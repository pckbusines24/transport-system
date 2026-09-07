"use server";

import { revalidatePath, revalidateTag } from "next/cache";
import { z } from "zod";
import { requireSession } from "@/lib/session";
import { runImport, num as importNum, enumKey, type ImportSummary } from "@/lib/import-core";
import { authorize } from "@/lib/authz";
import { lookupTag } from "@/lib/cached-lookups";
import { withTenant } from "@/lib/db";
import { assertNotReferenced } from "@/lib/master-refs";
import { audit } from "@/lib/audit";
import { actionError, optStr, zodError, type ActionResult } from "../_lib/util";

const schema = z.object({
  id: z.string().optional(),
  groupId: z.string().min(1, "Group is required"),
  name: z.string().trim().min(1, "Name is required"),
  unit: z.string().trim().min(1, "Unit is required — select one from the Unit Master"),
  hsnCode: optStr,
  productType: z.enum(["NORMAL", "ODC"]).default("NORMAL"),
  gstPct: z.coerce.number().min(0).max(100).default(0),
  type: optStr,
  className: optStr,
  division: optStr,
});

export async function saveProduct(input: unknown): Promise<ActionResult> {
  const session = requireSession();
  const parsed = schema.safeParse(input);
  if (!parsed.success) return zodError(parsed.error);
  const data = parsed.data;
  await authorize(session, "masters", data.id ? "edit" : "create");
  try {
    const id = await withTenant(session.tenantId, async (tx) => {
      const unit = await tx.unit.findFirst({
        where: { name: { equals: data.unit, mode: "insensitive" } },
      });
      if (!unit) throw new Error(`Unit "${data.unit}" is not in the Unit Master`);
      const values = {
        groupId: data.groupId,
        name: data.name.toUpperCase(),
        unit: unit.name,
        hsnCode: data.hsnCode,
        productType: data.productType,
        gstPct: data.gstPct,
        type: data.type,
        className: data.className,
        division: data.division,
      };
      if (data.id) {
        const before = await tx.product.findUniqueOrThrow({ where: { id: data.id } });
        const row = await tx.product.update({ where: { id: data.id }, data: values });
        await audit(tx, session, { entity: "Product", entityId: row.id, action: "UPDATE", before, after: row });
        return row.id;
      }
      const row = await tx.product.create({ data: { tenantId: session.tenantId, ...values } });
      await audit(tx, session, { entity: "Product", entityId: row.id, action: "CREATE", after: row });
      return row.id;
    });
    revalidatePath("/masters/products");
    revalidateTag(lookupTag.products(session.tenantId));
    return { ok: true, id };
  } catch (e) {
    return actionError(e);
  }
}

export async function deleteProduct(id: string): Promise<ActionResult> {
  const session = requireSession();
  await authorize(session, "masters", "delete");
  try {
    await withTenant(session.tenantId, async (tx) => {
      const before = await tx.product.findUniqueOrThrow({ where: { id } });
      await assertNotReferenced(tx, "product", { id });
      await tx.product.delete({ where: { id } });
      await audit(tx, session, { entity: "Product", entityId: id, action: "DELETE", before });
    });
    revalidatePath("/masters/products");
    revalidateTag(lookupTag.products(session.tenantId));
    return { ok: true, id };
  } catch (e) {
    return actionError(e);
  }
}

/** Excel/CSV import — see the sample template for expected columns. */
export async function importProducts(formData: FormData): Promise<ImportSummary> {
  const session = requireSession();
  await authorize(session, "masters", "create");
  const file = formData.get("file");
  const summary = await withTenant(session.tenantId, async (tx) =>
    runImport(file instanceof File ? file : null, ["PRODUCT"], async (rec) => {
      const name = rec["PRODUCT"].toUpperCase();
      if (!name) throw new Error("Product name is required");
      const groupName = (rec["GROUP"] || "GENERAL").toUpperCase();
      const group = await tx.productGroup.upsert({
        where: { tenantId_name: { tenantId: session.tenantId, name: groupName } },
        create: { tenantId: session.tenantId, name: groupName },
        update: {},
      });
      const productType = enumKey(rec["PRODUCT TYPE"]) === "ODC" ? "ODC" : "NORMAL";
      const unitName = rec["UNIT"]?.trim();
      if (!unitName) throw new Error("Unit is required (must exist in the Unit Master)");
      const unit = await tx.unit.findFirst({
        where: { name: { equals: unitName, mode: "insensitive" } },
      });
      if (!unit) throw new Error(`unit "${unitName}" is not in the Unit Master`);
      const values = {
        groupId: group.id,
        unit: unit.name,
        hsnCode: rec["HSN CODE"] || null,
        gstPct: importNum(rec["GST %"]),
        productType,
      };
      const existing = await tx.product.findFirst({ where: { name } });
      if (existing) {
        await tx.product.update({ where: { id: existing.id }, data: values });
        return "updated";
      }
      await tx.product.create({ data: { tenantId: session.tenantId, name, ...values } });
      return "created";
    })
  );
  revalidateTag(lookupTag.products(session.tenantId));
  return summary;
}
