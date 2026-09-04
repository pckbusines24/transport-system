import type { Prisma } from "@prisma/client";
import { requireSession } from "@/lib/session";
import { authorize } from "@/lib/authz";
import { withTenant } from "@/lib/db";
import { roundWt, toNum } from "@/lib/utils";
import { invoiceSettlement, payableSettlement } from "@/lib/settlement";
import { PaginationBar, parsePage } from "@/components/data/pagination-bar";
import { ChalanRegisterClient, type ChalanRegisterRow } from "./register-client";

export const dynamic = "force-dynamic";

const PAGE_SIZE = 100;

export default async function ChalanRegisterPage({
  searchParams,
}: {
  searchParams: Record<string, string | undefined>;
}) {
  const session = requireSession();
  await authorize(session, "chalan", "view");
  const { date_from, date_to, q, broker, vehicle, status, payment, ownership, shortage } =
    searchParams;
  // two registers in one screen: MARKET (payable workflow, the default) and
  // OWNREL (own + relative vehicles — no payment actions, settlement via ledger)
  const tab = searchParams.type === "OWNREL" ? ("OWNREL" as const) : ("MARKET" as const);
  // each tab has its own Cancel Register: cancelled chalans leave the normal
  // register entirely and live here until restored
  const view = searchParams.view === "CANCELLED" ? ("CANCELLED" as const) : ("ACTIVE" as const);

  const page = parsePage(searchParams.page);
  // the payment filter runs on the LIVE settled position computed after the
  // query, so it cannot be pushed into SQL — with it set, the full filtered
  // set is fetched and paged in memory instead of at the database
  const dbPaged = !payment;

  const [rows, totalCount, brokers, vehicles, billStatusByChalan, payable, allVehicleRows] = await withTenant(
    session.tenantId,
    async (tx) => {
    // ownership resolves to a vehicle-id list (it also covers vehicle type)
    const allVehicles = await tx.vehicle.findMany({
      orderBy: { number: "asc" },
      select: { id: true, number: true, ownershipType: true, isActive: true },
    });
    // the tab decides the ownership universe; the ownership filter can only
    // narrow WITHIN it (Own vs Relative on the OWNREL tab)
    const allowed = tab === "MARKET" ? ["BROKER"] : ["OWNER", "RELATIVE"];
    const effective = ownership && allowed.includes(ownership) ? [ownership] : allowed;
    const vehicleIdFilter = allVehicles
      .filter((v) => effective.includes(v.ownershipType))
      .map((v) => v.id);

    // date filter beats FY (FY continuity): dates set → any year's chalans
    const where: Prisma.ChalanWhereInput = {
        firmId: session.firmId,
        // dates OR a number search beat FY — chalan numbers continue across
        // years, so last year's 498 must be findable from this year too
        ...(date_from || date_to || q ? {} : { fyId: session.fyId }),
        deletedAt: null,
        cancelledAt: view === "CANCELLED" ? { not: null } : null,
        ...(date_from || date_to
          ? {
              chalanDate: {
                ...(date_from ? { gte: new Date(date_from + "T00:00:00") } : {}),
                ...(date_to ? { lte: new Date(date_to + "T23:59:59") } : {}),
              },
            }
          : {}),
        ...(q ? { chalanNo: { contains: q, mode: "insensitive" } } : {}),
        ...(broker ? { brokerId: broker } : {}),
        // a picked vehicle filters HARD: inside the tab's universe it narrows
        // to that vehicle, outside it the list goes empty — never silently
        // ignored (that read as "vehicle filter not working")
        vehicleId: vehicle
          ? { in: vehicleIdFilter.includes(vehicle) ? [vehicle] : [] }
          : { in: vehicleIdFilter },
        ...(status === "final" ? { isFinal: true } : status === "draft" ? { isFinal: false } : {}),
        // the payment filter is applied after settlement is computed, since a
        // voucher can settle a chalan whose stored status still says PENDING
        // shortage weight lives on the LRs' PODs, so filter through the relation
        ...(shortage === "yes"
          ? { lrs: { some: { lr: { pods: { some: { shortageWt: { gt: 0 } } } } } } }
          : shortage === "no"
            ? { lrs: { none: { lr: { pods: { some: { shortageWt: { gt: 0 } } } } } } }
            : {}),
    };
    const [chalans, totalCount] = await Promise.all([
      tx.chalan.findMany({
        where,
        include: {
          lrs: { include: { lr: { include: { pods: true, invoiceLrs: { include: { invoice: true } } } } } },
        },
        orderBy: { chalanDate: "desc" },
        ...(dbPaged ? { take: PAGE_SIZE, skip: (page - 1) * PAGE_SIZE } : {}),
      }),
      tx.chalan.count({ where }),
    ]);
    // ALL brokers (inactive too) — a chalan on a deactivated broker must
    // still render its name instead of a blank cell
    const brokers = await tx.party.findMany({
      where: { ledgerGroup: { in: ["OWNER_BROKER", "RELATIVE"] } },
      orderBy: { name: "asc" },
      select: { id: true, name: true },
    });
    // dropdown offers ONLY this tab's universe (market tab: broker vehicles;
    // own/relative tab: own + relative) — offering the rest made the filter
    // look broken when an out-of-tab vehicle was picked
    const vehicles = allVehicles.filter((v) => v.isActive && allowed.includes(v.ownershipType));

    // Bill status must reflect receipts entered after the bill was raised, so
    // it is derived from live voucher allocations, never from Invoice.balance
    // (which is frozen at bill-creation time).
    const invoices = Array.from(
      new Map(
        chalans
          .flatMap((c) => c.lrs.flatMap((l) => l.lr.invoiceLrs.map((il) => il.invoice)))
          .map((i) => [i.id, i])
      ).values()
    );
    const settlement = await invoiceSettlement(tx, {
      firmId: session.firmId,
      fyId: session.fyId,
      invoices,
    });
    const billStatusByChalan = new Map<string, string>();
    for (const c of chalans) {
      const invs = Array.from(
        new Set(c.lrs.flatMap((l) => l.lr.invoiceLrs.map((il) => il.invoiceId)))
      );
      if (invs.length === 0) {
        billStatusByChalan.set(c.id, "NOT BILLED");
        continue;
      }
      const states = invs.map((id) => settlement.get(id)?.status ?? "UNPAID");
      billStatusByChalan.set(
        c.id,
        states.every((s) => s === "PAID")
          ? "PAID"
          : states.every((s) => s === "UNPAID")
            ? "UNPAID"
            : "PARTLY PAID"
      );
    }
    // a chalan can also be settled from a Payment Voucher, so the register's
    // balance and payment status come from the combined position
    const payable = await payableSettlement(tx, {
      firmId: session.firmId,
      fyId: session.fyId,
      refType: "FREIGHT_CHALLAN",
      docs: chalans.map((c) => ({
        id: c.id,
        // LIVE balance (grandTotal − advances) — the stored column freezes at
        // save time and can disagree with the dashboard payable tile
        balance: Math.round((toNum(c.grandTotal) - toNum(c.advanceTotal)) * 100) / 100,
        ownPaid: toNum(c.balPaidAmount),
        ownShortage: toNum(c.balShortage),
        ownRoundOff: toNum(c.balRoundOff),
        ownAdvanceAdjusted: toNum(c.balAdvanceAdjusted),
      })),
    });
    return [chalans, totalCount, brokers, vehicles, billStatusByChalan, payable, allVehicles] as const;
    }
  );

  const brokerName = (id: string) => brokers.find((b) => b.id === id)?.name ?? "";
  // lookup over ALL vehicles — an inactive vehicle's chalan still shows its number
  const vehicleNo = (id: string) => allVehicleRows.find((v) => v.id === id)?.number ?? "";

  const mapped: ChalanRegisterRow[] = rows.map((c) => ({
    id: c.id,
    chalanNo: c.chalanNo,
    chalanDate: c.chalanDate.toISOString(),
    broker: brokerName(c.brokerId),
    vehicle: vehicleNo(c.vehicleId),
    lrCount: c.lrs.length,
    freight: toNum(c.freight),
    tdsAmt: toNum(c.tdsAmt),
    commissionAmt: toNum(c.commissionAmt),
    advanceTotal: toNum(c.advanceTotal),
    balance: payable.get(c.id)?.outstanding ?? toNum(c.balance),
    mamool: toNum(c.mamool),
    courierCharge: toNum(c.courierCharge),
    isFinal: c.isFinal,
    podDone: c.lrs.filter((l) => l.lr.pods.length > 0).length,
    // shortage weight recorded on the LRs' PODs (visible before balance payment)
    shortageWt: roundWt(
      c.lrs.flatMap((l) => l.lr.pods).reduce((s, p) => s + toNum(p.shortageWt), 0)
    ),
    // shortage amount + round-off applied at balance payment (visible after) —
    // across BOTH paths: chalan-side legacy fields AND settlement vouchers
    shortage: Number(c.balShortage) + (payable.get(c.id)?.voucherShortage ?? 0),
    roundOff: Number(c.balRoundOff) + (payable.get(c.id)?.voucherRoundOff ?? 0),
    // payment status and paid amount span both settlement paths
    paymentStatus: c.cancelledAt
      ? "CANCELLED"
      : (payable.get(c.id)?.outstanding ?? 0) <= 0.009
        ? "PAID"
        : c.paymentStatus,
    balPaidAmount: payable.get(c.id)?.settled ?? Number(c.balPaidAmount),
    billStatus: billStatusByChalan.get(c.id) ?? "NOT BILLED",
    cancelled: !!c.cancelledAt,
    cancelReason: c.cancelReason ?? "",
  }));

  const filtered =
    payment === "paid"
      ? mapped.filter((r) => r.paymentStatus === "PAID")
      : payment === "pending"
        ? // a cancelled chalan owes nothing, so it is neither paid nor pending
          mapped.filter((r) => r.paymentStatus !== "PAID" && !r.cancelled)
        : mapped;
  const total = dbPaged ? totalCount : filtered.length;
  // dbPaged → rows are already the page slice; otherwise slice the filtered set
  const data = dbPaged ? filtered : filtered.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);

  return (
    <div className="space-y-4">
      <ChalanRegisterClient
        rows={data}
        mode={tab}
        view={view}
        brokers={brokers.map((b) => ({ value: b.id, label: b.name }))}
        vehicles={vehicles.map((v) => ({ value: v.id, label: v.number }))}
        canDelete={session.role === "ADMIN" || session.role === "OWNER"}
      />
      <PaginationBar
        page={page}
        pageSize={PAGE_SIZE}
        total={total}
        basePath="/chalan/register"
        searchParams={searchParams}
      />
    </div>
  );
}
