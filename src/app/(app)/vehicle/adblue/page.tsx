import type { Prisma } from "@prisma/client";
import { requireSession } from "@/lib/session";
import { authorize } from "@/lib/authz";
import { withTenant } from "@/lib/db";
import { toNum } from "@/lib/utils";
import { AdblueClient, type AdblueRow } from "@/components/vehicle/adblue-client";
import { PaginationBar, parsePage } from "@/components/data/pagination-bar";
import { settledByRef } from "@/lib/settlement";

const PAGE_SIZE = 100;

/** search-param value → derived row status it selects */
const STATUS_FILTER: Record<string, string> = {
  PENDING: "PENDING BILL",
  BILLED: "BILL UPDATED",
  PARTLY: "PARTLY PAID",
  PAID: "PAID",
};

export const dynamic = "force-dynamic";

export default async function AdbluePage({
  searchParams,
}: {
  searchParams: Record<string, string | undefined>;
}) {
  const session = requireSession();
  await authorize(session, "adblue", "view");

  const page = parsePage(searchParams.page);
  // status is derived per-row from settlement data (payment vouchers), so it
  // cannot be pushed into the SQL where. With a status filter active we must
  // fetch the whole filtered set anyway and paginate in memory; without one
  // the DB does take/skip.
  const wanted = searchParams.status ? STATUS_FILTER[searchParams.status] : null;

  const { txns, dbTotal, allTxns, vehicles, banks, suppliers, settled } = await withTenant(
    session.tenantId,
    async (tx) => {
    // stock is a LIFETIME figure (FY continuity): 31 March's closing IS
    // 1 April's opening, so the position sums every year's entries
    const lifetime: Prisma.AdblueTxnWhereInput = {
      firmId: session.firmId,
      deletedAt: null,
    };
    // register list: date filter beats FY — no dates → this year's entries
    const where: Prisma.AdblueTxnWhereInput = {
      ...lifetime,
      ...(searchParams.date_from || searchParams.date_to ? {} : { fyId: session.fyId }),
    };
    if (searchParams.type === "REFILL" || searchParams.type === "ISSUE") {
      where.type = searchParams.type;
    }
    if (searchParams.vehicle) where.vehicleId = searchParams.vehicle;
    if (searchParams.date_from || searchParams.date_to) {
      where.date = {
        ...(searchParams.date_from ? { gte: new Date(searchParams.date_from + "T00:00:00") } : {}),
        ...(searchParams.date_to ? { lte: new Date(searchParams.date_to + "T23:59:59") } : {}),
      };
    }
    const [txns, dbTotal, allTxns, vehicles, banks, suppliers] = await Promise.all([
      tx.adblueTxn.findMany({
        where,
        orderBy: [{ date: "desc" }, { createdAt: "desc" }],
        // status filter needs every row's settlement state — paginate later
        ...(wanted ? {} : { take: PAGE_SIZE, skip: (page - 1) * PAGE_SIZE }),
      }),
      tx.adblueTxn.count({ where }),
      tx.adblueTxn.groupBy({ by: ["type"], where: lifetime, _sum: { qty: true } }),
      // ALL vehicles for the name lookup — inactive ones' rows must still
      // show a number; the entry dropdown filters to active below
      tx.vehicle.findMany({ orderBy: { number: "asc" }, select: { id: true, number: true, isActive: true } }),
      tx.party.findMany({
        where: { isActive: true, ledgerGroup: { in: ["BANK", "CASH", "CARD"] } },
        orderBy: { name: "asc" },
        select: { id: true, name: true, ledgerGroup: true },
      }),
      tx.party.findMany({
        where: { isActive: true, ledgerGroup: { notIn: ["BANK", "CASH", "CARD"] } },
        orderBy: { name: "asc" },
        select: { id: true, name: true },
      }),
    ]);
    // what payment vouchers have already settled against these bills
    const settled = await settledByRef(tx, {
      firmId: session.firmId,
      fyId: session.fyId,
      refTypes: ["ADBLUE_PURCHASE"],
      refIds: txns.map((t) => t.id),
    });
      return { txns, dbTotal, allTxns, vehicles, banks, suppliers, settled };
    }
  );

  const vehicleNo = new Map(vehicles.map((v) => [v.id, v.number]));
  const sumOf = (t: string) =>
    toNum(String(allTxns.find((r) => r.type === t)?._sum.qty ?? 0));
  const totalRefill = sumOf("REFILL");
  const totalIssued = sumOf("ISSUE");

  const supplierName = new Map(suppliers.map((p) => [p.id, p.name]));
  const DAY = 24 * 60 * 60 * 1000;
  const today = new Date();

  /**
   * Where a refill stands. A receipt with no bill is PENDING BILL and carries no
   * accounting at all; once billed it is BILL UPDATED until it is settled —
   * immediately, when it was paid at entry, or later by a payment voucher.
   */
  const statusOf = (t: (typeof txns)[number]) => {
    if (t.type !== "REFILL") return "";
    if (!t.billNo) return "PENDING BILL";
    if (t.paymentMode) return "PAID";
    const amount = toNum(String(t.amount));
    const paid = settled.get(t.id) ?? 0;
    if (paid >= amount - 0.009) return "PAID";
    return paid > 0.009 ? "PARTLY PAID" : "BILL UPDATED";
  };

  const rows: AdblueRow[] = txns.map((t) => ({
    id: t.id,
    type: t.type,
    date: t.date.toISOString(),
    supplierName: t.supplierId ? supplierName.get(t.supplierId) ?? "" : t.supplierName ?? "",
    supplierId: t.supplierId,
    vehicleId: t.vehicleId,
    vehicle: t.vehicleId ? vehicleNo.get(t.vehicleId) ?? "" : "",
    destination: t.destination ?? "",
    qty: toNum(String(t.qty)),
    amount: toNum(String(t.amount)),
    billNo: t.billNo ?? "",
    billDate: t.billDate ? t.billDate.toISOString() : null,
    gstPct: toNum(String(t.gstPct)),
    gstAmount: toNum(String(t.gstAmount)),
    paymentMode: t.paymentMode ?? "",
    bankPartyId: t.bankPartyId,
    refNo: t.refNo ?? "",
    remarks: t.remarks ?? "",
    status: statusOf(t),
    // how long this receipt has been waiting for its invoice
    pendingDays:
      t.type === "REFILL" && !t.billNo
        ? Math.max(0, Math.floor((today.getTime() - t.date.getTime()) / DAY))
        : null,
  }));

  const filtered = wanted ? rows.filter((r) => r.status === wanted) : rows;
  // without a status filter the DB already returned one page; with one, slice here
  const total = wanted ? filtered.length : dbTotal;
  const visible = wanted ? filtered.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE) : filtered;

  return (
    <div className="space-y-4 p-4">
      <AdblueClient
        rows={visible}
        totals={{
          totalRefill,
          totalIssued,
          closing: Math.round((totalRefill - totalIssued) * 100) / 100,
        }}
        vehicleOptions={vehicles.filter((v) => v.isActive).map((v) => ({ value: v.id, label: v.number }))}
        bankOptions={banks.map((b) => ({ value: b.id, label: b.name, meta: b.ledgerGroup }))}
        partyOptions={suppliers.map((p) => ({ value: p.id, label: p.name }))}
        canDelete={session.role === "ADMIN" || session.role === "OWNER"}
      />
      <PaginationBar
        page={page}
        pageSize={PAGE_SIZE}
        total={total}
        basePath="/vehicle/adblue"
        searchParams={searchParams}
      />
    </div>
  );
}
