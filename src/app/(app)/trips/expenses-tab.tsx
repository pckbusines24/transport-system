import { requireSession } from "@/lib/session";
import { authorize } from "@/lib/authz";
import { withTenant } from "@/lib/db";
import { toNum, istDayEnd, istDayStart } from "@/lib/utils";
import { FilterBar, type FilterDef } from "@/components/data/filter-bar";
import { SimpleReport } from "@/components/accounts/simple-report";

const catLabel = (c: string) =>
  c.split("_").map((w) => w.charAt(0) + w.slice(1).toLowerCase()).join(" ");

export async function TripExpensesTab({
  searchParams,
}: {
  searchParams: { vehicle?: string; category?: string; date_from?: string; date_to?: string };
}) {
  const session = requireSession();
  await authorize(session, "trips", "view");

  const { rows, vehicles } = await withTenant(session.tenantId, async (tx) => {
    const [expenses, trips, vehicles] = await Promise.all([
      tx.tripExpense.findMany({
        where: {
          ...(searchParams.category ? { category: searchParams.category } : {}),
          trip: {
            firmId: session.firmId,
            fyId: session.fyId,
            deletedAt: null,
            ...(searchParams.vehicle ? { vehicleId: searchParams.vehicle } : {}),
            ...(searchParams.date_from || searchParams.date_to
              ? {
                  tripDate: {
                    ...(searchParams.date_from
                      ? { gte: istDayStart(searchParams.date_from) }
                      : {}),
                    ...(searchParams.date_to
                      ? { lte: istDayEnd(searchParams.date_to) }
                      : {}),
                  },
                }
              : {}),
          },
        },
        include: { trip: true },
        orderBy: { trip: { tripDate: "desc" } },
        take: 1000,
      }),
      Promise.resolve(null),
      tx.vehicle.findMany({ where: { isActive: true }, orderBy: { number: "asc" } }),
    ]);
    void trips;
    return { rows: expenses, vehicles };
  });

  const vehicleById = new Map(vehicles.map((v) => [v.id, v.number]));
  const categories = Array.from(new Set(rows.map((r) => r.category)));

  const filters: FilterDef[] = [
    { type: "daterange", key: "date", label: "Trip Date" },
    {
      type: "combobox",
      key: "vehicle",
      label: "Vehicle",
      options: vehicles.map((v) => ({ value: v.id, label: v.number })),
    },
    {
      type: "select",
      key: "category",
      label: "Category",
      options: ["DIESEL", "TOLL", "DRIVER_BATA", "LOADING", "UNLOADING", "PARKING", "POLICE_RTO", "MISC"].map(
        (c) => ({ value: c, label: catLabel(c) })
      ),
    },
  ];
  void categories;

  return (
    <div className="space-y-4">
      <FilterBar filters={filters} />
      <SimpleReport
        title={`${rows.length} expense lines`}
        columns={[
          { key: "tripNo", header: "Trip No", linkBase: "/", linkParamKey: "link" },
          { key: "tripDate", header: "Trip Date", kind: "date" },
          { key: "vehicle", header: "Vehicle" },
          { key: "category", header: "Category", kind: "badge" },
          { key: "amount", header: "Amount", kind: "money" },
          { key: "remarks", header: "Remarks" },
        ]}
        rows={rows.map((r) => ({
          tripNo: r.trip.tripNo,
          link: `trips?id=${r.tripId}`,
          tripDate: r.trip.tripDate.toISOString(),
          vehicle: vehicleById.get(r.trip.vehicleId) ?? "",
          category: catLabel(r.category),
          amount: toNum(String(r.amount)),
          remarks: r.remarks ?? "",
        }))}
        fileName="trip-expenses"
        emptyMessage="No trip expenses recorded yet — add them from the Trip Sheet form."
      />
    </div>
  );
}
