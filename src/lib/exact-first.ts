/**
 * Exact-match-first paging for database registers.
 *
 * A register searches with `contains` and pages in date order. With a query
 * typed, the rows whose searched field EQUALS the query (case-insensitive)
 * should lead page one, then every other match in the usual order. The set
 * of rows — and so every count and total — is unchanged; only their order.
 *
 * How: fetch the ids of the exact matches (they are few), serve them first,
 * then page through the rest of `where` with those ids excluded. When there
 * are no exact matches, or an unusually large number of them, the normal
 * single query runs.
 */

/** above this many exact matches the plain date order is kept */
export const EXACT_FIRST_CAP = 1000;

type IdWhere = { id: { in: string[] } | { notIn: string[] } };

export async function findExactFirst<W, R>(opts: {
  /** the register's full filter (already contains the `contains` search) */
  where: W;
  /** the same search with `equals` instead of `contains`; null = no query.
   *  Typed loosely: a register's `where` is often an inferred literal type
   *  that a differently-shaped exact filter would not fit. */
  exact: object | null;
  /** ids of rows matching a where (cap is applied by `take`) */
  ids: (where: W, take: number) => Promise<string[]>;
  /** the register's own findMany with its orderBy / include */
  fetch: (where: W, skip: number, take: number | undefined) => Promise<R[]>;
  skip: number;
  /** undefined = every row (registers that page in code after filtering) */
  take: number | undefined;
}): Promise<R[]> {
  const { where, exact, ids, fetch, skip, take } = opts;
  if (!exact) return fetch(where, skip, take);
  const exactIds = await ids({ AND: [where, exact] } as W, EXACT_FIRST_CAP + 1);
  if (exactIds.length === 0 || exactIds.length > EXACT_FIRST_CAP) return fetch(where, skip, take);

  const n = exactIds.length;
  const out: R[] = [];
  if (skip < n) {
    const idIn: IdWhere = { id: { in: exactIds } };
    const exactTake = take === undefined ? undefined : Math.min(take, n - skip);
    out.push(...(await fetch({ AND: [where, idIn] } as W, skip, exactTake)));
  }
  const left = take === undefined ? undefined : take - out.length;
  if (left === undefined || left > 0) {
    const idNotIn: IdWhere = { id: { notIn: exactIds } };
    out.push(...(await fetch({ AND: [where, idNotIn] } as W, Math.max(0, skip - n), left)));
  }
  return out;
}

/** `equals` + case-insensitive filter for a trimmed query (null when blank) */
export function eqi(q: string | null | undefined) {
  const v = (q ?? "").trim();
  return v ? { equals: v, mode: "insensitive" as const } : null;
}
