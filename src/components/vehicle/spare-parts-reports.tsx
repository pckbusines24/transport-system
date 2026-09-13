"use client";

import * as React from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { formatDate, formatMoney, parseDdMmYyyy } from "@/lib/utils";
import { CLAIM_STATUS_LABEL, EVENT_LABEL, PART_STATUS_LABEL, WARRANTY_LABEL } from "@/lib/spare-parts";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { DateInput } from "@/components/data/date-input";
import { ExportButton, type ExportColumn } from "@/components/data/export-button";
import { MasterCombobox, type MasterOption } from "@/components/data/master-combobox";
import { WarrantyBadge } from "./spare-parts-client";
import type { SparePartRow, SparePartEventRow } from "./spare-parts-types";

const BASE = "/vehicle/spare-parts";

const REPORTS = [
  { key: "vehicle", label: "Vehicle-wise Spare Parts (currently installed)" },
  { key: "part-history", label: "Spare Part-wise History" },
  { key: "warranty-expiry", label: "Warranty Expiry Report" },
  { key: "warranty-30", label: "Warranty Expiring Within 30 Days" },
  { key: "claims", label: "Warranty Claim Report" },
  { key: "replacements", label: "Spare Part Replacement History" },
  { key: "serial", label: "Unique Serial Number Tracking" },
  { key: "vehicle-history", label: "Vehicle-wise Spare Part History" },
] as const;
type ReportKey = (typeof REPORTS)[number]["key"];

/** one flat line for the event-based reports */
interface EventLine {
  part: SparePartRow;
  event: SparePartEventRow;
}

type Cell = string | number | null;
interface Col<T> { header: string; cell: (r: T) => Cell; numeric?: boolean; link?: (r: T) => string | null }

const km = (n: number | null) => (n === null ? null : n);
const d = (s: string | null) => (s ? formatDate(s) : "");

