import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { Card, CardContent } from "@/components/ui/card";
import { cn } from "@/lib/utils";

/**
 * Headline figures — the "78 Employees / 56 Hirings" row.
 *
 * The number is LIGHT and large, the label is small and quiet. That contrast is
 * what makes a metric read as a headline instead of as body text, and it is
 * why these must not be rebuilt ad hoc with text-2xl font-bold on each screen.
 */
const statValueVariants = cva("font-light leading-none tracking-[-0.03em] tabular-nums", {
  variants: {
    size: {
      sm: "text-2xl",
      default: "text-3xl sm:text-4xl",
      lg: "text-4xl sm:text-5xl",
    },
  },
  defaultVariants: { size: "default" },
});

export interface StatProps
  extends React.HTMLAttributes<HTMLDivElement>,
    VariantProps<typeof statValueVariants> {
  label: string;
  value: React.ReactNode;
  /** small glyph shown beside the label — pass a lucide icon */
  icon?: React.ReactNode;
  /** signed change; positive renders success, negative destructive */
  delta?: number;
  deltaSuffix?: string;
  hint?: string;
}

export function Stat({
  label,
  value,
  icon,
  delta,
  deltaSuffix = "",
  hint,
  size,
  className,
  ...props
}: StatProps) {
  return (
    <div className={cn("min-w-0", className)} {...props}>
      <div className={statValueVariants({ size })}>{value}</div>
      <div className="mt-1.5 flex items-center gap-1.5">
        {icon && <span className="text-muted-foreground [&_svg]:size-3.5">{icon}</span>}
        <span className="truncate text-sm text-muted-foreground">{label}</span>
        {typeof delta === "number" && delta !== 0 && (
          <span
            className={cn(
              "text-xs font-medium tabular-nums",
              delta > 0 ? "text-success" : "text-destructive"
            )}
          >
            {delta > 0 ? "↑" : "↓"}
            {Math.abs(delta)}
            {deltaSuffix}
          </span>
        )}
      </div>
      {hint && <div className="mt-0.5 truncate text-xs text-muted-foreground/80">{hint}</div>}
    </div>
  );
}

/**
 * The segmented percentage bar from the reference header — several labelled
 * pills sharing one track, each sized by its own share.
 *
 * Segments whose share is too small to hold a label still keep a minimum
 * width, so a 2% segment stays visible and clickable instead of collapsing.
 */
export interface MeterSegment {
  label: string;
  value: number;
  tone?: "ink" | "primary" | "hatched" | "outline";
}

export function SegmentedMeter({
  segments,
  className,
  suffix = "",
}: {
  segments: MeterSegment[];
  className?: string;
  /**
   * Appended to each segment's printed value. Empty by default, because the
   * width ALREADY encodes the share — printing "%" on a raw count would claim
   * that 4 expired bills are 4 percent of something, which is simply false.
   * Pass "%" only when the values really are percentages.
   */
  suffix?: string;
}) {
  const total = segments.reduce((s, x) => s + Math.max(0, x.value), 0) || 1;
  return (
    <div className={cn("flex items-stretch gap-2", className)}>
      {segments.map((s) => {
        const pct = Math.max(0, s.value) / total;
        return (
          <div
            key={s.label}
            className="min-w-[4.5rem] shrink-0"
            style={{ flexGrow: Math.max(pct, 0.06), flexBasis: 0 }}
          >
            <div className="mb-1.5 truncate text-sm text-muted-foreground">{s.label}</div>
            <div
              className={cn(
                "flex h-11 items-center rounded-full px-4 text-sm font-medium",
                s.tone === "ink" && "bg-inverted text-inverted-foreground",
                s.tone === "primary" && "bg-primary text-primary-foreground",
                s.tone === "outline" && "border border-border text-foreground",
                (s.tone === "hatched" || !s.tone) &&
                  "border border-border/60 bg-[repeating-linear-gradient(135deg,hsl(var(--muted))_0_6px,transparent_6px_12px)] text-muted-foreground"
              )}
            >
              {s.value}
              {suffix}
            </div>
          </div>
        );
      })}
    </div>
  );
}

/** A single-value progress track. */
export function Meter({
  value,
  max = 100,
  tone = "primary",
  className,
  label,
}: {
  value: number;
  max?: number;
  tone?: "primary" | "ink" | "success";
  className?: string;
  label?: string;
}) {
  const pct = Math.min(100, Math.max(0, (value / (max || 1)) * 100));
  return (
    <div className={cn("space-y-1.5", className)}>
      {label && (
        <div className="flex items-baseline justify-between text-sm">
          <span className="text-muted-foreground">{label}</span>
          <span className="font-medium tabular-nums">{Math.round(pct)}%</span>
        </div>
      )}
      <div
        className="h-2 overflow-hidden rounded-full bg-muted"
        role="progressbar"
        aria-valuenow={Math.round(pct)}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-label={label}
      >
        <div
          className={cn(
            "h-full rounded-full transition-[width] duration-500 ease-out",
            tone === "primary" && "bg-primary",
            tone === "ink" && "bg-inverted",
            tone === "success" && "bg-success"
          )}
          style={{ width: `${pct}%` }}
        />
      </div>
    </div>
  );
}

/**
 * A headline figure in a card — the "label over a big number" tile that every
 * register and report page had rebuilt by hand.
 *
 * Those copies had drifted: different paddings, different type sizes, some
 * bold and some not. One component means a change to the pattern lands
 * everywhere at once, which is the whole point of having a design system
 * rather than a set of conventions.
 */
export function StatCard({
  label,
  value,
  hint,
  tone = "default",
  className,
}: {
  label: React.ReactNode;
  value: React.ReactNode;
  hint?: React.ReactNode;
  /** colours the FIGURE only — the card stays neutral so a row of these reads
   *  as one group rather than as a traffic light */
  tone?: "default" | "success" | "destructive" | "muted";
  className?: string;
}) {
  return (
    <Card className={className}>
      <CardContent className="p-5">
        <div className="text-eyebrow">{label}</div>
        <div
          className={cn(
            "mt-2 text-3xl font-light leading-none tracking-[-0.02em] tabular-nums",
            tone === "success" && "text-success",
            tone === "destructive" && "text-destructive",
            tone === "muted" && "text-muted-foreground"
          )}
        >
          {value}
        </div>
        {hint && <div className="mt-1.5 text-xs text-muted-foreground">{hint}</div>}
      </CardContent>
    </Card>
  );
}
