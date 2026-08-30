"use client";

import type { ColumnDef } from "@tanstack/react-table";
import type { MasterOption } from "@/components/data/master-combobox";
import { SimpleMaster, type FieldDef } from "@/components/masters/simple-master";
import * as React from "react";
import { Upload } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useToast } from "@/components/ui/use-toast";
import { saveRate, deleteRate, importRatesFromExcel } from "@/app/(app)/masters/rates/actions";
import { formatMoney } from "@/lib/utils";

export interface RateRow {
  id: string;
  partyId: string;
  partyName: string;
  /** all products sharing this rate row; empty = ALL products */
  productIds: string[];
  productNames: string[];
  sourceCityId: string;
  sourceName: string;
  destCityId: string;
  destName: string;
  rate: number;
  rateBasis: string;
  hamali: number;
  hamaliBasis: string;
  preBhada: number;
  preBhadaBasis: string;
  dCharge: number;
  dChargeBasis: string;
  stationery: number;
  stationeryBasis: string;
  crossing: number;
  crossingBasis: string;
}

const BASIS = [
  { value: "QTY", label: "Per Qty" },
  { value: "ACTUAL_WT", label: "Actual Wt" },
  { value: "CHARGE_WT", label: "Charge Wt" },
  { value: "FIXED", label: "Fixed" },
];

const basisLabel = (b: string) => BASIS.find((x) => x.value === b)?.label ?? b;

const columns: ColumnDef<RateRow, unknown>[] = [
  { accessorKey: "partyName", header: "Party" },
  {
    accessorKey: "productNames",
    header: "Products",
    cell: ({ row }) => {
      const names = row.original.productNames;
      if (!names.length) return <span className="text-muted-foreground">ALL</span>;
      const shown = names.slice(0, 3);
      return (
        <span className="flex flex-wrap items-center gap-1">
          {shown.map((n) => (
            <span
              key={n}
              className="rounded-md bg-secondary px-1.5 py-0.5 text-xs font-medium text-secondary-foreground"
            >
              {n}
            </span>
          ))}
          {names.length > 3 && (
            <span className="text-xs text-muted-foreground" title={names.join(", ")}>
              +{names.length - 3} more
            </span>
          )}
        </span>
      );
    },
  },
  { accessorKey: "sourceName", header: "From" },
  { accessorKey: "destName", header: "To" },
  {
    accessorKey: "rate",
    header: "Rate",
    cell: ({ row }) => formatMoney(row.original.rate),
    meta: { numeric: true },
  },
  {
    accessorKey: "rateBasis",
    header: "Basis",
    cell: ({ row }) => basisLabel(row.original.rateBasis),
  },
  {
    accessorKey: "hamali",
    header: "Hamali",
    cell: ({ row }) => formatMoney(row.original.hamali),
    meta: { numeric: true },
  },
  {
    accessorKey: "dCharge",
    header: "D. Charge",
    cell: ({ row }) => formatMoney(row.original.dCharge),
    meta: { numeric: true },
  },
  {
    accessorKey: "crossing",
    header: "Crossing",
    cell: ({ row }) => formatMoney(row.original.crossing),
    meta: { numeric: true },
  },
];

function amountWithBasis(name: string, label: string, options: MasterOption[]): FieldDef[] {
  return [
    { name, label, type: "number" },
    { name: `${name}Basis`, label: `${label} Basis`, type: "select", options },
  ];
}

