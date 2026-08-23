"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { requireSession } from "@/lib/session";
import { withTenant } from "@/lib/db";
import { authorize } from "@/lib/authz";
import { audit } from "@/lib/audit";
import { ensureAccountHead, postLedger, reverseLedger, type LedgerPostEntry } from "@/lib/ledger";
import { recoverShortage } from "@/lib/shortage";
import { resolveRelativeOwner } from "@/lib/relative-owner";
import { round2 } from "@/lib/calc/tds";
import { toNum } from "@/lib/utils";

/**
 * Driver Salary — separate from trip settlement and driver advance.
 * Pending shortages surface at processing time; the user CHOOSES whether to
 * adjust them (never forced). Posting (refType DRIVER_SALARY):
 *   DR "Driver Salary Expense" gross
 *   CR driver party (net + advance recovery)   [advance recovery nets against
 *                                               the existing advance debit]
 *   CR "Shortage Recovery (Driver)" shortage   + mark shortages ADJUSTED
 *   CR "Salary Deductions (Driver)" other deductions
 * On payment: CR cash/bank net, DR driver party net.
 */

const REVALIDATE = "/vehicle/driver-salary";

// ------------------------------------------------------- salary advance markers
// DriverAdvance has no salaryId column, so a salary that consumes register rows
// stamps them through a machine-readable remark tag — same family as the trip
// sheet's tripId link and the F&F's remainder remarks. The tag is what lets a
// salary edit / delete restore exactly the rows it consumed.
const salaryAdvTag = (salaryId: string) => `[SAL-ADV:${salaryId}]`;
const salaryAdvRemTag = (salaryId: string) => `[SAL-ADV-REM:${salaryId}]`;

/** Undo the remark chunk `consumeAdvance` appended for this salary. */
function stripSalaryAdvTag(remarks: string | null, salaryId: string): string | null {
  if (!remarks) return null;
  const idx = remarks.indexOf(salaryAdvTag(salaryId));
  if (idx < 0) return remarks;
  // the appended chunk contains no " · " itself, so the last separator before
  // the tag is the one that joined it to the original remark
  const sep = remarks.lastIndexOf(" · ", idx);
  const cleaned = sep >= 0 ? remarks.slice(0, sep) : "";
  return cleaned.trim() || null;
}

// ---------------------------------------------------------------- shortage entry

const shortageSchema = z.object({
  date: z.string().min(1, "Date is required"),
  driverId: z.string().min(1, "Driver is required"),
  tripRef: z.string().nullish(),
  amount: z.number().min(0.01, "Amount is required"),
  remarks: z.string().nullish(),
});

export async function saveDriverShortage(
  input: unknown
): Promise<{ ok: true } | { ok: false; error: string }> {
  const session = requireSession();
  const parsed = shortageSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid input" };
  const d = parsed.data;
  await authorize(session, "driver", "create");
  try {
    await withTenant(session.tenantId, async (tx) => {
      const created = await tx.driverShortage.create({
        data: {
          tenantId: session.tenantId,
          firmId: session.firmId,
          fyId: session.fyId,
          date: new Date(`${d.date}T00:00:00`),
          driverId: d.driverId,
          tripRef: d.tripRef?.trim() || null,
          amount: d.amount,
          remarks: d.remarks || null,
        },
      });
      // Recording a driver shortage IS the recovery: the driver is answerable
      // for it, so it comes back off the shortage ledger here and the driver is
      // debited. Deducting it later in salary / F&F must NOT post again.
      const driver = await tx.driver.findUnique({ where: { id: d.driverId } });
      const refNo = d.tripRef?.trim() || `SHT-${driver?.driverCode ?? ""}`;
      await recoverShortage(tx, session, {
        date: created.date,
        module: "DRIVER",
        refId: created.id,
        refNo,
        source: "DRIVER",
        partyKind: "DRIVER",
        partyId: driver?.partyId ?? null,
        driverId: d.driverId,
        amount: d.amount,
        remarks: d.remarks || null,
      });
      // the driver owes it — the counter leg of the recovery
      if (driver?.partyId) {
        await postLedger(tx, session, [
          {
            date: created.date,
            refType: "DRIVER_SHORTAGE",
            refId: created.id,
            refNo,
            partyId: driver.partyId,
            side: "DEBIT",
            amount: d.amount,
            narration: `Shortage recorded against ${driver.name}${d.tripRef ? ` (trip ${d.tripRef})` : ""}`,
          },
        ]);
      }
      await audit(tx, session, {
        entity: "DriverShortage",
        entityId: created.id,
        action: "CREATE",
        after: created,
      });
    });
    revalidatePath(REVALIDATE);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Save failed" };
  }
}

