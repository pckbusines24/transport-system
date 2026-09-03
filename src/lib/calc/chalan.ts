import { round2 } from "./tds";
import { computeTds } from "./tds-base";
import { amountByBasis, RateBasis } from "./rate";

export interface ChalanInput {
  rate: number;
  rateBasis: RateBasis;
  qty?: number;
  actualWt: number;
  chargeWt: number;
  /** manual vehicle freight overrides rate calc when provided (> 0) */
  manualFreight?: number;
  detention: number;
  odcAmt: number;
  fineSlip: number;
  otherAmt: number;
  ldCharge: number;
  shortageAmt: number;
  mamool: number;
  courierCharge: number;
  commissionPct: number;
  /** manual commission amount used when commissionPct is 0 */
  commissionAmt?: number;
  tdsPct: number;
  advances: number[];
}

export interface ChalanTotals {
  freight: number;
  totalChalanAmt: number;
  /** what TDS was charged on — the freight alone */
  tdsBase: number;
  commissionAmt: number;
  tdsAmt: number;
  grandTotal: number;
  advanceTotal: number;
  balance: number;
}

export function computeChalan(i: ChalanInput): ChalanTotals {
  const freight =
    i.manualFreight && i.manualFreight > 0
      ? round2(i.manualFreight)
      : amountByBasis(i.rate, i.rateBasis, i.qty ?? 0, i.actualWt, i.chargeWt);

  const totalChalanAmt = round2(
    freight + i.detention + i.odcAmt + i.fineSlip + i.otherAmt - i.ldCharge - i.shortageAmt
  );

  // TDS & commission are levied on the freight amount ONLY — detention, ODC,
  // fine slip and other charges are excluded from both bases.
  const commissionAmt =
    i.commissionPct > 0
      ? round2((freight * i.commissionPct) / 100)
      : round2(i.commissionAmt ?? 0);

  const tds = computeTds({ freight }, i.tdsPct);
  const tdsAmt = tds.amount;

  const grandTotal = round2(
    totalChalanAmt - commissionAmt - tdsAmt - i.mamool - i.courierCharge
  );

  const advanceTotal = round2(i.advances.reduce((s, a) => s + a, 0));
  const balance = round2(grandTotal - advanceTotal);

  return {
    freight,
    totalChalanAmt,
    tdsBase: tds.base,
    commissionAmt,
    tdsAmt,
    grandTotal,
    advanceTotal,
    balance,
  };
}

export function dieselAdvanceAmount(qty: number, ratePerLitre: number): number {
  return round2(qty * ratePerLitre);
}
