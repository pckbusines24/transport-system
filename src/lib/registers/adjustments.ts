/**
 * MAIN VALUE ≠ ADJUSTMENTS.
 *
 * A chalan or broker slip lets the user enter Detention, ODC, Fine and Other
 * (additions) and LD Charge and Shortage (deductions). None of them are part of
 * the freight the document was booked at, so none of them may ever be folded
 * into the Purchase / Sale Register's main value.
 *
 *   MAIN VALUE = original Freight / Purchase / Sale value only
 *   NET VALUE  = MAIN VALUE + ADDITIONS − DEDUCTIONS
 *
 * Every register, drill-down and export splits the document with this module so
 * the three numbers can never drift apart or get merged by accident.
 */

const r2 = (n: number) => Math.round(n * 100) / 100;

/** The six adjustment fields a chalan / broker slip side can carry. */
export interface AdjustmentInput {
  /** additions */
  detention?: number;
  odcAmt?: number;
  fineAmt?: number;
  otherAmt?: number;
  /** deductions */
  ldCharge?: number;
  shortageAmt?: number;
}

export interface RegisterAmounts {
  /** original freight / purchase / sale value — never touched by adjustments */
  main: number;
  detention: number;
  odcAmt: number;
  fineAmt: number;
  otherAmt: number;
  ldCharge: number;
  shortageAmt: number;
  /** detention + odc + fine + other */
  additions: number;
  /** ldCharge + shortage */
  deductions: number;
  /** main + additions − deductions */
  net: number;
}

export const ZERO_AMOUNTS: RegisterAmounts = {
  main: 0,
  detention: 0,
  odcAmt: 0,
  fineAmt: 0,
  otherAmt: 0,
  ldCharge: 0,
  shortageAmt: 0,
  additions: 0,
  deductions: 0,
  net: 0,
};

/**
 * Split a document into its main value and its adjustments. `main` is passed in
 * untouched — the caller must hand over the FREIGHT field, never a pre-totalled
 * "chalan amount" that already has the adjustments baked in.
 */
export function splitAmounts(main: number, a: AdjustmentInput = {}): RegisterAmounts {
  const detention = r2(a.detention ?? 0);
  const odcAmt = r2(a.odcAmt ?? 0);
  const fineAmt = r2(a.fineAmt ?? 0);
  const otherAmt = r2(a.otherAmt ?? 0);
  const ldCharge = r2(a.ldCharge ?? 0);
  const shortageAmt = r2(a.shortageAmt ?? 0);

  const additions = r2(detention + odcAmt + fineAmt + otherAmt);
  const deductions = r2(ldCharge + shortageAmt);
  const mainValue = r2(main);

  return {
    main: mainValue,
    detention,
    odcAmt,
    fineAmt,
    otherAmt,
    ldCharge,
    shortageAmt,
    additions,
    deductions,
    net: r2(mainValue + additions - deductions),
  };
}

/** Accumulate amounts across documents, keeping every component separate. */
export function addAmounts(a: RegisterAmounts, b: RegisterAmounts): RegisterAmounts {
  return {
    main: r2(a.main + b.main),
    detention: r2(a.detention + b.detention),
    odcAmt: r2(a.odcAmt + b.odcAmt),
    fineAmt: r2(a.fineAmt + b.fineAmt),
    otherAmt: r2(a.otherAmt + b.otherAmt),
    ldCharge: r2(a.ldCharge + b.ldCharge),
    shortageAmt: r2(a.shortageAmt + b.shortageAmt),
    additions: r2(a.additions + b.additions),
    deductions: r2(a.deductions + b.deductions),
    net: r2(a.net + b.net),
  };
}

export function sumAmounts(list: RegisterAmounts[]): RegisterAmounts {
  return list.reduce(addAmounts, ZERO_AMOUNTS);
}
