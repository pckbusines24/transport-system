import type { Prisma } from "@prisma/client";
import { requireSession } from "@/lib/session";
import { withTenant } from "@/lib/db";
import { settledByRef, signedRemainder } from "@/lib/settlement";
import { toNum } from "@/lib/utils";
import type { DriverSalaryRow } from "@/components/vehicle/driver-salary-client";
import type { DriverSettlementRow } from "@/components/vehicle/driver-settlement-client";
import type { DriverAdvanceRow } from "@/components/vehicle/driver-advance-client";
import type { FnfRow } from "@/components/vehicle/driver-fnf-client";

/**
 * Loaders for the Driver Management tabs. Only the active tab runs, so the
 * grouped page costs no more than the four separate pages it replaced.
 * Lifted verbatim from those pages so behaviour is unchanged.
 */

export type DriverFilters = {
  driver?: string;
  vehicle?: string;
  status?: string;
  date_from?: string;
  date_to?: string;
};

const dateRange = (f: DriverFilters) =>
  f.date_from || f.date_to
    ? {
        ...(f.date_from ? { gte: new Date(f.date_from + "T00:00:00") } : {}),
        ...(f.date_to ? { lte: new Date(f.date_to + "T23:59:59") } : {}),
      }
    : undefined;

const bankWhere: Prisma.PartyWhereInput = {
  isActive: true,
  ledgerGroup: { in: ["BANK", "CASH", "CARD"] },
};

export async function loadSalaryTab(filters: DriverFilters) {
  const session = requireSession();
  const { salaries, shortages, drivers, banks } = await withTenant(
    session.tenantId,
    async (tx) => {
      // FY continuity: the driver account is lifetime — old-year dues stay visible
      const where: Prisma.DriverSalaryWhereInput = {
        firmId: session.firmId,
        deletedAt: null,
      };
      if (filters.driver) where.driverId = filters.driver;
      if (filters.status === "PENDING" || filters.status === "PAID") {
        where.paymentStatus = filters.status;
      }
      const [salaries, shortages, drivers, banks] = await Promise.all([
        tx.driverSalary.findMany({ where, orderBy: [{ month: "asc" }, { createdAt: "asc" }] }),
        tx.driverShortage.findMany({
          where: { firmId: session.firmId, deletedAt: null },
          orderBy: { date: "desc" },
        }),
        tx.driver.findMany({
          where: { firmId: session.firmId, deletedAt: null },
          orderBy: { name: "asc" },
        }),
        tx.party.findMany({ where: bankWhere, orderBy: { name: "asc" } }),
      ]);
      return { salaries, shortages, drivers, banks };
    }
  );

  const driverName = new Map(drivers.map((d) => [d.id, d.name]));

  // pending shortage (remaining) per driver — offered for adjustment at pay time
  const shortagePendingByDriver = new Map<string, number>();
  for (const s of shortages) {
    if (s.status !== "PENDING") continue;
    const remaining = toNum(String(s.amount)) - toNum(String(s.adjustedAmount));
    if (remaining <= 0) continue;
    shortagePendingByDriver.set(
      s.driverId,
      Math.round(((shortagePendingByDriver.get(s.driverId) ?? 0) + remaining) * 100) / 100
    );
  }

  // running salary balance per driver, chronological (unpaid carries forward)
  const runningByDriver = new Map<string, number>();
  const rows: DriverSalaryRow[] = salaries.map((s) => {
    const net = toNum(String(s.netPayable));
    const paid = toNum(String(s.paidAmount));
    const outstanding = Math.round((net - paid) * 100) / 100;
    const prevPending = runningByDriver.get(s.driverId) ?? 0;
    const running = Math.round((prevPending + outstanding) * 100) / 100;
    runningByDriver.set(s.driverId, running);
    return {
      id: s.id,
      driverId: s.driverId,
      driver: driverName.get(s.driverId) ?? "",
      month: s.month,
      salaryAmount: toNum(String(s.salaryAmount)),
      incentive: toNum(String(s.incentive)),
      bonus: toNum(String(s.bonus)),
      otherAllowance: toNum(String(s.otherAllowance)),
      advanceAdjust: toNum(String(s.advanceAdjust)),
      shortageDeduction: toNum(String(s.shortageDeduction)),
      otherDeductions: toNum(String(s.otherDeductions)),
      netPayable: net,
      paidAmount: paid,
      outstanding,
      prevPending,
      runningBalance: running,
      shortagePending: shortagePendingByDriver.get(s.driverId) ?? 0,
      paymentStatus: s.paymentStatus === "PAID" ? "PAID" : paid > 0 ? "PARTIAL" : "PENDING",
      paymentDate: s.paymentDate ? s.paymentDate.toISOString() : null,
      remarks: s.remarks ?? "",
    };
  });
  rows.reverse(); // newest first for display

  return {
    rows,
    shortages: shortages.map((s) => ({
      id: s.id,
      date: s.date.toISOString(),
      driver: driverName.get(s.driverId) ?? "",
      tripRef: s.tripRef ?? "",
      amount: toNum(String(s.amount)),
      status: s.status,
      remarks: s.remarks ?? "",
    })),
    driverOptions: drivers
      .filter((d) => d.status === "ACTIVE")
      .map((d) => ({ value: d.id, label: `${d.name} (${d.driverCode})` })),
    allDriverOptions: drivers.map((d) => ({ value: d.id, label: d.name })),
    bankOptions: banks.map((b) => ({ value: b.id, label: b.name, meta: b.ledgerGroup })),
    canDelete: session.role === "ADMIN" || session.role === "OWNER",
  };
}

