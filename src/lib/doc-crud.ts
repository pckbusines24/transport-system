import { revalidatePath } from "next/cache";
import type { DocNumberType } from "@prisma/client";
import { withTenant, type Tx } from "./db";
import type { Session } from "./session";
import { audit } from "./audit";
import { nextDocNumber, syncSequenceTo } from "./sequences";
import { assertNotReferenced, type MasterKind } from "./master-refs";

export type ActionResult = { ok: true; id: string } | { ok: false; error: string };

export interface DocCrudConfig {
  /** prisma delegate name, e.g. "loadingChalan" */
  delegate: string;
  /** audit entity name, e.g. "LoadingChalan" */
  entity: string;
  /** route to revalidate, e.g. "/loading-chalan" */
  path: string;
  /** auto-number sequence to use (optional; only for firmfy-scoped documents) */
  docType?: DocNumberType;
  /** field holding the document number (required when docType set) */
  numberField?: string;
  /** row has firmId+fyId ("firmfy"), only firmId ("firm"), or neither ("tenant") */
  scope: "firmfy" | "firm" | "tenant";
  /** soft delete via deletedAt (true) or hard delete (false) */
  softDelete: boolean;
  /** reference-registry kind: delete is refused while anything points at the row */
  refKind?: MasterKind;
}

type FullSession = Session & { firmId: string; fyId: string };

/* Delegates are addressed by name; the narrow surface used here is typed locally. */
interface AnyDelegate {
  findUniqueOrThrow(args: { where: { id: string } }): Promise<Record<string, unknown>>;
  create(args: { data: Record<string, unknown> }): Promise<{ id: string }>;
  update(args: {
    where: { id: string };
    data: Record<string, unknown>;
  }): Promise<{ id: string }>;
  delete(args: { where: { id: string } }): Promise<unknown>;
}

function delegateOf(tx: Tx, name: string): AnyDelegate {
  return (tx as unknown as Record<string, AnyDelegate>)[name];
}

function friendlyError(e: unknown, cfg: DocCrudConfig): ActionResult {
  const msg = e instanceof Error ? e.message : "Unexpected error";
  if (msg.includes("Unique constraint")) {
    return { ok: false, error: "This document number already exists for the firm / financial year." };
  }
  if (msg.includes("Foreign key")) {
    return { ok: false, error: `${cfg.entity} is referenced by other records.` };
  }
  return { ok: false, error: msg };
}

/** Create or update a document row, handling scope fields, numbering and audit. */
export async function saveDocRow(
  session: FullSession,
  cfg: DocCrudConfig,
  id: string | undefined,
  values: Record<string, unknown>
): Promise<ActionResult> {
  try {
    const rowId = await withTenant(session.tenantId, async (tx) => {
      const d = delegateOf(tx, cfg.delegate);
      if (id) {
        const before = await d.findUniqueOrThrow({ where: { id } });
        const row = await d.update({ where: { id }, data: values });
        await audit(tx, session, { entity: cfg.entity, entityId: row.id, action: "UPDATE", before, after: values });
        if (cfg.docType && cfg.numberField && values[cfg.numberField]) {
          await syncSequenceTo(tx, {
            tenantId: session.tenantId,
            firmId: session.firmId,
            fyId: session.fyId,
            docType: cfg.docType,
            savedNumber: String(values[cfg.numberField]),
          });
        }
        return row.id;
      }

      const scoped: Record<string, unknown> = { tenantId: session.tenantId, ...values };
      if (cfg.scope !== "tenant") scoped.firmId = session.firmId;
      if (cfg.scope === "firmfy") scoped.fyId = session.fyId;

      if (cfg.docType && cfg.numberField) {
        const manual = String(scoped[cfg.numberField] ?? "").trim();
        if (!manual) {
          scoped[cfg.numberField] = await nextDocNumber(tx, {
            tenantId: session.tenantId,
            firmId: session.firmId,
            fyId: session.fyId,
            docType: cfg.docType,
          });
        }
      }
      const row = await d.create({ data: scoped });
      if (cfg.docType && cfg.numberField) {
        await syncSequenceTo(tx, {
          tenantId: session.tenantId,
          firmId: session.firmId,
          fyId: session.fyId,
          docType: cfg.docType,
          savedNumber: String(scoped[cfg.numberField]),
        });
      }
      await audit(tx, session, { entity: cfg.entity, entityId: row.id, action: "CREATE", after: scoped });
      return row.id;
    });
    revalidatePath(cfg.path);
    return { ok: true, id: rowId };
  } catch (e) {
    return friendlyError(e, cfg);
  }
}

export async function deleteDocRow(
  session: FullSession,
  cfg: DocCrudConfig,
  id: string
): Promise<ActionResult> {
  try {
    await withTenant(session.tenantId, async (tx) => {
      const d = delegateOf(tx, cfg.delegate);
      const before = await d.findUniqueOrThrow({ where: { id } });
      // e.g. a hire slip settled by a payment voucher must not vanish under it
      if (cfg.refKind) await assertNotReferenced(tx, cfg.refKind, { id });
      if (cfg.softDelete) await d.update({ where: { id }, data: { deletedAt: new Date() } });
      else await d.delete({ where: { id } });
      await audit(tx, session, { entity: cfg.entity, entityId: id, action: "DELETE", before });
    });
    revalidatePath(cfg.path);
    return { ok: true, id };
  } catch (e) {
    return friendlyError(e, cfg);
  }
}
