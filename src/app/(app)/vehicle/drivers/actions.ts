"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { requireSession } from "@/lib/session";
import { withTenant, type Tx } from "@/lib/db";
import { authorize } from "@/lib/authz";
import { audit } from "@/lib/audit";

/**
 * Driver Master — profile + fixed document slots + extra documents + vehicle
 * assignment history (transfers never overwrite; the old assignment is closed
 * and a new one opened) + exit. Each driver gets a linked Party (ledgerGroup
 * DRIVER) so advances / settlements / salary post to the normal ledger.
 */

const REVALIDATE = "/masters/drivers";

function toDate(s: string): Date {
  return new Date(s.includes("T") ? s : `${s}T00:00:00`);
}

async function nextDriverCode(tx: Tx, firmId: string): Promise<string> {
  const rows = await tx.$queryRaw<{ max: bigint | null }[]>`
    SELECT MAX(NULLIF(regexp_replace("driverCode", '\\D', '', 'g'), '')::bigint) AS max
    FROM "Driver" WHERE "firmId" = ${firmId}`;
  const max = rows[0]?.max ? Number(rows[0].max) : 0;
  return `DRV-${String(max + 1).padStart(4, "0")}`;
}

const docSlot = z.object({ path: z.string().nullish(), name: z.string().nullish() });

const driverSchema = z.object({
  id: z.string().nullish(),
  name: z.string().trim().min(1, "Driver name is required"),
  /** existing DRIVER-group ledger to link; blank auto-creates one */
  partyId: z.string().nullish(),
  mobile: z.string().nullish(),
  emergencyContact: z.string().nullish(),
  address: z.string().nullish(),
  joinDate: z.string().nullish(),
  remarks: z.string().nullish(),
  vehicleId: z.string().nullish(), // initial assignment (create only)
  licence: docSlot.nullish(),
  aadhaar: docSlot.nullish(),
  pan: docSlot.nullish(),
  photo: docSlot.nullish(),
  medical: docSlot.nullish(),
  police: docSlot.nullish(),
  otherDocs: z
    .array(z.object({ title: z.string().min(1), path: z.string().min(1), name: z.string().min(1) }))
    .default([]),
});

