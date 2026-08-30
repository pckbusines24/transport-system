"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { requireSession } from "@/lib/session";
import { withTenant } from "@/lib/db";
import { authorize } from "@/lib/authz";
import { audit } from "@/lib/audit";
import {
  ensureAccountHead,
  postLedger,
  reverseLedger,
  type LedgerPostEntry,
} from "@/lib/ledger";
import { revalidateOutstanding } from "@/lib/outstanding-cache";
import { settledByRef } from "@/lib/settlement";
import { toNum } from "@/lib/utils";

/**
 * AdBlue (Urea) stock register.
 *
 * Stock arrives before the supplier's invoice does, so a refill is entered in
 * two steps. Step one records the receipt — date, supplier, litres — and posts
 * NOTHING: quantity moves, no ledger entry, no payable. It sits as "Pending
 * Bill". Step two edits the SAME record with the bill (amount, bill no, date,
 * GST, payment) and only then does the accounting happen: Urea Expense Dr /
 * Supplier Cr, plus Supplier Dr / Cash-Bank Cr when it was paid on the spot.
 * Left on credit it is a payable the Payment Voucher settles (ADBLUE_PURCHASE).
 *
 * The purchase never touches a vehicle. Urea reaches a vehicle's P&L only
 * through trip-sheet consumption (litres x rate), which is where the owner,
 * relative-vehicle and broker rules already apply — none of that changes here.
 */

const REVALIDATE = "/vehicle/adblue";

const schema = z.object({
  id: z.string().nullish(),
  type: z.enum(["REFILL", "ISSUE"]),
  date: z.string().min(1, "Date is required"),
  supplierName: z.string().nullish(),
  supplierId: z.string().nullish(),
  vehicleId: z.string().nullish(),
  destination: z.string().nullish(),
  qty: z.number().min(0.01, "Quantity (litres) is required"),
  // everything below is optional at receipt time and filled in when the bill
  // turns up a day or two later
  amount: z.number().min(0).default(0),
  billNo: z.string().nullish(),
  billDate: z.string().nullish(),
  gstPct: z.number().min(0).default(0),
  gstAmount: z.number().min(0).default(0),
  paymentMode: z.enum(["CASH", "BANK", "CARD"]).nullish(), // blank = on credit
  bankPartyId: z.string().nullish(),
  refNo: z.string().nullish(),
  remarks: z.string().nullish(),
});

export async function saveAdblueTxn(
  input: unknown
): Promise<{ ok: true; id: string } | { ok: false; error: string }> {
  const session = requireSession();
  const parsed = schema.safeParse(input);
  if (!parsed.success) return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid input" };
  const d = parsed.data;
  await authorize(session, "adblue", d.id ? "edit" : "create");
  if (d.type === "ISSUE" && !d.vehicleId) {
    return { ok: false, error: "Vehicle is required for an issue entry." };
  }
  // Bill details travel together: an amount without a bill number (or the other
  // way round) is a half-entered invoice, and it decides whether accounting is
  // posted at all.
  const billed = d.type === "REFILL" && d.amount > 0 && !!d.billNo?.trim();
  if (d.type === "REFILL" && d.amount > 0 && !d.billNo?.trim()) {
    return { ok: false, error: "Enter the bill number along with the purchase amount." };
  }
  if (billed && !d.supplierId && !d.bankPartyId) {
    return {
      ok: false,
      error: "Choose the supplier ledger, or a payment mode with a cash/bank account.",
    };
  }
  if (d.paymentMode && !d.bankPartyId) {
    return { ok: false, error: "Cash / Bank account is required when a payment mode is selected." };
  }

  try {
    const res = await withTenant(session.tenantId, async (tx) => {
      const isRefill = d.type === "REFILL";
      const billNo = isRefill ? d.billNo?.trim() || null : null;
      const supplierId = isRefill ? d.supplierId || null : null;
      // The same invoice must not be booked twice against one supplier — the
      // second entry would double both the expense and what he is owed.
      if (billNo && supplierId) {
        const dupe = await tx.adblueTxn.findFirst({
          where: {
            firmId: session.firmId,
            supplierId,
            billNo,
            deletedAt: null,
            ...(d.id ? { id: { not: d.id } } : {}),
          },
        });
        if (dupe) {
          return {
            ok: false as const,
            error: `Bill ${billNo} is already entered for this supplier.`,
          };
        }
      }

      const values = {
        type: d.type,
        date: new Date(`${d.date}T00:00:00`),
        supplierName: isRefill ? d.supplierName?.trim() || null : null,
        supplierId,
        vehicleId: d.vehicleId || null,
        destination: d.type === "ISSUE" ? d.destination?.trim() || null : null,
        qty: d.qty,
        amount: isRefill ? d.amount : 0,
        billNo,
        billDate: isRefill && d.billDate ? new Date(`${d.billDate}T00:00:00`) : null,
        gstPct: isRefill ? d.gstPct : 0,
        gstAmount: isRefill ? d.gstAmount : 0,
        paymentMode: isRefill ? d.paymentMode || null : null,
        bankPartyId: isRefill ? d.bankPartyId || null : null,
        refNo: d.refNo?.trim() || null,
        remarks: d.remarks || null,
      };
      let id: string;
      if (d.id) {
        const before = await tx.adblueTxn.findFirstOrThrow({ where: { id: d.id, deletedAt: null } });
        const updated = await tx.adblueTxn.update({ where: { id: d.id }, data: values });
        id = updated.id;
        await audit(tx, session, { entity: "AdblueTxn", entityId: id, action: "UPDATE", before, after: updated });
      } else {
        const created = await tx.adblueTxn.create({
          data: {
            tenantId: session.tenantId,
            firmId: session.firmId,
            fyId: session.fyId,
            createdById: session.userId,
            ...values,
          },
        });
        id = created.id;
        await audit(tx, session, { entity: "AdblueTxn", entityId: id, action: "CREATE", after: created });
      }

      // Accounting happens ONLY once the bill is in. A stock receipt awaiting its
      // invoice posts nothing — no expense, no payable — and an issue never
      // posts anything, because urea reaches a vehicle through the trip sheet.
      // No entry here carries a vehicleId: the purchase must never land in
      // vehicle P&L or the vehicle expense register.
      await reverseLedger(tx, "ADBLUE", id);
      if (billed) {
        const ureaHead = await ensureAccountHead(tx, session, "Urea Expense", "EXPENSE");
        const common = {
          date: values.billDate ?? values.date,
          refType: "ADBLUE",
          refId: id,
          refNo: values.billNo || values.refNo || "ADBLUE",
          narration: `AdBlue purchase ${values.qty} L${values.supplierName ? " — " + values.supplierName : ""}`,
        };
        const entries: LedgerPostEntry[] = [
          { ...common, accountHeadId: ureaHead, side: "DEBIT", amount: values.amount },
        ];
        if (values.supplierId) {
          // bill on the supplier; paying it is a second, separate pair of legs so
          // a credit purchase leaves a payable behind
          entries.push({
            ...common,
            partyId: values.supplierId,
            side: "CREDIT" as const,
            amount: values.amount,
          });
          if (values.paymentMode && values.bankPartyId) {
            entries.push(
              {
                ...common,
                partyId: values.supplierId,
                side: "DEBIT" as const,
                amount: values.amount,
                narration: `Payment to supplier (${values.paymentMode.toLowerCase()}) — bill ${values.billNo}`,
              },
              {
                ...common,
                partyId: values.bankPartyId,
                side: "CREDIT" as const,
                amount: values.amount,
                narration: `AdBlue purchase ${values.qty} L — bill ${values.billNo}`,
              }
            );
          }
        } else {
          // no supplier ledger: a straight cash/bank purchase, as before
          entries.push({
            ...common,
            partyId: values.bankPartyId!,
            side: "CREDIT" as const,
            amount: values.amount,
          });
        }
        await postLedger(tx, session, entries);
      }
      revalidatePath(REVALIDATE);
      return { ok: true as const, id };
    });
    if (res.ok) revalidateOutstanding(session.tenantId);
    return res;
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Save failed" };
  }
}

