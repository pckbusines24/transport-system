"use client";

import * as React from "react";
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
import { ExportButton } from "@/components/data/export-button";

export interface PsRow {
  partyId: string;
  party: string;
  /** "YYYY-MM" -> amount */
  months: Record<string, number>;
  total: number;
  count: number;
  tds: number;
  docs: { refNo: string; dateIso: string; kind: string; amount: number }[];
}

const MONTH_SHORT = ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"];
const monthLabel = (m: string) => `${MONTH_SHORT[Number(m.slice(5)) - 1] ?? m} ${m.slice(2, 4)}`;

export function PurchaseSaleClient({
  rows,
  monthKeys,
  side,
}: {
  rows: PsRow[];
  monthKeys: string[];
  side: "SALE" | "PURCHASE";
}) {
  const [detailOf, setDetailOf] = React.useState<PsRow | null>(null);

  const monthTotals = monthKeys.map((m) =>
    rows.reduce((s, r) => s + (r.months[m] ?? 0), 0)
  );
  const grandTotal = rows.reduce((s, r) => s + r.total, 0);
  const tdsTotal = rows.reduce((s, r) => s + r.tds, 0);
  const docsTotal = rows.reduce((s, r) => s + r.count, 0);

  // flat rows for Excel — month columns are dynamic, so rows are open records
  const exportRows: Record<string, string | number>[] = rows.map((r) => ({
    party: r.party,
    ...Object.fromEntries(monthKeys.map((m) => [m, r.months[m] ?? 0])),
    total: r.total,
    docs: r.count,
    tds: r.tds,
  }));

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-end">
        <ExportButton
          rows={exportRows}
          fileName={`${side.toLowerCase()}-party-month`}
          sheetName={side === "SALE" ? "Sale Register" : "Purchase Register"}
          columns={[
            { header: "Party", key: "party" },
            ...monthKeys.map((m) => ({ header: monthLabel(m), key: m, numeric: true as const })),
            { header: "Total", key: "total", numeric: true },
            { header: "Docs", key: "docs", numeric: true },
            { header: "TDS", key: "tds", numeric: true },
          ]}
        />
      </div>

      <div className="overflow-x-auto rounded-lg border">
        <table className="w-full border-collapse text-sm">
          <thead>
            <tr className="border-b bg-muted/50 text-left text-xs uppercase tracking-wide text-muted-foreground">
              <th className="sticky left-0 bg-muted px-3 py-2">Party</th>
              {monthKeys.map((m) => (
                <th key={m} className="px-3 py-2 text-right">
                  {monthLabel(m)}
                </th>
              ))}
              <th className="px-3 py-2 text-right">Total</th>
              <th className="px-3 py-2 text-right">Docs</th>
              <th className="px-3 py-2 text-right">TDS {side === "SALE" ? "(kata gaya)" : "(aapne kata)"}</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr
                key={r.partyId}
                className="cursor-pointer border-b hover:bg-muted/40"
                onClick={() => setDetailOf(r)}
              >
                <td className="sticky left-0 bg-card px-3 py-2 font-medium">{r.party}</td>
                {monthKeys.map((m) => (
                  <td key={m} className="px-3 py-2 text-right tabular-nums">
                    {r.months[m] ? formatMoney(r.months[m]) : ""}
                  </td>
                ))}
                <td className="px-3 py-2 text-right font-semibold tabular-nums">
                  {formatMoney(r.total)}
                </td>
                <td className="px-3 py-2 text-right tabular-nums">{r.count}</td>
                <td className="px-3 py-2 text-right tabular-nums">
                  {r.tds ? formatMoney(r.tds) : ""}
                </td>
              </tr>
            ))}
            {rows.length === 0 && (
              <tr>
                <td colSpan={monthKeys.length + 4} className="px-3 py-6 text-center text-muted-foreground">
                  Nothing found in this period.
                </td>
              </tr>
            )}
          </tbody>
          {rows.length > 0 && (
            <tfoot>
              <tr className="border-t bg-muted/30 font-semibold">
                <td className="sticky left-0 bg-muted px-3 py-2">Total</td>
                {monthTotals.map((t, i) => (
                  <td key={monthKeys[i]} className="px-3 py-2 text-right tabular-nums">
                    {t ? formatMoney(t) : ""}
                  </td>
                ))}
                <td className="px-3 py-2 text-right tabular-nums">{formatMoney(grandTotal)}</td>
                <td className="px-3 py-2 text-right tabular-nums">{docsTotal}</td>
                <td className="px-3 py-2 text-right tabular-nums">{formatMoney(tdsTotal)}</td>
              </tr>
            </tfoot>
          )}
        </table>
      </div>

      {/* -------- party drill-down: every document -------- */}
      <Dialog open={!!detailOf} onOpenChange={(o) => !o && setDetailOf(null)}>
        <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>
              {detailOf?.party} — {side === "SALE" ? "Sale" : "Purchase"}
            </DialogTitle>
            <DialogDescription>
              {detailOf?.count} documents · Total {formatMoney(detailOf?.total ?? 0)}
              {detailOf?.tds ? ` · TDS ${formatMoney(detailOf.tds)}` : ""}
            </DialogDescription>
          </DialogHeader>
          <div className="overflow-x-auto">
            <table className="w-full border-collapse text-xs">
              <thead>
                <tr>
                  {["Date", "Type", "Ref No", "Amount"].map((h) => (
                    <th
                      key={h}
                      className={`border px-1.5 py-1 text-left font-semibold ${h === "Amount" ? "text-right" : ""}`}
                    >
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {detailOf?.docs.map((d, i) => (
                  <tr key={i}>
                    <td className="border px-1.5 py-1">{formatDate(d.dateIso)}</td>
                    <td className="border px-1.5 py-1">
                      <Badge variant="secondary" className="text-[10px]">
                        {d.kind}
                      </Badge>
                    </td>
                    <td className="border px-1.5 py-1 font-medium">{d.refNo}</td>
                    <td className="border px-1.5 py-1 text-right tabular-nums">
                      {formatMoney(d.amount)}
                    </td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr className="font-semibold">
                  <td colSpan={3} className="border px-1.5 py-1">
                    Total
                  </td>
                  <td className="border px-1.5 py-1 text-right tabular-nums">
                    {formatMoney(detailOf?.total ?? 0)}
                  </td>
                </tr>
              </tfoot>
            </table>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDetailOf(null)}>
              Close
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
