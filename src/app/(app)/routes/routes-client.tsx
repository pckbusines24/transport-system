"use client";

import * as React from "react";
import { formatDate } from "@/lib/utils";
import { InfoHint } from "@/components/ui/info-hint";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ExportButton } from "@/components/data/export-button";

export interface RouteRow {
  route: string;
  totalTrips: number;
  tripsThisMonth: number;
  tripsLastMonth: number;
  lastTripDate: string;
  daysSince: number;
  avgFreight: number;
  /** avg per-MT rate the party pays (from LR items / slip party rate) */
  avgPartyRate: number;
  /** avg market vehicle cost per trip on this lane */
  avgVehicleAmt: number;
  /** avg party freight − avg vehicle cost; null when either side has no data */
  marginPerTrip: number | null;
  status: "ALIVE" | "COOLING" | "SLEEPING" | "OCCASIONAL";
  topParties: { name: string; mobile: string | null; trips: number }[];
  partyHistory: { date: string; refNo: string; party: string; rate: number; freight: number }[];
  vehicleHistory: { date: string; refNo: string; broker: string; vehicle: string; amount: number }[];
}

const STATUS_META: Record<RouteRow["status"], { label: string; variant: "default" | "secondary" | "destructive" | "outline" }> = {
  ALIVE: { label: "🟢 Active", variant: "default" },
  COOLING: { label: "🟠 Slowing", variant: "secondary" },
  SLEEPING: { label: "🔴 Inactive", variant: "destructive" },
  OCCASIONAL: { label: "Occasional", variant: "outline" },
};

function Trend({ now, prev }: { now: number; prev: number }) {
  if (now > prev) return <span className="font-bold text-emerald-600">▲ {now - prev}</span>;
  if (now < prev) return <span className="font-bold text-red-600">▼ {prev - now}</span>;
  return <span className="text-muted-foreground">—</span>;
}

export function RoutesClient({ rows }: { rows: RouteRow[] }) {
  const [status, setStatus] = React.useState<"ALL" | RouteRow["status"]>("ALL");
  const [q, setQ] = React.useState("");

  const list = rows.filter((r) => {
    if (status !== "ALL" && r.status !== status) return false;
    if (q && !r.route.toLowerCase().includes(q.toLowerCase())) return false;
    return true;
  });

  const counts = {
    ALIVE: rows.filter((r) => r.status === "ALIVE").length,
    COOLING: rows.filter((r) => r.status === "COOLING").length,
    SLEEPING: rows.filter((r) => r.status === "SLEEPING").length,
    OCCASIONAL: rows.filter((r) => r.status === "OCCASIONAL").length,
  };

  return (
    <div className="space-y-3 p-4">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <h1 className="page-title flex items-center gap-2">
            Route Activity Monitor
            <InfoHint>
              Lane-wise trip activity based on the last trip date. Open an inactive route to call
              its top parties before the business goes elsewhere.
            </InfoHint>
          </h1>
        </div>
        <ExportButton
          rows={list}
          fileName="route-activity"
          sheetName="Routes"
          columns={[
            { header: "Route", key: "route", width: 30 },
            { header: "Status", accessor: (r) => r.status },
            { header: "Trips (This Month)", key: "tripsThisMonth", numeric: true },
            { header: "Trips (Last Month)", key: "tripsLastMonth", numeric: true },
            { header: "Total Trips", key: "totalTrips", numeric: true },
            { header: "Last Trip", accessor: (r) => formatDate(r.lastTripDate) },
            { header: "Days Since", key: "daysSince", numeric: true },
          ]}
        />
      </div>

      {/* status chips */}
      <div className="flex flex-wrap items-center gap-2">
        {(
          [
            ["ALL", `All (${rows.length})`],
            ["SLEEPING", `🔴 Inactive (${counts.SLEEPING})`],
            ["COOLING", `🟠 Slowing (${counts.COOLING})`],
            ["ALIVE", `🟢 Active (${counts.ALIVE})`],
            ["OCCASIONAL", `Occasional (${counts.OCCASIONAL})`],
          ] as const
        ).map(([s, label]) => (
          <Button
            key={s}
            size="sm"
            variant={status === s ? "default" : "outline"}
            className="h-8"
            onClick={() => setStatus(s)}
          >
            {label}
          </Button>
        ))}
        <div className="w-56">
          <Input className="h-8" placeholder="Search route..." value={q} onChange={(e) => setQ(e.target.value)} />
        </div>
      </div>

      <div className="overflow-x-auto rounded-md border">
        <table className="w-full text-sm">
          <thead className="sticky top-0 bg-muted/80 backdrop-blur">
            <tr>
              {["Route", "Status", "This Month", "Last Month", "Trend", "Total", "Last Trip"].map((h) => (
                <th key={h} className="whitespace-nowrap px-2 py-1.5 text-left text-xs font-medium text-muted-foreground">
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {list.length === 0 ? (
              <tr>
                <td colSpan={7} className="h-20 text-center text-muted-foreground">
                  No routes yet — LR entries will build this automatically.
                </td>
              </tr>
            ) : (
              list.map((r) => (
                <tr key={r.route} className="border-t hover:bg-muted/40">
                  <td className="px-2 py-1.5 font-medium uppercase">{r.route}</td>
                  <td className="px-2 py-1.5">
                    <Badge variant={STATUS_META[r.status].variant}>{STATUS_META[r.status].label}</Badge>
                  </td>
                  <td className="px-2 py-1.5 text-center tabular-nums">{r.tripsThisMonth}</td>
                  <td className="px-2 py-1.5 text-center tabular-nums">{r.tripsLastMonth}</td>
                  <td className="px-2 py-1.5 text-center">
                    <Trend now={r.tripsThisMonth} prev={r.tripsLastMonth} />
                  </td>
                  <td className="px-2 py-1.5 text-center tabular-nums">{r.totalTrips}</td>
                  <td className="whitespace-nowrap px-2 py-1.5">
                    {formatDate(r.lastTripDate)}
                    <span className={`ml-1 text-xs ${r.daysSince > 20 ? "font-bold text-destructive" : "text-muted-foreground"}`}>
                      ({r.daysSince} days)
                    </span>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

    </div>
  );
}