export function RatesClient({
  rows,
  partyOptions,
  productOptions,
  cityOptions,
  canDelete,
}: {
  rows: RateRow[];
  partyOptions: MasterOption[];
  productOptions: MasterOption[];
  cityOptions: MasterOption[];
  canDelete: boolean;
}) {
  const { toast } = useToast();
  const fileRef = React.useRef<HTMLInputElement>(null);
  const [importing, setImporting] = React.useState(false);

  const handleImport = async (file: File) => {
    setImporting(true);
    try {
      const fd = new FormData();
      fd.append("file", file);
      const res = await importRatesFromExcel(fd);
      toast({
        title: `Import finished: ${res.created} created, ${res.updated} updated`,
        description: res.errors.length
          ? `${res.errors.length} row(s) skipped — ${res.errors.slice(0, 3).join(" ")}`
          : undefined,
        variant: res.errors.length ? "destructive" : undefined,
      });
    } finally {
      setImporting(false);
      if (fileRef.current) fileRef.current.value = "";
    }
  };

  const numeric = [
    "rate",
    "hamali",
    "preBhada",
    "dCharge",
    "stationery",
    "crossing",
  ] as const;
  return (
    <div>
      <div className="flex justify-end px-4 pt-4">
        <input
          ref={fileRef}
          type="file"
          accept=".xlsx"
          className="hidden"
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) void handleImport(f);
          }}
        />
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={importing}
          onClick={() => fileRef.current?.click()}
          title="Excel with headers: Party, Product, Source, Destination, Rate, Basis, Hamali, Pre Bhada, D Charge, Stationery, Crossing. In the Product cell you can write several products at once, separated by commas (PLATE, ANGLE, CHANNEL)"
        >
          <Upload className="h-4 w-4" />
          {importing ? "Importing..." : "Import from Excel"}
        </Button>
      </div>
    <SimpleMaster
      title="Rate Setup"
      newLabel="New Rate"
      rows={rows}
      columns={columns}
      exportColumns={[
        { header: "Party", key: "partyName" },
        { header: "Products", accessor: (r) => r.productNames.join(", ") || "ALL" },
        { header: "From", key: "sourceName" },
        { header: "To", key: "destName" },
        { header: "Rate", key: "rate", numeric: true },
        { header: "Basis", accessor: (r) => basisLabel(r.rateBasis) },
        { header: "Hamali", key: "hamali", numeric: true },
        { header: "Pre-Bhada", key: "preBhada", numeric: true },
        { header: "D. Charge", key: "dCharge", numeric: true },
        { header: "Stationery", key: "stationery", numeric: true },
        { header: "Crossing", key: "crossing", numeric: true },
      ]}
      exportName="rate-setup"
      filters={[
        { type: "combobox", key: "party", label: "Party", options: partyOptions },
        { type: "combobox", key: "source", label: "Source", options: cityOptions },
        { type: "combobox", key: "dest", label: "Destination", options: cityOptions },
      ]}
      fields={[
        { name: "partyId", label: "Party *", type: "combobox", options: partyOptions, span2: true },
        {
          name: "productIds",
          label: "Products (tick to select multiple · blank = all)",
          type: "multicombobox",
          options: productOptions,
          placeholder: "Type to search & tick products...",
          span2: true,
        },
        { name: "sourceCityId", label: "Source City *", type: "combobox", options: cityOptions },
        { name: "destCityId", label: "Destination City *", type: "combobox", options: cityOptions },
        ...amountWithBasis("rate", "Freight Rate", BASIS),
        ...amountWithBasis("hamali", "Hamali", BASIS),
        ...amountWithBasis("preBhada", "Pre-Bhada", BASIS),
        ...amountWithBasis("dCharge", "Delivery Charge", BASIS),
        ...amountWithBasis("stationery", "Stationery", BASIS),
        ...amountWithBasis("crossing", "Crossing", BASIS),
      ]}
      defaults={{
        productIds: [],
        rate: 0,
        rateBasis: "CHARGE_WT",
        hamali: 0,
        hamaliBasis: "FIXED",
        preBhada: 0,
        preBhadaBasis: "FIXED",
        dCharge: 0,
        dChargeBasis: "FIXED",
        stationery: 0,
        stationeryBasis: "FIXED",
        crossing: 0,
        crossingBasis: "FIXED",
      }}
      toForm={(r) => ({ ...r })}
      getId={(r) => r.id}
      save={saveRate}
      remove={deleteRate}
      canDelete={canDelete}
      transform={(f) =>
        numeric.reduce((acc, k) => ({ ...acc, [k]: Number(acc[k as keyof typeof acc]) || 0 }), {
          ...f,
        })
      }
      dialogClassName="max-h-[90vh] overflow-y-auto sm:max-w-2xl"
    />
    </div>
  );
}
