import { notFound } from "next/navigation";
import { requireSession } from "@/lib/session";
import { authorize } from "@/lib/authz";
import { withTenant } from "@/lib/db";
import { formatDate, formatMoney, toNum } from "@/lib/utils";
import { payableSettlement } from "@/lib/settlement";
import { PrintToolbar } from "./print-toolbar";

export const dynamic = "force-dynamic";

export default async function ChalanPrintPage({
  params,
  searchParams,
}: {
  params: { id: string };
  searchParams: { copies?: string };
}) {
  const session = requireSession();
  await authorize(session, "chalan", "print");
  const copies = Math.min(3, Math.max(1, parseInt(searchParams.copies ?? "1", 10) || 1));

  const data = await withTenant(session.tenantId, async (tx) => {
    // firm scoped: another firm's chalan must never print under this session
    const chalan = await tx.chalan.findFirst({
      where: { id: params.id, firmId: session.firmId, deletedAt: null },
      include: {
        lrs: { include: { lr: { include: { items: true } } } },
        advances: true,
      },
    });
    if (!chalan) return null;
    const [firm, broker, vehicle, cities, parties, positions, voucherAllocations] =
      await Promise.all([
        tx.firm.findUnique({ where: { id: chalan.firmId } }),
        tx.party.findUnique({ where: { id: chalan.brokerId } }),
        tx.vehicle.findUnique({ where: { id: chalan.vehicleId } }),
        tx.city.findMany(),
        tx.party.findMany(),
        // the SAME live settlement the register / status drawer / voucher grid
        // read — the print must never fall back to the frozen stored balance
        payableSettlement(tx, {
          firmId: chalan.firmId,
          fyId: chalan.fyId,
          refType: "FREIGHT_CHALLAN",
          docs: [
            {
              id: chalan.id,
              balance: toNum(chalan.balance),
              ownPaid: toNum(chalan.balPaidAmount),
              ownShortage: toNum(chalan.balShortage),
              ownRoundOff: toNum(chalan.balRoundOff),
              ownAdvanceAdjusted: toNum(chalan.balAdvanceAdjusted),
            },
          ],
        }),
        // per-voucher detail so the settlement block can name each payment —
        // ALL years, like the position itself: a later-FY voucher settling
        // this chalan must appear or the rows total less than "Total Settled"
        tx.voucherAllocation.findMany({
          where: {
            refType: "FREIGHT_CHALLAN",
            refId: chalan.id,
            voucher: { deletedAt: null, firmId: chalan.firmId },
          },
          include: {
            voucher: {
              select: { voucherNo: true, voucherDate: true, type: true, bankPartyId: true },
            },
          },
          orderBy: { voucher: { voucherDate: "asc" } },
        }),
      ]);
    return {
      chalan,
      firm,
      broker,
      vehicle,
      cities,
      parties,
      position: positions.get(chalan.id)!,
      voucherAllocations,
    };
  });

  if (!data) notFound();
  const { chalan, firm, broker, vehicle, cities, parties, position, voucherAllocations } = data;
  const cityName = (id: string | null) => (id ? cities.find((c) => c.id === id)?.name ?? "" : "");
  const partyName = (id: string) => parties.find((p) => p.id === id)?.name ?? "";

  // NOTE: booking freight is intentionally NOT rendered anywhere on the print.
  const cancelled = !!chalan.cancelledAt;
  const Copy = ({ n }: { n: number }) => (
    <div className="relative mx-auto max-w-[190mm] break-after-page border border-black p-4 text-sm">
      {/* a cancelled chalan must scream it on paper — watermark + reason band */}
      {cancelled && (
        <>
          <div
            className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center"
            aria-hidden
          >
            <span
              className="rotate-[-28deg] border-8 border-red-600/70 px-10 py-3 text-[64px] font-black tracking-[0.3em] text-red-600/70"
              style={{ WebkitPrintColorAdjust: "exact", printColorAdjust: "exact" }}
            >
              CANCELLED
            </span>
          </div>
          <div
            className="mb-2 border-2 border-red-600 py-1 text-center text-[13px] font-black tracking-widest text-red-600"
            style={{ WebkitPrintColorAdjust: "exact", printColorAdjust: "exact" }}
          >
            CANCELLED{chalan.cancelledAt ? ` on ${formatDate(chalan.cancelledAt)}` : ""}
            {chalan.cancelReason ? ` — ${chalan.cancelReason}` : ""}
          </div>
        </>
      )}
      {/* firm header */}
      <div className="border-b border-black pb-2 text-center">
        <div className="text-xl font-bold uppercase">{firm?.name}</div>
        <div className="text-xs">
          {[firm?.address1, firm?.address2].filter(Boolean).join(", ")}
        </div>
        <div className="text-xs">
          {[
            firm?.mobile && `Mob: ${firm.mobile}`,
            firm?.phone && `Ph: ${firm.phone}`,
            firm?.gstin && `GSTIN: ${firm.gstin}`,
            firm?.pan && `PAN: ${firm.pan}`,
          ]
            .filter(Boolean)
            .join(" | ")}
        </div>
        <div className="mt-1 text-sm font-semibold">
          FREIGHT CHALAN {copies > 1 ? `(Copy ${n})` : ""}
        </div>
      </div>

      {/* chalan details */}
      <div className="mt-2 grid grid-cols-2 gap-x-4 gap-y-0.5 text-xs">
        <div>
          <b>Chalan No:</b> {chalan.chalanNo}
        </div>
        <div>
          <b>Date:</b> {formatDate(chalan.chalanDate)}
        </div>
        <div>
          <b>Broker/Owner:</b> {broker?.name}
        </div>
        <div>
          <b>Transport Name:</b> {chalan.transportName ?? broker?.transportName ?? ""}
        </div>
        <div>
          <b>Owner Name:</b> {chalan.ownerName ?? ""}
        </div>
        <div>
          <b>Vehicle:</b> {vehicle?.number}
        </div>
        <div>
          <b>Driver:</b> {[chalan.driverName, chalan.driverMobile].filter(Boolean).join(" / ")}
        </div>
        <div>
          <b>License No:</b> {chalan.licenseNo ?? ""}
        </div>
        <div>
          <b>Payable At:</b> {chalan.payableAt ?? ""}
        </div>
        <div>
          <b>PAN:</b> {broker?.pan ?? ""}
        </div>
        {toNum(chalan.rate) > 0 && (
          <div>
            <b>Freight Rate:</b> {formatMoney(toNum(chalan.rate))}{" "}
            {(
              {
                CHARGE_WT: "per Charge Wt",
                ACTUAL_WT: "per Actual Wt",
                QTY: "per Qty",
                FIXED: "(fixed)",
              } as Record<string, string>
            )[chalan.rateBasis] ?? ""}
          </div>
        )}
      </div>

      {/* LR list — no booking freight anywhere */}
      <table className="mt-3 w-full border-collapse text-xs">
        <thead>
          <tr>
            {["S.No", "LR No", "Date", "From", "To", "Consignor", "Qty", "Actual Wt", "Charge Wt"].map(
              (h) => (
                <th key={h} className="border border-black px-1 py-0.5 text-left">
                  {h}
                </th>
              )
            )}
          </tr>
        </thead>
        <tbody>
          {chalan.lrs.map(({ lr }, i) => (
            <tr key={lr.id}>
              <td className="border border-black px-1 py-0.5">{i + 1}</td>
              <td className="border border-black px-1 py-0.5">{lr.lrNo}</td>
              <td className="border border-black px-1 py-0.5">{formatDate(lr.lrDate)}</td>
              <td className="border border-black px-1 py-0.5">{cityName(lr.sourceCityId)}</td>
              <td className="border border-black px-1 py-0.5">{cityName(lr.destCityId)}</td>
              <td className="border border-black px-1 py-0.5">{partyName(lr.consignorId)}</td>
              <td className="border border-black px-1 py-0.5 text-right">
                {lr.items.reduce((s, it) => s + toNum(it.qty), 0)}
              </td>
              <td className="border border-black px-1 py-0.5 text-right">
                {lr.items.reduce((s, it) => s + toNum(it.actualWt), 0)}
              </td>
              <td className="border border-black px-1 py-0.5 text-right">
                {lr.items.reduce((s, it) => s + toNum(it.chargeWt), 0)}
              </td>
            </tr>
          ))}
        </tbody>
        <tfoot>
          <tr className="font-semibold">
            <td colSpan={6} className="border border-black px-1 py-0.5">
              Total ({chalan.lrs.length} LRs)
            </td>
            <td className="border border-black px-1 py-0.5 text-right">
              {chalan.lrs.reduce(
                (s, { lr }) => s + lr.items.reduce((a, it) => a + toNum(it.qty), 0),
                0
              )}
            </td>
            {/* totals come from the saved chalan so print always matches the record */}
            <td className="border border-black px-1 py-0.5 text-right">{toNum(chalan.actualWt)}</td>
            <td className="border border-black px-1 py-0.5 text-right">{toNum(chalan.chargeWt)}</td>
          </tr>
        </tfoot>
      </table>

      <div className="mt-3 flex gap-4">
        {/* deductions summary */}
        <table className="w-1/2 border-collapse text-xs">
          <tbody>
            {(
              [
                ["Vehicle Freight", toNum(chalan.freight)],
                ["Detention", toNum(chalan.detention)],
                ["ODC", toNum(chalan.odcAmt)],
                ["Fine Slip", toNum(chalan.fineSlip)],
                ["Other", toNum(chalan.otherAmt)],
                ["Less: LD Charge", -toNum(chalan.ldCharge)],
                ["Less: Shortage", -toNum(chalan.shortageAmt)],
                ["Total Chalan Amount", toNum(chalan.totalChalanAmt)],
                // on paper the commission reads as loading expense; the software keeps "Commission"
                ["Less: Loading Exp", -toNum(chalan.commissionAmt)],
                [`Less: TDS @ ${toNum(chalan.tdsPct)}%`, -toNum(chalan.tdsAmt)],
                ["Less: Mamool", -toNum(chalan.mamool)],
                ["Less: Courier", -toNum(chalan.courierCharge)],
                ["Grand Total", toNum(chalan.grandTotal)],
              ] as [string, number][]
            ).map(([label, v]) => (
              <tr key={label}>
                <td className="border border-black px-1 py-0.5">{label}</td>
                <td className="border border-black px-1 py-0.5 text-right">
                  {formatMoney(Math.abs(v)) === "0.00" && !label.startsWith("Total") && !label.startsWith("Grand")
                    ? "-"
                    : `${v < 0 ? "(-) " : ""}${formatMoney(Math.abs(v))}`}
                </td>
              </tr>
            ))}
          </tbody>
        </table>

        {/* advances */}
        <div className="w-1/2">
          <table className="w-full border-collapse text-xs">
            <thead>
              <tr>
                {["Advance", "Date", "Detail", "Amount"].map((h) => (
                  <th key={h} className="border border-black px-1 py-0.5 text-left">
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {chalan.advances.length === 0 && (
                <tr>
                  <td colSpan={4} className="border border-black px-1 py-1 text-center">
                    No advances
                  </td>
                </tr>
              )}
              {chalan.advances.map((a) => (
                <tr key={a.id}>
                  <td className="border border-black px-1 py-0.5">
                    {a.type === "ADVANCE_ADJ" ? "ADV ADJUSTMENT" : a.type.replace("_", " ")}
                  </td>
                  <td className="border border-black px-1 py-0.5">{formatDate(a.date)}</td>
                  <td className="border border-black px-1 py-0.5">
                    {[
                      a.advanceVoucherNo && `Voucher ${a.advanceVoucherNo}`,
                      a.supplierName,
                      a.bankName,
                      a.remarks,
                    ]
                      .filter(Boolean)
                      .join(" / ")}
                  </td>
                  <td className="border border-black px-1 py-0.5 text-right">
                    {formatMoney(toNum(a.amount))}
                  </td>
                </tr>
              ))}
              <tr className="font-semibold">
                <td colSpan={3} className="border border-black px-1 py-0.5">
                  Total Advance
                </td>
                <td className="border border-black px-1 py-0.5 text-right">
                  {formatMoney(toNum(chalan.advanceTotal))}
                </td>
              </tr>
              <tr>
                <td colSpan={3} className="border border-black px-1 py-0.5">
                  Balance Payable
                </td>
                <td className="border border-black px-1 py-0.5 text-right">
                  {formatMoney(toNum(chalan.balance))}
                </td>
              </tr>
              {position.settled > 0.009 && (
                <tr>
                  <td colSpan={3} className="border border-black px-1 py-0.5">
                    Less: Paid / Adjusted
                  </td>
                  <td className="border border-black px-1 py-0.5 text-right">
                    {formatMoney(position.settled)}
                  </td>
                </tr>
              )}
              {/* always printed, always the LIVE figure — a chalan settled
                  through a payment voucher must read 0.00 here, never the
                  frozen balance */}
              <tr className="font-bold">
                <td colSpan={3} className="border border-black px-1 py-0.5">
                  Balance Due
                </td>
                <td className="border border-black px-1 py-0.5 text-right">
                  {formatMoney(position.outstanding)}
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>

      {/* balance settlement — chalan-screen payment and payment-voucher
          settlements alike, from the one shared calculation */}
      {position.settled > 0.009 && (
        <table className="mt-3 w-full border-collapse text-xs">
          <thead>
            <tr>
              <th colSpan={8} className="border border-black bg-neutral-100 px-1 py-0.5 text-left">
                BALANCE SETTLEMENT —{" "}
                {position.status === "PAID" ? "FULLY PAID / SETTLED" : position.status}
              </th>
            </tr>
            <tr>
              {[
                "Date",
                "Through",
                "Paid From",
                "Paid Amount",
                "Round Off",
                "Shortage",
                "TDS / Other",
                "Advance Adj",
              ].map((h) => (
                <th key={h} className="border border-black px-1 py-0.5 text-left">
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {position.ownSettled > 0.009 && (
              <tr>
                <td className="border border-black px-1 py-0.5">
                  {chalan.balPaymentDate ? formatDate(chalan.balPaymentDate) : ""}
                </td>
                <td className="border border-black px-1 py-0.5">
                  Chalan payment
                  {chalan.balPaymentMode ? ` (${chalan.balPaymentMode.replace("_", "/")})` : ""}
                  {chalan.balRemarks ? ` — ${chalan.balRemarks}` : ""}
                </td>
                <td className="border border-black px-1 py-0.5">
                  {chalan.balPaymentHeadId ? partyName(chalan.balPaymentHeadId) : ""}
                </td>
                <td className="border border-black px-1 py-0.5 text-right">
                  {formatMoney(toNum(chalan.balPaidAmount))}
                </td>
                <td className="border border-black px-1 py-0.5 text-right">
                  {formatMoney(toNum(chalan.balRoundOff))}
                </td>
                <td className="border border-black px-1 py-0.5 text-right">
                  {formatMoney(toNum(chalan.balShortage))}
                </td>
                <td className="border border-black px-1 py-0.5 text-right">-</td>
                <td className="border border-black px-1 py-0.5 text-right">
                  {formatMoney(toNum(chalan.balAdvanceAdjusted))}
                </td>
              </tr>
            )}
            {voucherAllocations.map((a) => (
              <tr key={a.id}>
                <td className="border border-black px-1 py-0.5">
                  {formatDate(a.voucher.voucherDate)}
                </td>
                <td className="border border-black px-1 py-0.5">
                  {a.voucher.type === "JOURNAL" ? "Journal" : "Payment"} voucher{" "}
                  {a.voucher.voucherNo}
                </td>
                <td className="border border-black px-1 py-0.5">
                  {a.voucher.bankPartyId ? partyName(a.voucher.bankPartyId) : ""}
                </td>
                <td className="border border-black px-1 py-0.5 text-right">
                  {formatMoney(toNum(a.amount))}
                </td>
                <td className="border border-black px-1 py-0.5 text-right">
                  {formatMoney(toNum(a.roundOff))}
                </td>
                <td className="border border-black px-1 py-0.5 text-right">
                  {formatMoney(toNum(a.deduction))}
                </td>
                <td className="border border-black px-1 py-0.5 text-right">
                  {formatMoney(toNum(a.tdsAmt) + toNum(a.otherAmt))}
                </td>
                <td className="border border-black px-1 py-0.5 text-right">-</td>
              </tr>
            ))}
            <tr className="font-semibold">
              <td colSpan={3} className="border border-black px-1 py-0.5">
                Total
              </td>
              <td className="border border-black px-1 py-0.5 text-right">
                {formatMoney(toNum(chalan.balPaidAmount) + position.voucherPaid)}
              </td>
              <td className="border border-black px-1 py-0.5 text-right">
                {formatMoney(toNum(chalan.balRoundOff) + position.voucherRoundOff)}
              </td>
              <td className="border border-black px-1 py-0.5 text-right">
                {formatMoney(toNum(chalan.balShortage) + position.voucherShortage)}
              </td>
              <td className="border border-black px-1 py-0.5 text-right">
                {formatMoney(position.voucherTds + position.voucherOther)}
              </td>
              <td className="border border-black px-1 py-0.5 text-right">
                {formatMoney(toNum(chalan.balAdvanceAdjusted))}
              </td>
            </tr>
            <tr className="font-bold">
              <td colSpan={7} className="border border-black px-1 py-0.5">
                Total Settled {formatMoney(position.settled)} of {formatMoney(position.balance)} —
                Balance Due
              </td>
              <td className="border border-black px-1 py-0.5 text-right">
                {formatMoney(position.outstanding)}
              </td>
            </tr>
          </tbody>
        </table>
      )}

      <div className="mt-8 flex justify-between text-xs">
        <div>Driver Signature</div>
        <div>For {firm?.name}</div>
      </div>
    </div>
  );

  return (
    <div className="bg-white p-4 text-black">
      <PrintToolbar copies={copies} />
      <div className="space-y-6">
        {Array.from({ length: copies }, (_, i) => (
          <Copy key={i} n={i + 1} />
        ))}
      </div>
    </div>
  );
}
