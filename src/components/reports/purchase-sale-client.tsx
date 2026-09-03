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
import { sumAmounts, type RegisterAmounts } from "@/lib/registers/adjustments";

/**
 * MAIN VALUE ≠ ADJUSTMENTS — the table, the drill-down and the Excel export all
 * keep Main Value, Additions and Deductions in their own columns. Net Value is
 * the only place the three are combined.
 */
export interface PsRow {
  partyId: string;
  party: string;
  /** "YYYY-MM" -> MAIN value (never includes adjustments) */
  months: Record<string, number>;
  totals: RegisterAmounts;
  count: number;
  tds: number;
  docs: { refNo: string; dateIso: string; kind: string; amounts: RegisterAmounts }[];
}

const MONTH_SHORT = ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"];
const monthLabel = (m: string) => `${MONTH_SHORT[Number(m.slice(5)) - 1] ?? m} ${m.slice(2, 4)}`;

const money = (n: number) => (n ? formatMoney(n) : "");

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

  const monthTotals = monthKeys.map((m) => rows.reduce((s, r) => s + (r.months[m] ?? 0), 0));
  const grand = sumAmounts(rows.map((r) => r.totals));
  const tdsTotal = rows.reduce((s, r) => s + r.tds, 0);
  const docsTotal = rows.reduce((s, r) => s + r.count, 0);

  const netLabel = side === "SALE" ? "Net Receivable" : "Net Payable";

  // flat rows for Excel — month columns are dynamic, so rows are open records
  const exportRows: Record<string, string | number>[] = rows.map((r) => ({
    party: r.party,
    ...Object.fromEntries(monthKeys.map((m) => [m, r.months[m] ?? 0])),
    main: r.totals.main,
    detention: r.totals.detention,
    odc: r.totals.odcAmt,
    fine: r.totals.fineAmt,
    other: r.totals.otherAmt,
    additions: r.totals.additions,
    ld: r.totals.ldCharge,
    shortage: r.totals.shortageAmt,
    deductions: r.totals.deductions,
    net: r.totals.net,
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
            // month columns carry the MAIN value alone
            ...monthKeys.map((m) => ({ header: monthLabel(m), key: m, numeric: true as const })),
            { header: "Main Value", key: "main", numeric: true },
            { header: "Detention (+)", key: "detention", numeric: true },
            { header: "ODC (+)", key: "odc", numeric: true },
            { header: "Fine (+)", key: "fine", numeric: true },
            { header: "Other (+)", key: "other", numeric: true },
            { header: "Total Additions", key: "additions", numeric: true },
            { header: "LD Charge (−)", key: "ld", numeric: true },
            { header: "Shortage (−)", key: "shortage", numeric: true },
            { header: "Total Deductions", key: "deductions", numeric: true },
            { header: netLabel, key: "net", numeric: true },
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
              <th className="border-l px-3 py-2 text-right">Main Value</th>
              <th className="px-3 py-2 text-right">Additions (+)</th>
              <th className="px-3 py-2 text-right">Deductions (−)</th>
              <th className="px-3 py-2 text-right">{netLabel}</th>
              <th className="border-l px-3 py-2 text-right">Docs</th>
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
                    {money(r.months[m] ?? 0)}
                  </td>
                ))}
                <td className="border-l px-3 py-2 text-right font-semibold tabular-nums">
                  {formatMoney(r.totals.main)}
                </td>
                <td className="px-3 py-2 text-right tabular-nums">{money(r.totals.additions)}</td>
                <td className="px-3 py-2 text-right tabular-nums">{money(r.totals.deductions)}</td>
                <td className="px-3 py-2 text-right tabular-nums">{formatMoney(r.totals.net)}</td>
                <td className="border-l px-3 py-2 text-right tabular-nums">{r.count}</td>
                <td className="px-3 py-2 text-right tabular-nums">{money(r.tds)}</td>
              </tr>
            ))}
            {rows.length === 0 && (
              <tr>
                <td
                  colSpan={monthKeys.length + 7}
                  className="px-3 py-6 text-center text-muted-foreground"
                >
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
                    {money(t)}
                  </td>
                ))}
                <td className="border-l px-3 py-2 text-right tabular-nums">
                  {formatMoney(grand.main)}
                </td>
                <td className="px-3 py-2 text-right tabular-nums">{money(grand.additions)}</td>
                <td className="px-3 py-2 text-right tabular-nums">{money(grand.deductions)}</td>
                <td className="px-3 py-2 text-right tabular-nums">{formatMoney(grand.net)}</td>
                <td className="border-l px-3 py-2 text-right tabular-nums">{docsTotal}</td>
                <td className="px-3 py-2 text-right tabular-nums">{formatMoney(tdsTotal)}</td>
              </tr>
            </tfoot>
          )}
        </table>
      </div>

      {/* -------- party drill-down: every document, split the same way -------- */}
      <Dialog open={!!detailOf} onOpenChange={(o) => !o && setDetailOf(null)}>
        <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-4xl">
          <DialogHeader>
            <DialogTitle>
              {detailOf?.party} — {side === "SALE" ? "Sale" : "Purchase"}
            </DialogTitle>
            <DialogDescription>
              {detailOf?.count} documents · Main Value {formatMoney(detailOf?.totals.main ?? 0)} ·{" "}
              {netLabel} {formatMoney(detailOf?.totals.net ?? 0)}
              {detailOf?.tds ? ` · TDS ${formatMoney(detailOf.tds)}` : ""}
            </DialogDescription>
          </DialogHeader>
          <div className="overflow-x-auto">
            <table className="w-full border-collapse text-xs">
              <thead>
                <tr>
                  {[
                    "Date",
                    "Type",
                    "Ref No",
                    "Main Value",
                    "Detention",
                    "ODC",
                    "Fine",
                    "Other",
                    "LD (−)",
                    "Shortage (−)",
                    netLabel,
                  ].map((h, i) => (
                    <th
                      key={h}
                      className={`border px-1.5 py-1 font-semibold ${i >= 3 ? "text-right" : "text-left"}`}
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
                    <td className="border px-1.5 py-1 text-right font-medium tabular-nums">
                      {formatMoney(d.amounts.main)}
                    </td>
                    <td className="border px-1.5 py-1 text-right tabular-nums">
                      {money(d.amounts.detention)}
                    </td>
                    <td className="border px-1.5 py-1 text-right tabular-nums">
                      {money(d.amounts.odcAmt)}
                    </td>
                    <td className="border px-1.5 py-1 text-right tabular-nums">
                      {money(d.amounts.fineAmt)}
                    </td>
                    <td className="border px-1.5 py-1 text-right tabular-nums">
                      {money(d.amounts.otherAmt)}
                    </td>
                    <td className="border px-1.5 py-1 text-right tabular-nums">
                      {money(d.amounts.ldCharge)}
                    </td>
                    <td className="border px-1.5 py-1 text-right tabular-nums">
                      {money(d.amounts.shortageAmt)}
                    </td>
                    <td className="border px-1.5 py-1 text-right tabular-nums">
                      {formatMoney(d.amounts.net)}
                    </td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr className="font-semibold">
                  <td colSpan={3} className="border px-1.5 py-1">
                    Total
                  </td>
                  {(
                    [
                      detailOf?.totals.main,
                      detailOf?.totals.detention,
                      detailOf?.totals.odcAmt,
                      detailOf?.totals.fineAmt,
                      detailOf?.totals.otherAmt,
                      detailOf?.totals.ldCharge,
                      detailOf?.totals.shortageAmt,
                      detailOf?.totals.net,
                    ] as (number | undefined)[]
                  ).map((v, i) => (
                    <td key={i} className="border px-1.5 py-1 text-right tabular-nums">
                      {formatMoney(v ?? 0)}
                    </td>
                  ))}
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
