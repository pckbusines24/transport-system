import { describe, expect, it } from "vitest";
import { CARD_LEDGER_GROUP, voucherTypeForMoneyLedger } from "./tally";

/**
 * CARD EXPENSE -> JOURNAL VOUCHER.
 *
 *   Cash / Bank / UPI -> Payment voucher
 *   Card              -> Journal voucher
 */
describe("card expenses export as Journal vouchers", () => {
  it("maps every payment mode to the right voucher type", () => {
    // the money ledger's party group is what decides it
    expect(voucherTypeForMoneyLedger("CASH", "Payment")).toBe("Payment");
    expect(voucherTypeForMoneyLedger("BANK", "Payment")).toBe("Payment");
    expect(voucherTypeForMoneyLedger(CARD_LEDGER_GROUP, "Payment")).toBe("Journal");
  });

  it("sends card receipts to Journal too", () => {
    expect(voucherTypeForMoneyLedger("BANK", "Receipt")).toBe("Receipt");
    expect(voucherTypeForMoneyLedger("CARD", "Receipt")).toBe("Journal");
  });

  it("leaves an unknown or missing group on the cash-style type", () => {
    // UPI/cheque/NEFT all settle through a BANK party, so they never reach here
    // as their own group — anything unrecognised must NOT silently become a JV
    expect(voucherTypeForMoneyLedger(null, "Payment")).toBe("Payment");
    expect(voucherTypeForMoneyLedger(undefined, "Payment")).toBe("Payment");
    expect(voucherTypeForMoneyLedger("", "Payment")).toBe("Payment");
    expect(voucherTypeForMoneyLedger("SUPPLIER", "Payment")).toBe("Payment");
  });

  it("is case-sensitive on the stored group, matching the Party ledgerGroup enum", () => {
    // ledgerGroup is stored uppercase; a lowercase value is not a card ledger
    expect(voucherTypeForMoneyLedger("card", "Payment")).toBe("Payment");
  });

  it("paying the card bill from the bank stays a Payment voucher", () => {
    // Card Dr / Bank Cr — the MONEY ledger is the bank, so this is the real
    // payment. Keying off the money side is what stops the cost being
    // exported twice: once as the card expense JV, once as this payment.
    expect(voucherTypeForMoneyLedger("BANK", "Payment")).toBe("Payment");
  });
});
