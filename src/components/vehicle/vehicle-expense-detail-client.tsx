"use client";

import * as React from "react";
import { ChevronRight } from "lucide-react";
import { formatDate, formatMoney } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import { ExportButton } from "@/components/data/export-button";
import { FilterBar } from "@/components/data/filter-bar";
import type { MasterOption } from "@/components/data/master-combobox";

export interface HeadDetail {
  name: string;
  amount: number;
  entries: {
    date: string;
    voucherNo: string;
    supplier: string;
    qty: number | null;
    amount: number;
    remarks: string;
  }[];
  /** "YYYY-MM" -> amount, for the month chips */
  months: Record<string, number>;
}

export interface VehicleExpenseDetailRow {
  id: string;
  vehicle: string;
  ownership: string;
  ownershipType: string;
  /** expense total */
  total: number;
  /** INCOME vouchers allocated to the vehicle (scrap sale, rent, ...) */
  income: number;
  incomeEntries: HeadDetail["entries"];
  /** total − income */
  net: number;
  heads: HeadDetail[];
}

const MONTH_SHORT = ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"];
const monthLabel = (m: string) => `${MONTH_SHORT[Number(m.slice(5)) - 1] ?? m} ${m.slice(2, 4)}`;

function lakh(n: number): string {
  const abs = Math.abs(n);
  if (abs >= 10000000) return `₹${(abs / 10000000).toFixed(2)}Cr`;
  if (abs >= 100000) return `₹${(abs / 100000).toFixed(2)}L`;
  if (abs >= 1000) return `₹${(abs / 1000).toFixed(1)}k`;
  return `₹${Math.round(abs)}`;
}

// validated categorical palette (light/dark pairs); heads beyond six share grey
const HEAD_BG = [
  "bg-[#2a78d6] dark:bg-[#3987e5]",
  "bg-[#eb6834] dark:bg-[#d95926]",
  "bg-[#1baf7a] dark:bg-[#199e70]",
  "bg-[#eda100] dark:bg-[#c98500]",
  "bg-[#e87ba4] dark:bg-[#d55181]",
  "bg-[#4a3aa7] dark:bg-[#9085e9]",
];
const OTHER_BG = "bg-neutral-400 dark:bg-neutral-500";

