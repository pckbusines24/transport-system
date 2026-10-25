"use server";

import { z } from "zod";
import { requireSession } from "@/lib/session";
import { withTenant } from "@/lib/db";
import { authorize } from "@/lib/authz";
import { audit } from "@/lib/audit";
import type { Prisma } from "@prisma/client";
import {
  buildMastersXml,
  buildVouchersXml,
  type TallyVoucher,
  type TallyVoucherDelete,
} from "@/lib/tally";
import { planDoc, type SyncOp } from "@/lib/tally-sync";
import { buildModuleDocs, type TallyModule } from "./build";
import { loadExportState } from "./sync-state";

const moduleSchema = z.enum(["CHALAN", "BILLING", "SLIP", "VOUCHERS", "EXPENSES", "OFFICE"]);

const exportSchema = z.object({
  module: moduleSchema,
  dateFrom: z.string().nullish(), // ISO yyyy-mm-dd
  dateTo: z.string().nullish(),
  docIds: z.array(z.string()).min(1, "Select at least one document"),
  /** false (default): only NEW / CHANGED vouchers; true: everything selected */
  includeExported: z.boolean().default(false),
  /** documents whose pre-tracking copies the user deleted in Tally by hand */
  legacyConfirmed: z.array(z.string()).default([]),
});

const toRange = (from?: string | null, to?: string | null) => ({
  dateFrom: from ? new Date(`${from}T00:00:00`) : null,
  dateTo: to ? new Date(`${to}T23:59:59`) : null,
});

/** Write a confirmed file's register changes (UPSERT / DELETE per voucher). */
async function applyOpsToRegister(
  tx: Prisma.TransactionClient,
  session: { tenantId: string; firmId: string },
  ops: SyncOp[]
) {
  for (const o of ops) {
    if (o.op === "DELETE") {
      await tx.tallyExportEntry.deleteMany({ where: { firmId: session.firmId, key: o.key } });
      continue;
    }
    const meta = {
      hash: o.hash,
      remoteId: o.remoteId,
      vchType: o.vchType,
      vchDate: o.vchDate,
      ledgerSig: o.ledgerSig,
    };
    await tx.tallyExportEntry.upsert({
      where: { firmId_key: { firmId: session.firmId, key: o.key } },
      create: { tenantId: session.tenantId, firmId: session.firmId, key: o.key, ...meta },
      update: { ...meta, exportedAt: new Date() },
    });
  }
}

/**
 * Generate the Tally vouchers XML for the selected documents of one module.
 *
 * Nothing is marked exported here: the file is recorded as PENDING and the
 * export register only changes when the user confirms Tally imported it
 * (confirmTallyBatch). With the module's sync switch on, vouchers go as
 * Create / Alter / Delete by REMOTEID (see lib/tally-sync).
 */
export async function runTallyExport(
  input: unknown
): Promise<
  | {
      ok: true;
      xml: string | null;
      fileName: string;
      exported: number;
      deleted: number;
      skipped: number;
      legacyChanged: number;
      blocked: string[];
      batchId: string | null;
    }
  | { ok: false; error: string }
> {
  const session = requireSession();
  const parsed = exportSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid input" };
  }
  const data = parsed.data;
  await authorize(session, "tally", "export");

  try {
    return await withTenant(session.tenantId, async (tx) => {
      const state = await loadExportState(
        tx,
        session,
        data.module as TallyModule,
        toRange(data.dateFrom, data.dateTo)
      );
      const wanted = state.docs.filter((d) => data.docIds.includes(d.id));
      const awaiting = wanted.filter((d) => state.pendingDocIds.has(d.id));
      if (awaiting.length) {
        return {
          ok: false as const,
          error: `${awaiting.map((d) => d.refNo).join(", ")}: already in a file awaiting import — confirm that file (Imported OK / Import failed) first.`,
        };
      }

      const vouchers: TallyVoucher[] = [];
      const deletes: TallyVoucherDelete[] = [];
      const ops: SyncOp[] = [];
      const blocked: string[] = [];
      let skipped = 0;
      let legacyChanged = 0;
      for (const d of wanted) {
        const plan = planDoc(d, state.rowsByDoc.get(d.id) ?? [], {
          sync: state.sync,
          includeExported: data.includeExported,
          legacyConfirmed: data.legacyConfirmed.includes(d.id),
        });
        if (plan.blocked) {
          blocked.push(plan.blocked);
          continue;
        }
        vouchers.push(...plan.vouchers);
        deletes.push(...plan.deletes);
        ops.push(...plan.ops);
        skipped += plan.skipped;
        legacyChanged += plan.legacyChanged;
      }

      const range = [data.dateFrom, data.dateTo].filter(Boolean).join("_to_") || "all";
      const fileName = `tally-${data.module.toLowerCase()}-${range}.xml`;
      const result = {
        fileName,
        exported: vouchers.length,
        deleted: deletes.length,
        skipped,
        legacyChanged,
        blocked,
      };

      if (vouchers.length === 0 && deletes.length === 0) {
        if (ops.length > 0) {
          // only register clean-up (old copies the user deleted by hand) —
          // nothing for Tally to import, so apply it straight away
          await applyOpsToRegister(tx, session, ops);
          return { ok: true as const, xml: null, batchId: null, ...result };
        }
        if (blocked.length) return { ok: true as const, xml: null, batchId: null, ...result };
        return {
          ok: false as const,
          error:
            "Everything is already exported — nothing new found. (For a full re-export, tick 'include already exported'.)",
        };
      }

      const xml = buildVouchersXml(vouchers, deletes);
      const batch = await tx.tallyExportBatch.create({
        data: {
          tenantId: session.tenantId,
          firmId: session.firmId,
          module: data.module,
          fileName,
          xml,
          ops: ops as unknown as Prisma.InputJsonValue,
          vouchers: vouchers.length,
          deletes: deletes.length,
        },
      });
      await audit(tx, session, {
        entity: "TallyExport",
        entityId: batch.id,
        action: "CREATE",
        after: { module: data.module, vouchers: vouchers.length, deletes: deletes.length, skipped, sync: state.sync },
      });
      return { ok: true as const, xml, batchId: batch.id, ...result };
    });
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Export failed" };
  }
}

