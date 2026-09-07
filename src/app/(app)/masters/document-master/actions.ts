"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { requireSession } from "@/lib/session";
import { runImport, num as importNum, type ImportSummary } from "@/lib/import-core";
import { authorize } from "@/lib/authz";
import { withTenant } from "@/lib/db";
import { assertNotReferenced } from "@/lib/master-refs";
import { audit } from "@/lib/audit";
import { actionError, optStr, zodError, type ActionResult } from "../_lib/util";

const schema = z.object({
  id: z.string().optional(),
  name: z.string().trim().min(1, "Name is required"),
  description: optStr,
  showReminder: z.boolean().default(true),
  reminderDays: z.coerce.number().int().min(1).max(365).default(30),
});

export async function saveDocumentType(input: unknown): Promise<ActionResult> {
  const session = requireSession();
  const parsed = schema.safeParse(input);
  if (!parsed.success) return zodError(parsed.error);
  const data = parsed.data;
  await authorize(session, "masters", data.id ? "edit" : "create");
  try {
    const id = await withTenant(session.tenantId, async (tx) => {
      const values = {
        name: data.name,
        description: data.description,
        showReminder: data.showReminder,
        reminderDays: data.reminderDays,
      };
      if (data.id) {
        const before = await tx.documentType.findUniqueOrThrow({ where: { id: data.id } });
        const row = await tx.documentType.update({ where: { id: data.id }, data: values });
        await audit(tx, session, { entity: "DocumentType", entityId: row.id, action: "UPDATE", before, after: row });
        return row.id;
      }
      const row = await tx.documentType.create({ data: { tenantId: session.tenantId, ...values } });
      await audit(tx, session, { entity: "DocumentType", entityId: row.id, action: "CREATE", after: row });
      return row.id;
    });
    revalidatePath("/masters/document-master");
    return { ok: true, id };
  } catch (e) {
    return actionError(e);
  }
}

export async function deleteDocumentType(id: string): Promise<ActionResult> {
  const session = requireSession();
  await authorize(session, "masters", "delete");
  try {
    await withTenant(session.tenantId, async (tx) => {
      const before = await tx.documentType.findUniqueOrThrow({ where: { id } });
      await assertNotReferenced(tx, "documentType", { id });
      await tx.documentType.delete({ where: { id } });
      await audit(tx, session, { entity: "DocumentType", entityId: id, action: "DELETE", before });
    });
    revalidatePath("/masters/document-master");
    return { ok: true, id };
  } catch (e) {
    return actionError(e);
  }
}

/** Excel/CSV import — see the sample template for expected columns. */
export async function importDocumentTypes(formData: FormData): Promise<ImportSummary> {
  const session = requireSession();
  await authorize(session, "masters", "create");
  const file = formData.get("file");
  return withTenant(session.tenantId, async (tx) =>
    runImport(file instanceof File ? file : null, ["NAME"], async (rec) => {
      const name = rec["NAME"].toUpperCase();
      if (!name) throw new Error("Document type name is required");
      const values = {
        description: rec["DESCRIPTION"] || null,
        reminderDays: importNum(rec["REMINDER DAYS"]) || 30,
      };
      const existing = await tx.documentType.findFirst({ where: { name } });
      if (existing) {
        await tx.documentType.update({ where: { id: existing.id }, data: values });
        return "updated";
      }
      await tx.documentType.create({ data: { tenantId: session.tenantId, name, ...values } });
      return "created";
    })
  );
}