/** Reports tab: one table, eight shapes, every filter the module knows. */
export function SparePartsReports({
  parts,
  vehicleOptions,
}: {
  parts: SparePartRow[];
  vehicleOptions: MasterOption[];
}) {
  const sp = useSearchParams();
  const [report, setReport] = React.useState<ReportKey>(
    (REPORTS.some((r) => r.key === sp.get("report")) ? (sp.get("report") as ReportKey) : "vehicle")
  );
  const [vehicleId, setVehicleId] = React.useState<string | null>(null);
  const [partName, setPartName] = React.useState("");
  const [partNumber, setPartNumber] = React.useState("");
  const [serial, setSerial] = React.useState("");
  const [supplier, setSupplier] = React.useState("");
  const [warranty, setWarranty] = React.useState("");
  const [fromText, setFromText] = React.useState("");
  const [toText, setToText] = React.useState("");

  const from = parseDdMmYyyy(fromText);
  const to = parseDdMmYyyy(toText);
  const inRange = (iso: string | null) => {
    if (!iso) return !from && !to;
    const t = new Date(iso).getTime();
    if (from && t < from.getTime()) return false;
    if (to && t > to.getTime() + 86399999) return false;
    return true;
  };
  const partOk = (p: SparePartRow) =>
    (!partName || p.name.toLowerCase().includes(partName.toLowerCase())) &&
    (!partNumber || p.partNumber.toLowerCase().includes(partNumber.toLowerCase())) &&
    (!serial || p.serialNo.toLowerCase().includes(serial.toLowerCase())) &&
    (!supplier || p.supplierName.toLowerCase().includes(supplier.toLowerCase())) &&
    (!warranty || p.warranty === warranty);

  const events: EventLine[] = React.useMemo(
    () =>
      parts
        .filter(partOk)
        .flatMap((p) => p.events.map((event) => ({ part: p, event })))
        .filter((l) => (!vehicleId || l.event.vehicleId === vehicleId) && inRange(l.event.date))
        .sort((a, b) => b.event.date.localeCompare(a.event.date)),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [parts, vehicleId, partName, partNumber, serial, supplier, warranty, fromText, toText]
  );

  const partRows = parts.filter(partOk).filter((p) => !vehicleId || p.currentVehicleId === vehicleId);

  // ---- the eight shapes ----
  let rows: unknown[] = [];
  let cols: Col<never>[] = [];
  const partCols: Col<SparePartRow>[] = [
    { header: "Vehicle", cell: (r) => r.currentVehicle || "—" },
    { header: "Serial No", cell: (r) => r.serialNo, link: (r) => `${BASE}?tab=parts&part=${r.id}` },
    { header: "Spare Part", cell: (r) => r.name },
    { header: "Part No", cell: (r) => r.partNumber },
    { header: "Brand", cell: (r) => r.brand },
    { header: "Supplier / Workshop", cell: (r) => r.supplierName },
    { header: "Installed On", cell: (r) => d(r.installedOn) },
    { header: "Install KM", cell: (r) => km(r.installKm), numeric: true },
    { header: "Warranty Status", cell: (r) => WARRANTY_LABEL[r.warranty] },
    { header: "Warranty Expiry", cell: (r) => d(r.warrantyExpiry) },
    { header: "Days Left", cell: (r) => r.daysLeft, numeric: true },
  ];
  const eventCols: Col<EventLine>[] = [
    { header: "Date", cell: (l) => d(l.event.date) },
    { header: "Event", cell: (l) => `${EVENT_LABEL[l.event.type] ?? l.event.type}${l.event.claimStatus ? ` (${CLAIM_STATUS_LABEL[l.event.claimStatus] ?? l.event.claimStatus})` : ""}` },
    { header: "Serial No", cell: (l) => l.part.serialNo, link: (l) => `${BASE}?tab=parts&part=${l.part.id}` },
    { header: "Spare Part", cell: (l) => l.part.name },
    { header: "Part No", cell: (l) => l.part.partNumber },
    { header: "Vehicle", cell: (l) => l.event.vehicle || "—" },
    { header: "KM Reading", cell: (l) => km(l.event.km), numeric: true },
    { header: "Workshop / Supplier", cell: (l) => l.event.workshop },
    { header: "Related Part", cell: (l) => l.event.relatedSerial ?? "" },
    { header: "Details", cell: (l) => l.event.remarks },
  ];

  switch (report) {
    case "vehicle":
      rows = partRows.filter((p) => p.status === "INSTALLED").sort((a, b) => a.currentVehicle.localeCompare(b.currentVehicle));
      cols = partCols as Col<never>[];
      break;
    case "warranty-expiry":
      rows = partRows.filter((p) => p.warrantyApplicable).sort((a, b) => (a.warrantyExpiry ?? "").localeCompare(b.warrantyExpiry ?? ""));
      cols = partCols as Col<never>[];
      break;
    case "warranty-30":
      rows = partRows.filter((p) => p.warranty === "EXPIRING_30").sort((a, b) => (a.daysLeft ?? 0) - (b.daysLeft ?? 0));
      cols = partCols as Col<never>[];
      break;
    case "claims":
      rows = events.filter((l) => l.event.type === "WARRANTY_CLAIM" || l.event.type === "WARRANTY_REPLACEMENT");
      cols = eventCols as Col<never>[];
      break;
    case "replacements":
      rows = events.filter((l) => (l.event.type === "REMOVE" && l.event.relatedSerial) || l.event.type === "WARRANTY_REPLACEMENT" || (l.event.type === "INSTALL" && l.event.relatedSerial));
      cols = eventCols as Col<never>[];
      break;
    case "serial":
    case "part-history":
    case "vehicle-history":
      rows = report === "vehicle-history" && !vehicleId ? [] : events;
      cols = eventCols as Col<never>[];
      break;
  }
  const typedCols = cols as Col<unknown>[];
  const exportCols: ExportColumn<unknown>[] = typedCols.map((c) => ({ header: c.header, accessor: (r) => c.cell(r as never), numeric: c.numeric }));

  return (
    <div className="space-y-3">
      <div className="grid gap-2 md:grid-cols-4">
        <div className="space-y-1 md:col-span-2">
          <Label className="text-xs">Report</Label>
          <Select value={report} onValueChange={(v) => setReport(v as ReportKey)}>
            <SelectTrigger className="h-9"><SelectValue /></SelectTrigger>
            <SelectContent>
              {REPORTS.map((r, i) => <SelectItem key={r.key} value={r.key}>{i + 1}. {r.label}</SelectItem>)}
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-1"><Label className="text-xs">Vehicle Number</Label><MasterCombobox options={vehicleOptions} value={vehicleId} onChange={setVehicleId} placeholder="Any vehicle" /></div>
        <div className="space-y-1"><Label className="text-xs">Warranty Status</Label>
          <Select value={warranty || "ALL"} onValueChange={(v) => setWarranty(v === "ALL" ? "" : v)}>
            <SelectTrigger className="h-9"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="ALL">Any</SelectItem>
              <SelectItem value="ACTIVE">🟢 Active</SelectItem>
              <SelectItem value="EXPIRING_SOON">🟡 Expiring Soon</SelectItem>
              <SelectItem value="EXPIRING_30">🟠 Expiring Within 30 Days</SelectItem>
              <SelectItem value="EXPIRED">🔴 Expired</SelectItem>
              <SelectItem value="NONE">⚪ No Warranty</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-1"><Label className="text-xs">Spare Part</Label><Input className="h-9" value={partName} onChange={(e) => setPartName(e.target.value)} placeholder="name contains..." /></div>
        <div className="space-y-1"><Label className="text-xs">Part Number</Label><Input className="h-9" value={partNumber} onChange={(e) => setPartNumber(e.target.value)} /></div>
        <div className="space-y-1"><Label className="text-xs">Unique Serial Number</Label><Input className="h-9" value={serial} onChange={(e) => setSerial(e.target.value)} placeholder="e.g. ALT-45821" /></div>
        <div className="space-y-1"><Label className="text-xs">Supplier / Workshop</Label><Input className="h-9" value={supplier} onChange={(e) => setSupplier(e.target.value)} /></div>
        <div className="space-y-1"><Label className="text-xs">From Date</Label><DateInput className="h-9" value={fromText} onChange={setFromText} /></div>
        <div className="space-y-1"><Label className="text-xs">To Date</Label><DateInput className="h-9" value={toText} onChange={setToText} /></div>
        <div className="flex items-end gap-2 md:col-span-2">
          <Button variant="ghost" size="sm" onClick={() => { setVehicleId(null); setPartName(""); setPartNumber(""); setSerial(""); setSupplier(""); setWarranty(""); setFromText(""); setToText(""); }}>Clear filters</Button>
          <span className="ml-auto">
            <ExportButton rows={rows} columns={exportCols} fileName={`spare-parts-${report}`} sheetName={REPORTS.find((r) => r.key === report)?.label.slice(0, 31) ?? "Report"} />
          </span>
        </div>
      </div>

      {report === "vehicle-history" && !vehicleId && (
        <p className="text-sm text-muted-foreground">Select a vehicle to see its spare part history.</p>
      )}

      <div className="overflow-x-auto rounded-md border">
        <table className="w-full border-collapse text-xs">
          <thead className="bg-muted/60">
            <tr>
              {typedCols.map((c) => (
                <th key={c.header} className={`border-b px-2 py-1.5 font-semibold ${c.numeric ? "text-right" : "text-left"}`}>{c.header}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => (
              <tr key={i} className="border-b last:border-0">
                {typedCols.map((c) => {
                  const v = c.cell(r as never);
                  const href = c.link?.(r as never);
                  const text = v === null ? "—" : c.numeric && typeof v === "number" ? v.toLocaleString("en-IN") : String(v);
                  if (c.header === "Warranty Status") {
                    const p = (r as EventLine).part ?? (r as SparePartRow);
                    return <td key={c.header} className="px-2 py-1"><WarrantyBadge status={p.warranty} daysLeft={p.daysLeft} /></td>;
                  }
                  return (
                    <td key={c.header} className={`px-2 py-1 ${c.numeric ? "text-right tabular-nums" : ""}`}>
                      {href ? <Link href={href} className="font-medium text-primary hover:underline">{text}</Link> : text}
                    </td>
                  );
                })}
              </tr>
            ))}
            {rows.length === 0 && (
              <tr><td colSpan={typedCols.length} className="px-2 py-4 text-center text-muted-foreground">No rows for this report and filters.</td></tr>
            )}
          </tbody>
        </table>
      </div>
      <p className="text-xs text-muted-foreground">
        {rows.length} row(s). Informational reports — no accounting figures. Purchase rate:{" "}
        {formatMoney(partRows.reduce((s, p) => s + (p.purchaseRate ?? 0), 0))} across {partRows.length} filtered part(s) (information only).
        {" "}Status legend: {Object.values(PART_STATUS_LABEL).join(" / ")}.
      </p>
    </div>
  );
}
