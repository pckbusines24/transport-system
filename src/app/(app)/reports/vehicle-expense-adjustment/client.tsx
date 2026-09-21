"use client";

import * as React from "react";
import { ChevronDown, ChevronRight } from "lucide-react";
import { formatDate, formatMoney } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { InfoHint } from "@/components/ui/info-hint";
import { StatCard } from "@/components/ui/stat";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { ExportButton } from "@/components/data/export-button";
import { FilterBar, type FilterOption } from "@/components/data/filter-bar";
import type { AdjEntry, AdjResult, AdjVehicleRow } from "./data";

const money = (n: number) => formatMoney(n);
const signed = (n: number) => (n > 0 ? `+${money(n)}` : n < 0 ? `−${money(-n)}` : money(0));
const diffClass = (n: number) => (n > 0.009 ? "text-destructive" : n < -0.009 ? "text-warning" : "text-success");

const Th = ({ children, right }: { children: React.ReactNode; right?: boolean }) => (
  <TableHead className={`h-8 whitespace-nowrap text-xs ${right ? "text-right" : ""}`}>{children}</TableHead>
);
const Td = ({ children, right, strong, className = "", colSpan }: { children: React.ReactNode; right?: boolean; strong?: boolean; className?: string; colSpan?: number }) => (
  <TableCell colSpan={colSpan} className={`py-1.5 text-xs ${right ? "text-right tabular-nums" : ""} ${strong ? "font-semibold" : ""} ${className}`}>
    {children}
  </TableCell>
);