/** Pending shortages of a driver (remaining after partial adjustments). */
export async function getPendingShortages(driverId: string): Promise<{
  total: number;
  rows: { id: string; date: string; tripRef: string; amount: number; remarks: string }[];
}> {
  const session = requireSession();
  return withTenant(session.tenantId, async (tx) => {
    const rows = await tx.driverShortage.findMany({
      where: { firmId: session.firmId, driverId, status: "PENDING", deletedAt: null },
      orderBy: { date: "asc" },
    });
    const out = rows
      .map((r) => ({
        id: r.id,
        date: r.date.toISOString(),
        tripRef: r.tripRef ?? "",
        amount: round2(toNum(String(r.amount)) - toNum(String(r.adjustedAmount))),
        remarks: r.remarks ?? "",
      }))
      .filter((r) => r.amount > 0);
    return { total: round2(out.reduce((s, r) => s + r.amount, 0)), rows: out };
  });
}

// ---------------------------------------------------------------- process salary

const salarySchema = z.object({
  id: z.string().nullish(),
  driverId: z.string().min(1, "Driver is required"),
  // month 01-12 only — "2026-13" would post an Invalid Date into the ledger
  month: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, "Salary month is required"),
  salaryAmount: z.number().min(0),
  incentive: z.number().min(0).default(0),
  bonus: z.number().min(0).default(0),
  otherAllowance: z.number().min(0).default(0),
  advanceAdjust: z.number().min(0).default(0),
  adjustShortage: z.boolean().default(false), // user's Yes / No — never forced
  otherDeductions: z.number().min(0).default(0),
  remarks: z.string().nullish(),
});

