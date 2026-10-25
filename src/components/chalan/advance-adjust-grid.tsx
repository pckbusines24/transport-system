"use client";

import * as React from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { NumInput } from "@/components/fleet/fields";
import { formatDate, formatMoney } from "@/lib/utils";
import type { OpenAdvance } from "@/lib/party-advance";
import { rankByMatch } from "@/lib/search-rank";

const r2 = (n: number) => Math.round(n * 100) / 100;

export interface AdvanceAdjustResult {
  /** adjustAmount keyed by advance id (zero entries already dropped) */
  lines: { advanceId: string; voucherNo: string; amount: number }[];
  total: number;
  error: string | null;
}

/**
 * Manual voucher-wise advance adjustment. The user decides which advance
 * voucher is consumed and how much from each — nothing is auto-allocated.
 * Used by both the Advance section and the Balance Payment section.
 */
export function AdvanceAdjustGrid({
  advances,
  values,
  onChange,
  payable,
  loading,
}: {
  advances: OpenAdvance[];
  /** advanceId -> amount to adjust */
  values: Record<string, number>;
  onChange: (next: Record<string, number>) => void;
  /** amount still due on the chalan; the total may not exceed it */
  payable: number;
  loading?: boolean;
}) {
  const [search, setSearch] = React.useState("");
  const [sortAsc, setSortAsc] = React.useState(true);

  const shown = React.useMemo(() => {
    const q = search.trim().toLowerCase();
    const list = q
      ? advances.filter((a) => a.voucherNo.toLowerCase().includes(q))
      : advances.slice();
    list.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
    if (!sortAsc) list.reverse();
    // exact voucher no. first, the date order kept within each group
    return rankByMatch(list, q, (a) => a.voucherNo);
  }, [advances, search, sortAsc]);

  const totalAvailable = r2(advances.reduce((s, a) => s + a.available, 0));
  const totalAdjusted = r2(
    advances.reduce((s, a) => s + (values[a.id] ?? 0), 0)
  );
  const remainingAdvance = r2(totalAvailable - totalAdjusted);
  const remainingPayable = r2(payable - totalAdjusted);

  const overRow = advances.find((a) => (values[a.id] ?? 0) > a.available + 0.009);
  const negative = advances.some((a) => (values[a.id] ?? 0) < 0);
  const error = negative
    ? "Adjustment amount cannot be negative."
    : overRow
      ? `Voucher ${overRow.voucherNo}: adjustment exceeds its available balance of ${formatMoney(overRow.available)}.`
      : totalAdjusted > payable + 0.009
        ? `Total adjusted ${formatMoney(totalAdjusted)} exceeds the payable amount ${formatMoney(payable)}.`
        : null;

  const set = (id: string, n: number) => onChange({ ...values, [id]: n });

  return (
    <div className="space-y-2 rounded-md border p-2">
      <div className="flex flex-wrap items-center gap-2">
        <Input
          className="h-8 w-48"
          placeholder="Search voucher no..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        <Button type="button" size="sm" variant="outline" onClick={() => setSortAsc((s) => !s)}>
          Date {sortAsc ? "↑" : "↓"}
        </Button>
        <Button
          type="button"
          size="sm"
          variant="ghost"
          onClick={() => onChange({})}
          disabled={totalAdjusted === 0}
        >
          Clear
        </Button>
      </div>

      {loading ? (
        <div className="p-2 text-sm text-muted-foreground">Loading advances...</div>
      ) : advances.length === 0 ? (
        <div className="p-2 text-sm text-muted-foreground">
          No advance paid to this party with an open balance.
        </div>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="text-xs text-muted-foreground">
              <tr className="border-b">
                <th className="p-1 text-left">Voucher No</th>
                <th className="p-1 text-left">Voucher Date</th>
                <th className="p-1 text-right">Original Amount</th>
                <th className="p-1 text-right">Already Adjusted</th>
                <th className="p-1 text-right">Available Balance</th>
                <th className="p-1 text-right">Adjust Amount</th>
              </tr>
            </thead>
            <tbody>
              {shown.map((a) => (
                <tr key={a.id} className="border-b last:border-0">
                  <td className="p-1 font-medium">{a.voucherNo}</td>
                  <td className="p-1">{formatDate(new Date(a.date))}</td>
                  <td className="p-1 text-right tabular-nums">{formatMoney(a.amount)}</td>
                  <td className="p-1 text-right tabular-nums">{formatMoney(a.consumed)}</td>
                  <td className="p-1 text-right tabular-nums">{formatMoney(a.available)}</td>
                  <td className="p-1">
                    <NumInput
                      className="h-8 w-32"
                      value={values[a.id] ?? 0}
                      onChange={(n) => set(a.id, n)}
                    />
                  </td>
                </tr>
              ))}
              {shown.length === 0 && (
                <tr>
                  <td colSpan={6} className="p-2 text-muted-foreground">
                    No voucher matches “{search}”.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      )}

      <div className="grid gap-2 sm:grid-cols-4">
        <Tile label="Total Available Advance" value={totalAvailable} />
        <Tile label="Total Adjusted" value={totalAdjusted} />
        <Tile label="Remaining Advance" value={remainingAdvance} />
        <Tile label="Remaining Challan Payable" value={remainingPayable} />
      </div>

      {error && <div className="text-xs text-destructive">{error}</div>}
    </div>
  );
}

/** Reduce the grid's raw values to what the server expects. */
export function advanceAdjustLines(
  advances: OpenAdvance[],
  values: Record<string, number>
): { advanceId: string; voucherNo: string; amount: number }[] {
  return advances
    .map((a) => ({ advanceId: a.id, voucherNo: a.voucherNo, amount: r2(values[a.id] ?? 0) }))
    .filter((l) => l.amount > 0.009);
}

/** Client-side mirror of the server validation; null when the grid is valid. */
export function advanceAdjustError(
  advances: OpenAdvance[],
  values: Record<string, number>,
  payable: number
): string | null {
  const total = r2(advances.reduce((s, a) => s + (values[a.id] ?? 0), 0));
  if (advances.some((a) => (values[a.id] ?? 0) < 0)) return "Adjustment amount cannot be negative.";
  const over = advances.find((a) => (values[a.id] ?? 0) > a.available + 0.009);
  if (over) return `Voucher ${over.voucherNo}: adjustment exceeds its available balance.`;
  if (total > payable + 0.009) return "Total adjusted exceeds the payable amount.";
  return null;
}

function Tile({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-md border p-2">
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className="font-medium tabular-nums">{formatMoney(value)}</div>
    </div>
  );
}
