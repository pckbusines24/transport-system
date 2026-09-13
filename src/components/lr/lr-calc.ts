import { amountByBasis, type RateBasis } from "@/lib/calc/rate";
import type { LrFormItem, LrFormInvoice } from "@/components/lr/lr-form";
import { gstSplit } from "@/lib/calc/gst";
import { round2 } from "@/lib/calc/tds";

export interface LrItemCalcInput {
  qty: number;
  actualWt: number;
  chargeWt: number;
  rate: number;
  rateBasis: RateBasis;
}

export interface LrChargesInput {
  freight: number;
  hamali: number;
  preBhada: number;
  biltyCharge: number;
  collCharge: number;
  cpc: number;
  otherCharge: number;
  gstApplicable: boolean;
  gstPct: number;
  supplierStateCode?: string | null;
  recipientStateCode?: string | null;
  advance: number;
}

export interface LrTotals {
  total: number;
  cgstAmt: number;
  sgstAmt: number;
  igstAmt: number;
  grandTotal: number;
}

export function itemAmount(i: LrItemCalcInput): number {
  return amountByBasis(i.rate, i.rateBasis, i.qty, i.actualWt, i.chargeWt);
}

export function itemsFreight(items: LrItemCalcInput[]): number {
  return round2(items.reduce((s, i) => s + itemAmount(i), 0));
}

export function computeLrTotals(c: LrChargesInput): LrTotals {
  const total = round2(
    c.freight + c.hamali + c.preBhada + c.biltyCharge + c.collCharge + c.cpc + c.otherCharge
  );
  const gst = c.gstApplicable
    ? gstSplit({
        taxableValue: total,
        gstPct: c.gstPct,
        supplierStateCode: c.supplierStateCode,
        recipientStateCode: c.recipientStateCode,
      })
    : { cgst: 0, sgst: 0, igst: 0 };
  const grandTotal = round2(total + gst.cgst + gst.sgst + gst.igst - c.advance);
  return { total, cgstAmt: gst.cgst, sgstAmt: gst.sgst, igstAmt: gst.igst, grandTotal };
}

export const RATE_BASIS_LABELS: Record<RateBasis, string> = {
  QTY: "Quantity",
  ACTUAL_WT: "Actual Weight",
  CHARGE_WT: "Guaranteed Weight",
  FIXED: "Fixed",
};

/** Blank item row for the LR form (shared by client form and server prefill). */
export function emptyLrInvoice(): LrFormInvoice {
  return {
    invoiceNo: "",
    obdNo: "",
    refNo: "",
    invoiceDateText: "",
    goodsValue: 0,
    ewayBillNo: "",
    ewayExpiryText: "",
  };
}

/** a row with nothing typed in it — dropped on save, not stored as blanks */
export function isBlankLrInvoice(r: LrFormInvoice): boolean {
  return (
    !r.invoiceNo.trim() &&
    !r.obdNo.trim() &&
    !r.refNo.trim() &&
    !r.invoiceDateText.trim() &&
    !(Number(r.goodsValue) > 0) &&
    !r.ewayBillNo.trim() &&
    !r.ewayExpiryText.trim()
  );
}

export function emptyLrItem(): LrFormItem {
  return {
    productId: "",
    productName: "",
    description: "",
    qty: 0,
    actualWt: 0,
    chargeWt: 0,
    unit: "MT",
    rate: 0,
    rateBasis: "CHARGE_WT",
  };
}
