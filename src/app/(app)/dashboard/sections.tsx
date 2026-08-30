import { ClipboardCheck, FileCheck2, IndianRupee, Map as MapIcon, Percent } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { InfoHint } from "@/components/ui/info-hint";
import { formatMoney } from "@/lib/utils";
import { getLrSummary } from "./lr-actions";
import { getOutstandingAgeing } from "./outstanding-actions";
import { getTdsMonitor } from "./tds-actions";
import { LrPipeline } from "./lr-pipeline";
import type { OpsMetrics } from "./ops-metrics";

/**
 * Dashboard sections as independent async server components. Each one is
 * wrapped in <Suspense> by the page, so the shell paints immediately and
 * every card streams in as its own data arrives — no card waits for the
 * slowest query on the page.
 */

export function CardFallback({ tall }: { tall?: boolean }) {
  return (
    <Card className="h-full">
      <CardContent className="space-y-3 p-5">
        <Skeleton className="h-6 w-40" />
        <Skeleton className={tall ? "h-16 w-full" : "h-8 w-3/4"} />
      </CardContent>
    </Card>
  );
}

/* ----------------------------- outstanding ----------------------------- */

function AgeingCard({
  side,
  label,
  colorClass,
  totals,
}: {
  side: "RECV" | "PAY";
  label: string;
  colorClass: string;
  totals: { total: number; parties: number; b90: number };
}) {
  return (
    <a href={`/dashboard/outstanding?side=${side}`} target="_blank" rel="noreferrer" className="group">
      <Card className="h-full transition-all hover:border-primary/40 hover:shadow-card">
        <CardContent className="p-5">
          <span className="flex items-center gap-1.5 text-lg font-semibold group-hover:text-primary">
            {label}
            <InfoHint>
              {side === "RECV"
                ? "Open party bills by settlement math — click for party-wise ageing (0–30 / 31–60 / 61–90 / 90+ days) with pending documents"
                : "Open payables — market chalan balances, broker slips and hire slips — click for party-wise ageing with pending documents"}
            </InfoHint>
          </span>
          <div className={`mt-1 text-2xl font-black tabular-nums ${colorClass}`}>
            {formatMoney(totals.total)}
          </div>
          <div className="mt-1 flex flex-wrap gap-2 text-xs font-medium">
            <span className="rounded bg-blue-500/10 px-2 py-0.5 text-blue-600">
              {totals.parties} parties
            </span>
            {totals.b90 > 0 && (
              <span className="rounded bg-red-500/10 px-2 py-0.5 text-red-600">
                90+ days: {formatMoney(totals.b90)}
              </span>
            )}
          </div>
        </CardContent>
      </Card>
    </a>
  );
}

export async function OutstandingSection() {
  const [recvRes, payRes] = await Promise.all([
    getOutstandingAgeing({ side: "RECV" }),
    getOutstandingAgeing({ side: "PAY" }),
  ]);
  const recv = recvRes.ok ? recvRes.data.totals : null;
  const pay = payRes.ok ? payRes.data.totals : null;
  if (!recv && !pay) return null;
  return (
    <div className="grid gap-3 sm:grid-cols-2">
      {recv && <AgeingCard side="RECV" label="Receivable" colorClass="text-emerald-600" totals={recv} />}
      {pay && <AgeingCard side="PAY" label="Payable" colorClass="text-red-600" totals={pay} />}
    </div>
  );
}

/* ------------------------------ LR summary ------------------------------ */

export async function LrSummarySection() {
  const lrSummary = await getLrSummary();
  if (!lrSummary.ok) return null;
  return <LrPipeline cards={lrSummary.cards} />;
}

/* ---------------------------- operational cards ---------------------------- */

export async function EwayCard({ metrics }: { metrics: Promise<OpsMetrics> }) {
  const { expiredCount, todayCount, upcomingCount } = await metrics;
  return (
    <a href="/eway" target="_blank" rel="noreferrer" className="group">
      <Card className="h-full transition-all hover:border-primary/40 hover:shadow-card">
        <CardContent className="flex items-start gap-3 p-5">
          <span className="mt-0.5 flex h-11 w-11 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
            <FileCheck2 className="h-6 w-6" />
          </span>
          <span className="min-w-0">
            <span className="flex items-center gap-1.5 text-lg font-semibold group-hover:text-primary">
              E-Way Bill (3 Days)
              <InfoHint>Expiring e-way bills — check &amp; extend from one screen</InfoHint>
            </span>
            <span className="mt-2 flex flex-wrap gap-2 text-xs font-medium">
              <span className="rounded bg-red-500/10 px-2 py-0.5 text-red-600">
                Expired: {expiredCount}
              </span>
              <span className="rounded bg-amber-500/10 px-2 py-0.5 text-amber-600">
                Today: {todayCount}
              </span>
              <span className="rounded bg-emerald-500/10 px-2 py-0.5 text-emerald-600">
                Next 2 days: {upcomingCount}
              </span>
            </span>
          </span>
        </CardContent>
      </Card>
    </a>
  );
}

