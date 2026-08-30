"use client";

import { useFormStatus } from "react-dom";
import { CalendarRange, ChevronRight, Loader2 } from "lucide-react";

/**
 * FY submit button with pending feedback. Selecting a year runs a server
 * action (DB checks + cookie + redirect into the dashboard) — without this
 * the click looks dead for the whole round-trip.
 */
export function FyButton({
  label,
  sub,
  dashed,
}: {
  label: string;
  sub: string;
  dashed?: boolean;
}) {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      disabled={pending}
      className={`group flex w-full items-center gap-3 rounded-xl border bg-card px-4 py-3 text-left transition-colors hover:border-primary hover:bg-primary/5 disabled:pointer-events-none disabled:opacity-70 ${
        dashed ? "border-dashed" : ""
      }`}
    >
      {pending ? (
        <Loader2 className="h-4 w-4 shrink-0 animate-spin text-primary" />
      ) : (
        <CalendarRange
          className={`h-4 w-4 shrink-0 ${dashed ? "text-muted-foreground group-hover:text-primary" : "text-primary"}`}
        />
      )}
      <span className="flex-1">
        <span
          className={`block text-sm font-semibold ${
            dashed ? "text-muted-foreground group-hover:text-foreground" : ""
          }`}
        >
          {label}
        </span>
        <span className="block text-xs text-muted-foreground">
          {pending ? "Opening..." : sub}
        </span>
      </span>
      <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground transition-transform group-hover:translate-x-0.5 group-hover:text-primary" />
    </button>
  );
}
