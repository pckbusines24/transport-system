"use client";

import * as React from "react";
import { ChevronDown, ChevronRight } from "lucide-react";
import { formatDate, formatMoney } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { InfoHint } from "@/components/ui/info-hint";
import { StatCard } from "@/components/ui/stat";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { ExportButton } from "@/components/data/export-button";
import { FilterBar, type FilterOption } from "@/components/data/filter-bar";
import type { AdjBrokerNode, AdjCell, AdjEntry, AdjHeadRow, AdjResult, AdjVehicleNode } from "./data";

/* ------------------------------------------------------------------ helpers */

const money = (n: number) => formatMoney(n);
const signed = (n: number) => (n > 0 ? `+${money(n)}` : n < 0 ? `−${money(-n)}` : money(0));
const diffClass = (n: number) => (n > 0.009 ? "text-destructive" : n < -0.009 ? "text-warning" : "text-success");

type Side = "deducted" | "booked" | "diff";

interface Drill {
  title: string;
  side: Side;
  cell: AdjCell;
  deducted: AdjEntry[];
  booked: AdjEntry[];
}

const Th = ({ children, right }: { children: React.ReactNode; right?: boolean }) => (
  <TableHead className={`h-8 whitespace-nowrap text-xs ${right ? "text-right" : ""}`}>{children}</TableHead>
);
const Td = ({ children, right, strong, className = "", colSpan }: { children: React.ReactNode; right?: boolean; strong?: boolean; className?: string; colSpan?: number }) => (
  <TableCell colSpan={colSpan} className={`py-1.5 text-xs ${right ? "text-right tabular-nums" : ""} ${strong ? "font-semibold" : ""} ${className}`}>
    {children}
  </TableCell>
);

/** Clickable amount — every summary figure opens its entries. */
function Amt({ value, onClick, className = "", signedFmt }: { value: number; onClick: () => void; className?: string; signedFmt?: boolean }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`tabular-nums underline-offset-2 hover:underline ${className}`}
      title="Click to see the entries"
    >
      {signedFmt ? signed(value) : money(value)}
    </button>
  );
}

function Toggle({ open, onToggle, label }: { open: boolean; onToggle: () => void; label: React.ReactNode }) {
  return (
    <button type="button" onClick={onToggle} className="inline-flex items-center gap-1 text-left font-semibold hover:text-primary">
      {open ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
      {label}
    </button>
  );
}

/* ------------------------------------------------------------------ entry table */

function EntryTable({ rows, source }: { rows: AdjEntry[]; source: "deducted" | "booked" }) {
  if (!rows.length) return <p className="px-2 py-1 text-xs text-muted-foreground">No entries.</p>;
  const total = rows.reduce((s, r) => s + r.amount, 0);
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <Th>Date</Th>
          <Th>{source === "deducted" ? "Chalan / Slip No." : "Expense Entry"}</Th>
          <Th>{source === "deducted" ? "Doc Date" : "Bill Date"}</Th>
          <Th>Vehicle No.</Th>
          <Th>Broker / Owner</Th>
          <Th>Expense Head</Th>
          <Th>Particular / Description</Th>
          <Th right>Amount</Th>
          <Th>Reference</Th>
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.map((r) => (
          <TableRow key={r.id}>
            <Td>{formatDate(r.date)}</Td>
            <Td strong>
              {r.docNo}{" "}
              <Badge variant="outline" className="ml-1">
                {r.source === "CHALAN" ? "Chalan" : r.source === "BROKER_SLIP" ? "Broker Slip" : "Expense"}
              </Badge>
            </Td>
            <Td>{formatDate(r.docDate)}</Td>
            <Td>{r.vehicleNo}</Td>
            <Td>{r.broker}</Td>
            <Td>{r.head}</Td>
            <Td className="max-w-[22rem]">{r.particular}</Td>
            <Td right strong>{money(r.amount)}</Td>
            <Td>{r.reference}</Td>
          </TableRow>
        ))}
        <TableRow className="bg-muted/40 font-semibold">
          <Td colSpan={7}>Total ({rows.length} entries)</Td>
          <Td right strong>{money(total)}</Td>
          <Td> </Td>
        </TableRow>
      </TableBody>
    </Table>
  );
}

