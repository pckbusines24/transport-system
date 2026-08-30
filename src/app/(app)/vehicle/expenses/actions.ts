"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { requireSession } from "@/lib/session";
import { withTenant, type Tx } from "@/lib/db";
import { authorize } from "@/lib/authz";
import { audit } from "@/lib/audit";
import { assertDateInFy } from "@/lib/fy-guard";
import { postLedger, reverseLedger, type LedgerPostEntry } from "@/lib/ledger";
import { round2 } from "@/lib/calc/tds";
import { toNum } from "@/lib/utils";
import { settledByRef } from "@/lib/settlement";
import { revalidateOutstanding } from "@/lib/outstanding-cache";

/**
 * Vehicle Expenses — office-I&E-style accounting voucher with vehicle-wise
 * allocation. One voucher, unlimited vehicles. Posting (refType
 * VEHICLE_EXPENSE):
 *   EXPENSE: DR head total; supplier / cash-bank per the office rules
 *            (credit / direct / immediate payment).
 *   Relative vehicles: each relative share auto-transfers to the relative
 *   owner's ledger — DR owner party / CR head — so the company's final
 *   expense reduces and the amount sits against the vehicle owner.
 * Trip sheets only FETCH Diesel / Toll rows from here; they never write.
 */

const REVALIDATE = "/vehicle/expenses";

async function nextVoucherNo(tx: Tx, firmId: string, fyId: string, txnType: string) {
  const prefix = txnType === "INCOME" ? "VIN-" : "VEX-";
  const rows = await tx.$queryRaw<{ max: bigint | null }[]>`
    SELECT MAX(NULLIF(regexp_replace("voucherNo", '\\D', '', 'g'), '')::bigint) AS max
    FROM "VehicleExpenseVoucher"
    WHERE "firmId" = ${firmId} AND "fyId" = ${fyId} AND "txnType" = ${txnType}`;
  const max = rows[0]?.max ? Number(rows[0].max) : 0;
  return `${prefix}${String(max + 1).padStart(4, "0")}`;
}

const schema = z.object({
  id: z.string().nullish(),
  date: z.string().min(1, "Date is required"),
  txnType: z.enum(["EXPENSE", "INCOME"]).default("EXPENSE"),
  headId: z.string().min(1, "Expense head is required"),
  partyId: z.string().nullish(),
  paymentMode: z.enum(["CASH", "BANK", "CARD"]).nullish(), // blank = on credit
  bankPartyId: z.string().nullish(),
  paymentDate: z.string().nullish(), // may differ from the bill date
  refNo: z.string().nullish(),
  remarks: z.string().nullish(),
  attachmentPath: z.string().nullish(),
  attachmentName: z.string().nullish(),
  // what was bought, for bulk purchases allocated later
  itemName: z.string().nullish(),
  qty: z.number().min(0).nullish(),
  /** total of the bill when no vehicle is named yet (bulk purchase) */
  amount: z.number().min(0).nullish(),
  // A purchase does NOT have to name a vehicle: bulk stock (tyres, chains,
  // batteries, spares) is bought first and allocated to vehicles as they consume
  // it, from the Expense Allocation tab.
  items: z
    .array(
      z.object({
        vehicleId: z.string().min(1),
        amount: z.number().min(0.01),
        allocDate: z.string().nullish(),
        qty: z.number().min(0).nullish(),
        remarks: z.string().nullish(),
      })
    )
    .default([]),
  // one bill, many heads (optional): head-wise split of the same bill —
  // spare parts + repair labour on one invoice. Sum must equal the bill total.
  lines: z
    .array(
      z.object({
        headId: z.string().min(1),
        amount: z.number().min(0.01),
        remarks: z.string().nullish(),
      })
    )
    .default([]),
});

