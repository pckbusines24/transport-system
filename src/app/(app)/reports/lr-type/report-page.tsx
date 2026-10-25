import type { LrType, Prisma } from "@prisma/client";
import { requireSession } from "@/lib/session";
import { withTenant } from "@/lib/db";
import { formatDate, toNum } from "@/lib/utils";
import { FilterBar, type FilterDef } from "@/components/data/filter-bar";
import {
  LrTypeReportTable,
  type LrTypeReportRow,
} from "@/components/lr/lr-type-report-table";
import { rankByMatch } from "@/lib/search-rank";

/**
 * Shared audit report for non-operational LR types (Cancelled / Paper Change).
 * These LRs are excluded from every count, freight total and financial report;
 * this page is the only place they appear.
 */
export async function LrTypeReportPage({
  lrType,
  title,
  fileName,
  searchParams,
}: {
  lrType: LrType;
  title: string;
  fileName: string;
  searchParams: { date_from?: string; date_to?: string; q?: string };
}) {
  const session = requireSession();
  const canDelete = session.role === "ADMIN" || session.role === "OWNER";

  const rows: LrTypeReportRow[] = await withTenant(session.tenantId, async (tx) => {
    const where: Prisma.LrWhereInput = {
      firmId: session.firmId,
      fyId: session.fyId,
      deletedAt: null,
      lrType,
    };
    if (searchParams.q) where.lrNo = { contains: searchParams.q, mode: "insensitive" };
    if (searchParams.date_from || searchParams.date_to) {
      where.lrDate = {
        ...(searchParams.date_from ? { gte: new Date(`${searchParams.date_from}T00:00:00`) } : {}),
        ...(searchParams.date_to ? { lte: new Date(`${searchParams.date_to}T23:59:59`) } : {}),
      };
    }
    const [lrs, cities, parties, vehicles] = await Promise.all([
      tx.lr.findMany({ where, include: { items: true }, orderBy: { lrDate: "desc" } })
      // exact match on the typed search first
      .then((rows) => rankByMatch(rows, searchParams.q ?? "", (r) => r.lrNo)),
      tx.city.findMany(),
      tx.party.findMany(),
      tx.vehicle.findMany(),
    ]);
    const city = new Map(cities.map((c) => [c.id, c.name]));
    const party = new Map(parties.map((p) => [p.id, p.name]));
    const vehicle = new Map(vehicles.map((v) => [v.id, v.number]));
    return lrs.map((lr) => ({
      // the id drives the row's edit / print / delete actions
      id: lr.id,
      lrNo: lr.lrNo,
      lrDate: formatDate(lr.lrDate),
      route: `${city.get(lr.sourceCityId) ?? ""} → ${city.get(lr.destCityId) ?? ""}`,
      consignor: party.get(lr.consignorId) ?? "",
      consignee: party.get(lr.consigneeId) ?? "",
      vehicle: (lr.vehicleId && vehicle.get(lr.vehicleId)) || lr.vehicleText || "",
      qty: lr.items.reduce((s, i) => s + toNum(i.qty), 0),
      chargeWt: lr.items.reduce((s, i) => s + toNum(i.chargeWt), 0),
      freight: toNum(lr.freight),
      grandTotal: toNum(lr.grandTotal),
      remarks: lr.remarks ?? "",
    }));
  });

  const filters: FilterDef[] = [
    { type: "daterange", key: "date", label: "LR Date" },
    { type: "text", key: "q", label: "LR No" },
  ];

  return (
    <div className="space-y-4 p-4">
      <div>
        <h1 className="page-title">{title}</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          These LRs are excluded from all operational, freight and profit &amp; loss figures —
          this report exists for audit and tracking only.
        </p>
      </div>
      <FilterBar filters={filters} />
      <LrTypeReportTable
        rows={rows}
        fileName={fileName}
        emptyMessage={`No ${title.toLowerCase()} found.`}
        canDelete={canDelete}
      />
    </div>
  );
}
