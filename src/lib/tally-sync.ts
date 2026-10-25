import { voucherHash, type TallyVoucher, type TallyVoucherDelete } from "@/lib/tally";

/**
 * Tally sync planner — pure, no database.
 *
 * Given one document's vouchers as the software produces them NOW and the
 * export-register rows of what was last sent for it, decide what the next
 * XML file must say so Tally ends up matching the software:
 *
 *   never sent                          -> Create (with REMOTEID)
 *   unchanged                           -> skip (or Alter on a full re-export)
 *   amount / date / narration changed   -> Alter the same REMOTEID
 *   voucher type or ledger set changed  -> Delete + Create (same REMOTEID) —
 *                                          Tally replaces amounts on Alter but
 *                                          does not reliably drop old lines
 *   no longer produced (amount -> 0)    -> Delete
 *   document deleted / cancelled        -> Delete every voucher it had
 *
 * "Legacy" rows were exported before REMOTEIDs existed: Tally cannot find
 * them, so a document with a changed or obsolete legacy voucher is BLOCKED
 * until the user confirms they deleted its old vouchers in Tally by hand —
 * then everything is created fresh. Never a silent duplicate.
 *
 * Modules not yet on sync (`sync: false`) keep the old export exactly
 * (Create, plus the chalan-advance Alter that predates this planner).
 */

export interface RegistryRow {
  key: string;
  hash: string;
  remoteId: boolean;
  vchType: string | null;
  vchDate: string | null;
  ledgerSig: string | null;
}

export type SyncOp =
  | {
      op: "UPSERT";
      key: string;
      docId: string;
      hash: string;
      remoteId: boolean;
      vchType: string;
      vchDate: string;
      ledgerSig: string;
    }
  | { op: "DELETE"; key: string; docId: string };

export type DocSyncStatus =
  | "NEW" // nothing sent yet
  | "PARTIAL" // some vouchers sent, some new
  | "CHANGED" // something sent has changed / must be removed
  | "EXPORTED" // Tally matches the software
  | "REMOVE" // document gone from the software — its vouchers must leave Tally
  | "LEGACY"; // old (pre-REMOTEID) copies must be deleted in Tally by hand

export interface SyncDoc {
  id: string;
  refNo: string;
  /** vouchers as produced now, VOUCHERNUMBER already filled in */
  vouchers: TallyVoucher[];
  /** the document no longer exists / no longer exports */
  removed?: boolean;
}

export interface DocPlan {
  status: DocSyncStatus;
  fresh: number;
  changed: number;
  done: number;
  /** vouchers that must leave Tally (obsolete or removed document) */
  obsolete: number;
  /** a reason the document cannot export as it stands (legacy copies) */
  blocked: string | null;
  vouchers: TallyVoucher[];
  deletes: TallyVoucherDelete[];
  ops: SyncOp[];
  skipped: number;
  /** sync OFF only: edited advances whose first export predates REMOTEIDs */
  legacyChanged: number;
}

/** Sorted, distinct ledger names — a different set means Delete + Create. */
export function ledgerSig(v: TallyVoucher): string {
  return Array.from(new Set(v.lines.map((l) => l.ledger))).sort().join("|");
}

function upsertOp(docId: string, v: TallyVoucher, hash: string): SyncOp {
  return {
    op: "UPSERT",
    key: v.key,
    docId,
    hash,
    remoteId: !!v.remoteId,
    vchType: v.type,
    vchDate: v.date,
    ledgerSig: ledgerSig(v),
  };
}

function deleteOf(row: RegistryRow, voucherNo: string, fallbackDate: string): TallyVoucherDelete {
  return {
    remoteId: row.key,
    type: (row.vchType ?? "Journal") as TallyVoucher["type"],
    date: row.vchDate ?? fallbackDate,
    voucherNo,
  };
}

