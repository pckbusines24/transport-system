"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { requireSession } from "@/lib/session";
import { runImport, matchEnum, type ImportSummary } from "@/lib/import-core";
import { authorize } from "@/lib/authz";
import { withTenant } from "@/lib/db";
import { audit } from "@/lib/audit";
import { isSystemHeadName } from "@/lib/account-heads";
import { actionError, zodError, type ActionResult } from "../_lib/util";

const schema = z.object({
  id: z.string().optional(),
  name: z.string().trim().min(1, "Name is required"),
  kind: z.enum(["INCOME", "EXPENSE"]),
});

export async function saveAccountHead(input: unknown): Promise<ActionResult> {
  const session = requireSession();
  const parsed = schema.safeParse(input);
  if (!parsed.success) return zodError(parsed.error);
  const data = parsed.data;
  await authorize(session, "masters", data.id ? "edit" : "create");
  try {
    const result = await withTenant(session.tenantId, async (tx) => {
      if (data.id) {
        const before = await tx.accountHead.findUniqueOrThrow({ where: { id: data.id } });
        // system heads carry the exact names every module posts to — renaming
        // or reclassifying one would silently break those postings
        if (isSystemHeadName(before.name)) {
          throw new Error(
            `"${before.name}" is a system ledger head used by the software itself — it cannot be edited.`
          );
        }
        const row = await tx.accountHead.update({
          where: { id: data.id },
          data: { name: data.name, kind: data.kind },
        });
        await audit(tx, session, { entity: "AccountHead", entityId: row.id, action: "UPDATE", before, after: row });
        return row.id;
      }
      const row = await tx.accountHead.create({
        data: { tenantId: session.tenantId, name: data.name, kind: data.kind },
      });
      await audit(tx, session, { entity: "AccountHead", entityId: row.id, action: "CREATE", after: row });
      return row.id;
    });
    revalidatePath("/masters/account-heads");
    return { ok: true, id: result };
  } catch (e) {
    return actionError(e);
  }
}

const PNL_SCOPES = ["AUTO", "COMPANY", "VEHICLE", "EXCLUDE"] as const;
export type PnlScope = (typeof PNL_SCOPES)[number];

/** Which operational P&L this head reports in — saved instantly from the grid.
 *  Allowed on system heads too: it changes reporting placement, not postings. */
export async function setPnlScope(
  headId: string,
  scope: PnlScope
): Promise<{ ok: true } | { ok: false; error: string }> {
  const session = requireSession();
  await authorize(session, "masters", "edit");
  if (!PNL_SCOPES.includes(scope)) return { ok: false, error: "Invalid scope" };
  try {
    await withTenant(session.tenantId, async (tx) => {
      const before = await tx.accountHead.findUniqueOrThrow({ where: { id: headId } });
      const after = await tx.accountHead.update({
        where: { id: headId },
        data: { pnlScope: scope },
      });
      await audit(tx, session, { entity: "AccountHead", entityId: headId, action: "UPDATE", before, after });
    });
    revalidatePath("/masters/account-heads");
    revalidatePath("/accounts/operational-pnl");
    revalidatePath("/accounts/vehicle-operational-pnl");
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Failed to save" };
  }
}

export async function deleteAccountHead(id: string): Promise<ActionResult> {
  const session = requireSession();
  await authorize(session, "masters", "delete");
  try {
    await withTenant(session.tenantId, async (tx) => {
      const before = await tx.accountHead.findUniqueOrThrow({ where: { id } });
      if (isSystemHeadName(before.name)) {
        throw new Error(
          `"${before.name}" is a system ledger head used by the software itself — it cannot be deleted.`
        );
      }
      await tx.accountHead.delete({ where: { id } });
      await audit(tx, session, { entity: "AccountHead", entityId: id, action: "DELETE", before });
    });
    revalidatePath("/masters/account-heads");
    return { ok: true, id };
  } catch (e) {
    return actionError(e);
  }
}

/** Excel/CSV import — see the sample template for expected columns. */
export async function importAccountHeads(formData: FormData): Promise<ImportSummary> {
  const session = requireSession();
  await authorize(session, "masters", "create");
  const file = formData.get("file");
  return withTenant(session.tenantId, async (tx) =>
    runImport(file instanceof File ? file : null, ["NAME", "KIND"], async (rec) => {
      const name = rec["NAME"].toUpperCase();
      if (!name) throw new Error("Head name is required");
      const kind = matchEnum(rec["KIND"], { INCOME: "INCOME", EXPENSE: "EXPENSE" } as const);
      if (!kind) throw new Error(`Kind must be INCOME or EXPENSE (got "${rec["KIND"]}")`);
      const existing = await tx.accountHead.findFirst({ where: { name } });
      if (existing) {
        // an import must not reclassify a system head either
        if (isSystemHeadName(existing.name)) return "skipped";
        await tx.accountHead.update({ where: { id: existing.id }, data: { kind } });
        return "updated";
      }
      await tx.accountHead.create({ data: { tenantId: session.tenantId, name, kind } });
      return "created";
    })
  );
}