export async function loadSettlementTab(filters: DriverFilters) {
  const session = requireSession();
  const { settlements, drivers, vehicles, banks, voucherPaid } = await withTenant(
    session.tenantId,
    async (tx) => {
      // FY continuity: settlements carry until squared off
      const where: Prisma.DriverSettlementWhereInput = {
        firmId: session.firmId,
        deletedAt: null,
      };
      if (filters.driver) where.driverId = filters.driver;
      if (filters.status === "PENDING" || filters.status === "SETTLED") {
        where.status = filters.status;
      } else {
        // default view: only settlements where money ACTUALLY moved — a real
        // payment/receipt voucher exists. Pending trip balances stay reachable
        // via the Status filter (that is where Pay/Receive lives).
        where.status = "SETTLED";
        where.voucherId = { not: null };
      }
      const range = dateRange(filters);
      if (range) where.date = range;
      const [settlements, drivers, vehicles, banks] = await Promise.all([
        tx.driverSettlement.findMany({ where, orderBy: [{ date: "asc" }, { createdAt: "asc" }] }),
        tx.driver.findMany({
          where: { firmId: session.firmId, deletedAt: null },
          orderBy: { name: "asc" },
        }),
        tx.vehicle.findMany({ where: { isActive: true }, orderBy: { number: "asc" } }),
        tx.party.findMany({ where: bankWhere, orderBy: { name: "asc" } }),
      ]);
      // voucher allocations already made against pending rows — the running
      // balance shown next to Pay/Receive must be the LIVE remainder, exactly
      // what the settle action will actually pay
      const voucherPaid = await settledByRef(tx, {
        firmId: session.firmId,
        fyId: session.fyId,
        refTypes: ["DRIVER_SETTLEMENT"],
        refIds: settlements.filter((s) => s.status === "PENDING").map((s) => s.id),
      });
      return { settlements, drivers, vehicles, banks, voucherPaid };
    }
  );

  const driverName = new Map(drivers.map((d) => [d.id, d.name]));
  const vehicleNo = new Map(vehicles.map((v) => [v.id, v.number]));

  // previous / running balance per driver in chronological order — settled
  // amounts drop out (they never carry to the next trip), and pending rows
  // count only for what vouchers have not already settled
  const runningByDriver = new Map<string, number>();
  const rows: DriverSettlementRow[] = settlements.map((s) => {
    const amount = toNum(String(s.amount));
    const live =
      s.status === "PENDING" ? signedRemainder(amount, voucherPaid.get(s.id) ?? 0) : 0;
    const prev = runningByDriver.get(s.driverId) ?? 0;
    const running = prev + live;
    runningByDriver.set(s.driverId, running);
    return {
      id: s.id,
      date: s.date.toISOString(),
      driverId: s.driverId,
      driver: driverName.get(s.driverId) ?? "",
      vehicle: s.vehicleId ? vehicleNo.get(s.vehicleId) ?? "" : "",
      tripRef: s.tripRef ?? "",
      previousBalance: prev,
      amount,
      runningBalance: running,
      status: s.status,
      isManual: !s.tripId,
      settledDate: s.settledDate ? s.settledDate.toISOString() : null,
      voucherNo: s.voucherNo ?? "",
      remarks: s.remarks ?? "",
    };
  });
  rows.reverse(); // newest first for display

  return {
    rows,
    driverOptions: drivers.map((d) => ({ value: d.id, label: `${d.name} (${d.driverCode})` })),
    vehicleOptions: vehicles.map((v) => ({ value: v.id, label: v.number })),
    bankOptions: banks.map((b) => ({ value: b.id, label: b.name, meta: b.ledgerGroup })),
    canDelete: session.role === "ADMIN" || session.role === "OWNER",
  };
}

