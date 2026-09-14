"use client";

import * as React from "react";
import { formatDate, formatMoney } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { IsoDateInput } from "@/components/data/date-input";
import { InfoHint } from "@/components/ui/info-hint";
import { ExportButton } from "@/components/data/export-button";
import { MasterCombobox, type MasterOption } from "@/components/data/master-combobox";
import { LR_VIEW_META, type LrView } from "../lr-views";
import { getLrDetail, type LrDetailFilters, type LrDetailRow } from "../lr-actions";

interface Option {
  id: string;
  name: string;
  /** extra searchable text (owner / transport name) shown beside the name */
  meta?: string;
}

const toOptions = (opts: Option[]): MasterOption[] =>
  opts.map((o) => ({ value: o.id, label: o.name, meta: o.meta }));

const POD_OPTIONS: MasterOption[] = [
  { value: "RECEIVED", label: "Received" },
  { value: "PENDING", label: "Pending" },
];
const BILL_OPTIONS: MasterOption[] = [
  { value: "BILLED", label: "Billed" },
  { value: "PENDING", label: "Pending" },
];
const STATUS_OPTIONS: MasterOption[] = [
  { value: "PENDING", label: "PENDING" },
  { value: "ON_CHALAN", label: "ON_CHALAN" },
  { value: "ARRIVED", label: "ARRIVED" },
  { value: "DELIVERED", label: "DELIVERED" },
  { value: "BILLED", label: "BILLED" },
];

const EMPTY: LrDetailFilters = {};

