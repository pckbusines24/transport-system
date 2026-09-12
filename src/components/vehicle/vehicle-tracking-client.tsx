"use client";

import * as React from "react";
import { CheckCircle2, Loader2, Printer } from "lucide-react";
import { formatDate, parseDdMmYyyy } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useToast } from "@/components/ui/use-toast";
import { DateInput } from "@/components/data/date-input";
import { ExportButton } from "@/components/data/export-button";
import { updateVehicleTracking } from "@/app/(app)/vehicle/tracking/actions";

export interface TrackingSnapshot {
  vehicleId: string;
  date: string; // ISO day
  transporterName: string;
  fromLocation: string;
  toLocation: string;
  currentLocation: string;
  status: string;
  remarks: string;
  updatedAt: string;
}

interface VehicleInfo {
  id: string;
  number: string;
  ownership: string;
}

/** statuses that mean the vehicle is idle → Available for Load */
const IDLE_STATUSES = [
  "EMPTY",
  "AVAILABLE",
  "UNLOADED",
  "TRIP COMPLETED",
  "AT YARD",
  "WAITING FOR LOAD",
];
const BUSY_STATUSES = ["LOADING", "RUNNING", "UNLOADING", "TRIP STARTED"];
const ALL_STATUSES = [...BUSY_STATUSES, ...IDLE_STATUSES];

const isIdle = (status: string) => IDLE_STATUSES.includes(status.toUpperCase().trim());

type LiveRow = {
  vehicleId: string;
  transporterName: string;
  fromLocation: string;
  toLocation: string;
  currentLocation: string;
  status: string;
  remarks: string;
  lastUpdated: string | null;
};

