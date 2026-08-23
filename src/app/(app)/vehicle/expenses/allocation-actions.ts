"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { requireSession } from "@/lib/session";
import { withTenant, type Tx } from "@/lib/db";
import { authorize } from "@/lib/authz";
import { audit } from "@/lib/audit";
import { round2 } from "@/lib/calc/tds";
import { toNum } from "@/lib/utils";
import { postLedger, reverseLedger, type LedgerPostEntry } from "@/lib/ledger";

/**
 * Vehicle Expense Allocation.
 *
 * Stock bought in bulk — tyres, chains, batteries, spares — is booked once as a
 * purchase (expense head Dr / supplier Cr) with no vehicle named. It sits as an
 * UNALLOCATED vehicle expense until vehicles actually consume it; allocating
 * writes one VehicleExpenseItem per vehicle. For a COMPANY vehicle it posts
 * nothing — the purchase already carries the accounting and allocation is an
 * internal cost transfer on the allocation date, so a chain bought on the 1st
 * and fitted on the 8th reaches that vehicle's P&L on the 8th.
 *
 * A RELATIVE vehicle's share, however, is not the company's cost: exactly like
 * a vehicle-wise purchase (see expenses/actions.ts) the allocated amount
 * transfers OUT of the expense head and ONTO the relative owner's ledger
 * (owner Dr / expense head Cr) on the allocation date. Each transfer posts
 * under its own item id (refType VEH_EXP_ALLOC) so undoing one allocation
 * line reverses only its own entries.
 */

const REVALIDATE = "/vehicle/management";

const rowSchema = z.object({
  vehicleId: z.string().min(1, "Vehicle is required"),
  qty: z.number().min(0).nullish(),
  amount: z.number().min(0.01, "Allocated amount is required"),
  allocDate: z.string().min(1, "Allocation date is required"),
  remarks: z.string().nullish(),
});

const schema = z.object({
  voucherId: z.string().min(1),
  rows: z.array(rowSchema).min(1, "Allocate to at least one vehicle"),
});

/** What is still available on a purchase, after everything already allocated. */
async function remaining(tx: Tx, voucherId: string) {
  const voucher = await tx.vehicleExpenseVoucher.findFirstOrThrow({
    where: { id: voucherId, deletedAt: null },
    include: { items: true },
  });
  const allocatedAmt = round2(voucher.items.reduce((s, i) => s + toNum(String(i.amount)), 0));
  const allocatedQty = round2(voucher.items.reduce((s, i) => s + toNum(String(i.qty ?? 0)), 0));
  const totalQty = voucher.qty == null ? null : toNum(String(voucher.qty));
  return {
    voucher,
    amount: round2(toNum(String(voucher.amount)) - allocatedAmt),
    qty: totalQty == null ? null : round2(totalQty - allocatedQty),
  };
}

