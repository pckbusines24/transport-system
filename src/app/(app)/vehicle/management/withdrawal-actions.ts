"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { requireSession } from "@/lib/session";
import { withTenant } from "@/lib/db";
import { authorize } from "@/lib/authz";
import { audit } from "@/lib/audit";
import { postLedger, reverseLedger } from "@/lib/ledger";

/**
 * Owner Withdrawal — an owner drawing money out of a vehicle's earnings —
 * and its mirror, Owner Deposit — the owner putting money in. Neither is an
 * expense or income: net profit stays untouched; only the vehicle's running
 * balance (lifetime net − withdrawals + deposits) moves. Ledger:
 *   WITHDRAWAL  DEBIT owner party,  CREDIT the paying bank/cash party
 *   DEPOSIT     CREDIT owner party, DEBIT the receiving bank/cash party
 * so the owner's ledger and the bank/cash book both carry the entry.
 */
const withdrawalSchema = z.object({
  kind: z.enum(["WITHDRAWAL", "DEPOSIT"]).default("WITHDRAWAL"),
  vehicleId: z.string().min(1, "Vehicle is required"),
  partyId: z.string().min(1, "Owner (party) is required"),
  payPartyId: z.string().min(1, "Paid-from bank/cash is required"),
  date: z.string().min(1, "Date is required"), // ISO yyyy-mm-dd
  amount: z.number().min(0.01, "Amount must be positive"),
  remarks: z.string().optional(),
});

export async function saveVehicleWithdrawal(
  input: unknown
): Promise<{ ok: true } | { ok: false; error: string }> {
  const session = requireSession();
  const parsed = withdrawalSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid input" };
  }
  const d = parsed.data;
  await authorize(session, "vehicle", "create");

  try {
    return await withTenant(session.tenantId, async (tx) => {
      const [vehicle, party, payParty] = await Promise.all([
        tx.vehicle.findFirst({
          where: { id: d.vehicleId, ownershipType: { in: ["OWNER", "RELATIVE"] } },
        }),
        tx.party.findFirst({ where: { id: d.partyId, isActive: true } }),
        tx.party.findFirst({
          where: { id: d.payPartyId, isActive: true, ledgerGroup: { in: ["BANK", "CASH", "CARD"] } },
        }),
      ]);
      if (!vehicle) return { ok: false as const, error: "Vehicle not found (Own/Relative only)." };
      if (!party) return { ok: false as const, error: "Owner party not found." };
      if (!payParty) return { ok: false as const, error: "Paid-from must be a Bank/Cash/Card party." };

      const created = await tx.vehicleWithdrawal.create({
        data: {
          tenantId: session.tenantId,
          firmId: session.firmId,
          fyId: session.fyId,
          vehicleId: d.vehicleId,
          kind: d.kind,
          partyId: d.partyId,
          payPartyId: d.payPartyId,
          date: new Date(d.date),
          amount: d.amount,
          remarks: d.remarks || null,
          createdById: session.userId,
        },
      });

      const deposit = d.kind === "DEPOSIT";
      // the ledger shows this as the module, so a deposit must not read as a withdrawal
      const refType = deposit ? "VEH_DEPOSIT" : "VEH_WITHDRAWAL";
      const refNo = `${deposit ? "JMA" : "NIK"}-${created.id.slice(-6).toUpperCase()}`;
      const narration = `Owner ${deposit ? "deposit" : "withdrawal"} — ${vehicle.number}${d.remarks ? ` (${d.remarks})` : ""}`;
      await postLedger(tx, session, [
        {
          date: new Date(d.date),
          partyId: d.partyId,
          side: deposit ? "CREDIT" : "DEBIT",
          amount: d.amount,
          refType,
          refId: created.id,
          refNo,
          narration,
        },
        {
          date: new Date(d.date),
          partyId: d.payPartyId,
          side: deposit ? "DEBIT" : "CREDIT",
          amount: d.amount,
          refType,
          refId: created.id,
          refNo,
          narration,
        },
      ]);

      await audit(tx, session, {
        entity: "VehicleWithdrawal",
        entityId: created.id,
        action: "CREATE",
        after: created,
      });
      revalidatePath("/vehicle/management");
      return { ok: true as const };
    });
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "Save failed" };
  }
}

export async function deleteVehicleWithdrawal(
  id: string
): Promise<{ ok: true } | { ok: false; error: string }> {
  const session = requireSession();
  await authorize(session, "vehicle", "delete");
  try {
    return await withTenant(session.tenantId, async (tx) => {
      const before = await tx.vehicleWithdrawal.findFirst({
        where: { id, firmId: session.firmId, deletedAt: null },
      });
      if (!before) return { ok: false as const, error: "Withdrawal / deposit entry not found." };
      await reverseLedger(tx, before.kind === "DEPOSIT" ? "VEH_DEPOSIT" : "VEH_WITHDRAWAL", id);
      const deleted = await tx.vehicleWithdrawal.update({
        where: { id },
        data: { deletedAt: new Date() },
      });
      await audit(tx, session, {
        entity: "VehicleWithdrawal",
        entityId: id,
        action: "DELETE",
        before,
        after: deleted,
      });
      revalidatePath("/vehicle/management");
      return { ok: true as const };
    });
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "Delete failed" };
  }
}
