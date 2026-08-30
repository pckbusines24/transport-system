import type { Tx } from "@/lib/db";

/**
 * Chain lock, trip side: a chalan / broker slip that a trip sheet has taken
 * into its accounts must not be deleted (or cancelled) underneath it — the trip
 * sheet releases the document first. Returns the error message, or null when
 * the document is free.
 */
export async function tripLockError(
  tx: Tx,
  refType: "CHALAN" | "BROKER_SLIP",
  refId: string,
  what: string
): Promise<string | null> {
  const link = await tx.tripDoc.findFirst({ where: { refType, refId } });
  if (!link) return null;
  const trip = await tx.trip.findFirst({
    where: { id: link.tripId, deletedAt: null },
    select: { tripNo: true },
  });
  if (!trip) return null; // stale link of a deleted trip — not a lock
  return `This ${what} is tied into trip sheet ${trip.tripNo}'s accounts — edit that trip sheet to remove it (or delete the trip) first, then this ${what} can be deleted.`;
}
