import { revalidateTag } from "next/cache";

/**
 * Cache tag for the dashboard's Outstanding / Ageing tile.
 *
 * The tile aggregates every open invoice, chalan, slip, advance, salary and
 * settlement the firm has ever created, so it is far too expensive to
 * recompute on each view. It is cached per tenant instead, and every action
 * that writes a document the tile reads must call `revalidateOutstanding`
 * so the figures are never stale — the TTL on the cache is only a backstop.
 *
 * Models whose writes must revalidate: Invoice, Chalan, BrokerSlip, HireSlip,
 * OfficeTransaction, VehicleExpenseVoucher, AdblueTxn, StaffSalary,
 * PartyAdvance, PartyAdvanceUse, DriverSettlement, Voucher, VoucherAllocation,
 * plus the masters the rows are labelled and filtered by (Party, Vehicle,
 * Driver) and FinancialYear.
 */
export function outstandingTag(tenantId: string): string {
  return `outstanding:${tenantId}`;
}

/** Call after any mutation that can move an outstanding figure. */
export function revalidateOutstanding(tenantId: string): void {
  revalidateTag(outstandingTag(tenantId));
}
