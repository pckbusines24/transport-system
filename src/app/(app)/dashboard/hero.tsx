import { AlertTriangle, CalendarClock, FileWarning, Route, Wallet } from "lucide-react";
import { Stat, SegmentedMeter } from "@/components/ui/stat";
import type { OpsMetrics } from "./ops-metrics";

/**
 * The dashboard's opening band: who you are, then the four numbers worth
 * knowing before you scroll.
 *
 * This deliberately does NOT sit in a card. The reference design puts its
 * headline figures straight on the canvas so the panels below read as the
 * detail; wrapping this in another bordered box would make the page a stack of
 * equal-weight rectangles, which is exactly what made the old dashboard look
 * dated.
 *
 * Every figure here is already fetched by getOpsMetrics for the cards further
 * down, so the band costs nothing extra — it awaits the same promise.
 */
export function DashboardHero({
  name,
  firmName,
  fyLabel,
  metrics,
}: {
  name: string;
  firmName?: string;
  fyLabel?: string;
  metrics: OpsMetrics;
}) {
  const ewayTotal = metrics.expiredCount + metrics.todayCount + metrics.upcomingCount;
  const lanes = metrics.laneAlive + metrics.laneCooling + metrics.laneSleeping;

  // greet by local time rather than a fixed "Welcome" — it is the cheapest way
  // to make a screen feel like it belongs to the person looking at it
  const hour = new Date(Date.now() + 5.5 * 3600 * 1000).getUTCHours();
  const greeting = hour < 12 ? "Good morning" : hour < 17 ? "Good afternoon" : "Good evening";
  const firstName = name.trim().split(/\s+/)[0] || name;

  return (
    <section className="space-y-6 pb-2">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-display">
            {greeting}, {firstName}
          </h1>
          {(firmName || fyLabel) && (
            <p className="mt-2 text-sm text-muted-foreground">
              {firmName}
              {firmName && fyLabel && <span className="mx-1.5 opacity-40">·</span>}
              {fyLabel && `FY ${fyLabel}`}
            </p>
          )}
        </div>

        {/* the four numbers, right-aligned so the greeting owns the left edge */}
        <div className="flex flex-wrap items-start gap-x-9 gap-y-4">
          <Stat
            label="E-way expiring"
            value={metrics.todayCount + metrics.upcomingCount}
            icon={<CalendarClock />}
            size="sm"
          />
          <Stat
            label="Expired"
            value={metrics.expiredCount}
            icon={<AlertTriangle />}
            size="sm"
            hint={metrics.expiredCount > 0 ? "needs action today" : undefined}
          />
          <Stat label="Doc issues" value={metrics.docProblem} icon={<FileWarning />} size="sm" />
          <Stat label="EMIs due" value={metrics.emiDue} icon={<Wallet />} size="sm" />
        </div>
      </div>

      {/* Two meters rather than one: e-way is time-critical and lane health is
          a trend. Sharing a single track would imply they are parts of a whole. */}
      <div className="grid gap-5 lg:grid-cols-2">
        {ewayTotal > 0 && (
          <div>
            <div className="text-eyebrow mb-2.5">E-way bills</div>
            <SegmentedMeter
              segments={[
                { label: "Expired", value: metrics.expiredCount, tone: "ink" },
                { label: "Today", value: metrics.todayCount, tone: "primary" },
                { label: "Upcoming", value: metrics.upcomingCount, tone: "hatched" },
              ]}
            />
          </div>
        )}
        {lanes > 0 && (
          <div>
            <div className="text-eyebrow mb-2.5 flex items-center gap-1.5">
              <Route className="size-3.5" /> Lane activity
            </div>
            <SegmentedMeter
              segments={[
                { label: "Active", value: metrics.laneAlive, tone: "primary" },
                { label: "Cooling", value: metrics.laneCooling, tone: "hatched" },
                { label: "Dormant", value: metrics.laneSleeping, tone: "outline" },
              ]}
            />
          </div>
        )}
      </div>
    </section>
  );
}
