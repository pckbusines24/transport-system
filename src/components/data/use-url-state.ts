"use client";

import * as React from "react";
import { useSearchParams } from "next/navigation";

/**
 * useState that also lives in the URL query, so a refresh keeps the filter.
 * Writes with history.replaceState (Next 14 syncs it with useSearchParams),
 * so typing in a search box never reloads the page or refetches its data.
 * The default value is left out of the URL.
 */
export function useUrlState(key: string, fallback = ""): [string, (v: string) => void] {
  const searchParams = useSearchParams();
  const [value, setValue] = React.useState(() => searchParams.get(key) ?? fallback);
  const set = React.useCallback(
    (v: string) => {
      setValue(v);
      try {
        const params = new URLSearchParams(window.location.search);
        if (!v || v === fallback) params.delete(key);
        else params.set(key, v);
        const qs = params.toString();
        window.history.replaceState(null, "", `${window.location.pathname}${qs ? `?${qs}` : ""}${window.location.hash}`);
      } catch {
        // URL sync is a convenience; the in-memory filter still applies
      }
    },
    [key, fallback]
  );
  return [value, set];
}

/** Nullable variant for pickers: null = not set (absent from the URL). */
export function useUrlNullable(key: string): [string | null, (v: string | null) => void] {
  const [value, set] = useUrlState(key);
  return [value || null, React.useCallback((v: string | null) => set(v ?? ""), [set])];
}

/** Boolean variant for checkboxes / switches: present as "1" when on. */
export function useUrlFlag(key: string): [boolean, (v: boolean) => void] {
  const [value, set] = useUrlState(key);
  return [value === "1", React.useCallback((v: boolean) => set(v ? "1" : ""), [set])];
}
