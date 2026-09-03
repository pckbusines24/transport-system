import { describe, expect, it } from "vitest";
import { addAmounts, splitAmounts, sumAmounts, ZERO_AMOUNTS } from "./adjustments";
import { computeChalan } from "@/lib/calc/chalan";
import { computeBrokerSide } from "@/components/broker/broker-calc";

// The worked example from the spec.
const EXAMPLE = {
  detention: 5000,
  odcAmt: 3000,
  fineAmt: 1000,
  otherAmt: 500,
  ldCharge: 2000,
  shortageAmt: 1500,
};

describe("register main value vs adjustments", () => {
  it("keeps the main value at the original freight", () => {
    const a = splitAmounts(100000, EXAMPLE);
    expect(a.main).toBe(100000);
    expect(a.additions).toBe(9500); // 5000 + 3000 + 1000 + 500
    expect(a.deductions).toBe(3500); // 2000 + 1500
    expect(a.net).toBe(106000); // 100000 + 9500 − 3500
  });

  it("never moves the main value when an adjustment changes", () => {
    const base = splitAmounts(100000, {});
    expect(base.main).toBe(100000);
    expect(base.net).toBe(100000);

    for (const field of Object.keys(EXAMPLE) as (keyof typeof EXAMPLE)[]) {
      for (const amount of [0, 250, 99999]) {
        const a = splitAmounts(100000, { [field]: amount });
        expect(a.main).toBe(100000);
      }
    }
  });

  it("treats a zero entry exactly like no entry", () => {
    const zeros = splitAmounts(100000, {
      detention: 0,
      odcAmt: 0,
      fineAmt: 0,
      otherAmt: 0,
      ldCharge: 0,
      shortageAmt: 0,
    });
    expect(zeros).toEqual(splitAmounts(100000, {}));
  });

  it("accumulates each component independently", () => {
    const totals = sumAmounts([
      splitAmounts(100000, EXAMPLE),
      splitAmounts(50000, { detention: 1000, shortageAmt: 400 }),
    ]);
    expect(totals.main).toBe(150000);
    expect(totals.detention).toBe(6000);
    expect(totals.additions).toBe(10500);
    expect(totals.deductions).toBe(3900);
    expect(totals.net).toBe(156600);
    // the identity holds on the accumulated row too
    expect(totals.net).toBe(totals.main + totals.additions - totals.deductions);
  });

  it("edits and deletes move only the component they touch", () => {
    const before = splitAmounts(100000, EXAMPLE);
    // user edits detention 5000 -> 7500, deletes the fine
    const after = splitAmounts(100000, { ...EXAMPLE, detention: 7500, fineAmt: 0 });
    expect(after.main).toBe(before.main);
    expect(after.additions).toBe(11000);
    expect(after.net).toBe(107500);

    // removing a document removes its components, main included, and nothing else
    const two = addAmounts(before, after);
    expect(addAmounts(two, ZERO_AMOUNTS)).toEqual(two);
  });

  it("agrees with the chalan net payable", () => {
    const t = computeChalan({
      rate: 0,
      rateBasis: "CHARGE_WT",
      actualWt: 0,
      chargeWt: 0,
      manualFreight: 100000,
      detention: EXAMPLE.detention,
      odcAmt: EXAMPLE.odcAmt,
      fineSlip: EXAMPLE.fineAmt,
      otherAmt: EXAMPLE.otherAmt,
      ldCharge: EXAMPLE.ldCharge,
      shortageAmt: EXAMPLE.shortageAmt,
      mamool: 0,
      courierCharge: 0,
      commissionPct: 0,
      tdsPct: 0,
      advances: [],
    });
    const a = splitAmounts(t.freight, {
      detention: EXAMPLE.detention,
      odcAmt: EXAMPLE.odcAmt,
      fineAmt: EXAMPLE.fineAmt,
      otherAmt: EXAMPLE.otherAmt,
      ldCharge: EXAMPLE.ldCharge,
      shortageAmt: EXAMPLE.shortageAmt,
    });
    // the register's main value is the freight, NOT the chalan total
    expect(a.main).toBe(100000);
    expect(t.totalChalanAmt).toBe(106000);
    expect(a.net).toBe(t.totalChalanAmt);
  });

  it("agrees with the broker slip net for a side", () => {
    const t = computeBrokerSide({
      rate: 0,
      rateBasis: "CHARGE_WT",
      qty: 0,
      actualWt: 0,
      chargeWt: 0,
      manualFreight: 100000,
      ...EXAMPLE,
      tdsPct: 0,
      commPct: 0,
      mamool: 0,
      paymentCharge: 0,
      advance: 0,
    });
    const a = splitAmounts(t.freight, EXAMPLE);
    expect(a.main).toBe(100000);
    expect(t.chalanAmt).toBe(106000);
    expect(a.net).toBe(t.chalanAmt);
  });
});
