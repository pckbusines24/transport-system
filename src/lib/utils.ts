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

export function toNum(v: unknown): number {
  if (v === null || v === undefined || v === "") return 0;
  // handles strings, numbers AND Prisma Decimal objects (via toString)
  const n = typeof v === "number" ? v : parseFloat(String(v));
  return isNaN(n) ? 0 : n;
}
