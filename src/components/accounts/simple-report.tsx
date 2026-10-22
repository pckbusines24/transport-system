"use client";

import * as React from "react";
import Link from "next/link";
import { type ColumnDef } from "@tanstack/react-table";
import { Link2 } from "lucide-react";
import { formatDate, formatMoney, toNum } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { DataTable, DataTableColumnMeta } from "@/components/data/data-table";
import { ExportButton, ExportColumn } from "@/components/data/export-button";

/** Serializable column spec so server components can define report tables. */
export interface ReportColumn {
  key: string;
  header: string;
  /**
   * money: right-aligned, formatted, totalled; date: dd/mm/yyyy;
   * badge: coloured pill; adjustments: "View Adjustments" popover fed by a
   * JSON AdvanceAdjustments payload (settlement history, never a money column)
   */
  kind?: "text" | "money" | "date" | "badge" | "adjustments";
  /** money columns get a totals footer unless disabled */
  total?: boolean;
  /** render cell as link to `${linkBase}${row[linkParamKey]}` */
  linkBase?: string;
  linkParamKey?: string;
}

export type ReportRow = Record<string, string | number | null>;

const BADGE_VARIANTS: Record<string, "default" | "secondary" | "destructive" | "outline"> = {
  RECEIPT: "default",
  PAYMENT: "destructive",
  CONTRA: "secondary",
};

export function SimpleReport({
  columns,
  rows,
  fileName,
  title,
  emptyMessage,
  fillViewport = false,
}: {
  columns: ReportColumn[];
  rows: ReportRow[];
  fileName: string;
  title?: string;
  emptyMessage?: string;
  /** register screens: rows scroll inside a screen-height box */
  fillViewport?: boolean;
}) {
  const columnDefs = React.useMemo<ColumnDef<ReportRow, unknown>[]>(
    () =>
      columns.map((c) => {
        const meta: DataTableColumnMeta<ReportRow> = {
          numeric: c.kind === "money",
          total:
            c.kind === "money" && c.total !== false
              ? (all: ReportRow[]) => formatMoney(all.reduce((s, r) => s + toNum(r[c.key]), 0))
              : undefined,
        };
        return {
          id: c.key,
          accessorKey: c.key,
          header: c.header,
          meta,
          cell: ({ row }) => {
            const v = row.original[c.key];
            let content: React.ReactNode;
            if (v === null || v === undefined || v === "") content = "";
            else if (c.kind === "money") content = formatMoney(toNum(v));
            else if (c.kind === "date") content = formatDate(String(v));
            else if (c.kind === "badge")
              content = (
                <Badge variant={BADGE_VARIANTS[String(v)] ?? "outline"}>{String(v)}</Badge>
              );
            else if (c.kind === "adjustments") return <AdjustmentsCell value={String(v)} />;
            else content = String(v);
            if (c.linkBase && c.linkParamKey && row.original[c.linkParamKey]) {
              return (
                <Link
                  href={`${c.linkBase}${row.original[c.linkParamKey]}`}
                  className="text-primary underline-offset-2 hover:underline"
                >
                  {content}
                </Link>
              );
            }
            return content;
          },
        };
      }),
    [columns]
  );

  const exportColumns = React.useMemo<ExportColumn<ReportRow>[]>(
    () =>
      columns.map((c) => ({
        header: c.header,
        numeric: c.kind === "money",
        accessor: (row: ReportRow) => {
          const v = row[c.key];
          if (c.kind === "money") return toNum(v);
          if (c.kind === "date" && v) return formatDate(String(v));
          // exports get the history flattened to one readable cell
          if (c.kind === "adjustments") return summariseAdjustments(String(v ?? ""));
          return v ?? "";
        },
      })),
    [columns]
  );

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-medium text-muted-foreground">{title}</h2>
        <ExportButton rows={rows} columns={exportColumns} fileName={fileName} />
      </div>
      <DataTable
        fillViewport={fillViewport}
        columns={columnDefs}
        data={rows}
        emptyMessage={emptyMessage}
      />
    </div>
  );
}

/** Settlement history carried on an advance voucher's ledger row. */
interface AdvanceAdjustments {
  voucherNo: string;
  amount: number;
  consumed: number;
  remaining: number;
  uses: { refNo: string; amount: number; date: string }[];
}

function parseAdjustments(raw: string): AdvanceAdjustments | null {
  if (!raw) return null;
  try {
    return JSON.parse(raw) as AdvanceAdjustments;
  } catch {
    return null;
  }
}

function summariseAdjustments(raw: string): string {
  const a = parseAdjustments(raw);
  if (!a) return "";
  if (!a.uses.length) return `Unadjusted advance ${formatMoney(a.amount)}`;
  return `${a.uses.map((u) => `${u.refNo} ${formatMoney(u.amount)}`).join(", ")} | Remaining ${formatMoney(a.remaining)}`;
}

/**
 * "View Adjustments" for an advance voucher. An adjustment is a reference
 * link, not a transaction — it never appears as its own ledger row, so the
 * history lives here, on the voucher that actually moved the money.
 */
function AdjustmentsCell({ value }: { value: string }) {
  const adj = parseAdjustments(value);
  if (!adj) return null;
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button variant="ghost" size="sm" className="h-7 gap-1 px-2 text-xs">
          <Link2 className="h-3.5 w-3.5" />
          {adj.uses.length ? `${adj.uses.length} adj` : "Advance"}
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-80">
        <div className="space-y-2 text-sm">
          <div className="font-medium">Voucher {adj.voucherNo}</div>
          <div className="flex justify-between text-xs text-muted-foreground">
            <span>Advance Amount</span>
            <span className="tabular-nums">{formatMoney(adj.amount)}</span>
          </div>
          <div className="border-t pt-2">
            <div className="mb-1 text-xs font-semibold uppercase text-muted-foreground">
              Adjustment History
            </div>
            {adj.uses.length === 0 ? (
              <div className="text-xs text-muted-foreground">
                Not adjusted against any document yet.
              </div>
            ) : (
              adj.uses.map((u, i) => (
                <div key={i} className="flex justify-between gap-2 py-0.5 text-xs">
                  <span>
                    {u.refNo}
                    <span className="text-muted-foreground"> — {formatDate(u.date)}</span>
                  </span>
                  <span className="tabular-nums">{formatMoney(u.amount)}</span>
                </div>
              ))
            )}
          </div>
          <div className="flex justify-between border-t pt-2 font-medium">
            <span>Remaining Advance</span>
            <span className="tabular-nums">{formatMoney(adj.remaining)}</span>
          </div>
          <div className="text-[11px] text-muted-foreground">
            Adjustments are reference links — they do not create ledger entries.
          </div>
        </div>
      </PopoverContent>
    </Popover>
  );
}