export function planDoc(
  doc: SyncDoc,
  rows: RegistryRow[],
  opts: {
    sync: boolean;
    /** resend unchanged vouchers too (as Alter in sync mode) */
    includeExported?: boolean;
    /** the user confirmed this document's old copies are deleted in Tally */
    legacyConfirmed?: boolean;
  }
): DocPlan {
  const byKey = new Map(rows.map((r) => [r.key, r]));
  const current = new Set(doc.vouchers.map((v) => v.key));
  const plan: DocPlan = {
    status: "EXPORTED",
    fresh: 0,
    changed: 0,
    done: 0,
    obsolete: 0,
    blocked: null,
    vouchers: [],
    deletes: [],
    ops: [],
    skipped: 0,
    legacyChanged: 0,
  };
  const hashes = new Map(doc.vouchers.map((v) => [v.key, voucherHash(v)]));
  const fallbackDate = doc.vouchers[0]?.date ?? rows.find((r) => r.vchDate)?.vchDate ?? "";

  // ------------------------------------------------------------ sync OFF
  if (!opts.sync) {
    for (const v of doc.vouchers) {
      const hash = hashes.get(v.key)!;
      const prev = byKey.get(v.key);
      if (!prev) plan.fresh += 1;
      else if (prev.hash === hash) plan.done += 1;
      else plan.changed += 1;
      if (!opts.includeExported && prev?.hash === hash) {
        plan.skipped += 1;
        continue;
      }
      let out = v;
      if (v.remoteId && prev) {
        if (!prev.remoteId) {
          if (prev.hash !== hash) plan.legacyChanged += 1;
        } else if (prev.vchType && prev.vchType !== v.type) {
          plan.deletes.push(deleteOf(prev, v.voucherNo ?? doc.refNo, v.date));
        } else {
          out = { ...v, action: "Alter" };
        }
      }
      plan.vouchers.push(out);
      plan.ops.push(upsertOp(doc.id, out, hash));
    }
    plan.status = statusOf(plan, doc, rows);
    return plan;
  }

  // ------------------------------------------------------------ sync ON
  const obsoleteRows = doc.removed ? rows : rows.filter((r) => !current.has(r.key));
  const legacyTrouble =
    rows.some((r) => !r.remoteId && !current.has(r.key)) ||
    doc.vouchers.some((v) => {
      const prev = byKey.get(v.key);
      return !!prev && !prev.remoteId && prev.hash !== hashes.get(v.key);
    });

  for (const v of doc.vouchers) {
    const prev = byKey.get(v.key);
    if (!prev) plan.fresh += 1;
    else if (prev.hash === hashes.get(v.key)) plan.done += 1;
    else plan.changed += 1;
  }
  plan.obsolete = obsoleteRows.length;

  if (legacyTrouble && !opts.legacyConfirmed) {
    plan.blocked =
      `Voucher(s) of ${doc.refNo} were sent to Tally before update tracking, so Tally cannot ` +
      `find them. Delete ALL vouchers of ${doc.refNo} in Tally by hand, then tick ` +
      `"old copies deleted" so they are created fresh.`;
    plan.status = "LEGACY";
    return plan;
  }

  if (legacyTrouble && opts.legacyConfirmed) {
    // the user deleted every old copy: forget the register, create afresh
    for (const r of rows) plan.ops.push({ op: "DELETE", key: r.key, docId: doc.id });
    for (const v of doc.vouchers) {
      plan.vouchers.push({ ...v, action: "Create" });
      plan.ops.push(upsertOp(doc.id, v, hashes.get(v.key)!));
    }
    plan.status = statusOf(plan, doc, rows);
    return plan;
  }

  for (const v of doc.vouchers) {
    const hash = hashes.get(v.key)!;
    const prev = byKey.get(v.key);
    if (!prev) {
      plan.vouchers.push({ ...v, action: "Create" });
      plan.ops.push(upsertOp(doc.id, v, hash));
      continue;
    }
    if (prev.hash === hash && !opts.includeExported) {
      plan.skipped += 1;
      continue;
    }
    if (!prev.remoteId) {
      // unchanged legacy copy on a full re-export: Tally can't match it —
      // resending would duplicate, so leave it alone
      plan.skipped += 1;
      continue;
    }
    const typeChanged = !!prev.vchType && prev.vchType !== v.type;
    const linesChanged = !!prev.ledgerSig && prev.ledgerSig !== ledgerSig(v);
    if (typeChanged || linesChanged) {
      plan.deletes.push(deleteOf(prev, v.voucherNo ?? doc.refNo, v.date));
      plan.vouchers.push({ ...v, action: "Create" });
    } else {
      plan.vouchers.push({ ...v, action: "Alter" });
    }
    plan.ops.push(upsertOp(doc.id, v, hash));
  }
  for (const r of obsoleteRows) {
    plan.deletes.push(deleteOf(r, doc.refNo, fallbackDate));
    plan.ops.push({ op: "DELETE", key: r.key, docId: doc.id });
  }
  plan.status = statusOf(plan, doc, rows);
  return plan;
}

function statusOf(plan: DocPlan, doc: SyncDoc, rows: RegistryRow[]): DocSyncStatus {
  if (doc.removed) return "REMOVE";
  if (rows.length === 0) return "NEW";
  if (plan.changed > 0 || plan.obsolete > 0) return "CHANGED";
  if (plan.fresh > 0) return "PARTIAL";
  return "EXPORTED";
}

/** Apply a confirmed file's ops to the register rows (pure; tests + server). */
export function applyOps(rows: Map<string, RegistryRow>, ops: SyncOp[]): Map<string, RegistryRow> {
  const next = new Map(rows);
  for (const o of ops) {
    if (o.op === "DELETE") next.delete(o.key);
    else
      next.set(o.key, {
        key: o.key,
        hash: o.hash,
        remoteId: o.remoteId,
        vchType: o.vchType,
        vchDate: o.vchDate,
        ledgerSig: o.ledgerSig,
      });
  }
  return next;
}

/** Register key prefix of one document's vouchers, per module. */
export const SYNC_PREFIX: Record<string, string> = { CHALAN: "CHALAN:", BILLING: "BILL:" };

/** Modules whose exports update / delete their own vouchers in Tally. */
export const SYNC_MODULES = ["CHALAN", "BILLING"] as const;

/** "CHALAN:<id>:MAIN" -> "<id>" for a module prefix. */
export function docIdOfKey(key: string, prefix: string): string | null {
  if (!key.startsWith(prefix)) return null;
  const rest = key.slice(prefix.length);
  const i = rest.indexOf(":");
  return i > 0 ? rest.slice(0, i) : null;
}
