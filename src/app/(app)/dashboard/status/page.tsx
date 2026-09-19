import { requireSession } from "@/lib/session";
import { withTenant } from "@/lib/db";
import { getStatusData, type StatusFilters } from "./status-data";
import { StatusClient } from "./status-client";

export const dynamic = "force-dynamic";

/**
 * Dashboard → Status: transaction tracking & drill-down. Search by LR / chalan /
 * bill / vehicle / broker and see the whole chain on one screen. Read-only.
 */
export default async function StatusPage({
  searchParams,
}: {
  searchParams: Record<string, string | undefined>;
}) {
  const session = requireSession();
  const filters: StatusFilters = {
    lrNo: searchParams.lr?.trim() || undefined,
    chalanNo: searchParams.chalan?.trim() || undefined,
    billNo: searchParams.bill?.trim() || undefined,
    vehicleId: searchParams.vehicle || undefined,
    brokerId: searchParams.broker || undefined,
    dateFrom: searchParams.date_from || undefined,
    dateTo: searchParams.date_to || undefined,
  };

  const [{ brokers, vehicles }, data] = await Promise.all([
    withTenant(session.tenantId, async (tx) => {
      const [brokers, vehicles] = await Promise.all([
        tx.party.findMany({
          where: { ledgerGroup: { in: ["OWNER_BROKER", "RELATIVE"] }, isActive: true },
          select: { id: true, name: true, transportName: true, alias: true },
          orderBy: { name: "asc" },
        }),
        tx.vehicle.findMany({ where: { isActive: true }, select: { id: true, number: true }, orderBy: { number: "asc" } }),
      ]);
      return { brokers, vehicles };
    }),
    getStatusData(session, filters),
  ]);

  return (
    <StatusClient
      data={data}
      filters={filters}
      brokerOptions={brokers.map((b) => ({
        value: b.id,
        label: b.name,
        meta: [b.transportName, b.alias].filter(Boolean).join(" · ") || undefined,
      }))}
      vehicleOptions={vehicles.map((v) => ({ value: v.id, label: v.number }))}
    />
  );
}