export function LrDetailClient({
  view,
  parties,
  cities,
  vehicles,
}: {
  view: LrView;
  parties: Option[];
  cities: Option[];
  vehicles: Option[];
}) {
  const meta = LR_VIEW_META[view];
  const [filters, setFilters] = React.useState<LrDetailFilters>(EMPTY);
  const [rows, setRows] = React.useState<LrDetailRow[]>([]);
  const [totals, setTotals] = React.useState({
    totalCount: 0,
    totalAmount: 0,
    filteredCount: 0,
    filteredAmount: 0,
    truncated: false,
  });
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);

  // debounce text inputs a touch; selects/dates apply instantly
  React.useEffect(() => {
    let alive = true;
    setLoading(true);
    const t = window.setTimeout(() => {
      getLrDetail({ view, filters }).then((res) => {
        if (!alive) return;
        setLoading(false);
        if (res.ok) {
          setRows(res.rows);
          setTotals({
            totalCount: res.totalCount,
            totalAmount: res.totalAmount,
            filteredCount: res.filteredCount,
            filteredAmount: res.filteredAmount,
            truncated: res.truncated,
          });
          setError(null);
        } else {
          setError(res.error);
        }
      });
    }, 300);
    return () => {
      alive = false;
      window.clearTimeout(t);
    };
  }, [view, filters]);

  const set = (patch: Partial<LrDetailFilters>) => setFilters((f) => ({ ...f, ...patch }));
  const sel = (v: string | undefined) => (v ? v : undefined);

  const partyOptions = React.useMemo(() => toOptions(parties), [parties]);
  const cityOptions = React.useMemo(() => toOptions(cities), [cities]);
  const vehicleOptions = React.useMemo(() => toOptions(vehicles), [vehicles]);
  const cell = "border px-2 py-1 text-xs";

  const chips = [
    { label: "Total Records", value: String(totals.totalCount) },
    { label: "Total Freight", value: formatMoney(totals.totalAmount) },
    { label: "Filtered Records", value: String(totals.filteredCount) },
    { label: "Filtered Amount", value: formatMoney(totals.filteredAmount) },
  ];

  return (
    <div className="space-y-3 p-4">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <h1 className="page-title flex items-center gap-2">
          {meta.title}
          <InfoHint>{meta.info}</InfoHint>
        </h1>
        <ExportButton
          rows={rows}
          fileName={`lr-${view.toLowerCase()}`}
          sheetName="LRs"
          columns={[
            { header: "LR No", key: "lrNo" },
            { header: "LR Date", accessor: (r) => formatDate(r.lrDate) },
            { header: "Party", key: "party", width: 24 },
            { header: "Consignor", key: "consignor", width: 24 },
            { header: "Consignee", key: "consignee", width: 24 },
            { header: "From", key: "from" },
            { header: "To", key: "to" },
            { header: "Vehicle", key: "vehicle" },
            { header: "OBD No", key: "obdNo" },
            { header: "Freight", key: "freight", numeric: true },
            { header: "Chalan No", key: "chalanNo" },
            { header: "Bill No", key: "billNo" },
            { header: "POD Status", key: "podStatus" },
            { header: "Bill Status", key: "billStatus" },
            { header: "Status", key: "status" },
          ]}
          summary={[
            { label: "Filtered Records", value: totals.filteredCount },
            { label: "Filtered Amount", value: totals.filteredAmount },
          ]}
        />
      </div>

      {/* summary — always mirrors the filtered grid */}
      <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
        {chips.map((c) => (
          <div key={c.label} className={`rounded-md border p-3 ${loading ? "opacity-60" : ""}`}>
            <div className="text-[11px] font-medium uppercase text-muted-foreground">{c.label}</div>
            <div className="text-lg font-bold tabular-nums">{c.value}</div>
          </div>
        ))}
      </div>

      {/* filters */}
      <div className="flex flex-wrap items-end gap-2 rounded-md border p-2">
        <label className="flex flex-col gap-0.5 text-[10px] font-medium uppercase text-muted-foreground">
          From Date
          <IsoDateInput
            className="h-8 w-[130px] text-xs"
            value={filters.from}
            onChange={(iso) => set({ from: sel(iso ?? undefined) })}
          />
        </label>
        <label className="flex flex-col gap-0.5 text-[10px] font-medium uppercase text-muted-foreground">
          To Date
          <IsoDateInput
            className="h-8 w-[130px] text-xs"
            value={filters.to}
            onChange={(iso) => set({ to: sel(iso ?? undefined) })}
          />
        </label>
        {(
          [
            ["Party", "partyId", partyOptions],
            ["Consignor", "consignorId", partyOptions],
            ["Consignee", "consigneeId", partyOptions],
            ["Vehicle No", "vehicleId", vehicleOptions],
            ["Booking Station", "sourceCityId", cityOptions],
            ["Delivery Station", "destCityId", cityOptions],
            ["POD Status", "podStatus", POD_OPTIONS],
            ["Bill Status", "billStatus", BILL_OPTIONS],
            ["Final Status", "status", STATUS_OPTIONS],
          ] as [string, keyof LrDetailFilters, MasterOption[]][]
        ).map(([label, key, opts]) => (
          <label
            key={key}
            className="flex flex-col gap-0.5 text-[10px] font-medium uppercase text-muted-foreground"
          >
            {label}
            <MasterCombobox
              className="w-[170px] [&_input]:h-8 [&_input]:text-xs"
              options={opts}
              value={(filters[key] as string) ?? null}
              onChange={(v) => set({ [key]: sel(v ?? undefined) } as Partial<LrDetailFilters>)}
              placeholder="All"
            />
          </label>
        ))}
        <label className="flex flex-col gap-0.5 text-[10px] font-medium uppercase text-muted-foreground">
          LR No
          <Input
            className="h-8 w-[110px] text-xs"
            value={filters.lrNo ?? ""}
            onChange={(e) => set({ lrNo: sel(e.target.value) })}
            placeholder="search"
          />
        </label>
        <label className="flex flex-col gap-0.5 text-[10px] font-medium uppercase text-muted-foreground">
          OBD No
          <Input
            className="h-8 w-[110px] text-xs"
            value={filters.obd ?? ""}
            onChange={(e) => set({ obd: sel(e.target.value) })}
            placeholder="search"
          />
        </label>
        <label className="flex flex-col gap-0.5 text-[10px] font-medium uppercase text-muted-foreground">
          Bill No
          <Input
            className="h-8 w-[110px] text-xs"
            value={filters.billNo ?? ""}
            onChange={(e) => set({ billNo: sel(e.target.value) })}
            placeholder="search"
          />
        </label>
        <Button size="sm" variant="outline" className="h-8" onClick={() => setFilters(EMPTY)}>
          Clear
        </Button>
      </div>

      {error && <p className="text-sm text-destructive">{error}</p>}
      {totals.truncated && (
        <p className="text-xs text-muted-foreground">
          Showing the first 500 rows — apply filters to narrow the list (totals cover the full
          filtered data).
        </p>
      )}

      <div className="overflow-x-auto rounded-md border">
        <table className="w-full border-collapse text-xs">
          <thead className="bg-muted/60">
            <tr>
              {[
                "LR No",
                "LR Date",
                "Party",
                "Consignor",
                "Consignee",
                "From",
                "To",
                "Vehicle",
                "OBD No",
                "Freight",
                "Chalan No",
                "Bill No",
                "POD",
                "Bill",
                "Status",
              ].map((h) => (
                <th key={h} className={`${cell} whitespace-nowrap text-left font-semibold`}>
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody className={loading ? "opacity-60" : ""}>
            {rows.map((r) => (
              <tr key={r.id} className="odd:bg-muted/20">
                <td className={`${cell} font-medium`}>{r.lrNo}</td>
                <td className={`${cell} whitespace-nowrap`}>{formatDate(r.lrDate)}</td>
                <td className={cell}>{r.party}</td>
                <td className={cell}>{r.consignor}</td>
                <td className={cell}>{r.consignee}</td>
                <td className={cell}>{r.from}</td>
                <td className={cell}>{r.to}</td>
                <td className={`${cell} whitespace-nowrap`}>{r.vehicle}</td>
                <td className={cell}>{r.obdNo}</td>
                <td className={`${cell} text-right tabular-nums`}>{formatMoney(r.freight)}</td>
                <td className={cell}>{r.chalanNo}</td>
                <td className={cell}>{r.billNo}</td>
                <td className={cell}>
                  <Badge variant={r.podStatus === "RECEIVED" ? "default" : "secondary"}>
                    {r.podStatus === "RECEIVED" ? "Received" : "Pending"}
                  </Badge>
                </td>
                <td className={cell}>
                  <Badge variant={r.billStatus === "BILLED" ? "default" : "secondary"}>
                    {r.billStatus === "BILLED" ? "Billed" : "Pending"}
                  </Badge>
                </td>
                <td className={cell}>{r.status}</td>
              </tr>
            ))}
            {!loading && rows.length === 0 && (
              <tr>
                <td colSpan={15} className={`${cell} py-6 text-center text-muted-foreground`}>
                  No LRs match the applied filters.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
