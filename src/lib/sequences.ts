import { Tx } from "./db";
import { DocNumberType } from "@prisma/client";

/**
 * FY continuity: these document numbers CONTINUE across financial years
 * (…498, 499 | new FY | 500, 501…) instead of restarting at 1. Their sequence
 * row is keyed to the firm's FIRST financial year, so every later year reads
 * and bumps the same counter. LR / bill / POD / trip numbers stay per-FY.
 */
const FY_CONTINUOUS: ReadonlySet<DocNumberType> = new Set([
  "CHALAN",
  "BROKER_SLIP",
  "VOUCHER_RECEIPT",
  "VOUCHER_PAYMENT",
  "VOUCHER_CONTRA",
  "VOUCHER_JOURNAL",
] as DocNumberType[]);

/** The fyId whose sequence row carries this docType's counter. */
async function sequenceFyId(
  tx: Tx,
  firmId: string,
  fyId: string,
  docType: DocNumberType
): Promise<string> {
  if (!FY_CONTINUOUS.has(docType)) return fyId;
  const first = await tx.financialYear.findFirst({
    where: { firmId },
    orderBy: { startDate: "asc" },
    select: { id: true },
  });
  const canonical = first?.id ?? fyId;
  // consolidate strays: rows created under OTHER fy keys (pre-feature, or a
  // back-inserted earlier FY changing which row is "first") must never let
  // the counter fall backwards and re-issue numbers — the canonical row is
  // always bumped to the highest `next` seen anywhere for this docType
  const rows = await tx.documentSequence.findMany({
    where: { firmId, docType },
    select: { fyId: true, next: true, prefix: true },
  });
  const maxNext = rows.reduce((m, r) => Math.max(m, r.next), 0);
  const canonicalRow = rows.find((r) => r.fyId === canonical);
  if (rows.length && (!canonicalRow || canonicalRow.next < maxNext)) {
    const tenant = await tx.documentSequence.findFirst({
      where: { firmId, docType },
      select: { tenantId: true },
    });
    await tx.documentSequence.upsert({
      where: { firmId_fyId_docType: { firmId, fyId: canonical, docType } },
      create: {
        tenantId: tenant?.tenantId ?? "",
        firmId,
        fyId: canonical,
        docType,
        next: maxNext,
        prefix: rows.find((r) => r.prefix)?.prefix ?? "",
      },
      update: { next: maxNext },
    });
  }
  return canonical;
}

/**
 * Next document number for a firm+FY+docType. Transactional: call inside the
 * same transaction that inserts the document. Numbers are seeded by the first
 * manual entry, auto-increment after, and stay editable (uniqueness enforced
 * by DB constraints on the document tables).
 */
export async function nextDocNumber(
  tx: Tx,
  args: { tenantId: string; firmId: string; fyId: string; docType: DocNumberType }
): Promise<string> {
  const fyId = await sequenceFyId(tx, args.firmId, args.fyId, args.docType);
  const seq = await tx.documentSequence.upsert({
    where: {
      firmId_fyId_docType: {
        firmId: args.firmId,
        fyId,
        docType: args.docType,
      },
    },
    create: { ...args, fyId, next: 2 },
    update: { next: { increment: 1 } },
  });
  // when created, current number = 1 (next stored as 2); when updated, the
  // pre-increment value was seq.next - 1
  const current = seq.next - 1;
  return `${seq.prefix}${current}`;
}

/** After saving a manually-entered number, bump the sequence past it. */
export async function syncSequenceTo(
  tx: Tx,
  args: {
    tenantId: string;
    firmId: string;
    fyId: string;
    docType: DocNumberType;
    savedNumber: string;
  }
): Promise<void> {
  const n = parseInt(args.savedNumber.replace(/\D/g, ""), 10);
  if (isNaN(n)) return;
  const fyId = await sequenceFyId(tx, args.firmId, args.fyId, args.docType);
  await tx.documentSequence.upsert({
    where: {
      firmId_fyId_docType: {
        firmId: args.firmId,
        fyId,
        docType: args.docType,
      },
    },
    create: {
      tenantId: args.tenantId,
      firmId: args.firmId,
      fyId,
      docType: args.docType,
      next: n + 1,
    },
    update: {},
  });
  await tx.documentSequence.updateMany({
    where: {
      firmId: args.firmId,
      fyId,
      docType: args.docType,
      next: { lte: n },
    },
    data: { next: n + 1 },
  });
}

