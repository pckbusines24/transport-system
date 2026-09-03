/**
 * Duplicate detection for TRANSACTIONAL imports (expenses and the like).
 *
 * Master-data imports dedupe on a name, which is genuinely unique. A
 * transaction has no such natural key: the same vehicle can legitimately take
 * two ₹5,000 diesel fills on the same day, from the same card, under the same
 * head. Matching on a signature alone treats the second one as a copy of the
 * first and silently drops it.
 *
 * So the unit of comparison is the OCCURRENCE, not the signature. The ledger is
 * seeded with how many records already exist for each signature and every
 * imported row consumes one:
 *
 *   file has 2 identical rows, database has 0  -> both import
 *   the same file imported again (database 2)  -> both recognised, none added
 *   a file with 3 such rows (database 2)       -> two recognised, one imported
 *
 * That keeps a re-import idempotent — the requirement people actually care
 * about — without pretending that two same-day, same-amount fills are one
 * event.
 *
 * When the source data DOES carry a reference number, that is a real
 * transaction id: two rows sharing one are the same bill entered twice, so the
 * unique mode below collapses them.
 */
export class ImportDedup {
  /** signature -> how many matching records are still unaccounted for */
  private readonly remaining = new Map<string, number>();
  /** signatures already consumed in THIS run, for reference-numbered rows */
  private readonly usedUnique = new Set<string>();

  /** Seed with one entry per record already in the database. */
  constructor(existingKeys: readonly string[] = []) {
    for (const key of existingKeys) this.add(key);
  }

  /** Record that one more matching row exists. */
  add(key: string): void {
    this.remaining.set(key, (this.remaining.get(key) ?? 0) + 1);
  }

  /** How many records with this signature are still unaccounted for. */
  count(key: string): number {
    return this.remaining.get(key) ?? 0;
  }

  /**
   * Claim one occurrence of `key`.
   *
   * Returns true when this row is already on record and should be SKIPPED,
   * false when it is new and should be imported.
   *
   * `unique` marks a row carrying its own reference / transaction id, where a
   * repeat is a genuine duplicate rather than a second event.
   */
  isDuplicate(key: string, opts: { unique?: boolean } = {}): boolean {
    if (opts.unique) {
      // one record per reference, whether the twin is in the database or
      // earlier in this same file
      if (this.usedUnique.has(key) || this.count(key) > 0) return true;
      this.usedUnique.add(key);
      return false;
    }
    const left = this.count(key);
    if (left > 0) {
      // an existing record accounts for this row
      this.remaining.set(key, left - 1);
      return true;
    }
    // genuinely new: it will exist after import, but the count stays at 0
    // because THIS row is the one that creates it — a later identical row in
    // the same file is a separate event and must import too
    return false;
  }
}
