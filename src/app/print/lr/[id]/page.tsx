/* eslint-disable @next/next/no-img-element */
import { notFound } from "next/navigation";
import { requireSession } from "@/lib/session";
import { authorize } from "@/lib/authz";
import { withTenant } from "@/lib/db";
import { formatDate, formatMoney } from "@/lib/utils";
import { firmImageUrl } from "@/lib/branding";
import { PrintToolbar } from "@/components/lr/print-toolbar";

export const dynamic = "force-dynamic";

/**
 * Lorry Receipt — the approved standard print (design demo signed off
 * 05-08-2026). Landscape A4, one copy per sheet, five sheets.
 *
 * Layout: full-width masthead; left block carries demurrage + notice and the
 * single wide CONSIGNOR | CONSIGNEE box with insurance + consignee-bank under
 * it; the middle column groups the trip (From / To / Truck No / Invoice)
 * under the consignment note; the right column holds issuing office, delivery
 * office, E-Way Bill, marks and person-liable ticks. Goods description wraps
 * over multiple lines inside the material band.
 */
const COPIES = [
  "CONSIGNOR COPY",
  "CONSIGNEE COPY",
  "LORRY COPY",
  "ACCOUNT COPY",
  "FILE COPY",
] as const;

const RED = "#9f1218";

function Rule({ label, value, className = "" }: { label: string; value?: React.ReactNode; className?: string }) {
  return (
    <div className={`flex items-end gap-1 py-[2px] text-[10.5px] ${className}`}>
      {label && <span className="shrink-0 font-bold">{label}</span>}
      <span className="min-w-0 flex-1 break-words border-b border-neutral-500 px-1 font-extrabold leading-tight">
        {value ?? " "}
      </span>
    </div>
  );
}

function BoxTitle({ children }: { children: React.ReactNode }) {
  return (
    <div className="border-b border-black px-1 py-0.5 text-center text-[10px] font-black uppercase">
      {children}
    </div>
  );
}

