"use server";

import { revalidatePath, revalidateTag } from "next/cache";
import { z } from "zod";
import { requireSession } from "@/lib/session";
import { runImport, type ImportSummary } from "@/lib/import-core";
import { authorize } from "@/lib/authz";
import { lookupTag } from "@/lib/cached-lookups";
import { withTenant } from "@/lib/db";
import { audit } from "@/lib/audit";
import { revalidateOutstanding } from "@/lib/outstanding-cache";
import { actionError, optStr, zodError, type ActionResult } from "../_lib/util";

const schema = z
  .object({
    id: z.string().optional(),
    number: z.string().trim().min(1, "Vehicle number is required"),
    ownershipType: z.enum(["OWNER", "BROKER", "RELATIVE"]).default("BROKER"),
    isOwn: z.boolean().default(false),
    ownerId: z.string().optional().nullable(),
    ownerNames: optStr,
    chassisNo: optStr,
    engineNo: optStr,
    vehicleType: optStr,
    permitNo: optStr,
    insuranceNo: optStr,
  })
  // Own / Relative vehicles must name their owner (ledger & P&L attribution);
  // a broker vehicle may be saved without one — the chalan then asks for the
  // broker explicitly instead of prefilling it from the vehicle
  .refine((d) => d.ownershipType === "BROKER" || Boolean(d.ownerId), {
    message: "Select the owner / relative name",
    path: ["ownerId"],
  });

export async function saveVehicle(input: unknown): Promise<ActionResult> {
  const session = requireSession();
  const parsed = schema.safeParse(input);
  if (!parsed.success) return zodError(parsed.error);
  const data = parsed.data;
  await authorize(session, "masters", data.id ? "edit" : "create");
  try {
    const id = await withTenant(session.tenantId, async (tx) => {
      const values = {
        number: data.number.toUpperCase().replace(/\s+/g, ""),
        ownershipType: data.ownershipType,
        isOwn: data.ownershipType === "OWNER",
        ownerId: data.ownerId ?? null,
        ownerNames: data.ownerNames ?? null,
        chassisNo: data.chassisNo,
        engineNo: data.engineNo,
        vehicleType: data.vehicleType,
        permitNo: data.permitNo,
        insuranceNo: data.insuranceNo,
      };
      if (data.id) {
        const before = await tx.vehicle.findUniqueOrThrow({ where: { id: data.id } });
        const row = await tx.vehicle.update({ where: { id: data.id }, data: values });
        await audit(tx, session, { entity: "Vehicle", entityId: row.id, action: "UPDATE", before, after: row });
        return row.id;
      }
      const row = await tx.vehicle.create({ data: { tenantId: session.tenantId, ...values } });
      await audit(tx, session, { entity: "Vehicle", entityId: row.id, action: "CREATE", after: row });
      return row.id;
    });
    revalidatePath("/masters/vehicles");
    revalidateTag(lookupTag.vehicles(session.tenantId));
    revalidateOutstanding(session.tenantId);
    return { ok: true, id };
  } catch (e) {
    return actionError(e);
  }
}

/** Soft delete: mark inactive (vehicle may be referenced by documents). */
export async function deleteVehicle(id: string): Promise<ActionResult> {
  const session = requireSession();
  await authorize(session, "masters", "delete");
  try {
    await withTenant(session.tenantId, async (tx) => {
      const before = await tx.vehicle.findUniqueOrThrow({ where: { id } });
      const after = await tx.vehicle.update({ where: { id }, data: { isActive: false } });
      await audit(tx, session, { entity: "Vehicle", entityId: id, action: "DELETE", before, after });
    });
    revalidatePath("/masters/vehicles");
    revalidateTag(lookupTag.vehicles(session.tenantId));
    revalidateOutstanding(session.tenantId);
    return { ok: true, id };
  } catch (e) {
    return actionError(e);
  }
}

/** Excel/CSV import — see the sample template for expected columns. */
export async function importVehicles(formData: FormData): Promise<ImportSummary> {
  const session = requireSession();
  await authorize(session, "masters", "create");
  const file = formData.get("file");
  const summary = await withTenant(session.tenantId, async (tx) =>
    runImport(file instanceof File ? file : null, ["VEHICLE NO", "OWNERSHIP", "NAME"], async (rec) => {
      const number = rec["VEHICLE NO"].toUpperCase().replace(/\s+/g, "");
      if (!number) throw new Error("Vehicle number is required");
      const ownership = rec["OWNERSHIP"].toUpperCase();
      if (!["OWNER", "BROKER", "RELATIVE"].includes(ownership)) {
        throw new Error("Ownership must be OWNER, BROKER or RELATIVE");
      }
      // owners, brokers and relatives share one unified person list;
      // a BROKER vehicle may come in without a name
      const person = rec["NAME"]
        ? await tx.party.findFirst({
            where: {
              name: { equals: rec["NAME"], mode: "insensitive" },
              ledgerGroup: { in: ["OWNER_BROKER", "RELATIVE"] },
            },
          })
        : null;
      if (!person && (ownership !== "BROKER" || rec["NAME"])) {
        throw new Error(
          rec["NAME"]
            ? `"${rec["NAME"]}" not found in the owner / broker / relative list`
            : "Name is required for OWNER / RELATIVE vehicles"
        );
      }
      const values = {
        ownershipType: ownership,
        isOwn: ownership === "OWNER",
        ownerId: person?.id ?? null,
        vehicleType: rec["TYPE"] || null,
        chassisNo: rec["CHASSIS NO"]?.toUpperCase() || null,
        engineNo: rec["ENGINE NO"]?.toUpperCase() || null,
        permitNo: rec["PERMIT NO"] || null,
        insuranceNo: rec["INSURANCE NO"] || null,
      };
      const existing = await tx.vehicle.findFirst({ where: { number } });
      if (existing) {
        await tx.vehicle.update({ where: { id: existing.id }, data: values });
        return "updated";
      }
      await tx.vehicle.create({ data: { tenantId: session.tenantId, number, ...values } });
      return "created";
    })
  );
  revalidateTag(lookupTag.vehicles(session.tenantId));
  revalidateOutstanding(session.tenantId);
  return summary;
}