export async function saveVehicleExpenseTxn(
  input: unknown
): Promise<{ ok: true; id: string; voucherNo: string } | { ok: false; error: string }> {
  const session = requireSession();
  const parsed = schema.safeParse(input);
  if (!parsed.success) return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid input" };
  const d = parsed.data;
  await authorize(session, "vehicle", d.id ? "edit" : "create");
  if (d.attachmentPath && !d.attachmentPath.startsWith(`${session.tenantId}/`)) {
    return { ok: false, error: "Invalid attachment path" };
  }
  if (d.paymentMode && !d.bankPartyId) {
    return { ok: false, error: "Cash / Bank account is required when a payment mode is selected." };
  }
  if (!d.paymentMode && !d.partyId) {
    return {
      ok: false,
      error: "Select a Supplier/Party (credit entry) or a Payment Mode with Cash/Bank account.",
    };
  }
  const uniqVehicles = new Set(d.items.map((i) => i.vehicleId));
  if (uniqVehicles.size !== d.items.length) {
    return { ok: false, error: "The same vehicle is selected more than once." };
  }
  // A vehicle-wise entry totals its splits; a bulk purchase carries its own
  // amount and stays unallocated until vehicles consume it. When BOTH are
  // given, the bill amount wins (>= splits; the rest stays unallocated) —
  // silently shrinking a supplier bill to the split total would drop the
  // remainder from the ledger and the payable.
  const itemsTotal = round2(d.items.reduce((s, i) => s + i.amount, 0));
  const billAmt = d.amount != null ? round2(d.amount) : 0;
  const amount = billAmt > 0 ? billAmt : itemsTotal;
  if (amount <= 0) {
    return { ok: false, error: "Enter the purchase amount, or split it across vehicles." };
  }
  if (d.items.length && billAmt > 0 && billAmt < itemsTotal - 0.009) {
    return { ok: false, error: "Vehicle splits exceed the purchase amount." };
  }
  // a multi-head bill leads with its first line's head; the split must cover
  // the whole bill so every rupee lands in exactly one head
  if (d.lines.length) {
    const lineSum = round2(d.lines.reduce((s, l) => s + l.amount, 0));
    if (Math.abs(lineSum - amount) > 0.009) {
      return {
        ok: false,
        error: `Head-wise split (${lineSum.toFixed(2)}) must equal the bill amount (${amount.toFixed(2)}).`,
      };
    }
    d.headId = d.lines[0].headId;
  }

  try {
    const res = await withTenant(session.tenantId, async (tx) => {
      const head = await tx.accountHead.findFirst({ where: { id: d.headId } });
      if (!head) return { ok: false as const, error: "Head not found" };
      const lineHeads = d.lines.length
        ? await tx.accountHead.findMany({ where: { id: { in: d.lines.map((l) => l.headId) } } })
        : [];
      if (d.lines.length && lineHeads.length !== new Set(d.lines.map((l) => l.headId)).size) {
        return { ok: false as const, error: "A split head was not found." };
      }
      // every split head must match the entry's income/expense side, same as office
      for (const lh of lineHeads) {
        if (lh.kind !== d.txnType) {
          return {
            ok: false as const,
            error: `"${lh.name}" is a ${lh.kind} head — every split line must be a ${d.txnType} head.`,
          };
        }
      }

      // A bill that a payment voucher already settled cannot move underneath
      // it: paying it again in cash/bank or shrinking it below the settled
      // figure would double-pay the supplier (same rule as office entries).
      if (d.id) {
        const settledHere = await settledByRef(tx, {
          firmId: session.firmId,
          fyId: session.fyId,
          refTypes: ["VEHICLE_EXPENSE"],
          refIds: [d.id],
        });
        const settled = settledHere.get(d.id) ?? 0;
        if (settled > 0.009) {
          if (d.paymentMode) {
            return {
              ok: false as const,
              error: `${settled.toFixed(2)} is already settled against this bill by a voucher — remove that allocation before marking it paid in cash/bank.`,
            };
          }
          if (amount < settled - 0.009) {
            return {
              ok: false as const,
              error: `Amount cannot be less than the ${settled.toFixed(2)} already settled against this bill.`,
            };
          }
        }
      }

      const vehicles = await tx.vehicle.findMany({
        where: { id: { in: Array.from(uniqVehicles) } },
        select: { id: true, number: true, ownershipType: true, ownerId: true },
      });
      if (vehicles.length !== uniqVehicles.size) {
        return { ok: false as const, error: "One or more vehicles were not found." };
      }

      // an edit stays in the bill's own financial year (FY continuity); only
      // a fresh bill belongs to the session FY — the guard follows the doc
      const docFyId = d.id
        ? ((
            await tx.vehicleExpenseVoucher.findFirst({
              where: { id: d.id, firmId: session.firmId },
              select: { fyId: true },
            })
          )?.fyId ?? session.fyId)
        : session.fyId;
      await assertDateInFy(
        tx,
        { fyId: docFyId },
        new Date(`${d.date}T00:00:00`),
        "vehicle expense entry"
      );
      const values = {
        date: new Date(`${d.date}T00:00:00`),
        txnType: d.txnType,
        headId: d.headId,
        partyId: d.partyId || null,
        paymentMode: d.paymentMode || null,
        bankPartyId: d.paymentMode ? d.bankPartyId || null : null,
        paymentDate: d.paymentMode
          ? new Date(`${d.paymentDate || d.date}T00:00:00`)
          : null,
        amount,
        itemName: d.itemName?.trim() || null,
        qty: d.qty ?? null,
        refNo: d.refNo?.trim() || null,
        remarks: d.remarks || null,
        attachmentPath: d.attachmentPath || null,
        attachmentName: d.attachmentName || null,
      };

      let id: string;
      let voucherNo: string;
      // bulk-purchase allocation items that survive this edit — their
      // relative-owner transfers are reversed here and re-posted below so
      // they always follow the voucher's current head and reference
      let keptAllocItems: { id: string; vehicleId: string; amount: unknown; allocDate: Date }[] = [];
      if (d.id) {
        const before = await tx.vehicleExpenseVoucher.findFirstOrThrow({
          where: { id: d.id, deletedAt: null },
          include: { items: true },
        });
        // An edit that names no vehicle is a bulk purchase being corrected — its
        // allocations were made later, on their own dates, and must survive; the
        // amount just may not drop below what vehicles have already taken.
        if (!d.items.length) {
          const allocated = round2(
            before.items.reduce((s, i) => s + toNum(String(i.amount)), 0)
          );
          if (amount < allocated - 0.009) {
            return {
              ok: false as const,
              error: `${allocated} is already allocated to vehicles — the purchase cannot be reduced to ${amount}.`,
            };
          }
        }
        // a blank reference means "use the voucher number" — stored, not derived,
        // so the payment voucher, the register and the ledger all name the bill
        // the same way
        const updated = await tx.vehicleExpenseVoucher.update({
          where: { id: d.id },
          data: { ...values, refNo: values.refNo || before.voucherNo },
        });
        id = updated.id;
        voucherNo = updated.voucherNo;
        // an edit that names vehicles replaces the split it owns
        if (d.items.length) {
          await tx.vehicleExpenseItem.deleteMany({ where: { voucherId: id } });
        } else {
          keptAllocItems = before.items;
        }
        // allocation transfers hang off item ids — reverse them all, whether
        // the items are being replaced (their entries would be orphaned) or
        // kept (the head/reference may have changed); kept ones re-post below
        for (const item of before.items) {
          await reverseLedger(tx, "VEH_EXP_ALLOC", item.id);
        }
        await reverseLedger(tx, "VEHICLE_EXPENSE", id);
        await audit(tx, session, {
          entity: "VehicleExpenseVoucher",
          entityId: id,
          action: "UPDATE",
          before,
          after: { ...updated, items: d.items },
        });
      } else {
        voucherNo = await nextVoucherNo(tx, session.firmId, session.fyId, d.txnType);
        const created = await tx.vehicleExpenseVoucher.create({
          data: {
            tenantId: session.tenantId,
            firmId: session.firmId,
            fyId: session.fyId,
            voucherNo,
            createdById: session.userId,
            ...values,
            refNo: values.refNo || voucherNo,
          },
        });
        id = created.id;
        await audit(tx, session, {
          entity: "VehicleExpenseVoucher",
          entityId: id,
          action: "CREATE",
          after: { ...created, items: d.items },
        });
      }
      // replace the head-wise split (empty array clears back to single-head)
      await tx.vehicleExpenseLine.deleteMany({ where: { voucherId: id } });
      if (d.lines.length) {
        await tx.vehicleExpenseLine.createMany({
          data: d.lines.map((l) => ({
            tenantId: session.tenantId,
            voucherId: id,
            headId: l.headId,
            amount: l.amount,
            remarks: l.remarks || null,
          })),
        });
      }

      await tx.vehicleExpenseItem.createMany({
        data: d.items.map((i) => ({
          tenantId: session.tenantId,
          voucherId: id,
          vehicleId: i.vehicleId,
          amount: i.amount,
          // split at purchase time = allocated on the purchase date
          allocDate: i.allocDate ? new Date(`${i.allocDate}T00:00:00`) : values.date,
          qty: i.qty ?? null,
          remarks: i.remarks || null,
        })),
      });

      // ---- single accounting voucher (office-I&E rules) ----
      const paid = !!values.paymentMode && !!values.bankPartyId;
      const common = {
        date: values.date,
        refType: "VEHICLE_EXPENSE",
        refId: id,
        refNo: values.refNo || voucherNo,
      };
      const label = `${head.name}${values.remarks ? " — " + values.remarks : ""}`;
      const entries: LedgerPostEntry[] = [];
      const headSide = d.txnType === "EXPENSE" ? ("DEBIT" as const) : ("CREDIT" as const);
      const moneySide = d.txnType === "EXPENSE" ? ("CREDIT" as const) : ("DEBIT" as const);
      // multi-head bill: one head leg per split line; single-head: one leg.
      // Supplier / bank legs always stay on the bill total.
      const lineHeadName = new Map(lineHeads.map((h) => [h.id, h.name]));
      const headLegs = d.lines.length
        ? d.lines.map((l) => ({
            headId: l.headId,
            amount: l.amount,
            name: lineHeadName.get(l.headId) ?? "",
            tail: `${lineHeadName.get(l.headId) ?? ""}${l.remarks ? " — " + l.remarks : ""}`,
          }))
        : [{ headId: d.headId, amount, name: head.name, tail: label }];
      for (const leg of headLegs) {
        entries.push({
          ...common,
          accountHeadId: leg.headId,
          side: headSide,
          amount: leg.amount,
          narration: `Vehicle ${d.txnType.toLowerCase()} ${voucherNo}: ${leg.tail}`,
        });
      }
      // a relative/broker share of X splits across the lines in proportion, so
      // each head's credit matches what was debited for it (last line takes the
      // rounding remainder)
      const splitAcross = (x: number): { headId: string; amount: number; name: string }[] => {
        if (!d.lines.length) return [{ headId: d.headId, amount: x, name: head.name }];
        // shares are computed against the LINE total (not the voucher gross),
        // and the rounding remainder — positive or negative — folds into the
        // largest share so the sum ALWAYS equals x and nothing is dropped
        const linesTotal = round2(d.lines.reduce((s, l) => s + l.amount, 0)) || amount;
        const out = d.lines.map((l) => ({
          headId: l.headId,
          amount: round2((x * l.amount) / linesTotal),
          name: lineHeadName.get(l.headId) ?? "",
        }));
        const diff = round2(x - out.reduce((s, p) => s + p.amount, 0));
        if (Math.abs(diff) > 0.001) {
          const biggest = out.reduce((a, b) => (b.amount > a.amount ? b : a));
          biggest.amount = round2(biggest.amount + diff);
        }
        return out.filter((p) => p.amount > 0.001);
      };
      if (values.partyId) {
        entries.push({
          ...common,
          partyId: values.partyId,
          side: moneySide,
          amount,
          narration: `${d.txnType === "EXPENSE" ? "Supplier bill" : "Accrual"} ${common.refNo} — ${head.name}`,
        });
        if (paid) {
          entries.push({
            ...common,
            date: values.paymentDate ?? values.date,
            partyId: values.partyId,
            side: headSide,
            amount,
            narration: `${d.txnType === "EXPENSE" ? "Payment to supplier" : "Received"} (${values.paymentMode!.toLowerCase()}) ${voucherNo}`,
          });
        }
      }
      if (paid) {
        // money moves on the PAYMENT date, which may differ from the bill date
        entries.push({
          ...common,
          date: values.paymentDate ?? values.date,
          partyId: values.bankPartyId!,
          side: moneySide,
          amount,
          narration: `Vehicle ${d.txnType.toLowerCase()} ${voucherNo}: ${label}`,
        });
      }
      // relative-vehicle shares transfer to the relative owner's ledger
      if (d.txnType === "EXPENSE") {
        for (const item of d.items) {
          const v = vehicles.find((x) => x.id === item.vehicleId);
          if (v?.ownershipType === "RELATIVE" && v.ownerId) {
            entries.push({
              ...common,
              partyId: v.ownerId,
              side: "DEBIT",
              amount: item.amount,
              narration: `${head.name} for relative vehicle ${v.number} — transferred to owner`,
            });
            for (const part of splitAcross(item.amount)) {
              entries.push({
                ...common,
                accountHeadId: part.headId,
                side: "CREDIT",
                amount: part.amount,
                narration: `${part.name} ${v.number} — shifted to relative owner ledger`,
              });
            }
          }
        }
      }
      // stamped into the bill's own year — old-bill edits stay put
      await postLedger(tx, { ...session, fyId: docFyId }, entries);

      // re-post relative-owner transfers for bulk-purchase allocations that
      // survived the edit, against the voucher's CURRENT head and reference
      if (keptAllocItems.length && d.txnType === "EXPENSE") {
        const allocVehicles = await tx.vehicle.findMany({
          where: { id: { in: keptAllocItems.map((i) => i.vehicleId) } },
          select: { id: true, number: true, ownershipType: true, ownerId: true },
        });
        const byId = new Map(allocVehicles.map((v) => [v.id, v]));
        const transferEntries: LedgerPostEntry[] = [];
        for (const item of keptAllocItems) {
          const v = byId.get(item.vehicleId);
          if (v?.ownershipType !== "RELATIVE" || !v.ownerId) continue;
          const allocCommon = {
            date: item.allocDate,
            refType: "VEH_EXP_ALLOC",
            refId: item.id,
            refNo: values.refNo || voucherNo,
          };
          transferEntries.push({
            ...allocCommon,
            partyId: v.ownerId,
            side: "DEBIT",
            amount: toNum(String(item.amount)),
            narration: `${head.name} for relative vehicle ${v.number} — transferred to owner (allocation of ${voucherNo})`,
          });
          for (const part of splitAcross(toNum(String(item.amount)))) {
            transferEntries.push({
              ...allocCommon,
              accountHeadId: part.headId,
              side: "CREDIT",
              amount: part.amount,
              narration: `${part.name} ${v.number} — shifted to relative owner ledger (allocation of ${voucherNo})`,
            });
          }
        }
        if (transferEntries.length) {
          await postLedger(tx, { ...session, fyId: docFyId }, transferEntries);
        }
      }

      revalidatePath(REVALIDATE);
      return { ok: true as const, id, voucherNo };
    });
    if (res.ok) revalidateOutstanding(session.tenantId);
    return res;
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Save failed" };
  }
}

