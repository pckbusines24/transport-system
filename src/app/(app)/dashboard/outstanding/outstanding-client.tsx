"use client";

import * as React from "react";
import { ChevronDown, ChevronRight } from "lucide-react";
import { formatDate, formatMoney } from "@/lib/utils";
import { waLink } from "@/lib/phone";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { IsoDateInput } from "@/components/data/date-input";
import { InfoHint } from "@/components/ui/info-hint";
import { ExportButton } from "@/components/data/export-button";
import type { OutSide, OutstandingData } from "../outstanding-actions";

export function OutstandingClient({
  side,
  data,
  error,
  fys = [],
  selectedFy = null,
  asOf = null,
}: {
  side: OutSide;
  data: OutstandingData;
  error: string | null;
  /** FY pick = position AS ON that year's 31 March */
  fys?: { id: string; label: string }[];
  selectedFy?: string | null;
  /** custom "as on" date (yyyy-mm-dd) — beats the FY pick */
  asOf?: string | null;
}) {
  const [q, setQ] = React.useState("");
  const [minAmt, setMinAmt] = React.useState("");
  const [only90, setOnly90] = React.useState(false);
  const [open, setOpen] = React.useState<Set<string>>(new Set());

  const recv = side === "RECV";
  const title = recv ? "Receivables — Party-wise Ageing" : "Payables — Party-wise Ageing";

  const rows = data.rows.filter((r) => {
    if (q && !r.party.toLowerCase().includes(q.toLowerCase())) return false;
    if (minAmt && r.total < Number(minAmt)) return false;
    if (only90 && r.b90 <= 0.009) return false;
    return true;
  });
  const t = {
    b0: rows.reduce((s, r) => s + r.b0, 0),
    b31: rows.reduce((s, r) => s + r.b31, 0),
    b61: rows.reduce((s, r) => s + r.b61, 0),
    b90: rows.reduce((s, r) => s + r.b90, 0),
    total: rows.reduce((s, r) => s + r.total, 0),
  };

  const toggle = (key: string) =>
    setOpen((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

  const cell = "border px-2 py-1 text-xs";
  const num = `${cell} text-right tabular-nums`;

  return (
    <div className="space-y-3 p-4">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <h1 className="page-title flex items-center gap-2">
          {title}
          <InfoHint>
            {recv
              ? "Open party bills (same settlement math as the Outstanding report), bucketed by bill age. Click a party for its pending documents."
              : "Open payables — market chalan balances, broker slips and hire slips — bucketed by document age. Click a party for its pending documents."}
          </InfoHint>
        </h1>
        <div className="flex items-center gap-2">
          {/* "As on" — FY pick = that year's 31 March; the date box beats it.
              Everything (documents, payments, buckets) rewinds to the date. */}
          {fys.length > 1 && (
            <select
              aria-label="As-on financial year"
              className="h-8 rounded-md border border-input bg-background px-1.5 text-xs font-medium"
              value={selectedFy ?? ""}
              onChange={(e) => {
                const p = new URLSearchParams({ side });
                if (e.target.value) p.set("fy", e.target.value);
                window.location.href = `/dashboard/outstanding?${p.toString()}`;
              }}
            >
              <option value="">
                {asOf ? `As on ${asOf.split("-").reverse().join("/")}` : "Aaj tak (live)"}
              </option>
              {fys.map((f) => (
                <option key={f.id} value={f.id}>
                  As on 31/03 — FY {f.label}
                </option>
              ))}
            </select>
          )}
          <label className="flex items-center gap-1 text-xs text-muted-foreground">
            As on
            <IsoDateInput
              aria-label="As-on date"
              className="h-8 w-[130px] text-xs"
              value={asOf}
              onChange={(iso) => {
                // the custom date REPLACES an FY pick — one as-on truth at a time
                if (iso === (asOf ?? null)) return;
                const p = new URLSearchParams({ side });
                if (iso) p.set("asof", iso);
                window.location.href = `/dashboard/outstanding?${p.toString()}`;
              }}
            />
          </label>
          <Button asChild size="sm" variant={recv ? "default" : "outline"} className="h-8">
            <a href={`/dashboard/outstanding?side=RECV${selectedFy ? `&fy=${selectedFy}` : ""}${asOf ? `&asof=${asOf}` : ""}`}>Receivable</a>
          </Button>
          <Button asChild size="sm" variant={recv ? "outline" : "default"} className="h-8">
            <a href={`/dashboard/outstanding?side=PAY${selectedFy ? `&fy=${selectedFy}` : ""}${asOf ? `&asof=${asOf}` : ""}`}>Payable</a>
          </Button>
          <ExportButton
            rows={rows}
            fileName={recv ? "receivable-ageing" : "payable-ageing"}
            sheetName="Ageing"
            columns={[
              { header: "Party", key: "party", width: 30 },
              { header: "0-30 Days", key: "b0", numeric: true },
              { header: "31-60 Days", key: "b31", numeric: true },
              { header: "61-90 Days", key: "b61", numeric: true },
              { header: "90+ Days", key: "b90", numeric: true },
              { header: "Total", key: "total", numeric: true },
              { header: "Oldest (Days)", key: "oldestDays", numeric: true },
              { header: "Documents", accessor: (r) => r.docs.length, numeric: true },
            ]}
            summary={[
              { label: "Parties", value: rows.length },
              { label: "Total Outstanding", value: Math.round(t.total * 100) / 100 },
              { label: "90+ Days", value: Math.round(t.b90 * 100) / 100 },
            ]}
          />
        </div>
      </div>

      {error && <p className="text-sm text-destructive">{error}</p>}

      {/* summary chips */}
      <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-5">
        {(
          [
            ["0–30 Days", t.b0, ""],
            ["31–60 Days", t.b31, ""],
            ["61–90 Days", t.b61, ""],
            ["90+ Days", t.b90, "text-red-600"],
            [recv ? "Total Receivable" : "Total Payable", t.total, "text-primary"],
          ] as [string, number, string][]
        ).map(([label, value, cls]) => (
          <div key={label} className="rounded-md border p-3">
            <div className="text-[11px] font-medium uppercase text-muted-foreground">{label}</div>
            <div className={`text-lg font-bold tabular-nums ${cls}`}>{formatMoney(value)}</div>
          </div>
        ))}
      </div>

      {/* filters */}
      <div className="flex flex-wrap items-center gap-2 rounded-md border p-2">
        <Input
          className="h-8 w-[200px] text-xs"
          placeholder="Search party..."
          value={q}
          onChange={(e) => setQ(e.target.value)}
        />
        <Input
          className="h-8 w-[140px] text-xs"
          type="number"
          placeholder="Min amount"
          value={minAmt}
          onChange={(e) => setMinAmt(e.target.value)}
        />
        <label className="flex items-center gap-1.5 text-xs font-medium">
          <input type="checkbox" checked={only90} onChange={(e) => setOnly90(e.target.checked)} />
          90+ days only
        </label>
        <span className="ml-auto text-xs text-muted-foreground">
          {rows.length} of {data.totals.parties} parties
        </span>
      </div>

      <div className="overflow-x-auto rounded-md border">
        <table className="w-full border-collapse text-xs">
          <thead className="bg-muted/60">
            <tr>
              {["Party", "0–30", "31–60", "61–90", "90+", "Total", "Oldest", "Contact"].map((h) => (
                <th key={h} className={`${cell} whitespace-nowrap text-left font-semibold`}>
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => {
              const key = r.partyId ?? r.party;
              const expanded = open.has(key);
              return (
                <React.Fragment key={key}>
                  <tr
                    className="cursor-pointer odd:bg-muted/20 hover:bg-muted/40"
                    onClick={() => toggle(key)}
                  >
                    <td className={`${cell} font-medium`}>
                      <span className="flex items-center gap-1">
                        {expanded ? (
                          <ChevronDown className="h-3 w-3 shrink-0" />
                        ) : (
                          <ChevronRight className="h-3 w-3 shrink-0" />
                        )}
                        {r.party}
                        <span className="text-muted-foreground">({r.docs.length})</span>
                      </span>
                    </td>
                    <td className={num}>{r.b0 > 0 ? formatMoney(r.b0) : "—"}</td>
                    <td className={num}>{r.b31 > 0 ? formatMoney(r.b31) : "—"}</td>
                    <td className={num}>{r.b61 > 0 ? formatMoney(r.b61) : "—"}</td>
                    <td className={`${num} ${r.b90 > 0 ? "font-bold text-red-600" : ""}`}>
                      {r.b90 > 0 ? formatMoney(r.b90) : "—"}
                    </td>
                    <td className={`${num} font-bold`}>{formatMoney(r.total)}</td>
                    <td className={num}>
                      {r.oldestDays > 90 ? (
                        <Badge variant="destructive">{r.oldestDays} days</Badge>
                      ) : (
                        `${r.oldestDays} days`
                      )}
                    </td>
                    <td className={`${cell} whitespace-nowrap`} onClick={(e) => e.stopPropagation()}>
                      {r.mobile ? (
                        <>
                          <a className="text-primary hover:underline" href={`tel:${r.mobile}`}>
                            {r.mobile}
                          </a>{" "}
                          {waLink(r.mobile) && (
                            <a
                              className="text-emerald-600 hover:underline"
                              href={waLink(r.mobile)!}
                              target="_blank"
                              rel="noreferrer"
                            >
                              WA
                            </a>
                          )}
                        </>
                      ) : (
                        "—"
                      )}
                    </td>
                  </tr>
                  {expanded && (
                    <tr>
                      <td colSpan={8} className="border bg-muted/10 px-4 py-2">
                        <table className="w-full border-collapse">
                          <thead>
                            <tr className="text-left text-[10px] uppercase text-muted-foreground">
                              <th className="py-0.5 pr-2">Type</th>
                              <th className="py-0.5 pr-2">Ref No</th>
                              <th className="py-0.5 pr-2">Date</th>
                              <th className="py-0.5 pr-2 text-right">Amount</th>
                              <th className="py-0.5 pr-2 text-right">Settled</th>
                              <th className="py-0.5 pr-2 text-right">Outstanding</th>
                              <th className="py-0.5 text-right">Age</th>
                            </tr>
                          </thead>
                          <tbody>
                            {r.docs.map((d) => (
                              <tr key={`${d.type}-${d.refNo}`} className="border-t text-xs">
                                <td className="py-0.5 pr-2">{d.type}</td>
                                <td className="py-0.5 pr-2 font-medium">{d.refNo}</td>
                                <td className="py-0.5 pr-2 whitespace-nowrap">{formatDate(d.date)}</td>
                                <td className="py-0.5 pr-2 text-right tabular-nums">{formatMoney(d.amount)}</td>
                                <td className="py-0.5 pr-2 text-right tabular-nums">{formatMoney(d.settled)}</td>
                                <td className="py-0.5 pr-2 text-right font-medium tabular-nums">
                                  {formatMoney(d.outstanding)}
                                </td>
                                <td className={`py-0.5 text-right tabular-nums ${d.days > 90 ? "font-bold text-red-600" : ""}`}>
                                  {d.days}d
                                </td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </td>
                    </tr>
                  )}
                </React.Fragment>
              );
            })}
            {rows.length === 0 && (
              <tr>
                <td colSpan={8} className={`${cell} py-6 text-center text-muted-foreground`}>
                  Nothing outstanding for the applied filters.
                </td>
              </tr>
            )}
          </tbody>
          {rows.length > 0 && (
            <tfoot className="bg-muted/60 font-bold">
              <tr>
                <td className={cell}>Total ({rows.length} parties)</td>
                <td className={num}>{formatMoney(t.b0)}</td>
                <td className={num}>{formatMoney(t.b31)}</td>
                <td className={num}>{formatMoney(t.b61)}</td>
                <td className={`${num} text-red-600`}>{formatMoney(t.b90)}</td>
                <td className={num}>{formatMoney(t.total)}</td>
                <td className={cell} colSpan={2} />
              </tr>
            </tfoot>
          )}
        </table>
      </div>
    </div>
  );
}