/**
 * Random unique document number: N random digits (never starting with 0),
 * re-rolled until `exists` reports it free. Uniqueness is ultimately
 * guaranteed by the DB constraint on the document table; this only avoids
 * showing a colliding prefill. Falls back to a timestamp suffix if an
 * improbable streak of collisions occurs.
 */
export async function randomUniqueDocNumber(
  exists: (candidate: string) => Promise<boolean>,
  opts?: { digits?: number }
): Promise<string> {
  const digits = opts?.digits ?? 6;
  const min = Math.pow(10, digits - 1);
  const span = Math.pow(10, digits) - min;
  for (let i = 0; i < 30; i++) {
    const candidate = String(min + Math.floor(Math.random() * span));
    if (!(await exists(candidate))) return candidate;
  }
  return String(Date.now()).slice(-Math.max(digits, 9));
}


/** Numeric part of an LR number ("LR-1241" -> 1241); null when it has none. */
function lrNumeric(lrNo: string): number | null {
  const digits = lrNo.replace(/\D/g, "");
  return digits ? Number(digits) : null;
}

/**
 * Hands out free LR numbers for this firm+FY, counting up from the LAST NEW LR
 * ENTERED (+1) — not from the highest number, so one stray high entry (a typo,
 * another book's LR) no longer drags every later suggestion up with it.
 * "Last entered" is by creation, so editing an old LR never moves it; a
 * Multi-LR batch shares one timestamp, so the id (cuid, creation-ordered)
 * breaks the tie. Deleted LRs don't count — their numbers may be reused.
 * Numbers already held by a live LR are skipped, as is anything `skip` names
 * (a batch's own typed numbers). With no numeric LR yet, it continues from
 * the highest number (1 for a new year).
 */
export async function lrNumberAllocator(
  tx: Tx,
  args: { firmId: string; fyId: string }
): Promise<(skip?: (lrNo: string) => boolean) => string> {
  const where = { firmId: args.firmId, fyId: args.fyId, deletedAt: null };
  const [rows, last] = await Promise.all([
    tx.lr.findMany({ where, select: { lrNo: true } }),
    tx.lr.findFirst({
      where,
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      select: { lrNo: true },
    }),
  ]);
  const taken = new Set<number>();
  for (const r of rows) {
    const n = lrNumeric(r.lrNo);
    if (n != null) taken.add(n);
  }
  const lastN = last ? lrNumeric(last.lrNo) : null;
  let max = 0;
  taken.forEach((n) => {
    if (n > max) max = n;
  });
  let cursor = lastN != null ? lastN + 1 : max + 1;
  return (skip) => {
    while (taken.has(cursor) || skip?.(String(cursor))) cursor++;
    return String(cursor++);
  };
}

/** Next free LR number — last new LR entered + 1 (see lrNumberAllocator). */
export async function nextLrNumber(
  tx: Tx,
  args: { firmId: string; fyId: string }
): Promise<string> {
  return (await lrNumberAllocator(tx, args))();
}

/**
 * Max numeric chalan number in this FIRM plus one. Chalan numbers continue
 * across financial years (FY continuity) — the new year picks up where the
 * old one stopped instead of restarting at 1.
 */
export async function nextChalanNumber(
  tx: Tx,
  args: { firmId: string; fyId?: string }
): Promise<string> {
  const rows = await tx.$queryRaw<{ max: bigint | null }[]>`
    SELECT MAX(NULLIF(regexp_replace("chalanNo", '\\D', '', 'g'), '')::bigint) AS max
    FROM "Chalan" WHERE "firmId" = ${args.firmId}`;
  const max = rows[0]?.max ? Number(rows[0].max) : 0;
  return String(max + 1);
}

/** Peek at the next number without consuming it (for form prefill). */
export async function peekDocNumber(
  tx: Tx,
  args: { firmId: string; fyId: string; docType: DocNumberType }
): Promise<string | null> {
  const fyId = await sequenceFyId(tx, args.firmId, args.fyId, args.docType);
  const seq = await tx.documentSequence.findUnique({
    where: {
      firmId_fyId_docType: {
        firmId: args.firmId,
        fyId,
        docType: args.docType,
      },
    },
  });
  return seq ? `${seq.prefix}${seq.next}` : null;
}
