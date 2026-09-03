import { createHash } from "crypto";

/**
 * Tally Prime XML import format ("Import Data" envelope). Debits are NEGATIVE
 * amounts with ISDEEMEDPOSITIVE Yes; credits positive with No. Bill-wise
 * references ride BILLALLOCATIONS.LIST inside the party's ledger entry.
 *
 * The firm is GST-unregistered, so no GST/tax masters are ever emitted.
 */

export interface TallyBillRef {
  name: string;
  /** "New Ref" on the accrual, "Agst Ref" on settlements, "Advance" on-account */
  type: "New Ref" | "Agst Ref" | "Advance";
  amount: number; // sign follows the owning line's amount
}

export interface TallyLine {
  ledger: string;
  /** positive rupees; side decides the sign in XML */
  amount: number;
  side: "DR" | "CR";
  bills?: TallyBillRef[];
}

/**
 * The party ledgerGroup that means "credit card". A card ledger is a LIABILITY,
 * not money, so it never belongs on a Payment/Receipt voucher.
 */
export const CARD_LEDGER_GROUP = "CARD";

/**
 * Voucher type for a document settled against a money ledger.
 *
 * Cash / Bank / UPI all move real money, so they stay Payment or Receipt. A
 * card does not: booking an expense on a credit card swaps an expense for a
 * liability, which in Tally is a JOURNAL —
 *
 *   Vehicle Repair Expense A/c  Dr.  10,000
 *        To HDFC Credit Card A/c          10,000
 *
 * Paying the card bill later IS a real bank movement, and exports as its own
 * Payment voucher (Card Dr / Bank Cr). That second entry is keyed off the BANK
 * being the money ledger, so the same cost never reaches Tally twice.
 */
export function voucherTypeForMoneyLedger(
  ledgerGroup: string | null | undefined,
  cashType: "Payment" | "Receipt"
): TallyVoucher["type"] {
  return ledgerGroup === CARD_LEDGER_GROUP ? "Journal" : cashType;
}

export interface TallyVoucher {
  /** export-register key, e.g. "CHALAN:<id>:MAIN" */
  key: string;
  type: "Purchase" | "Journal" | "Receipt" | "Payment" | "Sales";
  /** yyyymmdd */
  date: string;
  /** supplier invoice no (Purchase "Reg No") — omitted otherwise */
  reference?: string;
  /** Tally VOUCHERNUMBER — the source document's own number (chalan no,
      invoice no, voucher no), so Tally doesn't assign a manual number */
  voucherNo?: string;
  narration: string;
  lines: TallyLine[];
}

export interface TallyLedgerMaster {
  name: string;
  parent: string; // "Sundry Debtors" | "Sundry Creditors" | ...
  address?: string;
  state?: string;
  pan?: string;
  mobile?: string;
}

const esc = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

export function tallyDate(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}${m}${day}`;
}

function voucherXml(v: TallyVoucher): string {
  const lines = v.lines
    .map((ln) => {
      const amt = ln.side === "DR" ? -ln.amount : ln.amount;
      const bills = (ln.bills ?? [])
        .map(
          (b) =>
            `<BILLALLOCATIONS.LIST><NAME>${esc(b.name)}</NAME><BILLTYPE>${b.type}</BILLTYPE>` +
            `<AMOUNT>${(ln.side === "DR" ? -b.amount : b.amount).toFixed(2)}</AMOUNT></BILLALLOCATIONS.LIST>`
        )
        .join("");
      return (
        `<ALLLEDGERENTRIES.LIST><LEDGERNAME>${esc(ln.ledger)}</LEDGERNAME>` +
        `<ISDEEMEDPOSITIVE>${ln.side === "DR" ? "Yes" : "No"}</ISDEEMEDPOSITIVE>` +
        `<AMOUNT>${amt.toFixed(2)}</AMOUNT>${bills}</ALLLEDGERENTRIES.LIST>`
      );
    })
    .join("");
  return (
    `<TALLYMESSAGE xmlns:UDF="TallyUDF"><VOUCHER VCHTYPE="${v.type}" ACTION="Create">` +
    `<DATE>${v.date}</DATE><EFFECTIVEDATE>${v.date}</EFFECTIVEDATE>` +
    `<VOUCHERTYPENAME>${v.type}</VOUCHERTYPENAME>` +
    (v.voucherNo ? `<VOUCHERNUMBER>${esc(v.voucherNo)}</VOUCHERNUMBER>` : "") +
    (v.reference ? `<REFERENCE>${esc(v.reference)}</REFERENCE>` : "") +
    `<NARRATION>${esc(v.narration)}</NARRATION><ISINVOICE>No</ISINVOICE>` +
    `${lines}</VOUCHER></TALLYMESSAGE>`
  );
}

function ledgerXml(l: TallyLedgerMaster): string {
  return (
    `<TALLYMESSAGE xmlns:UDF="TallyUDF"><LEDGER NAME="${esc(l.name)}" ACTION="Create">` +
    `<NAME.LIST><NAME>${esc(l.name)}</NAME></NAME.LIST>` +
    `<PARENT>${esc(l.parent)}</PARENT>` +
    (l.address ? `<ADDRESS.LIST TYPE="String"><ADDRESS>${esc(l.address)}</ADDRESS></ADDRESS.LIST>` : "") +
    (l.state ? `<LEDSTATENAME>${esc(l.state)}</LEDSTATENAME>` : "") +
    (l.pan ? `<INCOMETAXNUMBER>${esc(l.pan)}</INCOMETAXNUMBER>` : "") +
    (l.mobile ? `<LEDGERMOBILE>${esc(l.mobile)}</LEDGERMOBILE>` : "") +
    `<ISBILLWISEON>Yes</ISBILLWISEON>` +
    `</LEDGER></TALLYMESSAGE>`
  );
}

function envelope(messages: string): string {
  return (
    `<?xml version="1.0" encoding="UTF-8"?>` +
    `<ENVELOPE><HEADER><TALLYREQUEST>Import Data</TALLYREQUEST></HEADER>` +
    `<BODY><IMPORTDATA><REQUESTDESC><REPORTNAME>All Masters</REPORTNAME></REQUESTDESC>` +
    `<REQUESTDATA>${messages}</REQUESTDATA></IMPORTDATA></BODY></ENVELOPE>`
  );
}

export function buildVouchersXml(vouchers: TallyVoucher[]): string {
  const msgs = vouchers.map(voucherXml).join("");
  return (
    `<?xml version="1.0" encoding="UTF-8"?>` +
    `<ENVELOPE><HEADER><TALLYREQUEST>Import Data</TALLYREQUEST></HEADER>` +
    `<BODY><IMPORTDATA><REQUESTDESC><REPORTNAME>Vouchers</REPORTNAME></REQUESTDESC>` +
    `<REQUESTDATA>${msgs}</REQUESTDATA></IMPORTDATA></BODY></ENVELOPE>`
  );
}

export function buildMastersXml(ledgers: TallyLedgerMaster[]): string {
  return envelope(ledgers.map(ledgerXml).join(""));
}

/** Stable content hash: the export register flags a voucher whose figures changed. */
export function voucherHash(v: TallyVoucher): string {
  const stable = JSON.stringify({
    type: v.type,
    date: v.date,
    reference: v.reference ?? "",
    lines: v.lines.map((l) => [l.ledger, l.side, l.amount.toFixed(2), l.bills ?? []]),
  });
  return createHash("md5").update(stable).digest("hex");
}