export async function saveDriver(
  input: unknown
): Promise<{ ok: true; id: string; driverCode: string } | { ok: false; error: string }> {
  const session = requireSession();
  const parsed = driverSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid input" };
  const d = parsed.data;
  await authorize(session, "driver", d.id ? "edit" : "create");

  try {
    return await withTenant(session.tenantId, async (tx) => {
      const slot = (s: { path?: string | null; name?: string | null } | null | undefined) => ({
        path: s?.path || null,
        name: s?.name || null,
      });
      const values = {
        name: d.name,
        mobile: d.mobile || null,
        emergencyContact: d.emergencyContact || null,
        address: d.address || null,
        joinDate: d.joinDate ? toDate(d.joinDate) : null,
        remarks: d.remarks || null,
        licencePath: slot(d.licence).path,
        licenceName: slot(d.licence).name,
        aadhaarPath: slot(d.aadhaar).path,
        aadhaarName: slot(d.aadhaar).name,
        panPath: slot(d.pan).path,
        panName: slot(d.pan).name,
        photoPath: slot(d.photo).path,
        photoName: slot(d.photo).name,
        medicalPath: slot(d.medical).path,
        medicalName: slot(d.medical).name,
        policePath: slot(d.police).path,
        policeName: slot(d.police).name,
      };

      // The driver's ledger is a DRIVER-group party. The user may pick an
      // existing one (or create one inline, which lands in the Ledger Master
      // under the Driver group); leaving it blank auto-creates one as before.
      // Either way the two stay in step from here on.
      const pickedParty = d.partyId
        ? await tx.party.findFirst({ where: { id: d.partyId } })
        : null;
      if (d.partyId && !pickedParty) return { ok: false as const, error: "Driver ledger not found" };
      if (pickedParty && pickedParty.ledgerGroup !== "DRIVER") {
        return { ok: false as const, error: "Selected ledger is not in the Driver group" };
      }
      if (pickedParty) {
        // one ledger belongs to one driver, else advances/settlements collide
        const clash = await tx.driver.findFirst({
          where: { partyId: pickedParty.id, deletedAt: null, ...(d.id ? { id: { not: d.id } } : {}) },
        });
        if (clash) {
          return {
            ok: false as const,
            error: `Ledger "${pickedParty.name}" is already linked to driver ${clash.name} (${clash.driverCode})`,
          };
        }
      }

      let id: string;
      let driverCode: string;
      if (d.id) {
        const before = await tx.driver.findFirstOrThrow({ where: { id: d.id, deletedAt: null } });
        const partyId = pickedParty?.id ?? before.partyId;
        const updated = await tx.driver.update({
          where: { id: d.id },
          data: { ...values, partyId },
        });
        // keep the linked ledger in sync with the driver's own details
        if (partyId) {
          await tx.party.update({
            where: { id: partyId },
            data: { name: d.name, mobile: d.mobile || null },
          });
        }
        id = updated.id;
        driverCode = updated.driverCode;
        await audit(tx, session, { entity: "Driver", entityId: id, action: "UPDATE", before, after: updated });
      } else {
        driverCode = await nextDriverCode(tx, session.firmId);
        // ledger party so advances / settlements / salary hit real ledgers
        const party =
          pickedParty ??
          (await tx.party.create({
            data: {
              tenantId: session.tenantId,
              name: d.name,
              ledgerGroup: "DRIVER",
              mobile: d.mobile || null,
            },
          }));
        const created = await tx.driver.create({
          data: {
            tenantId: session.tenantId,
            firmId: session.firmId,
            driverCode,
            partyId: party.id,
            createdById: session.userId,
            ...values,
          },
        });
        id = created.id;
        if (d.vehicleId) {
          await tx.driverAssignment.create({
            data: {
              tenantId: session.tenantId,
              driverId: id,
              vehicleId: d.vehicleId,
              fromDate: values.joinDate ?? new Date(),
              remarks: "Initial assignment",
            },
          });
        }
        await audit(tx, session, { entity: "Driver", entityId: id, action: "CREATE", after: created });
      }
      await tx.driverDocument.deleteMany({ where: { driverId: id } });
      if (d.otherDocs.length) {
        await tx.driverDocument.createMany({
          data: d.otherDocs.map((o) => ({
            tenantId: session.tenantId,
            driverId: id,
            title: o.title,
            filePath: o.path,
            fileName: o.name,
          })),
        });
      }
      revalidatePath(REVALIDATE);
      return { ok: true as const, id, driverCode };
    });
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Save failed" };
  }
}

// ---------------------------------------------------------------- transfer

const transferSchema = z.object({
  driverId: z.string().min(1),
  changeDate: z.string().min(1, "Change date is required"),
  newVehicleId: z.string().min(1, "New vehicle is required"),
  reason: z.string().nullish(),
  remarks: z.string().nullish(),
});

export async function transferDriver(
  input: unknown
): Promise<{ ok: true } | { ok: false; error: string }> {
  const session = requireSession();
  const parsed = transferSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid input" };
  const d = parsed.data;
  await authorize(session, "driver", "edit");
  try {
    await withTenant(session.tenantId, async (tx) => {
      const driver = await tx.driver.findFirstOrThrow({ where: { id: d.driverId, deletedAt: null } });
      const changeDate = toDate(d.changeDate);
      const open = await tx.driverAssignment.findFirst({
        where: { driverId: d.driverId, toDate: null },
        orderBy: { fromDate: "desc" },
      });
      if (open) {
        if (open.vehicleId === d.newVehicleId) throw new Error("Driver is already on this vehicle.");
        await tx.driverAssignment.update({
          where: { id: open.id },
          data: { toDate: changeDate, reason: d.reason || null },
        });
      }
      await tx.driverAssignment.create({
        data: {
          tenantId: session.tenantId,
          driverId: d.driverId,
          vehicleId: d.newVehicleId,
          fromDate: changeDate,
          remarks: d.remarks || null,
        },
      });
      await audit(tx, session, {
        entity: "Driver",
        entityId: driver.id,
        action: "UPDATE",
        after: { transfer: d },
      });
    });
    revalidatePath(REVALIDATE);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Transfer failed" };
  }
}

