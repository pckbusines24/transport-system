"use client";

import * as React from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { Check, ChevronsUpDown, Search, SlidersHorizontal, X } from "lucide-react";
import { cn, formatDate, parseDdMmYyyy } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { MiniCalendar } from "@/components/data/mini-calendar";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

export interface FilterOption {
  value: string;
  label: string;
  /** secondary text (e.g. a party's transport name) — shown under the label
   *  and searched too, so typing either name finds the option */
  meta?: string;
}

export interface FilterDef {
  type: "text" | "select" | "combobox" | "daterange";
  key: string;
  label: string;
  options?: FilterOption[];
}

interface FilterBarProps {
  filters: FilterDef[];
  className?: string;
}

function toIso(d: Date): string {
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${d.getFullYear()}-${mm}-${dd}`;
}

function fromIso(s: string | null): Date | null {
  if (!s) return null;
  const d = new Date(s + "T00:00:00");
  return isNaN(d.getTime()) ? null : d;
}

const PRESETS = ["Today", "This Week", "This Month", "This FY"] as const;

function presetRange(preset: (typeof PRESETS)[number]): [Date, Date] {
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  switch (preset) {
    case "Today":
      return [today, today];
    case "This Week": {
      const day = (today.getDay() + 6) % 7; // Monday-based
      const start = new Date(today);
      start.setDate(today.getDate() - day);
      const end = new Date(start);
      end.setDate(start.getDate() + 6);
      return [start, end];
    }
    case "This Month":
      return [
        new Date(today.getFullYear(), today.getMonth(), 1),
        new Date(today.getFullYear(), today.getMonth() + 1, 0),
      ];
    case "This FY": {
      const fyStartYear = today.getMonth() >= 3 ? today.getFullYear() : today.getFullYear() - 1;
      return [new Date(fyStartYear, 3, 1), new Date(fyStartYear + 1, 2, 31)];
    }
  }
}

function DateRangeFilter({
  def,
  from,
  to,
  onChange,
}: {
  def: FilterDef;
  from: string | null;
  to: string | null;
  onChange: (from: string | null, to: string | null) => void;
}) {
  const [open, setOpen] = React.useState(false);
  const [fromText, setFromText] = React.useState("");
  const [toText, setToText] = React.useState("");
  // calendar picks land here: first click = From, second = To (typed dates
  // and focusing a field retarget it)
  const [pickTarget, setPickTarget] = React.useState<"from" | "to">("from");
  const [month, setMonth] = React.useState<Date>(() => {
    const d = fromIso(from) ?? new Date();
    return new Date(d.getFullYear(), d.getMonth(), 1);
  });

  React.useEffect(() => {
    setFromText(from ? formatDate(fromIso(from)) : "");
    setToText(to ? formatDate(fromIso(to)) : "");
  }, [from, to]);

  React.useEffect(() => {
    if (!open) return;
    const d = fromIso(from) ?? new Date();
    setMonth(new Date(d.getFullYear(), d.getMonth(), 1));
    setPickTarget(from && !to ? "to" : "from");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const pickedFrom = parseDdMmYyyy(fromText);
  const pickedTo = parseDdMmYyyy(toText);

  const handlePick = (d: Date) => {
    if (pickTarget === "from") {
      setFromText(formatDate(d));
      // a To before the new From makes no sense — restart the range
      if (pickedTo && d > pickedTo) setToText("");
      setPickTarget("to");
    } else {
      if (pickedFrom && d < pickedFrom) {
        // picked backwards: treat it as a fresh From
        setFromText(formatDate(d));
        setToText("");
      } else {
        setToText(formatDate(d));
        setPickTarget("from");
      }
    }
  };

  const label =
    from || to
      ? `${from ? formatDate(fromIso(from)) : "..."} - ${to ? formatDate(fromIso(to)) : "..."}`
      : def.label;

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="outline"
          size="sm"
          className="h-9 w-full justify-between font-normal sm:w-auto"
        >
          {label}
          <ChevronsUpDown className="ml-2 h-3.5 w-3.5 opacity-50" />
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-80 space-y-3" align="start">
        <div className="flex flex-wrap gap-1.5">
          {PRESETS.map((p) => (
            <Button
              key={p}
              variant="secondary"
              size="sm"
              className="h-7 text-xs"
              onClick={() => {
                const [s, e] = presetRange(p);
                onChange(toIso(s), toIso(e));
                setOpen(false);
              }}
            >
              {p}
            </Button>
          ))}
        </div>
        <div className="grid grid-cols-2 gap-2">
          <div className="space-y-1">
            <Label className="text-xs">From</Label>
            <Input
              value={fromText}
              onChange={(e) => setFromText(e.target.value)}
              onFocus={() => setPickTarget("from")}
              placeholder="dd/mm/yyyy"
              className={cn("h-8", pickTarget === "from" && "ring-1 ring-primary")}
            />
          </div>
          <div className="space-y-1">
            <Label className="text-xs">To</Label>
            <Input
              value={toText}
              onChange={(e) => setToText(e.target.value)}
              onFocus={() => setPickTarget("to")}
              placeholder="dd/mm/yyyy"
              className={cn("h-8", pickTarget === "to" && "ring-1 ring-primary")}
            />
          </div>
        </div>
        {/* calendar (Option B): click a date for From, then one for To —
            typing above still works exactly as before */}
        <MiniCalendar
          month={month}
          onMonthChange={setMonth}
          from={pickedFrom}
          to={pickedTo}
          onPick={handlePick}
        />
        <div className="flex flex-wrap justify-end gap-2">
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              onChange(null, null);
              setOpen(false);
            }}
          >
            Clear
          </Button>
          <Button
            size="sm"
            onClick={() => {
              const f = parseDdMmYyyy(fromText);
              const t = parseDdMmYyyy(toText);
              onChange(f ? toIso(f) : null, t ? toIso(t) : null);
              setOpen(false);
            }}
          >
            Apply
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  );
}

function ComboboxFilter({
  def,
  value,
  onChange,
}: {
  def: FilterDef;
  value: string | null;
  onChange: (v: string | null) => void;
}) {
  const [open, setOpen] = React.useState(false);
  const selected = def.options?.find((o) => o.value === value);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="outline"
          size="sm"
          role="combobox"
          aria-expanded={open}
          className="h-9 w-full min-w-[140px] justify-between font-normal sm:w-auto"
        >
          <span className="truncate">{selected ? selected.label : def.label}</span>
          <ChevronsUpDown className="ml-2 h-3.5 w-3.5 shrink-0 opacity-50" />
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-[240px] p-0" align="start">
        <Command>
          <CommandInput placeholder={`Search ${def.label.toLowerCase()}...`} />
          <CommandList>
            <CommandEmpty>No results.</CommandEmpty>
            <CommandGroup>
              {(def.options ?? []).map((opt) => (
                <CommandItem
                  key={opt.value}
                  // cmdk matches on `value`, so the meta rides along with the label
                  value={opt.meta ? `${opt.label} ${opt.meta}` : opt.label}
                  onSelect={() => {
                    onChange(opt.value === value ? null : opt.value);
                    setOpen(false);
                  }}
                >
                  <Check
                    className={cn("h-4 w-4", value === opt.value ? "opacity-100" : "opacity-0")}
                  />
                  <span className="flex min-w-0 flex-col">
                    <span className="truncate">{opt.label}</span>
                    {opt.meta && (
                      <span className="truncate text-[11px] text-muted-foreground">{opt.meta}</span>
                    )}
                  </span>
                </CommandItem>
              ))}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}

function TextFilter({
  def,
  value,
  onChange,
}: {
  def: FilterDef;
  value: string;
  onChange: (v: string | null) => void;
}) {
  const [text, setText] = React.useState(value);

  // stay in sync when the URL param changes externally (chips / clear all)
  React.useEffect(() => setText(value), [value]);

  // debounced text search -> URL
  React.useEffect(() => {
    if (text === value) return;
    const t = setTimeout(() => onChange(text || null), 300);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [text]);

  return (
    <div className="relative w-full sm:w-56">
      <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
      <Input
        value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder={def.label}
        className="w-full pl-8"
      />
    </div>
  );
}

export function FilterBar({ filters, className }: FilterBarProps) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const [open, setOpen] = React.useState(false);

  const setParams = React.useCallback(
    (updates: Record<string, string | null>) => {
      const params = new URLSearchParams(searchParams.toString());
      for (const [k, v] of Object.entries(updates)) {
        if (v === null || v === "") params.delete(k);
        else params.set(k, v);
      }
      // any filter change invalidates the current page number
      params.delete("page");
      router.replace(`${pathname}?${params.toString()}`, { scroll: false });
    },
    [router, pathname, searchParams]
  );

  // active chips
  const chips: { key: string; label: string; clear: Record<string, string | null> }[] = [];
  for (const f of filters) {
    if (f.type === "text") {
      const v = searchParams.get(f.key);
      if (v) chips.push({ key: f.key, label: `${f.label}: ${v}`, clear: { [f.key]: null } });
    } else if (f.type === "daterange") {
      const from = searchParams.get(`${f.key}_from`);
      const to = searchParams.get(`${f.key}_to`);
      if (from || to)
        chips.push({
          key: f.key,
          label: `${f.label}: ${from ? formatDate(fromIso(from)) : "..."} - ${
            to ? formatDate(fromIso(to)) : "..."
          }`,
          clear: { [`${f.key}_from`]: null, [`${f.key}_to`]: null },
        });
    } else {
      const v = searchParams.get(f.key);
      if (v) {
        const opt = f.options?.find((o) => o.value === v);
        chips.push({
          key: f.key,
          label: `${f.label}: ${opt?.label ?? v}`,
          clear: { [f.key]: null },
        });
      }
    }
  }

  const clearAll = () => {
    const updates: Record<string, string | null> = {};
    for (const f of filters) {
      if (f.type === "daterange") {
        updates[`${f.key}_from`] = null;
        updates[`${f.key}_to`] = null;
      } else {
        updates[f.key] = null;
      }
    }
    setParams(updates);
  };

  return (
    <div className={cn("space-y-2", className)}>
      {/*
        Below md the controls collapse behind one button - a full row of them
        costs most of a phone screen before a single record is visible. The
        active-filter chips stay outside the collapse on purpose: a register
        figure means something different under a different date range, so what
        is filtered must never be hidden, only the controls that set it.
      */}
      <Button
        type="button"
        variant="outline"
        size="sm"
        className="h-9 w-full justify-center gap-2 md:hidden"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
      >
        <SlidersHorizontal className="h-4 w-4" />
        Filters
        {chips.length > 0 && (
          <Badge variant="secondary" className="px-1.5 text-[10px]">
            {chips.length}
          </Badge>
        )}
      </Button>

      <div
        className={cn(
          "flex-wrap items-center gap-2 md:flex",
          open ? "flex" : "hidden"
        )}
      >
        {filters.map((f) => {
            if (f.type === "text") {
              return (
                <TextFilter
                  key={f.key}
                  def={f}
                  value={searchParams.get(f.key) ?? ""}
                  onChange={(v) => setParams({ [f.key]: v })}
                />
              );
            }
            if (f.type === "daterange") {
              return (
                <DateRangeFilter
                  key={f.key}
                  def={f}
                  from={searchParams.get(`${f.key}_from`)}
                  to={searchParams.get(`${f.key}_to`)}
                  onChange={(from, to) =>
                    setParams({ [`${f.key}_from`]: from, [`${f.key}_to`]: to })
                  }
                />
              );
            }
            if (f.type === "combobox") {
              return (
                <ComboboxFilter
                  key={f.key}
                  def={f}
                  value={searchParams.get(f.key)}
                  onChange={(v) => setParams({ [f.key]: v })}
                />
              );
            }
            // select
            return (
              <Select
                key={f.key}
                value={searchParams.get(f.key) ?? ""}
                onValueChange={(v) => setParams({ [f.key]: v === "__all__" ? null : v })}
              >
                <SelectTrigger className="h-9 w-full min-w-[140px] sm:w-auto">
                  <SelectValue placeholder={f.label} />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="__all__">All {f.label}</SelectItem>
                  {(f.options ?? []).map((opt) => (
                    <SelectItem key={opt.value} value={opt.value}>
                      {opt.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            );
          })}
      </div>

      {chips.length > 0 && (
        <div className="flex flex-wrap items-center gap-1.5">
          {chips.map((chip) => (
            <Badge key={chip.key} variant="secondary" className="gap-1 pr-1 font-normal">
              {chip.label}
              <button
                type="button"
                className="rounded-full p-0.5 hover:bg-muted-foreground/20"
                onClick={() => setParams(chip.clear)}
                aria-label={`Remove ${chip.label}`}
              >
                <X className="h-3 w-3" />
              </button>
            </Badge>
          ))}
          <Button variant="ghost" size="sm" className="h-6 px-2 text-xs" onClick={clearAll}>
            Clear all
          </Button>
        </div>
      )}
    </div>
  );
}
