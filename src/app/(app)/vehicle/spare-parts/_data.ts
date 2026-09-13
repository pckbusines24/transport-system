import { requireSession } from "@/lib/session";
import { withTenant } from "@/lib/db";
import { toNum } from "@/lib/utils";
import { warrantyPosition } from "@/lib/spare-parts";
import type { MasterOption } from "@/components/data/master-combobox";
import type { SparePartRow } from "@/components/vehicle/spare-parts-types";

/**
 * One loader for every tab of the Spare Parts module: the firm's parts with
 * their full event history, plus vehicle options. Purely operational data —
 * nothing here reads or writes accounting tables.
 */
export async function loadSpareParts(): Promise<{
  parts: SparePartRow[];
  vehicleOptions: MasterOption[];
}> {
  const session = requireSession();
  const { parts, vehicles } = await withTenant(session.tenantId, async (tx) => {
    const [parts, vehicles] = await Promise.all([
      tx.sparePart.findMany({
        where: { firmId: session.firmId, deletedAt: null },
        include: { events: { orderBy: [{ date: "asc" }, { createdAt: "asc" }] } },
        orderBy: [{ createdAt: "desc" }],
      }),
      tx.vehicle.findMany({ orderBy: { number: "asc" }, select: { id: true, number: true, isActive: true } }),
    ]);
    return { parts, vehicles };
  });

  const vehicleNo = new Map(vehicles.map((v) => [v.id, v.number]));
  const serialOf = new Map(parts.map((p) => [p.id, p.serialNo]));
  const now = new Date();

  const rows: SparePartRow[] = parts.map((p) => {
    const w = warrantyPosition(p.warrantyExpiryDate, now);
    return {
      id: p.id,
      name: p.name,
      partNumber: p.partNumber ?? "",
      serialNo: p.serialNo,
      brand: p.brand ?? "",
      model: p.model ?? "",
      supplierName: p.supplierName ?? "",
      purchaseDate: p.purchaseDate ? p.purchaseDate.toISOString() : null,
      invoiceNo: p.invoiceNo ?? "",
      purchaseRate: p.purchaseRate === null ? null : toNum(String(p.purchaseRate)),
      warrantyApplicable: p.warrantyApplicable,
      warrantyMonths: p.warrantyMonths,
      warrantyStart: p.warrantyStartDate ? p.warrantyStartDate.toISOString() : null,
      warrantyExpiry: p.warrantyExpiryDate ? p.warrantyExpiryDate.toISOString() : null,
      remarks: p.remarks ?? "",
      status: p.status,
      currentVehicleId: p.currentVehicleId,
      currentVehicle: p.currentVehicleId ? vehicleNo.get(p.currentVehicleId) ?? "" : "",
      installedOn: p.installedOn ? p.installedOn.toISOString() : null,
      installKm: p.installKm === null ? null : toNum(String(p.installKm)),
      warrantyReviewedAt: p.warrantyReviewedAt ? p.warrantyReviewedAt.toISOString() : null,
      warranty: p.warrantyApplicable ? w.status : "NONE",
      daysLeft: p.warrantyApplicable ? w.daysLeft : null,
      claimCount: p.events.filter((e) => e.type === "WARRANTY_CLAIM").length,
      events: p.events.map((e) => ({
        id: e.id,
        type: e.type,
        date: e.date.toISOString(),
        vehicleId: e.vehicleId,
        vehicle: e.vehicleId ? vehicleNo.get(e.vehicleId) ?? "" : "",
        km: e.kmReading === null ? null : toNum(String(e.kmReading)),
        workshop: e.workshop ?? "",
        remarks: e.remarks ?? "",
        claimStatus: e.claimStatus,
        relatedSerial: e.relatedPartId ? serialOf.get(e.relatedPartId) ?? null : null,
        relatedPartId: e.relatedPartId,
      })),
    };
  });

  return {
    parts: rows,
    vehicleOptions: vehicles
      .filter((v) => v.isActive)
      .map((v) => ({ value: v.id, label: v.number })),
  };
}
