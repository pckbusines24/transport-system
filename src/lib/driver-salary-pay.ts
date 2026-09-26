import type { Tx } from "@/lib/db";

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
