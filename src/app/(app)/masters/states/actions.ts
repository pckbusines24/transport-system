"use server";

import { revalidatePath, revalidateTag } from "next/cache";
import { z } from "zod";
import { requireSession } from "@/lib/session";
import { runImport, type ImportSummary } from "@/lib/import-core";
import { authorize } from "@/lib/authz";
import { lookupTag } from "@/lib/cached-lookups";
import { withTenant } from "@/lib/db";
import { assertNotReferenced } from "@/lib/master-refs";
import { audit } from "@/lib/audit";
import { actionError, zodError, type ActionResult } from "../_lib/util";

const schema = z.object({
  id: z.string().optional(),
  name: z.string().trim().min(1, "Name is required"),
  gstCode: z.string().trim().optional().default(""),
});

export async function saveState(input: unknown): Promise<ActionResult> {
  const session = requireSession();
  const parsed = schema.safeParse(input);
  if (!parsed.success) return zodError(parsed.error);
  const data = parsed.data;
  await authorize(session, "masters", data.id ? "edit" : "create");
  try {
    const id = await withTenant(session.tenantId, async (tx) => {
      const values = { name: data.name.toUpperCase(), gstCode: data.gstCode };
      if (data.id) {
        const before = await tx.state.findUniqueOrThrow({ where: { id: data.id } });
        const row = await tx.state.update({ where: { id: data.id }, data: values });
        await audit(tx, session, { entity: "State", entityId: row.id, action: "UPDATE", before, after: row });
        return row.id;
      }
      const row = await tx.state.create({ data: { tenantId: session.tenantId, ...values } });
      await audit(tx, session, { entity: "State", entityId: row.id, action: "CREATE", after: row });
      return row.id;
    });
    revalidatePath("/masters/states");
    revalidateTag(lookupTag.cities(session.tenantId));
    return { ok: true, id };
  } catch (e) {
    return actionError(e);
  }
}

export async function deleteState(id: string): Promise<ActionResult> {
  const session = requireSession();
  await authorize(session, "masters", "delete");
  try {
    await withTenant(session.tenantId, async (tx) => {
      const before = await tx.state.findUniqueOrThrow({ where: { id } });
      await assertNotReferenced(tx, "state", { id });
      await tx.state.delete({ where: { id } });
      await audit(tx, session, { entity: "State", entityId: id, action: "DELETE", before });
    });
    revalidatePath("/masters/states");
    revalidateTag(lookupTag.cities(session.tenantId));
    return { ok: true, id };
  } catch (e) {
    return actionError(e);
  }
}

/** Excel/CSV import — see the sample template for expected columns. */
export async function importStates(formData: FormData): Promise<ImportSummary> {
  const session = requireSession();
  await authorize(session, "masters", "create");
  const file = formData.get("file");
  const summary = await withTenant(session.tenantId, async (tx) =>
    runImport(file instanceof File ? file : null, ["STATE"], async (rec) => {
      const name = rec["STATE"].toUpperCase();
      if (!name) throw new Error("State name is required");
      const existing = await tx.state.findFirst({ where: { name } });
      if (existing) {
        await tx.state.update({ where: { id: existing.id }, data: { gstCode: rec["GST CODE"] || existing.gstCode } });
        return "updated";
      }
      await tx.state.create({ data: { tenantId: session.tenantId, name, gstCode: rec["GST CODE"] || "" } });
      return "created";
    })
  );
  revalidateTag(lookupTag.cities(session.tenantId));
  return summary;
}
