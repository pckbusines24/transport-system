import { requireSession } from "@/lib/session";
import { authorize } from "@/lib/authz";
import { withTenant } from "@/lib/db";
import { formatDate, istDayEnd, istDayStart, toNum } from "@/lib/utils";
import { round2 } from "@/lib/calc/tds";
import { payableSettlement } from "@/lib/settlement";
import { InfoHint } from "@/components/ui/info-hint";
import { StatCard } from "@/components/ui/stat";
import { FilterBar, type FilterDef } from "@/components/data/filter-bar";
import { PaginationBar, parsePage } from "@/components/data/pagination-bar";
import {
  BalanceFollowUpTable,
  type BalanceFollowUpRow,
} from "@/components/chalan/balance-follow-up-client";

export const dynamic = "force-dynamic";

const PAGE_SIZE = 50;
const DAY_MS = 24 * 3600 * 1000;
/** a date's IST calendar day as yyyy-mm-dd */
const istIso = (d: Date) => formatDate(d).split("/").reverse().join("-");
/** whole IST calendar days from day `a` to day `b` (yyyy-mm-dd) */
const daysBetween = (a: string, b: string) =>
  Math.round((istDayStart(b).getTime() - istDayStart(a).getTime()) / DAY_MS);

/**
 * Balance Paid Follow-up — broker chalans whose balance is still unpaid
 * `Firm.balanceFollowUpDays` days after their LAST POD was entered (software
 * entry time, not the POD document date: balance becomes payable only once
 * every LR has a POD). Own / relative vehicles never appear. Pay Now opens
 * the chalan's own balance-payment panel in a pop-up, so the filters, search
 * and page stay as they were and the list refreshes in place.
 */
