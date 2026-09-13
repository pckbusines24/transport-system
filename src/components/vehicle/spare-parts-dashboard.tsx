"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { AlertTriangle, Boxes, CheckCircle2, PackageOpen, ShieldAlert, ShieldCheck, ShieldX, Wrench } from "lucide-react";
import { formatDate } from "@/lib/utils";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { useToast } from "@/components/ui/use-toast";
import { markWarrantyReviewed } from "@/app/(app)/vehicle/spare-parts/actions";
import type { SparePartRow } from "./spare-parts-types";

const BASE = "/vehicle/spare-parts";

function Tile({
  label, value, href, icon: Icon, tone,
}: { label: string; value: number; href: string; icon: React.ComponentType<{ className?: string }>; tone?: string }) {
  return (
    <Link href={href} className="block">
      <Card className="h-full transition-colors hover:border-primary/50 hover:bg-accent/40">
        <CardContent className="flex items-start gap-3 p-4">
          <span className={`rounded-md p-2 ${tone ?? "bg-primary/10 text-primary"}`}>
            <Icon className="h-4 w-4" />
          </span>
          <span className="min-w-0">
            <span className="block truncate text-xs font-medium text-muted-foreground">{label}</span>
            <span className="block text-xl font-semibold tabular-nums">{value.toLocaleString("en-IN")}</span>
          </span>
        </CardContent>
      </Card>
    </Link>
  );
}

