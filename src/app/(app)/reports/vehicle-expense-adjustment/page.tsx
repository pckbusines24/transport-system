import { requireSession } from "@/lib/session";
import { withTenant } from "@/lib/db";
import { getAdjustmentReport, type AdjFilters } from "./data";
import { AdjustmentClient } from "./client";

export const dynamic = "force-dynamic";

/**
 * Vehicle Expense Adjustment Report — expense-head advances deducted on
 * chalans / owner-side broker slips vs the same heads booked in the Vehicle
 * Expense Book, with drill-down to the entries. Read-only.
 */
export default async function VehicleExpenseAdjustmentPage({
  searchParams,
}: {
  searchParams: Record<string, string | undefined>;
}) {
  const session = requireSession();
  const filters: AdjFilters = {
    vehicleId: searchParams.vehicle || undefined,
    brokerId: searchParams.broker || undefined,
    headId: searchParams.head || undefined,
    dateFrom: searchParams.date_from || undefined,
    dateTo: searchParams.date_to || undefined,
  };

  const [{ brokers, vehicles, heads }, data] = await Promise.all([
    withTenant(session.tenantId, async (tx) => {
      const [brokers, vehicles, heads] = await Promise.all([
        tx.party.findMany({
          where: { ledgerGroup: { in: ["OWNER_BROKER", "RELATIVE"] }, isActive: true },
          select: { id: true, name: true, transportName: true, alias: true },
          orderBy: { name: "asc" },
        }),
        tx.vehicle.findMany({ where: { isActive: true }, select: { id: true, number: true }, orderBy: { number: "asc" } }),
        tx.accountHead.findMany({ where: { kind: "EXPENSE" }, select: { id: true, name: true }, orderBy: { name: "asc" } }),
      ]);
      return { brokers, vehicles, heads };
    }),
    getAdjustmentReport(session, filters),
  ]);

  return (
    <AdjustmentClient
      data={data}
      brokerOptions={brokers.map((b) => ({
        value: b.id,
        label: b.name,
        meta: [b.transportName, b.alias].filter(Boolean).join(" · ") || undefined,
      }))}
      vehicleOptions={vehicles.map((v) => ({ value: v.id, label: v.number }))}
      headOptions={heads.map((h) => ({ value: h.id, label: h.name }))}
    />
  );
}
