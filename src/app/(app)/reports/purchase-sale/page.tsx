import { requireSession } from "@/lib/session";
import { authorize } from "@/lib/authz";
import { withTenant } from "@/lib/db";
import { toNum } from "@/lib/utils";
import { FilterBar } from "@/components/data/filter-bar";
import {
  addAmounts,
  splitAmounts,
  ZERO_AMOUNTS,
  type RegisterAmounts,
} from "@/lib/registers/adjustments";
import {
  PurchaseSaleClient,
  type PsRow,
} from "@/components/reports/purchase-sale-client";

export const dynamic = "force-dynamic";

const r2 = (n: number) => Math.round(n * 100) / 100;
const monthKey = (d: Date) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;

/**
 * Purchase & Sale Register — party × month matrix with a TDS column.
 *   SALE     = bills + broker slip PARTY side earnings;
 *              TDS = receipt-voucher TDS + slip party-side TDS
 *   PURCHASE = chalan lorry-hire earnings (Broker/Relative vehicles only —
 *              an own vehicle has no payee) + broker slip OWNER side earnings;
 *              TDS = what we deducted (chalan + slip owner side)
 * Supplier purchases (diesel/tyre on credit) stay out — freight only.
 *
 * MAIN VALUE ≠ ADJUSTMENTS. The month cells and the Main Value column carry the
 * ORIGINAL freight / purchase / sale value alone. Detention, ODC, Fine and
 * Other are reported as Additions, LD Charge and Shortage as Deductions, and
 * only Net Value (= Main + Additions − Deductions) brings them together. A user
 * typing any of those six amounts on a chalan or broker slip therefore cannot
 * move the register's main value — see `@/lib/registers/adjustments`.
 */