export async function deleteVehicleExpenseTxn(
  id: string
): Promise<{ ok: true } | { ok: false; error: string }> {
  const session = requireSession();
  if (session.role !== "ADMIN" && session.role !== "OWNER") {
    return { ok: false, error: "Only Admin/Owner may delete vehicle expenses" };
  }
  await authorize(session, "vehicle", "delete");
  try {
    await withTenant(session.tenantId, async (tx) => {
      const before = await tx.vehicleExpenseVoucher.findFirstOrThrow({
        where: { id, deletedAt: null },
        include: { items: true },
      });
      // a bill a payment voucher settled must not vanish under the voucher
      const settledHere = await settledByRef(tx, {
        firmId: session.firmId,
        fyId: session.fyId,
        refTypes: ["VEHICLE_EXPENSE"],
        refIds: [id],
      });
      if ((settledHere.get(id) ?? 0) > 0.009) {
        throw new Error(
          "A payment voucher already settles this bill — delete that voucher first."
        );
      }
      await tx.vehicleExpenseVoucher.update({ where: { id }, data: { deletedAt: new Date() } });
      await reverseLedger(tx, "VEHICLE_EXPENSE", id);
      // bulk-purchase allocations post relative-owner transfers under their
      // own item ids — reverse those too, or the owner keeps a phantom debit
      for (const item of before.items) {
        await reverseLedger(tx, "VEH_EXP_ALLOC", item.id);
      }
      await audit(tx, session, { entity: "VehicleExpenseVoucher", entityId: id, action: "DELETE", before });
    });
    revalidatePath(REVALIDATE);
    revalidateOutstanding(session.tenantId);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Delete failed" };
  }
}

