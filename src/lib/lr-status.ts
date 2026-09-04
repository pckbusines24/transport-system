/**
 * Which LRs a chalan may move to ON_CHALAN.
 *
 * An LR's status is a lifecycle, and the chalan sits early in it:
 *
 *   PENDING -> ON_CHALAN -> ARRIVED -> DELIVERED (POD) -> BILLED (invoice)
 *
 * Saving an already-final chalan used to set EVERY LR on it to ON_CHALAN, so a
 * routine edit — a detention amount, a driver name, the unload KM — dragged
 * LRs that had since been delivered and billed back to ON_CHALAN. The bill kept
 * its InvoiceLr links, so nothing looked broken on the billing side; only the
 * LR Register showed the LRs sitting at ON_CHALAN again.
 *
 * Two rules, both enforced here:
 *   - only LRs this edit ADDS are candidates; ones already on the chalan keep
 *     whatever status they have earned since;
 *   - the move is forward-only, so an LR that has reached DELIVERED or BILLED
 *     is never dragged backwards.
 */

export type LrStatusName = "PENDING" | "ON_CHALAN" | "ARRIVED" | "DELIVERED" | "BILLED";

/**
 * Statuses a chalan may legitimately move to ON_CHALAN. DELIVERED is excluded
 * because it is POD-derived, and BILLED because an invoice depends on it.
 */
export const ON_CHALAN_SOURCE_STATUSES: readonly LrStatusName[] = ["PENDING", "ARRIVED"];

export function canMoveToOnChalan(status: string): boolean {
  return (ON_CHALAN_SOURCE_STATUSES as readonly string[]).includes(status);
}

/**
 * The LRs an edit newly attaches to a chalan — the only ones whose status the
 * edit may touch. `alreadyLinkedIds` is the chalan's LR set before the edit.
 */
export function newlyLinkedLrIds(
  lrIds: readonly string[],
  alreadyLinkedIds: readonly string[]
): string[] {
  const linked = new Set(alreadyLinkedIds);
  // de-duplicated: a repeated id must not produce a repeated update
  return Array.from(new Set(lrIds.filter((id) => !linked.has(id))));
}
