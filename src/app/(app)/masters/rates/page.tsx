import { partyMeta } from "@/lib/party-option";
import type { Prisma } from "@prisma/client";
import { requireSession } from "@/lib/session";
import { authorize } from "@/lib/authz";
import { withTenant } from "@/lib/db";
import { toNum } from "@/lib/utils";
import { RatesClient } from "@/components/masters/rates-client";
import { PaginationBar, parsePage } from "@/components/data/pagination-bar";

const PAGE_SIZE = 100;

export const dynamic = "force-dynamic";

export default async function RatesPage({
  searchParams,
}: {
  searchParams: Record<string, string | undefined>;
}) {
  const session = requireSession();
  await authorize(session, "masters", "view");

  const page = parsePage(searchParams.page);
  const { rows, total, parties, products, cities } = await withTenant(session.tenantId, async (tx) => {
    const where: Prisma.RateMasterWhereInput = {};
    if (searchParams.party) where.partyId = searchParams.party;
    if (searchParams.source) where.sourceCityId = searchParams.source;
    if (searchParams.dest) where.destCityId = searchParams.dest;
    const [rows, total, parties, products, cities] = await Promise.all([
      // RateMaster has no party relation, so the DB cannot sort by party
      // name; group deterministically by party instead so pages are stable
      tx.rateMaster.findMany({
        where,
        orderBy: [{ partyId: "asc" }, { sourceCityId: "asc" }, { destCityId: "asc" }, { id: "asc" }],
        take: PAGE_SIZE,
        skip: (page - 1) * PAGE_SIZE,
      }),
      tx.rateMaster.count({ where }),
      tx.party.findMany({
        where: { isActive: true },
        orderBy: { name: "asc" },
        select: { id: true, name: true, transportName: true, alias: true },
      }),
      tx.product.findMany({ orderBy: { name: "asc" }, select: { id: true, name: true } }),
      tx.city.findMany({ orderBy: { name: "asc" }, select: { id: true, name: true } }),
    ]);
    return { rows, total, parties, products, cities };
  });

  const partyById = new Map(parties.map((p) => [p.id, p.name]));
  const productById = new Map(products.map((p) => [p.id, p.name]));
  const cityById = new Map(cities.map((c) => [c.id, c.name]));

  const canDelete = session.role === "ADMIN" || session.role === "OWNER";
  const n = (v: unknown) => toNum(String(v));
  return (
    <>
    <RatesClient
      rows={rows
        .map((r) => ({
          id: r.id,
          partyId: r.partyId,
          partyName: partyById.get(r.partyId) ?? "",
          // legacy single-product rows fold into the array view
          productIds: r.productIds.length ? r.productIds : r.productId ? [r.productId] : [],
          productNames: (r.productIds.length ? r.productIds : r.productId ? [r.productId] : [])
            .map((id) => productById.get(id) ?? "?")
            .sort(),
          sourceCityId: r.sourceCityId,
          sourceName: cityById.get(r.sourceCityId) ?? "",
          destCityId: r.destCityId,
          destName: cityById.get(r.destCityId) ?? "",
          rate: n(r.rate),
          rateBasis: r.rateBasis,
          hamali: n(r.hamali),
          hamaliBasis: r.hamaliBasis,
          preBhada: n(r.preBhada),
          preBhadaBasis: r.preBhadaBasis,
          dCharge: n(r.dCharge),
          dChargeBasis: r.dChargeBasis,
          stationery: n(r.stationery),
          stationeryBasis: r.stationeryBasis,
          crossing: n(r.crossing),
          crossingBasis: r.crossingBasis,
        }))
        .sort((a, b) => a.partyName.localeCompare(b.partyName))}
      partyOptions={parties.map((p) => ({ value: p.id, label: p.name, meta: partyMeta(p) }))}
      productOptions={products.map((p) => ({ value: p.id, label: p.name }))}
      cityOptions={cities.map((c) => ({ value: c.id, label: c.name }))}
      canDelete={canDelete}
    />
    <div className="px-4 pb-4">
      <PaginationBar
        page={page}
        pageSize={PAGE_SIZE}
        total={total}
        basePath="/masters/rates"
        searchParams={searchParams}
      />
    </div>
    </>
  );
}
