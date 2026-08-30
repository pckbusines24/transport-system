"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { Prisma } from "@prisma/client";
import { requireSession } from "@/lib/session";
import { withTenant, type Tx } from "@/lib/db";
import { authorize } from "@/lib/authz";
import { audit } from "@/lib/audit";
import { ensureAccountHead, postLedger, type LedgerPostEntry } from "@/lib/ledger";
import { resolveRelativeOwner } from "@/lib/relative-owner";
import { round2 } from "@/lib/calc/tds";
import { settledByRef, signedRemainder } from "@/lib/settlement";
import { revalidateOutstanding } from "@/lib/outstanding-cache";
import { toNum } from "@/lib/utils";

/**
 * Driver Final Settlement (F&F). One locked document per driver settles:
 * running salary (gross), pending shortages, pending advances, the +/-
 * negative balance, plus manual recoveries / incentives.
 *   Final Payable = Gross Salary − Shortage − Advance Adj − Negative Adj
 *                   − Other Recoveries + Other Payments
 * Positive → pay the driver; negative → receive from the driver. Partial
 * adjustments leave the unadjusted remainder outstanding. On finalize the
 * driver becomes INACTIVE and the document is locked (no edit/delete).
 */

const REVALIDATE = "/vehicle/driver-fnf";

async function nextSettlementNo(tx: Tx, firmId: string, fyId: string): Promise<string> {
  const rows = await tx.$queryRaw<{ max: bigint | null }[]>`
    SELECT MAX(NULLIF(regexp_replace("settlementNo", '\\D', '', 'g'), '')::bigint) AS max
    FROM "DriverFnf" WHERE "firmId" = ${firmId} AND "fyId" = ${fyId}`;
  const max = rows[0]?.max ? Number(rows[0].max) : 0;
  return `DFS-${String(max + 1).padStart(4, "0")}`;
}

export interface FnfPreview {
  driverName: string;
  driverCode: string;
  joinDate: string | null;
  runningSalary: number; // outstanding across pending months
  shortagePending: number;
  advancePending: number; // PENDING driver advances not yet trip-adjusted
  plusMinusBalance: number; // signed running +/- balance (negative = driver owes)
  alreadySettled: string | null; // existing settlement no, if any
}

/** Live figures for the settlement screen. */
export async function getFnfPreview(driverId: string): Promise<FnfPreview | null> {
  const session = requireSession();
  return withTenant(session.tenantId, async (tx) => {
    const driver = await tx.driver.findFirst({ where: { id: driverId, deletedAt: null } });
    if (!driver) return null;
    const [salaries, shortages, advances, settlements, existing] = await Promise.all([
      tx.driverSalary.findMany({
        where: { firmId: session.firmId, driverId, paymentStatus: "PENDING", deletedAt: null },
      }),
      tx.driverShortage.findMany({
        where: { firmId: session.firmId, driverId, status: "PENDING", deletedAt: null },
      }),
      tx.driverAdvance.findMany({
        where: { firmId: session.firmId, driverId, status: "PENDING", deletedAt: null },
      }),
      tx.driverSettlement.findMany({
        where: { firmId: session.firmId, driverId, status: "PENDING", deletedAt: null },
      }),
      tx.driverFnf.findFirst({ where: { driverId, deletedAt: null } }),
    ]);
    // +/- rows net of what Payment/Receipt vouchers already settled — the
    // preview must show the LIVE balance, not the recorded one. The pending
    // rows span financial years, so the allocations must too (fyId: null) —
    // an FY-scoped lookup made last year's payments invisible here.
    const settPaid = await settledByRef(tx, {
      firmId: session.firmId,
      fyId: null,
      refTypes: ["DRIVER_SETTLEMENT"],
      refIds: settlements.map((s) => s.id),
    });
    return {
      driverName: driver.name,
      driverCode: driver.driverCode,
      joinDate: driver.joinDate ? driver.joinDate.toISOString() : null,
      runningSalary: round2(
        salaries.reduce((s, r) => s + toNum(String(r.netPayable)) - toNum(String(r.paidAmount)), 0)
      ),
      shortagePending: round2(
        shortages.reduce((s, r) => s + toNum(String(r.amount)) - toNum(String(r.adjustedAmount)), 0)
      ),
      advancePending: round2(advances.reduce((s, r) => s + toNum(String(r.amount)), 0)),
      plusMinusBalance: round2(
        settlements.reduce(
          (s, r) => s + signedRemainder(toNum(String(r.amount)), settPaid.get(r.id) ?? 0),
          0
        )
      ),
      alreadySettled: existing?.settlementNo ?? null,
    };
  });
}