export async function DocsCard({ metrics }: { metrics: Promise<OpsMetrics> }) {
  const { docTypeCounts, docProblem, docExpired } = await metrics;
  return (
    <a href="/documents-status" target="_blank" rel="noreferrer" className="group">
      <Card className="h-full transition-all hover:border-primary/40 hover:shadow-card">
        <CardContent className="flex items-start gap-3 p-5">
          <span className="mt-0.5 flex h-11 w-11 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
            <ClipboardCheck className="h-6 w-6" />
          </span>
          <span className="min-w-0">
            <span className="flex items-center gap-1.5 text-lg font-semibold group-hover:text-primary">
              Document Registration
              <InfoHint>Renewal workflow — bulk / individual status update</InfoHint>
            </span>
            <span className="mt-2 flex flex-wrap gap-1.5 text-xs font-medium">
              {docTypeCounts.length === 0 ? (
                <span className="rounded bg-emerald-500/10 px-2 py-0.5 text-emerald-600">
                  All documents in order
                </span>
              ) : (
                docTypeCounts.map((t) => (
                  <span key={t.name} className="rounded bg-amber-500/10 px-2 py-0.5 text-amber-700 dark:text-amber-500">
                    {t.name} ({t.count})
                  </span>
                ))
              )}
              {docExpired > 0 && (
                <span className="rounded bg-red-500/15 px-2 py-0.5 font-semibold text-red-600">
                  EXPIRED: {docExpired}
                </span>
              )}
              {docProblem > 0 && (
                <span className="rounded bg-red-500/10 px-2 py-0.5 text-red-600">
                  Problem: {docProblem}
                </span>
              )}
            </span>
          </span>
        </CardContent>
      </Card>
    </a>
  );
}

export async function EmiCard({ metrics }: { metrics: Promise<OpsMetrics> }) {
  const { emiActive, emiDue } = await metrics;
  return (
    <a href="/emi-due" target="_blank" rel="noreferrer" className="group">
      <Card className="h-full transition-all hover:border-primary/40 hover:shadow-card">
        <CardContent className="flex items-start gap-3 p-5">
          <span className="mt-0.5 flex h-11 w-11 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
            <IndianRupee className="h-6 w-6" />
          </span>
          <span className="min-w-0">
            <span className="flex items-center gap-1.5 text-lg font-semibold group-hover:text-primary">
              EMI Due
              <InfoHint>Upcoming loan EMIs — pay from one list</InfoHint>
            </span>
            <span className="mt-2 flex flex-wrap gap-2 text-xs font-medium">
              <span className="rounded bg-blue-500/10 px-2 py-0.5 text-blue-600">
                Active EMI loans: {emiActive}
              </span>
              {emiDue > 0 && (
                <span className="rounded bg-red-500/10 px-2 py-0.5 text-red-600">
                  Due now: {emiDue}
                </span>
              )}
            </span>
          </span>
        </CardContent>
      </Card>
    </a>
  );
}

export async function TdsCard() {
  const tdsRes = await getTdsMonitor();
  const tds = tdsRes.ok ? tdsRes.data : null;
  return (
    <a href="/dashboard/tds-monitor" target="_blank" rel="noreferrer" className="group">
      <Card className="h-full transition-all hover:border-primary/40 hover:shadow-card">
        <CardContent className="flex items-start gap-3 p-5">
          <span className="mt-0.5 flex h-11 w-11 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
            <Percent className="h-6 w-6" />
          </span>
          <span className="min-w-0">
            <span className="flex items-center gap-1.5 text-lg font-semibold group-hover:text-primary">
              TDS Threshold Monitor
              <InfoHint>
                Supplier-wise limits per TDS section (heads connected in the TDS Master) —
                who crossed, who is close, and the TDS still to deduct
              </InfoHint>
            </span>
            <span className="mt-2 flex flex-wrap gap-2 text-xs font-medium">
              {tds && tds.crossedCount > 0 && (
                <span className="rounded bg-red-500/10 px-2 py-0.5 text-red-600">
                  Crossed: {tds.crossedCount}
                </span>
              )}
              {tds && tds.nearCount > 0 && (
                <span className="rounded bg-amber-500/10 px-2 py-0.5 text-amber-600">
                  Near limit: {tds.nearCount}
                </span>
              )}
              {tds && tds.toDeductTotal > 0 ? (
                <span className="rounded bg-red-500/10 px-2 py-0.5 text-red-600">
                  To deduct: {formatMoney(tds.toDeductTotal)}
                </span>
              ) : (
                <span className="rounded bg-emerald-500/10 px-2 py-0.5 text-emerald-600">
                  All clear
                </span>
              )}
            </span>
          </span>
        </CardContent>
      </Card>
    </a>
  );
}

export async function RoutesCard({ metrics }: { metrics: Promise<OpsMetrics> }) {
  const { laneAlive, laneCooling, laneSleeping } = await metrics;
  return (
    <a href="/routes" target="_blank" rel="noreferrer" className="group">
      <Card className="h-full transition-all hover:border-primary/40 hover:shadow-card">
        <CardContent className="flex items-start gap-3 p-5">
          <span className="mt-0.5 flex h-11 w-11 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
            <MapIcon className="h-6 w-6" />
          </span>
          <span className="min-w-0">
            <span className="flex items-center gap-1.5 text-lg font-semibold group-hover:text-primary">
              Route Activity Monitor
              <InfoHint>
                Lane-wise trip activity from the last trip date — reconnect with parties on
                inactive routes before they go cold
              </InfoHint>
            </span>
            <span className="mt-2 flex flex-wrap gap-2 text-xs font-medium">
              {laneSleeping > 0 && (
                <span className="rounded bg-red-500/10 px-2 py-0.5 text-red-600">
                  🔴 Inactive: {laneSleeping}
                </span>
              )}
              {laneCooling > 0 && (
                <span className="rounded bg-amber-500/10 px-2 py-0.5 text-amber-700 dark:text-amber-500">
                  🟠 Slowing: {laneCooling}
                </span>
              )}
              <span className="rounded bg-emerald-500/10 px-2 py-0.5 text-emerald-600">
                🟢 Active: {laneAlive}
              </span>
            </span>
          </span>
        </CardContent>
      </Card>
    </a>
  );
}
