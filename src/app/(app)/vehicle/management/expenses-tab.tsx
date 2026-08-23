import type { Prisma } from "@prisma/client";
import { requireSession } from "@/lib/session";
import { authorize } from "@/lib/authz";
import { withTenant } from "@/lib/db";
import { toNum } from "@/lib/utils";
import {
  VehicleExpenseClient,
  type VehicleExpenseRow,
} from "@/components/vehicle/vehicle-expense-client";

export async function VehicleExpensesTab({
  searchParams,
}: {
  searchParams: {
    q?: string;
    vehicle?: string;
    head?: string;
    type?: string;
    ownership?: string;
    date_from?: string;
    date_to?: string;
  };
}) {
  const session = requireSession();
  await authorize(session, "vehicle", "view");

  const { vouchers, vehicles, heads, parties, banks } = await withTenant(
    session.tenantId,
    async (tx) => {
      const where: Prisma.VehicleExpenseVoucherWhereInput = {
        firmId: session.firmId,
        fyId: session.fyId,
        deletedAt: null,
      };
      if (searchParams.q) {
        where.OR = [
          { voucherNo: { contains: searchParams.q, mode: "insensitive" } },
          { refNo: { contains: searchParams.q, mode: "insensitive" } },
        ];
      }
      if (searchParams.head) where.headId = searchParams.head;
      if (searchParams.type === "EXPENSE" || searchParams.type === "INCOME") {
        where.txnType = searchParams.type;
      }
      if (searchParams.vehicle) where.items = { some: { vehicleId: searchParams.vehicle } };
      if (searchParams.date_from || searchParams.date_to) {
        where.date = {
          ...(searchParams.date_from
            ? { gte: new Date(searchParams.date_from + "T00:00:00") }
            : {}),
          ...(searchParams.date_to ? { lte: new Date(searchParams.date_to + "T23:59:59") } : {}),
        };
      }
      const [vouchers, vehicles, heads, parties, banks] = await Promise.all([
        tx.vehicleExpenseVoucher.findMany({
          where,
          include: { items: true, lines: true },
          orderBy: [{ date: "desc" }, { createdAt: "desc" }],
        }),
        tx.vehicle.findMany({ where: { isActive: true }, orderBy: { number: "asc" } }),
        tx.accountHead.findMany({
          where: { kind: { in: ["INCOME", "EXPENSE"] } },
          orderBy: { name: "asc" },
        }),
        tx.party.findMany({
          where: { isActive: true, ledgerGroup: { notIn: ["BANK", "CASH", "CARD"] } },
          orderBy: { name: "asc" },
        }),
        tx.party.findMany({
          where: { isActive: true, ledgerGroup: { in: ["BANK", "CASH", "CARD"] } },
          orderBy: { name: "asc" },
        }),
      ]);
      return { vouchers, vehicles, heads, parties, banks };
    }
  );

  const vehicleById = new Map(vehicles.map((v) => [v.id, v]));
  const headName = new Map(heads.map((h) => [h.id, h.name]));
  const partyName = new Map([...parties, ...banks].map((p) => [p.id, p.name]));

  let rows: VehicleExpenseRow[] = vouchers.map((v) => ({
    id: v.id,
    voucherNo: v.voucherNo,
    date: v.date.toISOString(),
    txnType: v.txnType,
    headId: v.headId,
    head: headName.get(v.headId) ?? "",
    partyId: v.partyId,
    party: v.partyId ? partyName.get(v.partyId) ?? "" : "",
    paymentMode: v.paymentMode ?? "",
    bankPartyId: v.bankPartyId,
    bank: v.bankPartyId ? partyName.get(v.bankPartyId) ?? "" : "",
    paymentDate: v.paymentDate ? v.paymentDate.toISOString() : null,
    amount: toNum(String(v.amount)),
    itemName: v.itemName ?? "",
    qty: v.qty == null ? null : toNum(String(v.qty)),
    refNo: v.refNo ?? "",
    remarks: v.remarks ?? "",
    attachmentPath: v.attachmentPath,
    attachmentName: v.attachmentName ?? "",
    items: v.items.map((i) => ({
      vehicleId: i.vehicleId,
      vehicle: vehicleById.get(i.vehicleId)?.number ?? "",
      ownership: vehicleById.get(i.vehicleId)?.ownershipType ?? "",
      amount: toNum(String(i.amount)),
    })),
    lines: v.lines.map((l) => ({
      headId: l.headId,
      head: headName.get(l.headId) ?? "",
      amount: toNum(String(l.amount)),
      remarks: l.remarks ?? "",
    })),
  }));
  if (searchParams.ownership) {
    rows = rows.filter((r) => r.items.some((i) => i.ownership === searchParams.ownership));
  }

  return (
    <div className="space-y-4">
      <VehicleExpenseClient
        rows={rows}
        vehicleOptions={vehicles.map((v) => ({
          value: v.id,
          label: v.number,
          meta: v.ownershipType,
        }))}
        headOptions={heads.map((h) => ({ value: h.id, label: h.name, meta: h.kind }))}
        partyOptions={parties.map((p) => ({
          value: p.id,
          label: p.name,
          meta: p.ledgerGroup.replace(/_/g, " "),
        }))}
        bankOptions={banks.map((b) => ({ value: b.id, label: b.name, meta: b.ledgerGroup }))}
        canDelete={session.role === "ADMIN" || session.role === "OWNER"}
      />
    </div>
  );
}
