"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { requireSession } from "@/lib/session";
import { withTenant } from "@/lib/db";
import { authorize } from "@/lib/authz";
import { audit } from "@/lib/audit";
import { postLedger, type LedgerPostEntry } from "@/lib/ledger";
import { resolveRelativeOwner } from "@/lib/relative-owner";
import { nextDocNumber } from "@/lib/sequences";
import { round2 } from "@/lib/calc/tds";
import { settledByRef, signedRemainder } from "@/lib/settlement";
import { toNum } from "@/lib/utils";

/**
 * Driver +/- Settlement Register. Rows arrive automatically from completed
 * trip sheets (one per trip) or can be entered manually. Settling a positive
 * balance auto-creates a PAYMENT voucher (company pays driver); a negative
 * balance auto-creates a RECEIPT voucher (driver pays company). Settled
 * amounts never carry to the next trip.
 */

const REVALIDATE = "/vehicle/driver-settlements";

const manualSchema = z.object({
  date: z.string().min(1, "Date is required"),
  driverId: z.string().min(1, "Driver is required"),
  vehicleId: z.string().nullish(),
  tripRef: z.string().nullish(),
  amount: z.number().refine((v) => v !== 0, "Amount cannot be zero"),
  remarks: z.string().nullish(),
});

export async function saveDriverSettlement(
  input: unknown
): Promise<{ ok: true; id: string } | { ok: false; error: string }> {
  const session = requireSession();
  const parsed = manualSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid input" };
  const d = parsed.data;
  await authorize(session, "driver", "create");
  try {
    return await withTenant(session.tenantId, async (tx) => {
      const created = await tx.driverSettlement.create({
        data: {
          tenantId: session.tenantId,
          firmId: session.firmId,
          fyId: session.fyId,
          date: new Date(`${d.date}T00:00:00`),
          driverId: d.driverId,
          vehicleId: d.vehicleId || null,
          tripRef: d.tripRef?.trim() || null,
          amount: d.amount,
          remarks: d.remarks || null,
        },
      });
      await audit(tx, session, {
        entity: "DriverSettlement",
        entityId: created.id,
        action: "CREATE",
        after: created,
      });
      revalidatePath(REVALIDATE);
      return { ok: true as const, id: created.id };
    });
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Save failed" };
  }
}

// ---------------------------------------------------------------- settle

const settleSchema = z.object({
  id: z.string().min(1),
  date: z.string().min(1, "Date is required"),
  paymentMode: z.enum(["CASH", "BANK", "CARD"]).default("CASH"),
  bankPartyId: z.string().min(1, "Cash / Bank account is required"),
  remarks: z.string().nullish(),
});

