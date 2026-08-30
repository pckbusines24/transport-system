# Output-parity harnesses

Scripts that prove a performance change did not move a single figure a user
sees. Each one runs the same input through the current code and through a
reference — either an equivalent code path, or the same function at a baseline
git ref — and deep-diffs the rows that come out.

> **These need a throwaway database.** They delete `Lr`, `LrItem`,
> `DocumentSequence` and `AuditLog` rows between cases. Never point one at a
> database you care about.

## Running

Bring up a scratch Postgres, migrate, seed, then run:

```bash
docker compose up -d db
export DATABASE_URL="postgresql://tms:tms_dev_password@127.0.0.1:5433/transport_tms"
export DIRECT_DATABASE_URL="$DATABASE_URL"
npx prisma migrate deploy
npx tsx prisma/seed.ts
npx tsx scripts/parity/lr-batch-parity.ts
```

Exit code is 0 on parity, 1 on any difference, so it drops straight into CI.

## `lr-batch-parity.ts` — `saveLrBatch`

`saveLrBatch` used to run two party lookups plus an ODC-product lookup for
every entry, serially, inside one transaction — a 50-LR batch was ~150 round
trips holding one pooled connection. Those lookups were hoisted out of the loop
and batched. Nothing about what gets written was meant to change.

Three comparisons:

- **A — batch vs one-by-one.** Saving N LRs as a batch must produce
  byte-identical rows to saving the same N through `saveLr` individually. This
  is a permanent invariant, independent of any refactor, and is the check worth
  keeping in CI.
- **B — current vs a baseline git ref.** Set `BASELINE_REF` (default `HEAD`) to
  the commit before the change. When the baseline file is byte-identical to the
  working tree the comparison is **skipped and says so** — it would otherwise
  pass vacuously, which is worse than not running.
- **C — invariants.** Duplicate-number detection inside a batch, clash
  detection against existing LRs, and sequential number assignment (including
  blanks continuing from max+1 and stepping over numbers typed in the same
  batch).

The payload deliberately mixes intra-state and inter-state GSTIN pairs so both
the CGST/SGST and the IGST split are produced, a party with no GSTIN, ODC and
NORMAL products, multi-item LRs, dummy and real vehicles, GST on and off, and a
non-zero advance. Comparison A asserts that ODC rows and both GST splits were
actually produced, so the run fails loudly rather than passing on a payload
that never exercised the interesting branches.

### How it loads the code under test

`lr/actions.ts` is a `"use server"` module: it reads the session from cookies
and calls `revalidatePath`, neither of which exists outside a Next request. The
harness rewrites those two things — injecting a session and stubbing the cache
signals — into a temporary module under `.tmp/` (gitignored, removed on exit).
The transform touches nothing that can affect what is written to the database,
and asserts that it actually found its injection points rather than silently
testing an unmodified file.

### Verified against deliberate regressions

A parity test that cannot fail is worth nothing. This one was checked against
three seeded bugs — forcing `cargoType` to `NORMAL`, swapping the supplier and
recipient state codes in the GST split, and resolving every entry's consignor
from the first entry (the classic batching mistake). All three are caught by
both comparison A and comparison B.
