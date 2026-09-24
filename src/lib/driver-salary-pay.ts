import type { Tx } from "@/lib/db";
import { toNum } from "@/lib/utils";
import { round2 } from "@/lib/calc/tds";

/**
 * Driver salary payments are Payment Vouchers whose allocation (refType
 * DRIVER_SALARY) points at the salary row that carried the running balance:
 * `amount` = money paid, `deduction` = shortage adjusted in the same run.
 * Payments settle the driver's months oldest-first, so undoing one run walks
 * the months newest-first and gives back exactly what that run consumed.
 */
export async function undoDriverSalaryVoucherTx(tx: Tx, firmId: string, voucherId: string): Promise<void> {
  const allocs = await tx.voucherAllocation.findMany({
    where: { voucherId, refType: "DRIVER_SALARY" },
    select: { refId: true, amount: true, deduction: true },
  });
  for (const a of allocs) {
    const anchor = await tx.driverSalary.findFirst({ where: { id: a.refId }, select: { driverId: true } });
    if (!anchor) continue;
    let give = round2(toNum(a.amount) + toNum(a.deduction));
    if (give <= 0) continue;
    const salaries = await tx.driverSalary.findMany({
      where: { firmId, driverId: anchor.driverId, deletedAt: null },
      orderBy: [{ month: "desc" }, { createdAt: "desc" }],
    });
    // money + shortage: LIFO across the months this driver was paid
    for (const s of salaries) {
      if (give <= 0) break;
      const paid = toNum(s.paidAmount);
      if (paid <= 0) continue;
      const take = Math.min(paid, give);
      give = round2(give - take);
      const left = round2(paid - take);
      await tx.driverSalary.update({
        where: { id: s.id },
        data: {
          paidAmount: left,
          ...(left < toNum(s.netPayable) - 0.009
            ? { paymentStatus: "PENDING", paymentDate: null, paymentHeadId: null }
            : {}),
        },
      });
    }
    // shortage adjusted AT PAYMENT time is released; what the salary itself
    // deducted when processed (shortageDeduction) stays
    let short = round2(toNum(a.deduction));
    if (short <= 0) continue;
    for (const s of salaries) {
      if (short <= 0) break;
      const linked = await tx.driverShortage.findMany({
        where: { salaryId: s.id, deletedAt: null },
        orderBy: { date: "desc" },
      });
      let excess = round2(
        linked.reduce((sum, r) => sum + toNum(r.adjustedAmount), 0) - toNum(s.shortageDeduction)
      );
      for (const sh of linked) {
        if (excess <= 0 || short <= 0) break;
        const adj = toNum(sh.adjustedAmount);
        const back = Math.min(adj, excess, short);
        excess = round2(excess - back);
        short = round2(short - back);
        const left = round2(adj - back);
        await tx.driverShortage.update({
          where: { id: sh.id },
          data: { adjustedAmount: left, status: "PENDING", ...(left <= 0 ? { salaryId: null } : {}) },
        });
      }
    }
  }
}

/** Live payment vouchers settling any of a driver's salaries. */
export async function driverSalaryVouchers(
  tx: Tx,
  firmId: string,
  salaryIds: string[]
): Promise<{ id: string; voucherNo: string }[]> {
  if (!salaryIds.length) return [];
  const allocs = await tx.voucherAllocation.findMany({
    where: { refType: "DRIVER_SALARY", refId: { in: salaryIds }, voucher: { deletedAt: null, firmId } },
    select: { voucher: { select: { id: true, voucherNo: true } } },
  });
  const seen = new Map<string, string>();
  for (const a of allocs) seen.set(a.voucher.id, a.voucher.voucherNo);
  return Array.from(seen.entries()).map(([id, voucherNo]) => ({ id, voucherNo }));
}