// ------------------------------------------------- trip sheet fetch (read-only)

export interface TripFetchedExpenseRow {
  date: string;
  head: string;
  supplier: string;
  amount: number;
  voucherNo: string;
  remarks: string;
}

/**
 * Every OTHER vehicle expense booked in the range — everything the diesel/toll
 * fetch above deliberately skips (tyres, repairs, parking, RTO, spares...).
 *
 * Deliberately a separate action rather than a flag on the fetch above: that
 * one feeds the Diesel and Toll detail popups, and widening it would put
 * unrelated heads into them. The "Actual Income − Actual Expenses" method is
 * the only caller — the other two methods must keep seeing exactly what they
 * see today.
 */
export async function fetchOperatingExpensesForTrip(input: {
  vehicleId: string;
  dateFrom: string;
  dateTo: string;
}): Promise<{ total: number; rows: TripFetchedExpenseRow[] }> {
  const session = requireSession();
  return withTenant(session.tenantId, async (tx) => {
    const items = await tx.vehicleExpenseItem.findMany({
      where: {
        vehicleId: input.vehicleId,
        // the trip sees costs ALLOCATED to the vehicle in its dates, not stock
        // purchased in that window and fitted to some other vehicle later
        allocDate: {
          gte: new Date(`${input.dateFrom}T00:00:00`),
          lte: new Date(`${input.dateTo}T23:59:59`),
        },
        voucher: {
          firmId: session.firmId,
          txnType: "EXPENSE",
          deletedAt: null,
        },
      },
      include: { voucher: true },
    });
    if (!items.length) return { total: 0, rows: [] };
    const partyIds = Array.from(
      new Set(items.map((i) => i.voucher.partyId).filter(Boolean))
    ) as string[];
    const [heads, suppliers] = await Promise.all([
      tx.accountHead.findMany({
        where: { id: { in: Array.from(new Set(items.map((i) => i.voucher.headId))) } },
      }),
      partyIds.length
        ? tx.party.findMany({ where: { id: { in: partyIds } }, select: { id: true, name: true } })
        : Promise.resolve([]),
    ]);
    const headName = new Map(heads.map((h) => [h.id, h.name]));
    const supplierName = new Map(suppliers.map((p) => [p.id, p.name]));
    let total = 0;
    const rows: TripFetchedExpenseRow[] = [];
    for (const it of items) {
      const name = headName.get(it.voucher.headId) ?? "";
      const lower = name.toLowerCase();
      // diesel and toll are shown on their own lines already — counting them
      // here too would double the actual cost
      if (lower.includes("diesel") || lower.includes("toll")) continue;
      const amt = toNum(String(it.amount));
      total += amt;
      rows.push({
        date: it.voucher.date.toISOString(),
        head: name,
        supplier: it.voucher.partyId ? supplierName.get(it.voucher.partyId) ?? "" : "",
        amount: amt,
        voucherNo: it.voucher.voucherNo,
        remarks: it.voucher.remarks ?? "",
      });
    }
    return { total: round2(total), rows: rows.sort((a, b) => a.date.localeCompare(b.date)) };
  });
}

