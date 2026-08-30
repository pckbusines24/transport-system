"use server";

import { redirect } from "next/navigation";
import { withTenant } from "@/lib/db";
import { getSession, setSessionCookie } from "@/lib/session";
import { revalidateOutstanding } from "@/lib/outstanding-cache";

export async function selectFirm(formData: FormData) {
  const session = getSession();
  if (!session) redirect("/login");

  const firmId = String(formData.get("firmId") ?? "");
  const fyId = String(formData.get("fyId") ?? "");
  if (!firmId || !fyId) redirect("/select-firm");

  const data = await withTenant(session.tenantId, async (tx) => {
    // independent checks — one round-trip instead of three sequential ones
    const [firm, assignments, directFy] = await Promise.all([
      tx.firm.findFirst({
        where: { id: firmId, tenantId: session.tenantId, isActive: true },
      }),
      tx.userFirm.findMany({ where: { userId: session.userId } }),
      fyId !== "__next__"
        ? tx.financialYear.findFirst({ where: { id: fyId, firmId, isActive: true } })
        : Promise.resolve(null),
    ]);
    if (!firm) return null;

    // if user has explicit firm assignments, enforce them
    if (assignments.length > 0 && !assignments.some((a) => a.firmId === firmId)) return null;

    // FY continuity: picking the (not yet created) NEXT financial year simply
    // creates it — 1 April to 31 March after the latest existing year. The
    // label is unique per firm, so a double-click cannot create two.
    if (fyId === "__next__") {
      const latest = await tx.financialYear.findFirst({
        where: { firmId },
        orderBy: { startDate: "desc" },
      });
      if (!latest) return null;
      const y = latest.startDate.getFullYear() + 1;
      const label = `${y}-${y + 1}`;
      let fy = await tx.financialYear.findFirst({ where: { firmId, label } });
      if (!fy) {
        try {
          fy = await tx.financialYear.create({
            data: {
              tenantId: session.tenantId,
              firmId,
              label,
              startDate: new Date(y, 3, 1), // 1 April
              endDate: new Date(y + 1, 2, 31, 23, 59, 59), // 31 March
              isActive: true,
            },
          });
        } catch {
          // double-click race: the other request won the unique(firm, label)
          // constraint — adopt its row instead of erroring out
          fy = await tx.financialYear.findFirst({ where: { firmId, label } });
        }
      }
      if (!fy) return null;
      return { firm, fy };
    }

    if (!directFy) return null;
    return { firm, fy: directFy };
  });

  if (!data) redirect("/select-firm");

  revalidateOutstanding(session.tenantId);

  setSessionCookie({
    ...session,
    firmId: data.firm.id,
    firmName: data.firm.name,
    fyId: data.fy.id,
    fyLabel: data.fy.label,
  });
  redirect("/dashboard");
}
