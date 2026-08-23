import { requireSession } from "@/lib/session";
import { authorize } from "@/lib/authz";
import { withTenant } from "@/lib/db";
import {
  VehicleTrackingClient,
  type TrackingSnapshot,
} from "@/components/vehicle/vehicle-tracking-client";

const RETENTION_DAYS = 120;

export async function VehicleTrackingTab() {
  const session = requireSession();
  await authorize(session, "vehicle", "view");

  const now = new Date();
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const cutoff = new Date(todayStart);
  cutoff.setDate(cutoff.getDate() - RETENTION_DAYS);

  const { vehicles, rows } = await withTenant(session.tenantId, async (tx) => {
    // retention enforcement on read too — no user action ever required
    await tx.vehicleTracking.deleteMany({
      where: { firmId: session.firmId, date: { lt: cutoff } },
    });
    const [vehicles, rows] = await Promise.all([
      // tracking covers Own & Relative vehicles only — market/broker vehicles
      // are never tracked here
      tx.vehicle.findMany({
        where: { isActive: true, ownershipType: { in: ["OWNER", "RELATIVE"] } },
        orderBy: { number: "asc" },
      }),
      tx.vehicleTracking.findMany({
        where: { firmId: session.firmId },
        orderBy: [{ vehicleId: "asc" }, { date: "asc" }],
      }),
    ]);
    return { vehicles, rows };
  });

  const snapshots: TrackingSnapshot[] = rows.map((r) => ({
    vehicleId: r.vehicleId,
    date: r.date.toISOString(),
    transporterName: r.transporterName ?? "",
    fromLocation: r.fromLocation ?? "",
    toLocation: r.toLocation ?? "",
    currentLocation: r.currentLocation ?? "",
    status: r.status ?? "",
    remarks: r.remarks ?? "",
    updatedAt: r.updatedAt.toISOString(),
  }));

  return (
    <div className="space-y-4">
      <VehicleTrackingClient
        vehicles={vehicles.map((v) => ({
          id: v.id,
          number: v.number,
          ownership: v.ownershipType,
        }))}
        snapshots={snapshots}
        retentionDays={RETENTION_DAYS}
      />
    </div>
  );
}