export async function settleDriverSettlement(
  input: unknown
): Promise<{ ok: true; voucherNo: string } | { ok: false; error: string }> {
  const session = requireSession();
  const parsed = settleSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid input" };
  const d = parsed.data;
  await authorize(session, "vouchers", "create");

  try {
    return await withTenant(session.tenantId, async (tx) => {
      const s = await tx.driverSettlement.findFirst({
        where: { id: d.id, firmId: session.firmId, deletedAt: null },
      });
      if (!s) return { ok: false as const, error: "Settlement not found" };
      if (s.status === "SETTLED") return { ok: false as const, error: "Already settled." };
      const recorded = toNum(String(s.amount));
      if (recorded === 0) return { ok: false as const, error: "Zero balance — nothing to settle." };
      const date = new Date(`${d.date}T00:00:00`);

      // LIVE outstanding: a Payment/Receipt voucher may already have settled
      // part (or all) of this row through its allocation grid — paying the
      // recorded amount again would pay the driver twice. The row is not
      // FY-scoped, so the allocations must not be either (fyId: null) — a
      // voucher entered last FY settled it just as finally.
      const voucherPaid =
        (
          await settledByRef(tx, {
            firmId: session.firmId,
            fyId: null,
            refTypes: ["DRIVER_SETTLEMENT"],
            refIds: [s.id],
          })
        ).get(s.id) ?? 0;
      const amount = signedRemainder(recorded, voucherPaid);
      if (amount === 0) {
        // fully settled by vouchers — close the row instead of paying again
        await tx.driverSettlement.update({
          where: { id: s.id },
          data: { status: "SETTLED", settledDate: date },
        });
        revalidatePath(REVALIDATE);
        return {
          ok: false as const,
          error: "Already fully settled through voucher allocation(s) — row closed, nothing to pay.",
        };
      }

      const driver = await tx.driver.findFirst({ where: { id: s.driverId } });
      if (!driver?.partyId) {
        return { ok: false as const, error: "Driver has no linked ledger party." };
      }

      const pay = amount > 0; // company pays driver
      const abs = Math.abs(amount);
      const voucherNo = await nextDocNumber(tx, {
        tenantId: session.tenantId,
        firmId: session.firmId,
        fyId: session.fyId,
        docType: pay ? "VOUCHER_PAYMENT" : "VOUCHER_RECEIPT",
      });

      const narration = `Driver ${pay ? "settlement paid to" : "settlement received from"} ${driver.name}${s.tripRef ? ` (trip ${s.tripRef})` : ""}${d.remarks ? " — " + d.remarks : ""}`;
      const voucher = await tx.voucher.create({
        data: {
          tenantId: session.tenantId,
          firmId: session.firmId,
          fyId: session.fyId,
          voucherNo,
          voucherDate: date,
          type: pay ? "PAYMENT" : "RECEIPT",
          entryType: d.paymentMode,
          moduleLink: "OTHERS",
          partyId: driver.partyId,
          bankPartyId: d.bankPartyId,
          amount: abs,
          netAmount: abs,
          remarks: narration,
          createdById: session.userId,
        },
      });

      const common = {
        date,
        refType: "VOUCHER",
        refId: voucher.id,
        refNo: s.tripRef || voucherNo,
        narration,
      };
      const entries: LedgerPostEntry[] = [
        {
          ...common,
          partyId: d.bankPartyId,
          side: pay ? "CREDIT" : "DEBIT",
          amount: abs,
        },
        {
          ...common,
          partyId: driver.partyId,
          side: pay ? "DEBIT" : "CREDIT",
          amount: abs,
        },
      ];
      // relative vehicle: the settlement is on behalf of the relative owner
      const rel = await resolveRelativeOwner(tx, {
        vehicleId: s.vehicleId,
        driverId: s.driverId,
        at: date,
      });
      if (rel) {
        entries.push(
          {
            ...common,
            partyId: rel.ownerId,
            side: pay ? "DEBIT" : "CREDIT",
            amount: abs,
            narration: `Driver settlement (${driver.name}, vehicle ${rel.vehicleNo}) — on behalf of relative owner`,
          },
          {
            ...common,
            partyId: driver.partyId,
            side: pay ? "CREDIT" : "DEBIT",
            amount: abs,
            narration: `Settlement transferred to relative owner ledger (${rel.vehicleNo})`,
          }
        );
      }
      await postLedger(tx, session, entries);

      const after = await tx.driverSettlement.update({
        where: { id: s.id },
        data: {
          status: "SETTLED",
          settledDate: date,
          voucherId: voucher.id,
          voucherNo,
        },
      });
      await audit(tx, session, {
        entity: "DriverSettlement",
        entityId: s.id,
        action: "UPDATE",
        before: s,
        after,
      });
      revalidatePath(REVALIDATE);
      revalidatePath("/accounts/vouchers/register");
      return { ok: true as const, voucherNo };
    });
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Settlement failed" };
  }
}

