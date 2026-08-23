import * as React from "react";
import { formatMoney } from "@/lib/utils";
import { amountInWords } from "@/lib/num-to-words";

/**
 * Shared professional TAX INVOICE layout (A4 landscape) — rendered identically
 * by the Bill Preview dialog (client, from form state) and the print page
 * (server, from the saved invoice). All values arrive display-ready.
 *
 * The orientation itself is set by the print route, not here: `@page` cannot be
 * scoped to a component, and a global landscape rule would rotate the chalan,
 * LR, trip sheet and broker slip prints too.
 */
export interface InvoiceViewParty {
  name: string;
  address: string;
  gstin: string;
  pan: string;
  stateName: string;
  stateCode: string;
  /** vendor code from the Billed-To party's master (blank if none) */
  vendorCode: string;
}

export interface InvoiceViewLr {
  id: string;
  lrNo: string;
  lrDate: string; // formatted
  source: string;
  dest: string;
  obdNo: string;
  poNumber: string;
  gateEntryNo: string;
  invoiceNo: string;
  vehicle: string;
  material: string;
  consignee: string;
  unloadDate: string; // formatted or ""
  qty: number;
  actualWt: number;
  chargeWt: number;
  rate: number;
  amount: number;
}

export interface InvoiceViewData {
  billNo: string;
  billDate: string; // formatted
  placeOfSupply: string;
  firm: {
    name: string;
    address: string;
    mobile: string;
    email: string;
    gstin: string;
    pan: string;
    stateName: string;
    stateCode: string;
    ibaCode: string;
    vendorCode: string;
    rcmCovered: boolean;
    /** ready-to-use URLs from firmImageUrl(); null when nothing is uploaded */
    logoUrl?: string | null;
    sealUrl?: string | null;
  };
  tdsPct: number;
  serviceDescription: string;
  sacCode: string;
  party: InvoiceViewParty;
  lrs: InvoiceViewLr[];
  charges: { label: string; relatedLrs: string; amount: number }[];
  totals: {
    total: number;
    grandTotal: number;
    cgstAmt: number;
    sgstAmt: number;
    igstAmt: number;
    /** stored whole-rupee rounding (0 on bills saved before the column existed) */
    roundOff: number;
    netTotal: number;
    advance: number;
    balance: number;
  };
  gstPct: number;
  /** informational RCM split — never affects the invoice total */
  rcm: { taxableValue: number; pct: number; cgst: number; sgst: number; igst: number } | null;
  gstApplied: boolean;
  /** the bill itself is on reverse-charge basis (not the firm's RCM default) */
  reverseCharge: boolean;
  remarks: string;
  /**
   * Kept as separate fields rather than one joined line: this is what the
   * customer has to copy correctly to pay the bill, so each part gets its own
   * labelled row and the account number and IFSC never wrap mid-code.
   */
  bank: {
    name: string;
    branch: string;
    account: string;
    ifsc: string;
  } | null;
}

const cell = "border border-black px-1 py-0.5";
const labelCell = "border border-black bg-neutral-100 px-1 py-0.5 font-semibold print:bg-neutral-100";

/**
 * LR table columns.
 *
 * `optional` columns are dropped when every LR on the bill leaves them blank —
 * OBD, PO and gate-entry numbers only apply to some customers, and a column of
 * empty cells costs width that the remaining columns need. The rest print
 * always, blank or not: a freight bill without an LR number, route, weight or
 * rate is not a valid document, and their absence would be read as an error
 * rather than as "not applicable".
 */
interface LrColumn {
  header: string;
  optional?: boolean;
  numeric?: boolean;
  value: (lr: InvoiceViewLr, index: number) => React.ReactNode;
  /** blank-detection for optional columns; defaults to the rendered value */
  raw?: (lr: InvoiceViewLr) => string;
}

