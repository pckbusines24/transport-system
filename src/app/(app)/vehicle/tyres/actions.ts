"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { requireSession } from "@/lib/session";
import { withTenant } from "@/lib/db";
import { authorize } from "@/lib/authz";
import { audit } from "@/lib/audit";
import { toNum } from "@/lib/utils";

/**
 * Tyre Life Management. A tyre is a permanent identity (unique Tyre Number);
 * its life is a chain of installation cycles. Transfers close the running
 * cycle (reason TRANSFER) and open a new one on the next vehicle; removal
 * closes the running cycle and marks the tyre REMOVED. History is never
 * deleted — every cycle stays linked to the same tyre number.
 */

const REVALIDATE = "/vehicle/tyres";

function toDate(s: string): Date {
  return new Date(s.includes("T") ? s : `${s}T00:00:00`);
}

// ---------------------------------------------------------------- create

const newTyreSchema = z.object({
  entryDate: z.string().min(1, "Entry date is required"),
  vehicleId: z.string().min(1, "Vehicle is required"),
  tyreName: z.string().trim().min(1, "Tyre name is required"),
  tyreNo: z.string().trim().min(1, "Tyre number is required"),
  position: z.enum(["HORSE", "TRAILER"]),
  instDate: z.string().min(1, "Installation date is required"),
  instKm: z.number().min(0, "Installation KM is required"),
  remarks: z.string().nullish(),
});

export async function createTyre(
  input: unknown
): Promise<{ ok: true; id: string } | { ok: false; error: string }> {
  const session = requireSession();
  const parsed = newTyreSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid input" };
  const d = parsed.data;
  await authorize(session, "tyre", "create");

  try {
    return await withTenant(session.tenantId, async (tx) => {
      const tyreNo = d.tyreNo.toUpperCase().replace(/\s+/g, "");
      const dup = await tx.tyre.findFirst({
        where: { firmId: session.firmId, tyreNo },
        select: { id: true },
      });
      if (dup) {
        return {
          ok: false as const,
          error: `Tyre number ${tyreNo} already exists — tyre numbers are unique. Use Transfer to move it to another vehicle.`,
        };
      }
      const tyre = await tx.tyre.create({
        data: {
          tenantId: session.tenantId,
          firmId: session.firmId,
          tyreNo,
          tyreName: d.tyreName,
          createdById: session.userId,
          cycles: {
            create: {
              tenantId: session.tenantId,
              vehicleId: d.vehicleId,
              position: d.position,
              entryDate: toDate(d.entryDate),
              instDate: toDate(d.instDate),
              instKm: d.instKm,
              remarks: d.remarks || null,
            },
          },
        },
      });
      await audit(tx, session, { entity: "Tyre", entityId: tyre.id, action: "CREATE", after: tyre });
      revalidatePath(REVALIDATE);
      return { ok: true as const, id: tyre.id };
    });
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Save failed" };
  }
}

// ---------------------------------------------------------------- transfer

const transferSchema = z.object({
  tyreId: z.string().min(1),
  changeDate: z.string().min(1, "Change date is required"),
  oldKm: z.number().min(0, "Old vehicle KM is required"),
  newVehicleId: z.string().min(1, "New vehicle is required"),
  newInstKm: z.number().min(0, "New vehicle installation KM is required"),
  position: z.enum(["HORSE", "TRAILER"]),
  remarks: z.string().nullish(),
});

export async function transferTyre(
  input: unknown
): Promise<{ ok: true } | { ok: false; error: string }> {
  const session = requireSession();
  const parsed = transferSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid input" };
  const d = parsed.data;
  await authorize(session, "tyre", "edit");

  try {
    return await withTenant(session.tenantId, async (tx) => {
      const tyre = await tx.tyre.findFirst({
        where: { id: d.tyreId, firmId: session.firmId },
        include: { cycles: { where: { removalDate: null } } },
      });
      if (!tyre) return { ok: false as const, error: "Tyre not found" };
      if (tyre.status === "REMOVED" || !tyre.cycles.length) {
        return { ok: false as const, error: "Tyre is not running — nothing to transfer." };
      }
      const open = tyre.cycles[0];
      if (d.oldKm < toNum(String(open.instKm))) {
        return { ok: false as const, error: "Old vehicle KM cannot be less than its installation KM." };
      }
      if (open.vehicleId === d.newVehicleId) {
        return { ok: false as const, error: "New vehicle is the same as the current vehicle." };
      }
      const changeDate = toDate(d.changeDate);
      await tx.tyreCycle.update({
        where: { id: open.id },
        data: { removalDate: changeDate, removalKm: d.oldKm, removalReason: "TRANSFER" },
      });
      await tx.tyreCycle.create({
        data: {
          tenantId: session.tenantId,
          tyreId: tyre.id,
          vehicleId: d.newVehicleId,
          position: d.position,
          entryDate: changeDate,
          instDate: changeDate,
          instKm: d.newInstKm,
          remarks: d.remarks || null,
        },
      });
      await audit(tx, session, {
        entity: "Tyre",
        entityId: tyre.id,
        action: "UPDATE",
        after: { transfer: d },
      });
      revalidatePath(REVALIDATE);
      return { ok: true as const };
    });
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Transfer failed" };
  }
}

