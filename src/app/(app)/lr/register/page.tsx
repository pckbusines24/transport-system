import { partyMeta } from "@/lib/party-option";
import Link from "next/link";
import type { Prisma } from "@prisma/client";
import { requireSession } from "@/lib/session";
import { authorize } from "@/lib/authz";
import { Button } from "@/components/ui/button";
import { withTenant } from "@/lib/db";
import { formatDate, toNum } from "@/lib/utils";
import { FilterBar, type FilterDef } from "@/components/data/filter-bar";
import { PaginationBar, parsePage } from "@/components/data/pagination-bar";
import { LrRegisterTable, type LrRegisterRow } from "@/components/lr/lr-register-table";

const PAGE_SIZE = 100;

export const dynamic = "force-dynamic";

const LR_TYPES = ["TO_PAY", "TBB", "PAID", "FOC"] as const;
// CANCELLED and PAPER_CHANGE live only in their dedicated reports
const LR_STATUSES = ["PENDING", "ON_CHALAN", "ARRIVED", "DELIVERED", "BILLED"] as const;

export default async function LrRegisterPage({
  searchParams,
}: {
  searchParams: Record<string, string | undefined>;
}) {
  const session = requireSession();
  await authorize(session, "lr", "view");
  const canDelete = session.role === "ADMIN" || session.role === "OWNER";

  // date filter beats FY (FY continuity): no dates → this year's register;
  // dates set → that period from ANY year, no FY switch needed
  const where: Prisma.LrWhereInput = {
    firmId: session.firmId,
    ...(searchParams.date_from || searchParams.date_to ? {} : { fyId: session.fyId }),
    deletedAt: null,
  };
  if (searchParams.q) {
    where.OR = [
      { lrNo: { contains: searchParams.q, mode: "insensitive" } },
      { refLrNo: { contains: searchParams.q, mode: "insensitive" } },
      { privateMarka: { contains: searchParams.q, mode: "insensitive" } },
    ];
  }
  if (searchParams.date_from || searchParams.date_to) {
    where.lrDate = {
      ...(searchParams.date_from ? { gte: new Date(`${searchParams.date_from}T00:00:00`) } : {}),
      ...(searchParams.date_to ? { lte: new Date(`${searchParams.date_to}T23:59:59`) } : {}),
    };
  }
  if (searchParams.source) where.sourceCityId = searchParams.source;
  if (searchParams.dest) where.destCityId = searchParams.dest;
  if (searchParams.lrType && (LR_TYPES as readonly string[]).includes(searchParams.lrType)) {
    where.lrType = searchParams.lrType as (typeof LR_TYPES)[number];
  } else {
    where.lrType = { notIn: ["CANCELLED", "PAPER_CHANGE"] };
  }
  if (searchParams.party) {
    where.AND = [
      {
        OR: [
          { consignorId: searchParams.party },
          { consigneeId: searchParams.party },
          { billToId: searchParams.party },
        ],
      },
    ];
  }
  if (searchParams.vehicle) where.vehicleId = searchParams.vehicle;
  if (searchParams.obd) where.obdNo = { contains: searchParams.obd, mode: "insensitive" };
  if (searchParams.status && (LR_STATUSES as readonly string[]).includes(searchParams.status)) {
    where.status = searchParams.status as (typeof LR_STATUSES)[number];
  }

  const page = parsePage(searchParams.page);
  const { lrs, total, totals, cities, parties, vehicles } = await withTenant(session.tenantId, async (tx) => {
    const [lrs, total, freightAgg, wtAgg, cities, parties, vehicles, partyMap] = await Promise.all([
      tx.lr.findMany({
        where,
        include: { items: true },
        orderBy: [{ lrDate: "desc" }, { lrNo: "desc" }],
        take: PAGE_SIZE,
        skip: (page - 1) * PAGE_SIZE,
      }),
      tx.lr.count({ where }),
      // register-wide totals over the full filtered set — the table only
      // receives one page of rows, so it cannot compute these itself
      tx.lr.aggregate({ where, _sum: { freight: true } }),
      tx.lrItem.aggregate({
        where: { lr: where },
        _sum: { actualWt: true, chargeWt: true },
      }),
      tx.city.findMany({ orderBy: { name: "asc" }, select: { id: true, name: true } }),
      tx.party.findMany({
        where: { ledgerGroup: "CONSIGNEE_CONSIGNOR" },
        orderBy: { name: "asc" },
        select: { id: true, name: true, transportName: true, alias: true },
      }),
      tx.vehicle.findMany({ orderBy: { number: "asc" }, select: { id: true, number: true } }),
      tx.party.findMany({ select: { id: true, name: true } }),
    ]);
    const cityById = new Map(cities.map((c) => [c.id, c.name]));
    const partyById = new Map(partyMap.map((p) => [p.id, p.name]));
    const vehicleById = new Map(vehicles.map((v) => [v.id, v.number]));

    const rows: LrRegisterRow[] = lrs.map((lr) => ({
      id: lr.id,
      lrNo: lr.lrNo,
      lrDate: formatDate(lr.lrDate),
      source: cityById.get(lr.sourceCityId) ?? "",
      dest: cityById.get(lr.destCityId) ?? "",
      consignor: partyById.get(lr.consignorId) ?? "",
      consignee: partyById.get(lr.consigneeId) ?? "",
      billTo: lr.billToId ? partyById.get(lr.billToId) ?? "" : "",
      vehicle: lr.vehicleId ? vehicleById.get(lr.vehicleId) ?? "" : lr.vehicleText ?? "",
      qty: lr.items.reduce((s, i) => s + Number(i.qty), 0),
      actualWt: lr.items.reduce((s, i) => s + Number(i.actualWt), 0),
      chargeWt: lr.items.reduce((s, i) => s + Number(i.chargeWt), 0),
      freight: Number(lr.freight),
      grandTotal: Number(lr.grandTotal),
      lrType: lr.lrType,
      cargoType: lr.cargoType,
      obdNo: lr.obdNo ?? "",
      invoiceNo: lr.invoiceNo ?? "",
      refNo: lr.refNo ?? "",
      product: lr.items.map((i) => i.productName).filter(Boolean).join(", "),
      rate: lr.items.length ? Math.max(...lr.items.map((i) => toNum(i.rate))) : 0,
      status: lr.status,
      isDummy: lr.isDummy,
    }));
    const totals = {
      count: total,
      freight: toNum(freightAgg._sum.freight),
      actualWt: toNum(wtAgg._sum.actualWt),
      chargeWt: toNum(wtAgg._sum.chargeWt),
    };
    return { lrs: rows, total, totals, cities, parties, vehicles };
  });

  const cityOptions = cities.map((c) => ({ value: c.id, label: c.name }));
  const filters: FilterDef[] = [
    { type: "text", key: "q", label: "Search LR / Ref / Marka" },
    { type: "daterange", key: "date", label: "LR Date" },
    { type: "combobox", key: "source", label: "Source", options: cityOptions },
    { type: "combobox", key: "dest", label: "Destination", options: cityOptions },
    {
      type: "select",
      key: "lrType",
      label: "LR Type",
      options: LR_TYPES.map((t) => ({ value: t, label: t.replace("_", " ") })),
    },
    {
      type: "combobox",
      key: "party",
      label: "Party",
      options: parties.map((p) => ({ value: p.id, label: p.name, meta: partyMeta(p) })),
    },
    {
      type: "combobox",
      key: "vehicle",
      label: "Vehicle",
      options: vehicles.map((v) => ({ value: v.id, label: v.number })),
    },
    { type: "text", key: "obd", label: "OBD No" },
    {
      type: "select",
      key: "status",
      label: "Status",
      options: LR_STATUSES.map((s) => ({ value: s, label: s.replace("_", " ") })),
    },
  ];

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold">LR Register</h1>
        <Button asChild size="sm">
          <Link href="/lr">+ New LR</Link>
        </Button>
      </div>
      <FilterBar filters={filters} />
      <LrRegisterTable rows={lrs} canDelete={canDelete} totals={totals} />
      <PaginationBar
        page={page}
        pageSize={PAGE_SIZE}
        total={total}
        basePath="/lr/register"
        searchParams={searchParams}
      />
    </div>
  );
}
