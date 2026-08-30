import { requireSession } from "@/lib/session";
import { authorize } from "@/lib/authz";
import { withTenant } from "@/lib/db";
import { formatMoney, toNum } from "@/lib/utils";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { StatCard } from "@/components/ui/stat";
import { InfoHint } from "@/components/ui/info-hint";
import { FilterBar, type FilterDef } from "@/components/data/filter-bar";
import { SimpleReport, type ReportRow } from "@/components/accounts/simple-report";

export const dynamic = "force-dynamic";

const r2 = (n: number) => Math.round(n * 100) / 100;

/**
 * Company Operational Profit & Loss — the transport business only.
 *
 * Revenue: LR freight already billed (Lr.total via InvoiceLr on live
 * invoices — invoice ADDITIONAL charges are deliberately NOT LR revenue),
 * LR freight still awaiting a bill, and the broker (party) side of broker
 * slips. Expenses: the owner side of chalans and broker slips (lorry hire),
 * plus every operational ledger head.
 *
 * Ledger sections INCLUDE: the CHARGE heads of chalans (FleetOps) and
 * broker slips — Detention, ODC, Fine Slip, LD, Shortage, Other,
 * Commission, Mamool, Courier, Payment Charge — plus the Round Off and
 * Shortage posted at balance-payment time, Office Management entries and
 * non-vehicle loan interest from Finance. The FREIGHT legs post to parties,
 * never heads, so they cannot leak in — freight lives only in the Lorry
 * Hire section at GROSS (before any deduction), which is exactly why the
 * charge heads must appear here: gross hire + charge effects = net truth.
 * ADVANCE legs of chalans / broker slips stay out entirely.
 *
 * Excluded on purpose:
 *  - Vehicle-module entries (vehicle expenses, allocations, AdBlue, trip
 *    urea, driver salary/advance/FNF/shortage) — costed in Vehicle P&L.
 *  - VEHICLE loans (disbursement, EMI, interest, charges — by loan id and
 *    EMI voucher id) and the "Vehicle EMI Expense" head.
 *  - Other Receipts/Payments (FinanceTxn vouchers) — never operational.
 *  - TDS Payable / TDS Receivable heads — liability/asset, not P&L.
 *  - The "Freight Income" head — that is the billed revenue itself; invoice
 *    ADDITIONAL charge heads stay in ledger income, per their own heads.
 *
 * Ledger heads classify AUTOMATICALLY by their DR/CR balance in the period:
 * net credit → Ledger Head Income, net debit → Ledger Head Expense. No
 * manual mapping — a new head appears in the right section the first time
 * it is used.
 */

const EXCLUDED_REF_TYPES = [
  // vehicle module
  "VEHICLE_EXPENSE",
  "VEH_EXP_ALLOC",
  "ADBLUE",
  "TRIP_UREA",
  "DRIVER_ADVANCE",
  "DRIVER_FNF",
  "DRIVER_SALARY",
  "DRIVER_SALARY_PAY",
  "DRIVER_SHORTAGE",
  // relative-vehicle expense transfer: its debit side is a vehicle-module
  // entry (excluded above), so counting only the credit would inflate income
  "BROKER_SLIP_EXP_TRANSFER",
  // chalan / broker-slip ADVANCES never enter the head sections
  "CHALAN_ADVANCE",
  "BROKER_SLIP_ADVANCE",
];
// Chalan / broker-slip refTypes stay IN: only their CHARGE legs carry
// account heads (Detention, ODC, Fine Slip, LD, Shortage, Commission,
// Mamool, Courier, Payment Charge, Round Off at balance time) — the freight
// legs hit parties, not heads. Office-module entries stay included.

// TDS Payable / Receivable are liability & asset ledgers, never operational
// income or expense; Vehicle EMI Expense is financing; Freight Income IS the
// billed revenue counted above.
const EXCLUDED_HEADS = [
  "Vehicle EMI Expense",
  "Freight Income",
  // chalan / broker-slip freight accrues to this head — already counted
  // gross in the Lorry Hire section, so it must never repeat here
  "Lorry Hire Expense",
  "TDS Payable",
  "TDS Receivable",
  // GST charged on bills is a statutory liability, not operating income
  "GST Output",
];

