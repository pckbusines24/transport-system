/**
 * Search-result ranking shared by every type-to-search box.
 *
 * A typed query never hides anything new; it only reorders the matches:
 *   0 — some field equals the query exactly
 *   1 — some field starts with the query
 *   2 — some field (or the combined text) contains the query
 * Within a rank the incoming order is kept (date / name order), because
 * Array.prototype.sort is stable.
 *
 * Comparison ignores case and surrounding / repeated whitespace.
 */

export type MatchRank = 0 | 1 | 2 | 3;

export function normalizeSearch(value: unknown): string {
  return String(value ?? "")
    .trim()
    .replace(/\s+/g, " ")
    .toLowerCase();
}

type Fields = unknown | readonly unknown[];

function fieldList(fields: Fields): unknown[] {
  return Array.isArray(fields) ? fields : [fields];
}

/** Rank of `fields` against an already-normalized query (3 = no match). */
export function matchRank(fields: Fields, normalizedQuery: string): MatchRank {
  if (!normalizedQuery) return 2;
  let best: MatchRank = 3;
  for (const f of fieldList(fields)) {
    const v = normalizeSearch(f);
    if (!v) continue;
    if (v === normalizedQuery) return 0;
    if (best > 1 && v.startsWith(normalizedQuery)) best = 1;
    else if (best > 2 && v.includes(normalizedQuery)) best = 2;
  }
  return best;
}

/** Stable sort: exact matches first, then starts-with, then the rest. */
export function rankByMatch<T>(
  items: readonly T[],
  query: string,
  fields: (item: T) => Fields
): T[] {
  const q = normalizeSearch(query);
  if (!q) return items.slice();
  return items
    .map((item, i) => ({ item, i, r: matchRank(fields(item), q) }))
    .sort((a, b) => a.r - b.r || a.i - b.i)
    .map((x) => x.item);
}

/**
 * Filter + rank in one pass: keeps items whose fields (or their combined
 * text) contain the query, exact matches first.
 */
export function searchRanked<T>(
  items: readonly T[],
  query: string,
  fields: (item: T) => Fields
): T[] {
  const q = normalizeSearch(query);
  if (!q) return items.slice();
  const out: { item: T; i: number; r: MatchRank }[] = [];
  items.forEach((item, i) => {
    const f = fields(item);
    let r = matchRank(f, q);
    if (r === 3 && normalizeSearch(fieldList(f).join(" ")).includes(q)) r = 2;
    if (r < 3) out.push({ item, i, r });
  });
  return out.sort((a, b) => a.r - b.r || a.i - b.i).map((x) => x.item);
}


/**
 * Several column filters at once (one query per column): rows matching more
 * columns exactly come first. Rank = sum of each active filter's rank;
 * blank filters are ignored. Stable within equal ranks.
 */
export function rankByFilters<T>(
  items: readonly T[],
  filters: readonly (readonly [query: string, field: (item: T) => Fields])[]
): T[] {
  const active = filters
    .map(([q, f]) => [normalizeSearch(q), f] as const)
    .filter(([q]) => q);
  if (active.length === 0) return items.slice();
  return items
    .map((item, i) => ({
      item,
      i,
      r: active.reduce((s, [q, f]) => s + matchRank(f(item), q), 0),
    }))
    .sort((a, b) => a.r - b.r || a.i - b.i)
    .map((x) => x.item);
}
