"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { requireSession } from "@/lib/session";
import { withTenant } from "@/lib/db";
import { authorize } from "@/lib/authz";
import { audit } from "@/lib/audit";

/**
 * Extra Work Information — pure tracking of vehicle workshop jobs.
 * No ledger, no inventory, no financial side effects. Status is never stored:
 * completeDate set => COMPLETED, blank => PENDING.
 */

const REVALIDATE = "/vehicle/work";

const workSchema = z.object({
  id: z.string().nullish(),
  workDate: z.string().min(1, "Work date is required"),
  vehicleId: z.string().min(1, "Vehicle is required"),
  description: z.string().trim().min(1, "Work description is required"),
  supplier: z.string().nullish(),
  completeDate: z.string().nullish(),
  remarks: z.string().nullish(),
});

function toDate(s: string): Date {
  return new Date(s.includes("T") ? s : `${s}T00:00:00`);
}

export async function saveVehicleWork(
  input: unknown
): Promise<{ ok: true; id: string } | { ok: false; error: string }> {
  const session = requireSession();
  const parsed = workSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid input" };
  const d = parsed.data;
  await authorize(session, "work", d.id ? "edit" : "create");
  try {
    return await withTenant(session.tenantId, async (tx) => {
      const vehicle = await tx.vehicle.findFirst({ where: { id: d.vehicleId } });
      if (!vehicle) return { ok: false as const, error: "Vehicle not found in the Vehicle Master" };
      const values = {
        workDate: toDate(d.workDate),
        vehicleId: d.vehicleId,
        description: d.description.trim(),
        supplier: d.supplier?.trim() || null,
        completeDate: d.completeDate ? toDate(d.completeDate) : null,
        remarks: d.remarks?.trim() || null,
      };
      if (d.id) {
        const before = await tx.vehicleWork.findFirst({ where: { id: d.id, deletedAt: null } });
        if (!before) return { ok: false as const, error: "Work entry not found" };
        const after = await tx.vehicleWork.update({ where: { id: d.id }, data: values });
        await audit(tx, session, { entity: "VehicleWork", entityId: d.id, action: "UPDATE", before, after });
        revalidatePath(REVALIDATE);
        return { ok: true as const, id: d.id };
      }
      const created = await tx.vehicleWork.create({
        data: {
          tenantId: session.tenantId,
          firmId: session.firmId,
          fyId: session.fyId,
          createdById: session.userId,
          ...values,
        },
      });
      await audit(tx, session, { entity: "VehicleWork", entityId: created.id, action: "CREATE", after: created });
      revalidatePath(REVALIDATE);
      return { ok: true as const, id: created.id };
    });
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "Save failed" };
  }
}

export async function deleteVehicleWork(
  id: string
): Promise<{ ok: true } | { ok: false; error: string }> {
  const session = requireSession();
  await authorize(session, "work", "delete");
  try {
    await withTenant(session.tenantId, async (tx) => {
      const before = await tx.vehicleWork.findFirstOrThrow({ where: { id, deletedAt: null } });
      await tx.vehicleWork.update({ where: { id }, data: { deletedAt: new Date() } });
      await audit(tx, session, { entity: "VehicleWork", entityId: id, action: "DELETE", before });
    });
    revalidatePath(REVALIDATE);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "Delete failed" };
  }
}
