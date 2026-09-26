import type { Tx } from "@/lib/db";
import { toNum } from "@/lib/utils";
import { round2 } from "@/lib/calc/tds";

/**
 * Documents whose "settled" state is DERIVED from voucher allocations, so a
 * voucher saved, edited or deleted anywhere (its own screen or the Voucher
 * Register) leaves the source document reading right:
 *
 *  - DriverSalary  ← DRIVER_SALARY allocations (paid + shortage adjusted)
 *  - DriverAdvance ← DRIVER_ADVANCE allocations (received back in cash)
 *  - StaffLoan     ← STAFF_LOAN allocations + salary-row recoveries
 *
 * `excludeVoucherId` lets a delete recompute as if the voucher were gone
 * before its soft-delete lands.
 */
async function liveAllocations(
  tx: Tx,
  firmId: string,
  refType: "DRIVER_SALARY" | "DRIVER_ADVANCE" | "STAFF_LOAN",
  refIds: string[],
  excludeVoucherId?: string | null
) {
  if (!refIds.length) return [];
  return tx.voucherAllocation.findMany({
    where: {
      refType,
      refId: { in: refIds },
      voucher: { deletedAt: null, firmId, ...(excludeVoucherId ? { id: { not: excludeVoucherId } } : {}) },
    },
    select: {
      refId: true,
      amount: true,
      deduction: true,
      voucher: { select: { voucherDate: true, bankPartyId: true } },
    },
  });
}

/** paidAmount / status of driver salary months = what live vouchers settled. */
export async function recomputeDriverSalaryRows(
  tx: Tx,
  firmId: string,
  rowIds: string[],
  excludeVoucherId?: string | null
): Promise<void> {
  const ids = Array.from(new Set(rowIds));
  if (!ids.length) return;
  const rows = await tx.driverSalary.findMany({ where: { id: { in: ids }, deletedAt: null } });
  const allocs = await liveAllocations(tx, firmId, "DRIVER_SALARY", ids, excludeVoucherId);
  for (const r of rows) {
    const mine = allocs.filter((a) => a.refId === r.id);
    const paid = round2(mine.reduce((s, a) => s + toNum(a.amount) + toNum(a.deduction), 0));
    const latest = mine.sort((a, b) => b.voucher.voucherDate.getTime() - a.voucher.voucherDate.getTime())[0];
    const full = paid >= toNum(r.netPayable) - 0.009 && paid > 0;
    await tx.driverSalary.update({
      where: { id: r.id },
      data: {
        paidAmount: paid,
        paymentStatus: full ? "PAID" : "PENDING",
        paymentDate: full ? latest?.voucher.voucherDate ?? null : null,
        paymentHeadId: full ? latest?.voucher.bankPartyId ?? null : null,
      },
    });
  }
}

/**
 * Shortage adjusted AT PAYMENT time on a voucher is released when that voucher
 * goes: per salary row, the linked shortages may only stay adjusted up to what
 * the row itself deducted when processed (shortageDeduction).
 */
export async function releaseDriverShortagesForVoucher(
  tx: Tx,
  firmId: string,
  allocations: { refType: string; refId: string; deduction: unknown }[]
): Promise<void> {
  let give = round2(
    allocations.filter((a) => a.refType === "DRIVER_SALARY").reduce((s, a) => s + toNum(a.deduction), 0)
  );
  if (give <= 0) return;
  const anchor = await tx.driverSalary.findFirst({
    where: { id: { in: allocations.filter((a) => a.refType === "DRIVER_SALARY").map((a) => a.refId) } },
    select: { driverId: true },
  });
  if (!anchor) return;
  const salaries = await tx.driverSalary.findMany({
    where: { firmId, driverId: anchor.driverId, deletedAt: null },
    orderBy: [{ month: "desc" }, { createdAt: "desc" }],
  });
  for (const s of salaries) {
    if (give <= 0) break;
    const linked = await tx.driverShortage.findMany({
      where: { salaryId: s.id, deletedAt: null },
      orderBy: { date: "desc" },
    });
    let excess = round2(linked.reduce((sum, r) => sum + toNum(r.adjustedAmount), 0) - toNum(s.shortageDeduction));
    for (const sh of linked) {
      if (excess <= 0 || give <= 0) break;
      const adj = toNum(sh.adjustedAmount);
      const back = Math.min(adj, excess, give);
      excess = round2(excess - back);
      give = round2(give - back);
      const left = round2(adj - back);
      await tx.driverShortage.update({
        where: { id: sh.id },
        data: { adjustedAmount: left, status: "PENDING", ...(left <= 0 ? { salaryId: null } : {}) },
      });
    }
  }
}

