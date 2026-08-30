import { requireSession } from "@/lib/session";
import { authorize } from "@/lib/authz";
import { withTenant } from "@/lib/db";
import { toNum } from "@/lib/utils";
import {
  VehicleExpenseDetailClient,
  type VehicleExpenseDetailRow,
  type HeadDetail,
} from "@/components/vehicle/vehicle-expense-detail-client";

const r2 = (n: number) => Math.round(n * 100) / 100;

function monthKey(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}

/**
 * Vehicle Expense Detail — per vehicle, per head, down to every entry:
 * "click Diesel and every fill-up, date by date, shows up". Reads the same
 * vehicle-wise allocation items as the Expense Summary (allocDate decides the
 * period) plus vehicle-loan EMIs, exactly as the Vehicle P&L counts them.
 */
export async function VehicleExpenseDetailTab({
  searchParams,
}: {
  searchParams: { date_from?: string; date_to?: string; vehicle?: string; ownership?: string };
}) {
  const session = requireSession();
  await authorize(session, "reports", "view");

  const dateFrom = searchParams.date_from ? new Date(searchParams.date_from + "T00:00:00") : null;
  const dateTo = searchParams.date_to ? new Date(searchParams.date_to + "T23:59:59") : null;

  const data = await withTenant(session.tenantId, async (tx) => {
    const [items, vehicles, heads, parties, loanEmis] = await Promise.all([
      tx.vehicleExpenseItem.findMany({
        where: {
          ...(dateFrom || dateTo
            ? {
                allocDate: {
                  ...(dateFrom ? { gte: dateFrom } : {}),
                  ...(dateTo ? { lte: dateTo } : {}),
                },
              }
            : {}),
          // EXPENSE and INCOME vouchers both — income (scrap sale, rent)
          // shows as its own section and nets off the vehicle's cost.
          // FY continuity: since-inception view like the Vehicle P&L — the date
          // filter alone narrows the period, no FY wall.
          voucher: {
            firmId: session.firmId,
            deletedAt: null,
          },
        },
        include: { voucher: true },
        orderBy: { allocDate: "desc" },
      }),
      tx.vehicle.findMany({ orderBy: { number: "asc" } }),
      tx.accountHead.findMany(),
      tx.party.findMany({ select: { id: true, name: true } }),
      // full instalments paid in the period, exactly as the Vehicle P&L —
      // the loan itself is long-lived, so no FY filter on the loan
      tx.loanEmi.findMany({
        where: {
          deletedAt: null,
          ...(dateFrom || dateTo
            ? {
                payDate: {
                  ...(dateFrom ? { gte: dateFrom } : {}),
                  ...(dateTo ? { lte: dateTo } : {}),
                },
              }
            : {}),
          loan: {
            firmId: session.firmId,
            deletedAt: null,
            loanType: "VEHICLE",
            vehicleId: { not: null },
          },
        },
        include: { loan: true },
        orderBy: { payDate: "desc" },
      }),
    ]);
    return { items, vehicles, heads, parties, loanEmis };
  });

  const { items, vehicles, heads, parties, loanEmis } = data;
  const headName = new Map(heads.map((h) => [h.id, h.name]));
  const partyName = new Map(parties.map((p) => [p.id, p.name]));
  const vehicleById = new Map(vehicles.map((v) => [v.id, v]));

  // vehicleId -> headKey -> detail
  const byVehicle = new Map<string, Map<string, HeadDetail>>();
  const bump = (
    vehicleId: string,
    head: string,
    entry: HeadDetail["entries"][number],
    month: string
  ) => {
    const headsMap = byVehicle.get(vehicleId) ?? new Map<string, HeadDetail>();
    const d = headsMap.get(head) ?? { name: head, amount: 0, entries: [], months: {} };
    d.amount = r2(d.amount + entry.amount);
    d.entries.push(entry);
    d.months[month] = r2((d.months[month] ?? 0) + entry.amount);
    headsMap.set(head, d);
    byVehicle.set(vehicleId, headsMap);
  };

  // vehicleId -> income entries (INCOME vouchers allocated to the vehicle)
  const incomeByVehicle = new Map<string, HeadDetail["entries"]>();

  for (const it of items) {
    const amount = toNum(String(it.amount));
    if (amount <= 0) continue;
    const qty = it.qty != null ? toNum(String(it.qty)) : null;
    const entry = {
      date: it.allocDate.toISOString(),
      voucherNo: it.voucher.voucherNo,
      supplier:
        (it.voucher.partyId && partyName.get(it.voucher.partyId)) || it.voucher.itemName || "",
      qty,
      amount,
      remarks: it.remarks || it.voucher.remarks || "",
    };
    if (it.voucher.txnType === "INCOME") {
      const list = incomeByVehicle.get(it.vehicleId) ?? [];
      list.push(entry);
      incomeByVehicle.set(it.vehicleId, list);
      continue;
    }
    bump(
      it.vehicleId,
      headName.get(it.voucher.headId) ?? "(unknown head)",
      entry,
      monthKey(it.allocDate)
    );
  }
  for (const emi of loanEmis) {
    const vehicleId = emi.loan.vehicleId!;
    const total = r2(
      toNum(String(emi.principal)) +
        toNum(String(emi.interest)) +
        toNum(String(emi.penalty)) +
        toNum(String(emi.otherAmt))
    );
    if (total <= 0) continue;
    bump(
      vehicleId,
      "EMI (Loan)",
      {
        date: emi.payDate.toISOString(),
        voucherNo: emi.voucherNo ?? "",
        supplier: `${emi.loan.loanNo} — ${partyName.get(emi.loan.partyId) ?? ""}`,
        qty: null,
        amount: total,
        remarks: "",
      },
      monthKey(emi.payDate)
    );
  }

  const vehicleIds = new Set([
    ...Array.from(byVehicle.keys()),
    ...Array.from(incomeByVehicle.keys()),
  ]);
  const rows: VehicleExpenseDetailRow[] = Array.from(vehicleIds)
    .map((vehicleId) => {
      const v = vehicleById.get(vehicleId);
      const headList = Array.from(
        (byVehicle.get(vehicleId) ?? new Map<string, HeadDetail>()).values()
      ).sort((a, b) => b.amount - a.amount);
      const incomeEntries = incomeByVehicle.get(vehicleId) ?? [];
      const income = r2(incomeEntries.reduce((s, e) => s + e.amount, 0));
      const total = r2(headList.reduce((s, h) => s + h.amount, 0));
      return {
        id: vehicleId,
        vehicle: v?.number ?? "(unknown vehicle)",
        ownership:
          v?.ownershipType === "OWNER"
            ? "Own"
            : v?.ownershipType === "RELATIVE"
              ? "Relative"
              : "Broker",
        ownershipType: v?.ownershipType ?? "",
        total,
        income,
        incomeEntries,
        net: r2(total - income),
        heads: headList,
      };
    })
    .filter((r) => !searchParams.vehicle || r.id === searchParams.vehicle)
    .filter((r) => !searchParams.ownership || r.ownershipType === searchParams.ownership)
    .sort((a, b) => b.net - a.net);

  return (
    <VehicleExpenseDetailClient
      rows={rows}
      vehicleOptions={vehicles.map((v) => ({ value: v.id, label: v.number }))}
    />
  );
}