export default async function OperationalPnlPage({
  searchParams,
}: {
  searchParams: { date_from?: string; date_to?: string };
}) {
  const session = requireSession();
  await authorize(session, "reports", "view");

  const dateWhere =
    searchParams.date_from || searchParams.date_to
      ? {
          ...(searchParams.date_from ? { gte: new Date(searchParams.date_from + "T00:00:00") } : {}),
          ...(searchParams.date_to ? { lte: new Date(searchParams.date_to + "T23:59:59") } : {}),
        }
      : undefined;

  const data = await withTenant(session.tenantId, async (tx) => {
    // Period rule (FY continuity): everything is DATE-scoped; no explicit
    // range → the session FY's own dates. Revenue AND the chalan side are
    // attributed by the LR's date — an old-year LR billed/chalaned in the
    // new year stays the OLD year's P&L, all its components together.
    const sessionFy = await tx.financialYear.findUniqueOrThrow({ where: { id: session.fyId } });
    const period = dateWhere ?? { gte: sessionFy.startDate, lte: sessionFy.endDate };
    const inPeriod = (d: Date) =>
      (!period.gte || d >= period.gte) && (!period.lte || d <= period.lte);
    const scope = { firmId: session.firmId };

    // Finance is included EXCEPT vehicle loans and Other Receipts/Payments.
    // Finance postings ride the generic VOUCHER refType, so the excluded
    // vouchers are collected by id: every VEHICLE-loan EMI voucher plus every
    // FinanceTxn (other receipt/payment) voucher. Non-vehicle loan EMIs stay
    // in — their interest is operational finance cost/income.
    const [vehicleLoans, financeTxns] = await Promise.all([
      tx.loan.findMany({
        where: { ...scope, loanType: "VEHICLE" },
        select: { id: true, emis: { select: { voucherId: true } } },
      }),
      tx.financeTxn.findMany({
        where: { ...scope, voucherId: { not: null } },
        select: { voucherId: true },
      }),
    ]);
    const vehicleLoanIds = vehicleLoans.map((l) => l.id);
    // P&L Head Mapping: COMPANY-mapped heads pull their vehicle-module entries
    // in here too; VEHICLE/EXCLUDE-mapped heads leave the ledger sections
    const allHeads = await tx.accountHead.findMany({
      select: { id: true, name: true, kind: true, pnlScope: true },
    });
    const blockedHeadIds = allHeads
      .filter((h) => h.pnlScope === "VEHICLE" || h.pnlScope === "EXCLUDE")
      .map((h) => h.id);
    const companyForcedIds = allHeads.filter((h) => h.pnlScope === "COMPANY").map((h) => h.id);
    const financeVoucherIds = Array.from(
      new Set(
        [
          ...vehicleLoans.flatMap((l) => l.emis.map((e) => e.voucherId)),
          ...financeTxns.map((t) => t.voucherId),
        ].filter(Boolean) as string[]
      )
    );

    const [billedLrLinks, pendingLrs, slips, chalanRows, heads, headEntries] = await Promise.all([
      // BILLED = the LR sits on a LIVE bill (made in ANY year) — the revenue
      // itself belongs to the LR's own date/year
      tx.invoiceLr.findMany({
        where: {
          invoice: { ...scope, deletedAt: null },
          lr: { lrDate: period },
        },
        include: { lr: true },
      }),
      // LRs with no live bill yet — revenue still waiting to be billed
      tx.lr.findMany({
        where: {
          ...scope,
          deletedAt: null,
          lrType: { notIn: ["CANCELLED", "PAPER_CHANGE"] },
          invoiceLrs: { none: {} },
          lrDate: period,
        },
        select: { total: true },
      }),
      tx.brokerSlip.aggregate({
        where: { ...scope, deletedAt: null, slipDate: period },
        // BOTH sides at GROSS chalan amount — before any deduction; the
        // deduction/charge effects live in the ledger head sections
        _sum: { pChalanAmt: true, vChalanAmt: true },
      }),
      // chalans fetched wide and attributed by the EARLIEST linked LR's date
      // (fallback: chalan date) — summed below
      tx.chalan.findMany({
        // a cancelled chalan (accident / rejection) is no longer an expense
        where: { ...scope, deletedAt: null, cancelledAt: null },
        select: {
          id: true,
          chalanDate: true,
          totalChalanAmt: true,
          lrs: { select: { lr: { select: { lrDate: true } } } },
        },
      }),
      tx.accountHead.findMany({ select: { id: true, name: true, kind: true } }),
      // individual entries (not groupBy): chalan-accrual charge legs
      // (Commission / Mamool / ODC / Detention ... refType CHALAN) follow
      // their chalan's LR-date year, so they are fetched for ALL dates and
      // re-attributed below; everything else stays on its own date
      tx.ledgerEntry.findMany({
        where: {
          ...scope,
          accountHeadId: blockedHeadIds.length ? { not: null, notIn: blockedHeadIds } : { not: null },
          refType: { notIn: EXCLUDED_REF_TYPES },
          // vehicle-loan vouchers + other receipts/payments are financial,
          // never operational; vehicle-loan disbursements likewise
          AND: [
            ...(financeVoucherIds.length
              ? [{ NOT: { refType: "VOUCHER", refId: { in: financeVoucherIds } } }]
              : []),
            ...(vehicleLoanIds.length
              ? [{ NOT: { refType: "LOAN", refId: { in: vehicleLoanIds } } }]
              : []),
          ],
          OR: [{ date: period }, { refType: "CHALAN" }],
        },
        select: { accountHeadId: true, side: true, amount: true, date: true, refType: true, refId: true },
      }),
    ]);

    // earliest linked LR decides each chalan's year
    const chalanEff = new Map<string, Date>();
    for (const c of chalanRows) {
      const lrTimes = c.lrs.map((l) => l.lr.lrDate.getTime());
      chalanEff.set(c.id, lrTimes.length ? new Date(Math.min(...lrTimes)) : c.chalanDate);
    }
    const chalanOwnerSum = r2(
      chalanRows.reduce(
        (s, c) =>
          inPeriod(chalanEff.get(c.id) ?? c.chalanDate) ? s + toNum(String(c.totalChalanAmt)) : s,
        0
      )
    );
    const chalans = { _sum: { totalChalanAmt: chalanOwnerSum } };

    // re-aggregate the entries with chalan legs on their LR-date year
    const sumKey = new Map<string, { accountHeadId: string; side: string; total: number }>();
    for (const e of headEntries) {
      if (!e.accountHeadId) continue;
      const eff = e.refType === "CHALAN" ? chalanEff.get(e.refId) ?? e.date : e.date;
      if (!inPeriod(eff)) continue;
      const key = `${e.accountHeadId}:${e.side}`;
      const acc = sumKey.get(key) ?? { accountHeadId: e.accountHeadId, side: e.side, total: 0 };
      acc.total = r2(acc.total + toNum(String(e.amount)));
      sumKey.set(key, acc);
    }
    const headSums = Array.from(sumKey.values()).map((s) => ({
      accountHeadId: s.accountHeadId as string | null,
      side: s.side,
      _sum: { amount: s.total },
    }));

    // COMPANY-mapped heads: pull in the vehicle-module legs their mapping
    // claims (the advance/transfer refTypes stay out — they never carry heads
    // relevant here and would double-count)
    const forcedSums = companyForcedIds.length
      ? await tx.ledgerEntry.groupBy({
          by: ["accountHeadId", "side"],
          where: {
            ...scope,
            accountHeadId: { in: companyForcedIds },
            refType: {
              in: [
                "VEHICLE_EXPENSE",
                "VEH_EXP_ALLOC",
                "ADBLUE",
                "TRIP_UREA",
                "DRIVER_ADVANCE",
                "DRIVER_FNF",
                "DRIVER_SALARY",
                "DRIVER_SALARY_PAY",
                "DRIVER_SHORTAGE",
              ],
            },
            date: period,
          },
          _sum: { amount: true },
        })
      : [];

    return { billedLrLinks, pendingLrs, slips, chalans, heads, headSums: [...headSums, ...forcedSums] };
  });

  const { billedLrLinks, pendingLrs, slips, chalans, heads, headSums } = data;

  // ---- revenue ----
  const billedLr = r2(billedLrLinks.reduce((s, l) => s + toNum(String(l.lr.total)), 0));
  const pendingLr = r2(pendingLrs.reduce((s, l) => s + toNum(String(l.total)), 0));
  // gross party-side amount — before TDS / commission / any deduction
  const brokerRevenue = r2(toNum(String(slips._sum.pChalanAmt ?? 0)));
  const totalRevenue = r2(billedLr + pendingLr + brokerRevenue);

  // ---- lorry hire (GROSS freight, before any deduction) ----
  const chalanOwner = r2(toNum(String(chalans._sum.totalChalanAmt ?? 0)));
  const brokerOwner = r2(toNum(String(slips._sum.vChalanAmt ?? 0)));
  const lorryHire = r2(chalanOwner + brokerOwner);

  // ---- ledger heads (operational only) ----
  const headById = new Map(heads.map((h) => [h.id, h]));
  const perHead = new Map<string, { debit: number; credit: number }>();
  for (const g of headSums) {
    if (!g.accountHeadId) continue;
    const acc = perHead.get(g.accountHeadId) ?? { debit: 0, credit: 0 };
    const amt = toNum(String(g._sum.amount ?? 0));
    if (g.side === "DEBIT") acc.debit = r2(acc.debit + amt);
    else acc.credit = r2(acc.credit + amt);
    perHead.set(g.accountHeadId, acc);
  }
  const headRows: ReportRow[] = [];
  let ledgerIncome = 0;
  let ledgerExpense = 0;
  for (const [headId, sums] of Array.from(perHead.entries())) {
    const head = headById.get(headId);
    if (!head || EXCLUDED_HEADS.includes(head.name)) continue;
    // automatic classification by the period's DR/CR balance — net credit is
    // income, net debit is expense; no manual mapping, whatever the head's
    // master kind says
    const balance = r2(sums.credit - sums.debit);
    if (Math.abs(balance) < 0.009) continue;
    const isIncome = balance > 0;
    const net = Math.abs(balance);
    if (isIncome) ledgerIncome = r2(ledgerIncome + net);
    else ledgerExpense = r2(ledgerExpense + net);
    // drill-down: the head's full ledger for the same period — every voucher,
    // reference, party, running balance and module source, with click-through
    // to the original documents
    const range = [
      searchParams.date_from ? `date_from=${searchParams.date_from}` : "",
      searchParams.date_to ? `date_to=${searchParams.date_to}` : "",
    ]
      .filter(Boolean)
      .join("&");
    headRows.push({
      head: head.name,
      kind: isIncome ? "INCOME" : "EXPENSE",
      debit: sums.debit,
      credit: sums.credit,
      net,
      link: `accounts/ledger?party=${encodeURIComponent(`head:${headId}`)}${range ? `&${range}` : ""}`,
    });
  }
  headRows.sort((a, b) =>
    String(a.kind).localeCompare(String(b.kind)) || String(a.head).localeCompare(String(b.head))
  );

  const profit = r2(totalRevenue - lorryHire - ledgerExpense + ledgerIncome);

  const filters: FilterDef[] = [{ type: "daterange", key: "date", label: "Period" }];

  const money = (v: number) => formatMoney(v);
  const line = (label: string, value: number, strong = false, negative = false, link?: string) => (
    <div
      key={label}
      className={`flex justify-between py-0.5 ${strong ? "border-t pt-1 font-semibold" : ""}`}
    >
      {link ? (
        <a
          href={`/${link}`}
          target="_blank"
          rel="noreferrer"
          className="text-primary underline-offset-2 hover:underline"
          title="Open this ledger head's complete book (new tab)"
        >
          {label}
        </a>
      ) : (
        <span>{label}</span>
      )}
      <span className="tabular-nums">
        {negative ? "− " : ""}
        {money(Math.abs(value))}
      </span>
    </div>
  );

  return (
    <div className="space-y-4 p-4">
      <h1 className="page-title flex items-center gap-2">
        Company Operational Profit &amp; Loss
        <InfoHint>
          Transport operations only — vehicle-module costs, loan EMIs and finance entries are
          excluded (see Vehicle P&amp;L and Finance for those). Invoice additional charges are not
          LR revenue; they appear under their own ledger heads. Head placement follows the
          P&amp;L Head Mapping (Masters).
        </InfoHint>
      </h1>
      <FilterBar filters={filters} />

      {/* ---- KPI ---- */}
      <div className="grid gap-3 sm:grid-cols-3">
        <StatCard label="Total Operational Revenue" value={money(totalRevenue)} />
        <StatCard
          label="Total Operational Expenses"
          value={money(r2(lorryHire + ledgerExpense))}
        />
        <StatCard
          label="Company Operational Profit / Loss"
          value={money(profit)}
          tone={profit >= 0 ? "success" : "destructive"}
        />
      </div>

      {/* ---- sections ---- */}
      <div className="grid gap-3 text-sm lg:grid-cols-2">
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-base">Income</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <div>
              <div className="mb-1 text-xs font-semibold uppercase text-muted-foreground">
                LR Revenue
              </div>
              {line(`Billed LR Amount (${billedLrLinks.length} LRs)`, billedLr)}
              {line(`Pending LR Amount (${pendingLrs.length} LRs, bill not yet made)`, pendingLr)}
              {line("Broker Revenue (gross, broker slip party side)", brokerRevenue)}
              {line("Total Operational Revenue", totalRevenue, true)}
            </div>
            <div>
              <div className="mb-1 text-xs font-semibold uppercase text-muted-foreground">
                Ledger Head Income
              </div>
              {headRows
                .filter((rw) => rw.kind === "INCOME")
                .map((rw) => line(String(rw.head), Number(rw.net), false, false, String(rw.link)))}
              {line("Total Ledger Income", ledgerIncome, true)}
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-base">Expenses</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <div>
              <div className="mb-1 text-xs font-semibold uppercase text-muted-foreground">
                Lorry Hire Expenses
              </div>
              {line("Challan Owner Expenses (gross freight)", chalanOwner)}
              {line("Broker Owner Expenses (gross freight, slip owner side)", brokerOwner)}
              {line("Total Lorry Hire Expenses", lorryHire, true)}
            </div>
            <div>
              <div className="mb-1 text-xs font-semibold uppercase text-muted-foreground">
                Ledger Head Expenses
              </div>
              {headRows
                .filter((rw) => rw.kind === "EXPENSE")
                .map((rw) => line(String(rw.head), Number(rw.net), false, false, String(rw.link)))}
              {line("Total Ledger Expenses", ledgerExpense, true)}
            </div>
          </CardContent>
        </Card>
      </div>

      {/* ---- summary ---- */}
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-base">Summary</CardTitle>
        </CardHeader>
        <CardContent className="max-w-md text-sm">
          {line("Total Operational Revenue", totalRevenue)}
          {line("Total Lorry Hire Expenses", lorryHire, false, true)}
          {line("Total Ledger Expenses", ledgerExpense, false, true)}
          {line("Total Ledger Income", ledgerIncome)}
          <div
            className={`mt-1 flex justify-between border-t pt-1 text-base font-bold ${profit >= 0 ? "text-emerald-600" : "text-destructive"}`}
          >
            <span>Company Operational Profit / Loss</span>
            <span className="tabular-nums">{money(profit)}</span>
          </div>
        </CardContent>
      </Card>

      {/* ---- head detail with export ---- */}
      <SimpleReport
        title="Operational ledger heads (vehicle-module, chalan/broker-slip and vehicle-finance entries excluded)"
        columns={[
          // clicking a head opens its complete ledger book for the period
          { key: "head", header: "Ledger Head", linkBase: "/", linkParamKey: "link" },
          { key: "kind", header: "Kind", kind: "badge" },
          { key: "debit", header: "Debit", kind: "money" },
          { key: "credit", header: "Credit", kind: "money" },
          { key: "net", header: "Net", kind: "money" },
        ]}
        rows={headRows}
        fileName="operational-pnl-heads"
        emptyMessage="No operational ledger activity in this period."
      />
    </div>
  );
}