// ---------------------------------------------------------------- removal

const removalSchema = z.object({
  tyreId: z.string().min(1),
  removalDate: z.string().min(1, "Removal date is required"),
  removalKm: z.number().min(0, "Removal KM is required"),
  reason: z.string().nullish(),
  remarks: z.string().nullish(),
});

export async function removeTyre(
  input: unknown
): Promise<{ ok: true } | { ok: false; error: string }> {
  const session = requireSession();
  const parsed = removalSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid input" };
  const d = parsed.data;
  await authorize(session, "tyre", "edit");

  try {
    return await withTenant(session.tenantId, async (tx) => {
      const tyre = await tx.tyre.findFirst({
        where: { id: d.tyreId, firmId: session.firmId },
        include: { cycles: { where: { removalDate: null } } },
      });
      if (!tyre) return { ok: false as const, error: "Tyre not found" };
      if (tyre.status === "REMOVED" || !tyre.cycles.length) {
        return { ok: false as const, error: "Tyre is already removed." };
      }
      const open = tyre.cycles[0];
      if (d.removalKm < toNum(String(open.instKm))) {
        return { ok: false as const, error: "Removal KM cannot be less than the installation KM." };
      }
      await tx.tyreCycle.update({
        where: { id: open.id },
        data: {
          removalDate: toDate(d.removalDate),
          removalKm: d.removalKm,
          removalReason: d.reason || null,
          remarks: [open.remarks, d.remarks].filter(Boolean).join(" | ") || null,
        },
      });
      await tx.tyre.update({ where: { id: tyre.id }, data: { status: "REMOVED" } });
      await audit(tx, session, {
        entity: "Tyre",
        entityId: tyre.id,
        action: "UPDATE",
        after: { removal: d },
      });
      revalidatePath(REVALIDATE);
      return { ok: true as const };
    });
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Removal failed" };
  }
}

// ---------------------------------------------------------------- edit / delete

const editSchema = z.object({
  tyreId: z.string().min(1),
  tyreName: z.string().trim().min(1, "Tyre name is required"),
  tyreNo: z.string().trim().min(1, "Tyre number is required"),
  position: z.enum(["HORSE", "TRAILER"]).nullish(), // open cycle only
  instDate: z.string().nullish(),
  instKm: z.number().min(0).nullish(),
});

/** Edit tyre identity (name / number) and, when running, its open cycle. */
export async function updateTyre(
  input: unknown
): Promise<{ ok: true } | { ok: false; error: string }> {
  const session = requireSession();
  const parsed = editSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid input" };
  const d = parsed.data;
  await authorize(session, "tyre", "edit");
  try {
    return await withTenant(session.tenantId, async (tx) => {
      const tyre = await tx.tyre.findFirst({
        where: { id: d.tyreId, firmId: session.firmId },
        include: { cycles: { where: { removalDate: null } } },
      });
      if (!tyre) return { ok: false as const, error: "Tyre not found" };
      const tyreNo = d.tyreNo.toUpperCase().replace(/\s+/g, "");
      const dup = await tx.tyre.findFirst({
        where: { firmId: session.firmId, tyreNo, id: { not: tyre.id } },
        select: { id: true },
      });
      if (dup) return { ok: false as const, error: `Tyre number ${tyreNo} already exists.` };
      const updated = await tx.tyre.update({
        where: { id: tyre.id },
        data: { tyreNo, tyreName: d.tyreName },
      });
      const open = tyre.cycles[0];
      if (open) {
        await tx.tyreCycle.update({
          where: { id: open.id },
          data: {
            ...(d.position ? { position: d.position } : {}),
            ...(d.instDate ? { instDate: new Date(`${d.instDate}T00:00:00`) } : {}),
            ...(d.instKm != null && d.instKm > 0 ? { instKm: d.instKm } : {}),
          },
        });
      }
      await audit(tx, session, { entity: "Tyre", entityId: tyre.id, action: "UPDATE", before: tyre, after: updated });
      revalidatePath("/vehicle/tyres");
      return { ok: true as const };
    });
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Update failed" };
  }
}

/** Admin/Owner-only hard delete of a wrongly created tyre (cycles cascade). */
export async function deleteTyre(
  tyreId: string
): Promise<{ ok: true } | { ok: false; error: string }> {
  const session = requireSession();
  if (session.role !== "ADMIN" && session.role !== "OWNER") {
    return { ok: false, error: "Only Admin/Owner may delete tyres" };
  }
  await authorize(session, "tyre", "delete");
  try {
    await withTenant(session.tenantId, async (tx) => {
      const before = await tx.tyre.findFirstOrThrow({
        where: { id: tyreId, firmId: session.firmId },
        include: { cycles: true },
      });
      await tx.tyre.delete({ where: { id: tyreId } });
      await audit(tx, session, { entity: "Tyre", entityId: tyreId, action: "DELETE", before });
    });
    revalidatePath("/vehicle/tyres");
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Delete failed" };
  }
}
