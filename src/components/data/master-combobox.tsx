"use client";

import * as React from "react";
import { createPortal } from "react-dom";
import { Check, ChevronsUpDown, Plus } from "lucide-react";
import { cn } from "@/lib/utils";
import { Input } from "@/components/ui/input";

export interface MasterOption {
  value: string;
  label: string;
  meta?: string;
}

/** Rendered-suggestion cap; filtering and selection still span every option. */
const MAX_RENDERED = 50;

interface MasterComboboxProps {
  options: MasterOption[];
  value: string | null | undefined;
  onChange: (value: string | null) => void;
  placeholder?: string;
  /**
   * The ubiquitous "+ Create new" pattern: render a dialog; call
   * closeAndSelect(newValue) once the new record is created to select it.
   */
  renderCreateDialog?: (closeAndSelect: (value: string) => void) => React.ReactNode;
  createLabel?: string;
  disabled?: boolean;
  className?: string;
}

/**
 * Type-ahead autocomplete for master records: click in and type immediately,
 * suggestions filter live, Arrow keys / Enter / Tab select, and a "+ Create
 * new" row opens the inline-create dialog and auto-selects the result.
 */
export function MasterCombobox({
  options,
  value,
  onChange,
  placeholder = "Type to search...",
  renderCreateDialog,
  createLabel = "+ Create new",
  disabled,
  className,
}: MasterComboboxProps) {
  const selected = options.find((o) => o.value === value) ?? null;

  const [text, setText] = React.useState(selected?.label ?? "");
  const [open, setOpen] = React.useState(false);
  const [highlight, setHighlight] = React.useState(0);
  const [creating, setCreating] = React.useState(false);
  const inputRef = React.useRef<HTMLInputElement>(null);
  const listRef = React.useRef<HTMLDivElement>(null);
  const focused = React.useRef(false);

  // keep display text in sync when value/options change from outside
  React.useEffect(() => {
    if (!focused.current) setText(selected?.label ?? "");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value, selected?.label]);

  const query = text.trim().toLowerCase();
  const showAll = !query || (selected && text === selected.label);
  const filtered = React.useMemo(
    () =>
      showAll
        ? options
        : options.filter((o) => `${o.label} ${o.meta ?? ""}`.toLowerCase().includes(query)),
    [options, showAll, query]
  );
  // A master with thousands of rows rendered every match into the DOM, which
  // is what made a big party list slow to open. Only the slice is capped —
  // `options` stays whole, so blur-time exact-match select and the duplicate
  // check below still see every record.
  const visible = React.useMemo(
    () => (filtered.length > MAX_RENDERED ? filtered.slice(0, MAX_RENDERED) : filtered),
    [filtered]
  );
  const truncated = filtered.length > visible.length;
  // index === visible.length means the "+ Create new" row
  const createIndex = renderCreateDialog ? visible.length : -1;
  const lastIndex = renderCreateDialog ? visible.length : visible.length - 1;

  const scrollTo = (idx: number) => {
    listRef.current
      ?.querySelector(`[data-idx="${idx}"]`)
      ?.scrollIntoView({ block: "nearest" });
  };

  const pick = (opt: MasterOption) => {
    onChange(opt.value);
    setText(opt.label);
    setOpen(false);
  };

  const openCreate = () => {
    setOpen(false);
    setCreating(true);
  };

  const commitHighlight = (): boolean => {
    if (!open) return false;
    if (highlight === createIndex && renderCreateDialog) {
      openCreate();
      return true;
    }
    const opt = visible[highlight];
    if (opt) {
      pick(opt);
      return true;
    }
    return false;
  };

  const handleBlur = () => {
    focused.current = false;
    setOpen(false);
    const t = text.trim();
    if (!t) {
      if (value) onChange(null);
      setText("");
      return;
    }
    // exact label match (case-insensitive) selects; otherwise revert
    const exact = options.find((o) => o.label.toLowerCase() === t.toLowerCase());
    if (exact) {
      if (exact.value !== value) onChange(exact.value);
      setText(exact.label);
    } else {
      setText(selected?.label ?? "");
    }
  };

  const closeAndSelect = React.useCallback(
    (newValue: string) => {
      setCreating(false);
      onChange(newValue);
    },
    [onChange]
  );

  /**
   * The list is rendered into a PORTAL, positioned against the input's screen
   * rect, rather than absolutely inside this wrapper.
   *
   * Several call sites put this combobox inside a horizontally scrolling
   * container — the LR product rows are the obvious one. An absolutely
   * positioned list inside `overflow-x-auto` gets clipped by that ancestor and
   * makes the whole panel scroll to reveal itself, which is what the product
   * picker was doing. A fixed-position portal has no clipping ancestor.
   */
  const [rect, setRect] = React.useState<DOMRect | null>(null);
  React.useLayoutEffect(() => {
    if (!open) return;
    const measure = () => setRect(inputRef.current?.getBoundingClientRect() ?? null);
    measure();
    // capture: the scroll may happen on any ancestor, not just the window
    window.addEventListener("scroll", measure, true);
    window.addEventListener("resize", measure);
    return () => {
      window.removeEventListener("scroll", measure, true);
      window.removeEventListener("resize", measure);
    };
  }, [open]);

  // flip above when there is not enough room below, so the list is never
  // half off-screen on a row near the bottom of the viewport
  const MAX_LIST = 256;
  const below = rect ? window.innerHeight - rect.bottom - 8 : 0;
  const flip = rect !== null && below < 180 && rect.top > below;

  return (
    <div className={cn("relative", className)}>
      <Input
        ref={inputRef}
        role="combobox"
        aria-expanded={open}
        autoComplete="off"
        disabled={disabled}
        placeholder={placeholder}
        value={text}
        className="pr-8"
        onFocus={(e) => {
          focused.current = true;
          e.target.select();
          setOpen(true);
          setHighlight(0);
        }}
        onBlur={handleBlur}
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
              const next = Math.min(highlight + 1, Math.max(lastIndex, 0));
              setHighlight(next);
              scrollTo(next);
            }
          } else if (e.key === "ArrowUp") {
            e.preventDefault();
            const next = Math.max(highlight - 1, 0);
            setHighlight(next);
            scrollTo(next);
          } else if (e.key === "Enter") {
            if (open) {
              e.preventDefault();
              commitHighlight();
            }
          } else if (e.key === "Tab") {
            // commit the highlighted suggestion, then let focus move on
            commitHighlight();
          } else if (e.key === "Escape") {
            setOpen(false);
            setText(selected?.label ?? "");
          }
        }}
      />
      <ChevronsUpDown
        className="pointer-events-none absolute right-2.5 top-1/2 h-4 w-4 -translate-y-1/2 opacity-50"
        aria-hidden
      />

      {open && !disabled && rect && createPortal(
        <div
          ref={listRef}
          style={{
            position: "fixed",
            left: rect.left,
            width: Math.max(rect.width, 240),
            ...(flip
              ? { bottom: window.innerHeight - rect.top + 4 }
              : { top: rect.bottom + 4 }),
            maxHeight: flip ? Math.min(MAX_LIST, rect.top - 8) : Math.min(MAX_LIST, below),
          }}
          className="z-50 overflow-y-auto rounded-lg border bg-popover p-1 text-popover-foreground shadow-overlay"
        >
          {visible.length === 0 && !renderCreateDialog && (
            <div className="px-2 py-2 text-sm text-muted-foreground">No match found.</div>
          )}
          {visible.map((opt, idx) => (
            <div
              key={opt.value}
              data-idx={idx}
              // mousedown fires before the input's blur, so the pick wins
              onMouseDown={(e) => {
                e.preventDefault();
                pick(opt);
              }}
              onMouseEnter={() => setHighlight(idx)}
              className={cn(
                "flex cursor-pointer items-center gap-2 rounded-sm px-2 py-1.5 text-sm",
                idx === highlight && "bg-accent text-accent-foreground"
              )}
            >
              <Check
                className={cn("h-4 w-4 shrink-0", value === opt.value ? "opacity-100" : "opacity-0")}
              />
              <span className="flex-1 truncate">{opt.label}</span>
              {opt.meta && (
                <span className="ml-2 max-w-[45%] truncate text-xs text-muted-foreground">
                  {opt.meta}
                </span>
              )}
            </div>
          ))}
          {truncated && (
            <div className="px-2 py-1.5 text-xs text-muted-foreground">
              Showing {visible.length} of {filtered.length} — keep typing to narrow&hellip;
            </div>
          )}
          {renderCreateDialog && (
            <div
              data-idx={createIndex}
              onMouseDown={(e) => {
                e.preventDefault();
                openCreate();
              }}
              onMouseEnter={() => setHighlight(createIndex)}
              className={cn(
                "mt-1 flex cursor-pointer items-center gap-2 rounded-sm border-t px-2 py-1.5 text-sm text-primary",
                highlight === createIndex && "bg-accent"
              )}
            >
              <Plus className="h-4 w-4 shrink-0" />
              {createLabel}
              {text.trim() && !filtered.some((o) => o.label.toLowerCase() === query) && (
                <span className="truncate font-medium">&ldquo;{text.trim()}&rdquo;</span>
              )}
            </div>
          )}
        </div>,
        document.body
      )}

      {creating && renderCreateDialog?.(closeAndSelect)}
    </div>
  );
}
