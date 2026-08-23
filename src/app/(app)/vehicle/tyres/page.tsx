import type { Prisma } from "@prisma/client";
import { requireSession } from "@/lib/session";
import { authorize } from "@/lib/authz";
import { withTenant } from "@/lib/db";
import { toNum } from "@/lib/utils";
import { TyreClient, type TyreRow } from "@/components/vehicle/tyre-client";
import { PaginationBar, parsePage } from "@/components/data/pagination-bar";

const PAGE_SIZE = 100;

export const dynamic = "force-dynamic";

/** total-KM range classification, updates automatically as the tyre runs */
function kmRange(totalKm: number): string {
  if (totalKm <= 25000) return "1 – 25,000 KM";
  if (totalKm <= 50000) return "25,001 – 50,000 KM";
  if (totalKm <= 75000) return "50,001 – 75,000 KM";
  if (totalKm <= 100000) return "75,001 – 100,000 KM";
  return "Above 100,000 KM";
}

const DAY = 86400000;

export default async function TyresPage({
  searchParams,
}: {
  searchParams: Record<string, string | undefined>;
}) {
  const session = requireSession();
  await authorize(session, "tyre", "view");

  const page = parsePage(searchParams.page);
  const { tyres, total, tyreNames, vehicles } = await withTenant(session.tenantId, async (tx) => {
    const where: Prisma.TyreWhereInput = { firmId: session.firmId };
    if (searchParams.q) {
      where.tyreNo = { contains: searchParams.q.replace(/\s+/g, ""), mode: "insensitive" };
    }
    if (searchParams.name) where.tyreName = searchParams.name;
    if (searchParams.status === "RUNNING" || searchParams.status === "REMOVED") {
      where.status = searchParams.status;
    }
    // vehicle / position match ANY cycle so history is searchable
    if (searchParams.vehicle || searchParams.position) {
      where.cycles = {
        some: {
          ...(searchParams.vehicle ? { vehicleId: searchParams.vehicle } : {}),
          ...(searchParams.position === "HORSE" || searchParams.position === "TRAILER"
            ? { position: searchParams.position }
            : {}),
        },
      };
    }
    if (searchParams.date_from || searchParams.date_to) {
      where.cycles = {
        some: {
          ...((where.cycles as { some?: object } | undefined)?.some ?? {}),
          instDate: {
            ...(searchParams.date_from
              ? { gte: new Date(searchParams.date_from + "T00:00:00") }
              : {}),
            ...(searchParams.date_to ? { lte: new Date(searchParams.date_to + "T23:59:59") } : {}),
          },
        },
      };
    }
    const [tyres, total, nameRows, vehicles] = await Promise.all([
      tx.tyre.findMany({
        where,
        include: { cycles: { orderBy: { instDate: "asc" } } },
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        take: PAGE_SIZE,
        skip: (page - 1) * PAGE_SIZE,
      }),
      tx.tyre.count({ where }),
      // Tyre Name filter options come from the FULL filtered set, not the page
      tx.tyre.findMany({ where, select: { tyreName: true }, distinct: ["tyreName"] }),
      tx.vehicle.findMany({ where: { isActive: true }, orderBy: { number: "asc" }, select: { id: true, number: true } }),
    ]);
    return { tyres, total, tyreNames: nameRows.map((r) => r.tyreName), vehicles };
  });

  const vehicleNo = new Map(vehicles.map((v) => [v.id, v.number]));
  const today = new Date();

  const rows: TyreRow[] = tyres.map((t) => {
    let totalKm = 0;
    let totalDays = 0;
    const cycles = t.cycles.map((c) => {
      const instKm = toNum(String(c.instKm));
      const remKm = c.removalKm == null ? null : toNum(String(c.removalKm));
      const runKm = remKm != null ? Math.max(0, remKm - instKm) : 0;
      const endDate = c.removalDate ?? today;
      const runDays = Math.max(0, Math.round((endDate.getTime() - c.instDate.getTime()) / DAY));
      totalKm += runKm;
      totalDays += runDays;
      return {
        vehicle: vehicleNo.get(c.vehicleId) ?? "",
        position: c.position,
        instDate: c.instDate.toISOString(),
        instKm,
        removalDate: c.removalDate ? c.removalDate.toISOString() : null,
        removalKm: remKm,
        removalReason: c.removalReason ?? "",
        remarks: c.remarks ?? "",
        runKm,
        runDays,
      };
    });
    const open = t.cycles.find((c) => !c.removalDate);
    return {
      id: t.id,
      tyreNo: t.tyreNo,
      tyreName: t.tyreName,
      status: t.status,
      currentVehicle: open ? vehicleNo.get(open.vehicleId) ?? "" : "",
      currentPosition: open?.position ?? "",
      firstInstDate: t.cycles[0]?.instDate.toISOString() ?? "",
      vehicleCount: new Set(t.cycles.map((c) => c.vehicleId)).size,
      totalKm,
      totalDays,
      kmRange: kmRange(totalKm),
      cycles,
    };
  });

  const nameOptions = [...tyreNames].sort();

  return (
    <div className="space-y-4 p-4">
      <TyreClient
        rows={rows}
        vehicleOptions={vehicles.map((v) => ({ value: v.id, label: v.number }))}
        tyreNames={nameOptions}
        canEdit={true}
        canDelete={session.role === "ADMIN" || session.role === "OWNER"}
      />
      <PaginationBar
        page={page}
        pageSize={PAGE_SIZE}
        total={total}
        basePath="/vehicle/tyres"
        searchParams={searchParams}
      />
    </div>
  );
}
