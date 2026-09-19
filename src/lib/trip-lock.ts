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

/**
 * Register lock: diesel / toll expense lines and AdBlue issues reach a trip
 * sheet purely by vehicle + date (the sheet fetches whatever falls inside its
 * window), so a line dated inside a live trip's window IS on that sheet and
 * must not be deleted underneath it. Returns the covering trip's number, or
 * null when no trip window contains the date.
 */
export async function tripCoveringDate(
  tx: Tx,
  firmId: string,
  vehicleId: string,
  date: Date
): Promise<string | null> {
  const trips = await tx.trip.findMany({
    where: { firmId, vehicleId, deletedAt: null },
    select: { tripNo: true, tripDate: true, returnDate: true, fromDate: true, toDate: true },
  });
  const dayEnd = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate(), 23, 59, 59, 999);
  const hit = trips.find((t) => {
    const start = t.fromDate ?? t.tripDate;
    const end = dayEnd(t.toDate ?? t.returnDate ?? t.tripDate);
    return start <= date && date <= end;
  });
  return hit?.tripNo ?? null;
}

export const tripFetchLockMessage = (what: string, tripNo: string) =>
  `This ${what} is fetched into trip sheet ${tripNo} (it falls inside that trip's date window). Delete or re-date that trip sheet first.`;
