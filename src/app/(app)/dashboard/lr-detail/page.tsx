import { requireSession } from "@/lib/session";
import { withTenant } from "@/lib/db";
import { LR_VIEW_META, type LrView } from "../lr-views";
import { LrDetailClient } from "./lr-detail-client";

export const dynamic = "force-dynamic";

/**
 * Dashboard drill-down page — a dedicated detail grid per LR summary card,
 * independent of the existing reports/registers.
 */
export default async function LrDetailPage({
  searchParams,
}: {
  searchParams: { view?: string };
}) {
  const session = requireSession();
  const view = (
    searchParams.view && searchParams.view in LR_VIEW_META ? searchParams.view : "TOTAL"
  ) as LrView;

  const { parties, cities, vehicles } = await withTenant(session.tenantId, async (tx) => {
    const [parties, cities, vehicles] = await Promise.all([
      tx.party.findMany({
        select: { id: true, name: true, ownerName: true, transportName: true, alias: true },
        orderBy: { name: "asc" },
      }),
      tx.city.findMany({ select: { id: true, name: true }, orderBy: { name: "asc" } }),
      tx.vehicle.findMany({ select: { id: true, number: true }, orderBy: { number: "asc" } }),
    ]);
    return { parties, cities, vehicles };
  });

  return (
    <LrDetailClient
      view={view}
      parties={parties.map((p) => ({
        id: p.id,
        name: p.name,
        // searchable like chalan entry: typing the owner or transport name finds the party
        meta: [p.ownerName, p.transportName, p.alias].filter(Boolean).join(" · ") || undefined,
      }))}
      cities={cities}
      vehicles={vehicles.map((v) => ({ id: v.id, name: v.number }))}
    />
  );
}
