"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { requireSession } from "@/lib/session";
import { withTenant, type Tx } from "@/lib/db";
import { authorize } from "@/lib/authz";
import { audit } from "@/lib/audit";
import { addMonths } from "@/lib/spare-parts";

/**
 * Spare Parts & Warranty Management — OPERATIONAL TRACKING ONLY.
 *
 * Nothing in this file posts to the ledger, creates a voucher, touches the
 * purchase register, stock value, P&L, balance sheet or the Tally export.
 * A part is a permanent identity (unique serial number) whose life is a chain
 * of events: Purchase → Installation → Removal / Replacement → Warranty Claim.
 * History is never deleted.
 */

const MODULE = "spareparts";
const REVALIDATE = ["/vehicle/spare-parts", "/dashboard", "/masters/vehicles"];

const revalidateAll = () => REVALIDATE.forEach((p) => revalidatePath(p));

function toDate(s: string): Date {
  return new Date(s.includes("T") ? s : `${s}T00:00:00`);
}

type Result = { ok: true; id: string } | { ok: false; error: string };

const fail = (e: unknown): Result => ({
  ok: false,
  error: e instanceof Error ? e.message : "Failed",
});

async function ownPart(tx: Tx, firmId: string, id: string) {
  const part = await tx.sparePart.findFirst({ where: { id, firmId, deletedAt: null } });
  if (!part) throw new Error("Spare part not found");
  return part;
}

// ---------------------------------------------------------------- master

const partSchema = z.object({
  id: z.string().optional(),
  name: z.string().trim().min(1, "Spare part name is required"),
  partNumber: z.string().trim().nullish(),
  serialNo: z.string().trim().min(1, "Unique serial number is required"),
  brand: z.string().trim().nullish(),
  model: z.string().trim().nullish(),
  supplierName: z.string().trim().nullish(),
  purchaseDate: z.string().nullish(),
  invoiceNo: z.string().trim().nullish(),
  purchaseRate: z.number().min(0).nullish(),
  warrantyApplicable: z.boolean().default(false),
  warrantyMonths: z.number().int().min(0).nullish(),
  warrantyStartDate: z.string().nullish(),
  remarks: z.string().nullish(),
});

export async function saveSparePart(input: unknown): Promise<Result> {
  const session = requireSession();
  const parsed = partSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid input" };
  const d = parsed.data;
  await authorize(session, MODULE, d.id ? "edit" : "create");

  try {
    const id = await withTenant(session.tenantId, async (tx) => {
      const serialNo = d.serialNo.toUpperCase().replace(/\s+/g, "");
      const dup = await tx.sparePart.findFirst({
        where: { firmId: session.firmId, serialNo, deletedAt: null, ...(d.id ? { id: { not: d.id } } : {}) },
        select: { id: true },
      });
      if (dup) throw new Error(`Serial number ${serialNo} already exists — every part has a unique serial number.`);

      // Warranty Start + Period = Expiry (auto)
      const warrantyStart = d.warrantyApplicable && d.warrantyStartDate ? toDate(d.warrantyStartDate) : null;
      const warrantyMonths = d.warrantyApplicable ? d.warrantyMonths ?? null : null;
      const warrantyExpiry =
        warrantyStart && warrantyMonths && warrantyMonths > 0 ? addMonths(warrantyStart, warrantyMonths) : null;
      if (d.warrantyApplicable && (!warrantyStart || !warrantyMonths)) {
        throw new Error("Warranty start date and warranty period are required when warranty is applicable.");
      }

      const values = {
        name: d.name.toUpperCase(),
        partNumber: d.partNumber ? d.partNumber.toUpperCase() : null,
        serialNo,
        brand: d.brand || null,
        model: d.model || null,
        supplierName: d.supplierName || null,
        purchaseDate: d.purchaseDate ? toDate(d.purchaseDate) : null,
        invoiceNo: d.invoiceNo || null,
        purchaseRate: d.purchaseRate ?? null, // information only
        warrantyApplicable: d.warrantyApplicable,
        warrantyMonths,
        warrantyStartDate: warrantyStart,
        warrantyExpiryDate: warrantyExpiry,
        remarks: d.remarks || null,
      };

      if (d.id) {
        const before = await ownPart(tx, session.firmId, d.id);
        const row = await tx.sparePart.update({ where: { id: d.id }, data: values });
        // a changed expiry re-arms the dashboard alert
        if ((before.warrantyExpiryDate?.getTime() ?? 0) !== (warrantyExpiry?.getTime() ?? 0)) {
          await tx.sparePart.update({ where: { id: d.id }, data: { warrantyReviewedAt: null } });
        }
        await audit(tx, session, { entity: "SparePart", entityId: row.id, action: "UPDATE", before, after: row });
        return row.id;
      }
      const row = await tx.sparePart.create({
        data: {
          tenantId: session.tenantId,
          firmId: session.firmId,
          ...values,
          status: "AVAILABLE",
          createdById: session.userId,
          events: {
            create: {
              tenantId: session.tenantId,
              type: "PURCHASE",
              date: values.purchaseDate ?? new Date(),
              workshop: values.supplierName,
              remarks: values.invoiceNo ? `Invoice ${values.invoiceNo}` : null,
              createdById: session.userId,
            },
          },
        },
      });
      await audit(tx, session, { entity: "SparePart", entityId: row.id, action: "CREATE", after: row });
      return row.id;
    });
    revalidateAll();
    return { ok: true, id };
  } catch (e) {
    return fail(e);
  }
}

