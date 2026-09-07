import type { Prisma } from "@prisma/client";
import { requireSession } from "@/lib/session";
import { authorize } from "@/lib/authz";
import { withTenant } from "@/lib/db";
import { formatDate, toNum } from "@/lib/utils";
import { DocModule } from "@/components/data/doc-module";
import { saveSummary, deleteSummary } from "./actions";

export const dynamic = "force-dynamic";

export default async function SummaryPage({
  searchParams,
}: {
  searchParams: { date_from?: string; date_to?: string; vehicle?: string };
}) {
  const session = requireSession();
  await authorize(session, "summary", "view");

  const { rows, vehicles, cities } = await withTenant(session.tenantId, async (tx) => {
    const where: Prisma.SettlementSummaryWhereInput = {
      firmId: session.firmId,
      fyId: session.fyId,
      deletedAt: null,
    };
    if (searchParams.vehicle) where.vehicleId = searchParams.vehicle;
    if (searchParams.date_from || searchParams.date_to) {
      where.summaryDate = {
        ...(searchParams.date_from ? { gte: new Date(searchParams.date_from + "T00:00:00") } : {}),
        ...(searchParams.date_to ? { lte: new Date(searchParams.date_to + "T23:59:59") } : {}),
      };
    }
    const [rows, vehicles, cities] = await Promise.all([
      tx.settlementSummary.findMany({ where, orderBy: [{ summaryDate: "desc" }, { summaryNo: "desc" }] }),
      tx.vehicle.findMany({ where: { isActive: true }, orderBy: { number: "asc" } }),
      tx.city.findMany({ orderBy: { name: "asc" } }),
    ]);
    return { rows, vehicles, cities };
  });

  const vehicleById = new Map(vehicles.map((v) => [v.id, v.number]));
  const cityById = new Map(cities.map((c) => [c.id, c.name]));
  const cityOptions = cities.map((c) => ({ value: c.id, label: c.name }));
  const n = (v: unknown) => toNum(String(v));

  return (
    <DocModule
      title="Summary Entry (Settlement)"
      newLabel="New Summary"
      exportName="settlement-summaries"
      canDelete={session.role === "ADMIN" || session.role === "OWNER"}
      save={saveSummary}
      remove={deleteSummary}
      refKind="summary"
      rows={rows.map((r) => ({
        id: r.id,
        summaryNo: r.summaryNo,
        summaryDate: formatDate(r.summaryDate),
        chalanNo: r.chalanNo ?? "",
        chalanDate: r.chalanDate ? formatDate(r.chalanDate) : "",
        vehicleId: r.vehicleId,
        vehicleNumber: (r.vehicleId && vehicleById.get(r.vehicleId)) || "",
        sourceCityId: r.sourceCityId,
        sourceName: (r.sourceCityId && cityById.get(r.sourceCityId)) || "",
        destCityId: r.destCityId,
        destName: (r.destCityId && cityById.get(r.destCityId)) || "",
        remarks: r.remarks ?? "",
        deliveryAmt: n(r.deliveryAmt),
        crossingAmt: n(r.crossingAmt),
        delCommPct: n(r.delCommPct),
        delCharges: n(r.delCharges),
        crossingFreight: n(r.crossingFreight),
        truckFreight: n(r.truckFreight),
        unloadCharges: n(r.unloadCharges),
        doorDelivery: n(r.doorDelivery),
        totPartA: n(r.totPartA),
        totPartB: n(r.totPartB),
        balance: n(r.balance),
      }))}
      columns={[
        { key: "summaryNo", header: "Summary No" },
        { key: "summaryDate", header: "Date" },
        { key: "chalanNo", header: "Chalan No" },
        { key: "vehicleNumber", header: "Vehicle" },
        { key: "sourceName", header: "From" },
        { key: "destName", header: "To" },
        { key: "totPartA", header: "Part A (Collected)", kind: "money" },
        { key: "totPartB", header: "Part B (Payable)", kind: "money" },
        { key: "balance", header: "Balance", kind: "money" },
      ]}
      filters={[
        { type: "daterange", key: "date", label: "Summary Date" },
        {
          type: "combobox",
          key: "vehicle",
          label: "Vehicle",
          options: vehicles.map((v) => ({ value: v.id, label: v.number })),
        },
      ]}
      fields={[
        { name: "summaryNo", label: "Summary No (blank = auto)", type: "text" },
        { name: "summaryDate", label: "Summary Date *", type: "date" },
        { name: "chalanNo", label: "Chalan No", type: "text" },
        { name: "chalanDate", label: "Chalan Date", type: "date" },
        {
          name: "vehicleId",
          label: "Vehicle",
          type: "combobox",
          options: vehicles.map((v) => ({ value: v.id, label: v.number })),
        },
        { name: "sourceCityId", label: "From", type: "combobox", options: cityOptions },
        { name: "destCityId", label: "To", type: "combobox", options: cityOptions },
        { name: "deliveryAmt", label: "Delivery Amount (A)", type: "number" },
        { name: "crossingAmt", label: "Crossing Amount (A)", type: "number" },
        { name: "delCommPct", label: "Delivery Comm % (−A)", type: "number" },
        { name: "delCharges", label: "Delivery Charges (−A)", type: "number" },
        { name: "crossingFreight", label: "Crossing Freight (B)", type: "number" },
        { name: "truckFreight", label: "Truck Freight (B)", type: "number" },
        { name: "unloadCharges", label: "Unload Charges (B)", type: "number" },
        { name: "doorDelivery", label: "Door Delivery (B)", type: "number" },
        { name: "remarks", label: "Remarks", type: "textarea", span2: true },
      ]}
      defaults={{ summaryNo: "", summaryDate: formatDate(new Date()) }}
      numericFields={[
        "deliveryAmt",
        "crossingAmt",
        "delCommPct",
        "delCharges",
        "crossingFreight",
        "truckFreight",
        "unloadCharges",
        "doorDelivery",
      ]}
    />
  );
}
