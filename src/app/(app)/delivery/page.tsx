import type { Prisma } from "@prisma/client";
import { requireSession } from "@/lib/session";
import { authorize } from "@/lib/authz";
import { withTenant } from "@/lib/db";
import { formatDate, toNum } from "@/lib/utils";
import { DocModule } from "@/components/data/doc-module";
import { PaginationBar, parsePage } from "@/components/data/pagination-bar";
import { saveDelivery, deleteDelivery } from "./actions";

const PAGE_SIZE = 100;

export const dynamic = "force-dynamic";

export default async function DeliveryPage({
  searchParams,
}: {
  searchParams: Record<string, string | undefined>;
}) {
  const session = requireSession();
  await authorize(session, "delivery", "view");

  const page = parsePage(searchParams.page);
  const { rows, total, totals, parties, vehicles } = await withTenant(session.tenantId, async (tx) => {
    const where: Prisma.DeliveryWhereInput = {
      firmId: session.firmId,
      fyId: session.fyId,
      deletedAt: null,
    };
    if (searchParams.party) where.partyId = searchParams.party;
    if (searchParams.type === "GATE_PASS" || searchParams.type === "CASH_MEMO") {
      where.type = searchParams.type;
    }
    if (searchParams.date_from || searchParams.date_to) {
      where.delDate = {
        ...(searchParams.date_from ? { gte: new Date(searchParams.date_from + "T00:00:00") } : {}),
        ...(searchParams.date_to ? { lte: new Date(searchParams.date_to + "T23:59:59") } : {}),
      };
    }
    const [rows, total, agg, parties, vehicles] = await Promise.all([
      tx.delivery.findMany({
        where,
        orderBy: [{ delDate: "desc" }, { delNo: "desc" }],
        take: PAGE_SIZE,
        skip: (page - 1) * PAGE_SIZE,
      }),
      tx.delivery.count({ where }),
      // footer totals over the FULL filtered set — the table only gets one page
      tx.delivery.aggregate({
        where,
        _sum: { freight: true, deliveryCharges: true, total: true },
      }),
      tx.party.findMany({
        where: { isActive: true, ledgerGroup: "CONSIGNEE_CONSIGNOR" },
        orderBy: { name: "asc" },
        select: { id: true, name: true },
      }),
      tx.vehicle.findMany({
        where: { isActive: true },
        orderBy: { number: "asc" },
        select: { id: true, number: true },
      }),
    ]);
    const totals = {
      freight: toNum(agg._sum.freight),
      deliveryCharges: toNum(agg._sum.deliveryCharges),
      total: toNum(agg._sum.total),
    };
    return { rows, total, totals, parties, vehicles };
  });

  const partyById = new Map(parties.map((p) => [p.id, p.name]));
  const vehicleById = new Map(vehicles.map((v) => [v.id, v.number]));
  const partyOptions = parties.map((p) => ({ value: p.id, label: p.name }));
  const vehicleOptions = vehicles.map((v) => ({ value: v.id, label: v.number }));
  const n = (v: unknown) => toNum(String(v));

  return (
    <>
      <DocModule
      title="Delivery (Gate Pass / Cash Memo)"
      newLabel="New Delivery"
      exportName="deliveries"
      canDelete={session.role === "ADMIN" || session.role === "OWNER"}
      save={saveDelivery}
      remove={deleteDelivery}
      refKind="delivery"
      rows={rows.map((r) => ({
        id: r.id,
        delNo: r.delNo,
        delDate: formatDate(r.delDate),
        type: r.type,
        partyId: r.partyId,
        partyName: (r.partyId && partyById.get(r.partyId)) || "",
        vehicleId: r.vehicleId,
        vehicleNumber: (r.vehicleId && vehicleById.get(r.vehicleId)) || "",
        lrNo: r.lrNo ?? "",
        grNo: r.grNo ?? "",
        freight: n(r.freight),
        totQty: n(r.totQty),
        totWeight: n(r.totWeight),
        ewayBillNo: r.ewayBillNo ?? "",
        deliveryPerson: r.deliveryPerson ?? "",
        through: r.through ?? "",
        payType: r.payType,
        cashType: r.cashType,
        deliveryCharges: n(r.deliveryCharges),
        gatepassCharge: n(r.gatepassCharge),
        labourCharges: n(r.labourCharges),
        aoc: n(r.aoc),
        damrage: n(r.damrage),
        total: n(r.total),
        remarks: r.remarks ?? "",
      }))}
      columns={[
        { key: "delNo", header: "Del No" },
        { key: "delDate", header: "Date" },
        { key: "type", header: "Type", kind: "badge" },
        { key: "partyName", header: "Party" },
        { key: "lrNo", header: "LR No" },
        { key: "vehicleNumber", header: "Vehicle" },
        { key: "payType", header: "Pay Type", kind: "badge" },
        { key: "freight", header: "Freight", kind: "money" },
        { key: "deliveryCharges", header: "Del Charges", kind: "money" },
        { key: "total", header: "Total", kind: "money" },
      ]}
      filters={[
        { type: "daterange", key: "date", label: "Delivery Date" },
        { type: "combobox", key: "party", label: "Party", options: partyOptions },
        {
          type: "select",
          key: "type",
          label: "Type",
          options: [
            { value: "GATE_PASS", label: "Gate Pass" },
            { value: "CASH_MEMO", label: "Cash Memo" },
          ],
        },
      ]}
      fields={[
        { name: "delNo", label: "Delivery No (blank = auto)", type: "text" },
        { name: "delDate", label: "Delivery Date *", type: "date" },
        {
          name: "type",
          label: "Type",
          type: "radio",
          options: [
            { value: "GATE_PASS", label: "Gate Pass" },
            { value: "CASH_MEMO", label: "Cash Memo" },
          ],
        },
        { name: "partyId", label: "Party", type: "combobox", options: partyOptions },
        { name: "vehicleId", label: "Vehicle", type: "combobox", options: vehicleOptions },
        { name: "lrNo", label: "LR No", type: "text" },
        { name: "grNo", label: "GR No", type: "text" },
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
        {
          name: "cashType",
          label: "Cash / Credit",
          type: "radio",
          options: [
            { value: "CASH", label: "Cash" },
            { value: "CREDIT", label: "Credit" },
          ],
        },
        { name: "freight", label: "Freight", type: "number" },
        { name: "totQty", label: "Total Qty", type: "number" },
        { name: "totWeight", label: "Total Weight", type: "number" },
        { name: "deliveryCharges", label: "Delivery Charges", type: "number" },
        { name: "gatepassCharge", label: "Gate Pass Charge", type: "number" },
        { name: "labourCharges", label: "Labour Charges", type: "number" },
        { name: "aoc", label: "AOC", type: "number" },
        { name: "damrage", label: "Damrage", type: "number" },
        { name: "ewayBillNo", label: "E-Way Bill No", type: "text" },
        { name: "deliveryPerson", label: "Delivery Person", type: "text" },
        { name: "through", label: "Through", type: "text" },
        { name: "remarks", label: "Remarks", type: "textarea", span2: true },
      ]}
      defaults={{ delNo: "", delDate: formatDate(new Date()), type: "GATE_PASS", payType: "TO_PAY", cashType: "CASH" }}
      numericFields={[
        "freight",
        "totQty",
        "totWeight",
        "deliveryCharges",
        "gatepassCharge",
        "labourCharges",
        "aoc",
        "damrage",
      ]}
      totals={totals}
      />
      <div className="px-4 pb-4">
        <PaginationBar
          page={page}
          pageSize={PAGE_SIZE}
          total={total}
          basePath="/delivery"
          searchParams={searchParams}
        />
      </div>
    </>
  );
}