/** Soft delete — only a part that is not installed anywhere. History stays. */
export async function deleteSparePart(id: string): Promise<Result> {
  const session = requireSession();
  await authorize(session, MODULE, "delete");
  try {
    await withTenant(session.tenantId, async (tx) => {
      const part = await ownPart(tx, session.firmId, id);
      if (part.status === "INSTALLED") {
        throw new Error("This part is installed in a vehicle — remove it from the vehicle first.");
      }
      const after = await tx.sparePart.update({ where: { id }, data: { deletedAt: new Date() } });
      await audit(tx, session, { entity: "SparePart", entityId: id, action: "DELETE", before: part, after });
    });
    revalidateAll();
    return { ok: true, id };
  } catch (e) {
    return fail(e);
  }
}

// ---------------------------------------------------------------- install / remove

const installSchema = z.object({
  partId: z.string().min(1),
  vehicleId: z.string().min(1, "Vehicle is required"),
  date: z.string().min(1, "Installation date is required"),
  km: z.number().min(0, "Vehicle KM reading is required"),
  workshop: z.string().trim().nullish(),
  remarks: z.string().nullish(),
});

async function installInto(
  tx: Tx,
  session: ReturnType<typeof requireSession>,
  d: z.infer<typeof installSchema>,
  relatedPartId?: string | null
) {
  const part = await ownPart(tx, session.firmId, d.partId);
  if (part.status === "INSTALLED") {
    throw new Error(`${part.serialNo} is already installed — remove it from its vehicle first.`);
  }
  const vehicle = await tx.vehicle.findFirst({ where: { id: d.vehicleId }, select: { id: true } });
  if (!vehicle) throw new Error("Vehicle not found");
  const date = toDate(d.date);
  const after = await tx.sparePart.update({
    where: { id: part.id },
    data: {
      status: "INSTALLED",
      currentVehicleId: d.vehicleId,
      installedOn: date,
      installKm: d.km,
      events: {
        create: {
          tenantId: session.tenantId,
          type: "INSTALL",
          date,
          vehicleId: d.vehicleId,
          kmReading: d.km,
          workshop: d.workshop || null,
          remarks: d.remarks || null,
          relatedPartId: relatedPartId ?? null,
          createdById: session.userId,
        },
      },
    },
  });
  await audit(tx, session, {
    entity: "SparePart",
    entityId: part.id,
    action: "UPDATE",
    before: part,
    after: { ...after, event: "INSTALL" },
  });
  return after;
}

export async function installSparePart(input: unknown): Promise<Result> {
  const session = requireSession();
  const parsed = installSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid input" };
  await authorize(session, MODULE, "edit");
  try {
    const row = await withTenant(session.tenantId, (tx) => installInto(tx, session, parsed.data));
    revalidateAll();
    return { ok: true, id: row.id };
  } catch (e) {
    return fail(e);
  }
}

