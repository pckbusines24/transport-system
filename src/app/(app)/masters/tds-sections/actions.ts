"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { requireSession } from "@/lib/session";
import { withTenant } from "@/lib/db";
import { assertNotReferenced } from "@/lib/master-refs";
import { authorize } from "@/lib/authz";
import { audit } from "@/lib/audit";

const REVALIDATE = "/masters/tds-sections";

const sectionSchema = z.object({
  id: z.string().nullish(),
  code: z.string().trim().min(1, "Section code is required"),
  oldCode: z.string().trim().nullish(),
  name: z.string().trim().min(1, "Name is required"),
  annualLimit: z.number().min(0),
  singleBillLimit: z.number().min(0),
  rateIndividual: z.number().min(0).max(100),
  rateCompany: z.number().min(0).max(100),
  basis: z.enum(["FULL", "EXCESS"]),
  headIds: z.array(z.string()),
  moduleRefs: z.array(z.enum(["CHALAN", "BROKER_SLIP", "HIRE"])),
});

export async function saveTdsSection(
  input: z.infer<typeof sectionSchema>
): Promise<{ ok: true } | { ok: false; error: string }> {
  const session = requireSession();
  await authorize(session, "masters", input.id ? "edit" : "create");
  const parsed = sectionSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: parsed.error.issues[0].message };
  const d = parsed.data;
  try {
    await withTenant(session.tenantId, async (tx) => {
      // a head may belong to only ONE section
      const others = await tx.tdsSection.findMany({
        where: { deletedAt: null, ...(d.id ? { id: { not: d.id } } : {}) },
        select: { code: true, headIds: true, moduleRefs: true },
      });
      const taken = new Map<string, string>();
      for (const o of others) for (const h of o.headIds) taken.set(h, o.code);
      const clash = d.headIds.find((h) => taken.has(h));
      if (clash) {
        const head = await tx.accountHead.findUnique({ where: { id: clash } });
        throw new Error(
          `Head "${head?.name ?? clash}" is already connected to section ${taken.get(clash)}`
        );
      }
      // a module (chalan / slip / hire) can be labelled by only one section too
      const takenModule = new Map<string, string>();
      for (const o of others) for (const m of o.moduleRefs) takenModule.set(m, o.code);
      const mClash = d.moduleRefs.find((m) => takenModule.has(m));
      if (mClash) {
        throw new Error(`Module "${mClash}" is already labelled by section ${takenModule.get(mClash)}`);
      }
      const data = {
        code: d.code,
        oldCode: d.oldCode || null,
        name: d.name,
        annualLimit: d.annualLimit,
        singleBillLimit: d.singleBillLimit,
        rateIndividual: d.rateIndividual,
        rateCompany: d.rateCompany,
        basis: d.basis,
        headIds: d.headIds,
        moduleRefs: d.moduleRefs,
      };
      if (d.id) {
        const before = await tx.tdsSection.findUniqueOrThrow({ where: { id: d.id } });
        const after = await tx.tdsSection.update({ where: { id: d.id }, data });
        await audit(tx, session, { entity: "TdsSection", entityId: d.id, action: "UPDATE", before, after });
      } else {
        const created = await tx.tdsSection.create({
          data: { tenantId: session.tenantId, ...data },
        });
        await audit(tx, session, { entity: "TdsSection", entityId: created.id, action: "CREATE", after: created });
      }
    });
    revalidatePath(REVALIDATE);
    revalidatePath("/dashboard");
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "Failed to save section" };
  }
}

export async function deleteTdsSection(
  id: string
): Promise<{ ok: true } | { ok: false; error: string }> {
  const session = requireSession();
  await authorize(session, "masters", "delete");
  try {
    await withTenant(session.tenantId, async (tx) => {
      const before = await tx.tdsSection.findUniqueOrThrow({ where: { id } });
      await assertNotReferenced(tx, "tdsSection", { id });
      await tx.tdsSection.update({ where: { id }, data: { deletedAt: new Date() } });
      await audit(tx, session, { entity: "TdsSection", entityId: id, action: "DELETE", before });
    });
    revalidatePath(REVALIDATE);
    revalidatePath("/dashboard");
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "Failed to delete section" };
  }
}