export default async function LrPrintPage({ params }: { params: { id: string } }) {
  const session = requireSession();
  await authorize(session, "lr", "print");

  const data = await withTenant(session.tenantId, async (tx) => {
    // firm/FY scoped: another firm's LR must never print under this letterhead
    const lr = await tx.lr.findFirst({
      where: { id: params.id, firmId: session.firmId, fyId: session.fyId, deletedAt: null },
      include: { items: true, invoices: { orderBy: { sortOrder: "asc" } } },
    });
    if (!lr) return null;
    const [firm, sourceCity, destCity, consignor, consignee, vehicle] = await Promise.all([
      tx.firm.findUniqueOrThrow({ where: { id: session.firmId } }),
      tx.city.findUnique({ where: { id: lr.sourceCityId } }),
      tx.city.findUnique({ where: { id: lr.destCityId } }),
      tx.party.findUnique({ where: { id: lr.consignorId } }),
      tx.party.findUnique({ where: { id: lr.consigneeId } }),
      lr.vehicleId ? tx.vehicle.findUnique({ where: { id: lr.vehicleId } }) : Promise.resolve(null),
    ]);
    const destState = destCity?.stateId
      ? await tx.state.findUnique({ where: { id: destCity.stateId } })
      : null;
    return { lr, firm, sourceCity, destCity, destState, consignor, consignee, vehicle };
  });

  if (!data) notFound();
  const { lr, firm, sourceCity, destCity, destState, consignor, consignee, vehicle } = data;
  const logoUrl = firmImageUrl(firm, "logo");
  // invoice / e-way lines: the list when present, else the LR's own columns
  const invLines =
    lr.invoices.length > 0
      ? lr.invoices
      : [{ invoiceNo: lr.invoiceNo, invoiceDate: lr.invoiceDate, ewayBillNo: lr.ewayBillNo, ewayExpiry: lr.ewayExpiry }];
  const showAmounts = lr.printFreight;

  const addr = (p: { address1?: string | null; address2?: string | null } | null) =>
    [p?.address1, p?.address2].filter(Boolean).join(", ");

  const totalQty = lr.items.reduce((s, i) => s + Number(i.qty), 0);
  const totalActual = lr.items.reduce((s, i) => s + Number(i.actualWt), 0);
  const totalCharge = lr.items.reduce((s, i) => s + Number(i.chargeWt), 0);
  const mainRate = lr.items.length ? Math.max(...lr.items.map((i) => Number(i.rate))) : 0;
  const riskCharges =
    Number(lr.biltyCharge) + Number(lr.collCharge) + Number(lr.cpc) + Number(lr.preBhada);

  const chargeRows: { label: string; rate?: number; amount: number | null }[] = [
    { label: "Frieght", rate: mainRate || undefined, amount: Number(lr.freight) },
    { label: "Mazdoor Char.", amount: Number(lr.hamali) },
    { label: "Risk Charges", amount: riskCharges },
    { label: "SGST", amount: Number(lr.sgstAmt) },
    { label: "CGST", amount: Number(lr.cgstAmt) },
    { label: "IGST", amount: Number(lr.igstAmt) },
    { label: "Any Other Char.", amount: Number(lr.otherCharge) },
  ];

  const liable =
    lr.lrType === "TO_PAY" ? "CONSIGNEE" : lr.lrType === "PAID" ? "CONSIGNOR" : "CONSIGNOR";

  return (
    <div className="min-h-screen bg-neutral-200 text-black print:bg-white">
      <style
        dangerouslySetInnerHTML={{
          __html: `
            .print-fill { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
            @media print {
              .no-print { display: none !important; }
              body { background: #fff; }
              /* one copy = exactly one sheet: the copy is scaled a notch so its
                 full height always fits inside A4 landscape, and page breaks
                 are forced between copies — 5 copies, 5 pages, PDF included */
              .lr-copy {
                zoom: 0.88;
                page-break-after: always;
                page-break-inside: avoid;
                box-shadow: none !important;
                margin: 0 !important;
              }
              .lr-copy:last-child { page-break-after: auto; }
              /* browsers without CSS zoom (old Firefox): scale the copy
                 instead, widening the layout box so the scaled sheet still
                 spans the full printable width */
              @supports not (zoom: 1) {
                .lr-copy {
                  zoom: normal;
                  transform: scale(0.88);
                  transform-origin: top left;
                  width: 113.6%;
                }
              }
            }
            @page { size: A4 landscape; margin: 4mm; }
          `,
        }}
      />
      <PrintToolbar
        note={`Prints ${COPIES.length} copies: ${COPIES.map((c) => c.replace(" COPY", "")).join(", ")}`}
      />

      <div className="mx-auto max-w-[287mm] space-y-6 p-4">
        {COPIES.map((copyLabel) => (
          <div
            key={copyLabel}
            className="lr-copy border-2 border-black bg-white p-1 text-[10px] leading-snug shadow-lg"
            style={{ color: "#111" }}
          >
            {/* ---- top band ---- */}
            <div className="relative pb-0.5 text-center text-[12px] font-black">
              All Subject to {firm.jurisdiction || "Local"} Jurisdiction
              <span className="absolute right-0 top-0 text-[8.5px] font-semibold italic">
                This is a system generated lorry receipt, please treat it as the Original
              </span>
            </div>

            {/* ---- masthead ---- */}
            <div className="flex items-center gap-3 border-2 border-black px-2.5 py-1.5">
              <div className="flex w-[130px] shrink-0 flex-col items-center justify-center" style={{ color: RED }}>
                {logoUrl ? (
                  <img src={logoUrl} alt="" className="max-h-[76px] object-contain" />
                ) : (
                  <div className="border-4 px-2 py-1 text-[19px] font-black tracking-wide" style={{ borderColor: RED }}>
                    {firm.name
                      .split(/\s+/)
                      .map((w) => w[0])
                      .join(".")
                      .toUpperCase()}
                  </div>
                )}
                {firm.pan && <div className="mt-1 text-[10.5px] font-black">PAN No. : {firm.pan}</div>}
              </div>
              <div className="min-w-0 flex-1 text-center">
                <div className="text-[38px] font-black uppercase leading-none tracking-tight" style={{ color: RED }}>
                  {firm.name}
                </div>
                <div className="mt-0.5 text-[12.5px] font-bold italic">
                  Specialist Heavy &amp; O D C Consignment (Fleet Owners &amp; Total Transport Solution)
                </div>
                <div className="text-[12px] font-bold">
                  {[firm.address1, firm.address2].filter(Boolean).join(", ")}
                </div>
                <div className="text-[12px] font-bold">
                  {firm.mobile && <>Mob. : {firm.mobile}</>}
                  {firm.phone && <>, {firm.phone}</>}
                  {firm.email && <> · E-mail : {firm.email}</>}
                  {firm.gstin && <> · GSTIN : {firm.gstin}</>}
                </div>
              </div>
            </div>

            {(lr.lrType === "CANCELLED" || lr.lrType === "PAPER_CHANGE") && (
              <div className="print-fill my-0.5 py-0.5 text-center text-[12px] font-black tracking-[0.3em] text-white" style={{ background: RED }}>
                {lr.lrType === "CANCELLED" ? "CANCELLED LR" : "PAPER CHANGE LR"}
              </div>
            )}

            {/* ================= main body ================= */}
            <div className="mt-1 flex items-stretch gap-1">
              {/* ---- LEFT block (wide): demurrage+notice / consignor|consignee / insurance+bank ---- */}
              <div className="flex min-w-0 flex-1 flex-col gap-1" style={{ flexGrow: 1.35 }}>
                <div className="flex gap-1">
                  <div className="flex-1 border border-black">
                    <BoxTitle>Schedule of Demurrage Charges</BoxTitle>
                    <div className="p-1.5 text-[9px] font-semibold leading-relaxed">
                      Demurrage Chargeable after ________ days from Today
                      <br />@ Rs. ________ Per Day per Qtl. on weight charged.
                    </div>
                  </div>
                  <div className="flex-1 border p-1.5 text-[8.4px] leading-snug" style={{ borderColor: RED, color: RED }}>
                    <div className="text-center text-[9.5px] font-black underline">NOTICE :</div>
                    The consignment covered by this Lorry receipt shall be stored at the destination
                    under the control of the Transport Operator and shall be delivered to or to the
                    order of the Consignee Bank whose name is mentioned in the Lorry Receipt. It
                    will under no circumstances be delivered to anyone without the written authority
                    from the Consignee Bank or its order, endorsed on the Consignee Copy.
                  </div>
                </div>

                {/* the single wide consignor | consignee box */}
                {/* insurance + consignee bank (above, per request) */}
                <div className="flex border border-black">
                  <div className="border-r border-black" style={{ flex: 1.2 }}>
                    <BoxTitle>
                      At Carrier Risk — <span style={{ color: RED }}>Insurance</span>
                    </BoxTitle>
                    <div className="p-1.5 text-[9.5px]">
                      <div className="font-semibold">
                        The Customer has stated that : He has not insured Consignment O/R he has
                        insured with
                      </div>
                      <div className="flex gap-2">
                        <Rule className="flex-1" label="Company :" value={lr.insCompany} />
                        <Rule className="flex-1" label="Policy No. :" value={lr.insPolicyNo} />
                      </div>
                      <div className="flex gap-2">
                        <Rule
                          className="flex-1"
                          label="Amount :"
                          value={lr.insAmount != null && showAmounts ? formatMoney(Number(lr.insAmount)) : undefined}
                        />
                        <Rule className="w-[70px]" label="Date :" />
                        <Rule className="w-[60px]" label="Risk :" />
                      </div>
                    </div>
                  </div>
                  <div className="flex-1">
                    <BoxTitle>Consignee&apos;s Bank</BoxTitle>
                    <div className="p-1.5 text-[9.5px]">
                      <Rule label="Bank Name & Address :" />
                      <Rule label="" />
                      <Rule label="Code Number :" />
                    </div>
                  </div>
                </div>

                {/* consignor | consignee (below, per request) */}
                <div className="flex flex-1 border border-black">
                  <div className="flex-1 border-r border-black">
                    <BoxTitle>Consignor</BoxTitle>
                    <div className="p-1.5 text-[11.5px]">
                      <div className="text-[13px] font-black uppercase" style={{ color: RED }}>
                        {consignor?.name}
                      </div>
                      <div className="font-bold">{addr(consignor)}</div>
                      {consignor?.mobile && <div className="font-bold">Mob. : {consignor.mobile}</div>}
                      {consignor?.gstin && <div className="font-bold">GSTIN : {consignor.gstin}</div>}
                    </div>
                  </div>
                  <div className="flex-1">
                    <BoxTitle>Consignee</BoxTitle>
                    <div className="p-1.5 text-[11.5px]">
                      <div className="text-[13px] font-black uppercase" style={{ color: RED }}>
                        {consignee?.name}
                      </div>
                      <div className="font-bold">{addr(consignee)}</div>
                      {consignee?.mobile && <div className="font-bold">Mob. : {consignee.mobile}</div>}
                      {consignee?.gstin && <div className="font-bold">GSTIN : {consignee.gstin}</div>}
                    </div>
                  </div>
                </div>
              </div>

              {/* ---- MIDDLE column: copy / consignment note / trip details / caution ---- */}
              <div className="flex w-[218px] shrink-0 flex-col gap-1">
                <div className="pb-0.5 text-center text-[14px] font-black tracking-wide" style={{ color: RED }}>
                  {copyLabel}
                </div>
                {/* caution on top, then consignment note, then trip details */}
                <div className="border border-black p-1.5 text-[8.6px] font-semibold leading-snug">
                  <b>Caution :</b> This Consignment will not be detained, diverted, re-routed or
                  re-booked without Consignee Bank&apos;s written permission. Will be Delivered at
                  the destination.
                </div>
                <div className="border border-black">
                  <BoxTitle>Consignment Note</BoxTitle>
                  <div className="p-1.5">
                    <div className="flex items-baseline gap-1.5">
                      <span className="text-[10.5px] font-black">No. :</span>
                      <span className="text-[24px] font-black tracking-widest" style={{ color: RED }}>
                        {lr.lrNo}
                      </span>
                    </div>
                    <Rule label="Date :" value={formatDate(lr.lrDate)} />
                  </div>
                </div>
                {/* trip details: fixed label column so every value starts on the
                    same vertical line */}
                <div className="flex-1 border border-black">
                  <BoxTitle>Trip Details</BoxTitle>
                  <div className="p-1.5 text-[11.5px]">
                    {(
                      [
                        ["From :", <span key="f" className="uppercase">{sourceCity?.name}</span>],
                        ["To :", <span key="t" className="uppercase">{destCity?.name}</span>],
                        ["Truck No. :", <span key="v" className="text-[12.5px]">{vehicle?.number ?? lr.vehicleText}</span>],
                        // every invoice line of the LR, comma-joined
                        ["Invoice No. :", invLines.map((r) => r.invoiceNo).filter(Boolean).join(", ")],
                        [
                          "Invoice Date :",
                          Array.from(
                            new Set(invLines.map((r) => (r.invoiceDate ? formatDate(r.invoiceDate) : "")).filter(Boolean))
                          ).join(", "),
                        ],
                      ] as [string, React.ReactNode][]
                    ).map(([label, value]) => (
                      <div key={label} className="flex items-end gap-1 py-[3px]">
                        <span className="w-[82px] shrink-0 font-bold">{label}</span>
                        <span className="min-w-0 flex-1 break-words border-b border-neutral-500 px-1 font-extrabold leading-tight">
                          {value ?? " "}
                        </span>
                      </div>
                    ))}
                  </div>
                </div>
              </div>

              {/* ---- RIGHT column: issuing office / delivery / e-way / marks+liable ---- */}
              <div className="flex w-[205px] shrink-0 flex-col gap-1">
                <div className="border border-black">
                  <BoxTitle>Address of Issuing Office / Agent</BoxTitle>
                  <div className="p-1.5 text-[9px] font-semibold">
                    <div className="font-black uppercase">{firm.name}</div>
                    <div>{[firm.address1, firm.address2].filter(Boolean).join(", ")}</div>
                    <div>{firm.mobile && `Mob. : ${firm.mobile}`}</div>
                  </div>
                </div>
                <div className="border border-black p-1.5 text-[10px]">
                  <Rule label="Delivery Office :" value={lr.deliveryAt || destCity?.name} />
                  <Rule label="State :" value={destState?.name} />
                  <Rule label="Tel. :" />
                </div>
                <div className="border border-black">
                  <BoxTitle>E-Way Bill</BoxTitle>
                  <div className="p-1.5 text-[10.5px]">
                    <Rule label="No. :" value={invLines.map((r) => r.ewayBillNo).filter(Boolean).join(", ")} />
                    <Rule
                      label="Date :"
                      value={Array.from(
                        new Set(invLines.map((r) => (r.ewayExpiry ? formatDate(r.ewayExpiry) : "")).filter(Boolean))
                      ).join(", ")}
                    />
                  </div>
                </div>
                <div className="flex-1 border border-black p-1.5 text-[10px]">
                  <div className="font-black">Private Marks</div>
                  <div className="min-h-[13px] font-extrabold uppercase">{lr.privateMarka || " "}</div>
                  {lr.remarks && (
                    <>
                      <div className="mt-0.5 font-black">Additional Information</div>
                      <div className="font-semibold">{lr.remarks}</div>
                    </>
                  )}
                  <div className="mt-0.5 font-black">GSTIN / UniqueID Reg. No.</div>
                  <div className="break-all font-extrabold">{firm.gstin || " "}</div>
                  <div className="mt-1 font-black">Person Liable to Pay</div>
                  <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 pt-0.5">
                    {(["CONSIGNOR", "CONSIGNEE", "TRANSPORTER"] as const).map((who) => (
                      <span key={who} className="flex items-center gap-1">
                        <span className="inline-flex h-[11px] w-[11px] items-center justify-center border border-black text-[8.5px] font-black leading-none">
                          {liable === who ? "✓" : ""}
                        </span>
                        <span className="font-semibold capitalize">{who.toLowerCase()}</span>
                      </span>
                    ))}
                  </div>
                </div>
              </div>
            </div>

            {/* ================= material + charges ================= */}
            <div className="mt-1 flex items-stretch gap-1">
              <div className="min-w-0 flex-1 border border-black">
                <table className="w-full border-collapse text-[10.5px]">
                  <thead>
                    <tr className="text-center font-black">
                      <th className="w-[58px] border-b border-r border-black py-0.5">Pkgs.</th>
                      <th className="border-b border-r border-black py-0.5">Description (Said to Contain)</th>
                      <th className="w-[72px] border-b border-r border-black py-0.5">Actual Wt</th>
                      <th className="w-[72px] border-b border-black py-0.5">Charged Wt</th>
                    </tr>
                  </thead>
                  <tbody>
                    {lr.items.map((item) => (
                      <tr key={item.id} className="align-top">
                        <td className="border-r border-black px-1 py-0.5 text-center font-extrabold tabular-nums">
                          {Number(item.qty).toFixed(0)}
                        </td>
                        {/* description wraps over multiple lines inside the cell */}
                        <td className="max-w-[300px] whitespace-normal break-words border-r border-black px-1.5 py-0.5 font-extrabold uppercase leading-[1.4]">
                          {item.productName}
                          {item.description ? ` — ${item.description}` : ""}
                        </td>
                        <td className="border-r border-black px-1 py-0.5 text-right font-bold tabular-nums">
                          {Number(item.actualWt).toFixed(3)}
                        </td>
                        <td className="px-1 py-0.5 text-right font-bold tabular-nums">
                          {Number(item.chargeWt).toFixed(3)}
                        </td>
                      </tr>
                    ))}
                    <tr className="font-black">
                      <td className="border-r border-t border-black px-1 py-0.5 text-center tabular-nums">
                        {totalQty.toFixed(0)}
                      </td>
                      <td className="border-r border-t border-black px-1 py-0.5">
                        <div
                          className="mx-auto w-fit border px-2 py-0.5 text-center text-[7.5px] font-black leading-snug"
                          style={{ color: RED, borderColor: RED }}
                        >
                          * GOODS DESCRIBED AS ABOVE &amp; RECEIVED IN
                          <br />
                          GOOD ORDER &amp; CONDITION · CONTENTS NOT CHECKED
                          <br />
                          PLEASE TAKE DELIVERY FROM THE RISK *
                        </div>
                      </td>
                      <td className="border-r border-t border-black px-1 py-0.5 text-right tabular-nums">
                        {totalActual.toFixed(3)}
                      </td>
                      <td className="border-t border-black px-1 py-0.5 text-right tabular-nums">
                        {totalCharge.toFixed(3)}
                      </td>
                    </tr>
                  </tbody>
                </table>
              </div>

              <div className="w-[270px] shrink-0 border border-black">
                <table className="w-full border-collapse text-[10.5px]">
                  <thead>
                    <tr className="text-center font-black">
                      <th className="border-b border-r border-black py-0.5 pl-1 text-left">Particulars</th>
                      <th className="w-[46px] border-b border-r border-black py-0.5">Rate</th>
                      <th className="w-[92px] border-b border-black py-0.5">Amount Rs.</th>
                    </tr>
                  </thead>
                  <tbody>
                    {chargeRows.map((row) => (
                      <tr key={row.label}>
                        <td className="border-r border-black px-1 py-[2px] font-bold">{row.label}</td>
                        <td className="border-r border-black px-1 py-[2px] text-right font-semibold tabular-nums">
                          {showAmounts && row.rate ? row.rate.toFixed(2) : ""}
                        </td>
                        <td className="px-1 py-[2px] text-right font-bold tabular-nums">
                          {showAmounts && row.amount ? formatMoney(row.amount) : ""}
                        </td>
                      </tr>
                    ))}
                    {showAmounts && Number(lr.advance) > 0 && (
                      <tr>
                        <td className="border-r border-black px-1 py-[2px] font-bold">Less : Advance</td>
                        <td className="border-r border-black px-1 py-[2px]" />
                        <td className="px-1 py-[2px] text-right font-bold tabular-nums">
                          −{formatMoney(Number(lr.advance))}
                        </td>
                      </tr>
                    )}
                    <tr className="border-t-2 border-black text-[12px] font-black">
                      <td className="border-r border-black px-1 py-1">TOTAL</td>
                      <td className="border-r border-black px-1 py-1" />
                      <td className="px-1 py-1 text-right tabular-nums">
                        {showAmounts ? formatMoney(Number(lr.grandTotal)) : ""}
                      </td>
                    </tr>
                    {!showAmounts && (
                      <tr>
                        <td colSpan={3} className="p-2 text-center">
                          <span
                            className="inline-block rotate-[-6deg] border-2 px-2 py-0.5 text-[11px] font-black tracking-widest"
                            style={{ borderColor: RED, color: RED }}
                          >
                            TO BE BILLED
                          </span>
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>
            </div>

            {/* ---- footer ---- */}
            <div className="mt-1 flex items-end gap-4 border border-black p-2 text-[11.5px] font-black">
              <div className="flex items-end gap-1">
                Value
                <span className="inline-block w-[130px] border-b border-black px-1 text-right tabular-nums">
                  {lr.goodsValue != null && showAmounts ? formatMoney(Number(lr.goodsValue)) : " "}
                </span>
              </div>
              <div className="flex-1 text-center">
                <div className="mb-0.5 h-[18px] border-b border-black" />
                Signature of Transport Operator
              </div>
              <div className="flex-1 text-center">
                <div className="mb-0.5 h-[18px] border-b border-black" />
                Signature of Consignor
              </div>
              <div className="text-center text-[10px]">
                For <span style={{ color: RED }}>{firm.name.toUpperCase()}</span>
                <div className="mt-5 border-t border-black px-2 pt-0.5">Authorised Signatory</div>
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
