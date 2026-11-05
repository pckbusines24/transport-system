import { requireSession } from "@/lib/session";
import { authorize } from "@/lib/authz";
import { withTenant } from "@/lib/db";
import { toNum, istDayEnd, istDayStart } from "@/lib/utils";
import { FilterBar, type FilterDef } from "@/components/data/filter-bar";
import { SimpleReport, type ReportRow } from "@/components/accounts/simple-report";
import { COMMON_HEADS } from "@/lib/account-heads";

export const dynamic = "force-dynamic";

const COLUMNS = [
  {
    key: "head",
    header: "Ledger Head",
    linkBase: "/accounts/ledger?party=head:",
    linkParamKey: "headId",
  },
  { key: "kind", header: "Class" },
  { key: "expense", header: "Expense / Charged", kind: "money" as const },
  { key: "income", header: "Recovery / Income", kind: "money" as const },
  { key: "net", header: "Net Balance", kind: "money" as const },
  { key: "position", header: "Position" },
];

/**
 * Common Ledgers — one row per shared accounting head (Shortage, Round Off,
 * Commission, Mamool, Courier, Detention, ODC, Fine Slip, LD Charge, TDS).
 *
 * Every module posts into these same heads, so each row's net IS the firm-wide
 * position for that concept; the head name links to the full ledger (date,
 * module, voucher no, reference, party, debit, credit, running balance,
 * narration) in the Ledger Summary.
 */
export default async function CommonLedgerPage({
  searchParams,
}: {
  searchParams: { date_from?: string; date_to?: string };
}) {
  const session = requireSession();
  await authorize(session, "reports", "view");

  const rows = await withTenant(session.tenantId, async (tx) => {
    const heads = await tx.accountHead.findMany({ select: { id: true, name: true, kind: true } });
    // TDS Payable / Receivable are statutory asset & liability ledgers, not
    // operating concepts — they stay out of this report and are reached
    // directly through the Ledger Summary when needed
    const wanted = new Map(
      COMMON_HEADS.filter(
        (h) => h.name !== "TDS Payable" && h.name !== "TDS Receivable"
      ).map((h) => [h.name.toUpperCase(), h] as const)
    );
    const mine = heads.filter((h) => wanted.has(h.name.toUpperCase()));
    if (!mine.length) return [] as ReportRow[];

    const totals = await tx.ledgerEntry.groupBy({
      by: ["accountHeadId", "side"],
      where: {
        firmId: session.firmId,
        fyId: session.fyId,
        accountHeadId: { in: mine.map((h) => h.id) },
        ...(searchParams.date_from || searchParams.date_to
          ? {
              date: {
                ...(searchParams.date_from
                  ? { gte: istDayStart(searchParams.date_from) }
                  : {}),
                ...(searchParams.date_to
                  ? { lte: istDayEnd(searchParams.date_to) }
                  : {}),
              },
            }
          : {}),
      },
      _sum: { amount: true },
    });

    const byHead = new Map<string, { debit: number; credit: number }>();
    for (const t of totals) {
      if (!t.accountHeadId) continue;
      const acc = byHead.get(t.accountHeadId) ?? { debit: 0, credit: 0 };
      const amount = toNum(String(t._sum.amount ?? 0));
      if (t.side === "DEBIT") acc.debit += amount;
      else acc.credit += amount;
      byHead.set(t.accountHeadId, acc);
    }

    // Framework order, not alphabetical — the report reads the way the heads are
    // defined so the same list appears for every firm.
    const order = new Map(COMMON_HEADS.map((h, i) => [h.name.toUpperCase(), i]));
    return mine
      .sort((a, b) => (order.get(a.name.toUpperCase())! - order.get(b.name.toUpperCase())!))
      .map((h) => {
        const { debit, credit } = byHead.get(h.id) ?? { debit: 0, credit: 0 };
        // debit = the company bore it (expense side); credit = it was recovered
        // from or charged to someone (income side)
        const net = Math.round((debit - credit) * 100) / 100;
        return {
          headId: h.id,
          head: h.name,
          kind: h.kind === "INCOME" ? "Income" : h.kind === "EXPENSE" ? "Expense" : h.kind,
          expense: Math.round(debit * 100) / 100,
          income: Math.round(credit * 100) / 100,
          net: Math.abs(net),
          position: net === 0 ? "Nil" : net > 0 ? "Net Expense" : "Net Income",
        } satisfies ReportRow;
      });
  });

  const filters: FilterDef[] = [{ type: "daterange", key: "date", label: "Date" }];

  return (
    <div className="space-y-4 p-4">
      <h1 className="page-title">Common Ledgers</h1>
      <FilterBar filters={filters} />
      <SimpleReport
        title="One ledger per accounting head across every module — charged on the debit side, recovered on the credit side. Open a head for its date-wise ledger with running balance."
        columns={COLUMNS}
        rows={rows}
        fileName="common-ledgers"
        emptyMessage="No entries posted to the common heads yet."
      />
    </div>
  );
}
