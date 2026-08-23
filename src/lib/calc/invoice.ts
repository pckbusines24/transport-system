import { round2 } from "./tds";
import { gstSplit } from "./gst";

export interface InvoiceComputeInput {
  lrAmounts: number[]; // freight+charges per selected LR
  extraCharges: number[]; // typed additional charges
  gstApplicable: boolean;
  gstPct: number; // combined pct (split into cgst/sgst or igst)
  supplierStateCode?: string | null;
  recipientStateCode?: string | null;
  tdsPct: number;
  advance: number;
}

export interface InvoiceTotals {
  total: number;
  grandTotal: number;
  cgstAmt: number;
  sgstAmt: number;
  igstAmt: number;
  tdsAmt: number;
  /** whole-rupee difference absorbed to round the bill: netTotal − (grandTotal + GST) */
  roundOff: number;
  netTotal: number;
  balance: number;
}

/**
 * The printed bill has always rounded the payable to the whole rupee; the
 * stored/posted figures now do the same, with the paise carried explicitly as
 * `roundOff` so the ledger and the print agree to the rupee.
 */
export function roundInvoiceNet(netRaw: number): { netTotal: number; roundOff: number } {
  const netTotal = Math.round(netRaw);
  return { netTotal, roundOff: round2(netTotal - netRaw) };
}

export function computeInvoice(i: InvoiceComputeInput): InvoiceTotals {
  const total = round2(i.lrAmounts.reduce((s, a) => s + a, 0));
  const grandTotal = round2(total + i.extraCharges.reduce((s, a) => s + a, 0));
  const gst = i.gstApplicable
    ? gstSplit({
        taxableValue: grandTotal,
        gstPct: i.gstPct,
        supplierStateCode: i.supplierStateCode,
        recipientStateCode: i.recipientStateCode,
      })
    : { cgst: 0, sgst: 0, igst: 0 };
  const tdsAmt = round2((grandTotal * i.tdsPct) / 100);
  const { netTotal, roundOff } = roundInvoiceNet(
    round2(grandTotal + gst.cgst + gst.sgst + gst.igst)
  );
  const balance = round2(netTotal - i.advance);
  return {
    total,
    grandTotal,
    cgstAmt: gst.cgst,
    sgstAmt: gst.sgst,
    igstAmt: gst.igst,
    tdsAmt,
    roundOff,
    netTotal,
    balance,
  };
}

/** Parse a bulk LR paste box: space / comma / newline / semicolon separated */
export function parseBulkLrNumbers(text: string): string[] {
  return Array.from(
    new Set(
      text
        .split(/[\s,;]+/)
        .map((s) => s.trim())
        .filter(Boolean)
    )
  );
}
