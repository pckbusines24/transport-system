import { unstable_cache } from "next/cache";
import { requireSession } from "@/lib/session";
import { authorize } from "@/lib/authz";
import { withTenant } from "@/lib/db";
import { toNum } from "@/lib/utils";
import { RoutesClient, type RouteRow } from "./routes-client";

export const dynamic = "force-dynamic";

/**
 * Route Heartbeat + Rate Memory — which lanes are alive, and at what rate.
 * Party side comes from LRs and broker-slip party amounts; the vehicle
 * side comes from market chalans (lorry hire, lane derived from the chalan's
 * LRs) and broker-slip owner amounts. Everything is derived from data already
 * entered; nothing new to key in.
 *
 * Status by days since the last trip: ≤7 ALIVE, 8–20 COOLING, >20 SLEEPING.
 * A lane with fewer than 3 lifetime trips stays in the OCCASIONAL bucket so a
 * one-off route can never cry wolf in red.
 */

const ALIVE_DAYS = 7;
const COOLING_DAYS = 20;
const MIN_TRIPS = 3;
const r2 = (n: number) => Math.round(n * 100) / 100;

/**
 * The heartbeat scans every LR/slip/chalan ever entered — heavy, but the
 * answer ("which lanes are going cold") only moves at day granularity, so a
 * short cache makes repeat visits free without meaningfully staling the data.
 */
function getRouteRows(tenantId: string, firmId: string): Promise<RouteRow[]> {
  return unstable_cache(
    () => computeRouteRows(tenantId, firmId),
    ["route-heartbeat", tenantId, firmId],
    { revalidate: 300 }
  )();
}