/** Spare Parts dashboard: counts, the 30-day warranty alerts, recent installations. */
export function SparePartsDashboard({ parts }: { parts: SparePartRow[] }) {
  const router = useRouter();
  const { toast } = useToast();
  const [busy, setBusy] = React.useState<string | null>(null);

  const installed = parts.filter((p) => p.status === "INSTALLED");
  const available = parts.filter((p) => p.status === "AVAILABLE");
  const active = parts.filter((p) => p.warranty === "ACTIVE" || p.warranty === "EXPIRING_SOON");
  const expiring30 = parts.filter((p) => p.warranty === "EXPIRING_30");
  const expired = parts.filter((p) => p.warranty === "EXPIRED");
  const claims = parts.reduce((s, p) => s + p.claimCount, 0);

  // alert stays until the warranty expires or the user marks it reviewed
  const alerts = expiring30
    .filter((p) => !p.warrantyReviewedAt)
    .sort((a, b) => (a.daysLeft ?? 0) - (b.daysLeft ?? 0));

  const recent = parts
    .flatMap((p) => p.events.filter((e) => e.type === "INSTALL").map((e) => ({ part: p, event: e })))
    .sort((a, b) => b.event.date.localeCompare(a.event.date))
    .slice(0, 10);

  const review = async (p: SparePartRow) => {
    setBusy(p.id);
    try {
      const res = await markWarrantyReviewed(p.id);
      if (res.ok) {
        toast({ title: `${p.serialNo} marked as reviewed` });
        router.refresh();
      } else toast({ variant: "destructive", title: "Failed", description: res.error });
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="space-y-5">
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Tile label="Total Spare Parts" value={parts.length} href={`${BASE}?tab=parts`} icon={Boxes} />
        <Tile label="Currently Installed" value={installed.length} href={`${BASE}?tab=parts&status=INSTALLED`} icon={Wrench} />
        <Tile label="Available / Uninstalled" value={available.length} href={`${BASE}?tab=parts&status=AVAILABLE`} icon={PackageOpen} />
        <Tile label="Warranty Claims" value={claims} href={`${BASE}?tab=reports&report=claims`} icon={ShieldCheck} />
        <Tile label="Warranty Active" value={active.length} href={`${BASE}?tab=warranty&warranty=ACTIVE`} icon={CheckCircle2} tone="bg-emerald-500/15 text-emerald-700" />
        <Tile label="Expiring Within 30 Days" value={expiring30.length} href={`${BASE}?tab=warranty&warranty=EXPIRING_30`} icon={ShieldAlert} tone="bg-orange-500/15 text-orange-700" />
        <Tile label="Warranty Expired" value={expired.length} href={`${BASE}?tab=warranty&warranty=EXPIRED`} icon={ShieldX} tone="bg-red-500/15 text-red-700" />
        <Tile label="Expiring Soon (31–60 days)" value={parts.filter((p) => p.warranty === "EXPIRING_SOON").length} href={`${BASE}?tab=warranty&warranty=EXPIRING_SOON`} icon={AlertTriangle} tone="bg-yellow-400/25 text-yellow-800" />
      </div>

      {/* ---- 30-day warranty expiry alerts ---- */}
      <Card className={alerts.length ? "border-orange-500/50" : ""}>
        <CardContent className="space-y-3 p-4">
          <div className="flex items-center gap-2 text-sm font-semibold">
            <AlertTriangle className={`h-4 w-4 ${alerts.length ? "text-orange-600" : "text-muted-foreground"}`} />
            ⚠ WARRANTY EXPIRY ALERT
            <span className="text-xs font-normal text-muted-foreground">
              {alerts.length ? `${alerts.length} part(s) expiring within 30 days` : "no warranty is expiring within the next 30 days"}
            </span>
          </div>
          {alerts.length > 0 && (
            <p className="text-xs text-muted-foreground">
              Warranty is going to expire within 30 days. Please inspect the spare part and, if any issue is
              found, arrange replacement or a warranty claim before the warranty expiry date.
            </p>
          )}
          {alerts.map((p) => (
            <div key={p.id} className="flex flex-wrap items-center gap-x-4 gap-y-1 rounded-md border border-orange-500/30 bg-orange-500/5 px-3 py-2 text-sm">
              <Link href={`${BASE}?tab=parts&part=${p.id}`} className="font-semibold text-primary hover:underline">
                {p.name}
              </Link>
              <span><b>Unique No.:</b> {p.serialNo}</span>
              <span><b>Vehicle:</b> {p.currentVehicle || "not installed"}</span>
              <span><b>Warranty Expiry:</b> {p.warrantyExpiry ? formatDate(p.warrantyExpiry) : ""}</span>
              <span className="font-semibold text-orange-700"><b>Days Remaining:</b> {p.daysLeft} Days</span>
              <span className="ml-auto flex gap-1">
                <Button asChild variant="outline" size="sm" className="h-7 px-2 text-xs">
                  <Link href={`${BASE}?tab=parts&part=${p.id}`}>Open</Link>
                </Button>
                {p.currentVehicleId && (
                  <Button asChild variant="outline" size="sm" className="h-7 px-2 text-xs">
                    <Link href={`${BASE}?tab=vehicle&vehicleId=${p.currentVehicleId}`}>Vehicle</Link>
                  </Button>
                )}
                <Button size="sm" variant="secondary" className="h-7 px-2 text-xs" disabled={busy === p.id} onClick={() => void review(p)}>
                  Mark reviewed
                </Button>
              </span>
            </div>
          ))}
        </CardContent>
      </Card>

      {/* ---- recent installations ---- */}
      <Card>
        <CardContent className="p-4">
          <div className="mb-2 text-sm font-semibold">Recent Spare Part Installations</div>
          <div className="overflow-x-auto">
            <table className="w-full border-collapse text-xs">
              <thead className="bg-muted/60">
                <tr>
                  {["Date", "Vehicle", "Spare Part", "Serial No", "KM Reading", "Workshop", "Warranty"].map((h) => (
                    <th key={h} className="border-b px-2 py-1 text-left font-semibold">{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {recent.map(({ part, event }) => (
                  <tr key={event.id} className="border-b last:border-0">
                    <td className="whitespace-nowrap px-2 py-1">{formatDate(event.date)}</td>
                    <td className="px-2 py-1">{event.vehicle}</td>
                    <td className="px-2 py-1">{part.name}</td>
                    <td className="px-2 py-1">
                      <Link href={`${BASE}?tab=parts&part=${part.id}`} className="text-primary hover:underline">{part.serialNo}</Link>
                    </td>
                    <td className="whitespace-nowrap px-2 py-1 tabular-nums">{event.km === null ? "—" : `${event.km.toLocaleString("en-IN")} KM`}</td>
                    <td className="px-2 py-1">{event.workshop || "—"}</td>
                    <td className="px-2 py-1">{part.warrantyExpiry ? `till ${formatDate(part.warrantyExpiry)}` : "—"}</td>
                  </tr>
                ))}
                {recent.length === 0 && (
                  <tr><td colSpan={7} className="px-2 py-3 text-center text-muted-foreground">No installations recorded yet.</td></tr>
                )}
              </tbody>
            </table>
          </div>
        </CardContent>
      </Card>

      <p className="text-xs text-muted-foreground">
        Operational tracking only — this module never creates a voucher, expense, purchase, stock or Tally entry.
      </p>
    </div>
  );
}
