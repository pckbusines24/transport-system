import { requireSession } from "@/lib/session";
import { withTenant } from "@/lib/db";
import { FilterBar, type FilterDef } from "@/components/data/filter-bar";
import { SimpleReport, type ReportRow } from "@/components/accounts/simple-report";
import { buildTdsPayableRows } from "./payable-rows";

/**
 * TDS PAYABLE Register — TDS OUR company deducts while MAKING payments.
 * The row union (chalan owner side, broker-slip owner side, PAYMENT vouchers,
 * TDS Payable journals) lives in `buildTdsPayableRows` and is shared with the
 * quarterly TDS report, so the two can never disagree.
 */
export async function TdsPayableTab({
  searchParams,
}: {
  searchParams: {
    q?: string;
    tds?: string;
    party?: string;
    module?: string;
    section?: string;
    status?: string;
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

  const { rows, parties, sectionCodes } = await withTenant(session.tenantId, (tx) =>
    buildTdsPayableRows(tx, session, dateWhere)
  );

  let filtered: ReportRow[] = rows;
  if (searchParams.party) {
    const name = parties.find((p) => p.id === searchParams.party)?.name ?? "";
    filtered = filtered.filter((r) => r.party === name);
  }
  if (searchParams.module) filtered = filtered.filter((r) => r.module === searchParams.module);
  if (searchParams.section) {
    filtered = filtered.filter((r) =>
      searchParams.section === "NONE" ? !r.section : r.section === searchParams.section
    );
  }
  if (searchParams.q) {
    const q = searchParams.q.toLowerCase();
    filtered = filtered.filter((r) => String(r.refNo).toLowerCase().includes(q));
  }
  if (searchParams.tds) {
    filtered = filtered.filter((r) => String(r.tdsPct) === searchParams.tds?.trim());
  }
  if (searchParams.status) filtered = filtered.filter((r) => r.status === searchParams.status);

  const deductedCount = filtered.filter((r) => r.status === "DEDUCTED").length;
  const tdsTotal = filtered.reduce((s, r) => s + Number(r.tdsAmt ?? 0), 0);

  const filters: FilterDef[] = [
    { type: "text", key: "q", label: "Reference No..." },
    { type: "text", key: "tds", label: "TDS % (exact)..." },
    { type: "daterange", key: "date", label: "Date" },
    {
      type: "combobox",
      key: "party",
      label: "Party",
      options: parties.map((p) => ({ value: p.id, label: p.name })),
    },
    {
      type: "select",
      key: "module",
      label: "Module",
      options: [
        { value: "PAYMENT VOUCHER", label: "Payment Voucher" },
        { value: "CHALLAN (OWNER)", label: "Challan (Owner)" },
        { value: "BROKER SLIP (OWNER)", label: "Broker Slip (Owner)" },
        { value: "JOURNAL VOUCHER", label: "Journal Voucher" },
      ],
    },
    {
      type: "select",
      key: "section",
      label: "TDS Section",
      options: [
        ...sectionCodes.map((c) => ({ value: c, label: c })),
        { value: "NONE", label: "(No Section)" },
      ],
    },
    {
      type: "select",
      key: "status",
      label: "TDS Status",
      options: [
        { value: "DEDUCTED", label: "Deducted" },
        { value: "NOT DEDUCTED", label: "Not Deducted" },
      ],
    },
  ];

  return (
    <div className="space-y-4">
      <FilterBar filters={filters} />
      <SimpleReport
        title={`${filtered.length} transaction${filtered.length === 1 ? "" : "s"} — ${deductedCount} with TDS deducted, ${filtered.length - deductedCount} without — ₹${tdsTotal.toLocaleString("en-IN")} TDS`}
        columns={[
          { key: "date", header: "Date", kind: "date" },
          { key: "refNo", header: "Reference No" },
          { key: "module", header: "Module", kind: "badge" },
          { key: "section", header: "TDS Section" },
          { key: "vehicleNo", header: "Vehicle No" },
          { key: "party", header: "Party / Owner" },
          { key: "pan", header: "PAN" },
          // Bill Amount is the gross the party was paid on; TDS Base is the
          // freight alone. They differ by the settlement adjustments, which are
          // never taxed — showing both is what makes that visible.
          { key: "invoiceAmount", header: "Bill Amount", kind: "money" },
          { key: "baseAmt", header: "TDS Base Amount", kind: "money" },
          { key: "tdsPct", header: "TDS %" },
          { key: "tdsAmt", header: "TDS Amount", kind: "money" },
          { key: "net", header: "Net Payable", kind: "money" },
          { key: "status", header: "TDS Status", kind: "badge" },
          { key: "remarks", header: "Remarks" },
        ]}
        rows={filtered}
        fileName="tds-payable-register"
        emptyMessage="No TDS-eligible payments in this period."
      />
    </div>
  );
}
