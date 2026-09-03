import { amountByBasis, type RateBasis } from "@/lib/calc/rate";
import { round2 } from "@/lib/calc/tds";
import { computeTds } from "@/lib/calc/tds-base";

/**
 * Broker slip dual-side math (party = receivable, owner/vehicle = payable).
 * chalanAmt = freight + detention + odc + fine + other − ld − shortage
 *
 * NOTE: `freight` is the MAIN value. Everything else on that line is an
 * ADJUSTMENT and is reported separately — see the Purchase & Sale Register.
 * netAmt    = chalanAmt − tds − commission − mamool − paymentCharge
 * balance   = netAmt − advance
 */
export interface BrokerSideInput {
  rate: number;
  rateBasis: RateBasis;
  qty: number;
  actualWt: number;
  chargeWt: number;
  /** manual freight overrides rate calc when provided (> 0) */
  manualFreight?: number;
  detention: number;
  odcAmt: number;
  fineAmt: number;
  otherAmt: number;
  ldCharge: number;
  shortageAmt: number;
  tdsPct: number;
  /** manual TDS amount used when tdsPct is 0 */
  tdsAmtManual?: number;
  commPct: number;
  /** manual commission amount used when commPct is 0 */
  commAmtManual?: number;
  mamool: number;
  paymentCharge: number;
  advance: number;
}

export interface BrokerSideTotals {
  freight: number;
  chalanAmt: number;
  /** what TDS was charged on — the freight alone, never chalanAmt */
  tdsBase: number;
  tdsAmt: number;
  commAmt: number;
  netAmt: number;
  balance: number;
}

export function computeBrokerSide(i: BrokerSideInput): BrokerSideTotals {
  const freight =
    i.manualFreight && i.manualFreight > 0
      ? round2(i.manualFreight)
      : amountByBasis(i.rate, i.rateBasis, i.qty, i.actualWt, i.chargeWt);

  const chalanAmt = round2(
    freight +
      i.detention +
      i.odcAmt +
      i.fineAmt +
      i.otherAmt -
      i.ldCharge -
      i.shortageAmt
  );

  // TDS is levied on the FREIGHT only. Detention, ODC, fine, other, LD and
  // shortage are settlement adjustments and never enter the base — see
  // `@/lib/calc/tds-base`. (This used to tax chalanAmt, so every adjustment
  // silently moved the TDS.)
  const tds = computeTds({ freight }, i.tdsPct, { manualAmount: i.tdsAmtManual });
  const tdsAmt = tds.amount;
  const commAmt =
    i.commPct > 0 ? round2((chalanAmt * i.commPct) / 100) : round2(i.commAmtManual ?? 0);

  const netAmt = round2(chalanAmt - tdsAmt - commAmt - i.mamool - i.paymentCharge);
  const balance = round2(netAmt - i.advance);

  return { freight, chalanAmt, tdsBase: tds.base, tdsAmt, commAmt, netAmt, balance };
}

// ---------- advances ----------

export const ADVANCE_TYPES = [
  "CASH",
  "BANK",
  "DIESEL",
  "TOLL",
  "TYRE",
  "SPARE_PARTS",
  "REPAIR",
  "OTHER",
  /** consumes an existing advance voucher — reference link, posts nothing */
  "ADVANCE_ADJ",
] as const;
export type BrokerAdvanceType = (typeof ADVANCE_TYPES)[number];

/** Advance head kinds — sourced from the Income/Expense heads and Bank/Cash masters. */
export const ADVANCE_HEAD_KINDS = ["INCOME", "EXPENSE", "BANK", "CASH"] as const;
export type AdvanceHeadKind = (typeof ADVANCE_HEAD_KINDS)[number];

export const ADVANCE_HEAD_KIND_LABELS: Record<AdvanceHeadKind, string> = {
  INCOME: "Income Head",
  EXPENSE: "Expense Head",
  BANK: "Bank Account",
  CASH: "Cash Account",
};

export interface BrokerAdvance {
  side: "P" | "V";
  type: BrokerAdvanceType;
  /** master-driven head selection (new UI); legacy rows may only have type/bankName */
  headKind?: AdvanceHeadKind | null;
  headId?: string | null;
  supplierName?: string | null;
  bankName?: string | null;
  dieselQty?: number | null;
  dieselRate?: number | null;
  amount: number;
  date?: string | null; // ISO yyyy-mm-dd
  remarks?: string | null;
  /** ADVANCE_ADJ only — the PartyAdvance this row consumes */
  advanceId?: string | null;
  advanceVoucherNo?: string | null;
}

export function dieselAmount(qty: number, rate: number): number {
  return round2(qty * rate);
}

export function advanceAmount(a: BrokerAdvance): number {
  if (a.type === "DIESEL" && (a.dieselQty ?? 0) > 0 && (a.dieselRate ?? 0) > 0) {
    return dieselAmount(a.dieselQty ?? 0, a.dieselRate ?? 0);
  }
  return round2(a.amount);
}

export function sideAdvanceTotal(advances: BrokerAdvance[], side: "P" | "V"): number {
  return round2(
    advances.filter((a) => a.side === side).reduce((s, a) => s + advanceAmount(a), 0)
  );
}

// ---------- trip km ----------

export function computeTripKm(args: {
  startKm?: number | null;
  unloadKm?: number | null;
  slipDate?: Date | null;
  unloadDate?: Date | null;
}): { runningKm: number | null; tripDays: number | null } {
  const runningKm =
    args.startKm != null && args.unloadKm != null && args.unloadKm > args.startKm
      ? round2(args.unloadKm - args.startKm)
      : null;
  let tripDays: number | null = null;
  if (args.slipDate && args.unloadDate) {
    const ms = args.unloadDate.getTime() - args.slipDate.getTime();
    if (ms >= 0) tripDays = Math.floor(ms / 86400000) + 1;
  }
  return { runningKm, tripDays };
}
