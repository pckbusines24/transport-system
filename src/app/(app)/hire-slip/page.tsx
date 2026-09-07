import type { Prisma } from "@prisma/client";
import { requireSession } from "@/lib/session";
import { authorize } from "@/lib/authz";
import { withTenant } from "@/lib/db";
import { formatDate, toNum } from "@/lib/utils";
import { DocModule } from "@/components/data/doc-module";
import { PaginationBar, parsePage } from "@/components/data/pagination-bar";
import { saveHireSlip, deleteHireSlip } from "./actions";

const PAGE_SIZE = 100;

export const dynamic = "force-dynamic";

export default async function HireSlipPage({
  searchParams,
}: {
  searchParams: Record<string, string | undefined>;
}) {
  const session = requireSession();
  await authorize(session, "hireslip", "view");

  const page = parsePage(searchParams.page);
  const { rows, total, totals, vehicles, cities } = await withTenant(session.tenantId, async (tx) => {
    const where: Prisma.HireSlipWhereInput = {
      firmId: session.firmId,
      fyId: session.fyId,
      deletedAt: null,
    };
    if (searchParams.vehicle) where.vehicleId = searchParams.vehicle;
    if (searchParams.date_from || searchParams.date_to) {
      where.slipDate = {
        ...(searchParams.date_from ? { gte: new Date(searchParams.date_from + "T00:00:00") } : {}),
        ...(searchParams.date_to ? { lte: new Date(searchParams.date_to + "T23:59:59") } : {}),
      };
    }
    const [rows, total, agg, vehicles, cities] = await Promise.all([
      tx.hireSlip.findMany({
        where,
        orderBy: [{ slipDate: "desc" }, { slipNo: "desc" }],
        take: PAGE_SIZE,
        skip: (page - 1) * PAGE_SIZE,
      }),
      tx.hireSlip.count({ where }),
      // footer totals over the FULL filtered set — the table only gets one page
      tx.hireSlip.aggregate({
        where,
        _sum: { lorryHire: true, totalHire: true, advance: true, balance: true },
      }),
      tx.vehicle.findMany({
        where: { isActive: true },
        orderBy: { number: "asc" },
        select: { id: true, number: true },
      }),
      tx.city.findMany({ orderBy: { name: "asc" }, select: { id: true, name: true } }),
    ]);
    const totals = {
      lorryHire: toNum(agg._sum.lorryHire),
      totalHire: toNum(agg._sum.totalHire),
      advance: toNum(agg._sum.advance),
      balance: toNum(agg._sum.balance),
    };
    return { rows, total, totals, vehicles, cities };
  });

  const vehicleById = new Map(vehicles.map((v) => [v.id, v.number]));
  const cityById = new Map(cities.map((c) => [c.id, c.name]));
  const cityOptions = cities.map((c) => ({ value: c.id, label: c.name }));
  const n = (v: unknown) => toNum(String(v));

  return (
    <>
      <DocModule
        title="Hire Slip"
      exportName="hire-slips"
      canDelete={session.role === "ADMIN" || session.role === "OWNER"}
      save={saveHireSlip}
      remove={deleteHireSlip}
      refKind="hireSlip"
      rows={rows.map((r) => ({
        id: r.id,
        slipNo: r.slipNo,
        slipDate: formatDate(r.slipDate),
        vehicleId: r.vehicleId,
        vehicleNumber: (r.vehicleId && vehicleById.get(r.vehicleId)) || "",
        ownerName: r.ownerName ?? "",
        ownerPan: r.ownerPan ?? "",
        brokerName: r.brokerName ?? "",
        driverName: r.driverName ?? "",
        driverMobile: r.driverMobile ?? "",
        licenseNo: r.licenseNo ?? "",
        product: r.product ?? "",
        form15: r.form15 ?? "",
        via: r.via ?? "",
        payableAt: r.payableAt ?? "",
        chalanNo: r.chalanNo ?? "",
        sourceCityId: r.sourceCityId,
        sourceName: (r.sourceCityId && cityById.get(r.sourceCityId)) || "",
        destCityId: r.destCityId,
        destName: (r.destCityId && cityById.get(r.destCityId)) || "",
        totalPkgs: n(r.totalPkgs),
        actualWt: n(r.actualWt),
        guaranteeWt: n(r.guaranteeWt),
        ratePmt: n(r.ratePmt),
        lorryHire: n(r.lorryHire),
        loadingH: n(r.loadingH),
        craneCharge: n(r.craneCharge),
        unloadingH: n(r.unloadingH),
        overHeightCharge: n(r.overHeightCharge),
        others: n(r.others),
        lessTds: n(r.lessTds),
        lessSc: n(r.lessSc),
        totalHire: n(r.totalHire),
        advance: n(r.advance),
        balance: n(r.balance),
        narration: r.narration ?? "",
      }))}
      columns={[
        { key: "slipNo", header: "Slip No" },
        { key: "slipDate", header: "Date" },
        { key: "vehicleNumber", header: "Vehicle" },
        { key: "ownerName", header: "Owner" },
        { key: "sourceName", header: "From" },
        { key: "destName", header: "To" },
        { key: "lorryHire", header: "Lorry Hire", kind: "money" },
        { key: "totalHire", header: "Total Hire", kind: "money" },
        { key: "advance", header: "Advance", kind: "money" },
        { key: "balance", header: "Balance", kind: "money" },
      ]}
      filters={[
        { type: "daterange", key: "date", label: "Slip Date" },
        {
          type: "combobox",
          key: "vehicle",
          label: "Vehicle",
          options: vehicles.map((v) => ({ value: v.id, label: v.number })),
        },
      ]}
      fields={[
        { name: "slipNo", label: "Slip No (blank = auto)", type: "text" },
        { name: "slipDate", label: "Slip Date *", type: "date" },
        {
          name: "vehicleId",
          label: "Vehicle",
          type: "combobox",
          options: vehicles.map((v) => ({ value: v.id, label: v.number })),
        },
        { name: "ownerName", label: "Owner Name", type: "text" },
        { name: "ownerPan", label: "Owner PAN", type: "text", uppercase: true },
        { name: "brokerName", label: "Broker Name", type: "text" },
        { name: "driverName", label: "Driver", type: "text" },
        { name: "driverMobile", label: "Driver Mobile", type: "text" },
        { name: "licenseNo", label: "License No", type: "text" },
        { name: "product", label: "Product", type: "text" },
        { name: "via", label: "Via", type: "text" },
        { name: "payableAt", label: "Payable At", type: "text" },
        { name: "chalanNo", label: "Chalan No", type: "text" },
        { name: "sourceCityId", label: "From", type: "combobox", options: cityOptions },
        { name: "destCityId", label: "To", type: "combobox", options: cityOptions },
        { name: "totalPkgs", label: "Total Pkgs", type: "number" },
        { name: "actualWt", label: "Actual Wt", type: "number" },
        { name: "guaranteeWt", label: "Guarantee Wt", type: "number" },
        { name: "ratePmt", label: "Rate / MT", type: "number" },
        { name: "lorryHire", label: "Lorry Hire", type: "number" },
        { name: "loadingH", label: "Loading Hamali", type: "number" },
        { name: "craneCharge", label: "Crane Charge", type: "number" },
        { name: "unloadingH", label: "Unloading Hamali", type: "number" },
        { name: "overHeightCharge", label: "Over-Height Charge", type: "number" },
        { name: "others", label: "Others", type: "number" },
        { name: "lessTds", label: "Less: TDS", type: "number" },
        { name: "lessSc", label: "Less: SC", type: "number" },
        { name: "advance", label: "Advance", type: "number" },
        { name: "narration", label: "Narration", type: "textarea", span2: true },
      ]}
      defaults={{ slipNo: "", slipDate: formatDate(new Date()) }}
      numericFields={[
        "totalPkgs",
        "actualWt",
        "guaranteeWt",
        "ratePmt",
        "lorryHire",
        "loadingH",
        "craneCharge",
        "unloadingH",
        "overHeightCharge",
        "others",
        "lessTds",
        "lessSc",
        "advance",
      ]}
      totals={totals}
      />
      <div className="px-4 pb-4">
        <PaginationBar
          page={page}
          pageSize={PAGE_SIZE}
          total={total}
          basePath="/hire-slip"
          searchParams={searchParams}
        />
      </div>
    </>
  );
}
