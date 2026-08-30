"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { type ColumnDef } from "@tanstack/react-table";
import { Pencil, Trash2 } from "lucide-react";
import { formatDate, formatMoney } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { useToast } from "@/components/ui/use-toast";
import { DataTable, DataTableColumnMeta } from "@/components/data/data-table";
import { ExportButton, ExportColumn } from "@/components/data/export-button";
import { deleteVoucher } from "@/app/(app)/accounts/vouchers/actions";

export interface RegisterRow {
  id: string;
  voucherNo: string;
  voucherDate: string; // ISO
  type: string;
  partyName: string | null;
  moduleLink: string;
  bankName: string | null;
  chequeNo: string | null;
  amount: number;
  tdsAmt: number;
  deduction: number;
  netAmount: number;
  /** 1 = auto-created chalan/slip settlement voucher (delete-and-redo only) */
  settlement: number;
  [key: string]: string | number | null;
}

const TYPE_VARIANT: Record<string, "default" | "destructive" | "secondary" | "outline"> = {
  RECEIPT: "default",
  PAYMENT: "destructive",
  CONTRA: "secondary",
  JOURNAL: "outline",
};

export interface VoucherRegisterTotals {
  amount: number;
  tdsAmt: number;
  deduction: number;
  netAmount: number;
}

export function VoucherRegisterTable({
  rows,
  canDelete,
  totals,
}: {
  rows: RegisterRow[];
  canDelete: boolean;
  /** register-wide totals over the FULL filtered set (rows may be one page) */
  totals?: VoucherRegisterTotals;
}) {
  const router = useRouter();
  const { toast } = useToast();

  const columns = React.useMemo<ColumnDef<RegisterRow, unknown>[]>(() => {
    // footer totals: prefer the server-computed full-set figure; fall back to
    // summing the visible rows when the prop is absent
    const money = (key: keyof VoucherRegisterTotals): DataTableColumnMeta<RegisterRow> => ({
      numeric: true,
      total: totals
        ? formatMoney(totals[key])
        : (rs: RegisterRow[]) => formatMoney(rs.reduce((s, r) => s + (Number(r[key]) || 0), 0)),
    });
    const cols: ColumnDef<RegisterRow, unknown>[] = [
      { accessorKey: "voucherNo", header: "Voucher No" },
      {
        accessorKey: "voucherDate",
        header: "Date",
        cell: ({ row }) => formatDate(new Date(row.original.voucherDate)),
      },
      {
        accessorKey: "type",
        header: "Type",
        cell: ({ row }) => (
          <Badge variant={TYPE_VARIANT[row.original.type] ?? "secondary"}>
            {row.original.type}
          </Badge>
        ),
      },
      { accessorKey: "partyName", header: "Party" },
      {
        accessorKey: "moduleLink",
        header: "Module",
        cell: ({ row }) => row.original.moduleLink.replace(/_/g, " "),
      },
      { accessorKey: "bankName", header: "Bank" },
      { accessorKey: "chequeNo", header: "Cheque No" },
      {
        accessorKey: "amount",
        header: "Amount",
        meta: money("amount"),
        cell: ({ row }) => formatMoney(row.original.amount),
      },
      {
        accessorKey: "tdsAmt",
        header: "TDS",
        meta: money("tdsAmt"),
        cell: ({ row }) => formatMoney(row.original.tdsAmt),
      },
      {
        accessorKey: "deduction",
        header: "Deduction",
        meta: money("deduction"),
        cell: ({ row }) => formatMoney(row.original.deduction),
      },
      {
        accessorKey: "netAmount",
        header: "Net",
        meta: money("netAmount"),
        cell: ({ row }) => formatMoney(row.original.netAmount),
      },
    ];
    cols.push({
      id: "actions",
      header: "",
      enableSorting: false,
      cell: ({ row }) => (
        <div className="flex gap-0.5">
          {row.original.settlement ? (
            // auto-created settlement voucher: figures live with the chalan /
            // slip — delete here and re-settle from the document instead
            <span
              className="px-1 text-[10px] text-muted-foreground"
              title="Settlement voucher of a Chalan/slip — to edit, delete it and settle again from the document"
            >
              settle
            </span>
          ) : (
            <Button asChild variant="ghost" size="icon" className="h-7 w-7">
              <Link
                href={`/accounts/vouchers?edit=${row.original.id}`}
                title="Edit voucher"
                onClick={(e) => e.stopPropagation()}
              >
                <Pencil className="h-4 w-4" />
              </Link>
            </Button>
          )}
          {canDelete && (
            <Button
              variant="ghost"
              size="icon"
              className="h-7 w-7 text-destructive"
              onClick={async (e) => {
                e.stopPropagation();
                if (!confirm(`Delete voucher ${row.original.voucherNo}?`)) return;
                const res = await deleteVoucher(row.original.id);
                if (res.ok) {
                  toast({ title: "Voucher deleted" });
                  router.refresh();
                } else {
                  toast({ variant: "destructive", title: "Delete failed", description: res.error });
                }
              }}
            >
              <Trash2 className="h-4 w-4" />
            </Button>
          )}
        </div>
      ),
    });
    return cols;
  }, [canDelete, router, toast, totals]);

  const exportColumns: ExportColumn<RegisterRow>[] = [
    { header: "Voucher No", key: "voucherNo" },
    { header: "Date", accessor: (r) => formatDate(new Date(r.voucherDate)) },
    { header: "Type", key: "type" },
    { header: "Party", key: "partyName" },
    { header: "Module", key: "moduleLink" },
    { header: "Bank", key: "bankName" },
    { header: "Cheque No", key: "chequeNo" },
    { header: "Amount", key: "amount", numeric: true },
    { header: "TDS", key: "tdsAmt", numeric: true },
    { header: "Deduction", key: "deduction", numeric: true },
    { header: "Net", key: "netAmount", numeric: true },
  ];

  return (
    <div className="space-y-2">
      <div className="flex justify-end">
        <ExportButton rows={rows} columns={exportColumns} fileName="voucher-register" />
      </div>
      <DataTable columns={columns} data={rows} emptyMessage="No vouchers found." />
    </div>
  );
}
