"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import type { ColumnDef } from "@tanstack/react-table";
import { Eye, Plus, Trash2 } from "lucide-react";
import { formatDate, formatMoney } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useToast } from "@/components/ui/use-toast";
import { DataTable, type DataTableColumnMeta } from "@/components/data/data-table";
import { DateInput } from "@/components/data/date-input";
import { ExportButton } from "@/components/data/export-button";
import { FilterBar } from "@/components/data/filter-bar";
import { MasterCombobox, type MasterOption } from "@/components/data/master-combobox";
import {
  deleteVehicleWithdrawal,
  saveVehicleWithdrawal,
} from "@/app/(app)/vehicle/management/withdrawal-actions";

export interface PnlTrip {
  id: string;
  tripNo: string;
  tripDate: string;
  driver: string;
  from: string;
  to: string;
  freight: number;
  approved: number; // company approved expenses grand total
  driverBalance: number;
  profit: number;
  approvedByCategory: { category: string; amount: number }[];
  legDiesel: number;
  legDriverAdvance: number;
  actualDriverAdvance: number; // from Driver Advance register (linked to trip)
  ureaQty: number;
  ureaAmount: number;
  ureaExpenseType: string;
  settlement: { prev: number; current: number; final: number; status: string } | null;
  vehicleExpenses: { date: string; head: string; voucherNo: string; amount: number }[];
}

export interface PnlEmi {
  payDate: string;
  loanId: string;
  loanNo: string;
  financeCompany: string;
  principal: number;
  interest: number;
  /** penalty + other charges on the instalment */
  penalty: number;
  total: number;
  voucherNo: string;
}

export interface VehiclePnlRow {
  id: string;
  vehicle: string;
  ownership: string; // Own | Relative
  tripCount: number;
  freight: number;
  tripExpenses: number;
  vehicleExpenses: number;
  driverSalary: number;
  /** full instalments (principal + interest + charges) paid in the period */
  emi: number;
  emis: PnlEmi[];
  net: number;
  /** net ÷ freight, in % (0 when there is no freight) */
  margin: number;
  /** month-wise net ("YYYY-MM"), for the trend sparkline & monthly chart */
  monthlyNet: { month: string; net: number }[];
  /** register expenses in the period (Diesel & Toll excluded) */
  vehExpDetails: { date: string; head: string; voucherNo: string; amount: number }[];
  /** booked salary months attributed to this vehicle */
  salaryDetails: { month: string; driver: string; amount: number }[];
  /** owner withdrawals in the selected period */
  wdPeriod: number;
  /** owner withdrawals since the beginning */
  wdLifetime: number;
  /** net profit since the beginning (all FYs), behind the running balance */
  lifetimeNet: number;
  /** lifetime net − lifetime withdrawals — continues across periods */
  runningBalance: number;
  wdEntries: {
    id: string;
    date: string;
    party: string;
    payParty: string;
    amount: number;
    remarks: string;
    /** net through the entry's month − withdrawals up to & incl. this entry */
    balanceAfter: number;
  }[];
  trips: PnlTrip[];
}

const signed = (n: number) =>
  n === 0 ? "0" : `${n > 0 ? "+" : "−"}${formatMoney(Math.abs(n))}`;

const catLabel = (c: string) =>
  c.split("_").map((w) => w.charAt(0) + w.slice(1).toLowerCase()).join(" ");

const MONTH_SHORT = ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"];
const monthLabel = (m: string) => `${MONTH_SHORT[Number(m.slice(5)) - 1] ?? m} ${m.slice(2, 4)}`;

/** ₹ figure compacted for tiles/charts: 757000 → "₹7.57L" */
function lakh(n: number): string {
  const abs = Math.abs(n);
  const s =
    abs >= 10000000
      ? `₹${(abs / 10000000).toFixed(2)}Cr`
      : abs >= 100000
        ? `₹${(abs / 100000).toFixed(2)}L`
        : abs >= 1000
          ? `₹${(abs / 1000).toFixed(1)}k`
          : `₹${Math.round(abs)}`;
  return n < 0 ? `− ${s}` : s;
}

// chart palette (light / dark pairs, validated categorical order)
const PROFIT_BG = "bg-[#2a78d6] dark:bg-[#3987e5]";
const LOSS_BG = "bg-[#e34948] dark:bg-[#e66767]";
const SERIES_BG = [
  "bg-[#2a78d6] dark:bg-[#3987e5]", // trip expenses
  "bg-[#eb6834] dark:bg-[#d95926]", // vehicle expenses
  "bg-[#1baf7a] dark:bg-[#199e70]", // driver salary
  "bg-[#eda100] dark:bg-[#c98500]", // emi
];
const SERIES_STROKE = [
  "stroke-[#2a78d6] dark:stroke-[#3987e5]",
  "stroke-[#eb6834] dark:stroke-[#d95926]",
  "stroke-[#1baf7a] dark:stroke-[#199e70]",
  "stroke-[#eda100] dark:stroke-[#c98500]",
];

/** last ≤6 months of a vehicle's net as tiny bars — red below zero */
function TrendSpark({ monthly }: { monthly: { month: string; net: number }[] }) {
  const pts = monthly.slice(-6);
  if (!pts.length) return <span className="text-xs text-muted-foreground">—</span>;
  const maxAbs = Math.max(...pts.map((p) => Math.abs(p.net)), 1);
  return (
    <span className="inline-flex h-5 items-end gap-[2px]" title={pts.map((p) => `${monthLabel(p.month)}: ${formatMoney(p.net)}`).join("\n")}>
      {pts.map((p) => (
        <i
          key={p.month}
          className={`w-[5px] rounded-[1px] ${p.net >= 0 ? PROFIT_BG : LOSS_BG}`}
          style={{ height: `${Math.max(15, (Math.abs(p.net) / maxAbs) * 100)}%`, opacity: 0.85 }}
        />
      ))}
    </span>
  );
}

