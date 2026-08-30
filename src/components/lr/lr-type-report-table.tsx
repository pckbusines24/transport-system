"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import type { ColumnDef } from "@tanstack/react-table";
import { Pencil, Printer, Trash2 } from "lucide-react";
import { formatMoney } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useToast } from "@/components/ui/use-toast";
import { DataTable, type DataTableColumnMeta } from "@/components/data/data-table";
import { ExportButton } from "@/components/data/export-button";
import { deleteLr } from "@/app/(app)/lr/actions";

export interface LrTypeReportRow {
  id: string;
  lrNo: string;
  lrDate: string;
  route: string;
  consignor: string;
  consignee: string;
  vehicle: string;
  qty: number;
  chargeWt: number;
  freight: number;
  grandTotal: number;
  remarks: string;
}

/**
 * Cancelled / Paper Change LR report with the same row actions the LR register
 * has — open the LR in edit mode, print it (the print carries the CANCELLED /
 * PAPER CHANGE banner), or delete it. Delete goes through the ordinary `deleteLr`
 * action, so the LR is detached from chalans, invoices and PODs exactly as it is
 * anywhere else; nothing about these two types needs its own path.
 */
export function LrTypeReportTable({
  rows,
  fileName,
  emptyMessage,
  canDelete,
}: {
  rows: LrTypeReportRow[];
  fileName: string;
  emptyMessage: string;
  canDelete: boolean;
}) {
  const router = useRouter();
  const { toast } = useToast();
  const [toDelete, setToDelete] = React.useState<LrTypeReportRow | null>(null);
  const [busy, setBusy] = React.useState(false);

  const columns: ColumnDef<LrTypeReportRow>[] = React.useMemo(() => {
    const money = { numeric: true } satisfies DataTableColumnMeta<LrTypeReportRow>;
    const total = (key: keyof LrTypeReportRow) => ({
      numeric: true,
      total: (all: LrTypeReportRow[]) =>
        formatMoney(all.reduce((s, r) => s + (Number(r[key]) || 0), 0)),
    });

    return [
    { accessorKey: "lrNo", header: "LR No" },
    { accessorKey: "lrDate", header: "Date" },
    { accessorKey: "route", header: "Route" },
    { accessorKey: "consignor", header: "Consignor" },
    { accessorKey: "consignee", header: "Consignee" },
    { accessorKey: "vehicle", header: "Vehicle" },
    { accessorKey: "qty", header: "Qty", meta: money },
    { accessorKey: "chargeWt", header: "Charge Wt", meta: money },
    {
      accessorKey: "freight",
      header: "Freight",
      cell: ({ row }) => formatMoney(row.original.freight),
      meta: total("freight") satisfies DataTableColumnMeta<LrTypeReportRow>,
    },
    {
      accessorKey: "grandTotal",
      header: "Grand Total",
      cell: ({ row }) => formatMoney(row.original.grandTotal),
      meta: total("grandTotal") satisfies DataTableColumnMeta<LrTypeReportRow>,
    },
    { accessorKey: "remarks", header: "Reason / Remarks" },
    {
      id: "actions",
      header: "",
      enableSorting: false,
      cell: ({ row }) => (
        <div className="flex items-center gap-1" onClick={(e) => e.stopPropagation()}>
          <Button variant="ghost" size="icon" className="h-7 w-7" asChild>
            <Link href={`/lr?id=${row.original.id}`} title="View / Edit">
              <Pencil className="h-3.5 w-3.5" />
            </Link>
          </Button>
          <Button variant="ghost" size="icon" className="h-7 w-7" asChild>
            <Link href={`/print/lr/${row.original.id}`} target="_blank" title="Print">
              <Printer className="h-3.5 w-3.5" />
            </Link>
          </Button>
          {canDelete && (
            <Button
              variant="ghost"
              size="icon"
              className="h-7 w-7 text-destructive"
              title="Delete"
              onClick={() => setToDelete(row.original)}
            >
              <Trash2 className="h-3.5 w-3.5" />
            </Button>
          )}
        </div>
      ),
    },
    ];
  }, [canDelete]);

  const confirmDelete = async () => {
    if (!toDelete) return;
    setBusy(true);
    try {
      const res = await deleteLr(toDelete.id);
      if (res.ok) {
        toast({ title: `LR ${toDelete.lrNo} deleted` });
        setToDelete(null);
        router.refresh();
      } else {
        toast({ variant: "destructive", title: "Delete failed", description: res.error });
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-2">
      <div className="flex justify-end">
        <ExportButton
          rows={rows}
          fileName={fileName}
          columns={[
            { header: "LR No", key: "lrNo" },
            { header: "Date", key: "lrDate" },
            { header: "Route", key: "route" },
            { header: "Consignor", key: "consignor" },
            { header: "Consignee", key: "consignee" },
            { header: "Vehicle", key: "vehicle" },
            { header: "Qty", key: "qty", numeric: true },
            { header: "Charge Wt", key: "chargeWt", numeric: true },
            { header: "Freight", key: "freight", numeric: true },
            { header: "Grand Total", key: "grandTotal", numeric: true },
            { header: "Reason / Remarks", key: "remarks" },
          ]}
        />
      </div>
      <DataTable columns={columns} data={rows} emptyMessage={emptyMessage} />

      <Dialog open={!!toDelete} onOpenChange={(o: boolean) => !o && setToDelete(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete LR {toDelete?.lrNo}?</DialogTitle>
            <DialogDescription>
              The LR is soft-deleted and detached from any chalan, invoice and POD it was linked to,
              so it disappears from this report and every connected register at once.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setToDelete(null)} disabled={busy}>
              Cancel
            </Button>
            <Button variant="destructive" onClick={confirmDelete} disabled={busy}>
              {busy ? "Deleting..." : "Delete"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
