"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import type { ColumnDef } from "@tanstack/react-table";
import { Pencil, Printer, Trash2 } from "lucide-react";
import type { InvoiceKind } from "@prisma/client";
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
import { useToast } from "@/components/ui/use-toast";
import { DataTable, type DataTableColumnMeta } from "@/components/data/data-table";
import { ExportButton } from "@/components/data/export-button";
import { deleteInvoice } from "@/app/(app)/billing/actions";

export interface BillingRegisterRow {
  id: string;
  invoiceNo: string;
  invoiceDate: string;
  kind: InvoiceKind;
  party: string;
  lrCount: number;
  total: number;
  gstAmt: number;
  netTotal: number;
  advance: number;
  balance: number;
}

const KIND_PATHS: Record<InvoiceKind, string> = {
  PART_TRUCK: "part-truck",
  FULL_TRUCK: "full-truck",
  MANUAL: "manual",
  GST: "gst",
};

const KIND_LABELS: Record<InvoiceKind, string> = {
  PART_TRUCK: "Part Truck",
  FULL_TRUCK: "Full Truck",
  MANUAL: "Manual",
  GST: "GST",
};

const money = (
  key: keyof Pick<BillingRegisterRow, "total" | "gstAmt" | "netTotal" | "advance" | "balance">,
  header: string
): ColumnDef<BillingRegisterRow> => ({
  accessorKey: key,
  header,
  cell: ({ row }) => formatMoney(row.original[key]),
  meta: {
    numeric: true,
    total: (rows) => formatMoney(rows.reduce((s, r) => s + r[key], 0)),
  } satisfies DataTableColumnMeta<BillingRegisterRow>,
});

export function BillingRegisterTable({
  data,
  canDelete,
}: {
  data: BillingRegisterRow[];
  canDelete: boolean;
}) {
  const router = useRouter();
  const { toast } = useToast();
  const [toDelete, setToDelete] = React.useState<BillingRegisterRow | null>(null);
  const [deleting, setDeleting] = React.useState(false);

  const confirmDelete = async () => {
    if (!toDelete) return;
    setDeleting(true);
    try {
      const res = await deleteInvoice(toDelete.id);
      if (res.ok) {
        toast({ title: `Invoice ${toDelete.invoiceNo} deleted; its LRs are pending again` });
        setToDelete(null);
        router.refresh();
      } else {
        toast({ variant: "destructive", title: "Delete failed", description: res.error });
      }
    } finally {
      setDeleting(false);
    }
  };

  const columns: ColumnDef<BillingRegisterRow>[] = React.useMemo(() => [
    { accessorKey: "invoiceNo", header: "Invoice No" },
    {
      accessorKey: "invoiceDate",
      header: "Date",
      cell: ({ row }) => formatDate(row.original.invoiceDate),
    },
    {
      accessorKey: "kind",
      header: "Type",
      cell: ({ row }) => <Badge variant="secondary">{KIND_LABELS[row.original.kind]}</Badge>,
    },
    { accessorKey: "party", header: "Party" },
    {
      accessorKey: "lrCount",
      header: "LRs",
      cell: ({ row }) => (row.original.lrCount ? row.original.lrCount : ""),
      meta: { numeric: true } satisfies DataTableColumnMeta<BillingRegisterRow>,
    },
    money("total", "Total"),
    money("gstAmt", "GST"),
    money("netTotal", "Net Total"),
    money("advance", "Advance"),
    money("balance", "Balance"),
    {
      id: "actions",
      header: "",
      cell: ({ row }) => (
        <div className="flex gap-0.5" onClick={(e) => e.stopPropagation()}>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="h-7 w-7"
            title="Edit invoice"
            onClick={() =>
              router.push(`/billing/${KIND_PATHS[row.original.kind]}?id=${row.original.id}`)
            }
          >
            <Pencil className="h-4 w-4" />
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="h-7 w-7"
            title="Print invoice"
            onClick={() => window.open(`/print/invoice/${row.original.id}`, "_blank")}
          >
            <Printer className="h-4 w-4" />
          </Button>
          {canDelete && (
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="h-7 w-7 text-destructive"
              title="Delete invoice"
              onClick={() => setToDelete(row.original)}
            >
              <Trash2 className="h-4 w-4" />
            </Button>
          )}
        </div>
      ),
    } satisfies ColumnDef<BillingRegisterRow>,
  ], [canDelete, router]);

  return (
    <div className="space-y-2">
      <div className="flex justify-end">
        <ExportButton
          rows={data}
          fileName="billing-register"
          sheetName="Billing Register"
          columns={[
            { header: "Invoice No", key: "invoiceNo" },
            { header: "Date", accessor: (r) => formatDate(r.invoiceDate) },
            { header: "Type", accessor: (r) => KIND_LABELS[r.kind] },
            { header: "Party", key: "party" },
            { header: "LRs", key: "lrCount", numeric: true },
            { header: "Total", key: "total", numeric: true },
            { header: "GST", key: "gstAmt", numeric: true },
            { header: "Net Total", key: "netTotal", numeric: true },
            { header: "Advance", key: "advance", numeric: true },
            { header: "Balance", key: "balance", numeric: true },
          ]}
        />
      </div>
      <DataTable
        columns={columns}
        data={data}
        emptyMessage="No invoices found."
        onRowClick={(row) => router.push(`/billing/${KIND_PATHS[row.kind]}?id=${row.id}`)}
      />

      <Dialog open={!!toDelete} onOpenChange={(o) => !o && setToDelete(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete invoice {toDelete?.invoiceNo}?</DialogTitle>
            <DialogDescription>
              The invoice will be soft-deleted and its LRs revert to pending billing.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setToDelete(null)} disabled={deleting}>
              Cancel
            </Button>
            <Button variant="destructive" onClick={confirmDelete} disabled={deleting}>
              {deleting ? "Deleting..." : "Delete"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