const fnfSchema = z.object({
  driverId: z.string().min(1, "Driver is required"),
  date: z.string().min(1, "Settlement date is required"),
  lastWorkingDate: z.string().nullish(),
  shortageAdjust: z.number().min(0).default(0),
  advanceAdjust: z.number().min(0).default(0),
  negativeAdjust: z.number().min(0).default(0),
  otherRecoveries: z.number().min(0).default(0),
  otherPayments: z.number().min(0).default(0),
  paymentMode: z.enum(["CASH", "BANK", "CARD"]).default("CASH"),
  bankPartyId: z.string().min(1, "Cash / Bank account is required"),
  refNo: z.string().nullish(),
  remarks: z.string().nullish(),
});

export async function finalizeDriverFnf(
  input: unknown
): Promise<
  | { ok: true; settlementNo: string; finalPayable: number }
  | { ok: false; error: string }
> {
  const session = requireSession();
  const parsed = fnfSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid input" };
  const d = parsed.data;
  await authorize(session, "vouchers", "create");

  try {
    const res = await withTenant(session.tenantId, async (tx) => {
      const driver = await tx.driver.findFirst({
        where: { id: d.driverId, firmId: session.firmId, deletedAt: null },
      });
      if (!driver?.partyId) return { ok: false as const, error: "Driver (ledger party) not found" };

      // one final settlement per driver, ever (within the firm)
      const existing = await tx.driverFnf.findFirst({
        where: { driverId: d.driverId, firmId: session.firmId, deletedAt: null },
      });
      if (existing) {
        return {
          ok: false as const,
          error: `Driver already has final settlement ${existing.settlementNo}.`,
        };
      }

      const [salaries, shortages, advances, settlements] = await Promise.all([
        tx.driverSalary.findMany({
          where: { firmId: session.firmId, driverId: d.driverId, paymentStatus: "PENDING", deletedAt: null },
          orderBy: { month: "asc" },
        }),
        tx.driverShortage.findMany({
          where: { firmId: session.firmId, driverId: d.driverId, status: "PENDING", deletedAt: null },
          orderBy: { date: "asc" },
        }),
        tx.driverAdvance.findMany({
          where: { firmId: session.firmId, driverId: d.driverId, status: "PENDING", deletedAt: null },
          orderBy: { date: "asc" },
        }),
        tx.driverSettlement.findMany({
          where: { firmId: session.firmId, driverId: d.driverId, status: "PENDING", deletedAt: null },
          orderBy: { date: "asc" },
        }),
      ]);

      const grossSalary = round2(
        salaries.reduce((s, r) => s + toNum(String(r.netPayable)) - toNum(String(r.paidAmount)), 0)
      );
      const shortagePending = round2(
        shortages.reduce((s, r) => s + toNum(String(r.amount)) - toNum(String(r.adjustedAmount)), 0)
      );
      const advancePending = round2(advances.reduce((s, r) => s + toNum(String(r.amount)), 0));
      // LIVE +/- balance: rows already (partly) settled by voucher allocations
      // count only for their remainder — never twice. The pending rows are not
      // FY-scoped, so neither may the allocations be (fyId: null): a voucher
      // from last FY settled the row just as finally as one from this FY.
      const settPaid = await settledByRef(tx, {
        firmId: session.firmId,
        fyId: null,
        refTypes: ["DRIVER_SETTLEMENT"],
        refIds: settlements.map((s) => s.id),
      });
      const plusMinus = round2(
        settlements.reduce(
          (s, r) => s + signedRemainder(toNum(String(r.amount)), settPaid.get(r.id) ?? 0),
          0
        )
      );
      const negativeAvailable = plusMinus < 0 ? Math.abs(plusMinus) : 0;

      if (d.shortageAdjust > shortagePending) {
        return { ok: false as const, error: `Shortage adjustment exceeds pending shortage (${shortagePending}).` };
      }
      if (d.advanceAdjust > advancePending) {
        return { ok: false as const, error: `Advance adjustment exceeds pending advances (${advancePending}).` };
      }
      if (d.negativeAdjust > negativeAvailable) {
        return { ok: false as const, error: `Negative-balance adjustment exceeds the outstanding negative balance (${negativeAvailable}).` };
      }

      const finalPayable = round2(
        grossSalary -
          d.shortageAdjust -
          d.advanceAdjust -
          d.negativeAdjust -
          d.otherRecoveries +
          d.otherPayments
      );

      const date = new Date(`${d.date}T00:00:00`);
      const settlementNo = await nextSettlementNo(tx, session.firmId, session.fyId);
      const fnf = await tx.driverFnf.create({
        data: {
          tenantId: session.tenantId,
          firmId: session.firmId,
          fyId: session.fyId,
          settlementNo,
          driverId: d.driverId,
          date,
          lastWorkingDate: d.lastWorkingDate ? new Date(`${d.lastWorkingDate}T00:00:00`) : null,
          grossSalary,
          shortageAdjust: d.shortageAdjust,
          advanceAdjust: d.advanceAdjust,
          negativeAdjust: d.negativeAdjust,
          otherRecoveries: d.otherRecoveries,
          otherPayments: d.otherPayments,
          finalPayable,
          paymentMode: d.paymentMode,
          bankPartyId: d.bankPartyId,
          refNo: d.refNo?.trim() || null,
          remarks: d.remarks || null,
          createdById: session.userId,
        },
      });

      // ---- apply adjustments ----
      // salaries: fully settled by the F&F (deductions + payment cover gross)
      for (const sal of salaries) {
        await tx.driverSalary.update({
          where: { id: sal.id },
          data: {
            paidAmount: sal.netPayable,
            paymentStatus: "PAID",
            paymentDate: date,
            paymentHeadId: d.bankPartyId,
          },
        });
      }
      // shortages FIFO (partial remainder stays pending)
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
          },
        });
      }
      // advances FIFO — partial adjustments split the row: the adjusted part
      // closes and the REMAINDER survives as its own PENDING row, so exactly
      // what was deducted from the driver is what stops being recoverable.
      // (Before this, a partially covered advance stayed fully PENDING and
      // the same money could be recovered a second time later.)
      let advLeft = d.advanceAdjust;
      for (const adv of advances) {
        if (advLeft <= 0.009) break;
        const amt = toNum(String(adv.amount));
        if (amt <= 0) continue;
        const take = round2(Math.min(amt, advLeft));
        advLeft = round2(advLeft - take);
        await tx.driverAdvance.update({
          where: { id: adv.id },
          data: {
            status: "ADJUSTED",
            adjustedDate: date,
            ...(take < amt - 0.009
              ? {
                  remarks: `${adv.remarks ? adv.remarks + " · " : ""}₹${take} adjusted in F&F ${settlementNo}; ₹${round2(amt - take)} carried to a new pending row`,
                }
              : {}),
          },
        });
        if (take < amt - 0.009) {
          // remainder row: bookkeeping only — the ORIGINAL advance's ledger
          // posting already carries the money, so nothing posts again here
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
              remarks: `Remainder of advance dated ${adv.date.toISOString().slice(0, 10)} after F&F ${settlementNo} (₹${take} adjusted of ₹${amt})`,
              createdById: session.userId,
            },
          });
        }
      }
      // +/- rows: settle all, re-open the unadjusted remainder as one row
      if (settlements.length) {
        await tx.driverSettlement.updateMany({
          where: { id: { in: settlements.map((s) => s.id) } },
          data: { status: "SETTLED", settledDate: date, voucherNo: settlementNo },
        });
        const remainder = round2(plusMinus + d.negativeAdjust); // negative balance shrinks toward 0
        if (Math.abs(remainder) >= 0.01) {
          await tx.driverSettlement.create({
            data: {
              tenantId: session.tenantId,
              firmId: session.firmId,
              fyId: session.fyId,
              date,
              driverId: d.driverId,
              tripRef: settlementNo,
              amount: remainder,
              remarks: `Balance carried forward after final settlement ${settlementNo}`,
            },
          });
        }
      }

      // ---- ledger (refType DRIVER_FNF) ----
      const common = {
        date,
        refType: "DRIVER_FNF",
        refId: fnf.id,
        refNo: d.refNo?.trim() || settlementNo,
      };
      const entries: LedgerPostEntry[] = [];
      const recoveries = round2(d.negativeAdjust + d.otherRecoveries);
      // No shortage leg: recording the shortage already debited the driver and
      // already credited the shortage ledger. Settling it here would post the
      // same shortage twice, so the F&F only clears his account.
      if (recoveries > 0) {
        const head = await ensureAccountHead(tx, session, "Driver Recovery (F&F)", "INCOME");
        entries.push(
          { ...common, partyId: driver.partyId, side: "DEBIT", amount: recoveries, narration: `Negative balance / recoveries adjusted — F&F ${settlementNo}` },
          { ...common, accountHeadId: head, side: "CREDIT", amount: recoveries, narration: `F&F recovery — ${driver.name}` }
        );
      }
      if (d.otherPayments > 0) {
        const head = await ensureAccountHead(tx, session, "Driver Salary Expense", "EXPENSE");
        entries.push(
          { ...common, accountHeadId: head, side: "DEBIT", amount: d.otherPayments, narration: `F&F incentive / bonus — ${driver.name}` },
          { ...common, partyId: driver.partyId, side: "CREDIT", amount: d.otherPayments, narration: `F&F incentive credited ${settlementNo}` }
        );
      }
      if (Math.abs(finalPayable) >= 0.01) {
        const pay = finalPayable > 0;
        const abs = Math.abs(finalPayable);
        entries.push(
          { ...common, partyId: d.bankPartyId, side: pay ? "CREDIT" : "DEBIT", amount: abs, narration: `Final settlement ${pay ? "paid to" : "received from"} ${driver.name} (${settlementNo})` },
          { ...common, partyId: driver.partyId, side: pay ? "DEBIT" : "CREDIT", amount: abs, narration: `Final settlement ${settlementNo}` }
        );
      }
      // Relative vehicle: ONLY the F&F incentive shifts to the relative owner
      // here. The salary itself already moved to the owner's ledger at ACCRUAL
      // (processDriverSalary posts owner-DEBIT gross for every relative-vehicle
      // month) — that accrual is the single authoritative owner posting for
      // salary. Shifting the final payment again debited the owner a second
      // time for the same salary and distorted the driver's ledger with a
      // mirror credit; the running-salary payment path correctly posts no
      // owner leg for the same reason.
      const rel = await resolveRelativeOwner(tx, {
        driverId: d.driverId,
        at: d.lastWorkingDate ? new Date(`${d.lastWorkingDate}T00:00:00`) : date,
      });
      if (rel && d.otherPayments > 0) {
        const head = await ensureAccountHead(tx, session, "Driver Salary Expense", "EXPENSE");
        entries.push(
          { ...common, partyId: rel.ownerId, side: "DEBIT", amount: d.otherPayments, narration: `F&F incentive (${driver.name}, vehicle ${rel.vehicleNo}) — on behalf of relative owner` },
          { ...common, accountHeadId: head, side: "CREDIT", amount: d.otherPayments, narration: `F&F incentive shifted to relative owner ledger (${rel.vehicleNo})` }
        );
      }
      await postLedger(tx, session, entries);

      // driver leaves the company
      const lwd = d.lastWorkingDate ? new Date(`${d.lastWorkingDate}T00:00:00`) : date;
      await tx.driver.update({
        where: { id: driver.id },
        data: {
          status: "INACTIVE",
          exitDate: lwd,
          exitReason: `Final settlement ${settlementNo}`,
        },
      });
      await tx.driverAssignment.updateMany({
        where: { driverId: driver.id, toDate: null },
        data: { toDate: lwd, reason: `Final settlement ${settlementNo}` },
      });

      await audit(tx, session, {
        entity: "DriverFnf",
        entityId: fnf.id,
        action: "CREATE",
        after: fnf,
      });
      revalidatePath(REVALIDATE);
      revalidatePath("/masters/drivers");
      return { ok: true as const, settlementNo, finalPayable };
    });
    if (res.ok) revalidateOutstanding(session.tenantId);
    return res;
  } catch (e) {
    // unique(driverId): two concurrent F&Fs for one driver — the second loses
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") {
      return { ok: false, error: "A final settlement already exists for this driver." };
    }
    return { ok: false, error: e instanceof Error ? e.message : "Settlement failed" };
  }
}