export async function processDriverSalary(
  input: unknown
): Promise<{ ok: true; id: string; netPayable: number } | { ok: false; error: string }> {
  const session = requireSession();
  const parsed = salarySchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid input" };
  const d = parsed.data;
  await authorize(session, "driver", d.id ? "edit" : "create");

  try {
    return await withTenant(session.tenantId, async (tx) => {
      const driver = await tx.driver.findFirst({ where: { id: d.driverId, deletedAt: null } });
      if (!driver?.partyId) return { ok: false as const, error: "Driver (or its ledger party) not found" };

      const dup = await tx.driverSalary.findFirst({
        // month embeds the year (yyyy-mm) — firm-wide stays precise
        where: {
          firmId: session.firmId,
          driverId: d.driverId,
          month: d.month,
          deletedAt: null,
          ...(d.id ? { id: { not: d.id } } : {}),
        },
      });
      if (dup) return { ok: false as const, error: `Salary for ${d.month} already processed for this driver.` };

      // edit guards live up here so the advance validation below can count the
      // rows this salary previously consumed as available again
      const before = d.id
        ? await tx.driverSalary.findFirst({
            where: { id: d.id, firmId: session.firmId, deletedAt: null },
          })
        : null;
      if (d.id) {
        if (!before) return { ok: false as const, error: "Salary record not found." };
        if (before.paymentStatus === "PAID") {
          return { ok: false as const, error: "Salary already paid — cannot edit." };
        }
        if (toNum(String(before.paidAmount)) > 0) {
          return { ok: false as const, error: "Salary has payments against it — cannot edit." };
        }
      }

      // Advance register: PENDING rows, plus (on edit) what THIS salary
      // consumed earlier — those return to PENDING before re-consumption. The
      // register is the source of truth; a recovery that does not consume its
      // rows would let a trip sheet or the F&F recover the same advance again.
      const [pendingAdvances, prevConsumed, prevRemainders] = await Promise.all([
        tx.driverAdvance.findMany({
          where: { firmId: session.firmId, driverId: d.driverId, status: "PENDING", deletedAt: null },
          orderBy: { date: "asc" },
        }),
        d.id
          ? tx.driverAdvance.findMany({
              where: {
                firmId: session.firmId,
                status: "ADJUSTED",
                deletedAt: null,
                remarks: { contains: salaryAdvTag(d.id) },
              },
            })
          : Promise.resolve([]),
        d.id
          ? tx.driverAdvance.findMany({
              where: {
                firmId: session.firmId,
                deletedAt: null,
                remarks: { contains: salaryAdvRemTag(d.id) },
              },
            })
          : Promise.resolve([]),
      ]);
      // a remainder row this salary split off may itself have been consumed by
      // a trip sheet / F&F since — restoring the original would double it
      if (prevRemainders.some((r) => r.status !== "PENDING")) {
        return {
          ok: false as const,
          error: "An advance remainder from this salary was already adjusted elsewhere — cannot edit.",
        };
      }
      const remainderIds = new Set(prevRemainders.map((r) => r.id));
      // FIFO queue: live PENDING rows (minus this salary's own remainder rows,
      // which are withdrawn on release) + the rows this salary consumed before
      const advQueue = [
        ...pendingAdvances.filter((a) => !remainderIds.has(a.id)),
        ...prevConsumed.map((a) => ({
          ...a,
          remarks: d.id ? stripSalaryAdvTag(a.remarks, d.id) : a.remarks,
        })),
      ].sort((a, b) => a.date.getTime() - b.date.getTime());
      const advanceOutstanding = round2(
        advQueue.reduce((s, r) => s + toNum(String(r.amount)), 0)
      );
      if (d.advanceAdjust > advanceOutstanding + 0.009) {
        return {
          ok: false as const,
          error: `Advance adjustment exceeds the driver's pending advances (${advanceOutstanding}).`,
        };
      }

      // shortages: adjust only when the user said Yes
      const pending = await tx.driverShortage.findMany({
        where: { firmId: session.firmId, driverId: d.driverId, status: "PENDING", deletedAt: null },
      });
      const shortageDeduction = d.adjustShortage
        ? round2(
            pending.reduce(
              (s, r) => s + toNum(String(r.amount)) - toNum(String(r.adjustedAmount)),
              0
            )
          )
        : 0;

      const gross = round2(d.salaryAmount + d.incentive + d.bonus + d.otherAllowance);
      const netPayable = round2(gross - d.advanceAdjust - shortageDeduction - d.otherDeductions);
      if (netPayable < 0) {
        return { ok: false as const, error: "Deductions exceed the gross salary." };
      }

      const values = {
        driverId: d.driverId,
        month: d.month,
        salaryAmount: d.salaryAmount,
        incentive: d.incentive,
        bonus: d.bonus,
        otherAllowance: d.otherAllowance,
        advanceAdjust: d.advanceAdjust,
        shortageDeduction,
        otherDeductions: d.otherDeductions,
        netPayable,
        remarks: d.remarks || null,
      };

      let id: string;
      if (d.id && before) {
        // release shortages previously adjusted by this salary
        await tx.driverShortage.updateMany({
          where: { salaryId: d.id },
          data: { status: "PENDING", salaryId: null, adjustedAmount: 0 },
        });
        // release advances previously consumed by this salary (mirror the trip
        // sheet's release-then-relink): withdraw the remainder rows it split
        // off, return the consumed originals to PENDING
        if (prevRemainders.length) {
          await tx.driverAdvance.updateMany({
            where: { id: { in: prevRemainders.map((r) => r.id) } },
            data: { deletedAt: new Date() },
          });
        }
        for (const adv of prevConsumed) {
          await tx.driverAdvance.update({
            where: { id: adv.id },
            data: { status: "PENDING", adjustedDate: null, remarks: stripSalaryAdvTag(adv.remarks, d.id) },
          });
        }
        const updated = await tx.driverSalary.update({ where: { id: d.id }, data: values });
        id = updated.id;
        await reverseLedger(tx, "DRIVER_SALARY", id);
        await audit(tx, session, { entity: "DriverSalary", entityId: id, action: "UPDATE", before, after: updated });
      } else {
        // a soft-deleted month still holds the unique(firm, fy, driver, month)
        // key — REVIVE it instead of creating, or the month is locked forever
        // (same trap the staff module fixed)
        const deleted = await tx.driverSalary.findFirst({
          where: {
            firmId: session.firmId,
            driverId: d.driverId,
            month: d.month,
            deletedAt: { not: null },
          },
        });
        if (deleted) {
          const revived = await tx.driverSalary.update({
            where: { id: deleted.id },
            data: { ...values, deletedAt: null, paymentStatus: "PENDING", paidAmount: 0 },
          });
          id = revived.id;
          await audit(tx, session, { entity: "DriverSalary", entityId: id, action: "CREATE", after: revived });
        } else {
          const created = await tx.driverSalary.create({
            data: {
              tenantId: session.tenantId,
              firmId: session.firmId,
              fyId: session.fyId,
              createdById: session.userId,
              ...values,
            },
          });
          id = created.id;
          await audit(tx, session, { entity: "DriverSalary", entityId: id, action: "CREATE", after: created });
        }
      }

      if (d.adjustShortage && pending.length) {
        for (const p of pending) {
          await tx.driverShortage.update({
            where: { id: p.id },
            data: { status: "ADJUSTED", adjustedAmount: p.amount, salaryId: id },
          });
        }
      }

      const salaryDate = new Date(`${d.month}-01T00:00:00`);

      // consume PENDING advances FIFO up to the amount recovered here, so the
      // register closes with the recovery. Partial consumption splits the row
      // exactly like the F&F does: the adjusted part closes and the remainder
      // survives as its own PENDING row (bookkeeping only — the ORIGINAL
      // advance's ledger posting already carries the money).
      let advLeft = d.advanceAdjust;
      for (const adv of advQueue) {
        if (advLeft <= 0.009) break;
        const amt = toNum(String(adv.amount));
        if (amt <= 0) continue;
        const take = round2(Math.min(amt, advLeft));
        advLeft = round2(advLeft - take);
        await tx.driverAdvance.update({
          where: { id: adv.id },
          data: {
            status: "ADJUSTED",
            adjustedDate: salaryDate,
            remarks: `${adv.remarks ? adv.remarks + " · " : ""}₹${take} adjusted in salary ${d.month} ${salaryAdvTag(id)}`,
          },
        });
        if (take < amt - 0.009) {
          await tx.driverAdvance.create({
            data: {
              tenantId: session.tenantId,
              firmId: adv.firmId,
              fyId: adv.fyId,
              date: adv.date,
              driverId: adv.driverId,
              vehicleId: adv.vehicleId,
              tripRef: adv.tripRef,
              amount: round2(amt - take),
              paymentMode: adv.paymentMode,
              bankPartyId: adv.bankPartyId,
              voucherRef: adv.voucherRef,
              status: "PENDING",
              remarks: `Remainder of advance dated ${adv.date.toISOString().slice(0, 10)} after salary ${d.month} (₹${take} adjusted of ₹${amt}) ${salaryAdvRemTag(id)}`,
              createdById: session.userId,
            },
          });
        }
      }

      // ledger accrual
      const common = { date: salaryDate, refType: "DRIVER_SALARY", refId: id, refNo: `DSAL-${d.month}` };
      const expenseHead = await ensureAccountHead(tx, session, "Driver Salary Expense", "EXPENSE");
      const entries: LedgerPostEntry[] = [
        {
          ...common,
          accountHeadId: expenseHead,
          side: "DEBIT" as const,
          amount: gross,
          narration: `Driver salary ${d.month} — ${driver.name}`,
        },
        {
          ...common,
          partyId: driver.partyId,
          side: "CREDIT" as const,
          // the shortage was already debited to the driver when it was
          // recorded, so crediting it back here nets it off — the shortage
          // ledger is touched exactly once, at recording
          amount: round2(netPayable + d.advanceAdjust + shortageDeduction),
          narration: `Salary payable ${d.month}${d.advanceAdjust ? " (incl. advance recovery)" : ""}${shortageDeduction ? " (incl. shortage adjustment)" : ""}`,
        },
      ];
      if (d.otherDeductions > 0) {
        const head = await ensureAccountHead(tx, session, "Salary Deductions (Driver)", "INCOME");
        entries.push({
          ...common,
          accountHeadId: head,
          side: "CREDIT" as const,
          amount: d.otherDeductions,
          narration: `Salary deductions ${d.month} — ${driver.name}`,
        });
      }
      // relative vehicle: the salary is paid on behalf of the relative owner —
      // neutralise the company expense and move it to the owner's ledger
      const rel = await resolveRelativeOwner(tx, { driverId: d.driverId, at: salaryDate });
      if (rel && gross > 0) {
        entries.push(
          {
            ...common,
            partyId: rel.ownerId,
            side: "DEBIT" as const,
            amount: gross,
            narration: `Driver salary ${d.month} (${driver.name}, vehicle ${rel.vehicleNo}) — on behalf of relative owner`,
          },
          {
            ...common,
            accountHeadId: expenseHead,
            side: "CREDIT" as const,
            amount: gross,
            narration: `Salary ${d.month} shifted to relative owner ledger (${rel.vehicleNo})`,
          }
        );
      }
      await postLedger(tx, session, entries);

      revalidatePath(REVALIDATE);
      return { ok: true as const, id, netPayable };
    });
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Save failed" };
  }
}