export default async function BalanceFollowUpPage({
  searchParams,
}: {
  searchParams: Record<string, string | undefined>;
}) {
  const session = requireSession();
  await authorize(session, "chalan", "view");
  const page = parsePage(searchParams.page);
  const todayIso = istIso(new Date());
  const q = (k: string) => searchParams[k]?.trim() || "";
  const minDaysRaw = parseInt(q("min_days"), 10);
  const minDays = Number.isFinite(minDaysRaw) && minDaysRaw >= 0 ? minDaysRaw : null;

  const data = await withTenant(session.tenantId, async (tx) => {
    const firm = await tx.firm.findUniqueOrThrow({ where: { id: session.firmId } });
    if (!firm.balanceFollowUpEnabled) return null;
    const days = firm.balanceFollowUpDays ?? 15;

    const brokerVehicles = await tx.vehicle.findMany({
      where: { ownershipType: "BROKER" },
      select: { id: true, number: true },
    });
    const vehicleNo = new Map(brokerVehicles.map((v) => [v.id, v.number]));

    // FY continuity: an old-year chalan still unpaid stays chased here
    const chalans = await tx.chalan.findMany({
      where: {
        firmId: session.firmId,
        deletedAt: null,
        cancelledAt: null,
        isFinal: true,
        paymentStatus: { not: "PAID" },
        vehicleId: { in: Array.from(vehicleNo.keys()) },
        ...(q("broker") ? { brokerId: q("broker") } : {}),
        ...(q("vehicle") ? { vehicleId: q("vehicle") } : {}),
        ...(q("chalan") ? { chalanNo: { contains: q("chalan"), mode: "insensitive" as const } } : {}),
        ...(q("lr")
          ? { lrs: { some: { lr: { lrNo: { contains: q("lr"), mode: "insensitive" as const } } } } }
          : {}),
      },
      include: {
        lrs: {
          include: {
            lr: {
              select: {
                lrNo: true,
                lrType: true,
                consignorId: true,
                billToId: true,
                pods: { select: { createdAt: true } },
              },
            },
          },
        },
      },
    });

    const pos = await payableSettlement(tx, {
      firmId: session.firmId,
      refType: "FREIGHT_CHALLAN",
      docs: chalans.map((c) => ({
        id: c.id,
        // same as the Outstanding screen: live grandTotal − advances
        balance: round2(toNum(c.grandTotal) - toNum(c.advanceTotal)),
        ownPaid: toNum(c.balPaidAmount),
        ownShortage: toNum(c.balShortage),
        ownRoundOff: toNum(c.balRoundOff),
        ownAdvanceAdjusted: toNum(c.balAdvanceAdjusted),
      })),
    });

    const partyIds = new Set<string>();
    for (const c of chalans) {
      partyIds.add(c.brokerId);
      for (const l of c.lrs) partyIds.add(l.lr.billToId ?? l.lr.consignorId);
    }
    const parties = await tx.party.findMany({
      where: { id: { in: Array.from(partyIds) } },
      select: { id: true, name: true },
    });
    const partyName = new Map(parties.map((p) => [p.id, p.name]));
    const brokerOptions = await tx.party.findMany({
      where: { id: { in: Array.from(new Set(chalans.map((c) => c.brokerId))) } },
      select: { id: true, name: true },
      orderBy: { name: "asc" },
    });

    const rows: BalanceFollowUpRow[] = [];
    for (const c of chalans) {
      const operational = c.lrs.filter((l) => l.lr.lrType !== "CANCELLED" && l.lr.lrType !== "PAPER_CHANGE");
      // payable only once EVERY LR has a POD — the due date runs from the last one
      if (!operational.length || operational.some((l) => !l.lr.pods.length)) continue;
      const lastPod = new Date(
        Math.max(...operational.flatMap((l) => l.lr.pods.map((p) => p.createdAt.getTime())))
      );
      const podIso = istIso(lastPod);
      const dueIso = istIso(new Date(istDayStart(podIso).getTime() + days * DAY_MS));
      const pendingDays = daysBetween(dueIso, todayIso);
      if (pendingDays < 0) continue; // follow-up days not complete yet
      const p = pos.get(c.id);
      if (!p || p.outstanding <= 0.009) continue;
      const lrParties = Array.from(
        new Set(operational.map((l) => partyName.get(l.lr.billToId ?? l.lr.consignorId) ?? "").filter(Boolean))
      );
      rows.push({
        chalanId: c.id,
        chalanNo: c.chalanNo,
        lrNos: operational.map((l) => l.lr.lrNo).join(", "),
        vehicleNo: vehicleNo.get(c.vehicleId) ?? "",
        broker: c.transportName || partyName.get(c.brokerId) || "",
        party: lrParties.length > 1 ? `${lrParties[0]} +${lrParties.length - 1}` : (lrParties[0] ?? ""),
        partyNames: lrParties,
        podEntryIso: podIso,
        dueIso,
        total: round2(toNum(c.grandTotal)),
        paid: round2(toNum(c.advanceTotal) + p.settled),
        balance: p.outstanding,
        pendingDays,
        status: p.settled > 0.009 ? "PARTIAL" : "UNPAID",
      });
    }
    return { days, rows, brokerOptions, vehicleOptions: brokerVehicles };
  });

  if (!data) {
    return (
      <div className="space-y-4 p-4">
        <h1 className="page-title">Balance Paid Follow-up</h1>
        <div className="rounded-md border p-6 text-sm text-muted-foreground">
          Balance Paid Follow-up is turned off for this company. Turn it on in Settings → Firm.
        </div>
      </div>
    );
  }

  // POD-entry / due-date periods and the pending-days floor, on IST days
  const inRange = (iso: string, from: string, to: string) =>
    (!from || istDayStart(iso) >= istDayStart(from)) && (!to || istDayEnd(iso) <= istDayEnd(to));
  const filtered = data.rows
    .filter((r) => inRange(r.podEntryIso, q("pod_from"), q("pod_to")))
    .filter((r) => inRange(r.dueIso, q("due_from"), q("due_to")))
    .filter((r) => minDays === null || r.pendingDays >= minDays)
    // any of the chalan's parties, not only the one shown first
    .filter((r) => !q("party") || r.partyNames.includes(q("party")))
    // oldest pending first
    .sort((a, b) => b.pendingDays - a.pendingDays || a.chalanNo.localeCompare(b.chalanNo, undefined, { numeric: true }));

  const totalBalance = round2(filtered.reduce((s, r) => s + r.balance, 0));
  const vehicleCount = new Set(filtered.map((r) => r.vehicleNo)).size;
  const lastPage = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const current = Math.min(page, lastPage);
  const pageRows = filtered.slice((current - 1) * PAGE_SIZE, current * PAGE_SIZE);

  const filters: FilterDef[] = [
    { type: "daterange", key: "pod", label: "POD Entry Date" },
    { type: "daterange", key: "due", label: "Due Date" },
    {
      type: "combobox",
      key: "broker",
      label: "Broker",
      options: data.brokerOptions.map((b) => ({ value: b.id, label: b.name })),
    },
    {
      type: "combobox",
      key: "vehicle",
      label: "Vehicle",
      options: data.vehicleOptions.map((v) => ({ value: v.id, label: v.number })),
    },
    { type: "text", key: "lr", label: "LR No" },
    { type: "text", key: "chalan", label: "Chalan No" },
    {
      type: "combobox",
      key: "party",
      label: "Party",
      options: Array.from(new Set(data.rows.flatMap((r) => r.partyNames)))
        .sort()
        .map((name) => ({ value: name, label: name })),
    },
    { type: "text", key: "min_days", label: "Pending Days (and above)" },
  ];

  return (
    <div className="space-y-4 p-4">
      <h1 className="page-title flex items-center gap-2">
        Balance Paid Follow-up
        <InfoHint>
          Broker-vehicle chalans whose balance is unpaid {data.days} days after the last POD was entered
          (Settings → Firm). Own and relative vehicles never appear. Pay Now records the balance payment exactly
          as on the chalan screen.
        </InfoHint>
      </h1>
      <FilterBar filters={filters} />
      <div className="grid gap-3 sm:grid-cols-3">
        <StatCard label="Total Pending Vehicles" value={vehicleCount} />
        <StatCard label="Total Pending Chalans" value={filtered.length} />
        <StatCard label="Total Pending Balance" value={totalBalance.toLocaleString("en-IN", { minimumFractionDigits: 2 })} />
      </div>
      <BalanceFollowUpTable
        rows={pageRows}
        allRows={filtered}
        startIndex={(current - 1) * PAGE_SIZE}
        totalBalance={totalBalance}
      />
      <PaginationBar
        page={current}
        pageSize={PAGE_SIZE}
        total={filtered.length}
        basePath="/dashboard/balance-follow-up"
        searchParams={searchParams}
        hideSinglePage
      />
    </div>
  );
}