export async function deleteDriverSettlement(
  id: string
): Promise<{ ok: true } | { ok: false; error: string }> {
  const session = requireSession();
  if (session.role !== "ADMIN" && session.role !== "OWNER") {
    return { ok: false, error: "Only Admin/Owner may delete settlement rows" };
  }
  await authorize(session, "driver", "delete");
  try {
    await withTenant(session.tenantId, async (tx) => {
      const before = await tx.driverSettlement.findFirstOrThrow({ where: { id, deletedAt: null } });
      if (before.status === "SETTLED") throw new Error("Settled rows cannot be deleted.");
      await tx.driverSettlement.update({ where: { id }, data: { deletedAt: new Date() } });
      await audit(tx, session, { entity: "DriverSettlement", entityId: id, action: "DELETE", before });
    });
    revalidatePath(REVALIDATE);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Delete failed" };
  }
}

// ------------------------------------------------- running balance settlement

const runningSettleSchema = z.object({
  driverId: z.string().min(1),
  date: z.string().min(1, "Date is required"),
  paymentMode: z.enum(["CASH", "BANK", "CARD"]).default("CASH"),
  bankPartyId: z.string().min(1, "Cash / Bank account is required"),
  remarks: z.string().nullish(),
});

/**
 * Settle a driver's ENTIRE outstanding running balance in one shot — only the
 * latest entry offers Pay/Receive, and it always settles the net of all
 * pending entries. One voucher is created for the net amount; every pending
 * row is marked SETTLED so nothing carries forward.
 */
export async function settleDriverRunningBalance(
  input: unknown
): Promise<{ ok: true; voucherNo: string; amount: number } | { ok: false; error: string }> {
  const session = requireSession();
  const parsed = runningSettleSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid input" };
  const d = parsed.data;
  await authorize(session, "vouchers", "create");

  try {
    return await withTenant(session.tenantId, async (tx) => {
      const pending = await tx.driverSettlement.findMany({
        where: { firmId: session.firmId, driverId: d.driverId, status: "PENDING", deletedAt: null },
        orderBy: { date: "asc" },
      });
      if (!pending.length) return { ok: false as const, error: "No pending balance to settle." };
      // net of the LIVE remainders: voucher allocations already made against
      // any of these rows must not be paid a second time here. Pending rows
      // carry no FY filter, so the allocation lookup spans all FYs too
      // (fyId: null) — else a row paid last FY would be paid again this FY.
      const voucherPaid = await settledByRef(tx, {
        firmId: session.firmId,
        fyId: null,
        refTypes: ["DRIVER_SETTLEMENT"],
        refIds: pending.map((p) => p.id),
      });
      const net = round2(
        pending.reduce(
          (s, r) => s + signedRemainder(toNum(String(r.amount)), voucherPaid.get(r.id) ?? 0),
          0
        )
      );
      if (net === 0) {
        // pluses and minuses cancel out — close all rows without money movement
        await tx.driverSettlement.updateMany({
          where: { id: { in: pending.map((p) => p.id) } },
          data: { status: "SETTLED", settledDate: new Date(`${d.date}T00:00:00`), voucherNo: "NET-0" },
        });
        revalidatePath(REVALIDATE);
        return { ok: true as const, voucherNo: "NET-0", amount: 0 };
      }

      const driver = await tx.driver.findFirst({ where: { id: d.driverId } });
      if (!driver?.partyId) return { ok: false as const, error: "Driver has no linked ledger party." };

      const pay = net > 0; // company pays driver
      const abs = Math.abs(net);
      const date = new Date(`${d.date}T00:00:00`);
      const voucherNo = await nextDocNumber(tx, {
        tenantId: session.tenantId,
        firmId: session.firmId,
        fyId: session.fyId,
        docType: pay ? "VOUCHER_PAYMENT" : "VOUCHER_RECEIPT",
      });
      const refNos = Array.from(new Set(pending.map((p) => p.tripRef).filter(Boolean))) as string[];
      const narration = `Driver running balance ${pay ? "paid to" : "received from"} ${driver.name} (${pending.length} entr${pending.length === 1 ? "y" : "ies"})${d.remarks ? " — " + d.remarks : ""}`;
      const voucher = await tx.voucher.create({
        data: {
          tenantId: session.tenantId,
          firmId: session.firmId,
          fyId: session.fyId,
          voucherNo,
          voucherDate: date,
          type: pay ? "PAYMENT" : "RECEIPT",
          entryType: d.paymentMode,
          moduleLink: "OTHERS",
          partyId: driver.partyId,
          bankPartyId: d.bankPartyId,
          amount: abs,
          netAmount: abs,
          remarks: narration,
          createdById: session.userId,
        },
      });
      const common = {
        date,
        refType: "VOUCHER",
        refId: voucher.id,
        // reference-number-based adjustment: carries every trip ref settled
        refNo: refNos.length ? refNos.join(", ") : voucherNo,
        narration,
      };
      const entries: LedgerPostEntry[] = [
        { ...common, partyId: d.bankPartyId, side: pay ? "CREDIT" : "DEBIT", amount: abs },
        { ...common, partyId: driver.partyId, side: pay ? "DEBIT" : "CREDIT", amount: abs },
      ];
      // relative vehicle: running balance settles on behalf of the owner
      const rel = await resolveRelativeOwner(tx, { driverId: d.driverId, at: date });
      if (rel) {
        entries.push(
          {
            ...common,
            partyId: rel.ownerId,
            side: pay ? "DEBIT" : "CREDIT",
            amount: abs,
            narration: `Driver running balance (${driver.name}, vehicle ${rel.vehicleNo}) — on behalf of relative owner`,
          },
          {
            ...common,
            partyId: driver.partyId,
            side: pay ? "CREDIT" : "DEBIT",
            amount: abs,
            narration: `Settlement transferred to relative owner ledger (${rel.vehicleNo})`,
          }
        );
      }
      await postLedger(tx, session, entries);
      await tx.driverSettlement.updateMany({
        where: { id: { in: pending.map((p) => p.id) } },
        data: { status: "SETTLED", settledDate: date, voucherId: voucher.id, voucherNo },
      });
      await audit(tx, session, {
        entity: "DriverSettlement",
        entityId: d.driverId,
        action: "UPDATE",
        after: { runningSettle: { net, voucherNo, entries: pending.length } },
      });
      revalidatePath(REVALIDATE);
      revalidatePath("/accounts/vouchers/register");
      return { ok: true as const, voucherNo, amount: net };
    });
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Settlement failed" };
  }
}