export function VehicleTrackingClient({
  vehicles,
  snapshots,
  retentionDays,
}: {
  vehicles: VehicleInfo[];
  snapshots: TrackingSnapshot[];
  retentionDays: number;
}) {
  const { toast } = useToast();
  const [tab, setTab] = React.useState<"LIVE" | "AVAILABLE">("LIVE");
  const [dateText, setDateText] = React.useState(""); // history date filter
  const [saving, setSaving] = React.useState<Record<string, "saving" | "saved">>({});
  const timers = React.useRef<Record<string, ReturnType<typeof setTimeout>>>({});

  // snapshots grouped per vehicle, ascending by date
  const byVehicle = React.useMemo(() => {
    const m = new Map<string, TrackingSnapshot[]>();
    for (const s of snapshots) {
      const arr = m.get(s.vehicleId) ?? [];
      arr.push(s);
      m.set(s.vehicleId, arr);
    }
    return m;
  }, [snapshots]);

  // live editable state seeded from each vehicle's latest snapshot
  const [live, setLive] = React.useState<LiveRow[]>(() =>
    vehicles.map((v) => {
      const hist = byVehicle.get(v.id);
      const latest = hist?.[hist.length - 1];
      return {
        vehicleId: v.id,
        transporterName: latest?.transporterName ?? "",
        fromLocation: latest?.fromLocation ?? "",
        toLocation: latest?.toLocation ?? "",
        currentLocation: latest?.currentLocation ?? "",
        status: latest?.status ?? "",
        remarks: latest?.remarks ?? "",
        lastUpdated: latest?.updatedAt ?? null,
      };
    })
  );

  const vehicleNo = React.useMemo(
    () => new Map(vehicles.map((v) => [v.id, v.number])),
    [vehicles]
  );

  // custom statuses: defaults + anything ever used + user-created ones
  const [customStatuses, setCustomStatuses] = React.useState<string[]>([]);
  const statusOptions = React.useMemo(() => {
    const set = new Set(ALL_STATUSES);
    for (const s of snapshots) if (s.status) set.add(s.status.toUpperCase().trim());
    for (const s of live) if (s.status) set.add(s.status.toUpperCase().trim());
    for (const s of customStatuses) set.add(s);
    return Array.from(set);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [snapshots, customStatuses, live.map((r) => r.status).join("|")]);

  /** auto-save: debounce per vehicle+field, no save button anywhere */
  const autoSave = (vehicleId: string, patch: Partial<LiveRow>) => {
    setLive((prev) => prev.map((r) => (r.vehicleId === vehicleId ? { ...r, ...patch } : r)));
    const key = vehicleId;
    if (timers.current[key]) clearTimeout(timers.current[key]);
    setSaving((s) => ({ ...s, [key]: "saving" }));
    timers.current[key] = setTimeout(async () => {
      const row = (prevRowRef.current.get(vehicleId) ?? {}) as Partial<LiveRow>;
      const res = await updateVehicleTracking({ vehicleId, ...row, ...patch });
      if (res.ok) {
        setSaving((s) => ({ ...s, [key]: "saved" }));
        setLive((prev) =>
          prev.map((r) =>
            r.vehicleId === vehicleId ? { ...r, lastUpdated: new Date().toISOString() } : r
          )
        );
      } else {
        toast({ variant: "destructive", title: "Auto-save failed", description: res.error });
        setSaving((s) => {
          const rest = { ...s };
          delete rest[key];
          return rest;
        });
      }
    }, 700);
  };

  // keep latest full row values available for the debounced save
  const prevRowRef = React.useRef(new Map<string, LiveRow>());
  React.useEffect(() => {
    prevRowRef.current = new Map(live.map((r) => [r.vehicleId, r]));
  }, [live]);

  // ---- history (as-of date) view ----
  const historyDate = parseDdMmYyyy(dateText);
  const minDate = new Date();
  minDate.setDate(minDate.getDate() - retentionDays);
  minDate.setHours(0, 0, 0, 0);
  const historyTooOld = !!historyDate && historyDate < minDate;

  const asOfRows = React.useMemo(() => {
    if (!historyDate || historyTooOld) return null;
    const dayEnd = new Date(historyDate);
    dayEnd.setHours(23, 59, 59, 999);
    return vehicles
      .map((v) => {
        const hist = byVehicle.get(v.id) ?? [];
        const snap = [...hist].reverse().find((s) => new Date(s.date) <= dayEnd);
        return snap ? { vehicle: v.number, ...snap } : null;
      })
      .filter(Boolean) as ({ vehicle: string } & TrackingSnapshot)[];
  }, [historyDate, historyTooOld, vehicles, byVehicle]);

  // ---- available for load ----
  const availableRows = React.useMemo(() => {
    const today = new Date();
    return live
      .filter((r) => r.status && isIdle(r.status))
      .map((r) => {
        // walk history backwards to find when the current idle spell started
        const hist = byVehicle.get(r.vehicleId) ?? [];
        let since: string | null = null;
        for (let i = hist.length - 1; i >= 0; i--) {
          if (hist[i].status && isIdle(hist[i].status)) since = hist[i].date;
          else break;
        }
        const sinceDate = since ? new Date(since) : today;
        const idleDays = Math.max(
          0,
          Math.floor((today.getTime() - sinceDate.getTime()) / 86400000)
        );
        return {
          vehicleId: r.vehicleId,
          vehicle: vehicleNo.get(r.vehicleId) ?? "",
          transporterName: r.transporterName,
          currentLocation: r.currentLocation,
          availableSince: since,
          idleDays,
          status: r.status,
        };
      })
      .sort((a, b) => b.idleDays - a.idleDays); // longest idle first for dispatch
  }, [live, byVehicle, vehicleNo]);

  const cell = "border px-1.5 py-1";

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h1 className="text-xl font-semibold">Vehicle Tracking</h1>
        <div className="flex flex-wrap items-center gap-2">
          <Button
            size="sm"
            variant={tab === "LIVE" ? "default" : "outline"}
            onClick={() => setTab("LIVE")}
          >
            Live Tracking
          </Button>
          <Button
            size="sm"
            variant={tab === "AVAILABLE" ? "default" : "outline"}
            onClick={() => setTab("AVAILABLE")}
          >
            Available for Load ({availableRows.length})
          </Button>
        </div>
      </div>
      <p className="text-sm text-muted-foreground">
        Live register — every change saves automatically (no Save button) and becomes the current
        status; each day&apos;s values are kept as history. Data is retained for the last{" "}
        {retentionDays} days only.
      </p>

      {tab === "LIVE" && (
        <>
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-xs text-muted-foreground">View as on date (blank = current):</span>
            <DateInput className="h-8 w-36" value={dateText} onChange={setDateText} />
            {dateText && (
              <Button variant="ghost" size="sm" className="h-8 text-xs" onClick={() => setDateText("")}>
                Back to Current
              </Button>
            )}
            {historyTooOld && (
              <span className="text-xs font-medium text-destructive">
                Tracking data is available only for the last {retentionDays} days.
              </span>
            )}
            <span className="ml-auto flex items-center gap-2">
              <Button
                size="sm"
                variant="outline"
                onClick={() =>
                  window.open(
                    `/print/vehicle-tracking${
                      asOfRows ? `?date=${encodeURIComponent(dateText)}` : ""
                    }`,
                    "_blank"
                  )
                }
              >
                <Printer className="h-4 w-4" />
                Print
              </Button>
              <ExportButton
                rows={
                  asOfRows
                    ? asOfRows.map((r) => ({
                        vehicle: r.vehicle,
                        transporterName: r.transporterName,
                        fromLocation: r.fromLocation,
                        toLocation: r.toLocation,
                        currentLocation: r.currentLocation,
                        status: r.status,
                        remarks: r.remarks,
                        asOn: formatDate(r.date),
                      }))
                    : live.map((r) => ({
                        vehicle: vehicleNo.get(r.vehicleId) ?? "",
                        transporterName: r.transporterName,
                        fromLocation: r.fromLocation,
                        toLocation: r.toLocation,
                        currentLocation: r.currentLocation,
                        status: r.status,
                        remarks: r.remarks,
                        asOn: r.lastUpdated ? formatDate(r.lastUpdated) : "",
                      }))
                }
                fileName={asOfRows ? `vehicle-tracking-as-on-${dateText.replace(/\//g, "-")}` : "vehicle-tracking"}
                sheetName="Vehicle Tracking"
                columns={[
                  { header: "Vehicle No", key: "vehicle" },
                  { header: "Transporter Name", key: "transporterName" },
                  { header: "From", key: "fromLocation" },
                  { header: "To", key: "toLocation" },
                  { header: "Current Location", key: "currentLocation" },
                  { header: "Status", key: "status" },
                  { header: "Remarks", key: "remarks" },
                  { header: asOfRows ? "As On" : "Last Updated", key: "asOn" },
                ]}
              />
            </span>
          </div>

          {asOfRows ? (
            /* -------- read-only as-of history view -------- */
            <div className="overflow-x-auto">
              <table className="w-full border-collapse text-xs">
                <thead>
                  <tr>
                    {["Vehicle No", "Transporter", "From", "To", "Current Location", "Status", "As On"].map(
                      (h) => (
                        <th key={h} className={`${cell} bg-muted text-left font-semibold`}>
                          {h}
                        </th>
                      )
                    )}
                  </tr>
                </thead>
                <tbody>
                  {asOfRows.map((r) => (
                    <tr key={r.vehicleId}>
                      <td className={cell}>{r.vehicle}</td>
                      <td className={cell}>{r.transporterName}</td>
                      <td className={cell}>{r.fromLocation}</td>
                      <td className={cell}>{r.toLocation}</td>
                      <td className={cell}>{r.currentLocation}</td>
                      <td className={cell}>{r.status}</td>
                      <td className={cell}>{formatDate(r.date)}</td>
                    </tr>
                  ))}
                  {!asOfRows.length && (
                    <tr>
                      <td colSpan={7} className={`${cell} text-center text-muted-foreground`}>
                        No tracking records existed on {dateText}.
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          ) : historyTooOld ? null : (
            /* -------- live editable grid -------- */
            <div className="overflow-x-auto">
              <table className="w-full border-collapse text-xs">
                <thead>
                  <tr>
                    {[
                      "Vehicle No",
                      "Transporter Name",
                      "From",
                      "To",
                      "Current Location",
                      "Status",
                      "Remarks",
                      "Last Updated",
                    ].map((h) => (
                      <th key={h} className={`${cell} bg-muted text-left font-semibold`}>
                        {h}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {live.map((r) => (
                    <tr key={r.vehicleId}>
                      <td className={`${cell} whitespace-nowrap font-medium`}>
                        {vehicleNo.get(r.vehicleId)}
                        {r.status && isIdle(r.status) && (
                          <Badge variant="outline" className="ml-1 text-[10px]">
                            IDLE
                          </Badge>
                        )}
                      </td>
                      {(
                        [
                          ["transporterName", r.transporterName],
                          ["fromLocation", r.fromLocation],
                          ["toLocation", r.toLocation],
                          ["currentLocation", r.currentLocation],
                        ] as const
                      ).map(([field, value]) => (
                        <td key={field} className="border p-0.5">
                          <Input
                            className="h-7 border-0 text-xs shadow-none focus-visible:ring-1"
                            value={value}
                            onChange={(e) => autoSave(r.vehicleId, { [field]: e.target.value })}
                          />
                        </td>
                      ))}
                      <td className="border p-0.5">
                        <Select
                          value={r.status || undefined}
                          onValueChange={(v) => {
                            if (v === "__NEW__") {
                              const name = window
                                .prompt("New status name:")
                                ?.toUpperCase()
                                .trim();
                              if (!name) return;
                              setCustomStatuses((prev) =>
                                prev.includes(name) ? prev : [...prev, name]
                              );
                              autoSave(r.vehicleId, { status: name });
                              return;
                            }
                            autoSave(r.vehicleId, { status: v });
                          }}
                        >
                          <SelectTrigger className="h-7 border-0 text-xs shadow-none">
                            <SelectValue placeholder="Status..." />
                          </SelectTrigger>
                          <SelectContent>
                            {statusOptions.map((s) => (
                              <SelectItem key={s} value={s}>
                                {s.charAt(0) + s.slice(1).toLowerCase()}
                                {IDLE_STATUSES.includes(s) ? "  (available)" : ""}
                              </SelectItem>
                            ))}
                            <SelectItem value="__NEW__">+ New Status...</SelectItem>
                          </SelectContent>
                        </Select>
                      </td>
                      <td className="border p-0.5">
                        <Input
                          className="h-7 border-0 text-xs shadow-none focus-visible:ring-1"
                          value={r.remarks}
                          onChange={(e) => autoSave(r.vehicleId, { remarks: e.target.value })}
                        />
                      </td>
                      <td className={`${cell} whitespace-nowrap text-muted-foreground`}>
                        {saving[r.vehicleId] === "saving" ? (
                          <span className="inline-flex items-center gap-1">
                            <Loader2 className="h-3 w-3 animate-spin" /> saving...
                          </span>
                        ) : saving[r.vehicleId] === "saved" ? (
                          <span className="inline-flex items-center gap-1 text-emerald-600">
                            <CheckCircle2 className="h-3 w-3" /> saved
                          </span>
                        ) : r.lastUpdated ? (
                          formatDate(r.lastUpdated)
                        ) : (
                          "—"
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}

      {tab === "AVAILABLE" && (
        <div className="space-y-2">
          <div className="flex justify-end gap-2">
            <Button
              size="sm"
              variant="outline"
              onClick={() => window.open("/print/vehicle-tracking?view=available", "_blank")}
            >
              <Printer className="h-4 w-4" />
              Print
            </Button>
            <ExportButton
              rows={availableRows}
              fileName="available-for-load"
              sheetName="Available for Load"
              columns={[
                { header: "Vehicle No", key: "vehicle" },
                { header: "Transporter", key: "transporterName" },
                { header: "Current Location", key: "currentLocation" },
                {
                  header: "Available Since",
                  accessor: (r) => (r.availableSince ? formatDate(String(r.availableSince)) : ""),
                },
                { header: "Idle Days", key: "idleDays", numeric: true },
                { header: "Status", key: "status" },
              ]}
            />
          </div>
          <div className="overflow-x-auto">
            <table className="w-full border-collapse text-xs">
              <thead>
                <tr>
                  {[
                    "S.No.",
                    "Vehicle No",
                    "Transporter Name",
                    "Current Location",
                    "Available Since",
                    "Idle Days",
                    "Current Status",
                  ].map((h) => (
                    <th key={h} className={`${cell} bg-muted text-left font-semibold`}>
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {availableRows.map((r, i) => (
                  <tr key={r.vehicleId}>
                    <td className={cell}>{i + 1}</td>
                    <td className={`${cell} font-medium`}>{r.vehicle}</td>
                    <td className={cell}>{r.transporterName}</td>
                    <td className={cell}>{r.currentLocation}</td>
                    <td className={cell}>
                      {r.availableSince ? formatDate(r.availableSince) : ""}
                    </td>
                    <td className={`${cell} text-right`}>
                      <span className={r.idleDays >= 3 ? "font-semibold text-destructive" : ""}>
                        {r.idleDays}
                      </span>
                    </td>
                    <td className={cell}>
                      <Badge variant="outline">{r.status}</Badge>
                    </td>
                  </tr>
                ))}
                {!availableRows.length && (
                  <tr>
                    <td colSpan={7} className={`${cell} py-3 text-center text-muted-foreground`}>
                      No vehicles are currently idle — every tracked vehicle is on the move.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
          <p className="text-xs text-muted-foreground">
            Fully automatic: a vehicle appears here the moment its status becomes idle (Empty /
            Available / Unloaded / Trip Completed / At Yard / Waiting for Load) and disappears when
            it changes to Loading / Running / Unloading / Trip Started. Longest-idle vehicles are
            listed first for dispatch priority.
          </p>
        </div>
      )}
    </div>
  );
}
