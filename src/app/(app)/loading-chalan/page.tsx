import { partyMeta } from "@/lib/party-option";
import type { Prisma } from "@prisma/client";
import { requireSession } from "@/lib/session";
import { authorize } from "@/lib/authz";
import { withTenant } from "@/lib/db";
import { formatDate, toNum } from "@/lib/utils";
import { DocModule } from "@/components/data/doc-module";
import { PaginationBar, parsePage } from "@/components/data/pagination-bar";
import { saveLoadingChalan, deleteLoadingChalan } from "./actions";

const PAGE_SIZE = 100;

export const dynamic = "force-dynamic";

export default async function LoadingChalanPage({
  searchParams,
}: {
  searchParams: Record<string, string | undefined>;
}) {
  const session = requireSession();
  await authorize(session, "loading", "view");

  const page = parsePage(searchParams.page);
  const { rows, total, totals, vehicles, brokers, cities } = await withTenant(
    session.tenantId,
    async (tx) => {
      const where: Prisma.LoadingChalanWhereInput = {
        firmId: session.firmId,
        fyId: session.fyId,
        deletedAt: null,
      };
      if (searchParams.vehicle) where.vehicleId = searchParams.vehicle;
      if (searchParams.date_from || searchParams.date_to) {
        where.chalanDate = {
          ...(searchParams.date_from ? { gte: new Date(searchParams.date_from + "T00:00:00") } : {}),
          ...(searchParams.date_to ? { lte: new Date(searchParams.date_to + "T23:59:59") } : {}),
        };
      }
      const [rows, total, agg, vehicles, brokers, cities] = await Promise.all([
        tx.loadingChalan.findMany({
          where,
          orderBy: [{ chalanDate: "desc" }, { chalanNo: "desc" }],
          take: PAGE_SIZE,
          skip: (page - 1) * PAGE_SIZE,
        }),
        tx.loadingChalan.count({ where }),
        // footer totals over the FULL filtered set — the table only gets one page
        tx.loadingChalan.aggregate({
          where,
          _sum: { totFreight: true, truckFreight: true, advance: true, netAmount: true },
        }),
        tx.vehicle.findMany({
          where: { isActive: true },
          orderBy: { number: "asc" },
          select: { id: true, number: true },
        }),
        tx.party.findMany({
          where: { isActive: true, ledgerGroup: { in: ["OWNER_BROKER", "RELATIVE"] } },
          orderBy: { name: "asc" },
          select: { id: true, name: true, transportName: true, alias: true },
        }),
        tx.city.findMany({ orderBy: { name: "asc" }, select: { id: true, name: true } }),
      ]);
      const totals = {
        totFreight: toNum(agg._sum.totFreight),
        truckFreight: toNum(agg._sum.truckFreight),
        advance: toNum(agg._sum.advance),
        netAmount: toNum(agg._sum.netAmount),
      };
      return { rows, total, totals, vehicles, brokers, cities };
    }
  );

  const vehicleById = new Map(vehicles.map((v) => [v.id, v.number]));
  const cityById = new Map(cities.map((c) => [c.id, c.name]));
  const vehicleOptions = vehicles.map((v) => ({ value: v.id, label: v.number }));
  const brokerOptions = brokers.map((b) => ({ value: b.id, label: b.name, meta: partyMeta(b) }));
  const cityOptions = cities.map((c) => ({ value: c.id, label: c.name }));
  const n = (v: unknown) => toNum(String(v));

  return (
    <>
      <DocModule
      title="Loading Challan"
      exportName="loading-chalans"
      canDelete={session.role === "ADMIN" || session.role === "OWNER"}
      save={saveLoadingChalan}
      remove={deleteLoadingChalan}
      refKind="loadingChalan"
      rows={rows.map((r) => ({
        id: r.id,
        chalanNo: r.chalanNo,
        chalanDate: formatDate(r.chalanDate),
        type: r.type,
        vehicleId: r.vehicleId,
        vehicleNumber: (r.vehicleId && vehicleById.get(r.vehicleId)) || "",
        driverName: r.driverName ?? "",
        driverMobile: r.driverMobile ?? "",
        licenseNo: r.licenseNo ?? "",
        vehicleOwner: r.vehicleOwner ?? "",
        brokerId: r.brokerId,
        sourceCityId: r.sourceCityId,
        sourceName: (r.sourceCityId && cityById.get(r.sourceCityId)) || "",
        destCityId: r.destCityId,
        destName: (r.destCityId && cityById.get(r.destCityId)) || "",
        remarks: r.remarks ?? "",
        totFreight: n(r.totFreight),
        truckFreight: n(r.truckFreight),
        advance: n(r.advance),
        commAmt: n(r.commAmt),
        lcCharge: n(r.lcCharge),
        dcCharge: n(r.dcCharge),
        cfCharge: n(r.cfCharge),
        totCrossing: n(r.totCrossing),
        netAmount: n(r.netAmount),
      }))}
      columns={[
        { key: "chalanNo", header: "Chalan No" },
        { key: "chalanDate", header: "Date" },
        { key: "type", header: "Type", kind: "badge" },
        { key: "vehicleNumber", header: "Vehicle" },
        { key: "sourceName", header: "From" },
        { key: "destName", header: "To" },
        { key: "totFreight", header: "Total Freight", kind: "money" },
        { key: "truckFreight", header: "Truck Freight", kind: "money" },
        { key: "advance", header: "Advance", kind: "money" },
        { key: "netAmount", header: "Net Amount", kind: "money" },
      ]}
      filters={[
        { type: "daterange", key: "date", label: "Chalan Date" },
        { type: "combobox", key: "vehicle", label: "Vehicle", options: vehicleOptions },
      ]}
      fields={[
        { name: "chalanNo", label: "Chalan No (blank = auto)", type: "text" },
        { name: "chalanDate", label: "Chalan Date *", type: "date" },
        {
          name: "type",
          label: "Type",
          type: "radio",
          options: [
            { value: "DIRECT", label: "Direct" },
            { value: "CROSSING", label: "Crossing" },
          ],
        },
        { name: "vehicleId", label: "Vehicle", type: "combobox", options: vehicleOptions },
        { name: "brokerId", label: "Broker / Owner", type: "combobox", options: brokerOptions },
        { name: "vehicleOwner", label: "Owner Name (text)", type: "text" },
        { name: "driverName", label: "Driver", type: "text" },
        { name: "driverMobile", label: "Driver Mobile", type: "text" },
        { name: "licenseNo", label: "License No", type: "text" },
        { name: "sourceCityId", label: "From", type: "combobox", options: cityOptions },
        { name: "destCityId", label: "To", type: "combobox", options: cityOptions },
        { name: "totFreight", label: "Total LR Freight", type: "number" },
        { name: "truckFreight", label: "Truck Freight", type: "number" },
        { name: "advance", label: "Advance", type: "number" },
        { name: "commAmt", label: "Commission", type: "number" },
        { name: "lcCharge", label: "LC Charge", type: "number" },
        { name: "dcCharge", label: "DC Charge", type: "number" },
        { name: "cfCharge", label: "CF Charge", type: "number" },
        { name: "totCrossing", label: "Total Crossing", type: "number" },
        { name: "remarks", label: "Remarks", type: "textarea", span2: true },
      ]}
      defaults={{ chalanNo: "", chalanDate: formatDate(new Date()), type: "DIRECT" }}
      numericFields={[
        "totFreight",
        "truckFreight",
        "advance",
        "commAmt",
        "lcCharge",
        "dcCharge",
        "cfCharge",
        "totCrossing",
      ]}
      totals={totals}
      />
      <div className="px-4 pb-4">
        <PaginationBar
          page={page}
          pageSize={PAGE_SIZE}
          total={total}
          basePath="/loading-chalan"
          searchParams={searchParams}
        />
      </div>
    </>
  );
}