const removeSchema = z.object({
  partId: z.string().min(1),
  date: z.string().min(1, "Removal date is required"),
  km: z.number().min(0).nullish(),
  workshop: z.string().trim().nullish(),
  remarks: z.string().nullish(),
  /** SCRAP = part is finished; STOCK = back to available stock */
  disposition: z.enum(["SCRAP", "STOCK"]).default("SCRAP"),
  /** another (available) part that goes into the same vehicle in its place */
  replacementPartId: z.string().nullish(),
});

/**
 * Remove a part from its vehicle, optionally installing a replacement in the
 * same vehicle on the same date / KM — the two events point at each other so
 * the replacement history reads in both directions.
 */
export async function removeSparePart(input: unknown): Promise<Result> {
  const session = requireSession();
  const parsed = removeSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid input" };
  const d = parsed.data;
  await authorize(session, MODULE, "edit");
  try {
    await withTenant(session.tenantId, async (tx) => {
      const part = await ownPart(tx, session.firmId, d.partId);
      if (part.status !== "INSTALLED" || !part.currentVehicleId) {
        throw new Error(`${part.serialNo} is not installed in any vehicle.`);
      }
      const vehicleId = part.currentVehicleId;
      const date = toDate(d.date);
      const after = await tx.sparePart.update({
        where: { id: part.id },
        data: {
          status: d.disposition === "STOCK" ? "AVAILABLE" : "REMOVED",
          currentVehicleId: null,
          installedOn: null,
          installKm: null,
          events: {
            create: {
              tenantId: session.tenantId,
              type: "REMOVE",
              date,
              vehicleId,
              kmReading: d.km ?? null,
              workshop: d.workshop || null,
              remarks: [d.disposition === "STOCK" ? "Returned to stock" : "Removed", d.remarks]
                .filter(Boolean)
                .join(" — "),
              relatedPartId: d.replacementPartId || null,
              createdById: session.userId,
            },
          },
        },
      });
      await audit(tx, session, {
        entity: "SparePart",
        entityId: part.id,
        action: "UPDATE",
        before: part,
        after: { ...after, event: "REMOVE" },
      });
      if (d.replacementPartId) {
        await installInto(
          tx,
          session,
          {
            partId: d.replacementPartId,
            vehicleId,
            date: d.date,
            km: d.km ?? 0,
            workshop: d.workshop,
            remarks: `Replaces ${part.serialNo}${d.remarks ? " — " + d.remarks : ""}`,
          },
          part.id
        );
      }
    });
    revalidateAll();
    return { ok: true, id: d.partId };
  } catch (e) {
    return fail(e);
  }
}

// ---------------------------------------------------------------- warranty

const claimSchema = z.object({
  partId: z.string().min(1),
  date: z.string().min(1, "Claim date is required"),
  claimStatus: z.enum(["OPEN", "APPROVED", "REJECTED", "REPLACED"]).default("OPEN"),
  remarks: z.string().nullish(),
  /** on REPLACED: the (available) part supplied under warranty */
  replacementPartId: z.string().nullish(),
  km: z.number().min(0).nullish(),
});

/**
 * Record a warranty claim. A REPLACED claim with a replacement part swaps the
 * parts in the vehicle (if the claimed part is installed) and files a
 * WARRANTY_REPLACEMENT event on both sides.
 */