async function computeRouteRows(tenantId: string, firmId: string): Promise<RouteRow[]> {
  const data = await withTenant(tenantId, async (tx) => {
    // route activity continues across FYs — a lane's history does not reset
    // on 1 April (FY continuity)
    const scope = { firmId, deletedAt: null as null };
    const [lrs, slips, chalans, cities, parties, vehicles] = await Promise.all([
      tx.lr.findMany({
        where: { ...scope, lrType: { notIn: ["CANCELLED", "PAPER_CHANGE"] } },
        select: {
          sourceCityId: true,
          destCityId: true,
          lrDate: true,
          lrNo: true,
          grandTotal: true,
          consignorId: true,
          items: { select: { rate: true } },
        },
      }),
      tx.brokerSlip.findMany({
        where: scope,
        select: {
          slipNo: true,
          loadStationId: true,
          destCityId: true,
          slipDate: true,
          pChalanAmt: true,
          pRate: true,
          partyId: true,
          vChalanAmt: true,
          vRate: true,
          ownerId: true,
          ownerName: true,
          vehicleId: true,
        },
      }),
      // market chalans: lorry hire is the vehicle rate; the lane comes from the
      // chalan's own LRs (first linked LR decides the route)
      tx.chalan.findMany({
        where: { ...scope, cancelledAt: null },
        select: {
          chalanNo: true,
          chalanDate: true,
          freight: true,
          brokerId: true,
          vehicleId: true,
          lrs: { select: { lr: { select: { sourceCityId: true, destCityId: true } } }, take: 1 },
        },
      }),
      tx.city.findMany({ select: { id: true, name: true } }),
      tx.party.findMany({ select: { id: true, name: true, mobile: true } }),
      tx.vehicle.findMany({ select: { id: true, number: true, ownershipType: true } }),
    ]);
    return { lrs, slips, chalans, cities, parties, vehicles };
  });

  const cityName = new Map(data.cities.map((c) => [c.id, c.name]));
  const partyOf = new Map(data.parties.map((p) => [p.id, p]));
  const vehicleOf = new Map(data.vehicles.map((v) => [v.id, v]));

  interface PartyTrip {
    date: Date;
    refNo: string;
    freight: number;
    rate: number;
    partyId: string | null;
  }
  interface VehicleTrip {
    date: Date;
    refNo: string;
    amount: number;
    broker: string;
    vehicle: string;
  }
  const routes = new Map<string, { party: PartyTrip[]; vehicle: VehicleTrip[] }>();
  const laneOf = (fromId: string | null, toId: string | null): string | null => {
    if (!fromId || !toId) return null;
    const from = cityName.get(fromId);
    const to = cityName.get(toId);
    return from && to ? `${from}→${to}` : null;
  };
  const bucket = (key: string) => {
    const r = routes.get(key) ?? { party: [], vehicle: [] };
    routes.set(key, r);
    return r;
  };

  for (const l of data.lrs) {
    const key = laneOf(l.sourceCityId, l.destCityId);
    if (!key) continue;
    bucket(key).party.push({
      date: l.lrDate,
      refNo: l.lrNo,
      freight: toNum(l.grandTotal),
      rate: l.items.length ? Math.max(...l.items.map((i) => toNum(i.rate))) : 0,
      partyId: l.consignorId,
    });
  }
  for (const s of data.slips) {
    const key = laneOf(s.loadStationId, s.destCityId);
    if (!key) continue;
    const b = bucket(key);
    b.party.push({
      date: s.slipDate,
      refNo: s.slipNo,
      freight: toNum(s.pChalanAmt),
      rate: toNum(s.pRate),
      partyId: s.partyId,
    });
    if (toNum(s.vChalanAmt) > 0) {
      b.vehicle.push({
        date: s.slipDate,
        refNo: s.slipNo,
        amount: toNum(s.vChalanAmt),
        broker: (s.ownerId ? partyOf.get(s.ownerId)?.name : null) ?? s.ownerName ?? "",
        vehicle: s.vehicleId ? vehicleOf.get(s.vehicleId)?.number ?? "" : "",
      });
    }
  }
  for (const c of data.chalans) {
    const v = vehicleOf.get(c.vehicleId);
    // own/relative hire is an internal settlement, not the market rate
    if (!v || v.ownershipType !== "BROKER") continue;
    const first = c.lrs[0]?.lr;
    const key = first ? laneOf(first.sourceCityId, first.destCityId) : null;
    if (!key || toNum(c.freight) <= 0) continue;
    bucket(key).vehicle.push({
      date: c.chalanDate,
      refNo: c.chalanNo,
      amount: toNum(c.freight),
      broker: partyOf.get(c.brokerId)?.name ?? "",
      vehicle: v.number,
    });
  }

  const now = new Date();
  const monthKey = (d: Date) => `${d.getFullYear()}-${d.getMonth()}`;
  const thisMonth = monthKey(now);
  const lastMonth = monthKey(new Date(now.getFullYear(), now.getMonth() - 1, 1));
  const iso = (d: Date) => d.toISOString();

  const rows: RouteRow[] = Array.from(routes.entries())
    .filter(([, r]) => r.party.length > 0 || r.vehicle.length > 0)
    .map(([key, r]) => {
      const trips = r.party;
      const total = trips.length;
      const allDates = [...trips.map((t) => t.date), ...r.vehicle.map((t) => t.date)];
      const last = allDates.reduce((m, d) => (d > m ? d : m), allDates[0]);
      const daysSince = Math.floor((now.getTime() - last.getTime()) / 86400000);
      const tripsThisMonth = trips.filter((t) => monthKey(t.date) === thisMonth).length;
      const tripsLastMonth = trips.filter((t) => monthKey(t.date) === lastMonth).length;
      const avgFreight = total ? r2(trips.reduce((s, t) => s + t.freight, 0) / total) : 0;
      const rated = trips.filter((t) => t.rate > 0);
      const avgPartyRate = rated.length
        ? r2(rated.reduce((s, t) => s + t.rate, 0) / rated.length)
        : 0;
      const avgVehicleAmt = r.vehicle.length
        ? r2(r.vehicle.reduce((s, t) => s + t.amount, 0) / r.vehicle.length)
        : 0;
      // per-trip margin: what the party pays vs what a market vehicle costs here
      const marginPerTrip = avgFreight > 0 && avgVehicleAmt > 0 ? r2(avgFreight - avgVehicleAmt) : null;
      const status =
        Math.max(total, r.vehicle.length) < MIN_TRIPS
          ? "OCCASIONAL"
          : daysSince <= ALIVE_DAYS
            ? "ALIVE"
            : daysSince <= COOLING_DAYS
              ? "COOLING"
              : "SLEEPING";
      const byParty = new Map<string, number>();
      for (const t of trips) {
        if (t.partyId) byParty.set(t.partyId, (byParty.get(t.partyId) ?? 0) + 1);
      }
      const topParties = Array.from(byParty.entries())
        .sort((a, b) => b[1] - a[1])
        .slice(0, 5)
        .map(([id, n]) => ({
          name: partyOf.get(id)?.name ?? "",
          mobile: partyOf.get(id)?.mobile ?? null,
          trips: n,
        }))
        .filter((p) => p.name);
      const recent = <T extends { date: Date }>(list: T[]) =>
        [...list].sort((a, b) => b.date.getTime() - a.date.getTime()).slice(0, 5);
      return {
        route: key,
        totalTrips: total,
        tripsThisMonth,
        tripsLastMonth,
        lastTripDate: iso(last),
        daysSince,
        avgFreight,
        avgPartyRate,
        avgVehicleAmt,
        marginPerTrip,
        status,
        topParties,
        partyHistory: recent(trips).map((t) => ({
          date: iso(t.date),
          refNo: t.refNo,
          party: (t.partyId ? partyOf.get(t.partyId)?.name : null) ?? "",
          rate: t.rate,
          freight: t.freight,
        })),
        vehicleHistory: recent(r.vehicle).map((t) => ({
          date: iso(t.date),
          refNo: t.refNo,
          broker: t.broker,
          vehicle: t.vehicle,
          amount: t.amount,
        })),
      };
    });

  rows.sort((a, b) => b.daysSince - a.daysSince);
  return rows;
}

export default async function RoutesPage() {
  const session = requireSession();
  await authorize(session, "reports", "view");
  const rows = await getRouteRows(session.tenantId, session.firmId);
  return <RoutesClient rows={rows} />;
}