/** Date-wise drill-down for one vehicle. */
function EntryTable({ rows }: { rows: AdjEntry[] }) {
  if (!rows.length) return <p className="px-2 py-1 text-xs text-muted-foreground">No entries.</p>;
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <Th>Date</Th>
          <Th>Type</Th>
          <Th>Expense Head</Th>
          <Th right>Amount</Th>
          <Th>Source</Th>
          <Th>Doc No.</Th>
          <Th>Doc Date</Th>
          <Th>Vehicle No.</Th>
          <Th>Particular</Th>
          <Th>Chalan Status</Th>
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.map((r) => (
          <TableRow key={r.id} className={r.status === "Cancelled" ? "bg-destructive/5" : ""}>
            <Td>{formatDate(r.date)}</Td>
            <Td>
              <Badge variant={r.kind === "DEDUCTED" ? "warning" : "info"}>{r.kind === "DEDUCTED" ? "Deducted" : "Booked"}</Badge>
            </Td>
            <Td>{r.head}</Td>
            <Td right strong>{money(r.amount)}</Td>
            <Td>{r.source}</Td>
            <Td strong>{r.docNo}</Td>
            <Td>{formatDate(r.docDate)}</Td>
            <Td>{r.vehicleNo}</Td>
            <Td className="max-w-[22rem]">{r.particular}</Td>
            <Td>
              {r.source === "Chalan" ? (
                <Badge variant={r.status === "Cancelled" ? "destructive" : "success"}>{r.status}</Badge>
              ) : (
                "—"
              )}
            </Td>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

function VehicleRow({ v }: { v: AdjVehicleRow }) {
  const [open, setOpen] = React.useState(false);
  const cancelled = v.entries.filter((e) => e.status === "Cancelled").length;
  return (
    <>
      <TableRow className="cursor-pointer" onClick={() => setOpen((o) => !o)}>
        <Td strong>
          <span className="inline-flex items-center gap-1">
            {open ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
            {v.vehicleNo}
          </span>
          {cancelled > 0 && (
            <Badge variant="destructive" className="ml-2 text-[10px]">
              {cancelled} cancelled chalan {cancelled === 1 ? "entry" : "entries"} retained
            </Badge>
          )}
        </Td>
        <Td>{v.owner || <span className="text-muted-foreground">—</span>}</Td>
        <Td right>{money(v.deducted)}</Td>
        <Td right>{money(v.booked)}</Td>
        <Td right strong className={diffClass(v.diff)}>{signed(v.diff)}</Td>
        <Td className="text-primary">{open ? "Hide" : "Drill down"}</Td>
      </TableRow>
      {open && (
        <TableRow className="bg-muted/30 hover:bg-muted/30">
          <TableCell colSpan={6} className="p-2">
            <div className="mb-1 flex flex-wrap gap-x-6 text-xs">
              <span>Deducted: <b className="tabular-nums">{money(v.deducted)}</b></span>
              <span>Booked: <b className="tabular-nums">{money(v.booked)}</b></span>
              <span>Adjustment: <b className={`tabular-nums ${diffClass(v.diff)}`}>{signed(v.diff)}</b></span>
            </div>
            <div className="overflow-x-auto rounded-md border bg-background">
              <EntryTable rows={v.entries} />
            </div>
          </TableCell>
        </TableRow>
      )}
    </>
  );
}

export function AdjustmentClient({
  data,
  brokerOptions,
  vehicleOptions,
  headOptions,
}: {
  data: AdjResult;
  brokerOptions: FilterOption[];
  vehicleOptions: FilterOption[];
  headOptions: FilterOption[];
}) {
  const allEntries = React.useMemo(() => data.vehicles.flatMap((v) => v.entries), [data]);

  return (
    <div className="space-y-4 p-4 sm:p-6">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h1 className="flex items-center gap-2 text-2xl font-bold">
          Vehicle Expense Adjustment Report
          <InfoHint>
            Broker-owned vehicles only (Vehicle Master → Ownership = Broker); Owner Name comes from the
            Vehicle Master. Deducted = expense-head advances on chalans (cancelled chalans retained and
            flagged) and on the owner side of broker slips. Booked = Vehicle Expense Book lines plus
            expense the party gave for the vehicle on the broker slip. Bank / cash are money, not
            expense, and stay out of both. Adjustment = Deducted − Booked. Read-only.
          </InfoHint>
        </h1>
        <ExportButton
          rows={allEntries}
          fileName="vehicle-expense-adjustment"
          columns={[
            { header: "Vehicle", key: "vehicleNo" },
            { header: "Date", accessor: (r) => formatDate(r.date) },
            { header: "Type", accessor: (r) => (r.kind === "DEDUCTED" ? "Deducted" : "Booked") },
            { header: "Expense Head", key: "head" },
            { header: "Amount", key: "amount", numeric: true },
            { header: "Source", key: "source" },
            { header: "Doc No", key: "docNo" },
            { header: "Doc Date", accessor: (r) => formatDate(r.docDate) },
            { header: "Particular", key: "particular" },
            { header: "Chalan Status", accessor: (r) => (r.source === "Chalan" ? r.status : "") },
          ]}
        />
      </div>

      <FilterBar
        filters={[
          { type: "combobox", key: "vehicle", label: "Vehicle No.", options: vehicleOptions },
          { type: "combobox", key: "broker", label: "Owner (Vehicle Master)", options: brokerOptions },
          { type: "combobox", key: "head", label: "Expense Head", options: headOptions },
          { type: "daterange", key: "date", label: "Date" },
        ]}
      />

      <div className="grid gap-3 sm:grid-cols-3">
        <StatCard label="Chalan / Broker Slip Deducted" value={money(data.total.deducted)} />
        <StatCard label="Vehicle Expense Booked" value={money(data.total.booked)} />
        <StatCard
          label="Adjustment"
          tone={data.total.diff > 0.009 ? "destructive" : data.total.diff < -0.009 ? "muted" : "success"}
          value={signed(data.total.diff)}
          hint="+ more deducted on chalan / slip · − more booked as vehicle expense"
        />
      </div>

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-base">Vehicle-wise Adjustment ({data.vehicles.length} broker vehicles)</CardTitle>
        </CardHeader>
        <CardContent className="overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <Th>Vehicle No.</Th>
                <Th>Owner Name</Th>
                <Th right>Chalan / Broker Slip Deducted</Th>
                <Th right>Vehicle Expense Booked</Th>
                <Th right>Adjustment</Th>
                <Th> </Th>
              </TableRow>
            </TableHeader>
            <TableBody>
              {data.vehicles.map((v) => (
                <VehicleRow key={v.vehicleId} v={v} />
              ))}
              {!data.vehicles.length && (
                <TableRow>
                  <Td colSpan={6} className="text-muted-foreground">No broker-vehicle entries for these filters.</Td>
                </TableRow>
              )}
              <TableRow className="bg-muted/40">
                <Td strong colSpan={2}>TOTAL</Td>
                <Td right strong>{money(data.total.deducted)}</Td>
                <Td right strong>{money(data.total.booked)}</Td>
                <Td right strong className={diffClass(data.total.diff)}>{signed(data.total.diff)}</Td>
                <Td> </Td>
              </TableRow>
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </div>
  );
}
