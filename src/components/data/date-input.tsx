"use client";

import * as React from "react";
import { CalendarDays } from "lucide-react";
import { cn, formatDate, parseDdMmYyyy } from "@/lib/utils";
import { Input } from "@/components/ui/input";

interface DateInputProps
  extends Omit<React.InputHTMLAttributes<HTMLInputElement>, "value" | "onChange"> {
  /** Value as dd/mm/yyyy text (or empty string). */
  value: string;
  onChange: (text: string, date: Date | null) => void;
}

/** Forgiving parse: dd/mm/yyyy, dd-mm-yyyy, dd.mm.yyyy, ddmmyyyy, ddmmyy, dd/mm/yy. */
function parseLoose(text: string): Date | null {
  const t = text.trim();
  if (!t) return null;
  const strict = parseDdMmYyyy(t);
  if (strict) return strict;
  const digits = t.replace(/\D/g, "");
  let dd: number, mm: number, yyyy: number;
  if (digits.length === 8) {
    dd = +digits.slice(0, 2);
    mm = +digits.slice(2, 4);
    yyyy = +digits.slice(4);
  } else if (digits.length === 6) {
    dd = +digits.slice(0, 2);
    mm = +digits.slice(2, 4);
    yyyy = 2000 + +digits.slice(4);
  } else if (/^(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{2})$/.test(t)) {
    const m = t.match(/^(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{2})$/)!;
    dd = +m[1];
    mm = +m[2];
    yyyy = 2000 + +m[3];
  } else {
    return null;
  }
  const d = new Date(yyyy, mm - 1, dd);
  return d.getFullYear() === yyyy && d.getMonth() === mm - 1 && d.getDate() === dd ? d : null;
}

function toIsoDay(d: Date): string {
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${d.getFullYear()}-${mm}-${dd}`;
}

/**
 * Date field used across the app: dd/mm/yyyy text entry with auto-formatting
 * on blur (accepts 12/07/2026, 12-7-26, 12072026, ...) plus a native calendar
 * picker behind the calendar icon.
 */
export function DateInput({ value, onChange, className, onBlur, ...props }: DateInputProps) {
  const [invalid, setInvalid] = React.useState(false);
  const pickerRef = React.useRef<HTMLInputElement>(null);

  const openPicker = () => {
    const el = pickerRef.current;
    if (!el) return;
    if (typeof el.showPicker === "function") el.showPicker();
    else el.click();
  };

  const current = parseLoose(value);

  return (
    <div className="relative">
      <Input
        inputMode="numeric"
        placeholder="dd/mm/yyyy"
        value={value}
        onChange={(e) => {
          const text = e.target.value.replace(/[^\d/\-.]/g, "").slice(0, 10);
          setInvalid(false);
          onChange(text, parseLoose(text));
        }}
        onBlur={(e) => {
          const text = e.target.value.trim();
          if (!text) {
            setInvalid(false);
          } else {
            const d = parseLoose(text);
            if (d) {
              setInvalid(false);
              const normalized = formatDate(d);
              if (normalized !== text) onChange(normalized, d);
            } else {
              setInvalid(true);
            }
          }
          onBlur?.(e);
        }}
        aria-invalid={invalid || undefined}
        className={cn(
          "pr-8",
          invalid && "border-destructive focus-visible:ring-destructive",
          className
        )}
        {...props}
      />
      <button
        type="button"
        tabIndex={-1}
        aria-label="Open calendar"
        onClick={openPicker}
        className="absolute inset-y-0 right-0 flex w-8 items-center justify-center text-muted-foreground hover:text-primary"
        disabled={props.disabled}
      >
        <CalendarDays className="h-4 w-4" />
      </button>
      {/* invisible native date input drives the calendar popup */}
      <input
        ref={pickerRef}
        type="date"
        tabIndex={-1}
        aria-hidden
        value={current ? toIsoDay(current) : ""}
        onChange={(e) => {
          const v = e.target.value; // yyyy-mm-dd
          if (!v) return;
          const [y, m, d] = v.split("-").map(Number);
          const date = new Date(y, m - 1, d);
          setInvalid(false);
          onChange(formatDate(date), date);
        }}
        className="pointer-events-none absolute bottom-0 right-0 h-0 w-0 opacity-0"
      />
    </div>
  );
}

interface IsoDateInputProps
  extends Omit<React.InputHTMLAttributes<HTMLInputElement>, "value" | "onChange"> {
  /** Stored value: "yyyy-mm-dd", a full ISO timestamp, or empty/null. */
  value: string | null | undefined;
  /** Emits "yyyy-mm-dd" once the typed text is a valid date, or null when cleared. */
  onChange: (iso: string | null, date: Date | null) => void;
}

function isoToLocalDate(iso: string): Date | null {
  const m = iso.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return null;
  const d = new Date(+m[1], +m[2] - 1, +m[3]);
  return isNaN(d.getTime()) ? null : d;
}

/**
 * DateInput for state that stores an ISO date rather than dd/mm/yyyy text
 * (advance rows, dashboard filters). Keeps the partially-typed text locally so
 * a half-entered date is not wiped on every keystroke, and pushes the ISO
 * value up only when the text parses — the same feel as the LR Entry dates.
 */
export function IsoDateInput({ value, onChange, ...props }: IsoDateInputProps) {
  const external = value ? isoToLocalDate(value) : null;
  const externalText = external ? formatDate(external) : "";
  const [text, setText] = React.useState(externalText);
  const lastExternal = React.useRef(externalText);
  // adopt outside changes (e.g. a reset or an edit loaded from the server)
  React.useEffect(() => {
    if (externalText !== lastExternal.current) {
      lastExternal.current = externalText;
      setText(externalText);
    }
  }, [externalText]);

  return (
    <DateInput
      {...props}
      value={text}
      onChange={(t, d) => {
        setText(t);
        if (!t.trim()) {
          lastExternal.current = "";
          onChange(null, null);
        } else if (d) {
          lastExternal.current = formatDate(d);
          onChange(toIsoDay(d), d);
        }
      }}
    />
  );
}