const LR_COLUMNS: LrColumn[] = [
  { header: "Sr.", value: (_lr, i) => i + 1 },
  { header: "LR / C.Note No", value: (lr) => lr.lrNo },
  { header: "Dispatch Date", value: (lr) => lr.lrDate },
  { header: "From Station", value: (lr) => lr.source },
  { header: "To Station", value: (lr) => lr.dest },
  { header: "OBD No", optional: true, value: (lr) => lr.obdNo, raw: (lr) => lr.obdNo },
  { header: "PO No", optional: true, value: (lr) => lr.poNumber, raw: (lr) => lr.poNumber },
  {
    header: "Gate Entry No",
    optional: true,
    value: (lr) => lr.gateEntryNo,
    raw: (lr) => lr.gateEntryNo,
  },
  { header: "Invoice No", optional: true, value: (lr) => lr.invoiceNo, raw: (lr) => lr.invoiceNo },
  { header: "Vehicle No", value: (lr) => lr.vehicle },
  { header: "Material", optional: true, value: (lr) => lr.material, raw: (lr) => lr.material },
  { header: "Consignee", optional: true, value: (lr) => lr.consignee, raw: (lr) => lr.consignee },
  {
    header: "Delivery Date",
    optional: true,
    value: (lr) => lr.unloadDate,
    raw: (lr) => lr.unloadDate,
  },
  { header: "Net Wt", numeric: true, value: (lr) => lr.actualWt },
  { header: "Charged Wt", numeric: true, value: (lr) => lr.chargeWt },
  { header: "Rate", numeric: true, value: (lr) => lr.rate },
  { header: "Freight Amt", numeric: true, value: (lr) => formatMoney(lr.amount) },
];

/** Headers of the three columns the totals row fills in itself. */
const TOTAL_COLUMNS = ["Net Wt", "Charged Wt", "Rate", "Freight Amt"];