// ------------------------------------------ pay running salary balance

const payRunningSchema = z.object({
  driverId: z.string().min(1),
  paymentDate: z.string().min(1, "Payment date is required"),
  paymentHeadId: z.string().min(1, "Cash / Bank account is required"),
  paymentMode: z.enum(["CASH", "BANK", "CARD"]).default("CASH"),
  /** shortage amount to adjust against the salary (full or partial) */
  shortageAdjust: z.number().min(0).default(0),
  /** money actually paid now (partial payments allowed) */
  paymentAmount: z.number().min(0).default(0),
  refNo: z.string().nullish(),
  remarks: z.string().nullish(),
});

/**
 * Settle a driver's RUNNING salary balance (all pending months, FIFO):
 *   payable = running balance − shortage adjustment (full or partial)
 *   payment amount may be less than payable — the rest stays outstanding and
 *   carries forward automatically as Previous Pending Salary.
 * Shortage adjustment reduces the oldest pending shortages first; partially
 * consumed rows keep their remainder pending.
 */
export async function payDriverSalaryRunning(
  input: unknown
): Promise<
  | { ok: true; paid: number; adjusted: number; remaining: number }
  | { ok: false; error: string }
> {
  const session = requireSession();
  const parsed = payRunningSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid input" };
  const d = parsed.data;
  await authorize(session, "vouchers", "create");
  if (d.shortageAdjust <= 0 && d.paymentAmount <= 0) {
    return { ok: false, error: "Enter a payment amount and/or a shortage adjustment." };
  }

  try {
    return await withTenant(session.tenantId, async (tx) => {
      const driver = await tx.driver.findFirst({ where: { id: d.driverId, deletedAt: null } });
      if (!driver?.partyId) return { ok: false as const, error: "Driver (ledger party) not found" };

      const salaries = await tx.driverSalary.findMany({
        where: {
          firmId: session.firmId,
          driverId: d.driverId,
          paymentStatus: "PENDING",
          deletedAt: null,
        },
        orderBy: { month: "asc" },
      });
      const running = round2(
        salaries.reduce(
          (s, r) => s + toNum(String(r.netPayable)) - toNum(String(r.paidAmount)),
          0
        )
      );
      if (running <= 0) return { ok: false as const, error: "No outstanding salary balance." };

      const shortages = await tx.driverShortage.findMany({
        where: { firmId: session.firmId, driverId: d.driverId, status: "PENDING", deletedAt: null },
        orderBy: { date: "asc" },
      });
      const shortagePending = round2(
        shortages.reduce(
          (s, r) => s + toNum(String(r.amount)) - toNum(String(r.adjustedAmount)),
          0
        )
      );
      if (d.shortageAdjust > shortagePending) {
        return { ok: false as const, error: `Shortage adjustment exceeds pending shortage (${shortagePending}).` };
      }
      if (d.shortageAdjust > running) {
        return { ok: false as const, error: "Shortage adjustment exceeds the running salary balance." };
      }
      const payable = round2(running - d.shortageAdjust);
      if (d.paymentAmount > payable) {
        return { ok: false as const, error: `Payment exceeds the payable salary (${payable}).` };
      }

      const paymentDate = new Date(`${d.paymentDate}T00:00:00`);
      const latest = salaries[salaries.length - 1];
      // The salaries are settled OLDEST-first below, so the shortage stamp must
      // point at the salary the adjustment actually pays — the oldest one with
      // an outstanding. That salary receives money in this run and locks
      // (edit/delete refuse paid salaries), so editing a later, untouched month
      // can no longer reset a shortage that settled an older one.
      const fifoTarget =
        salaries.find(
          (s) => round2(toNum(String(s.netPayable)) - toNum(String(s.paidAmount))) > 0
        ) ?? latest;

      // shortage adjustment — consume oldest pending shortages first
      let toAdjust = d.shortageAdjust;
      for (const sh of shortages) {
        if (toAdjust <= 0) break;
        const remaining = round2(toNum(String(sh.amount)) - toNum(String(sh.adjustedAmount)));
        if (remaining <= 0) continue;
        const take = Math.min(remaining, toAdjust);
        toAdjust = round2(toAdjust - take);
        await tx.driverShortage.update({
          where: { id: sh.id },
          data: {
            adjustedAmount: round2(toNum(String(sh.adjustedAmount)) + take),
            status: take >= remaining ? "ADJUSTED" : "PENDING",
            salaryId: fifoTarget.id,
          },
        });
      }

      // settle salaries FIFO with (shortage adjust + money paid)
      let toSettle = round2(d.shortageAdjust + d.paymentAmount);
      for (const sal of salaries) {
        if (toSettle <= 0) break;
        const outstanding = round2(toNum(String(sal.netPayable)) - toNum(String(sal.paidAmount)));
        if (outstanding <= 0) continue;
        const take = Math.min(outstanding, toSettle);
        toSettle = round2(toSettle - take);
        await tx.driverSalary.update({
          where: { id: sal.id },
          data: {
            paidAmount: round2(toNum(String(sal.paidAmount)) + take),
            ...(take >= outstanding
              ? { paymentStatus: "PAID", paymentDate, paymentHeadId: d.paymentHeadId }
              : {}),
          },
        });
      }

      // ledger
      const common = {
        date: paymentDate,
        refType: "DRIVER_SALARY_PAY",
        refId: `${latest.id}:${paymentDate.getTime()}`,
        refNo: d.refNo?.trim() || `DSAL-${latest.month}`,
      };
      const entries = [];
      if (d.paymentAmount > 0) {
        entries.push(
          {
            ...common,
            partyId: d.paymentHeadId,
            side: "CREDIT" as const,
            amount: d.paymentAmount,
            narration: `Driver salary paid (running balance) — ${driver.name}${d.remarks ? " — " + d.remarks : ""}`,
          },
          {
            ...common,
            partyId: driver.partyId,
            side: "DEBIT" as const,
            amount: d.paymentAmount,
            narration: `Salary paid (running balance up to ${latest.month})`,
          }
        );
      }
      // No shortage leg here: the shortage was already debited to the driver
      // when it was recorded, and that recording is the one and only shortage
      // posting. Adjusting it against salary just settles his account.
      await postLedger(tx, session, entries);

      await audit(tx, session, {
        entity: "DriverSalary",
        entityId: latest.id,
        action: "UPDATE",
        after: {
          runningPay: {
            paid: d.paymentAmount,
            shortageAdjust: d.shortageAdjust,
            remaining: round2(payable - d.paymentAmount),
          },
        },
      });
      revalidatePath(REVALIDATE);
      return {
        ok: true as const,
        paid: d.paymentAmount,
        adjusted: d.shortageAdjust,
        remaining: round2(payable - d.paymentAmount),
      };
    });
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Payment failed" };
  }
}

