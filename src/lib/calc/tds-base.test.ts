import { describe, expect, it } from "vitest";
import { computeTds, resolveTdsBase, tdsBaseAmount } from "./tds-base";
import { computeChalan } from "./chalan";
import { computeBrokerSide } from "@/components/broker/broker-calc";

// The worked example from the spec.
const ADJ = {
  detention: 10000,
  odcAmt: 5000,
  fineAmt: 2000,
  otherAmt: 2000,
  ldCharge: 3000,
  shortageAmt: 1000,
};
const FREIGHT = 100000;

describe("TDS base excludes every settlement adjustment", () => {
  it("bases TDS on freight alone", () => {
    expect(tdsBaseAmount({ freight: FREIGHT })).toBe(100000);
    expect(computeTds({ freight: FREIGHT }, 1).amount).toBe(1000);
  });

  it("never taxes the adjusted or net figure", () => {
    const { base, amount } = computeTds({ freight: FREIGHT }, 1);
    expect(base).toBe(100000);
    // settlement total = 1,00,000 + 10,000 + 5,000 + 2,000 + 2,000
    //                    - 3,000 - 1,000 = 1,15,000
    expect(base).not.toBe(115000);
    expect(amount).not.toBe(1150);
    expect(amount).toBe(1000);
  });

  it("adds commission to the base when the deduction is on commission", () => {
    expect(tdsBaseAmount({ commission: 5000 })).toBe(5000);
    expect(tdsBaseAmount({ freight: 100000, commission: 5000 })).toBe(105000);
  });

  it("honours a manual base override, and only an explicit one", () => {
    expect(resolveTdsBase({ freight: FREIGHT })).toEqual({ base: 100000, isManualBase: false });
    expect(resolveTdsBase({ freight: FREIGHT }, null)).toEqual({
      base: 100000,
      isManualBase: false,
    });
    expect(resolveTdsBase({ freight: FREIGHT }, 80000)).toEqual({
      base: 80000,
      isManualBase: true,
    });
    // an explicit zero base is a real choice, not "unset"
    expect(resolveTdsBase({ freight: FREIGHT }, 0)).toEqual({ base: 0, isManualBase: true });
  });

  it("validates TDS = base x rate", () => {
    for (const [base, pct, expected] of [
      [100000, 1, 1000],
      [100000, 2, 2000],
      [250000, 1, 2500],
      [0, 1, 0],
    ] as [number, number, number][]) {
      expect(computeTds({ freight: base }, pct).amount).toBe(expected);
    }
  });
});

describe("challan TDS is immune to adjustments", () => {
  const chalanWith = (adj: Partial<typeof ADJ>) =>
    computeChalan({
      rate: 0,
      rateBasis: "CHARGE_WT",
      actualWt: 0,
      chargeWt: 0,
      manualFreight: FREIGHT,
      detention: adj.detention ?? 0,
      odcAmt: adj.odcAmt ?? 0,
      fineSlip: adj.fineAmt ?? 0,
      otherAmt: adj.otherAmt ?? 0,
      ldCharge: adj.ldCharge ?? 0,
      shortageAmt: adj.shortageAmt ?? 0,
      mamool: 0,
      courierCharge: 0,
      commissionPct: 0,
      tdsPct: 1,
      advances: [],
    });

  it("gives the spec's numbers", () => {
    const t = chalanWith(ADJ);
    expect(t.tdsBase).toBe(100000);
    expect(t.tdsAmt).toBe(1000);
    // the adjustments still move the settlement figure
    expect(t.totalChalanAmt).toBe(115000);
    expect(t.tdsBase).not.toBe(t.totalChalanAmt);
  });

  it("holds the TDS steady as each adjustment changes", () => {
    const bare = chalanWith({});
    for (const field of Object.keys(ADJ) as (keyof typeof ADJ)[]) {
      for (const amount of [0, 500, 250000]) {
        const t = chalanWith({ [field]: amount });
        expect(t.tdsBase).toBe(bare.tdsBase);
        expect(t.tdsAmt).toBe(bare.tdsAmt);
      }
    }
  });
});

describe("broker slip TDS is immune to adjustments", () => {
  const sideWith = (adj: Partial<typeof ADJ>) =>
    computeBrokerSide({
      rate: 0,
      rateBasis: "CHARGE_WT",
      qty: 0,
      actualWt: 0,
      chargeWt: 0,
      manualFreight: FREIGHT,
      detention: adj.detention ?? 0,
      odcAmt: adj.odcAmt ?? 0,
      fineAmt: adj.fineAmt ?? 0,
      otherAmt: adj.otherAmt ?? 0,
      ldCharge: adj.ldCharge ?? 0,
      shortageAmt: adj.shortageAmt ?? 0,
      tdsPct: 1,
      commPct: 0,
      mamool: 0,
      paymentCharge: 0,
      advance: 0,
    });

  it("gives the spec's numbers", () => {
    const t = sideWith(ADJ);
    expect(t.tdsBase).toBe(100000);
    expect(t.tdsAmt).toBe(1000);
    expect(t.chalanAmt).toBe(115000);
    // the regression this fixes: TDS used to be 1% of the adjusted 1,15,000
    expect(t.tdsAmt).not.toBe(1150);
  });

  it("holds the TDS steady as each adjustment changes", () => {
    const bare = sideWith({});
    for (const field of Object.keys(ADJ) as (keyof typeof ADJ)[]) {
      for (const amount of [0, 500, 250000]) {
        const t = sideWith({ [field]: amount });
        expect(t.tdsBase).toBe(bare.tdsBase);
        expect(t.tdsAmt).toBe(bare.tdsAmt);
      }
    }
  });

  it("keeps the base and the net payable as separate figures", () => {
    const t = sideWith(ADJ);
    expect(t.tdsBase).toBe(100000);
    expect(t.netAmt).toBe(114000); // 1,15,000 - 1,000 TDS
    expect(t.tdsBase).not.toBe(t.netAmt);
  });
});