export function InvoicePrintView({
  data,
  lrActions,
}: {
  data: InvoiceViewData;
  /** optional per-LR action cell (used by the preview for Edit / Remove) */
  lrActions?: (lr: InvoiceViewLr) => React.ReactNode;
}) {
  const { firm, party, totals } = data;
  const chargesTotal = data.charges.reduce((s, c) => s + c.amount, 0);
  // the round off is REAL now — stored on the bill and posted to the ledger,
  // so the print shows the saved figures. Bills saved before the column
  // existed carry roundOff 0 with a fractional balance; those keep the old
  // display-only rounding so their prints don't change until re-saved.
  const legacy = Math.abs(totals.roundOff) < 0.005 && Math.round(totals.balance) !== totals.balance;
  const grandRounded = legacy ? Math.round(totals.balance) : totals.balance;
  const roundOff = legacy
    ? Math.round((grandRounded - totals.balance) * 100) / 100
    : totals.roundOff;
  const totalChargeWt = Math.round(data.lrs.reduce((s, l) => s + l.chargeWt, 0) * 1000) / 1000;
  const totalActualWt = Math.round(data.lrs.reduce((s, l) => s + l.actualWt, 0) * 1000) / 1000;

  // decided per bill: an optional column survives if any one LR fills it in
  const columns = LR_COLUMNS.filter(
    (c) => !c.optional || data.lrs.some((lr) => (c.raw?.(lr) ?? "").trim() !== "")
  );
  // the totals row labels itself across everything up to Net Wt — computed
  // rather than hard-coded, or the totals slide under the wrong headings the
  // moment a column is dropped
  const totalLabelSpan = columns.filter((c) => !TOTAL_COLUMNS.includes(c.header)).length;

  // header info pairs, laid out two per row; a 0% TDS bill drops its pair
  // entirely rather than printing 0% (or the old, wrong 1%)
  const infoPairs: [string, string][] = [
    ["PAN", firm.pan],
    ["GSTIN", firm.gstin],
    ["Vendor Code", party.vendorCode || firm.vendorCode],
    ["IBA Code", firm.ibaCode],
    // "(Info)" is deliberate: TDS is the customer's to deduct, not a charge
    // on this bill
    ...(data.tdsPct > 0
      ? ([["TDS Applicable (Info)", `${data.tdsPct}%`]] as [string, string][])
      : []),
    ["SAC Code", data.sacCode],
    ["Service", data.serviceDescription],
    ["Reverse Charge", data.reverseCharge ? "Yes" : "No"],
    ["Place of Supply", data.placeOfSupply],
    ["State / Code", `${firm.stateName}${firm.stateCode ? ` / ${firm.stateCode}` : ""}`],
  ];
  const infoRows: [string, string][][] = [];
  for (let i = 0; i < infoPairs.length; i += 2) infoRows.push(infoPairs.slice(i, i + 2));

  // a missing branch or IFSC drops its line rather than printing a label with
  // nothing after it; no bank on the bill drops the block entirely
  const bankLines: [string, string, boolean][] = data.bank
    ? (
        [
          ["Bank Name", data.bank.name, false],
          ["Branch", data.bank.branch, false],
          ["A/c Number", data.bank.account, true],
          ["IFSC", data.bank.ifsc, true],
        ] as [string, string, boolean][]
      ).filter(([, v]) => v.trim() !== "")
    : [];

  return (
    // 277mm is the printable width of A4 landscape at an 8mm margin; seventeen
    // columns never fitted the 190mm portrait sheet
    <div className="mx-auto max-w-[277mm] border-2 border-black bg-white text-black">
      {/* masthead — logo | firm | bill no & date */}
      <table className="w-full border-collapse text-xs">
        <tbody>
          {/*
            Bill No and Date are two real table rows spanned against the logo
            and name cells, not two divs stacked inside one cell. Stacked divs
            take their own content height and leave the remainder below the
            second one, so the boxes came out unequal; as rows they split the
            masthead height between them.
          */}
          <tr>
            {firm.logoUrl && (
              <td
                rowSpan={2}
                className="w-[24mm] border-b border-r border-black p-1 align-middle"
              >
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={firm.logoUrl}
                  alt=""
                  className="mx-auto h-14 w-auto max-w-full object-contain"
                />
              </td>
            )}
            <td rowSpan={2} className="border-b border-black px-2 py-1 text-center align-middle">
              <div className="text-xl font-bold uppercase leading-tight">{firm.name}</div>
              {firm.address && <div className="text-[11px] font-semibold">{firm.address}</div>}
              <div className="text-[11px]">
                {[firm.mobile && `Mob: ${firm.mobile}`, firm.email && `Email: ${firm.email}`]
                  .filter(Boolean)
                  .join("  |  ")}
              </div>
            </td>
            {/*
              The box is sized to hold a full bill number on one line —
              whitespace-nowrap stops it wrapping, and the width is what stops
              nowrap from pushing into the firm name instead. Not bold: at this
              size it stands out by position and box, and bold made it heavier
              than the firm name above the table.
            */}
            <td className="w-[62mm] whitespace-nowrap border-b border-l border-black px-2 py-1 text-[13px]">
              BILL NO. : {data.billNo}
            </td>
          </tr>
          <tr>
            <td className="whitespace-nowrap border-b border-l border-black px-2 py-1 text-[13px]">
              DATE : {data.billDate}
            </td>
          </tr>
        </tbody>
      </table>

      {/* title band */}
      <div className="border-b border-black py-0.5 text-center text-sm font-bold tracking-widest">
        TAX INVOICE
      </div>

      {/* Bill To on the left, every remaining field as label/value cells right */}
      <table className="w-full border-collapse text-xs">
        <tbody>
          <tr>
            <td className="w-[40%] border-b border-r border-black px-2 py-1 align-top">
              <div className="font-semibold underline">Bill To</div>
              <div className="text-sm font-bold">{party.name}</div>
              {party.address && <div>{party.address}</div>}
              {party.gstin && (
                <div>
                  <b>GSTIN :</b> {party.gstin}
                </div>
              )}
              {party.pan && (
                <div>
                  <b>PAN :</b> {party.pan}
                </div>
              )}
              {party.stateName && (
                <div>
                  <b>State :</b> {party.stateName}
                  {party.stateCode ? ` (Code ${party.stateCode})` : ""}
                </div>
              )}
            </td>
            <td className="border-b border-black p-0 align-top">
              <table className="w-full border-collapse">
                <tbody>
                  {/* one list, two pairs per row — reordering is a code edit
                      here rather than a re-layout */}
                  {infoRows.map(([a, b]) => (
                    <tr key={a[0]}>
                      <td className={`${labelCell} border-t-0`}>{a[0]}</td>
                      <td className={`${cell} border-t-0`}>{a[1]}</td>
                      <td className={`${labelCell} border-t-0`}>{b?.[0] ?? ""}</td>
                      <td className={`${cell} border-r-0 border-t-0`}>{b?.[1] ?? ""}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </td>
          </tr>
        </tbody>
      </table>

      {/* LR details table — expands with the number of LRs */}
      <div className="overflow-x-auto">
        <table className="w-full border-collapse text-[9px]">
          <thead>
            <tr>
              {columns.map((c) => (
                <th key={c.header} className={`${labelCell} text-left`}>
                  {c.header}
                </th>
              ))}
              {lrActions && <th className={`${labelCell} text-left`} />}
            </tr>
          </thead>
          <tbody>
            {data.lrs.map((lr, i) => (
              <tr key={lr.id}>
                {columns.map((c) => (
                  <td key={c.header} className={`${cell}${c.numeric ? " text-right" : ""}`}>
                    {c.value(lr, i)}
                  </td>
                ))}
                {lrActions && <td className={cell}>{lrActions(lr)}</td>}
              </tr>
            ))}
            <tr className="font-semibold">
              <td colSpan={totalLabelSpan} className={cell}>
                Total — Enclosures: {data.lrs.length} LR{data.lrs.length === 1 ? "" : "s"}
              </td>
              <td className={`${cell} text-right`}>{totalActualWt}</td>
              <td className={`${cell} text-right`}>{totalChargeWt}</td>
              <td className={cell} />
              <td className={`${cell} text-right`}>{formatMoney(totals.total)}</td>
              {lrActions && <td className={cell} />}
            </tr>
          </tbody>
        </table>
      </div>

      {/*
        The lower half is two columns that both run to the foot of the sheet:
        everything in words on the left, everything in figures on the right,
        ending in the signature. items-stretch is what makes the sheet finish on
        one clean line however long the declaration runs.
      */}
      <div className="flex items-stretch">
        {/* left: charges, remarks, declaration (with RCM inside it), notes */}
        <div className="flex w-1/2 flex-col border-r border-black p-2 text-xs">
          {data.charges.length > 0 && (
            <table className="mb-2 w-full border-collapse">
              <thead>
                <tr>
                  <th className={`${labelCell} text-left`}>Additional Charge</th>
                  <th className={`${labelCell} text-left`}>Related LR(s)</th>
                  <th className={`${labelCell} text-left`}>Amount</th>
                </tr>
              </thead>
              <tbody>
                {data.charges.map((c, i) => (
                  <tr key={i}>
                    <td className={cell}>{c.label}</td>
                    <td className={cell}>{c.relatedLrs || "All LRs"}</td>
                    <td className={`${cell} text-right`}>{formatMoney(c.amount)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}

          {data.remarks && (
            <div className="mb-2">
              <b>Remarks:</b> {data.remarks}
            </div>
          )}

          <div className="font-semibold underline">Declaration</div>
          <div className="text-[10px]">
            We hereby declare that this invoice shows the actual price of the services described
            and that all particulars are true and correct. Goods Transport Agency service.
          </div>

          {/*
            The RCM figures and the Notification 13/2017 wording are one block.
            The table is only meaningful as evidence for the sentence beneath it —
            standing alone it reads as a tax charge sitting beside a Grand Total
            that deliberately excludes it.
          */}
          {data.rcm && (
            <div className="mt-1 border border-black p-1">
              <div className="font-semibold">
                Reverse Charge Mechanism (RCM) — For Information Only
              </div>
              <table className="mt-0.5 w-full border-collapse">
                <tbody>
                  {(
                    [
                      ["Taxable Value", data.rcm.taxableValue],
                      ...(data.rcm.igst > 0
                        ? ([[`IGST @ ${data.rcm.pct}%`, data.rcm.igst]] as [string, number][])
                        : ([
                            [`CGST @ ${data.rcm.pct / 2}%`, data.rcm.cgst],
                            [`SGST @ ${data.rcm.pct / 2}%`, data.rcm.sgst],
                          ] as [string, number][])),
                    ] as [string, number][]
                  ).map(([label, v]) => (
                    <tr key={label}>
                      <td className={cell}>{label}</td>
                      <td className={`${cell} text-right`}>{formatMoney(v)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <div className="mt-1 text-[10px] font-semibold">
                GST on this invoice is payable by the recipient of service under Reverse Charge
                Mechanism as per Notification No. 13/2017 — Central Tax (Rate). GST has NOT been
                charged on this invoice.
              </div>
            </div>
          )}

          {/* mt-auto pins the standing notes to the foot of the column, where a
              full-width strip used to carry them */}
          <div className="mt-auto pt-2 text-[10px]">
            <div>E. &amp; O.E.</div>
            <div>
              Interest @ 12% per annum will be charged from the date of the bill if payment is
              delayed.
            </div>
            <div>All disputes are subject to Raigarh jurisdiction only.</div>
          </div>
        </div>

        {/* right: totals, amount in words, bank, then the signature */}
        <div className="flex w-1/2 flex-col text-xs">
          <table className="w-full border-collapse">
            <tbody>
              {(
                [
                  ["Total Weight (Charged)", String(totalChargeWt)],
                  ["Total Freight", formatMoney(totals.total)],
                  ["Additional Charges", formatMoney(chargesTotal)],
                  ["Taxable Value", formatMoney(totals.grandTotal)],
                  ...(data.gstApplied
                    ? ([
                        [`CGST @ ${data.gstPct / 2}%`, formatMoney(totals.cgstAmt)],
                        [`SGST @ ${data.gstPct / 2}%`, formatMoney(totals.sgstAmt)],
                        [`IGST @ ${data.gstPct}%`, formatMoney(totals.igstAmt)],
                      ] as [string, string][])
                    : // only a bill actually on reverse-charge shifts GST to the
                      // recipient — a plain no-GST bill must not claim RCM
                      ([
                        [
                          "GST",
                          data.reverseCharge ? "Payable under RCM by recipient" : "Not Applicable",
                        ],
                      ] as [string, string][])),
                  ["Less: Advance", formatMoney(totals.advance)],
                  ["Round Off", (roundOff >= 0 ? "+" : "−") + formatMoney(Math.abs(roundOff))],
                ] as [string, string][]
              ).map(([label, v]) => (
                <tr key={label}>
                  <td className={cell}>{label}</td>
                  <td className={`${cell} text-right`}>{v}</td>
                </tr>
              ))}
              <tr className="text-sm font-bold">
                <td className={labelCell}>GRAND TOTAL</td>
                <td className={`${labelCell} text-right`}>{formatMoney(grandRounded)}</td>
              </tr>
              {/* directly under the figure it spells out, rather than as a
                  full-width band below both columns where it read as a footnote */}
              <tr>
                <td className={`${cell} font-semibold`} colSpan={2}>
                  Amount in Words: {amountInWords(grandRounded)}
                </td>
              </tr>
            </tbody>
          </table>

          {bankLines.length > 0 && (
            // the one thing on the bill a customer must copy exactly, so it gets
            // its own labelled line each and a larger face than the surrounding
            // declaration text
            // tight leading and an auto-width label column: still one line per
            // field, but the block takes the height it needs and no more
            <div className="border-b border-black px-2 py-1 text-[12px] leading-[1.35]">
              <div className="font-semibold underline">Bank Details</div>
              <table className="w-auto border-collapse">
                <tbody>
                  {bankLines.map(([label, value, mono]) => (
                    <tr key={label}>
                      <td className="whitespace-nowrap py-0 pr-3 align-top font-semibold">
                        {label}
                      </td>
                      <td className={`py-0 ${mono ? "font-mono tracking-tight" : ""}`}>{value}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {/*
            Last thing on the sheet, read top to bottom: firm, seal, signatory.
            The seal sits between the two lines rather than behind either, since
            a stamped bill is normally signed across it. flex-1 lets the panel
            take whatever height the left column leaves.
          */}
          <div className="flex flex-1 break-inside-avoid flex-col items-end justify-between p-2">
            <div className="font-semibold">For {firm.name}</div>
            {firm.sealUrl && (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={firm.sealUrl}
                alt=""
                className="my-0.5 mr-3 h-14 w-14 object-contain"
              />
            )}
            <div className="mt-4">Authorized Signatory</div>
          </div>
        </div>
      </div>
    </div>
  );
}