/** summary tiles + the three overview charts above the table */
function PnlOverview({ rows }: { rows: VehiclePnlRow[] }) {
  const t = React.useMemo(() => {
    const sum = (f: (r: VehiclePnlRow) => number) => rows.reduce((s, r) => s + f(r), 0);
    const freight = sum((r) => r.freight);
    const parts = [
      sum((r) => r.tripExpenses),
      sum((r) => r.vehicleExpenses),
      sum((r) => r.driverSalary),
      sum((r) => r.emi),
    ];
    const expenses = parts.reduce((s, v) => s + v, 0);
    const net = sum((r) => r.net);
    const trips = sum((r) => r.tripCount);
    const withdrawals = sum((r) => r.wdPeriod);
    const runningBalance = sum((r) => r.runningBalance);
    const sorted = [...rows].sort((a, b) => b.net - a.net);
    const monthly = new Map<string, number>();
    for (const r of rows)
      for (const m of r.monthlyNet) monthly.set(m.month, (monthly.get(m.month) ?? 0) + m.net);
    const months = Array.from(monthly.entries())
      .sort(([a], [b]) => a.localeCompare(b))
      .slice(-12)
      .map(([month, m]) => ({ month, net: Math.round(m) }));
    return { freight, parts, expenses, net, trips, withdrawals, runningBalance, sorted, months };
  }, [rows]);

  if (!rows.length) return null;

  const best = t.sorted[0];
  const worst = t.sorted[t.sorted.length - 1];
  // diverging bar geometry: one shared scale, baseline splits pos/neg space
  const maxPos = Math.max(...t.sorted.map((r) => Math.max(r.net, 0)), 0);
  const maxNeg = Math.max(...t.sorted.map((r) => Math.max(-r.net, 0)), 0);
  const scale = maxPos + maxNeg || 1;
  const basePct = maxNeg > 0 ? (maxNeg / scale) * 92 + 3 : 3;
  const barVehicles = t.sorted.slice(0, 12);
  const maxMonthAbs = Math.max(...t.months.map((m) => Math.abs(m.net)), 1);
  // donut segments on r=60 (circumference ≈ 377), 2px gaps between arcs
  const C = 2 * Math.PI * 60;
  let acc = 0;
  const donut = t.parts.map((v) => {
    const len = t.expenses > 0 ? (v / t.expenses) * C : 0;
    const seg = { len: Math.max(len - 2, 0), off: acc };
    acc += len;
    return seg;
  });
  const donutLabels = ["Trip Expenses", "Vehicle Exp.", "Driver Salary", "EMI"];

  return (
    <div className="space-y-3">
      {/* tiles */}
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-6">
        <div className="rounded-lg border bg-gradient-to-br from-primary/5 to-card p-4">
          <div className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
            Net Profit / Loss
          </div>
          <div
            className={`mt-1 text-3xl font-semibold tabular-nums ${t.net >= 0 ? "text-emerald-600" : "text-destructive"}`}
          >
            {lakh(t.net)}
          </div>
          <div className="mt-1 text-xs text-muted-foreground">
            margin{" "}
            <b className="text-foreground">
              {t.freight > 0 ? `${((t.net / t.freight) * 100).toFixed(1)}%` : "—"}
            </b>{" "}
            of freight
          </div>
        </div>
        <div className="rounded-lg border bg-card p-4">
          <div className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
            Owner Withdrawal
          </div>
          <div className="mt-1 text-2xl font-semibold tabular-nums text-orange-600 dark:text-orange-400">
            {lakh(t.withdrawals)}
          </div>
          <div className="mt-1 text-xs text-muted-foreground">in this period</div>
        </div>
        <div className="rounded-lg border bg-card p-4">
          <div className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
            Running Balance
          </div>
          <div
            className={`mt-1 text-2xl font-semibold tabular-nums ${t.runningBalance < 0 ? "text-destructive" : ""}`}
          >
            {lakh(t.runningBalance)}
          </div>
          <div className="mt-1 text-xs text-muted-foreground">since inception: profit − withdrawals</div>
        </div>
        <div className="rounded-lg border bg-card p-4">
          <div className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
            Trip Freight
          </div>
          <div className="mt-1 text-2xl font-semibold tabular-nums">{lakh(t.freight)}</div>
          <div className="mt-1 text-xs text-muted-foreground">
            {t.trips} trips · {rows.length} vehicles
            {t.trips > 0 && <> · avg {lakh(t.freight / t.trips)}/trip</>}
          </div>
        </div>
        <div className="rounded-lg border bg-card p-4">
          <div className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
            Total Expenses
          </div>
          <div className="mt-1 text-2xl font-semibold tabular-nums">{lakh(t.expenses)}</div>
          <div className="mt-1 text-xs text-muted-foreground">
            {t.freight > 0 ? `${((t.expenses / t.freight) * 100).toFixed(1)}% of freight` : " "}
          </div>
        </div>
        <div className="rounded-lg border bg-card p-4">
          <div className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
            Best / Worst
          </div>
          <div className="mt-1 space-y-1 text-sm">
            <div className="flex items-center justify-between gap-2">
              <span className="truncate">{best.vehicle}</span>
              <Badge className="bg-emerald-100 text-emerald-700 hover:bg-emerald-100 dark:bg-emerald-950 dark:text-emerald-400">
                {signed(best.net)}
              </Badge>
            </div>
            {worst.id !== best.id && (
              <div className="flex items-center justify-between gap-2">
                <span className="truncate">{worst.vehicle}</span>
                <Badge
                  variant={worst.net < 0 ? "destructive" : "secondary"}
                  className={worst.net < 0 ? "" : undefined}
                >
                  {signed(worst.net)}
                </Badge>
              </div>
            )}
          </div>
        </div>
      </div>

      {/* charts */}
      <div className="grid gap-3 lg:grid-cols-3">
        {/* vehicle-wise diverging bars */}
        <div className="rounded-lg border bg-card p-4">
          <div className="text-sm font-semibold">Vehicle-wise Net Profit / Loss</div>
          <p className="mb-2 text-xs text-muted-foreground">
            profit right of the line, loss left{t.sorted.length > 12 ? ` · top 12 of ${t.sorted.length}` : ""}
          </p>
          {barVehicles.map((r) => {
            const w = (Math.abs(r.net) / scale) * 92;
            return (
              <div key={r.id} className="my-1.5 grid grid-cols-[96px_1fr_76px] items-center gap-2 text-xs">
                <span className="truncate">{r.vehicle}</span>
                <span className="relative h-4">
                  <i className="absolute bottom-[-3px] top-[-3px] w-px bg-border" style={{ left: `${basePct}%` }} />
                  <i
                    className={`absolute top-[2px] h-3 ${r.net >= 0 ? `rounded-r ${PROFIT_BG}` : `rounded-l ${LOSS_BG}`}`}
                    style={
                      r.net >= 0
                        ? { left: `${basePct}%`, width: `${w}%` }
                        : { left: `${basePct - w}%`, width: `${w}%` }
                    }
                  />
                </span>
                <span
                  className={`text-right tabular-nums ${r.net < 0 ? "font-medium text-destructive" : "text-muted-foreground"}`}
                >
                  {lakh(r.net)}
                </span>
              </div>
            );
          })}
        </div>

        {/* month-wise net */}
        <div className="rounded-lg border bg-card p-4">
          <div className="text-sm font-semibold">Month-wise Net</div>
          <p className="mb-2 text-xs text-muted-foreground">net profit for each month</p>
          {t.months.length ? (
            <>
              <div className="flex h-36 items-end gap-2 border-b px-1">
                {t.months.map((m) => (
                  <div
                    key={m.month}
                    className="flex h-full flex-1 flex-col items-center justify-end"
                    title={`${monthLabel(m.month)}: ${formatMoney(m.net)}`}
                  >
                    <span className="mb-1 text-[10px] tabular-nums text-muted-foreground">
                      {lakh(m.net)}
                    </span>
                    <i
                      className={`w-[70%] max-w-10 rounded-t ${m.net >= 0 ? PROFIT_BG : LOSS_BG}`}
                      style={{ height: `${Math.max(4, (Math.abs(m.net) / maxMonthAbs) * 82)}%` }}
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
            <p className="text-xs text-muted-foreground">No monthly data in this period.</p>
          )}
        </div>

        {/* expense donut */}
        <div className="rounded-lg border bg-card p-4">
          <div className="text-sm font-semibold">Where the money went</div>
          <p className="mb-2 text-xs text-muted-foreground">all vehicles, selected period</p>
          <div className="flex items-center gap-4">
            <div className="relative h-[136px] w-[136px] flex-none">
              <svg width="136" height="136" viewBox="0 0 150 150" className="-rotate-90">
                <circle cx="75" cy="75" r="60" fill="none" strokeWidth="20" className="stroke-muted" />
                {donut.map((seg, i) =>
                  seg.len > 0 ? (
                    <circle
                      key={i}
                      cx="75"
                      cy="75"
                      r="60"
                      fill="none"
                      strokeWidth="20"
                      className={SERIES_STROKE[i]}
                      strokeDasharray={`${seg.len} ${C - seg.len}`}
                      strokeDashoffset={-seg.off}
                    />
                  ) : null
                )}
              </svg>
              <div className="absolute inset-0 flex flex-col items-center justify-center">
                <b className="text-sm tabular-nums">{lakh(t.expenses)}</b>
                <span className="text-[10px] uppercase text-muted-foreground">total</span>
              </div>
            </div>
            <div className="grid flex-1 gap-1.5 text-xs">
              {donutLabels.map((label, i) => (
                <div key={label} className="flex items-center gap-2">
                  <i className={`h-2.5 w-2.5 rounded-sm ${SERIES_BG[i]}`} />
                  <span className="text-muted-foreground">{label}</span>
                  <b className="ml-auto tabular-nums">{lakh(t.parts[i])}</b>
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

export function VehiclePnlClient({
  rows,
  vehicleOptions,
  driverOptions,
  malikOptions,
  payOptions,
}: {
  rows: VehiclePnlRow[];
  vehicleOptions: MasterOption[];
  driverOptions: MasterOption[];
  malikOptions: MasterOption[];
  payOptions: MasterOption[];
}) {
  const router = useRouter();
  const { toast } = useToast();
  const [vehicleOf, setVehicleOf] = React.useState<VehiclePnlRow | null>(null);
  const [tripOf, setTripOf] = React.useState<{ vehicle: VehiclePnlRow; trip: PnlTrip } | null>(null);
  const [emiOf, setEmiOf] = React.useState<VehiclePnlRow | null>(null);
  const [wdListOf, setWdListOf] = React.useState<VehiclePnlRow | null>(null);
  // owner withdrawal entry form
  const [wdOpen, setWdOpen] = React.useState(false);
  const [wdSaving, setWdSaving] = React.useState(false);
  const [wdVehicleId, setWdVehicleId] = React.useState<string | null>(null);
  const [wdPartyId, setWdPartyId] = React.useState<string | null>(null);
  const [wdPayPartyId, setWdPayPartyId] = React.useState<string | null>(null);
  const [wdDateText, setWdDateText] = React.useState(formatDate(new Date()));
  const [wdAmount, setWdAmount] = React.useState(0);
  const [wdRemarks, setWdRemarks] = React.useState("");

  const textToIso = (text: string): string => {
    const m = text.match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
    return m ? `${m[3]}-${m[2]}-${m[1]}` : "";
  };

  const saveWd = async () => {
    const iso = textToIso(wdDateText);
    if (!wdVehicleId || !wdPartyId || !wdPayPartyId || !iso || wdAmount <= 0) {
      toast({ variant: "destructive", title: "Vehicle, owner, paid-from, date and amount are all required" });
      return;
    }
    setWdSaving(true);
    try {
      const res = await saveVehicleWithdrawal({
        vehicleId: wdVehicleId,
        partyId: wdPartyId,
        payPartyId: wdPayPartyId,
        date: iso,
        amount: wdAmount,
        remarks: wdRemarks,
      });
      if (res.ok) {
        toast({ title: "Withdrawal saved — ledger & running balance updated" });
        setWdOpen(false);
        setWdAmount(0);
        setWdRemarks("");
        router.refresh();
      } else {
        toast({ variant: "destructive", title: res.error });
      }
    } finally {
      setWdSaving(false);
    }
  };

  const removeWd = async (id: string) => {
    const res = await deleteVehicleWithdrawal(id);
    if (res.ok) {
      toast({ title: "Withdrawal entry deleted — ledger reversed" });
      setWdListOf(null);
      router.refresh();
    } else {
      toast({ variant: "destructive", title: res.error });
    }
  };

  const money = (
    key: keyof Pick<
      VehiclePnlRow,
      "freight" | "tripExpenses" | "vehicleExpenses" | "driverSalary" | "emi" | "net"
    >,
    header: string
  ): ColumnDef<VehiclePnlRow> => ({
    accessorKey: key,
    header,
    cell: ({ row }) => (
      <span className={key === "net" ? (row.original.net >= 0 ? "font-semibold text-emerald-600" : "font-semibold text-destructive") : undefined}>
        {formatMoney(row.original[key])}
      </span>
    ),
    meta: {
      numeric: true,
      total: (rs) => formatMoney(rs.reduce((s, r) => s + r[key], 0)),
    } satisfies DataTableColumnMeta<VehiclePnlRow>,
  });

  const columns: ColumnDef<VehiclePnlRow>[] = [
    {
      accessorKey: "vehicle",
      header: "Vehicle No",
      cell: ({ row }) => (
        <button
          type="button"
          className="text-primary underline-offset-2 hover:underline"
          onClick={(e) => {
            e.stopPropagation();
            setVehicleOf(row.original);
          }}
        >
          {row.original.vehicle}
        </button>
      ),
    },
    {
      accessorKey: "ownership",
      header: "Ownership",
      cell: ({ row }) => <Badge variant="secondary">{row.original.ownership}</Badge>,
    },
    {
      accessorKey: "tripCount",
      header: "Trips",
      meta: { numeric: true } satisfies DataTableColumnMeta<VehiclePnlRow>,
    },
    money("freight", "Trip Freight"),
    money("tripExpenses", "Trip Expenses"),
    money("vehicleExpenses", "Vehicle Expenses"),
    money("driverSalary", "Driver Salary"),
    {
      accessorKey: "emi",
      header: "EMI Expenses",
      cell: ({ row }) =>
        row.original.emi > 0 ? (
          <button
            type="button"
            className="tabular-nums text-primary underline-offset-2 hover:underline"
            title="View EMI instalments"
            onClick={(e) => {
              e.stopPropagation();
              setEmiOf(row.original);
            }}
          >
            {formatMoney(row.original.emi)}
          </button>
        ) : (
          <span>{formatMoney(0)}</span>
        ),
      meta: {
        numeric: true,
        total: (rs) => formatMoney(rs.reduce((s, r) => s + r.emi, 0)),
      } satisfies DataTableColumnMeta<VehiclePnlRow>,
    },
    money("net", "Net Profit / Loss"),
    {
      id: "trend",
      header: "Trend",
      cell: ({ row }) => <TrendSpark monthly={row.original.monthlyNet} />,
      enableSorting: false,
    },
    {
      accessorKey: "margin",
      header: "Margin",
      cell: ({ row }) => (
        <span className="inline-flex items-center gap-1.5 tabular-nums">
          <span className={row.original.margin < 0 ? "font-medium text-destructive" : undefined}>
            {row.original.margin.toFixed(1)}%
          </span>
          {row.original.margin > 0 && (
            <span className="inline-block h-1.5 w-12 overflow-hidden rounded-full bg-muted">
              <i
                className={`block h-full rounded-full ${PROFIT_BG}`}
                style={{ width: `${Math.min(row.original.margin, 100)}%` }}
              />
            </span>
          )}
        </span>
      ),
      meta: { numeric: true } satisfies DataTableColumnMeta<VehiclePnlRow>,
    },
    {
      accessorKey: "wdPeriod",
      header: "Withdrawals",
      cell: ({ row }) =>
        row.original.wdEntries.length ? (
          <button
            type="button"
            className="tabular-nums text-orange-600 underline-offset-2 hover:underline dark:text-orange-400"
            title="View owner withdrawal entries"
            onClick={(e) => {
              e.stopPropagation();
              setWdListOf(row.original);
            }}
          >
            {formatMoney(row.original.wdPeriod)}
          </button>
        ) : (
          <span className="tabular-nums text-muted-foreground">{formatMoney(0)}</span>
        ),
      meta: {
        numeric: true,
        total: (rs) => formatMoney(rs.reduce((s, r) => s + r.wdPeriod, 0)),
      } satisfies DataTableColumnMeta<VehiclePnlRow>,
    },
    {
      accessorKey: "runningBalance",
      header: "Running Balance",
      cell: ({ row }) => (
        <span
          className={`font-semibold tabular-nums ${row.original.runningBalance < 0 ? "text-destructive" : ""}`}
          title={`Lifetime net ${formatMoney(row.original.lifetimeNet)} − withdrawals ${formatMoney(row.original.wdLifetime)}`}
        >
          {formatMoney(row.original.runningBalance)}
        </span>
      ),
      meta: {
        numeric: true,
        total: (rs) => formatMoney(rs.reduce((s, r) => s + r.runningBalance, 0)),
      } satisfies DataTableColumnMeta<VehiclePnlRow>,
    },
  ];

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h1 className="text-xl font-semibold">Trip Profit &amp; Loss with Expenses</h1>
        <div className="flex items-center gap-2">
        <Button size="sm" onClick={() => setWdOpen(true)}>
          <Plus className="h-4 w-4" /> Owner Withdrawal
        </Button>
        <ExportButton
          rows={rows}
          fileName="trip-pnl-with-expenses"
          sheetName="Trip P&L with Expenses"
          columns={[
            { header: "Vehicle No", key: "vehicle" },
            { header: "Ownership", key: "ownership" },
            { header: "Trips", key: "tripCount", numeric: true },
            { header: "Trip Freight", key: "freight", numeric: true },
            { header: "Trip Expenses", key: "tripExpenses", numeric: true },
            { header: "Vehicle Expenses", key: "vehicleExpenses", numeric: true },
            { header: "Driver Salary", key: "driverSalary", numeric: true },
            { header: "EMI Expenses", key: "emi", numeric: true },
            { header: "Net Profit / Loss", key: "net", numeric: true },
            { header: "Margin %", key: "margin", numeric: true },
            { header: "Withdrawals", key: "wdPeriod", numeric: true },
            { header: "Running Balance", key: "runningBalance", numeric: true },
          ]}
        />
        </div>
      </div>
      <p className="text-sm text-muted-foreground">
        Own &amp; Relative vehicles only. P&amp;L = Trip Freight − Company Approved Trip Expenses −
        Vehicle Expenses (Diesel &amp; Toll excluded — already in trips) − Booked Driver Salary
        (payment status never matters) − EMI Expenses (full instalments paid in the period,
        fetched from Finance &amp; Loans). Click a vehicle number to drill into its trips, or the
        EMI amount for instalment details.
      </p>
      <FilterBar
        filters={[
          { type: "daterange", key: "date", label: "Trip Date" },
          { type: "combobox", key: "vehicle", label: "Vehicle", options: vehicleOptions },
          {
            type: "select",
            key: "ownership",
            label: "Ownership",
            options: [
              { value: "OWNER", label: "Own" },
              { value: "RELATIVE", label: "Relative" },
            ],
          },
          { type: "combobox", key: "driver", label: "Driver", options: driverOptions },
        ]}
      />
      <PnlOverview rows={rows} />
      <DataTable
        columns={columns}
        data={rows}
        emptyMessage="No own / relative vehicle activity in this period."
        onRowClick={(r) => setVehicleOf(r)}
      />

      {/* -------- vehicle drill-down: trips -------- */}
      <Dialog open={!!vehicleOf} onOpenChange={(o) => !o && setVehicleOf(null)}>
        <DialogContent className="max-h-[95vh] overflow-y-auto sm:max-w-5xl">
          <DialogHeader>
            <DialogTitle>
              {vehicleOf?.vehicle} ({vehicleOf?.ownership}) — {vehicleOf?.tripCount} trip
              {vehicleOf?.tripCount === 1 ? "" : "s"}
            </DialogTitle>
            <DialogDescription>
              Net P&amp;L {formatMoney(vehicleOf?.net ?? 0)} = Freight{" "}
              {formatMoney(vehicleOf?.freight ?? 0)} − Trip Exp{" "}
              {formatMoney(vehicleOf?.tripExpenses ?? 0)} − Vehicle Exp{" "}
              {formatMoney(vehicleOf?.vehicleExpenses ?? 0)} − Booked Salary{" "}
              {formatMoney(vehicleOf?.driverSalary ?? 0)} − EMI{" "}
              {formatMoney(vehicleOf?.emi ?? 0)}
            </DialogDescription>
          </DialogHeader>
          <div className="overflow-x-auto">
            <table className="w-full border-collapse text-xs">
              <thead>
                <tr>
                  {[
                    "Trip Ref",
                    "Date",
                    "Driver",
                    "From",
                    "To",
                    "Freight",
                    "Approved Exp",
                    "Driver +/-",
                    "Trip P/L",
                    "",
                  ].map((h) => (
                    <th key={h} className="border px-1.5 py-1 text-left font-semibold">
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {vehicleOf?.trips.map((t) => (
                  <tr key={t.id}>
                    <td className="border px-1.5 py-1">{t.tripNo}</td>
                    <td className="border px-1.5 py-1">{formatDate(t.tripDate)}</td>
                    <td className="border px-1.5 py-1">{t.driver}</td>
                    <td className="border px-1.5 py-1">{t.from}</td>
                    <td className="border px-1.5 py-1">{t.to}</td>
                    <td className="border px-1.5 py-1 text-right">{formatMoney(t.freight)}</td>
                    <td className="border px-1.5 py-1 text-right">{formatMoney(t.approved)}</td>
                    <td className="border px-1.5 py-1 text-right">{signed(t.driverBalance)}</td>
                    <td
                      className={`border px-1.5 py-1 text-right font-medium ${t.profit >= 0 ? "text-emerald-600" : "text-destructive"}`}
                    >
                      {formatMoney(t.profit)}
                    </td>
                    <td className="border px-1 py-0.5">
                      <Button
                        variant="ghost"
                        size="sm"
                        className="h-6 px-2 text-xs"
                        onClick={() => setTripOf({ vehicle: vehicleOf, trip: t })}
                      >
                        <Eye className="h-3 w-3" /> View Details
                      </Button>
                    </td>
                  </tr>
                ))}
                {!vehicleOf?.trips.length && (
                  <tr>
                    <td colSpan={10} className="border px-1.5 py-2 text-center text-muted-foreground">
                      No trips in this period.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>

          {/* vehicle expenses + booked salary breakups for the same period */}
          <div className="grid gap-3 md:grid-cols-2">
            <div className="rounded-md border p-2">
              <div className="mb-1 text-sm font-semibold">
                Vehicle Expenses — {formatMoney(vehicleOf?.vehicleExpenses ?? 0)}
                <span className="ml-1 text-xs font-normal text-muted-foreground">
                  (Diesel &amp; Toll excluded — already in trips)
                </span>
              </div>
              {vehicleOf?.vehExpDetails.length ? (
                <div className="max-h-56 overflow-y-auto">
                  <table className="w-full border-collapse text-xs">
                    <thead>
                      <tr>
                        {["Date", "Head", "Voucher", "Amount"].map((h) => (
                          <th key={h} className="border px-1.5 py-1 text-left font-semibold">
                            {h}
                          </th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {vehicleOf.vehExpDetails.map((e, i) => (
                        <tr key={i}>
                          <td className="border px-1.5 py-0.5">{formatDate(e.date)}</td>
                          <td className="border px-1.5 py-0.5">{e.head}</td>
                          <td className="border px-1.5 py-0.5">{e.voucherNo}</td>
                          <td className="border px-1.5 py-0.5 text-right tabular-nums">
                            {formatMoney(e.amount)}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : (
                <div className="text-xs text-muted-foreground">None booked in this period.</div>
              )}
            </div>
            <div className="rounded-md border p-2">
              <div className="mb-1 text-sm font-semibold">
                Driver Salary — {formatMoney(vehicleOf?.driverSalary ?? 0)}
                <span className="ml-1 text-xs font-normal text-muted-foreground">
                  (booked — paid or pending, both count)
                </span>
              </div>
              {vehicleOf?.salaryDetails.length ? (
                <div className="max-h-56 overflow-y-auto">
                  <table className="w-full border-collapse text-xs">
                    <thead>
                      <tr>
                        {["Month", "Driver", "Salary"].map((h) => (
                          <th key={h} className="border px-1.5 py-1 text-left font-semibold">
                            {h}
                          </th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {vehicleOf.salaryDetails.map((s, i) => (
                        <tr key={i}>
                          <td className="border px-1.5 py-0.5">{monthLabel(s.month)}</td>
                          <td className="border px-1.5 py-0.5">{s.driver}</td>
                          <td className="border px-1.5 py-0.5 text-right tabular-nums">
                            {formatMoney(s.amount)}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : (
                <div className="text-xs text-muted-foreground">No salary booked in this period.</div>
              )}
            </div>
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={() => setVehicleOf(null)}>
              Close
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* -------- EMI drill-down: instalments in the period -------- */}
      <Dialog open={!!emiOf} onOpenChange={(o) => !o && setEmiOf(null)}>
        <DialogContent className="max-h-[95vh] overflow-y-auto sm:max-w-4xl">
          <DialogHeader>
            <DialogTitle>EMI Expenses — {emiOf?.vehicle}</DialogTitle>
            <DialogDescription>
              Instalments paid in the selected period, fetched from Finance &amp; Loans. The
              full EMI (principal + interest + charges) is the financing cost of operating the
              vehicle; accounting entries are unchanged.
            </DialogDescription>
          </DialogHeader>
          <div className="overflow-x-auto">
            <table className="w-full border-collapse text-xs">
              <thead>
                <tr>
                  {[
                    "Payment Date",
                    "Loan No",
                    "Finance Company",
                    "Principal",
                    "Interest",
                    "Penalty / Charges",
                    "Total EMI",
                    "Voucher No",
                    "",
                  ].map((h) => (
                    <th key={h} className="border px-1.5 py-1 text-left font-semibold">
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {emiOf?.emis.map((e, i) => (
                  <tr key={i}>
                    <td className="border px-1.5 py-1">{formatDate(e.payDate)}</td>
                    <td className="border px-1.5 py-1">{e.loanNo}</td>
                    <td className="border px-1.5 py-1">{e.financeCompany}</td>
                    <td className="border px-1.5 py-1 text-right tabular-nums">
                      {formatMoney(e.principal)}
                    </td>
                    <td className="border px-1.5 py-1 text-right tabular-nums">
                      {formatMoney(e.interest)}
                    </td>
                    <td className="border px-1.5 py-1 text-right tabular-nums">
                      {formatMoney(e.penalty)}
                    </td>
                    <td className="border px-1.5 py-1 text-right font-medium tabular-nums">
                      {formatMoney(e.total)}
                    </td>
                    <td className="border px-1.5 py-1">{e.voucherNo || "—"}</td>
                    <td className="whitespace-nowrap border px-1 py-0.5">
                      <Button variant="ghost" size="sm" className="h-6 px-2 text-xs" asChild>
                        <a href={`/print/loan/${e.loanId}`} target="_blank" rel="noreferrer">
                          Loan Entry
                        </a>
                      </Button>
                      <Button variant="ghost" size="sm" className="h-6 px-2 text-xs" asChild>
                        <a href="/accounts/vouchers/register" target="_blank" rel="noreferrer">
                          Voucher
                        </a>
                      </Button>
                    </td>
                  </tr>
                ))}
                {!emiOf?.emis.length && (
                  <tr>
                    <td colSpan={9} className="border px-1.5 py-2 text-center text-muted-foreground">
                      No instalments paid in this period.
                    </td>
                  </tr>
                )}
              </tbody>
              {!!emiOf?.emis.length && (
                <tfoot>
                  <tr className="font-semibold">
                    <td colSpan={3} className="border px-1.5 py-1">
                      Total
                    </td>
                    <td className="border px-1.5 py-1 text-right tabular-nums">
                      {formatMoney(emiOf.emis.reduce((s, e) => s + e.principal, 0))}
                    </td>
                    <td className="border px-1.5 py-1 text-right tabular-nums">
                      {formatMoney(emiOf.emis.reduce((s, e) => s + e.interest, 0))}
                    </td>
                    <td className="border px-1.5 py-1 text-right tabular-nums">
                      {formatMoney(emiOf.emis.reduce((s, e) => s + e.penalty, 0))}
                    </td>
                    <td className="border px-1.5 py-1 text-right tabular-nums">
                      {formatMoney(emiOf.emi)}
                    </td>
                    <td colSpan={2} className="border" />
                  </tr>
                </tfoot>
              )}
            </table>
          </div>
          <DialogFooter className="gap-2">
            <Button variant="outline" size="sm" onClick={() => window.print()}>
              Print
            </Button>
            <Button size="sm" asChild>
              <a href="/finance" target="_blank" rel="noreferrer">
                Open Finance &amp; Loans
              </a>
            </Button>
            <Button variant="outline" onClick={() => setEmiOf(null)}>
              Close
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* -------- trip detail -------- */}
      <Dialog open={!!tripOf} onOpenChange={(o) => !o && setTripOf(null)}>
        <DialogContent className="max-h-[95vh] overflow-y-auto sm:max-w-3xl">
          <DialogHeader>
            <DialogTitle>
              Trip {tripOf?.trip.tripNo} — {tripOf?.vehicle.vehicle}
            </DialogTitle>
            <DialogDescription>
              {formatDate(tripOf?.trip.tripDate ?? new Date().toISOString())} ·{" "}
              {tripOf?.trip.driver || "no driver"} · {tripOf?.trip.from} → {tripOf?.trip.to}
            </DialogDescription>
          </DialogHeader>

          {tripOf && (
            <div className="space-y-3 text-sm">
              {/* company approved expenses */}
              <div className="rounded-md border p-2">
                <div className="mb-1 font-semibold">Company Approved Expenses</div>
                <div className="grid grid-cols-2 gap-x-6 gap-y-0.5 text-xs sm:grid-cols-3">
                  {tripOf.trip.approvedByCategory.map((c) => (
                    <div key={c.category} className="flex justify-between">
                      <span>{catLabel(c.category)}</span>
                      <span className="tabular-nums">{formatMoney(c.amount)}</span>
                    </div>
                  ))}
                  {tripOf.trip.legDriverAdvance > 0 && (
                    <div className="flex justify-between">
                      <span>Driver Advance (legs)</span>
                      <span className="tabular-nums">{formatMoney(tripOf.trip.legDriverAdvance)}</span>
                    </div>
                  )}
                </div>
                <div className="mt-1 flex justify-between border-t pt-1 font-semibold">
                  <span>Grand Total</span>
                  <span className="tabular-nums">{formatMoney(tripOf.trip.approved)}</span>
                </div>
              </div>

              {/* actual driver expenses */}
              <div className="rounded-md border p-2">
                <div className="mb-1 font-semibold">Actual Driver Expenses</div>
                <div className="grid grid-cols-2 gap-x-6 gap-y-0.5 text-xs sm:grid-cols-3">
                  <div className="flex justify-between">
                    <span>Driver Advance (register)</span>
                    <span className="tabular-nums">{formatMoney(tripOf.trip.actualDriverAdvance)}</span>
                  </div>
                  <div className="flex justify-between">
                    <span>
                      Urea {tripOf.trip.ureaQty ? `(${tripOf.trip.ureaQty} L)` : ""}
                      {tripOf.trip.ureaExpenseType === "DRIVER" ? "" : " — company"}
                    </span>
                    <span className="tabular-nums">
                      {tripOf.trip.ureaExpenseType === "DRIVER"
                        ? formatMoney(tripOf.trip.ureaAmount)
                        : "—"}
                    </span>
                  </div>
                </div>
                <div className="mt-1 flex justify-between border-t pt-1 font-semibold">
                  <span>Total Actual Driver Expenses</span>
                  <span className="tabular-nums">
                    {formatMoney(
                      tripOf.trip.actualDriverAdvance +
                        (tripOf.trip.ureaExpenseType === "DRIVER" ? tripOf.trip.ureaAmount : 0)
                    )}
                  </span>
                </div>
              </div>

              {/* driver settlement */}
              <div className="rounded-md border p-2">
                <div className="mb-1 font-semibold">Driver Settlement</div>
                {tripOf.trip.settlement ? (
                  <div className="grid grid-cols-3 gap-2 text-xs">
                    <div>
                      Previous Balance:{" "}
                      <b className="tabular-nums">{signed(tripOf.trip.settlement.prev)}</b>
                    </div>
                    <div>
                      Current Trip Balance:{" "}
                      <b className="tabular-nums">{signed(tripOf.trip.settlement.current)}</b>
                    </div>
                    <div>
                      Final Balance:{" "}
                      <b className="tabular-nums">{signed(tripOf.trip.settlement.final)}</b>{" "}
                      <Badge variant={tripOf.trip.settlement.status === "PENDING" ? "outline" : "default"}>
                        {tripOf.trip.settlement.status === "PENDING" ? "PENDING" : "ADJUSTED"}
                      </Badge>
                    </div>
                  </div>
                ) : (
                  <div className="text-xs text-muted-foreground">No driver balance on this trip.</div>
                )}
              </div>

              {/* vehicle expenses (non diesel/toll, trip period) */}
              <div className="rounded-md border p-2">
                <div className="mb-1 font-semibold">
                  Vehicle Expenses in Trip Period (Diesel &amp; Toll excluded)
                </div>
                {tripOf.trip.vehicleExpenses.length ? (
                  <table className="w-full border-collapse text-xs">
                    <tbody>
                      {tripOf.trip.vehicleExpenses.map((e, i) => (
                        <tr key={i}>
                          <td className="border px-1.5 py-0.5">{formatDate(e.date)}</td>
                          <td className="border px-1.5 py-0.5">{e.head}</td>
                          <td className="border px-1.5 py-0.5">{e.voucherNo}</td>
                          <td className="border px-1.5 py-0.5 text-right">{formatMoney(e.amount)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                ) : (
                  <div className="text-xs text-muted-foreground">None booked in this period.</div>
                )}
              </div>

              {/* final trip P&L */}
              <div className="rounded-md bg-muted/50 p-2">
                <div className="flex justify-between text-xs">
                  <span>Trip Freight</span>
                  <span className="tabular-nums">{formatMoney(tripOf.trip.freight)}</span>
                </div>
                <div className="flex justify-between text-xs">
                  <span>Trip Expenses (approved)</span>
                  <span className="tabular-nums">− {formatMoney(tripOf.trip.approved)}</span>
                </div>
                <div
                  className={`mt-1 flex justify-between border-t pt-1 font-semibold ${tripOf.trip.profit >= 0 ? "text-emerald-600" : "text-destructive"}`}
                >
                  <span>Trip Net Profit / Loss</span>
                  <span className="tabular-nums">{formatMoney(tripOf.trip.profit)}</span>
                </div>
                <div className="mt-1 text-[11px] text-muted-foreground">
                  Vehicle expenses and booked driver salary are deducted at vehicle level (see the
                  main report row) so nothing is double-counted.
                </div>
              </div>
            </div>
          )}

          <DialogFooter className="gap-2">
            <Button variant="outline" size="sm" asChild>
              <a href={`/print/trip/${tripOf?.trip.id}`} target="_blank" rel="noreferrer">
                Print Trip Sheet
              </a>
            </Button>
            <Button variant="outline" size="sm" asChild>
              <a href={`/print/trip-summary/${tripOf?.trip.id}`} target="_blank" rel="noreferrer">
                360° Summary
              </a>
            </Button>
            <Button size="sm" asChild>
              <a href={`/trips?id=${tripOf?.trip.id}`} target="_blank" rel="noreferrer">
                Open Full Trip Sheet
              </a>
            </Button>
            <Button variant="outline" onClick={() => setTripOf(null)}>
              Close
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* -------- owner withdrawal list (lifetime, with balance-after) -------- */}
      <Dialog open={!!wdListOf} onOpenChange={(o) => !o && setWdListOf(null)}>
        <DialogContent className="max-h-[95vh] overflow-y-auto sm:max-w-3xl">
          <DialogHeader>
            <DialogTitle>Owner Withdrawal — {wdListOf?.vehicle}</DialogTitle>
            <DialogDescription>
              Running Balance {formatMoney(wdListOf?.runningBalance ?? 0)} = lifetime net{" "}
              {formatMoney(wdListOf?.lifetimeNet ?? 0)} − total withdrawals{" "}
              {formatMoney(wdListOf?.wdLifetime ?? 0)}. Balance After = profit through that month −
              withdrawals up to then.
            </DialogDescription>
          </DialogHeader>
          <div className="overflow-x-auto">
            <table className="w-full border-collapse text-xs">
              <thead>
                <tr>
                  {["Date", "Owner", "Paid From", "Remarks", "Amount", "Balance After", ""].map((h) => (
                    <th key={h} className="border px-1.5 py-1 text-left font-semibold">
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {wdListOf?.wdEntries.map((w) => (
                  <tr key={w.id}>
                    <td className="border px-1.5 py-1">{formatDate(w.date)}</td>
                    <td className="border px-1.5 py-1">{w.party}</td>
                    <td className="border px-1.5 py-1">{w.payParty}</td>
                    <td className="border px-1.5 py-1 text-muted-foreground">{w.remarks || "—"}</td>
                    <td className="border px-1.5 py-1 text-right font-medium tabular-nums text-orange-600 dark:text-orange-400">
                      {formatMoney(w.amount)}
                    </td>
                    <td
                      className={`border px-1.5 py-1 text-right font-semibold tabular-nums ${w.balanceAfter < 0 ? "text-destructive" : ""}`}
                    >
                      {formatMoney(w.balanceAfter)}
                    </td>
                    <td className="border px-1 py-0.5 text-center">
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-6 w-6 text-destructive"
                        title="Delete — the ledger entry is reversed too"
                        onClick={() => void removeWd(w.id)}
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
              {!!wdListOf?.wdEntries.length && (
                <tfoot>
                  <tr className="font-semibold">
                    <td colSpan={4} className="border px-1.5 py-1">
                      Total Withdrawals
                    </td>
                    <td className="border px-1.5 py-1 text-right tabular-nums">
                      {formatMoney(wdListOf.wdLifetime)}
                    </td>
                    <td className="border px-1.5 py-1 text-right tabular-nums">
                      {formatMoney(wdListOf.runningBalance)}
                    </td>
                    <td className="border" />
                  </tr>
                </tfoot>
              )}
            </table>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setWdListOf(null)}>
              Close
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* -------- owner withdrawal entry form -------- */}
      <Dialog open={wdOpen} onOpenChange={setWdOpen}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>Owner Withdrawal</DialogTitle>
            <DialogDescription>
              On save it debits the owner&rsquo;s ledger, credits the bank/cash book, and drops the
              vehicle&rsquo;s running balance. No effect on net profit — a withdrawal is not an expense.
            </DialogDescription>
          </DialogHeader>
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1">
              <Label className="text-xs">Vehicle *</Label>
              <MasterCombobox
                options={vehicleOptions}
                value={wdVehicleId}
                onChange={setWdVehicleId}
                placeholder="Select vehicle..."
              />
            </div>
            <div className="space-y-1">
              <Label className="text-xs">Owner (Party) *</Label>
              <MasterCombobox
                options={malikOptions}
                value={wdPartyId}
                onChange={setWdPartyId}
                placeholder="Select owner..."
              />
            </div>
            <div className="space-y-1">
              <Label className="text-xs">Date *</Label>
              <DateInput value={wdDateText} onChange={setWdDateText} className="h-9" />
            </div>
            <div className="space-y-1">
              <Label className="text-xs">Amount *</Label>
              <Input
                type="number"
                inputMode="decimal"
                step="any"
                className="h-9 text-right tabular-nums"
                value={wdAmount || ""}
                onChange={(e) => setWdAmount(Number(e.target.value) || 0)}
                onFocus={(e) => e.target.select()}
              />
            </div>
            <div className="space-y-1">
              <Label className="text-xs">Paid From (Bank / Cash) *</Label>
              <MasterCombobox
                options={payOptions}
                value={wdPayPartyId}
                onChange={setWdPayPartyId}
                placeholder="Select bank/cash..."
              />
            </div>
            <div className="space-y-1">
              <Label className="text-xs">Remarks</Label>
              <Input
                className="h-9"
                value={wdRemarks}
                onChange={(e) => setWdRemarks(e.target.value)}
                placeholder="optional"
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setWdOpen(false)} disabled={wdSaving}>
              Cancel
            </Button>
            <Button onClick={() => void saveWd()} disabled={wdSaving}>
              {wdSaving ? "Saving..." : "Save Withdrawal"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
