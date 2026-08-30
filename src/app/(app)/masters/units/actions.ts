"use server";

import { revalidatePath, revalidateTag } from "next/cache";
import { z } from "zod";
import { requireSession } from "@/lib/session";
import { runImport, num as importNum, type ImportSummary } from "@/lib/import-core";
import { authorize } from "@/lib/authz";
import { lookupTag } from "@/lib/cached-lookups";
import { withTenant } from "@/lib/db";
import { audit } from "@/lib/audit";
import { actionError, zodError, type ActionResult } from "../_lib/util";

const schema = z.object({
  id: z.string().optional(),
  name: z.string().trim().min(1, "Name is required"),
  value: z.coerce.number().default(1),
});

export async function saveUnit(input: unknown): Promise<ActionResult> {
  const session = requireSession();
  const parsed = schema.safeParse(input);
  if (!parsed.success) return zodError(parsed.error);
  const data = parsed.data;
  await authorize(session, "masters", data.id ? "edit" : "create");
  try {
    const id = await withTenant(session.tenantId, async (tx) => {
      const values = { name: data.name.toUpperCase(), value: data.value };
      if (data.id) {
        const before = await tx.unit.findUniqueOrThrow({ where: { id: data.id } });
        const row = await tx.unit.update({ where: { id: data.id }, data: values });
        await audit(tx, session, { entity: "Unit", entityId: row.id, action: "UPDATE", before, after: row });
        return row.id;
      }
      const row = await tx.unit.create({ data: { tenantId: session.tenantId, ...values } });
      await audit(tx, session, { entity: "Unit", entityId: row.id, action: "CREATE", after: row });
      return row.id;
    });
    revalidatePath("/masters/units");
    revalidateTag(lookupTag.units(session.tenantId));
    return { ok: true, id };
  } catch (e) {
    return actionError(e);
  }
}

export async function deleteUnit(id: string): Promise<ActionResult> {
  const session = requireSession();
  await authorize(session, "masters", "delete");
  try {
    await withTenant(session.tenantId, async (tx) => {
      const before = await tx.unit.findUniqueOrThrow({ where: { id } });
      await tx.unit.delete({ where: { id } });
      await audit(tx, session, { entity: "Unit", entityId: id, action: "DELETE", before });
    });
    revalidatePath("/masters/units");
    revalidateTag(lookupTag.units(session.tenantId));
    return { ok: true, id };
  } catch (e) {
    return actionError(e);
  }
}

/** Excel/CSV import — see the sample template for expected columns. */
export async function importUnits(formData: FormData): Promise<ImportSummary> {
  const session = requireSession();
  await authorize(session, "masters", "create");
  const file = formData.get("file");
  const summary = await withTenant(session.tenantId, async (tx) =>
    runImport(file instanceof File ? file : null, ["UNIT"], async (rec) => {
      const name = rec["UNIT"].toUpperCase();
      if (!name) throw new Error("Unit name is required");
      const value = importNum(rec["VALUE"]) || 1;
      const existing = await tx.unit.findFirst({ where: { name } });
      if (existing) {
        await tx.unit.update({ where: { id: existing.id }, data: { value } });
        return "updated";
      }
      await tx.unit.create({ data: { tenantId: session.tenantId, name, value } });
      return "created";
    })
  );
  revalidateTag(lookupTag.units(session.tenantId));
  return summary;
}