export async function allocateVehicleExpense(
  input: unknown
): Promise<{ ok: true } | { ok: false; error: string }> {
  const session = requireSession();
  const parsed = schema.safeParse(input);
  if (!parsed.success) return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid input" };
  const d = parsed.data;
  await authorize(session, "vehicle", "edit");

  const uniq = new Set(d.rows.map((r) => r.vehicleId));
  if (uniq.size !== d.rows.length) {
    return { ok: false, error: "The same vehicle appears more than once in this allocation." };
  }

  try {
    return await withTenant(session.tenantId, async (tx) => {
      const left = await remaining(tx, d.voucherId);
      if (left.voucher.txnType !== "EXPENSE") {
        return { ok: false as const, error: "Only expense vouchers can be allocated to vehicles." };
      }

      const askedAmt = round2(d.rows.reduce((s, r) => s + r.amount, 0));
      if (askedAmt > left.amount + 0.009) {
        return {
          ok: false as const,
          error: `Allocating ${askedAmt} exceeds the ${left.amount} still unallocated on this purchase.`,
        };
      }
      const askedQty = round2(d.rows.reduce((s, r) => s + (r.qty ?? 0), 0));
      if (left.qty != null && askedQty > left.qty + 0.009) {
        return {
          ok: false as const,
          error: `Allocating ${askedQty} exceeds the ${left.qty} still available on this purchase.`,
        };
      }

      const vehicles = await tx.vehicle.findMany({
        where: { id: { in: d.rows.map((r) => r.vehicleId) } },
        select: { id: true, number: true, ownershipType: true, ownerId: true },
      });
      if (vehicles.length !== uniq.size) {
        return { ok: false as const, error: "One or more vehicles were not found." };
      }
      const vehicleById = new Map(vehicles.map((v) => [v.id, v]));
      const head = await tx.accountHead.findUniqueOrThrow({
        where: { id: left.voucher.headId },
        select: { name: true },
      });

      const created = await Promise.all(
        d.rows.map((r) =>
          tx.vehicleExpenseItem.create({
            data: {
              tenantId: session.tenantId,
              voucherId: d.voucherId,
              vehicleId: r.vehicleId,
              amount: r.amount,
              qty: r.qty ?? null,
              allocDate: new Date(`${r.allocDate}T00:00:00`),
              remarks: r.remarks || null,
            },
          })
        )
      );
      // Company vehicles: no postLedger on purpose — the purchase already
      // carries the accounting; allocation is an internal cost transfer.
      // Relative vehicles: the allocated share stops being a company expense
      // the moment it is allocated — transfer it to the owner's ledger, the
      // same pair the vehicle-wise purchase posts (owner Dr / expense head Cr).
      const entries: LedgerPostEntry[] = [];
      for (let i = 0; i < created.length; i++) {
        const item = created[i];
        const v = vehicleById.get(item.vehicleId);
        if (v?.ownershipType !== "RELATIVE" || !v.ownerId) continue;
        const common = {
          date: item.allocDate,
          refType: "VEH_EXP_ALLOC",
          refId: item.id,
          refNo: left.voucher.refNo || left.voucher.voucherNo,
        };
        entries.push(
          {
            ...common,
            partyId: v.ownerId,
            side: "DEBIT",
            amount: d.rows[i].amount,
            narration: `${head.name} for relative vehicle ${v.number} — transferred to owner (allocation of ${left.voucher.voucherNo})`,
          },
          {
            ...common,
            accountHeadId: left.voucher.headId,
            side: "CREDIT",
            amount: d.rows[i].amount,
            narration: `${head.name} ${v.number} — shifted to relative owner ledger (allocation of ${left.voucher.voucherNo})`,
          }
        );
      }
      if (entries.length) await postLedger(tx, session, entries);
      await audit(tx, session, {
        entity: "VehicleExpenseAllocation",
        entityId: d.voucherId,
        action: "CREATE",
        after: { voucherNo: left.voucher.voucherNo, rows: created },
      });
      revalidatePath(REVALIDATE);
      return { ok: true as const };
    });
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Allocation failed" };
  }
}

/** Undo one allocation line — the quantity and amount return to the purchase. */
export async function deleteVehicleExpenseAllocation(
  itemId: string
): Promise<{ ok: true } | { ok: false; error: string }> {
  const session = requireSession();
  await authorize(session, "vehicle", "delete");
  try {
    await withTenant(session.tenantId, async (tx) => {
      const before = await tx.vehicleExpenseItem.findFirstOrThrow({ where: { id: itemId } });
      await tx.vehicleExpenseItem.delete({ where: { id: itemId } });
      // undo the relative-owner transfer this line may have posted
      await reverseLedger(tx, "VEH_EXP_ALLOC", itemId);
      await audit(tx, session, {
        entity: "VehicleExpenseAllocation",
        entityId: before.voucherId,
        action: "DELETE",
        before,
      });
    });
    revalidatePath(REVALIDATE);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Delete failed" };
  }
}

export interface UnallocatedPurchase {
  id: string;
  voucherNo: string;
  date: string;
  supplier: string;
  head: string;
  itemName: string;
  qty: number | null;
  allocatedQty: number;
  remainingQty: number | null;
  amount: number;
  allocatedAmount: number;
  remainingAmount: number;
}

/**
 * Purchases with something still unallocated. A purchase that named its vehicles
 * up front has nothing left here, which is exactly right — it is already booked
 * against those vehicles.
 */
