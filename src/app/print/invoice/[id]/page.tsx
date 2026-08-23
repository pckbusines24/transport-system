import { notFound } from "next/navigation";
import { requireSession } from "@/lib/session";
import { authorize } from "@/lib/authz";
import { withTenant } from "@/lib/db";
import { compareLrNo, formatDate, formatMoney, toNum } from "@/lib/utils";
import { round2 } from "@/lib/calc/tds";
import { gstSplit, stateCodeFromGstin } from "@/lib/calc/gst";
import { firmImageUrl } from "@/lib/branding";
import {
  InvoicePrintView,
  type InvoiceViewData,
} from "@/components/billing/invoice-print-view";
import {
  ManualBillPrintView,
  type ManualBillViewData,
} from "@/components/billing/manual-bill-print-view";
import { PrintToolbar } from "./print-toolbar";

export const dynamic = "force-dynamic";

export default async function InvoicePrintPage({ params }: { params: { id: string } }) {
  const session = requireSession();
  await authorize(session, "billing", "print");

  const data = await withTenant(session.tenantId, async (tx) => {
    const invoice = await tx.invoice.findFirst({
      where: { id: params.id, firmId: session.firmId, deletedAt: null },
      include: {
        lrs: { include: { lr: { include: { items: true, pods: true } } } },
        charges: true,
        lines: true,
      },
    });
    if (!invoice) return null;
    const [firm, party, bank, cities, vehicles, parties, states] = await Promise.all([
      tx.firm.findUnique({ where: { id: invoice.firmId } }),
      tx.party.findUnique({ where: { id: invoice.partyId } }),
      invoice.bankPartyId
        ? tx.party.findUnique({ where: { id: invoice.bankPartyId } })
        : Promise.resolve(null),
      tx.city.findMany(),
      tx.vehicle.findMany(),
      tx.party.findMany(),
      tx.state.findMany(),
    ]);
    return { invoice, firm, party, bank, cities, vehicles, parties, states };
  });

  if (!data) notFound();
  const { invoice, firm, party, bank, cities, vehicles, parties, states } = data;
  const cityName = (id: string) => cities.find((c) => c.id === id)?.name ?? "";
  const partyName = (id: string) => parties.find((p) => p.id === id)?.name ?? "";
  const vehicleNo = (id: string | null) =>
    id ? vehicles.find((v) => v.id === id)?.number ?? "" : "";
  const stateOf = (stateId: string | null | undefined, gstin: string | null | undefined) => {
    const st = stateId ? states.find((s) => s.id === stateId) : null;
    return {
      name: st?.name ?? "",
      code: st?.gstCode ?? stateCodeFromGstin(gstin) ?? "",
    };
  };

  const firmState = stateOf(firm?.stateId, firm?.gstin);
  const partyState = stateOf(party?.stateId, party?.gstin);
  const gstTotal = round2(
    toNum(invoice.cgstAmt) + toNum(invoice.sgstAmt) + toNum(invoice.igstAmt)
  );
  // GST-kind totals build up from the discounted taxable value of the lines
  const linesTaxable = round2(invoice.lines.reduce((s, l) => s + toNum(l.taxableValue), 0));
  const firmGstPct = firm
    ? toNum(firm.cgstPct) + toNum(firm.sgstPct) || toNum(firm.igstPct)
    : 0;
  const rcm = invoice.reverseCharge && gstTotal === 0;
  const rcmSplit = rcm
    ? gstSplit({
        taxableValue: toNum(invoice.grandTotal),
        gstPct: firmGstPct,
        supplierStateCode: firmState.code || null,
        recipientStateCode: partyState.code || null,
      })
    : null;

  const invGstPct =
    toNum(invoice.cgstPct) + toNum(invoice.sgstPct) || toNum(invoice.igstPct) || firmGstPct;

  const viewData: InvoiceViewData = {
    billNo: invoice.invoiceNo,
    billDate: formatDate(invoice.invoiceDate),
    placeOfSupply: invoice.placeOfSupply || partyState.name || "",
    gstPct: invGstPct,
    firm: {
      name: firm?.name ?? "",
      address: [firm?.address1, firm?.address2].filter(Boolean).join(", "),
      mobile: firm?.mobile ?? "",
      email: firm?.email ?? "",
      gstin: firm?.gstin ?? "",
      pan: firm?.pan ?? "",
      stateName: firmState.name,
      stateCode: firmState.code,
      ibaCode: firm?.ibaCode ?? "",
      vendorCode: firm?.vendorCode ?? "",
      rcmCovered: firm?.rcmCovered ?? true,
      logoUrl: firmImageUrl(firm, "logo"),
      sealUrl: firmImageUrl(firm, "seal"),
    },
    tdsPct: toNum(invoice.tdsPct),
    serviceDescription: "Goods Transport Service",
    sacCode: invoice.sacCode || "996791",
    party: {
      name: party?.name ?? "",
      address: [party?.address1, party?.address2].filter(Boolean).join(", "),
      gstin: party?.gstin ?? "",
      pan: party?.pan ?? "",
      stateName: partyState.name,
      stateCode: partyState.code,
      vendorCode: party?.vendorCode ?? "",
    },
    // S.No follows the LR number, not the order the LRs were attached — an
    // edited bill prints 10002, 10003, 10004 in the same seats every time
    lrs: [...invoice.lrs]
      .sort((a, b) => compareLrNo(a.lr.lrNo, b.lr.lrNo))
      .map(({ lr }) => ({
        id: lr.id,
        lrNo: lr.lrNo,
        lrDate: formatDate(lr.lrDate),
        source: cityName(lr.sourceCityId),
        dest: cityName(lr.destCityId),
        obdNo: lr.obdNo ?? "",
        // PO / gate entry come from the POD entry, falling back to the LR fields
        poNumber: lr.pods[0]?.poNumber || lr.poNumber || "",
        gateEntryNo: lr.pods[0]?.gateEntryNo || lr.gateEntryNo || "",
        invoiceNo: lr.invoiceNo ?? "",
        vehicle: vehicleNo(lr.vehicleId) || lr.vehicleText || "",
        material: lr.items.map((i) => i.productName).filter(Boolean).join(", "),
        consignee: partyName(lr.consigneeId),
        unloadDate: lr.pods[0]?.unloadDate ? formatDate(lr.pods[0].unloadDate) : "",
        qty: lr.items.reduce((s, i) => s + toNum(i.qty), 0),
        actualWt: lr.items.reduce((s, i) => s + toNum(i.actualWt), 0),
        chargeWt: lr.items.reduce((s, i) => s + toNum(i.chargeWt), 0),
        rate: lr.items.length ? Math.max(...lr.items.map((i) => toNum(i.rate))) : 0,
        amount: toNum(lr.total),
      })),
    charges: invoice.charges.map((c) => ({
      label: [c.chargeType, c.description].filter(Boolean).join(" — "),
      relatedLrs: c.relatedLrs ?? "",
      amount: toNum(c.amount),
    })),
    totals: {
      total: toNum(invoice.total),
      grandTotal: toNum(invoice.grandTotal),
      cgstAmt: toNum(invoice.cgstAmt),
      sgstAmt: toNum(invoice.sgstAmt),
      igstAmt: toNum(invoice.igstAmt),
      roundOff: toNum(invoice.roundOff),
      netTotal: toNum(invoice.netTotal),
      advance: toNum(invoice.advance),
      balance: toNum(invoice.balance),
    },
    rcm: rcmSplit
      ? {
          taxableValue: toNum(invoice.grandTotal),
          pct: firmGstPct,
          cgst: rcmSplit.cgst,
          sgst: rcmSplit.sgst,
          igst: rcmSplit.igst,
        }
      : null,
    gstApplied: gstTotal > 0,
    reverseCharge: invoice.reverseCharge,
    remarks: invoice.remarks ?? "",
    // passed through as fields, not a joined line — the view prints one
    // labelled row each so the account number and IFSC cannot be misread
    bank: bank
      ? {
          name: bank.bankName ?? bank.name,
          branch: bank.bankBranch ?? "",
          account: bank.bankAccount ?? "",
          ifsc: bank.bankIfsc ?? "",
        }
      : null,
  };

  // Manual bill prints in the firm's own hand-bill format (landscape replica)
  const manualData: ManualBillViewData | null =
    invoice.kind === "MANUAL"
      ? {
          billNo: invoice.invoiceNo,
          billDate: formatDate(invoice.invoiceDate),
          firm: {
            name: firm?.name ?? "",
            regdOffice: [firm?.address1, firm?.address2].filter(Boolean).join(", "),
            mobile: firm?.mobile ?? "",
            pan: firm?.pan ?? "",
            msmeNo: firm?.msmeNo ?? "",
            logoUrl: firmImageUrl(firm, "logo"),
            sealUrl: firmImageUrl(firm, "seal"),
          },
          party: {
            name: party?.name ?? "",
            address: [party?.address1, party?.address2].filter(Boolean).join(", "),
          },
          rows: invoice.lines.map((l) => ({
            cnNo: l.cnNo ?? "",
            date: l.lineDate ? formatDate(l.lineDate) : "",
            loading: l.loadingStation ?? "",
            delivery: l.deliveryStation ?? "",
            invoiceNo: l.invoiceNo ?? "",
            vehicleNo: l.vehicleNo ?? "",
            material: l.productName,
            deliveryDate: l.deliveryDate ? formatDate(l.deliveryDate) : "",
            wt: toNum(l.wt),
            gtWt: toNum(l.gtWt),
            rate: toNum(l.rate),
            amount: toNum(l.total),
          })),
          totalFreight: toNum(invoice.total),
          otherCharge: round2(toNum(invoice.grandTotal) - toNum(invoice.total)),
          cgstAmt: toNum(invoice.cgstAmt),
          sgstAmt: toNum(invoice.sgstAmt),
          igstAmt: toNum(invoice.igstAmt),
          totalBilled: toNum(invoice.netTotal),
          rcmNote: gstTotal === 0,
          // the account is the firm's own — the bill's selected bank party wins,
          // else the bank saved in Company Master prints as the default
          bank: bank
            ? {
                accountName: firm?.name ?? "",
                account: bank.bankAccount ?? "",
                bankName: bank.bankName ?? bank.name,
                ifsc: bank.bankIfsc ?? "",
                branch: bank.bankBranch ?? "",
              }
            : firm?.bankAccount || firm?.bankName
              ? {
                  accountName: firm.name,
                  account: firm.bankAccount ?? "",
                  bankName: firm.bankName ?? "",
                  ifsc: firm.bankIfsc ?? "",
                  branch: firm.bankBranch ?? "",
                }
              : null,
        }
      : null;

  const landscape = invoice.lrs.length > 0 || invoice.kind === "MANUAL";

  return (
    // no padding when printing — every millimetre of height counts toward
    // keeping the bill on one sheet
    <div className="bg-white p-4 text-black print:p-0">
      {/*
        Landscape, scoped to this route. @page cannot be scoped by selector, so
        putting this in globals.css would rotate the chalan, LR, trip sheet and
        broker slip prints too. The LR-based bill and the manual hand-bill are
        landscape — the GST layout below has six columns and stays portrait.
      */}
      {landscape && <style>{"@page { size: A4 landscape; margin: 8mm; }"}</style>}
      <PrintToolbar wide={landscape} />
      {invoice.lrs.length > 0 ? (
        <InvoicePrintView data={viewData} />
      ) : manualData ? (
        <ManualBillPrintView data={manualData} />
      ) : (
        /* lines-based bills (Manual / GST): simple generic layout */
        <div className="mx-auto max-w-[190mm] border border-black p-4 text-sm">
          <div className="border-b border-black pb-2 text-center">
            <div className="text-xl font-bold uppercase">{firm?.name}</div>
            <div className="text-xs">
              {[firm?.address1, firm?.address2].filter(Boolean).join(", ")}
            </div>
            <div className="text-xs">
              {[
                firm?.mobile && `Mob: ${firm.mobile}`,
                firm?.gstin && `GSTIN: ${firm.gstin}`,
                firm?.pan && `PAN: ${firm.pan}`,
              ]
                .filter(Boolean)
                .join(" | ")}
            </div>
            <div className="mt-1 text-sm font-semibold">
              {invoice.kind === "GST" ? "TAX INVOICE" : "BILL"}
            </div>
          </div>
          <div className="mt-2 grid grid-cols-2 gap-x-4 gap-y-0.5 text-xs">
            <div>
              <b>Bill No:</b> {invoice.invoiceNo}
            </div>
            <div>
              <b>Date:</b> {formatDate(invoice.invoiceDate)}
            </div>
            <div>
              <b>Party:</b> {party?.name}
            </div>
            <div>
              <b>Party GSTIN:</b> {party?.gstin ?? ""}
            </div>
          </div>
          <table className="mt-3 w-full border-collapse text-xs">
            <thead>
              <tr>
                {["S.No", "Particulars", "UOM", "Qty", "Rate", "Amount"].map((h) => (
                  <th key={h} className="border border-black px-1 py-0.5 text-left">
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {invoice.lines.map((l, i) => (
                <tr key={l.id}>
                  <td className="border border-black px-1 py-0.5">{i + 1}</td>
                  <td className="border border-black px-1 py-0.5">
                    {l.productName}
                    {l.description ? ` — ${l.description}` : ""}
                  </td>
                  <td className="border border-black px-1 py-0.5">{l.uom ?? ""}</td>
                  <td className="border border-black px-1 py-0.5 text-right">{toNum(l.qty)}</td>
                  <td className="border border-black px-1 py-0.5 text-right">{toNum(l.rate)}</td>
                  <td className="border border-black px-1 py-0.5 text-right">
                    {formatMoney(toNum(l.amount))}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <table className="ml-auto mt-3 w-1/2 border-collapse text-xs">
            <tbody>
              {(
                (invoice.kind === "GST"
                  ? [
                      // GST bill: grandTotal already includes tax, TCS and the
                      // extras — build up from the taxable lines instead of
                      // listing GST twice against an all-inclusive figure
                      ["Lines Total (Taxable)", linesTaxable],
                      ...(gstTotal > 0
                        ? ([
                            ["CGST", toNum(invoice.cgstAmt)],
                            ["SGST", toNum(invoice.sgstAmt)],
                            ["IGST", toNum(invoice.igstAmt)],
                          ] as [string, number][])
                        : []),
                      ...(toNum(invoice.tcsAmt) > 0
                        ? ([[`TCS @ ${toNum(invoice.tcsPct)}%`, toNum(invoice.tcsAmt)]] as [
                            string,
                            number,
                          ][])
                        : []),
                      ...(toNum(invoice.freightExtra) !== 0
                        ? ([["Freight (extra)", toNum(invoice.freightExtra)]] as [string, number][])
                        : []),
                      ...(toNum(invoice.othersExtra) !== 0
                        ? ([["Others (extra)", toNum(invoice.othersExtra)]] as [string, number][])
                        : []),
                      ...(toNum(invoice.roundOff) !== 0
                        ? ([["Round Off", toNum(invoice.roundOff)]] as [string, number][])
                        : []),
                      ["Grand Total", toNum(invoice.netTotal)],
                      ["Less: Advance", toNum(invoice.advance)],
                      ["Balance", toNum(invoice.balance)],
                    ]
                  : [
                      ["Grand Total (before tax)", toNum(invoice.grandTotal)],
                      ...(gstTotal > 0
                        ? ([
                            ["CGST", toNum(invoice.cgstAmt)],
                            ["SGST", toNum(invoice.sgstAmt)],
                            ["IGST", toNum(invoice.igstAmt)],
                          ] as [string, number][])
                        : []),
                      ...(toNum(invoice.roundOff) !== 0
                        ? ([["Round Off", toNum(invoice.roundOff)]] as [string, number][])
                        : []),
                      ["Net Total", toNum(invoice.netTotal)],
                      ["Less: Advance", toNum(invoice.advance)],
                      ["Balance", toNum(invoice.balance)],
                    ]) as [string, number][]
              ).map(([label, v]) => (
                <tr key={label} className={label === "Balance" ? "font-bold" : undefined}>
                  <td className="border border-black px-1 py-0.5">{label}</td>
                  <td className="border border-black px-1 py-0.5 text-right">{formatMoney(v)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <div className="mt-8 flex justify-between text-xs">
            <div>Receiver Signature</div>
            <div>For {firm?.name}</div>
          </div>
        </div>
      )}
    </div>
  );
}