// ---------------------------------------------------------------- exit / reactivate

const exitSchema = z.object({
  driverId: z.string().min(1),
  exitDate: z.string().min(1, "Exit date is required"),
  exitReason: z.string().nullish(),
  remarks: z.string().nullish(),
});

export async function exitDriver(
  input: unknown
): Promise<{ ok: true } | { ok: false; error: string }> {
  const session = requireSession();
  const parsed = exitSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid input" };
  const d = parsed.data;
  await authorize(session, "driver", "edit");
  try {
    await withTenant(session.tenantId, async (tx) => {
      const exitDate = toDate(d.exitDate);
      const driver = await tx.driver.update({
        where: { id: d.driverId },
        data: {
          exitDate,
          exitReason: d.exitReason || null,
          status: "INACTIVE",
          remarks: d.remarks || undefined,
        },
      });
      // close any open assignment
      await tx.driverAssignment.updateMany({
        where: { driverId: d.driverId, toDate: null },
        data: { toDate: exitDate, reason: d.exitReason || "EXIT" },
      });
      await audit(tx, session, {
        entity: "Driver",
        entityId: driver.id,
        action: "UPDATE",
        after: { exit: d },
      });
    });
    revalidatePath(REVALIDATE);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Exit failed" };
  }
}

export async function reactivateDriver(
  driverId: string
): Promise<{ ok: true } | { ok: false; error: string }> {
  const session = requireSession();
  await authorize(session, "driver", "edit");
  try {
    await withTenant(session.tenantId, async (tx) => {
      await tx.driver.update({
        where: { id: driverId },
        data: { status: "ACTIVE", exitDate: null, exitReason: null },
      });
    });
    revalidatePath(REVALIDATE);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Update failed" };
  }
}

/**
 * Admin/Owner-only delete (soft). Blocked while the driver is referenced by
 * advances, settlements, salaries or trip sheets — those must go first.
 */
export async function deleteDriver(
  driverId: string
): Promise<{ ok: true } | { ok: false; error: string }> {
  const session = requireSession();
  if (session.role !== "ADMIN" && session.role !== "OWNER") {
    return { ok: false, error: "Only Admin/Owner may delete drivers" };
  }
  await authorize(session, "driver", "delete");
  try {
    return await withTenant(session.tenantId, async (tx) => {
      const before = await tx.driver.findFirst({ where: { id: driverId, deletedAt: null } });
      if (!before) return { ok: false as const, error: "Driver not found" };
      const [advances, settlements, salaries, trips] = await Promise.all([
        tx.driverAdvance.count({ where: { driverId, deletedAt: null } }),
        tx.driverSettlement.count({ where: { driverId, deletedAt: null } }),
        tx.driverSalary.count({ where: { driverId, deletedAt: null } }),
        tx.trip.count({ where: { driverId, deletedAt: null } }),
      ]);
      const refs = [
        advances && `${advances} advance(s)`,
        settlements && `${settlements} settlement(s)`,
        salaries && `${salaries} salary record(s)`,
        trips && `${trips} trip sheet(s)`,
      ].filter(Boolean);
      if (refs.length) {
        return {
          ok: false as const,
          error: `Driver is referenced by ${refs.join(", ")} — delete or reassign those first.`,
        };
      }
      await tx.driver.update({ where: { id: driverId }, data: { deletedAt: new Date() } });
      await audit(tx, session, { entity: "Driver", entityId: driverId, action: "DELETE", before });
      revalidatePath(REVALIDATE);
      return { ok: true as const };
    });
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Delete failed" };
  }
}