/**
 * Diesel / Toll booked for a vehicle in a date range — for the trip sheet's
 * settlement view only. Nothing else is fetched; nothing is ever created.
 */
export async function fetchVehicleExpensesForTrip(input: {
  vehicleId: string;
  dateFrom: string;
  dateTo: string;
}): Promise<{ dieselTotal: number; tollTotal: number; rows: TripFetchedExpenseRow[] }> {
  const session = requireSession();
  return withTenant(session.tenantId, async (tx) => {
    const items = await tx.vehicleExpenseItem.findMany({
      where: {
        vehicleId: input.vehicleId,
        // the trip sees costs ALLOCATED to the vehicle in its dates, not stock
        // purchased in that window and fitted to some other vehicle later
        allocDate: {
          gte: new Date(`${input.dateFrom}T00:00:00`),
          lte: new Date(`${input.dateTo}T23:59:59`),
        },
        voucher: {
          firmId: session.firmId,
          txnType: "EXPENSE",
          deletedAt: null,
        },
      },
      include: { voucher: true },
    });
    if (!items.length) return { dieselTotal: 0, tollTotal: 0, rows: [] };
    const partyIds = Array.from(
      new Set(items.map((i) => i.voucher.partyId).filter(Boolean))
    ) as string[];
    const [heads, suppliers] = await Promise.all([
      tx.accountHead.findMany({
        where: { id: { in: Array.from(new Set(items.map((i) => i.voucher.headId))) } },
      }),
      partyIds.length
        ? tx.party.findMany({ where: { id: { in: partyIds } }, select: { id: true, name: true } })
        : Promise.resolve([]),
    ]);
    const headName = new Map(heads.map((h) => [h.id, h.name]));
    const supplierName = new Map(suppliers.map((p) => [p.id, p.name]));
    let dieselTotal = 0;
    let tollTotal = 0;
    const rows: TripFetchedExpenseRow[] = [];
    for (const it of items) {
      const name = headName.get(it.voucher.headId) ?? "";
      const lower = name.toLowerCase();
      const isDiesel = lower.includes("diesel");
      const isToll = lower.includes("toll");
      if (!isDiesel && !isToll) continue; // only Diesel / Toll reach the trip sheet
      const amt = toNum(String(it.amount));
      if (isDiesel) dieselTotal += amt;
      else tollTotal += amt;
      rows.push({
        date: it.voucher.date.toISOString(),
        head: name,
        supplier: it.voucher.partyId ? supplierName.get(it.voucher.partyId) ?? "" : "",
        amount: amt,
        voucherNo: it.voucher.voucherNo,
        remarks: it.voucher.remarks ?? "",
      });
    }
    return {
      dieselTotal: round2(dieselTotal),
      tollTotal: round2(tollTotal),
      rows: rows.sort((a, b) => a.date.localeCompare(b.date)),
    };
  });
}
