"use client";

import * as React from "react";
import { Check, ChevronsUpDown, X } from "lucide-react";
import { cn } from "@/lib/utils";
import type { MasterOption } from "@/components/data/master-combobox";

interface MultiComboboxProps {
  options: MasterOption[];
  values: string[];
  onChange: (values: string[]) => void;
  placeholder?: string;
  disabled?: boolean;
  className?: string;
}

/**
 * Tag-style multi-select with type-ahead: selected options render as chips,
 * the dropdown keeps itself open while ticking, Enter/click toggles, and
 * Backspace on an empty query removes the last chip.
 */
export function MultiCombobox({
  options,
  values,
  onChange,
  placeholder = "Type to search...",
  disabled,
  className,
}: MultiComboboxProps) {
  const [text, setText] = React.useState("");
  const [open, setOpen] = React.useState(false);
  const [highlight, setHighlight] = React.useState(0);
  const inputRef = React.useRef<HTMLInputElement>(null);
  const listRef = React.useRef<HTMLDivElement>(null);
  const listId = React.useId();

  const byValue = React.useMemo(
    () => new Map(options.map((o) => [o.value, o])),
    [options]
  );
  const query = text.trim().toLowerCase();
  const filtered = query
    ? options.filter((o) => `${o.label} ${o.meta ?? ""}`.toLowerCase().includes(query))
    : options;

  const scrollTo = (idx: number) => {
    listRef.current
      ?.querySelector(`[data-idx="${idx}"]`)
      ?.scrollIntoView({ block: "nearest" });
  };

  const toggle = (value: string) => {
    if (byValue.get(value)?.disabled && !values.includes(value)) return;
    onChange(
      values.includes(value) ? values.filter((v) => v !== value) : [...values, value]
    );
    // stay open for the next tick; a fresh query would only get in the way
    setText("");
  };

  return (
    <div className={cn("relative", className)}>
      <div
        className={cn(
          "flex min-h-10 w-full flex-wrap items-center gap-1.5 rounded-md border border-input bg-background px-2 py-1.5 text-sm",
          disabled ? "cursor-not-allowed opacity-50" : "cursor-text",
          open && "ring-2 ring-ring ring-offset-1"
        )}
        onMouseDown={(e) => {
          if (disabled) return;
          // keep focus in the search input when clicking anywhere in the box
          if (e.target !== inputRef.current) {
            e.preventDefault();
            inputRef.current?.focus();
            setOpen(true);
          }
        }}
      >
        {values.map((v) => (
          <span
            key={v}
            className="inline-flex items-center gap-1 rounded-md bg-secondary px-2 py-0.5 text-xs font-medium text-secondary-foreground"
          >
            {byValue.get(v)?.label ?? v}
            {!disabled && (
              <button
                type="button"
                tabIndex={-1}
                aria-label={`Remove ${byValue.get(v)?.label ?? v}`}
                className="text-muted-foreground hover:text-destructive"
                onMouseDown={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  onChange(values.filter((x) => x !== v));
                }}
              >
                <X className="h-3 w-3" />
              </button>
            )}
          </span>
        ))}
        <input
          ref={inputRef}
          role="combobox"
          aria-expanded={open}
          aria-controls={listId}
          autoComplete="off"
          disabled={disabled}
          placeholder={values.length ? "" : placeholder}
          value={text}
          className="min-w-[80px] flex-1 bg-transparent py-0.5 outline-none placeholder:text-muted-foreground"
          onFocus={() => {
            setOpen(true);
            setHighlight(0);
          }}
          onBlur={() => {
            setOpen(false);
            setText("");
          }}
          onChange={(e) => {
            setText(e.target.value);
            setOpen(true);
            setHighlight(0);
          }}
          onKeyDown={(e) => {
            if (e.key === "ArrowDown") {
              e.preventDefault();
              if (!open) setOpen(true);
              else {
                const next = Math.min(highlight + 1, filtered.length - 1);
                setHighlight(next);
                scrollTo(next);
              }
            } else if (e.key === "ArrowUp") {
              e.preventDefault();
              const next = Math.max(highlight - 1, 0);
              setHighlight(next);
              scrollTo(next);
            } else if (e.key === "Enter") {
              if (open && filtered[highlight]) {
                e.preventDefault();
                toggle(filtered[highlight].value);
              }
            } else if (e.key === "Backspace" && !text && values.length) {
              onChange(values.slice(0, -1));
            } else if (e.key === "Escape") {
              setOpen(false);
              setText("");
            }
          }}
        />
        <ChevronsUpDown
          className="pointer-events-none ml-auto h-4 w-4 shrink-0 opacity-50"
          aria-hidden
        />
      </div>

      {open && !disabled && (
        <div
          ref={listRef}
          id={listId}
          role="listbox"
          className="absolute z-50 mt-1 max-h-64 w-full min-w-[240px] overflow-y-auto rounded-md border bg-popover p-1 text-popover-foreground shadow-md"
        >
          {filtered.length === 0 && (
            <div className="px-2 py-2 text-sm text-muted-foreground">No match found.</div>
          )}
          {filtered.map((opt, idx) => {
            const picked = values.includes(opt.value);
            const off = !!opt.disabled && !picked;
            return (
              <div
                key={opt.value}
                data-idx={idx}
                aria-disabled={off || undefined}
                // mousedown fires before the input's blur, so the toggle wins
                onMouseDown={(e) => {
                  e.preventDefault();
                  toggle(opt.value);
                }}
                onMouseEnter={() => setHighlight(idx)}
                className={cn(
                  "flex items-center gap-2 rounded-sm px-2 py-1.5 text-sm",
                  off ? "cursor-not-allowed opacity-50" : "cursor-pointer",
                  idx === highlight && !off && "bg-accent text-accent-foreground"
                )}
              >
                <span
                  className={cn(
                    "flex h-4 w-4 shrink-0 items-center justify-center rounded-sm border",
                    picked
                      ? "border-primary bg-primary text-primary-foreground"
                      : "border-input"
                  )}
                >
                  {picked && <Check className="h-3 w-3" />}
                </span>
                <span className="flex-1 truncate">{opt.label}</span>
                {opt.meta && (
                  <span className="ml-2 max-w-[45%] truncate text-xs text-muted-foreground">
                    {opt.meta}
                  </span>
                )}
              </div>
            );
          })}
          <div className="mt-1 flex items-center justify-between border-t px-2 py-1.5 text-xs text-muted-foreground">
            <span>{values.length} selected</span>
            {values.length > 0 && (
              <button
                type="button"
                className="font-medium text-primary hover:underline"
                onMouseDown={(e) => {
                  e.preventDefault();
                  onChange([]);
                }}
              >
                Clear all
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
