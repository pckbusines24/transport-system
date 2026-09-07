import { requireSession } from "@/lib/session";
import { authorize } from "@/lib/authz";
import { withTenant } from "@/lib/db";
import { SYSTEM_HEADS, isSystemHeadName } from "@/lib/account-heads";
import { AccountHeadsClient } from "@/components/masters/account-heads-client";

export const dynamic = "force-dynamic";

export default async function AccountHeadsPage({
  searchParams,
}: {
  searchParams: { q?: string; kind?: string };
}) {
  const session = requireSession();
  await authorize(session, "masters", "view");
  const q = searchParams.q?.trim();
  const kind = searchParams.kind;

  const rows = await withTenant(session.tenantId, async (tx) => {
    // the software's own heads exist up front — every module posts to these
    // exact names, so they are seeded here and protected from edit/delete
    for (const h of SYSTEM_HEADS) {
      await tx.accountHead.upsert({
        where: { tenantId_name: { tenantId: session.tenantId, name: h.name } },
        update: {},
        create: { tenantId: session.tenantId, name: h.name, kind: h.kind },
      });
    }
    // retired names of the staff-payroll head (now "Staff Salary Expense");
    // safe to remove only while nothing has ever posted to them
    const retired = await tx.accountHead.findMany({
      where: {
        tenantId: session.tenantId,
        name: { in: ["Salary Expense", "SALARY EXPENSE", "SALARY DEDUCTIONS"] },
      },
    });
    for (const h of retired) {
      const used = await tx.ledgerEntry.count({ where: { accountHeadId: h.id } });
      if (used === 0) await tx.accountHead.delete({ where: { id: h.id } });
    }
    return tx.accountHead.findMany({
      where: {
        ...(q ? { name: { contains: q, mode: "insensitive" } } : {}),
        ...(kind ? { kind } : {}),
      },
      orderBy: { name: "asc" },
    });
  });

  const canDelete = session.role === "ADMIN" || session.role === "OWNER";
  return (
    <AccountHeadsClient
      rows={rows.map((r) => ({
        id: r.id,
        name: r.name,
        kind: r.kind,
        pnlScope: r.pnlScope as "AUTO" | "COMPANY" | "VEHICLE" | "EXCLUDE",
        system: isSystemHeadName(r.name),
      }))}
      canDelete={canDelete}
      canManageSystem={canDelete}
    />
  );
}