export function VehicleExpenseDetailClient({
  rows,
  vehicleOptions,
}: {
  rows: VehicleExpenseDetailRow[];
  vehicleOptions: MasterOption[];
}) {
  const [openVehicles, setOpenVehicles] = React.useState<Set<string>>(
    () => new Set(rows.length === 1 ? [rows[0].id] : [])
  );
  const [openHeads, setOpenHeads] = React.useState<Set<string>>(new Set());
  const toggle = (set: Set<string>, key: string) => {
    const next = new Set(set);
    if (next.has(key)) next.delete(key);
    else next.add(key);
    return next;
  };

  // overall totals + fixed color per head (by overall size, so a head keeps
  // its color in every vehicle block)
  const t = React.useMemo(() => {
    const headTotals = new Map<string, number>();
    const monthly = new Map<string, number>();
    const byType = new Map<string, { vehicles: number; net: number }>();
    let entries = 0;
    for (const r of rows) {
      for (const h of r.heads) {
        headTotals.set(h.name, (headTotals.get(h.name) ?? 0) + h.amount);
        entries += h.entries.length;
        for (const [m, amt] of Object.entries(h.months))
          monthly.set(m, (monthly.get(m) ?? 0) + amt);
      }
      entries += r.incomeEntries.length;
      const ty = byType.get(r.ownership) ?? { vehicles: 0, net: 0 };
      ty.vehicles += 1;
      ty.net += r.net;
      byType.set(r.ownership, ty);
    }
    const sorted = Array.from(headTotals.entries()).sort(([, a], [, b]) => b - a);
    const colorOf = new Map<string, string>();
    sorted.forEach(([name], i) => colorOf.set(name, HEAD_BG[i] ?? OTHER_BG));
    const total = rows.reduce((s, r) => s + r.total, 0);
    const income = rows.reduce((s, r) => s + r.income, 0);
    const months = Array.from(monthly.entries())
      .sort(([a], [b]) => a.localeCompare(b))
      .slice(-12)
      .map(([month, amt]) => ({ month, amt: Math.round(amt) }));
    const types = Array.from(byType.entries()).sort(([, a], [, b]) => b.net - a.net);
    // flat entry list for the Excel export: vehicle + head + every entry
    const flat = rows.flatMap((r) => [
      ...r.heads.flatMap((h) =>
        h.entries.map((e) => ({
          vehicle: r.vehicle,
          ownership: r.ownership,
          head: h.name,
          date: formatDate(e.date),
          voucherNo: e.voucherNo,
          supplier: e.supplier,
          qty: e.qty ?? "",
          amount: e.amount,
          remarks: e.remarks,
        }))
      ),
      ...r.incomeEntries.map((e) => ({
        vehicle: r.vehicle,
        ownership: r.ownership,
        head: "INCOME",
        date: formatDate(e.date),
        voucherNo: e.voucherNo,
        supplier: e.supplier,
        qty: e.qty ?? "",
        amount: -e.amount,
        remarks: e.remarks,
      })),
    ]);
    return { total, income, net: total - income, entries, sorted, colorOf, months, types, flat };
  }, [rows]);

  if (!rows.length) {
    return (
      <div className="space-y-4">
        <Filters vehicleOptions={vehicleOptions} />
        <p className="text-sm text-muted-foreground">No vehicle expenses in this period.</p>
      </div>
    );
  }

  const biggest = t.sorted[0];
  const costliest = rows[0];

  const maxMonth = Math.max(...t.months.map((m) => m.amt), 1);
  const maxTypeNet = Math.max(...t.types.map(([, v]) => v.net), 1);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <Filters vehicleOptions={vehicleOptions} />
        <ExportButton
          rows={t.flat}
          fileName="vehicle-expense-detail"
          sheetName="Vehicle Expense Detail"
          columns={[
            { header: "Vehicle", key: "vehicle" },
            { header: "Ownership", key: "ownership" },
            { header: "Head", key: "head" },
            { header: "Date", key: "date" },
            { header: "Voucher", key: "voucherNo" },
            { header: "Supplier / Detail", key: "supplier" },
            { header: "Qty", key: "qty", numeric: true },
            { header: "Amount", key: "amount", numeric: true },
            { header: "Remarks", key: "remarks" },
          ]}
        />
      </div>

      {/* tiles */}
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-5">
        <div className="rounded-lg border bg-card p-4">
          <div className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
            Total Expenses
          </div>
          <div className="mt-1 text-2xl font-semibold tabular-nums">{lakh(t.total)}</div>
          <div className="mt-1 text-xs text-muted-foreground">
            {rows.length} vehicles · {t.entries} entries
          </div>
        </div>
        <div className="rounded-lg border bg-card p-4">
          <div className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
            Total Income
          </div>
          <div className="mt-1 text-2xl font-semibold tabular-nums text-emerald-600">
            {lakh(t.income)}
          </div>
          <div className="mt-1 text-xs text-muted-foreground">scrap / rent (INCOME vouchers)</div>
        </div>
        <div className="rounded-lg border bg-card p-4">
          <div className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
            Net Cost
          </div>
          <div className="mt-1 text-2xl font-semibold tabular-nums">{lakh(t.net)}</div>
          <div className="mt-1 text-xs text-muted-foreground">expenses − income</div>
        </div>
        <div className="rounded-lg border bg-card p-4">
          <div className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
            Biggest Head
          </div>
          <div className="mt-1 text-lg font-semibold">
            {biggest[0]} <span className="tabular-nums">{lakh(biggest[1])}</span>
          </div>
          <div className="mt-1 text-xs text-muted-foreground">
            {t.total > 0 ? `${((biggest[1] / t.total) * 100).toFixed(1)}% of total` : ""}
          </div>
        </div>
        <div className="rounded-lg border bg-card p-4">
          <div className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
            Costliest Vehicle
          </div>
          <div className="mt-1 text-lg font-semibold">{costliest.vehicle}</div>
          <div className="mt-1 text-xs tabular-nums text-muted-foreground">
            {lakh(costliest.net)} net in this period
          </div>
        </div>
      </div>

      {/* monthly + ownership compare */}
      <div className="grid gap-3 lg:grid-cols-2">
        <div className="rounded-lg border bg-card p-4">
          <div className="text-sm font-semibold">Month-wise Expenses — all vehicles</div>
          <div className="mb-2 text-xs text-muted-foreground">expense by month</div>
          {t.months.length ? (
            <>
              <div className="flex h-32 items-end gap-2 border-b px-1">
                {t.months.map((m) => (
                  <div
                    key={m.month}
                    className="flex h-full flex-1 flex-col items-center justify-end"
                    title={`${monthLabel(m.month)}: ${formatMoney(m.amt)}`}
                  >
                    <span className="mb-1 text-[10px] tabular-nums text-muted-foreground">
                      {lakh(m.amt)}
                    </span>
                    <i
                      className={`w-[70%] max-w-10 rounded-t ${HEAD_BG[1]}`}
                      style={{ height: `${Math.max(4, (m.amt / maxMonth) * 80)}%` }}
                    />
                  </div>
                ))}
              </div>
              <div className="flex gap-2 px-1 pt-1">
                {t.months.map((m) => (
                  <div key={m.month} className="flex-1 text-center text-[10px] text-muted-foreground">
                    {monthLabel(m.month)}
                  </div>
                ))}
              </div>
            </>
          ) : (
            <p className="text-xs text-muted-foreground">No data.</p>
          )}
        </div>
        <div className="rounded-lg border bg-card p-4">
          <div className="text-sm font-semibold">Ownership Compare</div>
          <div className="mb-2 text-xs text-muted-foreground">net cost — Own vs Relative vs Broker</div>
          {t.types.map(([label, v]) => (
            <div
              key={label}
              className="my-2 grid grid-cols-[110px_1fr_110px] items-center gap-2 text-sm"
            >
              <span>
                {label} <span className="text-xs text-muted-foreground">({v.vehicles})</span>
              </span>
              <span className="h-2.5 overflow-hidden rounded-full bg-muted">
                <i
                  className={`block h-full rounded-full ${HEAD_BG[1]}`}
                  style={{ width: `${Math.max((v.net / maxTypeNet) * 100, 1)}%` }}
                />
              </span>
              <span className="text-right font-semibold tabular-nums">{formatMoney(v.net)}</span>
            </div>
          ))}
        </div>
      </div>

      {/* overall share bar */}
      <div className="rounded-lg border bg-card p-4">
        <div className="text-sm font-semibold">Where the money went — all vehicles</div>
        <div className="mb-2 text-xs text-muted-foreground">share of each head</div>
        <div className="flex h-4 gap-[2px] overflow-hidden rounded">
          {t.sorted.map(([name, amt]) => (
            <i
              key={name}
              className={`block h-full ${t.colorOf.get(name)}`}
              style={{ width: `${t.total > 0 ? (amt / t.total) * 100 : 0}%` }}
              title={`${name}: ${formatMoney(amt)}`}
            />
          ))}
        </div>
        <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
          {t.sorted.map(([name, amt]) => (
            <span key={name} className="inline-flex items-center gap-1.5">
              <i className={`h-2.5 w-2.5 rounded-sm ${t.colorOf.get(name)}`} />
              {name} <b className="tabular-nums text-foreground">{lakh(amt)}</b>
            </span>
          ))}
        </div>
      </div>

      {/* vehicle accordions */}
      {rows.map((r) => {
        const open = openVehicles.has(r.id);
        const maxHead = Math.max(...r.heads.map((h) => h.amount), 1);
        return (
          <div key={r.id} className="overflow-hidden rounded-lg border bg-card">
            <button
              type="button"
              className="flex w-full items-center gap-2.5 px-4 py-3 text-left hover:bg-muted/50"
              onClick={() => setOpenVehicles((s) => toggle(s, r.id))}
            >
              <ChevronRight
                className={`h-4 w-4 text-muted-foreground transition-transform ${open ? "rotate-90" : ""}`}
              />
              <span className="font-semibold">{r.vehicle}</span>
              <Badge variant="secondary">{r.ownership}</Badge>
              {r.income > 0 && (
                <Badge className="bg-emerald-100 text-emerald-700 hover:bg-emerald-100 dark:bg-emerald-950 dark:text-emerald-400">
                  Income {formatMoney(r.income)}
                </Badge>
              )}
              <span className="ml-auto font-semibold tabular-nums">
                {r.income > 0 ? <>Net {formatMoney(r.net)}</> : formatMoney(r.total)}
              </span>
            </button>
            {open && (
              <div className="border-t">
                {r.heads.map((h) => {
                  const key = `${r.id}:${h.name}`;
                  const headOpen = openHeads.has(key);
                  const totalQty = h.entries.reduce((s, e) => s + (e.qty ?? 0), 0);
                  const months = Object.entries(h.months).sort(([a], [b]) => a.localeCompare(b));
                  return (
                    <React.Fragment key={h.name}>
                      <button
                        type="button"
                        className={`grid w-full grid-cols-[14px_150px_1fr_110px_90px] items-center gap-2.5 border-t px-4 py-2 text-left text-sm first:border-t-0 hover:bg-muted/50 ${headOpen ? "bg-muted/40" : ""}`}
                        onClick={() => setOpenHeads((s) => toggle(s, key))}
                      >
                        <i className={`h-2.5 w-2.5 rounded-sm ${t.colorOf.get(h.name)}`} />
                        <span className="truncate font-medium">{h.name}</span>
                        <span className="h-2 overflow-hidden rounded-full bg-muted">
                          <i
                            className={`block h-full rounded-full ${t.colorOf.get(h.name)}`}
                            style={{ width: `${(h.amount / maxHead) * 100}%` }}
                          />
                        </span>
                        <span className="text-right font-semibold tabular-nums">
                          {formatMoney(h.amount)}
                        </span>
                        <span className="text-right text-xs tabular-nums text-muted-foreground">
                          {h.entries.length} {h.entries.length === 1 ? "entry" : "entries"}
                        </span>
                      </button>
                      {headOpen && (
                        <div className="border-t bg-muted/30 px-4 py-3">
                          {months.length > 1 && (
                            <div className="mb-2 flex flex-wrap gap-2">
                              {months.map(([m, amt]) => (
                                <span
                                  key={m}
                                  className="rounded-md border bg-card px-2.5 py-0.5 text-xs tabular-nums"
                                >
                                  {monthLabel(m)} <b>{formatMoney(amt)}</b>
                                </span>
                              ))}
                            </div>
                          )}
                          <div className="overflow-x-auto">
                            <table className="w-full border-collapse text-xs">
                              <thead>
                                <tr>
                                  {["Date", "Voucher", "Supplier / Detail", "Qty", "Rate", "Amount", "Remarks"].map(
                                    (hd) => (
                                      <th
                                        key={hd}
                                        className={`border px-1.5 py-1 text-left font-semibold ${["Qty", "Rate", "Amount"].includes(hd) ? "text-right" : ""}`}
                                      >
                                        {hd}
                                      </th>
                                    )
                                  )}
                                </tr>
                              </thead>
                              <tbody>
                                {h.entries.map((e, i) => (
                                  <tr key={i}>
                                    <td className="border px-1.5 py-1">{formatDate(e.date)}</td>
                                    <td className="border px-1.5 py-1">{e.voucherNo || "—"}</td>
                                    <td className="border px-1.5 py-1">{e.supplier || "—"}</td>
                                    <td className="border px-1.5 py-1 text-right tabular-nums">
                                      {e.qty ?? ""}
                                    </td>
                                    <td className="border px-1.5 py-1 text-right tabular-nums">
                                      {e.qty ? (e.amount / e.qty).toFixed(2) : ""}
                                    </td>
                                    <td className="border px-1.5 py-1 text-right font-medium tabular-nums">
                                      {formatMoney(e.amount)}
                                    </td>
                                    <td className="border px-1.5 py-1 text-muted-foreground">
                                      {e.remarks || "—"}
                                    </td>
                                  </tr>
                                ))}
                              </tbody>
                              <tfoot>
                                <tr className="font-semibold">
                                  <td colSpan={3} className="border px-1.5 py-1">
                                    Total ({h.entries.length})
                                  </td>
                                  <td className="border px-1.5 py-1 text-right tabular-nums">
                                    {totalQty > 0 ? totalQty.toFixed(1) : ""}
                                  </td>
                                  <td className="border px-1.5 py-1" />
                                  <td className="border px-1.5 py-1 text-right tabular-nums">
                                    {formatMoney(h.amount)}
                                  </td>
                                  <td className="border px-1.5 py-1" />
                                </tr>
                              </tfoot>
                            </table>
                          </div>
                        </div>
                      )}
                    </React.Fragment>
                  );
                })}
                {/* income section — nets off the vehicle's cost */}
                {r.income > 0 && (
                  <>
                    <button
                      type="button"
                      className="grid w-full grid-cols-[14px_150px_1fr_110px_90px] items-center gap-2.5 border-t px-4 py-2 text-left text-sm hover:bg-muted/50"
                      onClick={() => setOpenHeads((s) => toggle(s, `${r.id}:__income`))}
                    >
                      <i className="h-2.5 w-2.5 rounded-sm bg-emerald-600 dark:bg-emerald-500" />
                      <span className="truncate font-medium text-emerald-700 dark:text-emerald-400">
                        Income
                      </span>
                      <span />
                      <span className="text-right font-semibold tabular-nums text-emerald-700 dark:text-emerald-400">
                        + {formatMoney(r.income)}
                      </span>
                      <span className="text-right text-xs tabular-nums text-muted-foreground">
                        {r.incomeEntries.length}{" "}
                        {r.incomeEntries.length === 1 ? "entry" : "entries"}
                      </span>
                    </button>
                    {openHeads.has(`${r.id}:__income`) && (
                      <div className="border-t bg-muted/30 px-4 py-3">
                        <div className="overflow-x-auto">
                          <table className="w-full border-collapse text-xs">
                            <thead>
                              <tr>
                                {["Date", "Voucher", "Detail", "Amount", "Remarks"].map((hd) => (
                                  <th
                                    key={hd}
                                    className={`border px-1.5 py-1 text-left font-semibold ${hd === "Amount" ? "text-right" : ""}`}
                                  >
                                    {hd}
                                  </th>
                                ))}
                              </tr>
                            </thead>
                            <tbody>
                              {r.incomeEntries.map((e, i) => (
                                <tr key={i}>
                                  <td className="border px-1.5 py-1">{formatDate(e.date)}</td>
                                  <td className="border px-1.5 py-1">{e.voucherNo || "—"}</td>
                                  <td className="border px-1.5 py-1">{e.supplier || "—"}</td>
                                  <td className="border px-1.5 py-1 text-right font-medium tabular-nums text-emerald-700 dark:text-emerald-400">
                                    {formatMoney(e.amount)}
                                  </td>
                                  <td className="border px-1.5 py-1 text-muted-foreground">
                                    {e.remarks || "—"}
                                  </td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        </div>
                      </div>
                    )}
                  </>
                )}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

function Filters({ vehicleOptions }: { vehicleOptions: MasterOption[] }) {
  return (
    <FilterBar
      filters={[
        { type: "daterange", key: "date", label: "Date" },
        { type: "combobox", key: "vehicle", label: "Vehicle", options: vehicleOptions },
        {
          type: "select",
          key: "ownership",
          label: "Ownership",
          options: [
            { value: "OWNER", label: "Own" },
            { value: "RELATIVE", label: "Relative" },
            { value: "BROKER", label: "Broker" },
          ],
        },
      ]}
    />
  );
}
