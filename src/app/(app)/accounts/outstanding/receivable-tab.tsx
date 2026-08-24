import type { Prisma } from "@prisma/client";
import { requireSession } from "@/lib/session";
import { authorize } from "@/lib/authz";
import { withTenant } from "@/lib/db";
import { toNum } from "@/lib/utils";
import { ALL_RECEIVABLE_REF_TYPES, refPositions, settledByRef } from "@/lib/settlement";
import { FilterBar, type FilterDef } from "@/components/data/filter-bar";
import { SimpleReport } from "@/components/accounts/simple-report";

export const dynamic = "force-dynamic";

const KIND_ROUTE: Record<string, string> = {
  PART_TRUCK: "billing/part-truck",
  FULL_TRUCK: "billing/full-truck",
  MANUAL: "billing/manual",
  GST: "billing/gst",
};

export async function OutstandingReceivableTab({
  searchParams,
}: {
  searchParams: {
    date_from?: string;
    date_to?: string;
    party?: string;
    source?: string;
    show_closed?: string;
  };
}) {
  const session = requireSession();
  await authorize(session, "reports", "view");

  const showClosed = searchParams.show_closed === "1";
  const source = searchParams.source; // INVOICE | BROKER_SLIP | undefined (all)

  const dateWhere =
    searchParams.date_from || searchParams.date_to
      ? {
          ...(searchParams.date_from ? { gte: new Date(searchParams.date_from + "T00:00:00") } : {}),
          ...(searchParams.date_to ? { lte: new Date(searchParams.date_to + "T23:59:59") } : {}),
        }
      : undefined;

  const { rows, parties } = await withTenant(session.tenantId, async (tx) => {
    // no forward leak: documents dated in a LATER FY never appear while
    // standing in an earlier one — bound to this FY's end unless the user's
    // own date filter already set an upper edge
    const sessionFy = await tx.financialYear.findUnique({ where: { id: session.fyId } });
    const effDate = {
      ...(dateWhere ?? {}),
      ...(dateWhere?.lte || !sessionFy ? {} : { lte: sessionFy.endDate }),
    };
    const invoiceWhere: Prisma.InvoiceWhereInput = {
      firmId: session.firmId,
      deletedAt: null,
    };
    if (searchParams.party) invoiceWhere.partyId = searchParams.party;
    invoiceWhere.invoiceDate = effDate;

    const slipWhere: Prisma.BrokerSlipWhereInput = {
      firmId: session.firmId,
      deletedAt: null,
      partyId: searchParams.party ? searchParams.party : { not: null },
    };
    slipWhere.slipDate = effDate;

    const officeWhere: Prisma.OfficeTransactionWhereInput = {
      firmId: session.firmId,
      deletedAt: null,
      txnType: "INCOME",
      // only income booked on credit is receivable — one with a payment mode
      // was already received in cash or bank at entry
      paymentMode: null,
      partyId: searchParams.party ? searchParams.party : { not: null },
    };
    officeWhere.date = effDate;

    const [invoices, slips, office, parties, settled] = await Promise.all([
      source && source !== "INVOICE"
        ? Promise.resolve([])
        : tx.invoice.findMany({ where: invoiceWhere, orderBy: { invoiceDate: "asc" } }),
      source && source !== "BROKER_SLIP"
        ? Promise.resolve([])
        : tx.brokerSlip.findMany({ where: slipWhere, orderBy: { slipDate: "asc" } }),
      source && source !== "OFFICE_INCOME"
        ? Promise.resolve([])
        : tx.officeTransaction.findMany({ where: officeWhere, orderBy: { date: "asc" } }),
      tx.party.findMany({
        where: { ledgerGroup: { in: ["CONSIGNEE_CONSIGNOR", "OWNER_BROKER"] }, isActive: true },
        orderBy: { name: "asc" },
      }),
      // the ONE settlement formula (money + TDS + shortage + other + round-off,
      // live vouchers of this firm + FY) — the same helper every register and
      // voucher grid reads, so a rounding or an adjustment can never linger
      // here as a phantom receivable. BROKER_ENTRY allocations are deliberately
      // NOT counted: a voucher allocated to a broker slip settles its OWNER
      // (payable) side; the party side settles only from the slip's own screen.
      settledByRef(tx, {
        firmId: session.firmId,
        fyId: session.fyId,
        refTypes: ALL_RECEIVABLE_REF_TYPES,
      }),
    ]);
    // dashboard-tile parity: the Receivable tile also counts open advances we
    // PAID (party owes them back) and driver balances the company must
    // recover — this register carries them too, so the two totals agree
    const advances =
      source && source !== "ADVANCE"
        ? []
        : await tx.partyAdvance.findMany({
            where: {
              firmId: session.firmId,
              deletedAt: null,
              kind: "PAID",
              date: effDate,
              ...(searchParams.party ? { partyId: searchParams.party } : {}),
            },
            orderBy: { date: "asc" },
          });
    const advPartyIds = Array.from(new Set(advances.map((a) => a.partyId)));
    const advParties = advPartyIds.length
      ? await tx.party.findMany({
          where: { id: { in: advPartyIds } },
          select: { id: true, name: true },
        })
      : [];
    const driverSetts =
      source && source !== "DRIVER_SETTLEMENT"
        ? []
        : await tx.driverSettlement.findMany({
            where: {
              firmId: session.firmId,
              deletedAt: null,
              amount: { lt: 0 },
              status: "PENDING",
              date: effDate,
            },
            orderBy: { date: "asc" },
          });
    const driverRows = driverSetts.length
      ? await tx.driver.findMany({ select: { id: true, partyId: true, name: true } })
      : [];
    const settPos = await refPositions(tx, {
      firmId: session.firmId,
      fyId: session.fyId,
      refType: "DRIVER_SETTLEMENT",
      docs: driverSetts.map((s) => ({ id: s.id, original: Math.abs(toNum(String(s.amount))) })),
    });
    return { invoices, slips, office, parties, settled, advances, advParties, driverSetts, driverRows, settPos };
  }).then(({ invoices, slips, office, parties, settled, advances, advParties, driverSetts, driverRows, settPos }) => {
    const partyById = new Map(parties.map((p) => [p.id, p.name]));
    const status = (total: number, outstanding: number) =>
      outstanding <= 0.009 ? "PAID" : outstanding < total - 0.009 ? "PARTLY PAID" : "UNPAID";

    const invoiceRows = invoices.map((i) => {
      const net = toNum(String(i.netTotal));
      const received = (settled.get(i.id) ?? 0) + toNum(String(i.advance));
      const outstanding = Math.round((net - received) * 100) / 100;
      return {
        refNo: i.invoiceNo,
        date: i.invoiceDate.toISOString(),
        kind: i.kind,
        party: partyById.get(i.partyId) ?? "",
        netTotal: net,
        received,
        outstanding,
        status: status(net, outstanding),
        link: `${KIND_ROUTE[i.kind] ?? "billing/register"}?id=${i.id}`,
      };
    });

    // broker slip party side: total = pNetAmt; received = advance + the slip's
    // own settlement fields (round-off / shortage written off there count as
    // adjusted). Voucher allocations do NOT contribute — a voucher allocated
    // to a slip settles its owner (payable) side, never this one.
    const slipRows = slips.map((s) => {
      const net = toNum(String(s.pNetAmt));
      const received =
        toNum(String(s.pAdvance)) +
        toNum(String(s.pPaidAmount)) +
        toNum(String(s.pRoundOff)) +
        toNum(String(s.pShortage));
      const outstanding = Math.round((net - received) * 100) / 100;
      return {
        refNo: s.slipNo,
        date: s.slipDate.toISOString(),
        kind: "BROKER_SLIP",
        party: (s.partyId && partyById.get(s.partyId)) || "",
        netTotal: net,
        received,
        outstanding,
        status: status(net, outstanding),
        link: `broker/slip?id=${s.id}`,
      };
    });

    const officeRows = office.map((o) => {
      const net = toNum(String(o.amount));
      const received = settled.get(o.id) ?? 0;
      const outstanding = Math.round((net - received) * 100) / 100;
      return {
        refNo: o.refNo || o.voucherNo,
        date: o.date.toISOString(),
        kind: "OFFICE_INCOME",
        party: (o.partyId && partyById.get(o.partyId)) || "",
        netTotal: net,
        received,
        outstanding,
        status: status(net, outstanding),
        link: `accounts/office?id=${o.id}`,
      };
    });

    const advPartyName = new Map(advParties.map((p) => [p.id, p.name]));
    const advanceRows = advances.map((a) => {
      const net = Math.round(toNum(String(a.amount)) * 100) / 100;
      const received = Math.round(toNum(String(a.consumedAmount)) * 100) / 100;
      const outstanding = Math.round((net - received) * 100) / 100;
      return {
        refNo: a.voucherNo ?? "ADV",
        date: a.date.toISOString(),
        kind: a.source === "CHALAN_CANCEL" ? "CANCEL ADVANCE" : "ADVANCE (PAID)",
        party: advPartyName.get(a.partyId) ?? partyById.get(a.partyId) ?? "",
        netTotal: net,
        received,
        outstanding,
        status: status(net, outstanding),
        link:
          a.source === "CHALAN_CANCEL" ? "chalan/cancel-advances" : "accounts/vouchers?tab=REGISTER",
      };
    });

    const drvById = new Map(driverRows.map((d) => [d.id, d]));
    const driverSettRows = driverSetts
      .filter((s) => !searchParams.party || drvById.get(s.driverId)?.partyId === searchParams.party)
      .map((s) => {
        const p = settPos.get(s.id);
        const net = Math.round(Math.abs(toNum(String(s.amount))) * 100) / 100;
        const received = Math.round((p?.settled ?? 0) * 100) / 100;
        const outstanding = Math.round((p ? p.outstanding : net) * 100) / 100;
        return {
          refNo: s.tripRef || s.voucherNo || "SETTLEMENT",
          date: s.date.toISOString(),
          kind: "DRIVER SETTLEMENT",
          party: drvById.get(s.driverId)?.name ?? "",
          netTotal: net,
          received,
          outstanding,
          status: status(net, outstanding),
          link: "vehicle/driver-settlements",
        };
      });

    return {
      parties,
      rows: [...invoiceRows, ...slipRows, ...officeRows, ...advanceRows, ...driverSettRows]
        .filter((r) => r.netTotal > 0)
        .filter((r) => showClosed || r.outstanding > 0.009)
        .sort((a, b) => a.date.localeCompare(b.date)),
    };
  });

  const filters: FilterDef[] = [
    { type: "daterange", key: "date", label: "Date" },
    {
      type: "combobox",
      key: "party",
      label: "Party / Broker",
      options: parties.map((p) => ({
        value: p.id,
        label: p.ledgerGroup === "OWNER_BROKER" ? `${p.name} (Broker)` : p.name,
      })),
    },
    {
      type: "select",
      key: "source",
      label: "Type",
      options: [
        { value: "INVOICE", label: "Customer Invoices" },
        { value: "BROKER_SLIP", label: "Broker Slips" },
        { value: "OFFICE_INCOME", label: "Office Income" },
        { value: "ADVANCE", label: "Advances (Paid)" },
        { value: "DRIVER_SETTLEMENT", label: "Driver Settlements" },
      ],
    },
    {
      type: "select",
      key: "show_closed",
      label: "Show Closed",
      options: [{ value: "1", label: "Include settled" }],
    },
  ];

  return (
    <div className="space-y-4">
      <FilterBar filters={filters} />
      <SimpleReport
        title={`${rows.length} receivable${rows.length === 1 ? "" : "s"} (invoices + broker slips + office income + advances + driver settlements — same set as the dashboard tile)`}
        columns={[
          { key: "refNo", header: "Ref No", linkBase: "/", linkParamKey: "link" },
          { key: "date", header: "Date", kind: "date" },
          { key: "kind", header: "Type", kind: "badge" },
          { key: "party", header: "Party / Broker" },
          { key: "netTotal", header: "Total Amt", kind: "money" },
          { key: "received", header: "Received / Adj", kind: "money" },
          { key: "outstanding", header: "Outstanding", kind: "money" },
          { key: "status", header: "Status", kind: "badge" },
        ]}
        rows={rows}
        fileName="outstanding"
        emptyMessage="No outstanding receivables — everything is settled."
      />
    </div>
  );
}
