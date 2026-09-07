import type { Prisma } from "@prisma/client";
import { requireSession } from "@/lib/session";
import { authorize } from "@/lib/authz";
import { withTenant } from "@/lib/db";
import { formatDate, toNum } from "@/lib/utils";
import { DocModule } from "@/components/data/doc-module";
import { PaginationBar, parsePage } from "@/components/data/pagination-bar";
import { saveCrossing, deleteCrossing } from "./actions";

const PAGE_SIZE = 100;

export const dynamic = "force-dynamic";

export default async function CrossingPage({
  searchParams,
}: {
  searchParams: Record<string, string | undefined>;
}) {
  const session = requireSession();
  await authorize(session, "crossing", "view");

  const page = parsePage(searchParams.page);
  const { rows, total, totalsAgg, transporters, consignees, vehicles, cities } = await withTenant(
    session.tenantId,
    async (tx) => {
      const where: Prisma.CrossingWhereInput = {
        firmId: session.firmId,
        fyId: session.fyId,
        deletedAt: null,
      };
      if (searchParams.transporter) where.transporterId = searchParams.transporter;
      if (searchParams.date_from || searchParams.date_to) {
        where.chalanDate = {
          ...(searchParams.date_from ? { gte: new Date(searchParams.date_from + "T00:00:00") } : {}),
          ...(searchParams.date_to ? { lte: new Date(searchParams.date_to + "T23:59:59") } : {}),
        };
      }
      const [rows, total, totalsAgg, transporters, consignees, vehicles, cities] = await Promise.all([
        tx.crossing.findMany({
          where,
          orderBy: [{ chalanDate: "desc" }, { chalanNo: "desc" }],
          take: PAGE_SIZE,
          skip: (page - 1) * PAGE_SIZE,
        }),
        tx.crossing.count({ where }),
        // register-wide money totals over the FULL filtered set — the table
        // only receives one page of rows, so it cannot compute these itself
        tx.crossing.aggregate({
          where,
          _sum: { freight: true, crossingAmt: true, dcAmt: true, balance: true },
        }),
        tx.party.findMany({ where: { isActive: true, ledgerGroup: { in: ["OWNER_BROKER", "RELATIVE"] } }, orderBy: { name: "asc" }, select: { id: true, name: true } }),
        tx.party.findMany({ where: { isActive: true, ledgerGroup: "CONSIGNEE_CONSIGNOR" }, orderBy: { name: "asc" }, select: { id: true, name: true } }),
        tx.vehicle.findMany({ where: { isActive: true }, orderBy: { number: "asc" }, select: { id: true, number: true } }),
        tx.city.findMany({ orderBy: { name: "asc" }, select: { id: true, name: true } }),
      ]);
      return { rows, total, totalsAgg, transporters, consignees, vehicles, cities };
    }
  );

  const partyById = new Map([...transporters, ...consignees].map((p) => [p.id, p.name]));
  const vehicleById = new Map(vehicles.map((v) => [v.id, v.number]));
  const cityById = new Map(cities.map((c) => [c.id, c.name]));
  const n = (v: unknown) => toNum(String(v));

  return (
    <>
    <DocModule
      title="Crossing"
      exportName="crossings"
      canDelete={session.role === "ADMIN" || session.role === "OWNER"}
      save={saveCrossing}
      remove={deleteCrossing}
      refKind="crossing"
      rows={rows.map((r) => ({
        id: r.id,
        chalanNo: r.chalanNo,
        chalanDate: formatDate(r.chalanDate),
        transporterId: r.transporterId,
        transporterName: (r.transporterId && partyById.get(r.transporterId)) || "",
        vehicleId: r.vehicleId,
        vehicleNumber: (r.vehicleId && vehicleById.get(r.vehicleId)) || "",
        driverName: r.driverName ?? "",
        licenseNo: r.licenseNo ?? "",
        consigneeId: r.consigneeId,
        consigneeName: (r.consigneeId && partyById.get(r.consigneeId)) || "",
        lrNo: r.lrNo ?? "",
        grNo: r.grNo ?? "",
        sourceCityId: r.sourceCityId,
        sourceName: (r.sourceCityId && cityById.get(r.sourceCityId)) || "",
        addressTo: r.addressTo ?? "",
        freight: n(r.freight),
        ewayBillNo: r.ewayBillNo ?? "",
        payType: r.payType,
        crossingAmt: n(r.crossingAmt),
        dcPct: n(r.dcPct),
        dcAmt: n(r.dcAmt),
        toPayAmt: n(r.toPayAmt),
        paidAmt: n(r.paidAmt),
        tbbAmt: n(r.tbbAmt),
        partA: n(r.partA),
        balance: n(r.balance),
        drCr: r.drCr,
      }))}
      columns={[
        { key: "chalanNo", header: "Chalan No" },
        { key: "chalanDate", header: "Date" },
        { key: "transporterName", header: "Transporter" },
        { key: "lrNo", header: "LR No" },
        { key: "vehicleNumber", header: "Vehicle" },
        { key: "payType", header: "Pay Type", kind: "badge" },
        { key: "freight", header: "Freight", kind: "money" },
        { key: "crossingAmt", header: "Crossing Amt", kind: "money" },
        { key: "dcAmt", header: "DC Amt", kind: "money" },
        { key: "balance", header: "Balance", kind: "money" },
      ]}
      filters={[
        { type: "daterange", key: "date", label: "Chalan Date" },
        {
          type: "combobox",
          key: "transporter",
          label: "Transporter",
          options: transporters.map((p) => ({ value: p.id, label: p.name })),
        },
      ]}
      fields={[
        { name: "chalanNo", label: "Chalan No (blank = auto)", type: "text" },
        { name: "chalanDate", label: "Chalan Date *", type: "date" },
        {
          name: "transporterId",
          label: "Transporter",
          type: "combobox",
          options: transporters.map((p) => ({ value: p.id, label: p.name })),
        },
        {
          name: "consigneeId",
          label: "Consignee",
          type: "combobox",
          options: consignees.map((p) => ({ value: p.id, label: p.name })),
        },
        {
          name: "vehicleId",
          label: "Vehicle",
          type: "combobox",
          options: vehicles.map((v) => ({ value: v.id, label: v.number })),
        },
        { name: "driverName", label: "Driver", type: "text" },
        { name: "licenseNo", label: "License No", type: "text" },
        { name: "lrNo", label: "LR No", type: "text" },
        { name: "grNo", label: "GR No", type: "text" },
        {
          name: "sourceCityId",
          label: "Source City",
          type: "combobox",
          options: cities.map((c) => ({ value: c.id, label: c.name })),
        },
        { name: "addressTo", label: "Address To", type: "text" },
        { name: "ewayBillNo", label: "E-Way Bill No", type: "text" },
        {
          name: "payType",
          label: "Pay Type",
          type: "select",
          options: [
            { value: "TO_PAY", label: "To Pay" },
            { value: "TBB", label: "TBB" },
            { value: "PAID", label: "Paid" },
            { value: "FOC", label: "FOC" },
          ],
        },
        { name: "freight", label: "Freight", type: "number" },
        { name: "crossingAmt", label: "Crossing Amount", type: "number" },
        { name: "dcPct", label: "DC %", type: "number" },
        { name: "toPayAmt", label: "To-Pay Amt", type: "number" },
        { name: "paidAmt", label: "Paid Amt", type: "number" },
        { name: "tbbAmt", label: "TBB Amt", type: "number" },
        { name: "partA", label: "Part A", type: "number" },
        {
          name: "drCr",
          label: "Dr / Cr",
          type: "radio",
          options: [
            { value: "DEBIT", label: "Debit" },
            { value: "CREDIT", label: "Credit" },
          ],
        },
      ]}
      defaults={{ chalanNo: "", chalanDate: formatDate(new Date()), payType: "TO_PAY", drCr: "DEBIT" }}
      numericFields={["freight", "crossingAmt", "dcPct", "toPayAmt", "paidAmt", "tbbAmt", "partA"]}
      totals={{
        freight: n(totalsAgg._sum.freight),
        crossingAmt: n(totalsAgg._sum.crossingAmt),
        dcAmt: n(totalsAgg._sum.dcAmt),
        balance: n(totalsAgg._sum.balance),
      }}
    />
    <div className="px-4 pb-4">
      <PaginationBar
        page={page}
        pageSize={PAGE_SIZE}
        total={total}
        basePath="/crossing"
        searchParams={searchParams}
      />
    </div>
    </>
  );
}
