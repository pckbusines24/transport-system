import { Suspense } from "react";
import { requireSession } from "@/lib/session";
import { DashboardHero } from "./hero";
import { FinanceCardsSection } from "./finance-cards";
import { getOpsMetrics } from "./ops-metrics";
import {
  CardFallback,
  DocsCard,
  EmiCard,
  EwayCard,
  LrSummarySection,
  OutstandingSection,
  RoutesCard,
  TdsCard,
} from "./sections";

export const dynamic = "force-dynamic";

/**
 * Operational dashboard — E-Way Bill monitoring front door. The card opens the
 * full monitoring screen (five date tabs, check + extend) in a new window.
 *
 * The shell renders immediately; every section streams in independently via
 * Suspense, so one slow query never blanks the whole dashboard. The five
 * operational cards share ONE aggregate fetch (getOpsMetrics) — the promise
 * is started here and awaited by each card.
 */
async function HeroSection({
  name,
  firmName,
  fyLabel,
  metrics,
}: {
  name: string;
  firmName?: string;
  fyLabel?: string;
  metrics: ReturnType<typeof getOpsMetrics>;
}) {
  return (
    <DashboardHero name={name} firmName={firmName} fyLabel={fyLabel} metrics={await metrics} />
  );
}

function HeroFallback() {
  return (
    <div className="space-y-6 pb-2">
      <div className="h-12 w-72 animate-pulse rounded-lg bg-muted" />
      <div className="h-11 animate-pulse rounded-full bg-muted" />
    </div>
  );
}

export default function DashboardPage() {
  const session = requireSession();
  const todayCal = new Date(Date.now() + 5.5 * 3600 * 1000).toISOString().slice(0, 10);
  const metrics = getOpsMetrics(todayCal);
  // an unhandled rejection before the cards attach must not crash the route;
  // each card's own await still surfaces the error to its error boundary
  metrics.catch(() => {});

  return (
    <div className="space-y-6 p-4 sm:p-6">
      {/* streams in with the rest: the hero awaits the SAME metrics promise the
          cards below use, so it adds a section without adding a query */}
      <Suspense fallback={<HeroFallback />}>
        <HeroSection
          name={session.name}
          firmName={session.firmName}
          fyLabel={session.fyLabel}
          metrics={metrics}
        />
      </Suspense>

      {/* date filter here touches ONLY these cards */}
      <FinanceCardsSection defaultFrom={`${todayCal.slice(0, 8)}01`} defaultTo={todayCal} />

      {/* receivable / payable position with ageing drill-down */}
      <Suspense
        fallback={
          <div className="grid gap-3 sm:grid-cols-2">
            <CardFallback />
            <CardFallback />
          </div>
        }
      >
        <OutstandingSection />
      </Suspense>

      {/* LR summary — each card drills into its own dashboard detail page */}
      <Suspense fallback={<CardFallback tall />}>
        <LrSummarySection />
      </Suspense>

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        <Suspense fallback={<CardFallback />}>
          <EwayCard metrics={metrics} />
        </Suspense>
        <Suspense fallback={<CardFallback />}>
          <DocsCard metrics={metrics} />
        </Suspense>
        <Suspense fallback={<CardFallback />}>
          <EmiCard metrics={metrics} />
        </Suspense>
        <Suspense fallback={<CardFallback />}>
          <TdsCard />
        </Suspense>
        <Suspense fallback={<CardFallback />}>
          <RoutesCard metrics={metrics} />
        </Suspense>
      </div>
    </div>
  );
}
