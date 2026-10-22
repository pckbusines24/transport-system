"use client";

import * as React from "react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { formatDate, formatMoney, formatWt } from "@/lib/utils";

export interface PendingLrRow {
  id: string;
  lrNo: string;
  lrDate: string; // ISO
  source: string;
  destination: string;
  consignor: string;
  qty: number;
  actualWt: number;
  chargeWt: number;
  rate: number;
  rateBasis: "QTY" | "ACTUAL_WT" | "CHARGE_WT" | "FIXED";
  remarks: string;
  freight: number;
}

/**
 * Selectable grid of pending LRs (checkboxes + select all). "Add selected"
 * moves picked rows into the parent's LR list.
 */
export function LrPicker({
  rows,
  onAdd,
  title = "Pending LRs",
}: {
  rows: PendingLrRow[];
  onAdd: (rows: PendingLrRow[]) => void;
  title?: string;
}) {
  const [checked, setChecked] = React.useState<Record<string, boolean>>({});
  const selected = rows.filter((r) => checked[r.id]);
  const allChecked = rows.length > 0 && selected.length === rows.length;

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <div className="text-sm font-medium">
          {title} <span className="text-muted-foreground">({rows.length})</span>
        </div>
        <Button
          type="button"
          size="sm"
          disabled={selected.length === 0}
          onClick={() => {
            onAdd(selected);
            setChecked({});
          }}
        >
          Add selected ({selected.length})
        </Button>
      </div>
      <div className="max-h-64 overflow-auto rounded-md border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="w-8">
                <Checkbox
                  checked={allChecked}
                  onCheckedChange={(v) => {
                    const next: Record<string, boolean> = {};
                    if (v) rows.forEach((r) => (next[r.id] = true));
                    setChecked(next);
                  }}
                  aria-label="Select all"
                />
              </TableHead>
              <TableHead className="text-xs">LR No</TableHead>
              <TableHead className="text-xs">Date</TableHead>
              <TableHead className="text-xs">Source</TableHead>
              <TableHead className="text-xs">Destination</TableHead>
              <TableHead className="text-xs">Consignor</TableHead>
              <TableHead className="text-right text-xs">Qty</TableHead>
              <TableHead className="text-right text-xs">Actual Wt</TableHead>
              <TableHead className="text-right text-xs">Charge Wt</TableHead>
              <TableHead className="text-right text-xs">Rate</TableHead>
              <TableHead className="text-right text-xs">Booking Freight</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.length === 0 ? (
              <TableRow>
                <TableCell colSpan={11} className="h-16 text-center text-muted-foreground">
                  No pending LRs.
                </TableCell>
              </TableRow>
            ) : (
              rows.map((r) => (
                <TableRow
                  key={r.id}
                  className="cursor-pointer"
                  onClick={() => setChecked((p) => ({ ...p, [r.id]: !p[r.id] }))}
                >
                  <TableCell onClick={(e) => e.stopPropagation()}>
                    <Checkbox
                      checked={!!checked[r.id]}
                      onCheckedChange={(v) => setChecked((p) => ({ ...p, [r.id]: !!v }))}
                      aria-label={`Select LR ${r.lrNo}`}
                    />
                  </TableCell>
                  <TableCell>{r.lrNo}</TableCell>
                  <TableCell>{formatDate(r.lrDate)}</TableCell>
                  <TableCell>{r.source}</TableCell>
                  <TableCell>{r.destination}</TableCell>
                  <TableCell>{r.consignor}</TableCell>
                  <TableCell className="text-right tabular-nums">{r.qty}</TableCell>
                  <TableCell className="text-right tabular-nums">{formatWt(r.actualWt)}</TableCell>
                  <TableCell className="text-right tabular-nums">{formatWt(r.chargeWt)}</TableCell>
                  <TableCell className="text-right tabular-nums">{formatMoney(r.rate)}</TableCell>
                  <TableCell className="text-right tabular-nums">{formatMoney(r.freight)}</TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}

/** Read-only list of LRs already on the document, with remove buttons. */
export function SelectedLrList({
  rows,
  onRemove,
}: {
  rows: PendingLrRow[];
  onRemove: (id: string) => void;
}) {
  if (rows.length === 0)
    return <div className="rounded-md border p-4 text-sm text-muted-foreground">No LRs added.</div>;
  return (
    <div className="overflow-auto rounded-md border">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead className="text-xs">LR No</TableHead>
            <TableHead className="text-xs">Date</TableHead>
            <TableHead className="text-xs">Source</TableHead>
            <TableHead className="text-xs">Destination</TableHead>
            <TableHead className="text-xs">Consignor</TableHead>
            <TableHead className="text-right text-xs">Qty</TableHead>
            <TableHead className="text-right text-xs">Actual Wt</TableHead>
            <TableHead className="text-right text-xs">Charge Wt</TableHead>
            <TableHead className="text-right text-xs">Rate</TableHead>
            <TableHead className="text-right text-xs">Booking Freight</TableHead>
            <TableHead className="w-10 text-xs" />
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((r) => (
            <TableRow key={r.id}>
              <TableCell>{r.lrNo}</TableCell>
              <TableCell>{formatDate(r.lrDate)}</TableCell>
              <TableCell>{r.source}</TableCell>
              <TableCell>{r.destination}</TableCell>
              <TableCell>{r.consignor}</TableCell>
              <TableCell className="text-right tabular-nums">{r.qty}</TableCell>
              <TableCell className="text-right tabular-nums">{formatWt(r.actualWt)}</TableCell>
              <TableCell className="text-right tabular-nums">{formatWt(r.chargeWt)}</TableCell>
              <TableCell className="text-right tabular-nums">{formatMoney(r.rate)}</TableCell>
              <TableCell className="text-right tabular-nums">{formatMoney(r.freight)}</TableCell>
              <TableCell>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="h-7 px-2 text-destructive"
                  onClick={() => onRemove(r.id)}
                >
                  Remove
                </Button>
              </TableCell>
            </TableRow>
          ))}
          <TableRow className="font-medium">
            <TableCell colSpan={5}>Total ({rows.length} LRs)</TableCell>
            <TableCell className="text-right tabular-nums">
              {rows.reduce((s, r) => s + r.qty, 0)}
            </TableCell>
            <TableCell className="text-right tabular-nums">
              {formatWt(rows.reduce((s, r) => s + r.actualWt, 0))}
            </TableCell>
            <TableCell className="text-right tabular-nums">
              {formatWt(rows.reduce((s, r) => s + r.chargeWt, 0))}
            </TableCell>
            <TableCell />
            <TableCell className="text-right tabular-nums">
              {formatMoney(rows.reduce((s, r) => s + r.freight, 0))}
            </TableCell>
            <TableCell />
          </TableRow>
        </TableBody>
      </Table>
    </div>
  );
}