export async function getUnallocatedPurchases(): Promise<UnallocatedPurchase[]> {
  const session = requireSession();
  return withTenant(session.tenantId, async (tx) => {
    const vouchers = await tx.vehicleExpenseVoucher.findMany({
      // FY continuity: an old-year bill with anything unallocated stays
      // offered until every rupee lands on a vehicle
      where: {
        firmId: session.firmId,
        deletedAt: null,
        txnType: "EXPENSE",
      },
      include: { items: true },
      orderBy: { date: "asc" },
    });
    const [parties, heads] = await Promise.all([
      tx.party.findMany({ select: { id: true, name: true } }),
      tx.accountHead.findMany({ select: { id: true, name: true } }),
    ]);
    const partyName = new Map(parties.map((p) => [p.id, p.name]));
    const headName = new Map(heads.map((h) => [h.id, h.name]));

    const out: UnallocatedPurchase[] = [];
    for (const v of vouchers) {
      const amount = round2(toNum(String(v.amount)));
      const allocatedAmount = round2(v.items.reduce((s, i) => s + toNum(String(i.amount)), 0));
      const remainingAmount = round2(amount - allocatedAmount);
      if (remainingAmount <= 0.009) continue;
      const qty = v.qty == null ? null : round2(toNum(String(v.qty)));
      const allocatedQty = round2(v.items.reduce((s, i) => s + toNum(String(i.qty ?? 0)), 0));
      out.push({
        id: v.id,
        voucherNo: v.voucherNo,
        date: v.date.toISOString(),
        supplier: (v.partyId && partyName.get(v.partyId)) || "",
        head: headName.get(v.headId) ?? "",
        itemName: v.itemName ?? "",
        qty,
        allocatedQty,
        remainingQty: qty == null ? null : round2(qty - allocatedQty),
        amount,
        allocatedAmount,
        remainingAmount,
      });
    }
    return out;
  });
}

export interface AllocationRow {
  id: string;
  allocDate: string;
  vehicle: string;
  itemName: string;
  head: string;
  qty: number | null;
  amount: number;
  voucherNo: string;
  purchaseDate: string;
  supplier: string;
  remarks: string;
}

/** Every allocation made, newest first — the audit trail of who got what, when. */
export async function getAllocationHistory(opts?: {
  vehicleId?: string | null;
  dateFrom?: string | null;
  dateTo?: string | null;
}): Promise<AllocationRow[]> {
  const session = requireSession();
  return withTenant(session.tenantId, async (tx) => {
    const items = await tx.vehicleExpenseItem.findMany({
      where: {
        ...(opts?.vehicleId ? { vehicleId: opts.vehicleId } : {}),
        ...(opts?.dateFrom || opts?.dateTo
          ? {
              allocDate: {
                ...(opts?.dateFrom ? { gte: new Date(`${opts.dateFrom}T00:00:00`) } : {}),
                ...(opts?.dateTo ? { lte: new Date(`${opts.dateTo}T23:59:59`) } : {}),
              },
            }
          : {}),
        voucher: {
          firmId: session.firmId,
          fyId: session.fyId,
          deletedAt: null,
          txnType: "EXPENSE",
        },
      },
      include: { voucher: true },
      orderBy: { allocDate: "desc" },
      take: 2000,
    });
    const [vehicles, parties, heads] = await Promise.all([
      tx.vehicle.findMany({ select: { id: true, number: true } }),
      tx.party.findMany({ select: { id: true, name: true } }),
      tx.accountHead.findMany({ select: { id: true, name: true } }),
    ]);
    const vehicleNo = new Map(vehicles.map((v) => [v.id, v.number]));
    const partyName = new Map(parties.map((p) => [p.id, p.name]));
    const headName = new Map(heads.map((h) => [h.id, h.name]));

    return items.map((i) => ({
      id: i.id,
      allocDate: i.allocDate.toISOString(),
      vehicle: vehicleNo.get(i.vehicleId) ?? "",
      itemName: i.voucher.itemName ?? "",
      head: headName.get(i.voucher.headId) ?? "",
      qty: i.qty == null ? null : round2(toNum(String(i.qty))),
      amount: round2(toNum(String(i.amount))),
      voucherNo: i.voucher.voucherNo,
      purchaseDate: i.voucher.date.toISOString(),
      supplier: (i.voucher.partyId && partyName.get(i.voucher.partyId)) || "",
      remarks: i.remarks ?? "",
    }));
  });
}
