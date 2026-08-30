"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import type { ColumnDef } from "@tanstack/react-table";
import { Eye, FileSearch, Pencil, Plus, Printer, Trash2 } from "lucide-react";
import { formatDate, formatMoney } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { useToast } from "@/components/ui/use-toast";
import { DataTable, type DataTableColumnMeta } from "@/components/data/data-table";
import { ExportButton } from "@/components/data/export-button";
import { FilterBar } from "@/components/data/filter-bar";
import type { MasterOption } from "@/components/data/master-combobox";
import { deleteTrip } from "@/app/(app)/trips/actions";

export interface TripRegisterRow {
  id: string;
  tripNo: string;
  date: string;
  vehicle: string;
  driver: string;
  from: string;
  to: string;
  freight: number;
  approved: number;
  driverBalance: number;
  vehicleCost: number;
  status: string; // PENDING | SETTLED | NO BALANCE
}

const signed = (n: number) =>
  n === 0 ? "0" : `${n > 0 ? "+" : "−"}${formatMoney(Math.abs(n))}`;

export function TripRegisterClient({
  rows,
  vehicleOptions,
  driverOptions,
  canDelete,
}: {
  rows: TripRegisterRow[];
  vehicleOptions: MasterOption[];
  driverOptions: MasterOption[];
  canDelete: boolean;
}) {
  const router = useRouter();
  const { toast } = useToast();

  const columns: ColumnDef<TripRegisterRow>[] = React.useMemo(() => {
    const money = (
      key: keyof Pick<TripRegisterRow, "freight" | "approved" | "vehicleCost">,
      header: string
    ): ColumnDef<TripRegisterRow> => ({
      accessorKey: key,
      header,
      cell: ({ row }) => formatMoney(row.original[key]),
      meta: {
        numeric: true,
        total: (rs) => formatMoney(rs.reduce((s, r) => s + r[key], 0)),
      } satisfies DataTableColumnMeta<TripRegisterRow>,
    });

    return [
    { accessorKey: "tripNo", header: "Trip Sheet No" },
    { accessorKey: "date", header: "Date", cell: ({ row }) => formatDate(row.original.date) },
    { accessorKey: "vehicle", header: "Vehicle" },
    { accessorKey: "driver", header: "Driver" },
    { accessorKey: "from", header: "From" },
    { accessorKey: "to", header: "To" },
    money("freight", "Total Freight"),
    money("approved", "Approved Exp"),
    {
      accessorKey: "driverBalance",
      header: "Driver +/-",
      cell: ({ row }) => (
        <span className={row.original.driverBalance >= 0 ? "text-emerald-600" : "text-destructive"}>
          {signed(row.original.driverBalance)}
        </span>
      ),
      meta: { numeric: true } satisfies DataTableColumnMeta<TripRegisterRow>,
    },
    money("vehicleCost", "Vehicle Cost"),
    {
      accessorKey: "status",
      header: "Status",
      cell: ({ row }) =>
        row.original.status === "SETTLED" ? (
          <Badge>SETTLED</Badge>
        ) : row.original.status === "PENDING" ? (
          <Badge variant="outline">PENDING</Badge>
        ) : (
          <Badge variant="secondary">NO BALANCE</Badge>
        ),
    },
    {
      id: "actions",
      header: "",
      cell: ({ row }) => (
        <div className="flex gap-0.5" onClick={(e) => e.stopPropagation()}>
          <Button
            variant="ghost"
            size="icon"
            className="h-7 w-7"
            title="View trip sheet (read-only)"
            onClick={() => router.push(`/trips?id=${row.original.id}&view=1`)}
          >
            <Eye className="h-4 w-4" />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className="h-7 w-7"
            title="Edit trip sheet"
            onClick={() => router.push(`/trips?id=${row.original.id}`)}
          >
            <Pencil className="h-4 w-4" />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className="h-7 w-7"
            title="Print trip sheet"
            onClick={() => window.open(`/print/trip/${row.original.id}`, "_blank")}
          >
            <Printer className="h-4 w-4" />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className="h-7 w-7"
            title="View Complete Trip Summary (360°)"
            onClick={() => window.open(`/print/trip-summary/${row.original.id}`, "_blank")}
          >
            <FileSearch className="h-4 w-4" />
          </Button>
          {canDelete && (
            <Button
              variant="ghost"
              size="icon"
              className="h-7 w-7 text-destructive"
              title="Delete trip sheet"
              onClick={async () => {
                if (
                  !confirm(
                    `Delete trip sheet ${row.original.tripNo}? Linked chalans / broker slips return to pending.`
                  )
                )
                  return;
                const res = await deleteTrip(row.original.id);
                if (res.ok) {
                  toast({ title: `Trip ${row.original.tripNo} deleted` });
                  router.refresh();
                } else toast({ variant: "destructive", title: "Delete failed", description: res.error });
              }}
            >
              <Trash2 className="h-4 w-4" />
            </Button>
          )}
        </div>
      ),
    },
    ];
  }, [canDelete, router, toast]);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h1 className="text-xl font-semibold">Trip Sheet Register</h1>
        <div className="flex flex-wrap gap-2">
          <ExportButton
            rows={rows}
            fileName="trip-sheet-register"
            sheetName="Trip Sheets"
            columns={[
              { header: "Trip Sheet No", key: "tripNo" },
              { header: "Date", accessor: (r) => formatDate(r.date) },
              { header: "Vehicle", key: "vehicle" },
              { header: "Driver", key: "driver" },
              { header: "From", key: "from" },
              { header: "To", key: "to" },
              { header: "Total Freight", key: "freight", numeric: true },
              { header: "Approved Expenses", key: "approved", numeric: true },
              { header: "Driver +/-", key: "driverBalance", numeric: true },
              { header: "Vehicle Cost", key: "vehicleCost", numeric: true },
              { header: "Status", key: "status" },
            ]}
          />
          <Button size="sm" asChild>
            <Link href="/trips?new=1">
              <Plus className="h-4 w-4" /> New Trip Sheet
            </Link>
          </Button>
        </div>
      </div>
      <FilterBar
        filters={[
          { type: "text", key: "q", label: "Trip Sheet No..." },
          { type: "daterange", key: "date", label: "Trip Date" },
          { type: "combobox", key: "vehicle", label: "Vehicle", options: vehicleOptions },
          { type: "combobox", key: "driver", label: "Driver", options: driverOptions },
        ]}
      />
      <DataTable
        columns={columns}
        data={rows}
        emptyMessage="No trip sheets yet."
        onRowClick={(r) => router.push(`/trips?id=${r.id}`)}
      />
    </div>
  );
}
