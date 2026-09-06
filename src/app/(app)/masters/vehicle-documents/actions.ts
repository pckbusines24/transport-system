"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { requireSession } from "@/lib/session";
import { runImport, enumKey, type ImportSummary } from "@/lib/import-core";
import { authorize } from "@/lib/authz";
import { withTenant } from "@/lib/db";
import { audit } from "@/lib/audit";
import { actionError, optStr, parseDateInput, zodError, type ActionResult } from "../_lib/util";

const schema = z.object({
  id: z.string().optional(),
  docTypeId: z.string().min(1, "Document type is required"),
  vehicleId: z.string().min(1, "Vehicle is required"),
  docNo: optStr,
  companyName: optStr,
  // renewal workflow: PENDING (not started) -> PROCESSING (with RTO/agent)
  // -> DONE; PROBLEM flags an issue and demands remarks
  status: z.enum(["DONE", "PENDING", "PROCESSING", "PROBLEM"]).default("DONE"),
  entryDate: z.string().min(1, "Entry date is required"),
  effectiveDate: optStr,
  expiryDate: optStr,
  remarks: optStr,
  filePath: optStr,
  fileName: optStr,
});

export async function saveVehicleDocument(input: unknown): Promise<ActionResult> {
  const session = requireSession();
  const parsed = schema.safeParse(input);
  if (!parsed.success) return zodError(parsed.error);
  const data = parsed.data;
  await authorize(session, "masters", data.id ? "edit" : "create");
  if (data.status === "PROBLEM" && !data.remarks?.trim()) {
    return { ok: false, error: "Remarks are required when the status is Problem — state the issue (e.g. Fitness Failed, RTO Query Pending)." };
  }
  const entryDate = parseDateInput(data.entryDate);
  if (!entryDate) return { ok: false, error: "Invalid entry date" };
  try {
    const id = await withTenant(session.tenantId, async (tx) => {
      const effectiveDate = parseDateInput(data.effectiveDate);
      // Document Master no longer carries a validity period, so the expiry date
      // is whatever the user entered on the document itself.
      const expiryDate = parseDateInput(data.expiryDate);
      const values = {
        docTypeId: data.docTypeId,
        vehicleId: data.vehicleId,
        docNo: data.docNo,
        companyName: data.companyName,
        status: data.status,
        entryDate,
        effectiveDate,
        expiryDate,
        remarks: data.remarks,
        filePath: data.filePath,
        fileName: data.fileName,
      };
      if (data.id) {
        const before = await tx.vehicleDocument.findUniqueOrThrow({ where: { id: data.id } });
        const row = await tx.vehicleDocument.update({ where: { id: data.id }, data: values });
        await audit(tx, session, { entity: "VehicleDocument", entityId: row.id, action: "UPDATE", before, after: row });
        return row.id;
      }
      const row = await tx.vehicleDocument.create({ data: { tenantId: session.tenantId, ...values } });
      await audit(tx, session, { entity: "VehicleDocument", entityId: row.id, action: "CREATE", after: row });
      return row.id;
    });
    revalidatePath("/masters/vehicle-documents");
    return { ok: true, id };
  } catch (e) {
    return actionError(e);
  }
}

/**
 * Bulk renewal-status update: every selected registration moves to the given
 * status in one click. PROBLEM demands remarks; the remarks land on each row
 * (individual edits can refine them later).
 */
export async function bulkSetVehicleDocStatus(input: {
  ids: string[];
  status: "PENDING" | "PROCESSING" | "PROBLEM" | "DONE";
  remarks?: string | null;
}): Promise<ActionResult> {
  const session = requireSession();
  await authorize(session, "masters", "edit");
  if (!input.ids?.length) return { ok: false, error: "Select at least one registration" };
  if (input.status === "PROBLEM" && !input.remarks?.trim()) {
    return { ok: false, error: "Remarks are required when the status is Problem." };
  }
  try {
    await withTenant(session.tenantId, async (tx) => {
      await tx.vehicleDocument.updateMany({
        where: { id: { in: input.ids } },
        data: {
          status: input.status,
          // NOTE: DONE never survives inside the reminder window — a real
          // renewal enters a NEW expiry date, which is what lets DONE stick
          ...(input.remarks?.trim() ? { remarks: input.remarks.trim() } : {}),
        },
      });
      await audit(tx, session, {
        entity: "VehicleDocument",
        entityId: input.ids.join(","),
        action: "UPDATE",
        after: { bulkStatus: input.status, count: input.ids.length },
      });
    });
    revalidatePath("/masters/vehicle-documents");
    return { ok: true, id: input.ids[0] };
  } catch (e) {
    return actionError(e);
  }
}

export async function deleteVehicleDocument(id: string): Promise<ActionResult> {
  const session = requireSession();
  await authorize(session, "masters", "delete");
  try {
    await withTenant(session.tenantId, async (tx) => {
      const before = await tx.vehicleDocument.findUniqueOrThrow({ where: { id } });
      await tx.vehicleDocument.delete({ where: { id } });
      await audit(tx, session, { entity: "VehicleDocument", entityId: id, action: "DELETE", before });
    });
    revalidatePath("/masters/vehicle-documents");
    return { ok: true, id };
  } catch (e) {
    return actionError(e);
  }
}

/** Excel/CSV import — see the sample template for expected columns. */
export async function importVehicleDocuments(formData: FormData): Promise<ImportSummary> {
  const session = requireSession();
  await authorize(session, "masters", "create");
  const file = formData.get("file");
  return withTenant(session.tenantId, async (tx) =>
    runImport(file instanceof File ? file : null, ["VEHICLE NO", "DOCUMENT TYPE", "ENTRY DATE"], async (rec) => {
      const vehicle = await tx.vehicle.findFirst({
        where: { number: rec["VEHICLE NO"].toUpperCase().replace(/\s+/g, "") },
      });
      if (!vehicle) throw new Error(`vehicle "${rec["VEHICLE NO"]}" not found`);
      const docType = await tx.documentType.findFirst({
        where: { name: { equals: rec["DOCUMENT TYPE"], mode: "insensitive" } },
      });
      if (!docType) throw new Error(`document type "${rec["DOCUMENT TYPE"]}" not found`);
      const entryDate = parseDateInput(rec["ENTRY DATE"]);
      if (!entryDate) throw new Error("invalid entry date (use dd/mm/yyyy)");
      const values = {
        docNo: rec["DOC NO"] || null,
        companyName: rec["COMPANY"] || null,
        status: enumKey(rec["STATUS"]) === "PENDING" ? "PENDING" : "DONE",
        entryDate,
        effectiveDate: parseDateInput(rec["EFFECTIVE DATE"] ?? ""),
        expiryDate: parseDateInput(rec["EXPIRY DATE"] ?? ""),
        remarks: rec["REMARKS"] || null,
      };
      const existing = rec["DOC NO"]
        ? await tx.vehicleDocument.findFirst({
            where: { vehicleId: vehicle.id, docTypeId: docType.id, docNo: rec["DOC NO"] },
          })
        : null;
      if (existing) {
        await tx.vehicleDocument.update({ where: { id: existing.id }, data: values });
        return "updated";
      }
      await tx.vehicleDocument.create({
        data: { tenantId: session.tenantId, vehicleId: vehicle.id, docTypeId: docType.id, ...values },
      });
      return "created";
    })
  );
}
