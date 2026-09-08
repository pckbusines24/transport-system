import { partyMeta } from "@/lib/party-option";
import { requireSession } from "@/lib/session";
import { withTenant } from "@/lib/db";
import { toNum } from "@/lib/utils";
import { FilterBar, type FilterDef } from "@/components/data/filter-bar";
import { SimpleReport, type ReportRow } from "@/components/accounts/simple-report";

/**
 * TDS RECEIVABLE Register — TDS other parties deduct while PAYING our
 * company. Sources: RECEIPT vouchers, Broker Slip (broker/party side), and
 * JOURNAL vouchers that touch the TDS Receivable ledger. Payment vouchers
 * NEVER appear here. For Income Tax return filing.
 *
 * Journal rows are derived live from the LEDGER entries posted against the
 * common "TDS Receivable" head, so an edited or deleted journal can never
 * leave a stale or duplicate register row. A debit recognises the receivable;
 * a credit reduces it and shows as a negative amount.
 */
export async function TdsReceivableTab({
  searchParams,
}: {
  searchParams: {
    q?: string;
    tds?: string;
    party?: string;
    module?: string;
    date_from?: string;
    date_to?: string;
  };
}) {
  const session = requireSession();

  const dateWhere =
    searchParams.date_from || searchParams.date_to
      ? {
          ...(searchParams.date_from ? { gte: new Date(searchParams.date_from + "T00:00:00") } : {}),
          ...(searchParams.date_to ? { lte: new Date(searchParams.date_to + "T23:59:59") } : {}),
        }
      : undefined;

  const { rows, parties } = await withTenant(session.tenantId, async (tx) => {
    // date filter beats FY (FY continuity)
    const scope = {
      firmId: session.firmId,
      ...(dateWhere ? {} : { fyId: session.fyId }),
      deletedAt: null,
    };
    const [recVouchers, slips, parties] = await Promise.all([
      // RECEIPT vouchers only — payments must never appear in TDS Receivable
      tx.voucher.findMany({
        where: {
          ...scope,
          type: "RECEIPT",
          ...(dateWhere ? { voucherDate: dateWhere } : {}),
          OR: [{ tdsAmt: { gt: 0 } }, { allocations: { some: { tdsAmt: { gt: 0 } } } }],
        },
        include: { allocations: true },
      }),
      tx.brokerSlip.findMany({
        where: { ...scope, pTdsAmt: { gt: 0 }, ...(dateWhere ? { slipDate: dateWhere } : {}) },
      }),
      tx.party.findMany({ select: { id: true, name: true, pan: true, transportName: true, alias: true } }),
    ]);
    const partyById = new Map(parties.map((p) => [p.id, p]));

    // journal vouchers that touched the TDS Receivable ledger head
    const tdsHeads = await tx.accountHead.findMany({
      where: { name: "TDS Receivable" },
      select: { id: true },
    });
    const tdsLedger = tdsHeads.length
      ? await tx.ledgerEntry.findMany({
          where: {
            firmId: session.firmId,
            ...(dateWhere ? { date: dateWhere } : { fyId: session.fyId }),
            refType: "VOUCHER",
            accountHeadId: { in: tdsHeads.map((h) => h.id) },
          },
        })
      : [];
    const journals = tdsLedger.length
      ? await tx.voucher.findMany({
          where: {
            id: { in: Array.from(new Set(tdsLedger.map((e) => e.refId))) },
            type: "JOURNAL",
            deletedAt: null,
          },
        })
      : [];
    const journalById = new Map(journals.map((v) => [v.id, v]));

    const out: ReportRow[] = [];
    for (const e of tdsLedger) {
      const v = journalById.get(e.refId);
      if (!v) continue; // receipt vouchers already have their own rows
      const p =
        (v.partyId && partyById.get(v.partyId)) ||
        (v.bankPartyId && partyById.get(v.bankPartyId)) ||
        undefined;
      // debit = receivable recognised; credit = refunded / adjusted away
      const signedAmt = e.side === "DEBIT" ? toNum(String(e.amount)) : -toNum(String(e.amount));
      out.push({
        date: e.date.toISOString(),
        module: "JOURNAL VOUCHER",
        party: p?.name ?? "",
        pan: p?.pan ?? "",
        refNo: v.voucherNo,
        invoiceAmount: toNum(String(v.amount)),
        tdsPct: 0,
        tdsAmt: signedAmt,
        net: toNum(String(v.netAmount)),
        remarks: e.narration ?? v.remarks ?? "",
      });
    }
    for (const v of recVouchers) {
      const p = v.partyId ? partyById.get(v.partyId) : undefined;
      const allocTds = v.allocations.filter((a) => toNum(String(a.tdsAmt)) > 0);
      if (allocTds.length) {
        for (const a of allocTds) {
          out.push({
            date: v.voucherDate.toISOString(),
            module: "RECEIPT VOUCHER",
            party: p?.name ?? "",
            pan: p?.pan ?? "",
            // for a slip the two are the same number; only a voucher settling
            // a bill has a distinct reference, so name both there
            refNo: a.refNo && a.refNo !== v.voucherNo ? `${a.refNo} (${v.voucherNo})` : v.voucherNo,
            invoiceAmount: toNum(String(a.billAmt)),
            tdsPct: toNum(String(a.tdsPct)),
            tdsAmt: toNum(String(a.tdsAmt)),
            net: toNum(String(a.amount)),
            remarks: a.remarks ?? v.remarks ?? "",
          });
        }
      } else if (toNum(String(v.tdsAmt)) > 0) {
        out.push({
          date: v.voucherDate.toISOString(),
          module: "RECEIPT VOUCHER",
          party: p?.name ?? "",
          pan: p?.pan ?? "",
          refNo: v.voucherNo,
          invoiceAmount: toNum(String(v.amount)),
          tdsPct: 0,
          tdsAmt: toNum(String(v.tdsAmt)),
          net: toNum(String(v.netAmount)),
          remarks: v.remarks ?? "",
        });
      }
    }
    for (const s of slips) {
      const p = s.partyId ? partyById.get(s.partyId) : undefined;
      out.push({
        date: s.slipDate.toISOString(),
        module: "BROKER SLIP (BROKER)",
        party: p?.name ?? "",
        pan: p?.pan ?? "",
        refNo: s.slipNo,
        invoiceAmount: toNum(String(s.pChalanAmt)),
        tdsPct: toNum(String(s.pTdsPct)),
        tdsAmt: toNum(String(s.pTdsAmt)),
        net: toNum(String(s.pNetAmt)),
        remarks: s.pRemarks ?? "",
      });
    }
    return {
      rows: out.sort((a, b) => String(a.date).localeCompare(String(b.date))),
      parties,
    };
  });

  let filtered: ReportRow[] = rows;
  if (searchParams.party) {
    const name = parties.find((p) => p.id === searchParams.party)?.name ?? "";
    filtered = filtered.filter((r) => r.party === name);
  }
  if (searchParams.module) filtered = filtered.filter((r) => r.module === searchParams.module);
  if (searchParams.q) {
    const q = searchParams.q.toLowerCase();
    filtered = filtered.filter((r) => String(r.refNo).toLowerCase().includes(q));
  }
  if (searchParams.tds) {
    filtered = filtered.filter((r) => String(r.tdsPct) === searchParams.tds?.trim());
  }

  const filters: FilterDef[] = [
    { type: "text", key: "q", label: "Reference No..." },
    { type: "text", key: "tds", label: "TDS % (exact)..." },
    { type: "daterange", key: "date", label: "Date" },
    {
      type: "combobox",
      key: "party",
      label: "Party",
      options: parties.map((p) => ({ value: p.id, label: p.name, meta: partyMeta(p) })),
    },
    {
      type: "select",
      key: "module",
      label: "Module",
      options: [
        { value: "RECEIPT VOUCHER", label: "Receipt Voucher" },
        { value: "BROKER SLIP (BROKER)", label: "Broker Slip (Broker)" },
        { value: "JOURNAL VOUCHER", label: "Journal Voucher" },
      ],
    },
  ];

  return (
    <div className="space-y-4">
      <FilterBar filters={filters} />
      <SimpleReport
        title={`${filtered.length} TDS entr${filtered.length === 1 ? "y" : "ies"}`}
        columns={[
          { key: "date", header: "Date", kind: "date" },
          { key: "refNo", header: "Reference No" },
          { key: "module", header: "Module", kind: "badge" },
          { key: "party", header: "Party Name" },
          { key: "pan", header: "PAN" },
          { key: "invoiceAmount", header: "Bill Amount", kind: "money" },
          { key: "tdsPct", header: "TDS %" },
          { key: "tdsAmt", header: "TDS Amount", kind: "money" },
          { key: "remarks", header: "Remarks" },
        ]}
        rows={filtered}
        fileName="tds-receivable-register"
        emptyMessage="No TDS deducted on receipts in this period."
      />
    </div>
  );
}
