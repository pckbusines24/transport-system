"use client";

import * as React from "react";
import { Phone } from "lucide-react";
import { formatDate, formatMoney } from "@/lib/utils";
import { waLink } from "@/lib/phone";
import { InfoHint } from "@/components/ui/info-hint";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
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
  const [partiesFor, setPartiesFor] = React.useState<RouteRow | null>(null);

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
            { header: "Avg Freight", key: "avgFreight", numeric: true },
            { header: "Avg Party Rate", key: "avgPartyRate", numeric: true },
            { header: "Avg Vehicle Rate", key: "avgVehicleAmt", numeric: true },
            { header: "Margin/Trip", accessor: (r) => r.marginPerTrip ?? "" , numeric: true },
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
              {["Route", "Status", "This Month", "Last Month", "Trend", "Total", "Last Trip", "Avg Freight", "Avg Vehicle Rate", "Margin/Trip", "Rates & Parties"].map((h) => (
                <th key={h} className="whitespace-nowrap px-2 py-1.5 text-left text-xs font-medium text-muted-foreground">
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {list.length === 0 ? (
              <tr>
                <td colSpan={11} className="h-20 text-center text-muted-foreground">
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
                  <td className="px-2 py-1.5 text-right tabular-nums">
                    {formatMoney(r.avgFreight)}
                    {r.avgPartyRate > 0 && (
                      <span className="block text-[10px] text-muted-foreground">@{r.avgPartyRate.toFixed(2)}/MT</span>
                    )}
                  </td>
                  <td className="px-2 py-1.5 text-right tabular-nums">
                    {r.avgVehicleAmt > 0 ? formatMoney(r.avgVehicleAmt) : "—"}
                  </td>
                  <td className="px-2 py-1.5 text-right tabular-nums">
                    {r.marginPerTrip === null ? (
                      "—"
                    ) : (
                      <b className={r.marginPerTrip >= 0 ? "text-emerald-600" : "text-red-600"}>
                        {formatMoney(r.marginPerTrip)}
                      </b>
                    )}
                  </td>
                  <td className="px-2 py-1.5">
                    <Button
                      variant="outline"
                      size="sm"
                      className="h-7 px-2 text-xs"
                      onClick={() => setPartiesFor(r)}
                    >
                      Rate Memory
                    </Button>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      {/* Rate Memory: rate history both sides + top parties with call links */}
      <Dialog open={!!partiesFor} onOpenChange={(o) => !o && setPartiesFor(null)}>
        <DialogContent className="max-h-[92vh] overflow-y-auto sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle className="uppercase">{partiesFor?.route}</DialogTitle>
            <DialogDescription>
              Rate history for both sides of this lane — what parties have been paying, what
              vehicles have been costing, and the margin in between.
            </DialogDescription>
          </DialogHeader>

          {partiesFor && (
            <div className="grid gap-3 sm:grid-cols-2">
              {/* party side */}
              <div className="rounded-md border p-2">
                <div className="mb-1 text-xs font-black uppercase text-muted-foreground">
                  Party Side — last {partiesFor.partyHistory.length} LR/Slip
                </div>
                {partiesFor.partyHistory.length === 0 && (
                  <p className="text-xs text-muted-foreground">No bookings yet.</p>
                )}
                {partiesFor.partyHistory.map((h) => (
                  <div key={`${h.refNo}-${h.date}`} className="flex items-center justify-between gap-2 border-b py-1 text-xs last:border-0">
                    <span>
                      {formatDate(h.date)} · <b>{h.party || h.refNo}</b>
                      {h.rate > 0 && <span className="text-muted-foreground"> @{h.rate.toFixed(2)}/MT</span>}
                    </span>
                    <span className="font-medium tabular-nums">{formatMoney(h.freight)}</span>
                  </div>
                ))}
                <div className="mt-1 text-xs font-bold">
                  Avg: {formatMoney(partiesFor.avgFreight)}
                  {partiesFor.avgPartyRate > 0 && ` (@${partiesFor.avgPartyRate.toFixed(2)}/MT)`}
                </div>
              </div>
              {/* vehicle side */}
              <div className="rounded-md border p-2">
                <div className="mb-1 text-xs font-black uppercase text-muted-foreground">
                  Vehicle Side — last {partiesFor.vehicleHistory.length} market vehicles
                </div>
                {partiesFor.vehicleHistory.length === 0 && (
                  <p className="text-xs text-muted-foreground">No market vehicle on this lane yet.</p>
                )}
                {partiesFor.vehicleHistory.map((h) => (
                  <div key={`${h.refNo}-${h.date}`} className="flex items-center justify-between gap-2 border-b py-1 text-xs last:border-0">
                    <span>
                      {formatDate(h.date)} · <b>{h.broker || h.refNo}</b>
                      {h.vehicle && <span className="text-muted-foreground"> · {h.vehicle}</span>}
                    </span>
                    <span className="font-medium tabular-nums">{formatMoney(h.amount)}</span>
                  </div>
                ))}
                {partiesFor.avgVehicleAmt > 0 && (
                  <div className="mt-1 text-xs font-bold">Avg: {formatMoney(partiesFor.avgVehicleAmt)}</div>
                )}
              </div>
            </div>
          )}
          {partiesFor?.marginPerTrip !== null && partiesFor && (
            <div className="rounded-md border bg-muted/40 p-2 text-sm font-bold">
              Average Margin/Trip:{" "}
              <span className={partiesFor.marginPerTrip! >= 0 ? "text-emerald-600" : "text-red-600"}>
                {formatMoney(partiesFor.marginPerTrip!)}
              </span>
            </div>
          )}

          <div className="text-xs font-black uppercase text-muted-foreground">
            Who to Call — top parties on this lane
          </div>
          <div className="space-y-1.5">
            {partiesFor?.topParties.length === 0 && (
              <p className="text-sm text-muted-foreground">No party data on this lane.</p>
            )}
            {partiesFor?.topParties.map((p) => (
              <div key={p.name} className="flex items-center justify-between gap-2 rounded-md border p-2">
                <div>
                  <div className="font-medium">{p.name}</div>
                  <div className="text-xs text-muted-foreground">
                    {p.trips} trip(s){p.mobile ? ` · ${p.mobile}` : " · no mobile in master"}
                  </div>
                </div>
                {p.mobile && (
                  <div className="flex gap-1">
                    <Button asChild variant="outline" size="sm" className="h-7 px-2 text-xs">
                      <a href={`tel:${p.mobile}`}>
                        <Phone className="h-3 w-3" /> Call
                      </a>
                    </Button>
                    {waLink(p.mobile) && (
                      <Button asChild variant="outline" size="sm" className="h-7 px-2 text-xs">
                        <a href={waLink(p.mobile)!} target="_blank" rel="noreferrer">
                          WhatsApp
                        </a>
                      </Button>
                    )}
                  </div>
                )}
              </div>
            ))}
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
