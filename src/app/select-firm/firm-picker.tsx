"use client";

import * as React from "react";
import { useFormStatus } from "react-dom";
import { ArrowRight, CalendarRange, Loader2, Sparkles } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectSeparator,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

export interface FyOption {
  id: string;
  label: string; // "2026-2027"
  range: string; // "01/04/2026 — 31/03/2027"
  /** the year whose dates contain today */
  current: boolean;
}

const NEXT = "__next__";

function OpenButton({ creating, label }: { creating: boolean; label: string }) {
  const { pending } = useFormStatus();
  return (
    <Button type="submit" disabled={pending} className="h-11 w-full sm:w-auto sm:min-w-[11rem]">
      {pending ? (
        <>
          <Loader2 className="h-4 w-4 animate-spin" />
          {creating ? "Creating year..." : "Opening..."}
        </>
      ) : (
        <>
          {creating ? `Create FY ${label} & Open` : "Open"}
          <ArrowRight className="h-4 w-4" />
        </>
      )}
    </Button>
  );
}

/**
 * Financial-year picker for one firm: a dropdown of the existing years (the
 * current year preselected) plus a clearly separated "start a new year"
 * entry. Picking that entry changes nothing by itself — the new year is
 * created only when the user presses the button and confirms.
 */
export function FirmPicker({
  firmId,
  years,
  nextLabel,
  action,
}: {
  firmId: string;
  years: FyOption[];
  nextLabel: string;
  action: (formData: FormData) => void | Promise<void>;
}) {
  const initial = years.find((y) => y.current)?.id ?? years[0]?.id ?? NEXT;
  const [fyId, setFyId] = React.useState(initial);
  const creating = fyId === NEXT;
  const chosen = years.find((y) => y.id === fyId);

  return (
    <form
      action={action}
      onSubmit={(e) => {
        if (
          creating &&
          !window.confirm(
            `Start financial year ${nextLabel}?\n\nThis creates the year (1 April to 31 March) and opens it. It cannot be undone from this screen.`
          )
        ) {
          e.preventDefault();
        }
      }}
      className="space-y-3"
    >
      <input type="hidden" name="firmId" value={firmId} />
      <input type="hidden" name="fyId" value={fyId} />

      <div className="flex flex-col gap-3 sm:flex-row sm:items-end">
        <div className="flex-1 space-y-1.5">
          <label className="text-xs font-medium text-muted-foreground">Financial Year</label>
          <Select value={fyId} onValueChange={setFyId}>
            <SelectTrigger className="h-11">
              <span className="flex items-center gap-2">
                {creating ? (
                  <Sparkles className="h-4 w-4 text-primary" />
                ) : (
                  <CalendarRange className="h-4 w-4 text-primary" />
                )}
                <SelectValue />
              </span>
            </SelectTrigger>
            <SelectContent>
              {years.map((y) => (
                <SelectItem key={y.id} value={y.id}>
                  <span className="flex items-center gap-2">
                    <span className="font-semibold">FY {y.label}</span>
                    <span className="text-xs text-muted-foreground">{y.range}</span>
                    {y.current && (
                      <span className="rounded-full bg-primary/15 px-1.5 py-0.5 text-[10px] font-semibold uppercase text-primary">
                        Current
                      </span>
                    )}
                  </span>
                </SelectItem>
              ))}
              {years.length > 0 && <SelectSeparator />}
              <SelectItem value={NEXT}>
                <span className="flex items-center gap-2">
                  <span className="font-semibold">Start new year — FY {nextLabel}</span>
                  <span className="text-xs text-muted-foreground">not created yet</span>
                </span>
              </SelectItem>
            </SelectContent>
          </Select>
        </div>
        <OpenButton creating={creating} label={nextLabel} />
      </div>

      <p className="text-xs text-muted-foreground">
        {creating ? (
          <>
            FY {nextLabel} does not exist yet. Pressing the button will ask for confirmation, then
            create it and open it.
          </>
        ) : chosen ? (
          <>
            {chosen.range}
            {chosen.current ? " · today falls in this year" : ""}
          </>
        ) : null}
      </p>
    </form>
  );
}
