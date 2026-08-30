import type { Tx } from "@/lib/db";

/**
 * Wrong-FY date guard for ENTRY forms: a document's own date must fall inside
 * the given financial year. Callers pass the SESSION FY for fresh documents
 * (creating belongs to the year the user is standing in) and the DOCUMENT'S
 * OWN FY for edits (an old-year doc edits from the new year — FY continuity —
 * but its date must stay inside its own year, or registers/numbering split).
 */
/**
 * DAY-level compare in IST, never time-level: the browser serializes a
 * picked "1 April" as 31 March 18:30 UTC, and the UTC production server's
 * local getters then read the wrong day — rejecting 1 April inside its own
 * FY. The business runs on Indian time (the dashboard pins IST the same
 * way), so the calendar day is extracted at +5:30 for BOTH the form date
 * and the FY bounds, whatever midnight each was stored with.
 */
const IST_MS = 5.5 * 3600 * 1000;
const dayNum = (d: Date) => {
  const t = new Date(d.getTime() + IST_MS);
  return t.getUTCFullYear() * 10000 + (t.getUTCMonth() + 1) * 100 + t.getUTCDate();
};

/**
 * The END bound needs one extra rule: an endDate stamped 23:59:59 in UTC
 * shifts to 05:29 IST the NEXT morning, which would admit 1 April of the
 * following year. A late UTC time-of-day (≥ 12:00) means the stamp already
 * names its intended day in UTC — read it there; early stamps (date-only
 * UTC midnights) read in IST like everything else.
 */
const endDayNum = (d: Date) =>
  d.getUTCHours() >= 12
    ? d.getUTCFullYear() * 10000 + (d.getUTCMonth() + 1) * 100 + d.getUTCDate()
    : dayNum(d);

export async function assertDateInFy(
  tx: Tx,
  session: { fyId: string },
  date: Date,
  what = "entry"
): Promise<void> {
  const fy = await tx.financialYear.findUnique({ where: { id: session.fyId } });
  if (!fy) return;
  const d = dayNum(date);
  if (d < dayNum(fy.startDate) || d > endDayNum(fy.endDate)) {
    // label the IST day — the same day the guard actually evaluated
    const t = new Date(date.getTime() + IST_MS);
    const label = `${String(t.getUTCDate()).padStart(2, "0")}/${String(t.getUTCMonth() + 1).padStart(2, "0")}/${t.getUTCFullYear()}`;
    throw new Error(
      `This date (${label}) does not fall in FY ${fy.label} — switch to that FY to make this ${what}.`
    );
  }
}