/**
 * The user's answer after importing a downloaded file into Tally:
 * IMPORTED writes the register (those vouchers now count as in Tally);
 * FAILED changes nothing, so the same vouchers go across next time.
 */
export async function confirmTallyBatch(
  input: unknown
): Promise<{ ok: true } | { ok: false; error: string }> {
  const session = requireSession();
  const parsed = z
    .object({ batchId: z.string(), outcome: z.enum(["IMPORTED", "FAILED"]) })
    .safeParse(input);
  if (!parsed.success) return { ok: false, error: "Invalid input" };
  await authorize(session, "tally", "export");
  try {
    return await withTenant(session.tenantId, async (tx) => {
      const batch = await tx.tallyExportBatch.findFirst({
        where: { id: parsed.data.batchId, firmId: session.firmId },
      });
      if (!batch) return { ok: false as const, error: "File not found." };
      if (batch.status !== "PENDING") return { ok: false as const, error: "This file was already confirmed." };
      if (parsed.data.outcome === "IMPORTED") {
        await applyOpsToRegister(tx, session, batch.ops as unknown as SyncOp[]);
      }
      await tx.tallyExportBatch.update({
        where: { id: batch.id },
        data: { status: parsed.data.outcome, resolvedAt: new Date() },
      });
      await audit(tx, session, {
        entity: "TallyExport",
        entityId: batch.id,
        action: "UPDATE",
        after: { outcome: parsed.data.outcome, module: batch.module },
      });
      return { ok: true as const };
    });
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Could not record the result" };
  }
}

/** Download a pending file again (lost download, second try at importing). */
export async function getTallyBatchXml(
  input: unknown
): Promise<{ ok: true; xml: string; fileName: string } | { ok: false; error: string }> {
  const session = requireSession();
  const parsed = z.object({ batchId: z.string() }).safeParse(input);
  if (!parsed.success) return { ok: false, error: "Invalid input" };
  await authorize(session, "tally", "export");
  const batch = await withTenant(session.tenantId, (tx) =>
    tx.tallyExportBatch.findFirst({ where: { id: parsed.data.batchId, firmId: session.firmId } })
  );
  if (!batch) return { ok: false, error: "File not found." };
  return { ok: true, xml: batch.xml, fileName: batch.fileName };
}

/** Party ledger masters for the module's documents — first-time import. */
export async function runTallyMasters(
  input: unknown
): Promise<{ ok: true; xml: string; fileName: string; count: number } | { ok: false; error: string }> {
  const session = requireSession();
  const parsed = z
    .object({ module: moduleSchema, dateFrom: z.string().nullish(), dateTo: z.string().nullish() })
    .safeParse(input);
  if (!parsed.success) return { ok: false, error: "Invalid input" };
  await authorize(session, "tally", "export");
  try {
    return await withTenant(session.tenantId, async (tx) => {
      const { masters } = await buildModuleDocs(
        tx,
        session,
        parsed.data.module as TallyModule,
        toRange(parsed.data.dateFrom, parsed.data.dateTo)
      );
      if (!masters.length) {
        return { ok: false as const, error: "No party found in this period." };
      }
      return {
        ok: true as const,
        xml: buildMastersXml(masters),
        fileName: `tally-masters-${parsed.data.module.toLowerCase()}.xml`,
        count: masters.length,
      };
    });
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Masters export failed" };
  }
}
