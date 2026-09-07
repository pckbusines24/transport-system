import { requireSession } from "@/lib/session";
import { authorize } from "@/lib/authz";
import { withTenant } from "@/lib/db";
import { toNum } from "@/lib/utils";
import { TdsSectionsClient } from "./tds-sections-client";

export const dynamic = "force-dynamic";

/**
 * TDS Master — sections carry the connected expense heads. Seeded once with
 * the two everyday sections; everything (codes, limits, rates, heads) stays
 * editable so new Income Tax Act numbering can be adopted in place.
 */
const SEED = [
  {
    code: "194Q",
    oldCode: null,
    name: "Purchase of Goods",
    annualLimit: 5000000,
    singleBillLimit: 0,
    rateIndividual: 0.1,
    rateCompany: 0.1,
    basis: "EXCESS",
  },
  {
    code: "194C",
    oldCode: null,
    name: "Contract / Service",
    annualLimit: 100000,
    singleBillLimit: 30000,
    rateIndividual: 1,
    rateCompany: 2,
    basis: "FULL",
  },
];

export default async function TdsSectionsPage({
  searchParams,
}: {
  searchParams: { q?: string };
}) {
  const session = requireSession();
  await authorize(session, "masters", "view");
  const q = searchParams.q?.trim();

  const { sections, heads } = await withTenant(session.tenantId, async (tx) => {
    if ((await tx.tdsSection.count()) === 0) {
      for (const s of SEED) {
        await tx.tdsSection.create({ data: { tenantId: session.tenantId, ...s, headIds: [] } });
      }
    }
    const [sections, heads] = await Promise.all([
      tx.tdsSection.findMany({
        where: {
          deletedAt: null,
          ...(q
            ? {
                OR: [
                  { code: { contains: q, mode: "insensitive" } },
                  { oldCode: { contains: q, mode: "insensitive" } },
                  { name: { contains: q, mode: "insensitive" } },
                ],
              }
            : {}),
        },
        orderBy: { code: "asc" },
      }),
      tx.accountHead.findMany({ where: { kind: "EXPENSE" }, orderBy: { name: "asc" } }),
    ]);
    return { sections, heads };
  });

  return (
    <TdsSectionsClient
      sections={sections.map((s) => ({
        id: s.id,
        code: s.code,
        oldCode: s.oldCode,
        name: s.name,
        annualLimit: toNum(String(s.annualLimit)),
        singleBillLimit: toNum(String(s.singleBillLimit)),
        rateIndividual: toNum(String(s.rateIndividual)),
        rateCompany: toNum(String(s.rateCompany)),
        basis: s.basis as "FULL" | "EXCESS",
        headIds: s.headIds,
        moduleRefs: s.moduleRefs as ("CHALAN" | "BROKER_SLIP" | "HIRE")[],
      }))}
      heads={heads.map((h) => ({ id: h.id, name: h.name }))}
      canDelete={session.role === "ADMIN" || session.role === "OWNER"}
    />
  );
}
