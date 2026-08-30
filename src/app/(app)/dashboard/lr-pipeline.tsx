import { InfoHint } from "@/components/ui/info-hint";
import { Card, CardContent, CardTitle, CardToolbar } from "@/components/ui/card";
import { cn, formatMoney } from "@/lib/utils";
import { LR_VIEW_META, type LrView } from "./lr-views";

export interface LrSummaryCard {
  view: LrView;
  count: number;
  amount: number | null;
}

/**
 * These views are not six peers — they are STAGES of one journey, plus a
 * couple of exception buckets. Rendering them as identical bordered boxes hid
 * that completely and turned the dashboard into a wall of repeated
 * label-and-number tiles. Showing the flow as a flow says something the
 * numbers alone do not: where work is piling up.
 *
 * Presentation only, and deliberately separate from the fetch, so it can be
 * rendered and judged without a database.
 */
const STAGES: LrView[] = ["TOTAL", "NO_CHALAN", "PENDING", "RECEIVED", "BILLED"];

export function LrPipeline({ cards }: { cards: LrSummaryCard[] }) {
  const byView = new Map(cards.map((c) => [c.view, c]));
  const stages = STAGES.map((v) => byView.get(v)).filter(Boolean) as LrSummaryCard[];
  const exceptions = cards.filter((c) => !STAGES.includes(c.view));

  return (
    <Card>
      <CardToolbar>
        <CardTitle>LR pipeline</CardTitle>
      </CardToolbar>
      <CardContent className="space-y-4">
        <div className="flex flex-wrap items-stretch gap-1.5">
          {stages.map((c, i) => (
            <a
              key={c.view}
              href={`/dashboard/lr-detail?view=${c.view}`}
              target="_blank"
              rel="noreferrer"
              className={cn(
                "group/lr flex min-w-[8.5rem] flex-1 flex-col rounded-xl px-4 py-3 transition-colors duration-fast",
                // the first stage is the whole population, so it carries the
                // emphasis and the rest read as what happened to it
                i === 0
                  ? "bg-inverted text-inverted-foreground hover:bg-inverted/90"
                  : "bg-sunken hover:bg-accent/60"
              )}
            >
              <span
                className={cn(
                  "flex items-center gap-1 text-[11px] font-medium uppercase tracking-[0.06em]",
                  i === 0 ? "text-inverted-muted" : "text-muted-foreground"
                )}
              >
                {LR_VIEW_META[c.view].title}
                <InfoHint>{LR_VIEW_META[c.view].info}</InfoHint>
              </span>
              <span className="mt-2 text-2xl font-light leading-none tabular-nums">{c.count}</span>
              {c.amount !== null && (
                <span
                  className={cn(
                    "mt-1 text-xs tabular-nums",
                    i === 0 ? "text-inverted-muted" : "text-muted-foreground"
                  )}
                >
                  {formatMoney(c.amount)}
                </span>
              )}
            </a>
          ))}
        </div>

        {/* the buckets that mean someone has to act, kept out of the flow so
            they do not read as just another stage */}
        {exceptions.length > 0 && (
          <div className="flex flex-wrap gap-x-6 gap-y-2 border-t border-border/60 pt-3">
            {exceptions.map((c) => (
              <a
                key={c.view}
                href={`/dashboard/lr-detail?view=${c.view}`}
                target="_blank"
                rel="noreferrer"
                className="group/x flex items-baseline gap-2 text-sm"
              >
                <span className="text-base font-medium tabular-nums">{c.count}</span>
                <span className="text-muted-foreground group-hover/x:text-foreground">
                  {LR_VIEW_META[c.view].title}
                </span>
                {c.amount !== null && (
                  <span className="text-xs tabular-nums text-muted-foreground/80">
                    {formatMoney(c.amount)}
                  </span>
                )}
              </a>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
