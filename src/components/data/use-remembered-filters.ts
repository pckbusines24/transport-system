"use client";

import * as React from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";

/**
 * Register filter memory (per browser tab).
 *
 * Filters live in the URL, so a refresh keeps them. What lost them was coming
 * BACK: saving an edit (or the menu, or Back) lands on the bare register URL.
 * This remembers the last filtered query of each register in sessionStorage
 * and, when the register opens with none of its filters in the URL, restores
 * it — page number included, so the user lands where they left.
 *
 * Scope: one memory per register path + view (tab / kind / view / src), so
 * the tabs of one page keep separate filters. Params already in the URL win
 * over remembered ones (e.g. a form returning to `?kind=FULL_TRUCK`).
 * "Clear all" empties the URL's filters, which empties the memory too.
 */
const VIEW_PARAMS = ["tab", "kind", "view", "src"] as const;
const PREFIX = "register-filters:";

function read(key: string): string | null {
  try {
    return window.sessionStorage.getItem(key);
  } catch {
    return null;
  }
}
function write(key: string, value: string | null) {
  try {
    if (value) window.sessionStorage.setItem(key, value);
    else window.sessionStorage.removeItem(key);
  } catch {
    // storage blocked (private mode etc.) — memory is a convenience only
  }
}

export function useRememberedFilters(filterKeys: readonly string[]) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const keys = React.useMemo(() => new Set(filterKeys), [filterKeys]);

  const storageKey = React.useMemo(() => {
    const view = VIEW_PARAMS.filter((p) => !keys.has(p))
      .map((p) => `${p}=${searchParams.get(p) ?? ""}`)
      .join("&");
    return `${PREFIX}${pathname}?${view}`;
  }, [pathname, searchParams, keys]);

  const hasFilter = React.useMemo(
    () => Array.from(searchParams.keys()).some((k) => keys.has(k)),
    [searchParams, keys]
  );

  // restore once per register view, when it opens without any filter
  const restoredFor = React.useRef<string | null>(null);
  const restoring = React.useRef(false);
  React.useEffect(() => {
    if (restoredFor.current === storageKey) return;
    restoredFor.current = storageKey;
    if (hasFilter) return;
    const saved = read(storageKey);
    if (!saved) return;
    const merged = new URLSearchParams(saved);
    // what the URL already says (view, kind...) beats the memory
    searchParams.forEach((v, k) => merged.set(k, v));
    if (!Array.from(merged.keys()).some((k) => keys.has(k))) return;
    restoring.current = true;
    router.replace(`${pathname}?${merged.toString()}`, { scroll: false });
  }, [storageKey, hasFilter, searchParams, keys, pathname, router]);

  // remember the current filters (or forget them once cleared)
  React.useEffect(() => {
    if (restoring.current) {
      // wait for the restored URL before writing anything back
      if (!hasFilter) return;
      restoring.current = false;
    }
    write(storageKey, hasFilter ? searchParams.toString() : null);
  }, [storageKey, hasFilter, searchParams]);
}
