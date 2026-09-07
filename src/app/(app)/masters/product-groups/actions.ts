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
});

export async function saveProductGroup(input: unknown): Promise<ActionResult> {
  const session = requireSession();
  const parsed = schema.safeParse(input);
  if (!parsed.success) return zodError(parsed.error);
  const data = parsed.data;
  await authorize(session, "masters", data.id ? "edit" : "create");
  try {
    const id = await withTenant(session.tenantId, async (tx) => {
      if (data.id) {
        const before = await tx.productGroup.findUniqueOrThrow({ where: { id: data.id } });
        const row = await tx.productGroup.update({ where: { id: data.id }, data: { name: data.name } });
        await audit(tx, session, { entity: "ProductGroup", entityId: row.id, action: "UPDATE", before, after: row });
        return row.id;
      }
      const row = await tx.productGroup.create({ data: { tenantId: session.tenantId, name: data.name } });
      await audit(tx, session, { entity: "ProductGroup", entityId: row.id, action: "CREATE", after: row });
      return row.id;
    });
    revalidatePath("/masters/product-groups");
    revalidateTag(lookupTag.products(session.tenantId));
    return { ok: true, id };
  } catch (e) {
    return actionError(e);
  }
}

export async function deleteProductGroup(id: string): Promise<ActionResult> {
  const session = requireSession();
  await authorize(session, "masters", "delete");
  try {
    await withTenant(session.tenantId, async (tx) => {
      const before = await tx.productGroup.findUniqueOrThrow({ where: { id } });
      await assertNotReferenced(tx, "productGroup", { id });
      await tx.productGroup.delete({ where: { id } });
      await audit(tx, session, { entity: "ProductGroup", entityId: id, action: "DELETE", before });
    });
    revalidatePath("/masters/product-groups");
    revalidateTag(lookupTag.products(session.tenantId));
    return { ok: true, id };
  } catch (e) {
    return actionError(e);
  }
}

/** Excel/CSV import — see the sample template for expected columns. */
export async function importProductGroups(formData: FormData): Promise<ImportSummary> {
  const session = requireSession();
  await authorize(session, "masters", "create");
  const file = formData.get("file");
  const summary = await withTenant(session.tenantId, async (tx) =>
    runImport(file instanceof File ? file : null, ["GROUP"], async (rec) => {
      const name = rec["GROUP"].toUpperCase();
      if (!name) throw new Error("Group name is required");
      const existing = await tx.productGroup.findFirst({ where: { name } });
      if (existing) return "skipped";
      await tx.productGroup.create({ data: { tenantId: session.tenantId, name } });
      return "created";
    })
  );
  revalidateTag(lookupTag.products(session.tenantId));
  return summary;
}
