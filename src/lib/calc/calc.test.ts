import { describe, it, expect } from "vitest";
import { tdsPctFromPan, tdsAmount } from "./tds";
import { amountByBasis } from "./rate";
import { gstSplit, stateCodeFromGstin } from "./gst";
import { computeChalan, dieselAdvanceAmount } from "./chalan";
import { computeInvoice, parseBulkLrNumbers } from "./invoice";
import { tripLegTotal, tripLegBalance, vehicleNetPl } from "./trip";

describe("TDS from PAN", () => {
  it("individual PAN (4th char P) -> 1%", () => {
    expect(tdsPctFromPan("BHOPK1422J", "TDS_APPLICABLE")).toBe(1);
  });
  it("HUF PAN (4th char H) -> 1%", () => {
    expect(tdsPctFromPan("AAAHH1234A", "TDS_APPLICABLE")).toBe(1);
  });
  it("company PAN (4th char C) -> 2%", () => {
    expect(tdsPctFromPan("AAACJ9096D", "TDS_APPLICABLE")).toBe(2);
  });
  it("declaration -> 0%", () => {
    expect(tdsPctFromPan("AAACJ9096D", "DECLARATION")).toBe(0);
  });
  it("missing PAN with TDS applicable -> 2% (safe default)", () => {
    expect(tdsPctFromPan(null, "TDS_APPLICABLE")).toBe(2);
  });
  it("tds amount", () => {
    expect(tdsAmount(50000, 1)).toBe(500);
    expect(tdsAmount(50000, 2)).toBe(1000);
  });
});

describe("rate basis", () => {
  it("qty basis", () => expect(amountByBasis(100, "QTY", 5, 10, 12)).toBe(500));
  it("actual wt basis", () => expect(amountByBasis(100, "ACTUAL_WT", 5, 10, 12)).toBe(1000));
  it("charge wt basis", () => expect(amountByBasis(100, "CHARGE_WT", 5, 10, 12)).toBe(1200));
  it("fixed basis", () => expect(amountByBasis(1500, "FIXED", 5, 10, 12)).toBe(1500));
});

describe("GST", () => {
  it("intra-state splits CGST/SGST", () => {
    expect(
      gstSplit({ taxableValue: 1000, gstPct: 12, supplierStateCode: "22", recipientStateCode: "22" })
    ).toEqual({ cgst: 60, sgst: 60, igst: 0 });
  });
  it("inter-state -> IGST", () => {
    expect(
      gstSplit({ taxableValue: 1000, gstPct: 12, supplierStateCode: "22", recipientStateCode: "27" })
    ).toEqual({ cgst: 0, sgst: 0, igst: 120 });
  });
  it("gstin state code", () => {
    expect(stateCodeFromGstin("22AAACJ9096D1ZK")).toBe("22");
  });
  it("unregistered customer (no recipient state) -> local CGST/SGST, not IGST", () => {
    expect(
      gstSplit({ taxableValue: 1000, gstPct: 12, supplierStateCode: "22", recipientStateCode: null })
    ).toEqual({ cgst: 60, sgst: 60, igst: 0 });
  });
  it("intra-state halves reconstruct the rounded total exactly (no paisa drift)", () => {
    // 333.50 @ 3% = 10.005 -> 10.01 total; halves must sum to 10.01, not 10.02
    const g = gstSplit({ taxableValue: 333.5, gstPct: 3, supplierStateCode: "22", recipientStateCode: "22" });
    expect(g.cgst + g.sgst).toBeCloseTo(10.01, 2);
  });
});

describe("chalan compute", () => {
  it("full flow: freight, tds, commission, mamool, courier, advances", () => {
    const t = computeChalan({
      rate: 1000,
      rateBasis: "CHARGE_WT",
      actualWt: 24.5,
      chargeWt: 25,
      detention: 0,
      odcAmt: 0,
      fineSlip: 0,
      otherAmt: 500,
      ldCharge: 0,
      shortageAmt: 0,
      mamool: 200,
      courierCharge: 100,
      commissionPct: 2,
      tdsPct: 1,
      advances: [5000, 2000],
    });
    expect(t.freight).toBe(25000);
    expect(t.totalChalanAmt).toBe(25500);
    // commission & TDS are levied on the freight amount only
    expect(t.commissionAmt).toBe(500);
    expect(t.tdsAmt).toBe(250);
    expect(t.grandTotal).toBe(25500 - 500 - 250 - 200 - 100);
    expect(t.advanceTotal).toBe(7000);
    expect(t.balance).toBe(t.grandTotal - 7000);
  });
  it("manual freight overrides rate", () => {
    const t = computeChalan({
      rate: 1000, rateBasis: "CHARGE_WT", actualWt: 10, chargeWt: 10,
      manualFreight: 12000, detention: 0, odcAmt: 0, fineSlip: 0, otherAmt: 0,
      ldCharge: 0, shortageAmt: 0, mamool: 0, courierCharge: 0,
      commissionPct: 0, commissionAmt: 300, tdsPct: 0, advances: [],
    });
    expect(t.freight).toBe(12000);
    expect(t.commissionAmt).toBe(300);
  });
  it("diesel advance", () => expect(dieselAdvanceAmount(100, 89.5)).toBe(8950));
});

describe("invoice compute", () => {
  it("totals with charges, gst, tds, advance", () => {
    const t = computeInvoice({
      lrAmounts: [10000, 15000],
      extraCharges: [500, 300],
      gstApplicable: true,
      gstPct: 12,
      supplierStateCode: "22",
      recipientStateCode: "22",
      tdsPct: 1,
      advance: 5000,
    });
    expect(t.total).toBe(25000);
    expect(t.grandTotal).toBe(25800);
    expect(t.cgstAmt).toBe(1548);
    expect(t.sgstAmt).toBe(1548);
    expect(t.netTotal).toBe(25800 + 3096);
    expect(t.tdsAmt).toBe(258);
    expect(t.roundOff).toBe(0);
    expect(t.balance).toBe(t.netTotal - 5000);
  });
  it("rounds the net total to the whole rupee with an explicit round off", () => {
    const t = computeInvoice({
      lrAmounts: [1000.4],
      extraCharges: [],
      gstApplicable: false,
      gstPct: 0,
      tdsPct: 0,
      advance: 0,
    });
    expect(t.grandTotal).toBe(1000.4);
    expect(t.netTotal).toBe(1000);
    expect(t.roundOff).toBe(-0.4);
    expect(t.balance).toBe(1000);
    const up = computeInvoice({
      lrAmounts: [1000.5],
      extraCharges: [],
      gstApplicable: false,
      gstPct: 0,
      tdsPct: 0,
      advance: 0,
    });
    expect(up.netTotal).toBe(1001);
    expect(up.roundOff).toBe(0.5);
  });
  it("bulk LR parsing", () => {
    expect(parseBulkLrNumbers("1001, 1002\n1003 1004;1001")).toEqual([
      "1001", "1002", "1003", "1004",
    ]);
  });
});

describe("trip calc", () => {
  it("leg totals and balance", () => {
    expect(tripLegTotal(20000, 500, 300)).toBe(20800);
    expect(tripLegBalance(20800, 5000, 2000, 3000, 0)).toBe(10800);
  });
  it("vehicle net P&L", () => {
    expect(vehicleNetPl(100000, 30000, 25000)).toBe(45000);
  });
});
