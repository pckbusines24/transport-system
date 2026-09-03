import { round2 } from "./tds";

/**
 * THE TDS BASE ENGINE — one place decides what TDS is charged on.
 *
 *   TDS BASE  = the Freight / Commission amount designated as TDS-applicable
 *   TDS AMOUNT = TDS BASE x TDS RATE
 *
 * TDS BASE != NET PAYABLE. Detention, ODC, Fine Slip, Other Amount, LD Charge
 * and Shortage are settlement adjustments: they move the Net Payable and
 * nothing else. Adding, editing or clearing any of them must leave the TDS
 * base, the TDS amount, the TDS register and every TDS report untouched.
 *
 * The rule is enforced by CONSTRUCTION, not by discipline: `tdsBaseAmount`
 * takes the TDS-applicable components by name and has no parameter through
 * which a document total could be passed. A caller physically cannot hand it
 * `chalanAmt` or `netPayable` and have it type-check.
 *
 * Adding a new challan / broker-slip field therefore CANNOT widen the base by
 * accident — the default for anything new is excluded. Making a new field
 * TDS-applicable means deliberately adding it to `TdsBaseInput` and to
 * TDS_APPLICABLE_COMPONENTS below, which is a visible, reviewable change.
 */

/** The only components that may ever form a TDS base. */
export const TDS_APPLICABLE_COMPONENTS = ["freight", "commission"] as const;
export type TdsComponent = (typeof TDS_APPLICABLE_COMPONENTS)[number];

/**
 * Settlement adjustments — documented here so the exclusion is explicit rather
 * than merely implied by absence. These never touch the base.
 */
export const TDS_EXCLUDED_ADJUSTMENTS = [
  "detention",
  "odcAmt",
  "fineSlip",
  "otherAmt",
  "ldCharge",
  "shortageAmt",
] as const;
export type TdsExcludedAdjustment = (typeof TDS_EXCLUDED_ADJUSTMENTS)[number];

export interface TdsBaseInput {
  /** freight / lorry hire designated TDS-applicable */
  freight?: number;
  /** commission, when the deduction is on commission rather than freight */
  commission?: number;
}

export interface TdsResult {
  /** what TDS was actually charged on */
  base: number;
  pct: number;
  amount: number;
  /** true when the base came from a user override, not the freight/commission */
  isManualBase: boolean;
}

/** The default TDS base: the TDS-applicable components, nothing else. */
export function tdsBaseAmount(i: TdsBaseInput): number {
  return round2((i.freight ?? 0) + (i.commission ?? 0));
}

/**
 * The base actually used. A manual override wins when supplied — but it is an
 * explicit, separate argument, never something an adjustment can slip into.
 * Callers that persist an override are responsible for its audit trail (old
 * base, new base, who, when, why).
 */
export function resolveTdsBase(
  i: TdsBaseInput,
  manualBase?: number | null
): { base: number; isManualBase: boolean } {
  const isManualBase = manualBase != null && manualBase >= 0;
  return {
    base: isManualBase ? round2(manualBase) : tdsBaseAmount(i),
    isManualBase,
  };
}

/**
 * TDS = base x rate. The single entry point every module should use, so the
 * base and the amount can never disagree about what was taxed.
 */
export function computeTds(
  i: TdsBaseInput,
  pct: number,
  opts?: { manualBase?: number | null; manualAmount?: number | null }
): TdsResult {
  const { base, isManualBase } = resolveTdsBase(i, opts?.manualBase);
  // a hand-entered TDS amount is honoured only when no rate is given, matching
  // how the chalan and slip forms already behave
  const amount =
    pct > 0 ? round2((base * pct) / 100) : round2(opts?.manualAmount ?? 0);
  return { base, pct, amount, isManualBase };
}