export async function loadAdvanceTab(filters: DriverFilters) {
  const session = requireSession();
  const { advances, drivers, vehicles, banks } = await withTenant(session.tenantId, async (tx) => {
    // FY continuity: the driver account is lifetime — the FY filter here left the
    // "All" view empty in a fresh year (missed when salary/settlement tabs
    // were widened). No status filter → PENDING and ADJUSTED both show.
    const where: Prisma.DriverAdvanceWhereInput = {
      firmId: session.firmId,
      deletedAt: null,
    };
    if (filters.driver) where.driverId = filters.driver;
    if (filters.vehicle) where.vehicleId = filters.vehicle;
    if (filters.status === "PENDING" || filters.status === "ADJUSTED") {
      where.status = filters.status;
    }
    const range = dateRange(filters);
    if (range) where.date = range;
    const [advances, drivers, vehicles, banks] = await Promise.all([
      tx.driverAdvance.findMany({ where, orderBy: [{ date: "desc" }, { createdAt: "desc" }] }),
      tx.driver.findMany({
        where: { firmId: session.firmId, deletedAt: null },
        orderBy: { name: "asc" },
      }),
      tx.vehicle.findMany({ where: { isActive: true }, orderBy: { number: "asc" } }),
      tx.party.findMany({ where: bankWhere, orderBy: { name: "asc" } }),
    ]);
    return { advances, drivers, vehicles, banks };
  });

  const driverName = new Map(drivers.map((d) => [d.id, d.name]));
  const vehicleNo = new Map(vehicles.map((v) => [v.id, v.number]));
  const bankName = new Map(banks.map((b) => [b.id, b.name]));

  const rows: DriverAdvanceRow[] = advances.map((a) => ({
    id: a.id,
    date: a.date.toISOString(),
    driverId: a.driverId,
    driver: driverName.get(a.driverId) ?? "",
    vehicleId: a.vehicleId,
    vehicle: a.vehicleId ? vehicleNo.get(a.vehicleId) ?? "" : "",
    tripRef: a.tripRef ?? "",
    amount: toNum(String(a.amount)),
    paymentMode: a.paymentMode,
    bankPartyId: a.bankPartyId,
    bank: a.bankPartyId ? bankName.get(a.bankPartyId) ?? "" : "",
    voucherRef: a.voucherRef ?? "",
    remarks: a.remarks ?? "",
    status: a.status,
    adjustedDate: a.adjustedDate ? a.adjustedDate.toISOString() : null,
  }));

  return {
    rows,
    driverOptions: drivers
      .filter((d) => d.status === "ACTIVE")
      .map((d) => ({ value: d.id, label: `${d.name} (${d.driverCode})` })),
    allDriverOptions: drivers.map((d) => ({ value: d.id, label: d.name })),
    vehicleOptions: vehicles.map((v) => ({ value: v.id, label: v.number })),
    bankOptions: banks.map((b) => ({ value: b.id, label: b.name, meta: b.ledgerGroup })),
    canDelete: session.role === "ADMIN" || session.role === "OWNER",
  };
}

export async function loadFnfTab() {
  const session = requireSession();
  const { fnfs, drivers, banks } = await withTenant(session.tenantId, async (tx) => {
    const [fnfs, drivers, banks] = await Promise.all([
      tx.driverFnf.findMany({
        where: { firmId: session.firmId, deletedAt: null },
        orderBy: { createdAt: "desc" },
      }),
      tx.driver.findMany({
        where: { firmId: session.firmId, deletedAt: null },
        orderBy: { name: "asc" },
      }),
      tx.party.findMany({ where: bankWhere, orderBy: { name: "asc" } }),
    ]);
    return { fnfs, drivers, banks };
  });

  const driverName = new Map(drivers.map((d) => [d.id, `${d.name} (${d.driverCode})`]));

  const rows: FnfRow[] = fnfs.map((f) => ({
    id: f.id,
    settlementNo: f.settlementNo,
    date: f.date.toISOString(),
    driver: driverName.get(f.driverId) ?? "",
    lastWorkingDate: f.lastWorkingDate ? f.lastWorkingDate.toISOString() : null,
    grossSalary: toNum(String(f.grossSalary)),
    shortageAdjust: toNum(String(f.shortageAdjust)),
    advanceAdjust: toNum(String(f.advanceAdjust)),
    negativeAdjust: toNum(String(f.negativeAdjust)),
    otherRecoveries: toNum(String(f.otherRecoveries)),
    otherPayments: toNum(String(f.otherPayments)),
    finalPayable: toNum(String(f.finalPayable)),
    paymentMode: f.paymentMode ?? "",
    remarks: f.remarks ?? "",
  }));

  return {
    rows,
    driverOptions: drivers
      .filter((d) => d.status === "ACTIVE")
      .map((d) => ({ value: d.id, label: `${d.name} (${d.driverCode})` })),
    bankOptions: banks.map((b) => ({ value: b.id, label: b.name, meta: b.ledgerGroup })),
  };
}
