"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { requireSession } from "@/lib/session";
import { withTenant } from "@/lib/db";
import { authorize } from "@/lib/authz";
import { audit } from "@/lib/audit";
import { postLedger, reverseLedger, type LedgerPostEntry } from "@/lib/ledger";
import { resolveRelativeOwner } from "@/lib/relative-owner";
import { toNum } from "@/lib/utils";

/**
 * Driver Advance Register — the PRIMARY source of driver advance data. Trip
 * sheets only FETCH from here (by vehicle + driver + date range); they never
 * create advances. Each paid advance posts DEBIT driver ledger / CREDIT the
 * cash-bank account (refType DRIVER_ADVANCE).
 */

const REVALIDATE = "/vehicle/driver-advances";

const schema = z.object({
  id: z.string().nullish(),
  date: z.string().min(1, "Date is required"),
  driverId: z.string().min(1, "Driver is required"),
  vehicleId: z.string().nullish(),
  tripRef: z.string().nullish(),
  amount: z.number().min(0.01, "Amount is required"),
  paymentMode: z.enum(["CASH", "BANK", "CARD"]).default("CASH"),
  bankPartyId: z.string().nullish(),
  voucherRef: z.string().nullish(),
  remarks: z.string().nullish(),
});

export async function saveDriverAdvance(
  input: unknown
): Promise<{ ok: true; id: string } | { ok: false; error: string }> {
  const session = requireSession();
  const parsed = schema.safeParse(input);
  if (!parsed.success) return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid input" };
  const d = parsed.data;
  await authorize(session, "driver", d.id ? "edit" : "create");

  try {
    return await withTenant(session.tenantId, async (tx) => {
      const driver = await tx.driver.findFirst({ where: { id: d.driverId, deletedAt: null } });
      if (!driver) return { ok: false as const, error: "Driver not found" };
      // an advance that cannot post to the ledger must not save at all — a
      // silent skip here left cash advances invisible to the accounts
      if (!driver.partyId) {
        return {
          ok: false as const,
          error: `${driver.name} has no linked ledger party — open Driver Master and link/create one, then record the advance.`,
        };
      }

      const values = {
        date: new Date(`${d.date}T00:00:00`),
        driverId: d.driverId,
        vehicleId: d.vehicleId || null,
        tripRef: d.tripRef?.trim() || null,
        amount: d.amount,
        paymentMode: d.paymentMode,
        bankPartyId: d.bankPartyId || null,
        voucherRef: d.voucherRef?.trim() || null,
        remarks: d.remarks || null,
      };

      // resolve the money-side ledger BEFORE saving, so a missing cash/bank
      // account blocks the save instead of producing an unposted advance
      let creditPartyId = values.bankPartyId;
      if (!creditPartyId) {
        const cash = await tx.party.findFirst({
          where: { ledgerGroup: "CASH", isActive: true },
          orderBy: { name: "asc" },
          select: { id: true },
        });
        creditPartyId = cash?.id ?? null;
      }
      if (!creditPartyId) {
        return {
          ok: false as const,
          error:
            "No Cash account exists — create one in Masters → Accounts (Bank / Cash / Card), or pick a bank account, so the advance can post to the ledger.",
        };
      }

      let id: string;
      if (d.id) {
        const before = await tx.driverAdvance.findFirstOrThrow({
          // firm-scoped: an advance id from another firm must not be editable here
          where: { id: d.id, firmId: session.firmId, deletedAt: null },
        });
        if (before.status === "ADJUSTED") {
          return { ok: false as const, error: "Advance already adjusted in a trip sheet — cannot edit." };
        }
        const updated = await tx.driverAdvance.update({ where: { id: d.id }, data: values });
        id = updated.id;
        await reverseLedger(tx, "DRIVER_ADVANCE", id);
        await audit(tx, session, { entity: "DriverAdvance", entityId: id, action: "UPDATE", before, after: updated });
      } else {
        const created = await tx.driverAdvance.create({
          data: {
            tenantId: session.tenantId,
            firmId: session.firmId,
            fyId: session.fyId,
            createdById: session.userId,
            ...values,
          },
        });
        id = created.id;
        await audit(tx, session, { entity: "DriverAdvance", entityId: id, action: "CREATE", after: created });
      }

      // Ledger: the driver owes the advance, and money leaves cash/bank —
      // ALWAYS posted (both ledgers were validated above).
      {
        const common = {
          date: values.date,
          refType: "DRIVER_ADVANCE",
          refId: id,
          refNo: values.voucherRef || values.tripRef || `ADV-${driver.driverCode}`,
          narration: `Driver advance to ${driver.name}${values.tripRef ? ` (trip ${values.tripRef})` : ""}`,
        };
        const entries: LedgerPostEntry[] = [
          { ...common, partyId: driver.partyId, side: "DEBIT", amount: d.amount },
          { ...common, partyId: creditPartyId, side: "CREDIT", amount: d.amount },
        ];
        // relative vehicle: the advance is paid ON BEHALF OF the relative
        // owner — shift the recoverable from the driver to the owner's ledger
        const rel = await resolveRelativeOwner(tx, {
          vehicleId: values.vehicleId,
          driverId: d.driverId,
          at: values.date,
        });
        if (rel) {
          entries.push(
            {
              ...common,
              partyId: rel.ownerId,
              side: "DEBIT",
              amount: d.amount,
              narration: `Driver advance (${driver.name}, vehicle ${rel.vehicleNo}) — paid on behalf of relative owner`,
            },
            {
              ...common,
              partyId: driver.partyId,
              side: "CREDIT",
              amount: d.amount,
              narration: `Advance transferred to relative owner ledger (${rel.vehicleNo})`,
            }
          );
        }
        await postLedger(tx, session, entries);
      }

      revalidatePath(REVALIDATE);
      return { ok: true as const, id };
    });
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Save failed" };
  }
}

