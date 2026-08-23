import { requireSession } from "@/lib/session";
import { authorize } from "@/lib/authz";
import { getVehicleOptions } from "@/lib/lookups";
import {
  getAllocationHistory,
  getUnallocatedPurchases,
} from "@/app/(app)/vehicle/expenses/allocation-actions";
import { VehicleExpenseAllocationClient } from "@/components/vehicle/vehicle-expense-allocation-client";

/**
 * Vehicle Expense Allocation — hands bulk stock (tyres, chains, batteries,
 * spares) to the vehicles that consume it. The purchase was already accounted
 * for; allocating only moves cost into the vehicle registers, on the date the
 * vehicle actually took it.
 */
export async function VehicleExpenseAllocationTab({
  searchParams,
}: {
  searchParams: { vehicle?: string; date_from?: string; date_to?: string };
}) {
  const session = requireSession();
  await authorize(session, "vehicle", "view");

  const [purchases, history, vehicles] = await Promise.all([
    getUnallocatedPurchases(),
    getAllocationHistory({
      vehicleId: searchParams.vehicle,
      dateFrom: searchParams.date_from,
      dateTo: searchParams.date_to,
    }),
    getVehicleOptions(),
  ]);

  return (
    <VehicleExpenseAllocationClient
      purchases={purchases}
      history={history}
      vehicleOptions={vehicles}
    />
  );
}