export default async function PurchaseSalePage({
  searchParams,
}: {
  searchParams: { side?: string; date_from?: string; date_to?: string; party?: string };
}) {
  const session = requireSession();
  await authorize(session, "reports", "view");

  const side = searchParams.side === "PURCHASE" ? "PURCHASE" : "SALE";
  const dateFrom = searchParams.date_from ? new Date(`${searchParams.date_from}T00:00:00`) : null;
  const dateTo = searchParams.date_to ? new Date(`${searchParams.date_to}T23:59:59`) : null;
  const range = (field: string) =>
    dateFrom || dateTo
      ? {
          [field]: {
            ...(dateFrom ? { gte: dateFrom } : {}),
            ...(dateTo ? { lte: dateTo } : {}),
          },
        }
      : {};

  const { rows, monthKeys, partyOptions } = await withTenant(session.tenantId, async (tx) => {
    const [parties, vehicles] = await Promise.all([
      tx.party.findMany({ select: { id: true, name: true, ledgerGroup: true } }),
      tx.vehicle.findMany({ select: { id: true, ownershipType: true } }),
    ]);
    const partyName = new Map(parties.map((p) => [p.id, p.name]));
    const vehicleOwnership = new Map(vehicles.map((v) => [v.id, v.ownershipType]));

    interface Acc {
      partyId: string;
      /** month -> MAIN value only, never the adjustments */
      months: Record<string, number>;
      totals: RegisterAmounts;
      count: number;
      tds: number;
      docs: { refNo: string; dateIso: string; kind: string; amounts: RegisterAmounts }[];
    }
    const acc = new Map<string, Acc>();
    const bump = (
      partyId: string,
      date: Date,
      amounts: RegisterAmounts,
      kind: string,
      refNo: string,
      tds = 0
    ) => {
      if (searchParams.party && partyId !== searchParams.party) return;
      const a = acc.get(partyId) ?? {
        partyId,
        months: {},
        totals: ZERO_AMOUNTS,
        count: 0,
        tds: 0,
        docs: [],
      };
      // a document counts once it carries a main value OR an adjustment — a
      // freight-less entry that is nothing but charges still belongs here
      if (amounts.main > 0 || amounts.additions > 0 || amounts.deductions > 0) {
        const m = monthKey(date);
        // month buckets hold the MAIN value only
        a.months[m] = r2((a.months[m] ?? 0) + amounts.main);
        a.totals = addAmounts(a.totals, amounts);
        a.count += 1;
        a.docs.push({ refNo, dateIso: date.toISOString(), kind, amounts });
      }
      a.tds = r2(a.tds + tds);
      acc.set(partyId, a);
    };

    if (side === "SALE") {
      const [invoices, slips, receipts] = await Promise.all([
        tx.invoice.findMany({
          where: {
            firmId: session.firmId,
            fyId: session.fyId,
            deletedAt: null,
            kind: { not: "GST" },
            ...range("invoiceDate"),
          },
          select: {
            partyId: true,
            invoiceDate: true,
            invoiceNo: true,
            netTotal: true,
            kind: true,
            charges: { select: { amount: true } },
          },
        }),
        tx.brokerSlip.findMany({
          where: {
            firmId: session.firmId,
            fyId: session.fyId,
            deletedAt: null,
            partyId: { not: null },
            ...range("slipDate"),
          },
        }),
        // TDS the party deducted — receipt vouchers carry it
        tx.voucher.findMany({
          where: {
            firmId: session.firmId,
            fyId: session.fyId,
            deletedAt: null,
            type: "RECEIPT",
            partyId: { not: null },
            tdsAmt: { gt: 0 },
            ...range("voucherDate"),
          },
          select: { partyId: true, tdsAmt: true },
        }),
      ]);
      for (const inv of invoices) {
        // a bill's extra charges (Detention / Waiting / Other ...) are
        // adjustments too, so the bill's main value is its freight alone
        const charges = inv.charges.map((c) => toNum(c.amount));
        const chargeAdditions = r2(charges.filter((c) => c > 0).reduce((s, c) => s + c, 0));
        const chargeDeductions = r2(charges.filter((c) => c < 0).reduce((s, c) => s - c, 0));
        const main = r2(toNum(inv.netTotal) - chargeAdditions + chargeDeductions);
        bump(
          inv.partyId,
          inv.invoiceDate,
          splitAmounts(main, { otherAmt: chargeAdditions, ldCharge: chargeDeductions }),
          inv.kind.replace(/_/g, " "),
          inv.invoiceNo
        );
      }
      for (const s of slips) {
        bump(
          s.partyId!,
          s.slipDate,
          // MAIN = booked freight only; the six entered amounts stay apart
          splitAmounts(toNum(s.pFreight), {
            detention: toNum(s.pDetention),
            odcAmt: toNum(s.pOdcAmt),
            fineAmt: toNum(s.pFineSlip),
            otherAmt: toNum(s.pOtherAmt),
            ldCharge: toNum(s.pLdCharge),
            shortageAmt: toNum(s.pShortageAmt),
          }),
          "BROKER SLIP",
          s.slipNo,
          toNum(s.pTdsAmt)
        );
      }
      for (const v of receipts) bump(v.partyId!, new Date(0), ZERO_AMOUNTS, "", "", toNum(v.tdsAmt));
    } else {
      const [chalans, slips] = await Promise.all([
        tx.chalan.findMany({
          where: {
            firmId: session.firmId,
            fyId: session.fyId,
            deletedAt: null,
            cancelledAt: null,
            isFinal: true,
            ...range("chalanDate"),
          },
          select: {
            brokerId: true,
            vehicleId: true,
            chalanDate: true,
            chalanNo: true,
            // NOT totalChalanAmt — that one already has the adjustments merged
            freight: true,
            detention: true,
            odcAmt: true,
            fineSlip: true,
            otherAmt: true,
            ldCharge: true,
            shortageAmt: true,
            tdsAmt: true,
          },
        }),
        tx.brokerSlip.findMany({
          where: {
            firmId: session.firmId,
            fyId: session.fyId,
            deletedAt: null,
            ownerId: { not: null },
            ...range("slipDate"),
          },
        }),
      ]);
      for (const c of chalans) {
        // an own vehicle's chalan is not a purchase — there is no payee at all
        if (vehicleOwnership.get(c.vehicleId) === "OWNER") continue;
        bump(
          c.brokerId,
          c.chalanDate,
          splitAmounts(toNum(c.freight), {
            detention: toNum(c.detention),
            odcAmt: toNum(c.odcAmt),
            fineAmt: toNum(c.fineSlip),
            otherAmt: toNum(c.otherAmt),
            ldCharge: toNum(c.ldCharge),
            shortageAmt: toNum(c.shortageAmt),
          }),
          "CHALAN",
          c.chalanNo,
          toNum(c.tdsAmt)
        );
      }
      for (const s of slips) {
        if (s.vehicleId && vehicleOwnership.get(s.vehicleId) === "OWNER") continue;
        bump(
          s.ownerId!,
          s.slipDate,
          splitAmounts(toNum(s.vFreight), {
            detention: toNum(s.vDetention),
            odcAmt: toNum(s.vOdcAmt),
            fineAmt: toNum(s.vFineAmt),
            otherAmt: toNum(s.vOtherAmt),
            ldCharge: toNum(s.vLdCharge),
            shortageAmt: toNum(s.vShortageAmt),
          }),
          "BROKER SLIP",
          s.slipNo,
          toNum(s.vTdsAmt)
        );
      }
    }

    const months = new Set<string>();
    Array.from(acc.values()).forEach((a) => Object.keys(a.months).forEach((m) => months.add(m)));
    const monthKeys = Array.from(months).sort();

    const rows: PsRow[] = Array.from(acc.values())
      .filter((a) => a.count > 0 || a.tds > 0)
      .map((a) => ({
        partyId: a.partyId,
        party: partyName.get(a.partyId) ?? "(unknown)",
        months: a.months,
        totals: a.totals,
        count: a.count,
        tds: a.tds,
        docs: a.docs.sort((x, y) => x.dateIso.localeCompare(y.dateIso)),
      }))
      .sort((x, y) => y.totals.main - x.totals.main);

    const groups = side === "SALE" ? ["CONSIGNEE_CONSIGNOR"] : ["OWNER_BROKER", "RELATIVE"];
    const partyOptions = parties
      .filter((p) => groups.includes(p.ledgerGroup))
      .map((p) => ({ value: p.id, label: p.name }));

    return { rows, monthKeys, partyOptions };
  });

  return (
    <div className="space-y-4 p-4">
      <h1 className="text-xl font-semibold">Purchase &amp; Sale Register</h1>
      <p className="text-sm text-muted-foreground">
        {side === "SALE"
          ? "Sale = bills + broker slip party side. TDS = what the party deducted (receipts + slips)."
          : "Purchase = chalan lorry hire (Broker/Relative vehicle) + broker slip owner side. TDS = what you deducted."}{" "}
        Main Value is the original freight only — Detention / ODC / Fine / Other and LD / Shortage
        stay in their own columns and move Net Value alone. Click a Party — all of its documents
        open.
      </p>
      <FilterBar
        filters={[
          {
            type: "select",
            key: "side",
            label: "Side",
            options: [
              { value: "SALE", label: "Sale (receivable)" },
              { value: "PURCHASE", label: "Purchase (payable)" },
            ],
          },
          { type: "daterange", key: "date", label: "Period" },
          { type: "combobox", key: "party", label: "Party", options: partyOptions },
        ]}
      />
      <PurchaseSaleClient
        key={`${side}:${searchParams.date_from ?? ""}:${searchParams.date_to ?? ""}:${searchParams.party ?? ""}`}
        rows={rows}
        monthKeys={monthKeys}
        side={side}
      />
    </div>
  );
}
