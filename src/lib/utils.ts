import { type ClassValue, clsx } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

/**
 * Pinned to IST: the business runs on Indian time, but server-rendered pages
 * (prints) run on a UTC host — reading the instant with local getters there
 * showed 31 March for a chalan the user dated 1 April. The browser is IST
 * anyway, so client rendering is unchanged; the server now agrees with it.
 */
export function formatDate(d: Date | string | null | undefined): string {
  if (!d) return "";
  const date = typeof d === "string" ? new Date(d) : d;
  const t = new Date(date.getTime() + 5.5 * 3600 * 1000);
  const dd = String(t.getUTCDate()).padStart(2, "0");
  const mm = String(t.getUTCMonth() + 1).padStart(2, "0");
  return `${dd}/${mm}/${t.getUTCFullYear()}`;
}

/**
 * Half-open [gte, lt) range for a yyyy-mm-dd day span, anchored to IST like
 * formatDate. Documents are dated at IST midnight (18:30Z the day before),
 * so a server-local (UTC in production) midnight boundary pushed a 1 August
 * chalan into July. Works for 00:00Z-stored rows too — both fall inside.
 */
export function istDayRange(fromIso: string, toIso: string): { gte: Date; lt: Date } {
  return { gte: istDayStart(fromIso), lt: new Date(istDayEnd(toIso).getTime() + 1) };
}

/**
 * First instant of a yyyy-mm-dd day in IST — the `gte` of a date filter.
 * `new Date(iso + "T00:00:00")` is server-local (UTC in production), which
 * dropped documents of the first day (stored at IST midnight = 18:30Z the
 * day before) from every register's period.
 */
export function istDayStart(iso: string): Date {
  return new Date(`${iso}T00:00:00+05:30`);
}

/**
 * Last instant of a yyyy-mm-dd day in IST — the `lte` of a date filter.
 * `new Date(iso + "T23:59:59")` is UTC in production and reached 05:29 IST
 * of the NEXT day, pulling 1 November documents into a 1–31 October period.
 */
export function istDayEnd(iso: string): Date {
  return new Date(istDayStart(iso).getTime() + 24 * 3600 * 1000 - 1);
}

export function parseDdMmYyyy(s: string): Date | null {
  const m = s.trim().match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})$/);
  if (!m) return null;
  const day = Number(m[1]);
  const month = Number(m[2]);
  const d = new Date(Number(m[3]), month - 1, day);
  // reject rollover: "31/02" must not silently become 3 March
  if (d.getDate() !== day || d.getMonth() !== month - 1) return null;
  return isNaN(d.getTime()) ? null : d;
}

export function formatMoney(n: number | string | null | undefined): string {
  const v = typeof n === "string" ? parseFloat(n) : n ?? 0;
  return v.toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

/**
 * Weights are stored as Decimal(12,3), so three places IS their precision.
 * Adding them as JS floats does not respect that — summing a few POD shortage
 * weights produces 0.10500000000000001, which the register then printed in
 * full. Round every weight SUM through this.
 */
export function roundWt(n: number): number {
  return Math.round((n + Number.EPSILON) * 1000) / 1000;
}

/** A weight for display: grouped, at most three decimals, no trailing zeros. */
export function formatWt(n: number | string | null | undefined): string {
  const raw = typeof n === "string" ? parseFloat(n) : n ?? 0;
  const v = roundWt(isNaN(raw) ? 0 : raw);
  return v.toLocaleString("en-IN", { maximumFractionDigits: 3 });
}

/**
 * Numeric-aware LR/C.Note number ordering: "10002" < "10010" < "9001A".
 * Plain string sort put 10010 before 9001; the bill's S.No column follows
 * this order everywhere (entry grid, preview, print) so an edit never
 * reshuffles the lines.
 */
export function compareLrNo(a: string, b: string): number {
  const na = parseInt(a.replace(/\D/g, ""), 10);
  const nb = parseInt(b.replace(/\D/g, ""), 10);
  if (!isNaN(na) && !isNaN(nb) && na !== nb) return na - nb;
  return a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" });
}

/**
 * LR list order: LR date ascending, then LR number ascending within the same
 * day (numerically — "9" before "10"). Days compare by IST calendar date, so
 * LRs of one day stay together however their dates were stored.
 */
export function compareLrDateThenNo(
  a: { lrDate: Date | string; lrNo: string },
  b: { lrDate: Date | string; lrNo: string }
): number {
  const day = (d: Date | string) => formatDate(d).split("/").reverse().join("");
  return day(a.lrDate).localeCompare(day(b.lrDate)) || compareLrNo(a.lrNo, b.lrNo);
}

export function toNum(v: unknown): number {
  if (v === null || v === undefined || v === "") return 0;
  // handles strings, numbers AND Prisma Decimal objects (via toString)
  const n = typeof v === "number" ? v : parseFloat(String(v));
  return isNaN(n) ? 0 : n;
}