export async function deleteDriverAdvance(
  id: string
): Promise<{ ok: true } | { ok: false; error: string }> {
  const session = requireSession();
  if (session.role !== "ADMIN" && session.role !== "OWNER") {
    return { ok: false, error: "Only Admin/Owner may delete driver advances" };
  }
  await authorize(session, "driver", "delete");
  try {
    await withTenant(session.tenantId, async (tx) => {
      const before = await tx.driverAdvance.findFirstOrThrow({
        where: { id, firmId: session.firmId, deletedAt: null },
      });
      if (before.status === "ADJUSTED") throw new Error("Advance already adjusted in a trip sheet.");
      await tx.driverAdvance.update({ where: { id }, data: { deletedAt: new Date() } });
      await reverseLedger(tx, "DRIVER_ADVANCE", id);
      await audit(tx, session, { entity: "DriverAdvance", entityId: id, action: "DELETE", before });
    });
    revalidatePath(REVALIDATE);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Delete failed" };
  }
}

// ------------------------------------------------- trip sheet fetch (read-only)

export interface DriverAdvanceFetchRow {
  id: string;
  date: string; // ISO
  amount: number;
  paymentMode: string;
  voucherRef: string;
  tripRef: string;
  remarks: string;
}

/**
 * Trip Sheet integration: total + detail of PENDING advances for a vehicle /
 * driver in a date range. Already-adjusted advances are excluded so no
 * duplicate consumption can occur.
 */
export async function fetchDriverAdvancesForTrip(input: {
  driverId: string;
  vehicleId?: string | null;
  dateFrom: string;
  dateTo: string;
  includeTripId?: string | null;
}): Promise<{ total: number; rows: DriverAdvanceFetchRow[] }> {
  const session = requireSession();
  return withTenant(session.tenantId, async (tx) => {
    const rows = await tx.driverAdvance.findMany({
      where: {
        firmId: session.firmId,
        driverId: input.driverId,
        deletedAt: null,
        AND: [
          ...(input.vehicleId
            ? [{ OR: [{ vehicleId: input.vehicleId }, { vehicleId: null }] }]
            : []),
          // pending, or already linked to THIS trip (edit case)
          input.includeTripId
            ? { OR: [{ status: "PENDING" as const }, { tripId: input.includeTripId }] }
            : { status: "PENDING" as const },
        ],
        date: {
          gte: new Date(`${input.dateFrom}T00:00:00`),
          lte: new Date(`${input.dateTo}T23:59:59`),
        },
      },
      orderBy: { date: "asc" },
    });
    const out = rows.map((r) => ({
      id: r.id,
      date: r.date.toISOString(),
      amount: toNum(String(r.amount)),
      paymentMode: r.paymentMode,
      voucherRef: r.voucherRef ?? "",
      tripRef: r.tripRef ?? "",
      remarks: r.remarks ?? "",
    }));
    return { total: Math.round(out.reduce((s, r) => s + r.amount, 0) * 100) / 100, rows: out };
  });
}