export async function deleteAdblueTxn(
  id: string
): Promise<{ ok: true } | { ok: false; error: string }> {
  const session = requireSession();
  if (session.role !== "ADMIN" && session.role !== "OWNER") {
    return { ok: false, error: "Only Admin/Owner may delete AdBlue entries" };
  }
  await authorize(session, "adblue", "delete");
  try {
    await withTenant(session.tenantId, async (tx) => {
      const before = await tx.adblueTxn.findFirstOrThrow({
        where: { id, firmId: session.firmId, fyId: session.fyId, deletedAt: null },
      });
      // a refill already settled by a Payment Voucher must not vanish — the
      // voucher's allocation would keep paying a bill that no longer exists
      const settled =
        (
          await settledByRef(tx, {
            firmId: session.firmId,
            fyId: session.fyId,
            refTypes: ["ADBLUE_PURCHASE"],
            refIds: [id],
          })
        ).get(id) ?? 0;
      if (settled > 0.009) {
        throw new Error(
          "This AdBlue bill is already settled through a voucher — delete/reverse that voucher first."
        );
      }
      await tx.adblueTxn.update({ where: { id }, data: { deletedAt: new Date() } });
      await reverseLedger(tx, "ADBLUE", id);
      await audit(tx, session, { entity: "AdblueTxn", entityId: id, action: "DELETE", before });
    });
    revalidatePath(REVALIDATE);
    revalidateOutstanding(session.tenantId);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Delete failed" };
  }
}

// ------------------------------------------------- trip sheet fetch (read-only)

/** Total urea litres ISSUED to a vehicle in a date range (trip sheet fetch). */
export async function fetchAdblueForTrip(input: {
  vehicleId: string;
  dateFrom: string;
  dateTo: string;
}): Promise<{
  totalQty: number;
  rows: { id: string; date: string; destination: string; qty: number; remarks: string }[];
}> {
  const session = requireSession();
  return withTenant(session.tenantId, async (tx) => {
    const rows = await tx.adblueTxn.findMany({
      where: {
        firmId: session.firmId,
        type: "ISSUE",
        vehicleId: input.vehicleId,
        deletedAt: null,
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
      destination: r.destination ?? "",
      qty: toNum(String(r.qty)),
      remarks: r.remarks ?? "",
    }));
    return { totalQty: Math.round(out.reduce((s, r) => s + r.qty, 0) * 100) / 100, rows: out };
  });
}
