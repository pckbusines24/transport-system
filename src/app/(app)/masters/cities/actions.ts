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
import { actionError, optStr, zodError, type ActionResult } from "../_lib/util";

const schema = z.object({
  id: z.string().optional(),
  name: z.string().trim().min(1, "Name is required"),
  stateId: z.string().min(1, "State is required"),
  district: optStr,
  pincode: optStr,
  stdCode: optStr,
});

export async function saveCity(input: unknown): Promise<ActionResult> {
  const session = requireSession();
  const parsed = schema.safeParse(input);
  if (!parsed.success) return zodError(parsed.error);
  const data = parsed.data;
  await authorize(session, "masters", data.id ? "edit" : "create");
  try {
    const id = await withTenant(session.tenantId, async (tx) => {
      const values = {
        name: data.name.toUpperCase(),
        stateId: data.stateId,
        district: data.district,
        pincode: data.pincode,
        stdCode: data.stdCode,
      };
      if (data.id) {
        const before = await tx.city.findUniqueOrThrow({ where: { id: data.id } });
        const row = await tx.city.update({ where: { id: data.id }, data: values });
        await audit(tx, session, { entity: "City", entityId: row.id, action: "UPDATE", before, after: row });
        return row.id;
      }
      const row = await tx.city.create({ data: { tenantId: session.tenantId, ...values } });
      await audit(tx, session, { entity: "City", entityId: row.id, action: "CREATE", after: row });
      return row.id;
    });
    revalidatePath("/masters/cities");
    revalidateTag(lookupTag.cities(session.tenantId));
    return { ok: true, id };
  } catch (e) {
    return actionError(e);
  }
}

export async function deleteCity(id: string): Promise<ActionResult> {
  const session = requireSession();
  await authorize(session, "masters", "delete");
  try {
    await withTenant(session.tenantId, async (tx) => {
      const before = await tx.city.findUniqueOrThrow({ where: { id } });
      await assertNotReferenced(tx, "city", { id });
      await tx.city.delete({ where: { id } });
      await audit(tx, session, { entity: "City", entityId: id, action: "DELETE", before });
    });
    revalidatePath("/masters/cities");
    revalidateTag(lookupTag.cities(session.tenantId));
    return { ok: true, id };
  } catch (e) {
    return actionError(e);
  }
}

/** Excel/CSV import — see the sample template for expected columns. */
export async function importCities(formData: FormData): Promise<ImportSummary> {
  const session = requireSession();
  await authorize(session, "masters", "create");
  const file = formData.get("file");
  const summary = await withTenant(session.tenantId, async (tx) =>
    runImport(file instanceof File ? file : null, ["CITY", "STATE"], async (rec) => {
      const name = rec["CITY"].toUpperCase();
      if (!name) throw new Error("City name is required");
      const state = await tx.state.findFirst({ where: { name: { equals: rec["STATE"], mode: "insensitive" } } });
      if (!state) throw new Error(`state "${rec["STATE"]}" not found in State master`);
      const values = {
        district: rec["DISTRICT"] || null,
        pincode: rec["PINCODE"] || null,
        stdCode: rec["STD CODE"] || null,
      };
      const existing = await tx.city.findFirst({ where: { name, stateId: state.id } });
      if (existing) {
        await tx.city.update({ where: { id: existing.id }, data: values });
        return "updated";
      }
      await tx.city.create({ data: { tenantId: session.tenantId, name, stateId: state.id, ...values } });
      return "created";
    })
  );
  revalidateTag(lookupTag.cities(session.tenantId));
  return summary;
}
