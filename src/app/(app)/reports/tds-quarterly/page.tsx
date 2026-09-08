import { partyMeta } from "@/lib/party-option";
import { requireSession } from "@/lib/session";
import { authorize } from "@/lib/authz";
import { withTenant } from "@/lib/db";
import { buildTdsPayableRows } from "@/app/(app)/accounts/tds/payable-rows";
import { FilterBar, type FilterDef } from "@/components/data/filter-bar";
import { InfoHint } from "@/components/ui/info-hint";
import {
  buildQuarterlyData,
  DIRECT_LABEL,
  DIRECT_RATE_FILTER,
  QUARTERS,
  QUARTER_MONTHS,
} from "./data";
import { TdsQuarterlyClient } from "./quarterly-client";

export const dynamic = "force-dynamic";

/**
 * TDS Report – Quarterly Wise. PAYABLE TDS ONLY — the rows come from the same
 * `buildTdsPayableRows` union the TDS Payable Register reads (chalan owner
 * side, broker-slip owner side, PAYMENT vouchers, TDS Payable journals), so
 * receivable/customer-side TDS can never leak in and the two reports can
 * never disagree. Grouping: Party → TDS Rate → Q1/Q2/Q3/Q4, each cell a
 * recorded TDS Base Amount + TDS Amount.
 */
export default async function TdsQuarterlyPage({
  searchParams,
}: {
  searchParams: {
    party?: string;
    rate?: string;
    quarter?: string;
    date_from?: string;
    date_to?: string;
  };
}) {
  const session = requireSession();
  await authorize(session, "reports", "view");

  const dateWhere =
    searchParams.date_from || searchParams.date_to
      ? {
          ...(searchParams.date_from ? { gte: new Date(searchParams.date_from + "T00:00:00") } : {}),
          ...(searchParams.date_to ? { lte: new Date(searchParams.date_to + "T23:59:59") } : {}),
        }
      : undefined;

  const { rows, parties } = await withTenant(session.tenantId, (tx) =>
    buildTdsPayableRows(tx, session, dateWhere)
  );

  // the filter bar's combobox already carries party IDS — pass the id
  // straight through so the grouping filters on the stable link, never a name
  const data = buildQuarterlyData(rows, {
    partyId: searchParams.party,
    rate: searchParams.rate,
    quarter: searchParams.quarter,
  });

  // 0 / 1 / 2 are always offered; any other recorded rate joins the list
  const rateValues = Array.from(new Set([0, 1, 2, ...data.rateOptions])).sort((a, b) => a - b);

  const filters: FilterDef[] = [
    { type: "daterange", key: "date", label: "Date" },
    {
      type: "combobox",
      key: "party",
      label: "Party",
      options: parties.map((p) => ({ value: p.id, label: p.name, meta: partyMeta(p) })),
    },
    {
      type: "select",
      key: "rate",
      label: "TDS Rate",
      options: [
        ...rateValues.map((r) => ({ value: String(r), label: `${r}%` })),
        { value: DIRECT_RATE_FILTER, label: DIRECT_LABEL },
      ],
    },
    {
      type: "select",
      key: "quarter",
      label: "Quarter",
      options: QUARTERS.map((q, i) => ({ value: q, label: `${q} (${QUARTER_MONTHS[i]})` })),
    },
  ];

  const printParams = new URLSearchParams();
  for (const [k, v] of Object.entries(searchParams)) if (v) printParams.set(k, v);
  const printQs = printParams.toString();

  return (
    <div className="space-y-4 p-4">
      <div className="flex flex-wrap items-center gap-2">
        <h1 className="page-title">TDS Report – Quarterly Wise</h1>
        <InfoHint>
          Payable TDS only — TDS our company deducted while making payments (chalan owner side,
          broker slip owner side, payment vouchers, TDS Payable journals). Customer-side /
          receivable TDS never appears here. Chalan and broker-slip rows carry their recorded rate
          and base amount; voucher/journal TDS shows as one &quot;Voucher / Direct&quot; row per
          party with the TDS amount only. Q1 Apr–Jun, Q2 Jul–Sep, Q3 Oct–Dec, Q4 Jan–Mar. Click a
          quarter figure to see the transactions behind it.
        </InfoHint>
        <span className="ml-auto text-sm text-muted-foreground">
          Financial Year: {session.fyLabel ?? ""}
        </span>
      </div>
      <FilterBar filters={filters} />
      <TdsQuarterlyClient
        data={data}
        fyLabel={session.fyLabel ?? ""}
        printHref={`/print/tds-quarterly${printQs ? `?${printQs}` : ""}`}
      />
    </div>
  );
}