export async function addWarrantyClaim(input: unknown): Promise<Result> {
  const session = requireSession();
  const parsed = claimSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid input" };
  const d = parsed.data;
  await authorize(session, MODULE, "edit");
  try {
    await withTenant(session.tenantId, async (tx) => {
      const part = await ownPart(tx, session.firmId, d.partId);
      if (!part.warrantyApplicable) throw new Error(`${part.serialNo} has no warranty.`);
      const date = toDate(d.date);
      await tx.sparePartEvent.create({
        data: {
          tenantId: session.tenantId,
          partId: part.id,
          type: "WARRANTY_CLAIM",
          date,
          vehicleId: part.currentVehicleId,
          kmReading: d.km ?? null,
          remarks: d.remarks || null,
          claimStatus: d.claimStatus,
          relatedPartId: d.replacementPartId || null,
          createdById: session.userId,
        },
      });
      if (d.claimStatus === "REPLACED" && d.replacementPartId) {
        const replacement = await ownPart(tx, session.firmId, d.replacementPartId);
        if (replacement.status === "INSTALLED") {
          throw new Error(`${replacement.serialNo} is already installed in a vehicle.`);
        }
        const vehicleId = part.currentVehicleId;
        // the claimed part leaves (to scrap) with a replacement event
        await tx.sparePart.update({
          where: { id: part.id },
          data: {
            status: "REMOVED",
            currentVehicleId: null,
            installedOn: null,
            installKm: null,
            events: {
              create: {
                tenantId: session.tenantId,
                type: "WARRANTY_REPLACEMENT",
                date,
                vehicleId,
                kmReading: d.km ?? null,
                remarks: `Replaced under warranty by ${replacement.serialNo}`,
                relatedPartId: replacement.id,
                createdById: session.userId,
              },
            },
          },
        });
        if (vehicleId) {
          await installInto(
            tx,
            session,
            {
              partId: replacement.id,
              vehicleId,
              date: d.date,
              km: d.km ?? 0,
              workshop: null,
              remarks: `Warranty replacement for ${part.serialNo}`,
            },
            part.id
          );
        } else {
          await tx.sparePartEvent.create({
            data: {
              tenantId: session.tenantId,
              partId: replacement.id,
              type: "WARRANTY_REPLACEMENT",
              date,
              remarks: `Supplied under warranty in place of ${part.serialNo}`,
              relatedPartId: part.id,
              createdById: session.userId,
            },
          });
        }
      }
      await audit(tx, session, {
        entity: "SparePart",
        entityId: part.id,
        action: "UPDATE",
        after: { warrantyClaim: d.claimStatus, replacementPartId: d.replacementPartId ?? null },
      });
    });
    revalidateAll();
    return { ok: true, id: d.partId };
  } catch (e) {
    return fail(e);
  }
}

/** Update the status / remarks of an existing claim (no replacement swap here). */
export async function updateWarrantyClaim(input: unknown): Promise<Result> {
  const session = requireSession();
  const parsed = z
    .object({
      eventId: z.string().min(1),
      claimStatus: z.enum(["OPEN", "APPROVED", "REJECTED", "REPLACED"]),
      remarks: z.string().nullish(),
    })
    .safeParse(input);
  if (!parsed.success) return { ok: false, error: "Invalid input" };
  const d = parsed.data;
  await authorize(session, MODULE, "edit");
  try {
    await withTenant(session.tenantId, async (tx) => {
      const ev = await tx.sparePartEvent.findFirst({
        where: { id: d.eventId, type: "WARRANTY_CLAIM", part: { firmId: session.firmId } },
      });
      if (!ev) throw new Error("Claim not found");
      await tx.sparePartEvent.update({
        where: { id: ev.id },
        data: { claimStatus: d.claimStatus, remarks: d.remarks ?? ev.remarks },
      });
    });
    revalidateAll();
    return { ok: true, id: d.eventId };
  } catch (e) {
    return fail(e);
  }
}

/** The 30-day alert stays on the dashboard until expiry or until marked reviewed. */
export async function markWarrantyReviewed(partId: string): Promise<Result> {
  const session = requireSession();
  await authorize(session, MODULE, "edit");
  try {
    await withTenant(session.tenantId, async (tx) => {
      const part = await ownPart(tx, session.firmId, partId);
      await tx.sparePart.update({
        where: { id: part.id },
        data: {
          warrantyReviewedAt: new Date(),
          events: {
            create: {
              tenantId: session.tenantId,
              type: "REVIEWED",
              date: new Date(),
              vehicleId: part.currentVehicleId,
              remarks: "Warranty expiry alert reviewed",
              createdById: session.userId,
            },
          },
        },
      });
    });
    revalidateAll();
    return { ok: true, id: partId };
  } catch (e) {
    return fail(e);
  }
}