// ---------------------------------------------------------------- edit (manual)

const editSettlementSchema = z.object({
  id: z.string().min(1),
  date: z.string().min(1, "Date is required"),
  amount: z.number().refine((v) => v !== 0, "Amount cannot be zero"),
  tripRef: z.string().nullish(),
  remarks: z.string().nullish(),
});

/**
 * Edit a PENDING settlement entry. Trip-generated rows stay locked — their
 * amount comes from the trip sheet and must be edited there.
 */
export async function updateDriverSettlement(
  input: unknown
): Promise<{ ok: true } | { ok: false; error: string }> {
  const session = requireSession();
  const parsed = editSettlementSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid input" };
  const d = parsed.data;
  await authorize(session, "driver", "edit");
  try {
    return await withTenant(session.tenantId, async (tx) => {
      const before = await tx.driverSettlement.findFirst({
        where: { id: d.id, firmId: session.firmId, deletedAt: null },
      });
      if (!before) return { ok: false as const, error: "Settlement not found" };
      if (before.status === "SETTLED") return { ok: false as const, error: "Settled rows cannot be edited." };
      if (before.tripId) {
        return {
          ok: false as const,
          error: "This entry comes from a trip sheet — edit the trip sheet instead.",
        };
      }
      const after = await tx.driverSettlement.update({
        where: { id: before.id },
        data: {
          date: new Date(`${d.date}T00:00:00`),
          amount: d.amount,
          tripRef: d.tripRef?.trim() || null,
          remarks: d.remarks || null,
        },
      });
      await audit(tx, session, {
        entity: "DriverSettlement",
        entityId: before.id,
        action: "UPDATE",
        before,
        after,
      });
      revalidatePath(REVALIDATE);
      return { ok: true as const };
    });
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Update failed" };
  }
}
