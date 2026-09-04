"use client";

import * as React from "react";
import { createPortal } from "react-dom";
import { Check, ChevronsUpDown, Plus } from "lucide-react";
import { cn } from "@/lib/utils";
import { Input } from "@/components/ui/input";
import { computePlacement } from "@/lib/ui/popover-placement";
import { resolveOnBlur } from "@/lib/ui/combobox-resolve";

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
  /**
   * Whether the user has actually engaged with the suggestions — typed, arrowed
   * or hovered. Merely FOCUSING the field does not count.
   *
   * Focus alone opens the list and highlights row 0, so tabbing through an
   * untouched optional field used to reach the Tab branch below with a valid
   * highlight and silently select the first option. An optional field a user
   * never touched must stay empty; only an explicit action may set it.
   */
  const [interacted, setInteracted] = React.useState(false);
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
    // labels are not unique — an already-consistent selection is kept as-is
    // rather than re-matched by name. See `resolveOnBlur`.
    const next = resolveOnBlur({ text, value, options });
    if (next.changed) onChange(next.value);
    setText(next.text);
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
    if (!open) {
      setRect(null); // never reuse a stale rect on the next open
      return;
    }
    /**
     * Track the input every frame while the list is open.
     *
     * Measuring once was wrong inside a dialog. Radix autofocuses the first
     * field as the dialog opens, focus opens this list, and the measurement
     * then ran DURING the dialog's 200ms zoom-in-95 entry animation — with the
     * content still at scale(0.95), a top-left field measures pulled toward the
     * centre, so the list was pinned down and to the right of its field and
     * stayed there, since nothing re-measured afterwards.
     *
     * A frame loop settles with the animation and also covers ancestor
     * scrolling, resizes and any later layout shift. State is only set when the
     * rect actually moves, so a still list costs one comparison per frame.
     */
    let frame = 0;
    let last = "";
    const measure = () => {
      const r = inputRef.current?.getBoundingClientRect();
      if (r) {
        const key = `${r.top}|${r.left}|${r.width}|${r.bottom}`;
        if (key !== last) {
          last = key;
          setRect(r);
        }
      }
      frame = requestAnimationFrame(measure);
    };
    measure();
    return () => cancelAnimationFrame(frame);
  }, [open]);

  /**
   * Where the list goes. It is fixed-positioned in a portal, so the only thing
   * that can clip it is the viewport — never a modal or a scrolling ancestor.
   *
   * Vertically: open downward when the list fits below, otherwise flip above
   * whenever above has more room. Sizing to whichever side is chosen means the
   * list is never cut off at the bottom of the screen.
   *
   * Horizontally: the list is widened to a readable 240px minimum, which can
   * push it past the right edge for a field on the right of a modal. Clamping
   * the left keeps it on screen and still attached to its field.
   */
  const GAP = 4;
  const placement = React.useMemo(
    () =>
      rect
        ? computePlacement({
            rect,
            viewport: { width: window.innerWidth, height: window.innerHeight },
            gap: GAP,
          })
        : null,
    [rect]
  );

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
          // focus is not engagement — see `interacted`
          setInteracted(false);
        }}
        onBlur={handleBlur}
        onChange={(e) => {
          // typing is engagement: a typed prefix may still be completed by Tab
          setInteracted(true);
          setText(e.target.value);
          setOpen(true);
          setHighlight(0);
        }}
        onKeyDown={(e) => {
          if (e.key === "ArrowDown") {
            e.preventDefault();
            setInteracted(true);
            if (!open) setOpen(true);
            else {
              const next = Math.min(highlight + 1, Math.max(lastIndex, 0));
              setHighlight(next);
              scrollTo(next);
            }
          } else if (e.key === "ArrowUp") {
            e.preventDefault();
            setInteracted(true);
            const next = Math.max(highlight - 1, 0);
            setHighlight(next);
            scrollTo(next);
          } else if (e.key === "Enter") {
            if (open) {
              e.preventDefault();
              commitHighlight();
            }
          } else if (e.key === "Tab") {
            // commit the highlighted suggestion, then let focus move on — but
            // ONLY if the user actually engaged with the list. Tabbing straight
            // through an untouched field must leave it exactly as it was.
            if (interacted) commitHighlight();
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

      {open && !disabled && rect && placement && createPortal(
        <div
          ref={listRef}
          style={{
            position: "fixed",
            left: placement.left,
            width: placement.width,
            ...(placement.flip
              ? { bottom: window.innerHeight - rect.top + GAP }
              : { top: rect.bottom + GAP }),
            maxHeight: placement.maxHeight,
            // A modal Radix Dialog sets `pointer-events: none` on <body> while
            // it is open. This list is portalled to <body>, OUTSIDE the dialog
            // content, so it inherited that and swallowed every click on an
            // option — the reason picking by mouse did nothing in a dialog
            // while the same combobox worked on a full page like LR Entry.
            pointerEvents: "auto",
          }}
          // ...and the dialog treats a pointerdown outside its content as
          // "dismiss". Keeping the event inside the list stops a click on an
          // option from closing the whole form.
          onPointerDown={(e) => e.stopPropagation()}
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
              onMouseEnter={() => {
                setInteracted(true);
                setHighlight(idx);
              }}
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
              onMouseEnter={() => {
                setInteracted(true);
                setHighlight(createIndex);
              }}
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
