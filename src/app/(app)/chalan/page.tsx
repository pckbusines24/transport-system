import { requireSession } from "@/lib/session";
import { authorize } from "@/lib/authz";
import { withTenant } from "@/lib/db";
import { nextChalanNumber } from "@/lib/sequences";
import { roundWt, toNum } from "@/lib/utils";
import { payableSettlement } from "@/lib/settlement";
import { ChalanForm, type ChalanRecord, type BrokerOption } from "./chalan-form";

export const dynamic = "force-dynamic";

export default async function ChalanPage({
  searchParams,
}: {
  searchParams: { id?: string };
}) {
  const session = requireSession();
  await authorize(session, "chalan", "view");

  const [nextNo, brokers, vehicles, banks, accountHeads, record] = await withTenant(
    session.tenantId,
    async (tx) => {
      // sequential like LR numbers: continues from the last saved chalan; editable
      const nextNo = await nextChalanNumber(tx, { firmId: session.firmId, fyId: session.fyId });
      // owners, brokers and relatives share one unified list
      const brokers = await tx.party.findMany({
        where: { ledgerGroup: { in: ["OWNER_BROKER", "RELATIVE"] }, isActive: true },
        orderBy: { name: "asc" },
      });
      const vehicles = await tx.vehicle.findMany({
        where: { isActive: true },
        include: { owner: true },
        orderBy: { number: "asc" },
      });
      const banks = await tx.party.findMany({
        where: { ledgerGroup: { in: ["BANK", "CASH", "CARD"] }, isActive: true },
        orderBy: { name: "asc" },
      });
      const accountHeads = await tx.accountHead.findMany({ orderBy: { name: "asc" } });
      const record = searchParams.id
        ? await tx.chalan.findFirst({
            // no FY filter: an old-year chalan opened from Outstanding or a
            // reference search must load for balance payment in the new year
            where: {
              id: searchParams.id,
              firmId: session.firmId,
              deletedAt: null,
            },
            include: {
              lrs: { include: { lr: { include: { items: true, pods: true } } } },
              advances: true,
            },
          })
        : null;
      // advance vouchers consumed by the balance-payment step, for the grid
      const balAdvanceUses = record
        ? await tx.partyAdvanceUse.findMany({
            where: { refId: record.id, refType: "CHALAN_BALANCE_ADJ" },
          })
        : [];
      // a Payment Voucher can settle this chalan too — the balance section must
      // offer only what is still open across both modules
      const balPos = record
        ? (
            await payableSettlement(tx, {
              firmId: session.firmId,
              fyId: session.fyId,
              refType: "FREIGHT_CHALLAN",
              docs: [
                {
                  id: record.id,
                  balance: toNum(record.balance),
                  ownPaid: 0,
                  ownShortage: 0,
                  ownRoundOff: 0,
                },
              ],
            })
          ).get(record.id)
        : undefined;
      const voucherSettled = balPos?.voucherSettled ?? 0;
      const cities = record ? await tx.city.findMany() : [];
      const parties = record ? await tx.party.findMany() : [];
      const cityName = (id: string) => cities.find((c) => c.id === id)?.name ?? "";
      const partyName = (id: string) => parties.find((p) => p.id === id)?.name ?? "";

      const rec: ChalanRecord | null = record
        ? {
            id: record.id,
            chalanNo: record.chalanNo,
            chalanDate: record.chalanDate.toISOString(),
            brokerId: record.brokerId,
            vehicleId: record.vehicleId,
            driverName: record.driverName ?? "",
            driverMobile: record.driverMobile ?? "",
            licenseNo: record.licenseNo ?? "",
            payableAt: record.payableAt ?? "",
            transportName: record.transportName ?? "",
            ownerName: record.ownerName ?? "",
            remarks: record.remarks ?? "",
            isFinal: record.isFinal,
            paymentStatus: record.paymentStatus,
            balRoundOff: toNum(record.balRoundOff),
            balShortage: toNum(record.balShortage),
            balPaidAmount: toNum(record.balPaidAmount),
            balPaymentDate: record.balPaymentDate ? record.balPaymentDate.toISOString() : null,
            balPaymentHeadId: record.balPaymentHeadId,
            balPaymentMode: record.balPaymentMode ?? "BANK",
            balRemarks: record.balRemarks ?? "",
            voucherSettled,
            // combined saved settlement (chalan-side legacy + settlement
            // voucher) — display only, never prefills the payment inputs
            settledPaid: toNum(record.balPaidAmount) + (balPos?.voucherPaid ?? 0),
            settledShortage: toNum(record.balShortage) + (balPos?.voucherShortage ?? 0),
            settledRoundOff: toNum(record.balRoundOff) + (balPos?.voucherRoundOff ?? 0),
            settledAdvanceAdj: toNum(record.balAdvanceAdjusted),
            balAdvanceLines: balAdvanceUses.map((u) => ({
              advanceId: u.advanceId,
              amount: toNum(u.amount),
            })),
            podTotal: record.lrs.filter(
              (l) => l.lr.lrType !== "CANCELLED" && l.lr.lrType !== "PAPER_CHANGE"
            ).length,
            podDone: record.lrs.filter(
              (l) =>
                l.lr.lrType !== "CANCELLED" &&
                l.lr.lrType !== "PAPER_CHANGE" &&
                l.lr.pods.length > 0
            ).length,
            podShortageWt: roundWt(
              record.lrs.flatMap((l) => l.lr.pods).reduce((s, p) => s + toNum(p.shortageWt), 0)
            ),
            freight: toNum(record.freight),
            rate: toNum(record.rate),
            rateBasis: record.rateBasis,
            detention: toNum(record.detention),
            odcAmt: toNum(record.odcAmt),
            fineSlip: toNum(record.fineSlip),
            ldCharge: toNum(record.ldCharge),
            shortageAmt: toNum(record.shortageAmt),
            otherAmt: toNum(record.otherAmt),
            otherRemarks: record.otherRemarks ?? "",
            commissionPct: toNum(record.commissionPct),
            commissionAmt: toNum(record.commissionAmt),
            mamool: toNum(record.mamool),
            courierCharge: toNum(record.courierCharge),
            tdsPct: toNum(record.tdsPct),
            startKm: record.startKm == null ? null : toNum(record.startKm),
            unloadDate: record.unloadDate ? record.unloadDate.toISOString() : null,
            unloadKm: record.unloadKm == null ? null : toNum(record.unloadKm),
            unloadRemarks: record.unloadRemarks ?? "",
            lrs: record.lrs.map(({ lr }) => ({
              id: lr.id,
              lrNo: lr.lrNo,
              lrDate: lr.lrDate.toISOString(),
              source: cityName(lr.sourceCityId),
              destination: cityName(lr.destCityId),
              consignor: partyName(lr.consignorId),
              qty: lr.items.reduce((s, i) => s + toNum(i.qty), 0),
              actualWt: lr.items.reduce((s, i) => s + toNum(i.actualWt), 0),
              chargeWt: lr.items.reduce((s, i) => s + toNum(i.chargeWt), 0),
              freight: toNum(lr.freight),
              rate: lr.items.length ? Math.max(...lr.items.map((i) => toNum(i.rate))) : 0,
              rateBasis: (lr.items.find((i) => toNum(i.rate) > 0)?.rateBasis ?? "CHARGE_WT") as
                | "QTY"
                | "ACTUAL_WT"
                | "CHARGE_WT"
                | "FIXED",
              remarks: lr.remarks ?? "",
            })),
            advances: record.advances.map((a) => ({
              type: a.type,
              supplierName: a.supplierName ?? "",
              bankName: a.bankName ?? "",
              bankPartyId: a.bankPartyId,
              headId: a.headId,
              advanceId: a.advanceId,
              advanceVoucherNo: a.advanceVoucherNo,
              // the stored head/bank reference decides how the row reloads, so
              // a CASH row no longer comes back mislabelled as a head advance
              advanceType:
                a.type === "ADVANCE_ADJ"
                  ? ("ADV_ADJ" as const)
                  : a.headId
                    ? ("HEAD" as const)
                    : ("BANK_CASH" as const),
              dieselQty: a.dieselQty == null ? 0 : toNum(a.dieselQty),
              dieselRate: a.dieselRate == null ? 0 : toNum(a.dieselRate),
              amount: toNum(a.amount),
              date: a.date ? a.date.toISOString() : null,
              remarks: a.remarks ?? "",
            })),
          }
        : null;

      return [nextNo, brokers, vehicles, banks, accountHeads, rec] as const;
    }
  );

  const brokerOptions: BrokerOption[] = brokers.map((b) => ({
    value: b.id,
    label: b.name,
    meta: [b.alias, b.gstin, b.pan].filter(Boolean).join(" · ") || undefined,
    pan: b.pan,
    tdsMode: b.tdsMode,
    transportName: b.transportName,
    ownerName: b.ownerName,
  }));

  return (
    <ChalanForm
      nextChalanNo={nextNo ?? "1"}
      brokers={brokerOptions}
      vehicles={vehicles.map((v) => ({
        value: v.id,
        label: v.number,
        meta: v.isOwn ? `Owned${v.ownerNames ? " — " + v.ownerNames : ""}` : `Broker — ${v.owner?.name ?? "?"}`,
      }))}
      banks={banks.map((b) => ({ value: b.id, label: b.name, meta: b.ledgerGroup }))}
      accountHeads={accountHeads.map((h) => ({ value: h.id, label: h.name, meta: h.kind }))}
      record={record}
    />
  );
}
