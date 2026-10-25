import { requireSession } from "@/lib/session";
import { authorize } from "@/lib/authz";
import { withTenant } from "@/lib/db";
import { VehiclesClient } from "@/components/masters/vehicles-client";
import { rankByMatch } from "@/lib/search-rank";

export default async function VehiclesPage({
  searchParams,
}: {
  searchParams: { q?: string; own?: string };
}) {
  const session = requireSession();
  await authorize(session, "masters", "view");
  const q = searchParams.q?.trim();
  const own = searchParams.own;

  const { rows, owners } = await withTenant(session.tenantId, async (tx) => {
    const rows = await tx.vehicle.findMany({
      where: {
        isActive: true,
        ...(q ? { number: { contains: q, mode: "insensitive" } } : {}),
        ...(own === "OWN" ? { isOwn: true } : own === "MARKET" ? { isOwn: false } : {}),
      },
      include: { owner: true },
      orderBy: { number: "asc" },
    })
      // exact match on the typed search first
      .then((rows) => rankByMatch(rows, q ?? "", (r) => r.number));
    // unified person list — Owner / Broker / Relative are just ownership types;
    // legacy RELATIVE-group parties remain selectable alongside OWNER_BROKER ones
    const owners = await tx.party.findMany({
      where: { isActive: true, ledgerGroup: { in: ["OWNER_BROKER", "RELATIVE"] } },
      orderBy: { name: "asc" },
    });
    return { rows, owners };
  });

  const canDelete = session.role === "ADMIN" || session.role === "OWNER";
  return (
    <VehiclesClient
      rows={rows.map((r) => ({
        id: r.id,
        number: r.number,
        isOwn: r.isOwn,
        ownershipType: r.ownershipType,
        ownerId: r.ownerId,
        ownerName: r.owner?.name ?? null,
        ownerNames: r.ownerNames,
        chassisNo: r.chassisNo,
        engineNo: r.engineNo,
        vehicleType: r.vehicleType,
        permitNo: r.permitNo,
        insuranceNo: r.insuranceNo,
      }))}
      // transport name & alias ride the meta so the search matches them too —
      // "SHARMA ROADWAYS" finds the owner even when his ledger name differs
      ownerOptions={owners.map((p) => ({
        value: p.id,
        label: p.name,
        meta:
          [p.transportName, p.alias, p.pan ?? p.mobile].filter(Boolean).join(" · ") || undefined,
      }))}
      canDelete={canDelete}
    />
  );
}
