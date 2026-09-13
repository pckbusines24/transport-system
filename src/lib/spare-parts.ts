/**
 * Spare Parts & Warranty — shared, dependency-free helpers.
 *
 * This module is operational tracking ONLY: nothing here (and nothing in the
 * screens / actions built on it) touches the ledger, vouchers, purchase
 * register, stock value, P&L or Tally. Purchase rate is informational.
 */

export type WarrantyStatus = "ACTIVE" | "EXPIRING_SOON" | "EXPIRING_30" | "EXPIRED" | "NONE";

export interface WarrantyPosition {
  status: WarrantyStatus;
  /** calendar days from today to expiry (negative once expired); null without warranty */
  daysLeft: number | null;
}

const DAY = 86400000;
const IST = 5.5 * 3600 * 1000;

/** IST calendar day of an instant, as a UTC-midnight epoch — safe on a UTC server */
function istDay(d: Date): number {
  const s = new Date(d.getTime() + IST);
  return Date.UTC(s.getUTCFullYear(), s.getUTCMonth(), s.getUTCDate());
}

/**
 * Where a warranty stands today.
 *   🟢 ACTIVE          more than 60 days left
 *   🟡 EXPIRING_SOON   31–60 days left
 *   🟠 EXPIRING_30     0–30 days left
 *   🔴 EXPIRED         past the expiry date
 */
export function warrantyPosition(
  expiry: Date | string | null | undefined,
  now: Date = new Date()
): WarrantyPosition {
  if (!expiry) return { status: "NONE", daysLeft: null };
  const e = typeof expiry === "string" ? new Date(expiry) : expiry;
  if (isNaN(e.getTime())) return { status: "NONE", daysLeft: null };
  const days = Math.round((istDay(e) - istDay(now)) / DAY);
  if (days < 0) return { status: "EXPIRED", daysLeft: days };
  if (days <= 30) return { status: "EXPIRING_30", daysLeft: days };
  if (days <= 60) return { status: "EXPIRING_SOON", daysLeft: days };
  return { status: "ACTIVE", daysLeft: days };
}

export const WARRANTY_LABEL: Record<WarrantyStatus, string> = {
  ACTIVE: "Active",
  EXPIRING_SOON: "Expiring Soon",
  EXPIRING_30: "Expiring Within 30 Days",
  EXPIRED: "Expired",
  NONE: "No Warranty",
};

/** badge classes — one colour per status, readable in light and dark */
export const WARRANTY_CLASS: Record<WarrantyStatus, string> = {
  ACTIVE: "bg-emerald-500/15 text-emerald-700 dark:text-emerald-400",
  EXPIRING_SOON: "bg-yellow-400/25 text-yellow-800 dark:text-yellow-300",
  EXPIRING_30: "bg-orange-500/15 text-orange-700 dark:text-orange-400",
  EXPIRED: "bg-red-500/15 text-red-700 dark:text-red-400",
  NONE: "bg-muted text-muted-foreground",
};

export const WARRANTY_DOT: Record<WarrantyStatus, string> = {
  ACTIVE: "🟢",
  EXPIRING_SOON: "🟡",
  EXPIRING_30: "🟠",
  EXPIRED: "🔴",
  NONE: "⚪",
};

/** Warranty Start + Period (months) = Warranty Expiry */
export function addMonths(d: Date, months: number): Date {
  const r = new Date(d);
  r.setMonth(r.getMonth() + months);
  return r;
}

export const PART_STATUS_LABEL: Record<string, string> = {
  AVAILABLE: "Available",
  INSTALLED: "Installed",
  REMOVED: "Removed",
};

export const EVENT_LABEL: Record<string, string> = {
  PURCHASE: "Purchase",
  INSTALL: "Installation",
  REMOVE: "Removal",
  WARRANTY_CLAIM: "Warranty Claim",
  WARRANTY_REPLACEMENT: "Warranty Replacement",
  REVIEWED: "Warranty Alert Reviewed",
};

export const CLAIM_STATUS_LABEL: Record<string, string> = {
  OPEN: "Open",
  APPROVED: "Approved",
  REJECTED: "Rejected",
  REPLACED: "Replaced",
};