export async function deleteDriverSalary(
  id: string
): Promise<{ ok: true } | { ok: false; error: string }> {
  const session = requireSession();
  if (session.role !== "ADMIN" && session.role !== "OWNER") {
    return { ok: false, error: "Only Admin/Owner may delete salary records" };
  }
  await authorize(session, "driver", "delete");
  try {
    await withTenant(session.tenantId, async (tx) => {
      const before = await tx.driverSalary.findFirstOrThrow({
        where: { id, firmId: session.firmId, deletedAt: null },
      });
      if (before.paymentStatus === "PAID" || toNum(String(before.paidAmount)) > 0) {
        throw new Error("Salary with payments cannot be deleted.");
      }
      await tx.driverShortage.updateMany({
        where: { salaryId: id },
        data: { status: "PENDING", salaryId: null, adjustedAmount: 0 },
      });
      // release the advances this salary consumed (mirror the edit path):
      // withdraw the remainder rows it split off, restore the originals
      const [consumedAdv, remainderAdv] = await Promise.all([
        tx.driverAdvance.findMany({
          where: {
            firmId: session.firmId,
            status: "ADJUSTED",
            deletedAt: null,
            remarks: { contains: salaryAdvTag(id) },
          },
        }),
        tx.driverAdvance.findMany({
          where: { firmId: session.firmId, deletedAt: null, remarks: { contains: salaryAdvRemTag(id) } },
        }),
      ]);
      if (remainderAdv.some((r) => r.status !== "PENDING")) {
        throw new Error(
          "An advance remainder from this salary was already adjusted elsewhere — cannot delete."
        );
      }
      if (remainderAdv.length) {
        await tx.driverAdvance.updateMany({
          where: { id: { in: remainderAdv.map((r) => r.id) } },
          data: { deletedAt: new Date() },
        });
      }
      for (const adv of consumedAdv) {
        await tx.driverAdvance.update({
          where: { id: adv.id },
          data: { status: "PENDING", adjustedDate: null, remarks: stripSalaryAdvTag(adv.remarks, id) },
        });
      }
      await tx.driverSalary.update({ where: { id }, data: { deletedAt: new Date() } });
      // nothing to release in the shortage register: salary never posts there,
      // the DriverShortage record does
      await reverseLedger(tx, "DRIVER_SALARY", id);
      await audit(tx, session, { entity: "DriverSalary", entityId: id, action: "DELETE", before });
    });
    revalidatePath(REVALIDATE);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Delete failed" };
  }
}
