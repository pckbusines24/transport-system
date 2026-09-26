import * as React from "react";
import { notFound } from "next/navigation";
import { requireSession } from "@/lib/session";
import { authorize } from "@/lib/authz";
import { withTenant } from "@/lib/db";
import { formatDate, formatMoney, toNum } from "@/lib/utils";
import { round2 } from "@/lib/calc/tds";
import { brokerPartySettlement, payableSettlement } from "@/lib/settlement";
import { brokerBalanceStatus } from "@/lib/broker-status";
import { firmImageUrl } from "@/lib/branding";
import type { BrokerAdvance } from "@/components/broker/broker-calc";
import { PrintToolbar } from "@/app/print/chalan/[id]/print-toolbar";

export const dynamic = "force-dynamic";

export default async function BrokerSlipPrintPage({
  params,
  searchParams,
}: {
  params: { id: string };
  searchParams: { copies?: string };
}) {
  const session = requireSession();
  await authorize(session, "broker", "print");
  const copies = Math.min(
    3,
    Math.max(1, parseInt(searchParams.copies ?? "1", 10) || 1),
  );

  const data = await withTenant(session.tenantId, async (tx) => {
    // firm scoped: another firm's slip must never print under this session
    const slip = await tx.brokerSlip.findFirst({
      where: { id: params.id, firmId: session.firmId, deletedAt: null },
    });
    if (!slip) return null;
    const [firm, parties, cities, vehicles, vAlloc, pAlloc] = await Promise.all(
      [
        tx.firm.findUnique({ where: { id: slip.firmId } }),
        tx.party.findMany(),
        tx.city.findMany(),
        tx.vehicle.findMany(),
        // owner-side settlement through Payment Vouchers, with its breakdown —
        // the stored v-columns stay 0 for voucher-era payments, but the
        // printed slip must show paid / shortage / round-off like the party side
        payableSettlement(tx, {
          firmId: slip.firmId,
          refType: "BROKER_ENTRY",
          docs: [
            {
              id: slip.id,
              balance: round2(toNum(slip.vNetAmt) - toNum(slip.vAdvance)),
              ownPaid: toNum(slip.vPaidAmount),
              ownShortage: toNum(slip.vShortage),
              ownRoundOff: toNum(slip.vRoundOff),
            },
          ],
        }),
        // party-side settlement: own block + Receipt Vouchers
        brokerPartySettlement(tx, {
          firmId: slip.firmId,
          docs: [
            {
              id: slip.id,
              pNetAmt: toNum(slip.pNetAmt),
              pAdvance: toNum(slip.pAdvance),
              pPaidAmount: toNum(slip.pPaidAmount),
              pShortage: toNum(slip.pShortage),
              pRoundOff: toNum(slip.pRoundOff),
            },
          ],
        }),
      ],
    );
    const v = vAlloc.get(slip.id);
    const p = pAlloc.get(slip.id);
    return {
      slip,
      firm,
      parties,
      cities,
      vehicles,
      vSettled: round2((v?.voucherPaid ?? 0) + (v?.voucherTds ?? 0) + (v?.voucherOther ?? 0)),
      vVoucherShortage: v?.voucherShortage ?? 0,
      vVoucherRoundOff: v?.voucherRoundOff ?? 0,
      vOutstanding: v?.outstanding ?? null,
      pSettled: round2((p?.voucherPaid ?? 0) + (p?.voucherTds ?? 0) + (p?.voucherOther ?? 0)),
      pVoucherShortage: p?.voucherShortage ?? 0,
      pVoucherRoundOff: p?.voucherRoundOff ?? 0,
      pOutstanding: p?.outstanding ?? null,
    };
  });

  if (!data) notFound();
  const {
    slip, firm, parties, cities, vehicles,
    vSettled, vVoucherShortage, vVoucherRoundOff, vOutstanding,
    pSettled, pVoucherShortage, pVoucherRoundOff, pOutstanding,
  } = data;
  // combined figures: the slip's own block + whatever the settlement voucher carried
  const pShortageAll = round2(toNum(slip.pShortage) + pVoucherShortage);
  const pRoundOffAll = round2(toNum(slip.pRoundOff) + pVoucherRoundOff);
  const vShortageAll = round2(toNum(slip.vShortage) + vVoucherShortage);
  const vRoundOffAll = round2(toNum(slip.vRoundOff) + vVoucherRoundOff);
  // the logo uploaded in Firm Settings, top-left of the header like the chalan print
  const logoUrl = firmImageUrl(firm, "logo");
  const partyName = (id: string | null) =>
    id ? (parties.find((p) => p.id === id)?.name ?? "") : "";
  const cityName = (id: string | null) =>
    id ? (cities.find((c) => c.id === id)?.name ?? "") : "";
  const vehicleNo = (id: string | null) =>
    id ? (vehicles.find((v) => v.id === id)?.number ?? "") : "";

  const advances = (
    (slip.advances as unknown as BrokerAdvance[] | null) ?? []
  ).map((a) => ({
    ...a,
    amount: Number(a.amount ?? 0),
  }));

  const brokerName = partyName(slip.transporterId) || partyName(slip.partyId);
  const ownerName = partyName(slip.ownerId) || slip.ownerName || "";

  // live party-side position: the slip's own block PLUS receipt vouchers,
  // against the recomputed receivable (never the stored pBalance column)
  const pLiveBalance = round2(toNum(slip.pNetAmt) - toNum(slip.pAdvance));
  const pLivePaid = round2(toNum(slip.pPaidAmount) + pSettled);
  const pStatus = brokerBalanceStatus({
    side: "P",
    paymentStatus:
      slip.pPaymentStatus === "RECEIVED" || (pOutstanding !== null && pOutstanding <= 0.009) || pSettled > 0.009
        ? "RECEIVED"
        : slip.pPaymentStatus,
    paidAmount: pLivePaid,
    roundOff: pRoundOffAll,
    shortage: pShortageAll,
    balance: pLiveBalance,
  });
  // live owner-side position: own-screen payment PLUS voucher allocations,
  // against the recomputed payable (never the stored vBalance column)
  const vLiveBalance = round2(toNum(slip.vNetAmt) - toNum(slip.vAdvance));
  const vLivePaid = round2(toNum(slip.vPaidAmount) + vSettled);
  const vStatus = brokerBalanceStatus({
    side: "V",
    paymentStatus:
      (vOutstanding !== null && vOutstanding <= 0.009) || vLivePaid + vRoundOffAll + vShortageAll > 0.009
        ? "PAID"
        : slip.vPaymentStatus,
    paidAmount: vLivePaid,
    roundOff: vRoundOffAll,
    shortage: vShortageAll,
    balance: vLiveBalance,
  });

  const brokerParty = parties.find(
    (p) => p.id === (slip.transporterId ?? slip.partyId),
  );
  const ownerParty = slip.ownerId
    ? parties.find((p) => p.id === slip.ownerId)
    : undefined;
  const unit = slip.unit ?? "";
  /** the basis the rate is quoted against decides which quantity multiplies it */
  const basisLabel: Record<string, string> = {
    QTY: "Qty",
    ACTUAL_WT: "Actual Wt",
    CHARGE_WT: "Charge Wt",
    FIXED: "Fixed",
  };

  // Each copy shows only its own side's rate — the broker must never see the
  // owner's rate, and vice versa.
  const SlipDetails = ({ side }: { side: "P" | "V" }) => {
    const isP = side === "P";
    const basis = (isP ? slip.pRateBasis : slip.vRateBasis) ?? slip.rateBasis;
    const rate = toNum(isP ? slip.pRate : slip.vRate);
    const freight = toNum(isP ? slip.pFreight : slip.vFreight);
    const baseQty =
      basis === "QTY"
        ? toNum(slip.qty)
        : basis === "ACTUAL_WT"
          ? toNum(slip.actualWt)
          : basis === "CHARGE_WT"
            ? toNum(slip.chargeWt)
            : 0;
    return (
      <div className="mt-2 grid grid-cols-2 gap-x-4 gap-y-0.5 text-xs">
        <div>
          <b>Slip No:</b> {slip.slipNo}
        </div>
        <div>
          <b>Slip Date:</b> {formatDate(slip.slipDate)}
        </div>
        <div>
          <b>Vehicle:</b> {vehicleNo(slip.vehicleId)}
        </div>
        <div>
          <b>Route:</b> {cityName(slip.loadStationId)} →{" "}
          {cityName(slip.destCityId)}
        </div>
        <div>
          <b>LR No:</b> {slip.lrNo ?? ""}
          {slip.lrDate ? ` (${formatDate(slip.lrDate)})` : ""}
        </div>
        <div>
          <b>Product:</b> {slip.productName ?? ""}
        </div>
        <div>
          <b>Qty:</b> {toNum(slip.qty)} {unit}
        </div>
        <div>
          <b>Actual / Charge Wt:</b> {toNum(slip.actualWt)} /{" "}
          {toNum(slip.chargeWt)}
        </div>
        <div>
          <b>{isP ? "Broker Rate" : "Owner Rate"}:</b>{" "}
          {rate > 0
            ? `${formatMoney(rate)} / ${unit || basisLabel[basis] || ""}`
            : "—"}
          {basis === "FIXED" ? " (fixed)" : ""}
        </div>
        <div>
          <b>{isP ? "Broker Freight" : "Owner Freight"}:</b>{" "}
          {formatMoney(freight)}
          {rate > 0 && baseQty > 0 && (
            <span className="ml-1 text-[10px]">
              ({baseQty} {unit} × {formatMoney(rate)})
            </span>
          )}
        </div>
      </div>
    );
  };

  const SidePage = ({ side, copyNo }: { side: "P" | "V"; copyNo: number }) => {
    const isP = side === "P";
    const rows: [string, number][] = isP
      ? [
          ["Broker Freight", toNum(slip.pFreight)],
          ["Detention", toNum(slip.pDetention)],
          ["ODC", toNum(slip.pOdcAmt)],
          ["Fine / Slip", toNum(slip.pFineSlip)],
          ["Other", toNum(slip.pOtherAmt)],
          ["Less: LD Charge", -toNum(slip.pLdCharge)],
          ["Less: Shortage", -toNum(slip.pShortageAmt)],
          ["Chalan Amount", toNum(slip.pChalanAmt)],
          ["Less: TDS", -toNum(slip.pTdsAmt)],
          // on paper the commission reads as loading expense; the software keeps "Commission"
          ["Less: Loading Exp", -toNum(slip.pCommAmt)],
          ["Less: Mamool", -toNum(slip.pMamool)],
          ["Less: Payment Charge", -toNum(slip.pPaymentCharge)],
          ["Net Amount", toNum(slip.pNetAmt)],
        ]
      : [
          ["Owner Freight", toNum(slip.vFreight)],
          ["Detention", toNum(slip.vDetention)],
          ["ODC", toNum(slip.vOdcAmt)],
          ["Fine / Slip", toNum(slip.vFineAmt)],
          ["Other", toNum(slip.vOtherAmt)],
          ["Less: LD Charge", -toNum(slip.vLdCharge)],
          ["Less: Shortage", -toNum(slip.vShortageAmt)],
          ["Chalan Amount", toNum(slip.vChalanAmt)],
          ["Less: TDS", -toNum(slip.vTdsAmt)],
          ["Less: Loading Exp", -toNum(slip.vCommAmt)],
          ["Less: Mamool", -toNum(slip.vMamool)],
          ["Less: Payment Charge", -toNum(slip.vPaymentAmt)],
          ["Net Amount", toNum(slip.vNetAmt)],
        ];
    const sideAdvances = advances.filter((a) => a.side === side);
    const advanceTotal = isP ? toNum(slip.pAdvance) : toNum(slip.vAdvance);
    const balance = isP ? pLiveBalance : vLiveBalance;
    const status = isP ? pStatus : vStatus;
    const paid = isP ? pLivePaid : vLivePaid;
    const paymentDate = isP ? slip.pPaymentDate : slip.vPaymentDate;
    // deducted at settlement — shown so the printed balance reconciles
    const shortage = isP ? pShortageAll : vShortageAll;
    const roundOff = isP ? pRoundOffAll : vRoundOffAll;

    return (
      <div className="mx-auto max-w-[190mm] break-after-page border border-black p-4 text-sm last:break-after-auto">
        <div className="flex items-center gap-3 border-b border-black pb-2">
          {logoUrl && (
            <div className="flex w-[110px] shrink-0 items-center justify-center">
              <img
                src={logoUrl}
                alt=""
                className="max-h-[64px] max-w-[110px] object-contain"
              />
            </div>
          )}
          <div className="min-w-0 flex-1 text-center">
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
              BROKER SLIP — {isP ? "BROKER (RECEIVABLE)" : "OWNER (PAYABLE)"}
              {copies > 1 ? ` (Copy ${copyNo})` : ""}
            </div>
          </div>
          {/* mirrors the logo column so the firm details sit dead centre */}
          {logoUrl && <div className="w-[110px] shrink-0" />}
        </div>

        <SlipDetails side={side} />

        <div className="mt-2 grid grid-cols-2 gap-x-4 gap-y-0.5 text-xs">
          {/* both sides carry the same three lines: who, their transport
              name, their PAN — the owner side used to print the name alone */}
          <div>
            <b>{isP ? "Broker Name" : "Owner Name"}:</b>{" "}
            {isP ? brokerName : ownerName}
          </div>
          <div>
            <b>Transporter:</b>{" "}
            {(isP ? brokerParty : ownerParty)?.transportName ?? ""}
          </div>
          <div>
            <b>PAN:</b> {(isP ? brokerParty : ownerParty)?.pan ?? ""}
          </div>
        </div>

        <div className="mt-3 flex gap-4">
          <table className="w-1/2 border-collapse text-xs">
            <tbody>
              {rows.map(([label, v]) => (
                <tr
                  key={label}
                  className={
                    label.startsWith("Net") || label.startsWith("Chalan")
                      ? "font-semibold"
                      : undefined
                  }
                >
                  <td className="border border-black px-1 py-0.5">{label}</td>
                  <td className="border border-black px-1 py-0.5 text-right">
                    {`${v < 0 ? "(-) " : ""}${formatMoney(Math.abs(v))}`}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>

          <div className="w-1/2">
            <table className="w-full border-collapse text-xs">
              <thead>
                <tr>
                  {["Advance", "Date", "Amount"].map((h) => (
                    <th
                      key={h}
                      className="border border-black px-1 py-0.5 text-left"
                    >
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {sideAdvances.length === 0 && (
                  <tr>
                    <td
                      colSpan={3}
                      className="border border-black px-1 py-1 text-center"
                    >
                      No advances
                    </td>
                  </tr>
                )}
                {sideAdvances.map((a, i) => (
                  <tr key={i}>
                    <td className="border border-black px-1 py-0.5">
                      {[a.bankName, a.remarks].filter(Boolean).join(" — ") ||
                        a.type}
                    </td>
                    <td className="border border-black px-1 py-0.5">
                      {a.date ? formatDate(a.date) : ""}
                    </td>
                    <td className="border border-black px-1 py-0.5 text-right">
                      {formatMoney(a.amount)}
                    </td>
                  </tr>
                ))}
                <tr className="font-semibold">
                  <td colSpan={2} className="border border-black px-1 py-0.5">
                    Total Advance
                  </td>
                  <td className="border border-black px-1 py-0.5 text-right">
                    {formatMoney(advanceTotal)}
                  </td>
                </tr>
                <tr className="font-bold">
                  <td colSpan={2} className="border border-black px-1 py-0.5">
                    {isP ? "Balance Receivable" : "Balance Payable"}
                  </td>
                  <td className="border border-black px-1 py-0.5 text-right">
                    {formatMoney(balance)}
                  </td>
                </tr>
                {/* the balance is settled by cash PLUS whatever was knocked off
                    it — without these two lines the printed figure looks short
                    by the shortage and round-off with no explanation */}
                {shortage > 0 && (
                  <tr>
                    <td colSpan={2} className="border border-black px-1 py-0.5">
                      Less: Shortage
                    </td>
                    <td className="border border-black px-1 py-0.5 text-right">
                      {`(-) ${formatMoney(shortage)}`}
                    </td>
                  </tr>
                )}
                {Math.abs(roundOff) > 0.009 && (
                  <tr>
                    <td colSpan={2} className="border border-black px-1 py-0.5">
                      {roundOff > 0 ? "Less: Round Off" : "Add: Round Off"}
                    </td>
                    <td className="border border-black px-1 py-0.5 text-right">
                      {`${roundOff > 0 ? "(-) " : "(+) "}${formatMoney(Math.abs(roundOff))}`}
                    </td>
                  </tr>
                )}
                {(shortage > 0 || Math.abs(roundOff) > 0.009) && (
                  <tr className="font-semibold">
                    <td colSpan={2} className="border border-black px-1 py-0.5">
                      {isP ? "Net Receivable" : "Net Payable"}
                    </td>
                    <td className="border border-black px-1 py-0.5 text-right">
                      {formatMoney(
                        Math.round((balance - shortage - roundOff) * 100) / 100,
                      )}
                    </td>
                  </tr>
                )}
                <tr>
                  <td colSpan={2} className="border border-black px-1 py-0.5">
                    {isP ? "Amount Received" : "Amount Paid"}
                  </td>
                  <td className="border border-black px-1 py-0.5 text-right">
                    {formatMoney(paid)}
                    {paymentDate ? ` on ${formatDate(paymentDate)}` : ""}
                  </td>
                </tr>
                <tr>
                  <td colSpan={2} className="border border-black px-1 py-0.5">
                    Balance Status
                  </td>
                  <td className="border border-black px-1 py-0.5 text-right font-semibold">
                    {status}
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
        </div>

        <div className="mt-8 flex justify-between text-xs">
          <div>Driver / Owner Signature</div>
          <div>For {firm?.name}</div>
        </div>
      </div>
    );
  };

  // every print run generates BOTH pages (broker + owner) per copy
  return (
    <div className="bg-white p-4 text-black">
      <PrintToolbar copies={copies} />
      <div className="space-y-6">
        {Array.from({ length: copies }, (_, i) => (
          <React.Fragment key={i}>
            <SidePage side="P" copyNo={i + 1} />
            <SidePage side="V" copyNo={i + 1} />
          </React.Fragment>
        ))}
      </div>
    </div>
  );
}