/** A driver advance received back in cash (Receipt Voucher) is ADJUSTED once fully covered. */
export async function recomputeDriverAdvances(
  tx: Tx,
  firmId: string,
  ids: string[],
  excludeVoucherId?: string | null
): Promise<void> {
  const uniq = Array.from(new Set(ids));
  if (!uniq.length) return;
  const advances = await tx.driverAdvance.findMany({ where: { id: { in: uniq }, deletedAt: null } });
  const allocs = await liveAllocations(tx, firmId, "DRIVER_ADVANCE", uniq, excludeVoucherId);
  for (const a of advances) {
    if (a.tripId) continue; // consumed by a trip sheet — that owns its status
    const mine = allocs.filter((x) => x.refId === a.id);
    const received = round2(mine.reduce((s, x) => s + toNum(x.amount) + toNum(x.deduction), 0));
    const latest = mine.sort((x, y) => y.voucher.voucherDate.getTime() - x.voucher.voucherDate.getTime())[0];
    const full = received >= toNum(a.amount) - 0.009 && received > 0;
    if (full && a.status !== "ADJUSTED") {
      await tx.driverAdvance.update({
        where: { id: a.id },
        data: { status: "ADJUSTED", adjustedDate: latest?.voucher.voucherDate ?? new Date() },
      });
    } else if (!full && a.status === "ADJUSTED") {
      await tx.driverAdvance.update({ where: { id: a.id }, data: { status: "PENDING", adjustedDate: null } });
    }
  }
}

/** Amount received back against a driver advance through Receipt Vouchers. */
export async function driverAdvanceReceived(
  tx: Tx,
  firmId: string,
  ids: string[],
  excludeVoucherId?: string | null
): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  for (const a of await liveAllocations(tx, firmId, "DRIVER_ADVANCE", ids, excludeVoucherId)) {
    out.set(a.refId, round2((out.get(a.refId) ?? 0) + toNum(a.amount) + toNum(a.deduction)));
  }
  return out;
}

/** Staff loan: recovered = payroll recoveries + Receipt / salary-payment voucher allocations. */
export async function staffLoanRecovered(
  tx: Tx,
  firmId: string,
  ids: string[],
  excludeVoucherId?: string | null
): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  if (!ids.length) return out;
  const rows = await tx.staffSalary.groupBy({
    by: ["loanId"],
    where: { loanId: { in: ids }, deletedAt: null },
    _sum: { loanRecovery: true },
  });
  for (const r of rows) if (r.loanId) out.set(r.loanId, round2(toNum(r._sum.loanRecovery ?? 0)));
  for (const a of await liveAllocations(tx, firmId, "STAFF_LOAN", ids, excludeVoucherId)) {
    out.set(a.refId, round2((out.get(a.refId) ?? 0) + toNum(a.amount) + toNum(a.deduction)));
  }
  return out;
}

export async function recomputeStaffLoans(
  tx: Tx,
  firmId: string,
  ids: string[],
  excludeVoucherId?: string | null
): Promise<void> {
  const uniq = Array.from(new Set(ids));
  if (!uniq.length) return;
  const loans = await tx.staffLoan.findMany({ where: { id: { in: uniq }, deletedAt: null } });
  const rec = await staffLoanRecovered(tx, firmId, uniq, excludeVoucherId);
  for (const l of loans) {
    const status = (rec.get(l.id) ?? 0) + 0.01 >= toNum(l.amount) ? "CLOSED" : "OPEN";
    if (status !== l.status) await tx.staffLoan.update({ where: { id: l.id }, data: { status } });
  }
}
