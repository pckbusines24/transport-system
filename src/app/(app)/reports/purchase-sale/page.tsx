import { requireSession } from "@/lib/session";
import { authorize } from "@/lib/authz";
import { withTenant } from "@/lib/db";
import { toNum } from "@/lib/utils";
import { FilterBar } from "@/components/data/filter-bar";
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
 *   SALE     = bills (netTotal) + broker slip PARTY side earnings;
 *              TDS = receipt-voucher TDS + slip party-side TDS
 *   PURCHASE = chalan lorry-hire earnings (Broker/Relative vehicles only —
 *              an own vehicle has no payee) + broker slip OWNER side earnings;
 *              TDS = what we deducted (chalan + slip owner side)
 * Supplier purchases (diesel/tyre on credit) stay out — freight only.
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
      months: Record<string, number>;
      total: number;
      count: number;
      tds: number;
      docs: { refNo: string; dateIso: string; kind: string; amount: number }[];
    }
    const acc = new Map<string, Acc>();
    const bump = (
      partyId: string,
      date: Date,
      amount: number,
      kind: string,
      refNo: string,
      tds = 0
    ) => {
      if (searchParams.party && partyId !== searchParams.party) return;
      const a = acc.get(partyId) ?? {
        partyId,
        months: {},
        total: 0,
        count: 0,
        tds: 0,
        docs: [],
      };
      if (amount > 0) {
        const m = monthKey(date);
        a.months[m] = r2((a.months[m] ?? 0) + amount);
        a.total = r2(a.total + amount);
        a.count += 1;
        a.docs.push({ refNo, dateIso: date.toISOString(), kind, amount });
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
          select: { partyId: true, invoiceDate: true, invoiceNo: true, netTotal: true, kind: true },
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
        bump(inv.partyId, inv.invoiceDate, toNum(inv.netTotal), inv.kind.replace(/_/g, " "), inv.invoiceNo);
      }
      for (const s of slips) {
        const gross = r2(
          toNum(s.pFreight) + toNum(s.pDetention) + toNum(s.pOdcAmt) + toNum(s.pFineSlip)
        );
        bump(s.partyId!, s.slipDate, gross, "BROKER SLIP", s.slipNo, toNum(s.pTdsAmt));
      }
      for (const v of receipts) bump(v.partyId!, new Date(0), 0, "", "", toNum(v.tdsAmt));
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
            totalChalanAmt: true,
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
          toNum(c.totalChalanAmt),
          "CHALAN",
          c.chalanNo,
          toNum(c.tdsAmt)
        );
      }
      for (const s of slips) {
        if (s.vehicleId && vehicleOwnership.get(s.vehicleId) === "OWNER") continue;
        const gross = r2(
          toNum(s.vFreight) + toNum(s.vDetention) + toNum(s.vOdcAmt) + toNum(s.vFineAmt)
        );
        bump(s.ownerId!, s.slipDate, gross, "BROKER SLIP", s.slipNo, toNum(s.vTdsAmt));
      }
    }

    const months = new Set<string>();
    Array.from(acc.values()).forEach((a) => Object.keys(a.months).forEach((m) => months.add(m)));
    const monthKeys = Array.from(months).sort();

    const rows: PsRow[] = Array.from(acc.values())
      .filter((a) => a.total > 0 || a.tds > 0)
      .map((a) => ({
        partyId: a.partyId,
        party: partyName.get(a.partyId) ?? "(unknown)",
        months: a.months,
        total: a.total,
        count: a.count,
        tds: a.tds,
        docs: a.docs.sort((x, y) => x.dateIso.localeCompare(y.dateIso)),
      }))
      .sort((x, y) => y.total - x.total);

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
        Click a Party — all of its documents open.
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
