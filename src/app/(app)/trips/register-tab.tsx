import type { Prisma } from "@prisma/client";
import { requireSession } from "@/lib/session";
import { authorize } from "@/lib/authz";
import { withTenant } from "@/lib/db";
import { toNum } from "@/lib/utils";
import { tripGrandTotals } from "@/lib/trip-docs";
import {
  TripRegisterClient,
  type TripRegisterRow,
} from "@/components/trips/trip-register-client";

export async function TripRegisterTab({
  searchParams,
}: {
  searchParams: {
    q?: string;
    vehicle?: string;
    driver?: string;
    date_from?: string;
    date_to?: string;
  };
}) {
  const session = requireSession();
  await authorize(session, "trips", "view");

  const { trips, vehicles, drivers, cities, settlements, docTotals } = await withTenant(
    session.tenantId,
    async (tx) => {
      // FY-scoped list, but an UNSETTLED trip from an earlier year stays
      // visible until its accounts close (FY continuity for pending work)
      const openSettlements = await tx.driverSettlement.findMany({
        where: { firmId: session.firmId, deletedAt: null, status: "PENDING", tripId: { not: null } },
        select: { tripId: true },
      });
      const openTripIds = openSettlements.map((s) => s.tripId).filter((x): x is string => !!x);
      // date filter beats FY: dates set → that period from any year
      const where: Prisma.TripWhereInput = {
        firmId: session.firmId,
        deletedAt: null,
        ...(searchParams.date_from || searchParams.date_to
          ? {}
          : { OR: [{ fyId: session.fyId }, { id: { in: openTripIds } }] }),
      };
      if (searchParams.q) where.tripNo = { contains: searchParams.q, mode: "insensitive" };
      if (searchParams.vehicle) where.vehicleId = searchParams.vehicle;
      if (searchParams.driver) where.driverId = searchParams.driver;
      if (searchParams.date_from || searchParams.date_to) {
        where.tripDate = {
          ...(searchParams.date_from
            ? { gte: new Date(searchParams.date_from + "T00:00:00") }
            : {}),
          ...(searchParams.date_to ? { lte: new Date(searchParams.date_to + "T23:59:59") } : {}),
        };
      }
      const [trips, vehicles, drivers, settlements] = await Promise.all([
        tx.trip.findMany({ where, orderBy: [{ tripDate: "desc" }, { createdAt: "desc" }] }),
        // these three feed id→label maps and the filter dropdowns, so only the
        // label columns are needed — the full master rows were pure wire cost
        tx.vehicle.findMany({ orderBy: { number: "asc" }, select: { id: true, number: true } }),
        tx.driver.findMany({
          where: { firmId: session.firmId, deletedAt: null },
          select: { id: true, name: true },
        }),
        tx.driverSettlement.findMany({
          where: { firmId: session.firmId, deletedAt: null, tripId: { not: null } },
          select: { tripId: true, status: true },
        }),
      ]);
      // only the cities these trips actually route through — the register used
      // to pull the whole city master to label two columns
      const cityIds = Array.from(
        new Set(
          trips.flatMap((t) => [t.goingSourceCityId, t.goingDestCityId]).filter(Boolean) as string[]
        )
      );
      const cities = cityIds.length
        ? await tx.city.findMany({ where: { id: { in: cityIds } }, select: { id: true, name: true } })
        : [];
      const docTotals = await tripGrandTotals(tx, trips.map((t) => t.id));
      return { trips, vehicles, drivers, cities, settlements, docTotals };
    }
  );

  const vehicleNo = new Map(vehicles.map((v) => [v.id, v.number]));
  const driverName = new Map(drivers.map((d) => [d.id, d.name]));
  const cityName = new Map(cities.map((c) => [c.id, c.name]));
  const settlementByTrip = new Map(settlements.map((s) => [s.tripId as string, s]));

  const rows: TripRegisterRow[] = trips.map((t) => {
    const s = settlementByTrip.get(t.id);
    return {
      id: t.id,
      tripNo: t.tripNo,
      date: t.tripDate.toISOString(),
      vehicle: vehicleNo.get(t.vehicleId) ?? "",
      driver: t.driverId ? driverName.get(t.driverId) ?? "" : "",
      from: (t.goingSourceCityId && cityName.get(t.goingSourceCityId)) || "",
      to: (t.goingDestCityId && cityName.get(t.goingDestCityId)) || "",
      // Grand Total of the linked documents, read live so a chalan edit shows
      // here without the sheet being re-saved; stored snapshot for legacy trips
      freight:
        docTotals.get(t.id) ??
        toNum(String(t.gTotalFreight)) + toNum(String(t.rTotalFreight)),
      approved: toNum(String(t.approvedTotal)),
      driverBalance: toNum(String(t.driverBalance)),
      vehicleCost: toNum(String(t.grandTotal)),
      status: s ? (s.status === "SETTLED" ? "SETTLED" : "PENDING") : "NO BALANCE",
    };
  });

  return (
    <div className="space-y-4">
      <TripRegisterClient
        rows={rows}
        vehicleOptions={vehicles.map((v) => ({ value: v.id, label: v.number }))}
        driverOptions={drivers.map((d) => ({ value: d.id, label: d.name }))}
        canDelete={session.role === "ADMIN" || session.role === "OWNER"}
      />
    </div>
  );
}
