import type { Prisma } from "@prisma/client";
import { requireSession } from "@/lib/session";
import { authorize } from "@/lib/authz";
import { withTenant } from "@/lib/db";
import { formatMoney, toNum } from "@/lib/utils";
import { FilterBar, type FilterDef } from "@/components/data/filter-bar";
import { SimpleReport, type ReportRow } from "@/components/accounts/simple-report";
import { InfoHint } from "@/components/ui/info-hint";

export const dynamic = "force-dynamic";

/**
 * Advance Register — advances auto-created by receipt vouchers (unallocated
 * remainder / over-payment) and consumed FIFO by bills.
 */
export default async function AdvanceRegisterPage({
  searchParams,
}: {
  searchParams: { party?: string; status?: string; date_from?: string; date_to?: string };
}) {
  const session = requireSession();
  await authorize(session, "reports", "view");

  const { advances, parties } = await withTenant(session.tenantId, async (tx) => {
    const hasDates = Boolean(searchParams.date_from || searchParams.date_to);
    const where: Prisma.PartyAdvanceWhereInput = {
      firmId: session.firmId,
      // date filter beats FY (FY continuity): a range reaching into an old
      // year shows that year's advances; no filter → current FY as before
      ...(hasDates ? {} : { fyId: session.fyId }),
      deletedAt: null,
      // cancel-created advances have their own register (Chalan Cancel Advances)
      source: { not: "CHALAN_CANCEL" },
    };
    if (searchParams.party) where.partyId = searchParams.party;
    if (hasDates) {
      where.date = {
        ...(searchParams.date_from ? { gte: new Date(searchParams.date_from + "T00:00:00") } : {}),
        ...(searchParams.date_to ? { lte: new Date(searchParams.date_to + "T23:59:59") } : {}),
      };
    }
    const [advances, parties] = await Promise.all([
      tx.partyAdvance.findMany({
        where,
        include: { uses: true },
        orderBy: [{ date: "desc" }, { createdAt: "desc" }],
      }),
      tx.party.findMany({ where: { isActive: true }, orderBy: { name: "asc" } }),
    ]);
    return { advances, parties };
  });

  const partyName = new Map(parties.map((p) => [p.id, p.name]));

  let rows: ReportRow[] = advances.map((a) => {
    const amount = toNum(String(a.amount));
    const consumed = toNum(String(a.consumedAmount));
    const balance = Math.round((amount - consumed) * 100) / 100;
    return {
      date: a.date.toISOString(),
      party: partyName.get(a.partyId) ?? "",
      kind: a.kind === "PAID" ? "ADV PAID" : "ADV RECEIVED",
      refNo: a.voucherNo ?? "",
      amount,
      consumed,
      balance,
      // the per-document split, so a voucher spread over several chalans reads
      // as "CH-80001 ₹6,000, CH-80006 ₹5,000" rather than a bare list
      usedAgainst: a.uses
        .map((u) => `${u.refNo} ${formatMoney(toNum(String(u.amount)))}`)
        .join(", "),
      status: balance <= 0.009 ? "CONSUMED" : consumed > 0 ? "PARTLY USED" : "OPEN",
      narration: a.remarks ?? "",
    };
  });
  if (searchParams.status === "OPEN") rows = rows.filter((r) => Number(r.balance) > 0.009);
  if (searchParams.status === "CONSUMED") rows = rows.filter((r) => Number(r.balance) <= 0.009);

  const filters: FilterDef[] = [
    {
      type: "combobox",
      key: "party",
      label: "Party",
      options: parties.map((p) => ({ value: p.id, label: p.name })),
    },
    {
      type: "select",
      key: "status",
      label: "Status",
      options: [
        { value: "OPEN", label: "Open" },
        { value: "CONSUMED", label: "Fully Consumed" },
      ],
    },
    { type: "daterange", key: "date", label: "Date" },
  ];

  return (
    <div className="space-y-4 p-4">
      <h1 className="page-title flex items-center gap-2">
        Advance Register
        <InfoHint>
          Created automatically by receipt / payment vouchers with no bill reference. Bills
          consume them automatically; chalans consume them manually, voucher by voucher, through
          Advance Adjustment — &ldquo;Used Against&rdquo; shows the document and amount for every
          adjustment.
        </InfoHint>
      </h1>
      <FilterBar filters={filters} />
      <SimpleReport
        title={`${rows.length} advance${rows.length === 1 ? "" : "s"}`}
        columns={[
          { key: "date", header: "Date", kind: "date" },
          { key: "party", header: "Party" },
          { key: "kind", header: "Type", kind: "badge" },
          { key: "refNo", header: "Voucher No" },
          { key: "amount", header: "Advance Amt", kind: "money" },
          { key: "consumed", header: "Consumed", kind: "money" },
          { key: "balance", header: "Balance", kind: "money" },
          { key: "usedAgainst", header: "Used Against" },
          { key: "status", header: "Status", kind: "badge" },
          { key: "narration", header: "Narration" },
        ]}
        rows={rows}
        fileName="advance-register"
        emptyMessage="No party advances yet."
      />
    </div>
  );
}
