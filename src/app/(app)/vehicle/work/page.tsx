import { requireSession } from "@/lib/session";
import { authorize } from "@/lib/authz";
import { withTenant } from "@/lib/db";
import { WorkEntryClient, type WorkRow } from "./work-client";

export const dynamic = "force-dynamic";

export default async function VehicleWorkPage() {
  const session = requireSession();
  await authorize(session, "work", "view");

  const { rows, vehicles } = await withTenant(session.tenantId, async (tx) => {
    const [works, vehicles] = await Promise.all([
      tx.vehicleWork.findMany({
        // FY continuity: work carries across years — old open/recent work
        // stays visible without switching FY
        where: { firmId: session.firmId, deletedAt: null },
        orderBy: [{ workDate: "desc" }, { createdAt: "desc" }],
      }),
      tx.vehicle.findMany({ where: { isActive: true }, orderBy: { number: "asc" } }),
    ]);
    return { rows: works, vehicles };
  });

  const vname = new Map(vehicles.map((v) => [v.id, v.number]));
  const mapped: WorkRow[] = rows.map((w) => ({
    id: w.id,
    workDate: w.workDate.toISOString(),
    vehicleId: w.vehicleId,
    vehicle: vname.get(w.vehicleId) ?? "",
    description: w.description,
    supplier: w.supplier ?? "",
    completeDate: w.completeDate ? w.completeDate.toISOString() : null,
    remarks: w.remarks ?? "",
  }));

  return (
    <WorkEntryClient
      rows={mapped}
      vehicles={vehicles.map((v) => ({ value: v.id, label: v.number }))}
      canDelete={session.role === "ADMIN" || session.role === "OWNER"}
    />
  );
}
