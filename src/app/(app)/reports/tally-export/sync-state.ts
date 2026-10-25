import type { Prisma } from "@prisma/client";
import type { TallyVoucher } from "@/lib/tally";
import {
  SYNC_MODULES,
  SYNC_PREFIX,
  docIdOfKey,
  type RegistryRow,
  type SyncDoc,
  type SyncOp,
} from "@/lib/tally-sync";
import { buildModuleDocs, type ExportDoc, type Range, type TallyModule } from "./build";

type Tx = Prisma.TransactionClient;
interface Session {
  tenantId: string;
  firmId: string;
  fyId: string;
}

/** A document row of the export screen: live, or removed from the software. */
export interface StateDoc extends ExportDoc, SyncDoc {
  removed?: boolean;
}

export interface ExportState {
  sync: boolean;
  docs: StateDoc[];
  rowsByDoc: Map<string, RegistryRow[]>;
  /** documents inside a downloaded file not yet confirmed imported */
  pendingDocIds: Set<string>;
}

export function isSyncModule(module: string): module is (typeof SYNC_MODULES)[number] {
  return (SYNC_MODULES as readonly string[]).includes(module);
}


const toRow = (r: {
  key: string;
  hash: string;
  remoteId: boolean;
  vchType: string | null;
  vchDate: string | null;
  ledgerSig: string | null;
}): RegistryRow => ({
  key: r.key,
  hash: r.hash,
  remoteId: r.remoteId,
  vchType: r.vchType,
  vchDate: r.vchDate,
  ledgerSig: r.ledgerSig,
});

/** VOUCHERNUMBER = the document's own number, filled before hashing — the
 *  export and the status must hash the SAME shape. */
function withVoucherNo(d: ExportDoc): TallyVoucher[] {
  return d.vouchers.map((v) => ({ ...v, voucherNo: v.voucherNo ?? d.refNo }));
}

/**
 * Everything the export screen and the export action need for one module:
 * the documents (as they export NOW), their register rows, and — for Chalan
 * and Billing — documents that left the software but still have
 * vouchers in Tally ("Remove from Tally").
 */
export async function loadExportState(
  tx: Tx,
  session: Session,
  module: TallyModule,
  range: Range
): Promise<ExportState> {
  // Chalan and Billing always update / delete their own vouchers in Tally
  const sync = isSyncModule(module);
  const { docs: built } = await buildModuleDocs(tx, session, module, range, { sync });
  const docs: StateDoc[] = built.map((d) => ({ ...d, vouchers: withVoucherNo(d) }));
  const liveIds = new Set(docs.map((d) => d.id));

  const rowsByDoc = new Map<string, RegistryRow[]>();
  const add = (docId: string, r: RegistryRow) => {
    const list = rowsByDoc.get(docId);
    if (list) list.push(r);
    else rowsByDoc.set(docId, [r]);
  };

  const prefix = isSyncModule(module) ? SYNC_PREFIX[module] : null;
  if (sync && prefix) {
    // every row the module ever sent: current vouchers, obsolete ones, and
    // those of documents that are gone
    const all = await tx.tallyExportEntry.findMany({
      where: { firmId: session.firmId, key: { startsWith: prefix } },
    });
    const orphanIds = new Set<string>();
    for (const r of all) {
      const id = docIdOfKey(r.key, prefix);
      if (!id) continue;
      if (liveIds.has(id)) add(id, toRow(r));
      else orphanIds.add(id);
    }
    const removed = await removedDocs(tx, session, module, Array.from(orphanIds));
    for (const d of removed) {
      docs.push(d);
      for (const r of all) if (docIdOfKey(r.key, prefix) === d.id) add(d.id, toRow(r));
    }
  } else {
    const keyToDoc = new Map(docs.flatMap((d) => d.vouchers.map((v) => [v.key, d.id] as const)));
    const rows = await tx.tallyExportEntry.findMany({
      where: { firmId: session.firmId, key: { in: Array.from(keyToDoc.keys()) } },
    });
    for (const r of rows) add(keyToDoc.get(r.key)!, toRow(r));
  }

  const pending = await tx.tallyExportBatch.findMany({
    where: { firmId: session.firmId, module, status: "PENDING" },
    select: { ops: true },
  });
  const pendingDocIds = new Set(pending.flatMap((b) => (b.ops as unknown as SyncOp[]).map((o) => o.docId)));

  return { sync, docs, rowsByDoc, pendingDocIds };
}

/**
 * Of the documents that have register rows but did not build, the ones that
 * really left the software (deleted, cancelled, back to draft, zero amount).
 * Live documents merely outside the date filter are not returned.
 */
async function removedDocs(
  tx: Tx,
  session: Session,
  module: TallyModule,
  ids: string[]
): Promise<StateDoc[]> {
  if (ids.length === 0) return [];
  if (module === "CHALAN") {
    const rows = await tx.chalan.findMany({
      where: { id: { in: ids }, firmId: session.firmId },
      select: { id: true, chalanNo: true, chalanDate: true, brokerId: true, deletedAt: true, cancelledAt: true, isFinal: true },
    });
    const byId = new Map(rows.map((r) => [r.id, r]));
    const gone = ids.filter((id) => {
      const c = byId.get(id);
      return !c || !!c.deletedAt || !!c.cancelledAt || !c.isFinal;
    });
    const brokers = await partyNames(tx, rows.filter((r) => gone.includes(r.id)).map((r) => r.brokerId));
    return gone.map((id) => {
      const c = byId.get(id);
      return removedDoc(id, c?.chalanNo ?? "(deleted chalan)", c?.chalanDate ?? null, c ? brokers.get(c.brokerId) ?? "" : "",
        !c || c.deletedAt ? "Deleted" : c.cancelledAt ? "Cancelled" : "Back to draft");
    });
  }
  if (module === "BILLING") {
    const rows = await tx.invoice.findMany({
      where: { id: { in: ids }, firmId: session.firmId },
      select: { id: true, invoiceNo: true, invoiceDate: true, partyId: true, deletedAt: true, netTotal: true },
    });
    const byId = new Map(rows.map((r) => [r.id, r]));
    const gone = ids.filter((id) => {
      const b = byId.get(id);
      return !b || !!b.deletedAt || Number(b.netTotal) <= 0;
    });
    const parties = await partyNames(tx, rows.filter((r) => gone.includes(r.id)).map((r) => r.partyId));
    return gone.map((id) => {
      const b = byId.get(id);
      return removedDoc(id, b?.invoiceNo ?? "(deleted bill)", b?.invoiceDate ?? null, b ? parties.get(b.partyId) ?? "" : "",
        !b || b.deletedAt ? "Deleted" : "Zero amount");
    });
  }
  return [];
}

async function partyNames(tx: Tx, ids: string[]): Promise<Map<string, string>> {
  if (ids.length === 0) return new Map();
  const rows = await tx.party.findMany({ where: { id: { in: ids } }, select: { id: true, name: true } });
  return new Map(rows.map((p) => [p.id, p.name]));
}

function removedDoc(id: string, refNo: string, date: Date | null, party: string, why: string): StateDoc {
  return {
    id,
    refNo,
    dateIso: (date ?? new Date()).toISOString(),
    party,
    detail: `${why} — remove from Tally`,
    amount: 0,
    vouchers: [],
    removed: true,
  };
}