/* ------------------------------------------------------------------ drill dialog */

function DrillDialog({ drill, onClose }: { drill: Drill | null; onClose: () => void }) {
  return (
    <Dialog open={!!drill} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-6xl">
        {drill && (
          <>
            <DialogHeader>
              <DialogTitle className="text-base">{drill.title}</DialogTitle>
            </DialogHeader>
            <div className="grid gap-2 text-sm sm:grid-cols-3">
              <div className="rounded-md border p-2">
                Chalan / Broker Slip Deducted
                <div className="text-lg font-semibold tabular-nums">{money(drill.cell.deducted)}</div>
              </div>
              <div className="rounded-md border p-2">
                Vehicle Expense Booked
                <div className="text-lg font-semibold tabular-nums">{money(drill.cell.booked)}</div>
              </div>
              <div className="rounded-md border p-2">
                Difference
                <div className={`text-lg font-semibold tabular-nums ${diffClass(drill.cell.diff)}`}>{signed(drill.cell.diff)}</div>
              </div>
            </div>
            {(drill.side === "deducted" || drill.side === "diff") && (
              <div className="space-y-1">
                <div className="text-xs font-semibold uppercase text-muted-foreground">Chalan / Broker Slip deductions</div>
                <div className="overflow-x-auto rounded-md border">
                  <EntryTable rows={drill.deducted} source="deducted" />
                </div>
              </div>
            )}
            {(drill.side === "booked" || drill.side === "diff") && (
              <div className="space-y-1">
                <div className="text-xs font-semibold uppercase text-muted-foreground">Vehicle Expense Book entries</div>
                <div className="overflow-x-auto rounded-md border">
                  <EntryTable rows={drill.booked} source="booked" />
                </div>
              </div>
            )}
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}

/* ------------------------------------------------------------------ head-wise table */

function HeadTable({
  rows,
  total,
  onDrill,
  scope,
}: {
  rows: AdjHeadRow[];
  total: AdjCell;
  onDrill: (d: Drill) => void;
  scope: string;
}) {
  const open = (r: AdjHeadRow, side: Side) =>
    onDrill({
      title: `${r.head} — ${scope}`,
      side,
      cell: r,
      deducted: r.deductedEntries,
      booked: r.bookedEntries,
    });
  const openTotal = (side: Side) =>
    onDrill({
      title: `All heads — ${scope}`,
      side,
      cell: total,
      deducted: rows.flatMap((r) => r.deductedEntries),
      booked: rows.flatMap((r) => r.bookedEntries),
    });
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <Th>Expense Head</Th>
          <Th right>Chalan / Broker Slip Deducted</Th>
          <Th right>Vehicle Expense Booked</Th>
          <Th right>Difference</Th>
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.map((r) => (
          <TableRow key={r.headId}>
            <Td strong>{r.head}</Td>
            <Td right><Amt value={r.deducted} onClick={() => open(r, "deducted")} /></Td>
            <Td right><Amt value={r.booked} onClick={() => open(r, "booked")} /></Td>
            <Td right strong><Amt value={r.diff} signedFmt className={diffClass(r.diff)} onClick={() => open(r, "diff")} /></Td>
          </TableRow>
        ))}
        {!rows.length && (
          <TableRow>
            <Td colSpan={4} className="text-muted-foreground">Nothing to compare for these filters.</Td>
          </TableRow>
        )}
        <TableRow className="bg-muted/40">
          <Td strong>TOTAL</Td>
          <Td right strong><Amt value={total.deducted} onClick={() => openTotal("deducted")} /></Td>
          <Td right strong><Amt value={total.booked} onClick={() => openTotal("booked")} /></Td>
          <Td right strong><Amt value={total.diff} signedFmt className={diffClass(total.diff)} onClick={() => openTotal("diff")} /></Td>
        </TableRow>
      </TableBody>
    </Table>
  );
}

/* ------------------------------------------------------------------ hierarchy */

function VehicleBlock({ v, broker, onDrill }: { v: AdjVehicleNode; broker: string; onDrill: (d: Drill) => void }) {
  const [open, setOpen] = React.useState(false);
  const scope = `${broker} → ${v.vehicleNo}`;
  const all = (side: Side) =>
    onDrill({
      title: `All heads — ${scope}`,
      side,
      cell: v,
      deducted: v.heads.flatMap((h) => h.deductedEntries),
      booked: v.heads.flatMap((h) => h.bookedEntries),
    });
  return (
    <div className="rounded-md border">
      <div className="grid grid-cols-[1fr_auto_auto_auto] items-center gap-x-6 px-3 py-1.5 text-sm">
        <Toggle open={open} onToggle={() => setOpen((o) => !o)} label={<span>{v.vehicleNo} <span className="font-normal text-muted-foreground">({v.heads.length} heads)</span></span>} />
        <Amt value={v.deducted} onClick={() => all("deducted")} />
        <Amt value={v.booked} onClick={() => all("booked")} />
        <Amt value={v.diff} signedFmt className={`font-semibold ${diffClass(v.diff)}`} onClick={() => all("diff")} />
      </div>
      {open && (
        <div className="overflow-x-auto border-t p-2">
          <HeadTable rows={v.heads} total={v} onDrill={onDrill} scope={scope} />
        </div>
      )}
    </div>
  );
}

function BrokerBlock({ b, onDrill }: { b: AdjBrokerNode; onDrill: (d: Drill) => void }) {
  const [open, setOpen] = React.useState(false);
  const all = (side: Side) =>
    onDrill({
      title: `All vehicles — ${b.broker}`,
      side,
      cell: b,
      deducted: b.vehicles.flatMap((v) => v.heads.flatMap((h) => h.deductedEntries)),
      booked: b.vehicles.flatMap((v) => v.heads.flatMap((h) => h.bookedEntries)),
    });
  return (
    <Card>
      <CardHeader className="py-3">
        <div className="grid grid-cols-[1fr_auto_auto_auto] items-center gap-x-6 text-sm">
          <Toggle open={open} onToggle={() => setOpen((o) => !o)} label={<CardTitle className="text-base">{b.broker} <span className="text-sm font-normal text-muted-foreground">({b.vehicles.length} vehicle{b.vehicles.length === 1 ? "" : "s"})</span></CardTitle>} />
          <div className="text-right"><div className="text-[10px] uppercase text-muted-foreground">Deducted</div><Amt value={b.deducted} onClick={() => all("deducted")} /></div>
          <div className="text-right"><div className="text-[10px] uppercase text-muted-foreground">Booked</div><Amt value={b.booked} onClick={() => all("booked")} /></div>
          <div className="text-right"><div className="text-[10px] uppercase text-muted-foreground">Difference</div><Amt value={b.diff} signedFmt className={`font-semibold ${diffClass(b.diff)}`} onClick={() => all("diff")} /></div>
        </div>
      </CardHeader>
      {open && (
        <CardContent className="space-y-2 pt-0">
          {b.vehicles.map((v) => (
            <VehicleBlock key={v.vehicleId} v={v} broker={b.broker} onDrill={onDrill} />
          ))}
          <div className="flex flex-wrap justify-end gap-x-6 rounded-md bg-muted/40 px-3 py-1.5 text-sm">
            <span>Total Deducted: <b className="tabular-nums">{money(b.deducted)}</b></span>
            <span>Total Expense Booked: <b className="tabular-nums">{money(b.booked)}</b></span>
            <span>Difference: <b className={`tabular-nums ${diffClass(b.diff)}`}>{signed(b.diff)}</b></span>
          </div>
        </CardContent>
      )}
    </Card>
  );
}

/* ------------------------------------------------------------------ page */

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
  const [drill, setDrill] = React.useState<Drill | null>(null);
  const allEntries = React.useMemo(
    () => data.heads.flatMap((h) => [...h.deductedEntries, ...h.bookedEntries]),
    [data]
  );

  return (
    <div className="space-y-4 p-4 sm:p-6">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h1 className="flex items-center gap-2 text-2xl font-bold">
          Vehicle Expense Adjustment Report
          <InfoHint>
            Expense-head advances deducted from the owner / broker on chalans and owner-side broker slips
            (diesel, tyre, repair, toll, spare parts…) against the same heads booked in the Vehicle Expense
            Book. Difference = Deducted − Booked: + means more was deducted on the chalan / slip, − means
            more is booked in the expense book. Bank / cash advances are money, not expense heads, so they
            are not compared. Every amount opens its entries. Read-only — nothing here changes accounts.
          </InfoHint>
        </h1>
        <ExportButton
          rows={allEntries}
          fileName="vehicle-expense-adjustment"
          columns={[
            { header: "Source", accessor: (r) => (r.source === "EXPENSE" ? "Vehicle Expense" : r.source === "CHALAN" ? "Chalan" : "Broker Slip") },
            { header: "Date", accessor: (r) => formatDate(r.date) },
            { header: "Doc No", key: "docNo" },
            { header: "Doc Date", accessor: (r) => formatDate(r.docDate) },
            { header: "Vehicle", key: "vehicleNo" },
            { header: "Broker / Owner", key: "broker" },
            { header: "Expense Head", key: "head" },
            { header: "Particular", key: "particular" },
            { header: "Deducted", accessor: (r) => (r.source === "EXPENSE" ? "" : r.amount), numeric: true },
            { header: "Booked", accessor: (r) => (r.source === "EXPENSE" ? r.amount : ""), numeric: true },
            { header: "Reference", key: "reference" },
          ]}
        />
      </div>

      <FilterBar
        filters={[
          { type: "combobox", key: "vehicle", label: "Vehicle No.", options: vehicleOptions },
          { type: "combobox", key: "broker", label: "Broker / Owner", options: brokerOptions },
          { type: "combobox", key: "head", label: "Expense Head", options: headOptions },
          { type: "daterange", key: "date", label: "Date" },
        ]}
      />

      <div className="grid gap-3 sm:grid-cols-3">
        <StatCard
          label="Chalan / Broker Slip Deducted"
          value={<Amt value={data.total.deducted} onClick={() => setDrill({ title: "All deductions", side: "deducted", cell: data.total, deducted: data.heads.flatMap((h) => h.deductedEntries), booked: [] })} />}
        />
        <StatCard
          label="Vehicle Expense Booked"
          value={<Amt value={data.total.booked} onClick={() => setDrill({ title: "All expense book entries", side: "booked", cell: data.total, deducted: [], booked: data.heads.flatMap((h) => h.bookedEntries) })} />}
        />
        <StatCard
          label="Difference"
          tone={data.total.diff > 0.009 ? "destructive" : data.total.diff < -0.009 ? "muted" : "success"}
          value={<Amt value={data.total.diff} signedFmt onClick={() => setDrill({ title: "Difference — all entries", side: "diff", cell: data.total, deducted: data.heads.flatMap((h) => h.deductedEntries), booked: data.heads.flatMap((h) => h.bookedEntries) })} />}
          hint="+ more deducted on chalan / slip · − more booked in expense book"
        />
      </div>

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-base">Expense Head-wise Comparison</CardTitle>
        </CardHeader>
        <CardContent className="overflow-x-auto">
          <HeadTable rows={data.heads} total={data.total} onDrill={setDrill} scope="all vehicles" />
        </CardContent>
      </Card>

      <div className="space-y-2">
        <h2 className="flex items-center gap-2 text-lg font-semibold">
          Broker → Vehicle → Expense Head
          <InfoHint>Expand a broker, then a vehicle, to reach its head-wise comparison; click any amount for the entries.</InfoHint>
        </h2>
        {data.brokers.map((b) => (
          <BrokerBlock key={b.brokerId} b={b} onDrill={setDrill} />
        ))}
        {!data.brokers.length && (
          <Card>
            <CardContent className="p-6 text-sm text-muted-foreground">Nothing to compare for these filters.</CardContent>
          </Card>
        )}
      </div>

      <DrillDialog drill={drill} onClose={() => setDrill(null)} />
    </div>
  );
}
