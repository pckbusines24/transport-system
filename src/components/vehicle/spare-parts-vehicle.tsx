"use client";

import * as React from "react";
import Link from "next/link";
import { formatDate } from "@/lib/utils";
import { EVENT_LABEL, WARRANTY_LABEL } from "@/lib/spare-parts";
import { Card, CardContent } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { ExportButton } from "@/components/data/export-button";
import { MasterCombobox, type MasterOption } from "@/components/data/master-combobox";
import { WarrantyBadge } from "./spare-parts-client";
import type { SparePartRow } from "./spare-parts-types";

const BASE = "/vehicle/spare-parts";
const km = (n: number | null) => (n === null ? "—" : `${n.toLocaleString("en-IN")} KM`);

/**
 * Vehicle-wise view: what is fitted now, what was fitted before (with the
 * date it went in, the date it came out and what replaced it), so a vehicle
 * that eats a particular part shows it at a glance.
 */
export function SparePartsVehicleView({
  parts,
  vehicleOptions,
  initialVehicleId,
}: {
  parts: SparePartRow[];
  vehicleOptions: MasterOption[];
  initialVehicleId: string | null;
}) {
  const [vehicleId, setVehicleId] = React.useState<string | null>(initialVehicleId);
  const vehicleNo = vehicleOptions.find((v) => v.value === vehicleId)?.label ?? "";

  const current = parts.filter((p) => p.status === "INSTALLED" && p.currentVehicleId === vehicleId);

  // previous = every INSTALL on this vehicle that has since been removed / replaced
  const previous = React.useMemo(() => {
    if (!vehicleId) return [];
    const out: {
      part: SparePartRow;
      installDate: string;
      installKm: number | null;
      removalDate: string | null;
      removalKm: number | null;
      reason: string;
      replacedBy: string | null;
    }[] = [];
    for (const p of parts) {
      const evs = p.events.filter((e) => e.vehicleId === vehicleId);
      for (let i = 0; i < evs.length; i++) {
        const e = evs[i];
        if (e.type !== "INSTALL") continue;
        const end = evs.slice(i + 1).find((x) => x.type === "REMOVE" || x.type === "WARRANTY_REPLACEMENT");
        // still fitted → shown in the current table, not here
        if (!end && p.status === "INSTALLED" && p.currentVehicleId === vehicleId) continue;
        out.push({
          part: p,
          installDate: e.date,
          installKm: e.km,
          removalDate: end?.date ?? null,
          removalKm: end?.km ?? null,
          reason: end ? EVENT_LABEL[end.type] ?? end.type : "",
          replacedBy: end?.relatedSerial ?? null,
        });
      }
    }
    return out.sort((a, b) => (b.removalDate ?? b.installDate).localeCompare(a.removalDate ?? a.installDate));
  }, [parts, vehicleId]);

  // how often this vehicle changes each part
  const frequency = React.useMemo(() => {
    const m = new Map<string, number>();
    for (const row of [...previous.map((r) => r.part), ...current]) {
      m.set(row.name, (m.get(row.name) ?? 0) + 1);
    }
    return Array.from(m.entries()).sort((a, b) => b[1] - a[1]);
  }, [previous, current]);

  const th = "border-b px-2 py-1 text-left font-semibold";
  const td = "px-2 py-1";

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end gap-3">
        <div className="w-64 space-y-1.5">
          <Label className="text-xs">Vehicle</Label>
          <MasterCombobox options={vehicleOptions} value={vehicleId} onChange={setVehicleId} placeholder="Select vehicle..." />
        </div>
        {vehicleId && (
          <div className="flex flex-wrap gap-2 text-xs">
            {frequency.map(([name, n]) => (
              <span key={name} className="rounded-full bg-muted px-2 py-1">
                {name}: <b>{n}</b> fitted
              </span>
            ))}
          </div>
        )}
        {vehicleId && (
          <span className="ml-auto">
            <ExportButton
              rows={[
                ...current.map((p) => ({ status: "Currently Installed", serial: p.serialNo, part: p.name, partNo: p.partNumber, installDate: p.installedOn ? formatDate(p.installedOn) : "", installKm: p.installKm, removalDate: "", removalKm: null as number | null, replacedBy: "", warranty: WARRANTY_LABEL[p.warranty], expiry: p.warrantyExpiry ? formatDate(p.warrantyExpiry) : "" })),
                ...previous.map((r) => ({ status: "Previous", serial: r.part.serialNo, part: r.part.name, partNo: r.part.partNumber, installDate: formatDate(r.installDate), installKm: r.installKm, removalDate: r.removalDate ? formatDate(r.removalDate) : "", removalKm: r.removalKm, replacedBy: r.replacedBy ?? "", warranty: WARRANTY_LABEL[r.part.warranty], expiry: r.part.warrantyExpiry ? formatDate(r.part.warrantyExpiry) : "" })),
              ]}
              fileName={`spare-parts-${vehicleNo || "vehicle"}`}
              sheetName="Vehicle Spare Parts"
              columns={[
                { header: "Status", key: "status" },
                { header: "Serial No", key: "serial" },
                { header: "Spare Part", key: "part" },
                { header: "Part No", key: "partNo" },
                { header: "Installation Date", key: "installDate" },
                { header: "Installation KM", key: "installKm", numeric: true },
                { header: "Removal Date", key: "removalDate" },
                { header: "Removal KM", key: "removalKm", numeric: true },
                { header: "Replaced By", key: "replacedBy" },
                { header: "Warranty Status", key: "warranty" },
                { header: "Warranty Expiry", key: "expiry" },
              ]}
            />
          </span>
        )}
      </div>

      {!vehicleId ? (
        <p className="text-sm text-muted-foreground">Select a vehicle to see its spare parts history.</p>
      ) : (
        <>
          <Card>
            <CardContent className="p-4">
              <div className="mb-2 text-sm font-semibold">Currently Installed — {vehicleNo}</div>
              <div className="overflow-x-auto">
                <table className="w-full border-collapse text-xs">
                  <thead className="bg-muted/60">
                    <tr>{["Serial No", "Spare Part", "Part No", "Brand", "Installation Date", "Installation KM", "Warranty", "Warranty Expiry"].map((h) => <th key={h} className={th}>{h}</th>)}</tr>
                  </thead>
                  <tbody>
                    {current.map((p) => (
                      <tr key={p.id} className="border-b last:border-0">
                        <td className={td}><Link href={`${BASE}?tab=parts&part=${p.id}`} className="font-medium text-primary hover:underline">{p.serialNo}</Link></td>
                        <td className={td}>{p.name}</td>
                        <td className={td}>{p.partNumber || "—"}</td>
                        <td className={td}>{p.brand || "—"}</td>
                        <td className={`${td} whitespace-nowrap`}>{p.installedOn ? formatDate(p.installedOn) : "—"}</td>
                        <td className={`${td} whitespace-nowrap tabular-nums`}>{km(p.installKm)}</td>
                        <td className={td}><WarrantyBadge status={p.warranty} daysLeft={p.daysLeft} /></td>
                        <td className={`${td} whitespace-nowrap`}>{p.warrantyExpiry ? formatDate(p.warrantyExpiry) : "—"}</td>
                      </tr>
                    ))}
                    {current.length === 0 && <tr><td colSpan={8} className="px-2 py-3 text-center text-muted-foreground">No spare part is currently installed in this vehicle.</td></tr>}
                  </tbody>
                </table>
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardContent className="p-4">
              <div className="mb-2 text-sm font-semibold">Previous Spare Parts — {vehicleNo}</div>
              <div className="overflow-x-auto">
                <table className="w-full border-collapse text-xs">
                  <thead className="bg-muted/60">
                    <tr>{["Serial No", "Spare Part", "Installation Date", "Installation KM", "Removal / Replacement Date", "Removal KM", "Reason", "Replaced By", "Warranty"].map((h) => <th key={h} className={th}>{h}</th>)}</tr>
                  </thead>
                  <tbody>
                    {previous.map((r, i) => (
                      <tr key={`${r.part.id}-${i}`} className="border-b last:border-0">
                        <td className={td}><Link href={`${BASE}?tab=parts&part=${r.part.id}`} className="font-medium text-primary hover:underline">{r.part.serialNo}</Link></td>
                        <td className={td}>{r.part.name}</td>
                        <td className={`${td} whitespace-nowrap`}>{formatDate(r.installDate)}</td>
                        <td className={`${td} whitespace-nowrap tabular-nums`}>{km(r.installKm)}</td>
                        <td className={`${td} whitespace-nowrap`}>{r.removalDate ? formatDate(r.removalDate) : "—"}</td>
                        <td className={`${td} whitespace-nowrap tabular-nums`}>{km(r.removalKm)}</td>
                        <td className={td}>{r.reason || "—"}</td>
                        <td className={td}>{r.replacedBy ?? "—"}</td>
                        <td className={td}><WarrantyBadge status={r.part.warranty} daysLeft={r.part.daysLeft} /></td>
                      </tr>
                    ))}
                    {previous.length === 0 && <tr><td colSpan={9} className="px-2 py-3 text-center text-muted-foreground">No earlier spare parts on this vehicle.</td></tr>}
                  </tbody>
                </table>
              </div>
            </CardContent>
          </Card>
        </>
      )}
    </div>
  );
}
