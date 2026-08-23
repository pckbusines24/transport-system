import type { Prisma } from "@prisma/client";
import { requireSession } from "@/lib/session";
import { authorize } from "@/lib/authz";
import { withTenant } from "@/lib/db";
import { DriverClient, type DriverRow } from "@/components/vehicle/driver-client";

export async function DriverInfoTab({
  searchParams,
}: {
  searchParams: { q?: string; vehicle?: string; status?: string };
}) {
  const session = requireSession();
  await authorize(session, "driver", "view");

  const { drivers, vehicles, driverLedgers, advances, settlements } = await withTenant(
    session.tenantId,
    async (tx) => {
    const where: Prisma.DriverWhereInput = { firmId: session.firmId, deletedAt: null };
    if (searchParams.q) {
      where.OR = [
        { name: { contains: searchParams.q, mode: "insensitive" } },
        { driverCode: { contains: searchParams.q, mode: "insensitive" } },
        { mobile: { contains: searchParams.q } },
      ];
    }
    if (searchParams.status === "ACTIVE" || searchParams.status === "INACTIVE") {
      where.status = searchParams.status;
    }
    if (searchParams.vehicle) {
      where.assignments = { some: { vehicleId: searchParams.vehicle } };
    }
    const [drivers, vehicles, driverLedgers, advances, settlements] = await Promise.all([
      tx.driver.findMany({
        where,
        include: {
          documents: true,
          assignments: { orderBy: { fromDate: "asc" } },
        },
        orderBy: { createdAt: "desc" },
      }),
      tx.vehicle.findMany({ orderBy: { number: "asc" } }),
      // every ledger in the Driver group is selectable from Driver Master
      tx.party.findMany({
        where: { ledgerGroup: "DRIVER", isActive: true },
        orderBy: { name: "asc" },
        select: { id: true, name: true, mobile: true },
      }),
      // expense summary: everything ever advanced / settled per driver
      tx.driverAdvance.findMany({
        where: { firmId: session.firmId, deletedAt: null },
        select: { driverId: true, amount: true, status: true },
      }),
      tx.driverSettlement.findMany({
        where: { firmId: session.firmId, deletedAt: null, status: "SETTLED", voucherId: { not: null } },
        select: { driverId: true, amount: true },
      }),
    ]);
    return { drivers, vehicles, driverLedgers, advances, settlements };
  });

  const vehicleNo = new Map(vehicles.map((v) => [v.id, v.number]));
  const vehicleOwnership = new Map(vehicles.map((v) => [v.id, v.ownershipType]));
  const ledgerName = new Map(driverLedgers.map((p) => [p.id, p.name]));

  const r2 = (n: number) => Math.round(n * 100) / 100;
  const num = (v: unknown) => Number(String(v ?? 0)) || 0;
  const advByDriver = new Map<string, { paid: number; pending: number }>();
  for (const a of advances) {
    const acc = advByDriver.get(a.driverId) ?? { paid: 0, pending: 0 };
    acc.paid = r2(acc.paid + num(a.amount));
    if (a.status === "PENDING") acc.pending = r2(acc.pending + num(a.amount));
    advByDriver.set(a.driverId, acc);
  }
  const settleByDriver = new Map<string, { paid: number; received: number }>();
  for (const s of settlements) {
    const acc = settleByDriver.get(s.driverId) ?? { paid: 0, received: 0 };
    const amt = num(s.amount);
    if (amt > 0) acc.paid = r2(acc.paid + amt);
    else acc.received = r2(acc.received + Math.abs(amt));
    settleByDriver.set(s.driverId, acc);
  }

  const rows: DriverRow[] = drivers.map((d) => {
    const open = d.assignments.find((a) => !a.toDate);
    // driver type follows the ASSIGNED vehicle's ownership, live
    const ownership = open ? vehicleOwnership.get(open.vehicleId) : undefined;
    const adv = advByDriver.get(d.id) ?? { paid: 0, pending: 0 };
    const stl = settleByDriver.get(d.id) ?? { paid: 0, received: 0 };
    return {
      driverType:
        ownership === "OWNER"
          ? "COMPANY"
          : ownership === "RELATIVE"
            ? "RELATIVE"
            : ownership === "BROKER"
              ? "BROKER"
              : "",
      advancePaid: adv.paid,
      outstandingAdvance: adv.pending,
      settlementPaid: stl.paid,
      totalExpense: r2(adv.paid + stl.paid - stl.received),
      id: d.id,
      driverCode: d.driverCode,
      name: d.name,
      partyId: d.partyId,
      partyName: d.partyId ? ledgerName.get(d.partyId) ?? "" : "",
      mobile: d.mobile ?? "",
      emergencyContact: d.emergencyContact ?? "",
      address: d.address ?? "",
      joinDate: d.joinDate ? d.joinDate.toISOString() : null,
      exitDate: d.exitDate ? d.exitDate.toISOString() : null,
      exitReason: d.exitReason ?? "",
      status: d.status,
      remarks: d.remarks ?? "",
      currentVehicle: open ? vehicleNo.get(open.vehicleId) ?? "" : "",
      licence: { path: d.licencePath, name: d.licenceName },
      aadhaar: { path: d.aadhaarPath, name: d.aadhaarName },
      pan: { path: d.panPath, name: d.panName },
      photo: { path: d.photoPath, name: d.photoName },
      medical: { path: d.medicalPath, name: d.medicalName },
      police: { path: d.policePath, name: d.policeName },
      otherDocs: d.documents.map((o) => ({ title: o.title, path: o.filePath, name: o.fileName })),
      assignments: d.assignments.map((a) => ({
        vehicle: vehicleNo.get(a.vehicleId) ?? "",
        fromDate: a.fromDate.toISOString(),
        toDate: a.toDate ? a.toDate.toISOString() : null,
        reason: a.reason ?? "",
        remarks: a.remarks ?? "",
      })),
    };
  });

  return (
    <div className="space-y-4">
      <DriverClient
        rows={rows}
        vehicleOptions={vehicles
          .filter((v) => v.isActive)
          .map((v) => ({ value: v.id, label: v.number }))}
        driverLedgerOptions={driverLedgers.map((p) => ({
          value: p.id,
          label: p.name,
          meta: p.mobile ?? undefined,
        }))}
        canDelete={session.role === "ADMIN" || session.role === "OWNER"}
      />
    </div>
  );
}
