"use client";

import * as React from "react";
import type { ColumnDef } from "@tanstack/react-table";
import { formatDate, formatMoney } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import { DataTable, type DataTableColumnMeta } from "@/components/data/data-table";
import { ExportButton } from "@/components/data/export-button";

export interface TdsReportRow {
  id: string;
  voucherNo: string;
  voucherDate: string;
  voucherType: string;
  party: string;
  reference: string;
  gross: number;
  tdsPct: string;
  tdsAmt: number;
  netPayment: number;
  financialYear: string;
  remarks: string;
}

const money = (key: "gross" | "tdsAmt" | "netPayment", header: string): ColumnDef<TdsReportRow> => ({
  accessorKey: key,
  header,
  cell: ({ row }) => formatMoney(row.original[key]),
  meta: {
    numeric: true,
    total: (rows) => formatMoney(rows.reduce((s, r) => s + r[key], 0)),
  } satisfies DataTableColumnMeta<TdsReportRow>,
});

export function TdsReportTable({ rows }: { rows: TdsReportRow[] }) {
  const columns: ColumnDef<TdsReportRow>[] = React.useMemo(() => [
    { accessorKey: "voucherNo", header: "Voucher No" },
    {
      accessorKey: "voucherDate",
      header: "Voucher Date",
      cell: ({ row }) => formatDate(row.original.voucherDate),
    },
    {
      accessorKey: "voucherType",
      header: "Type",
      cell: ({ row }) => <Badge variant="outline">{row.original.voucherType}</Badge>,
    },
    { accessorKey: "party", header: "Party Name" },
    { accessorKey: "reference", header: "Bill / Reference No" },
    money("gross", "Gross Amount"),
    { accessorKey: "tdsPct", header: "TDS %", meta: { numeric: true } },
    money("tdsAmt", "TDS Amount"),
    money("netPayment", "Net Payment"),
    { accessorKey: "financialYear", header: "FY" },
    { accessorKey: "remarks", header: "Remarks" },
  ], []);

  return (
    <div className="space-y-2">
      <div className="flex justify-end">
        <ExportButton
          rows={rows}
          fileName="tds-report"
          sheetName="TDS Register"
          columns={[
            { header: "Voucher No", key: "voucherNo" },
            { header: "Voucher Date", accessor: (r) => formatDate(r.voucherDate) },
            { header: "Type", key: "voucherType" },
            { header: "Party Name", key: "party" },
            { header: "Bill / Reference No", key: "reference" },
            { header: "Gross Amount", key: "gross", numeric: true },
            { header: "TDS %", key: "tdsPct" },
            { header: "TDS Amount", key: "tdsAmt", numeric: true },
            { header: "Net Payment", key: "netPayment", numeric: true },
            { header: "Financial Year", key: "financialYear" },
            { header: "Remarks", key: "remarks" },
          ]}
        />
      </div>
      <DataTable columns={columns} data={rows} emptyMessage="No TDS entries found." />
    </div>
  );
}
