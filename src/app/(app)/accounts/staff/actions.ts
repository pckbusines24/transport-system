"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { requireSession } from "@/lib/session";
import { withTenant, type Tx } from "@/lib/db";
import { authorize } from "@/lib/authz";
import { audit } from "@/lib/audit";
import { postLedger, reverseLedger, type LedgerPostEntry } from "@/lib/ledger";
import { settledByRef } from "@/lib/settlement";
import { revalidateOutstanding } from "@/lib/outstanding-cache";
import { round2 } from "@/lib/calc/tds";
import { toNum } from "@/lib/utils";
import { createModulePaymentVoucher } from "@/lib/module-voucher";

/**
 * Staff Payroll & Advance Management. Every transaction posts to the ledger
 * with its own refType (STAFF_ADVANCE / STAFF_LOAN / STAFF_SALARY), so the
 * staff party ledger is always the single source of truth. Edits reverse and
 * re-post; history is never silently mutated (audit rows record every change).
 */

const REVALIDATE = "/accounts/staff";

async function salaryHead(tx: Tx, tenantId: string, name: string, kind: string): Promise<string> {
  const head = await tx.accountHead.upsert({
    where: { tenantId_name: { tenantId, name } },
    create: { tenantId, name, kind },
    update: {},
  });
  return head.id;
}

async function nextNo(tx: Tx, table: "staffAdvance" | "staffLoan", firmId: string, fyId: string, prefix: string) {
  const rows =
    table === "staffAdvance"
      ? await tx.$queryRaw<{ max: bigint | null }[]>`
          SELECT MAX(NULLIF(regexp_replace("advanceNo", '\\D', '', 'g'), '')::bigint) AS max
          FROM "StaffAdvance" WHERE "firmId" = ${firmId} AND "fyId" = ${fyId}`
      : await tx.$queryRaw<{ max: bigint | null }[]>`
          SELECT MAX(NULLIF(regexp_replace("loanNo", '\\D', '', 'g'), '')::bigint) AS max
          FROM "StaffLoan" WHERE "firmId" = ${firmId} AND "fyId" = ${fyId}`;
  const max = rows[0]?.max ? Number(rows[0].max) : 0;
  return `${prefix}${String(max + 1).padStart(4, "0")}`;
}

/** Next PAY-#### for the firm + FY, following the advance / loan numbering. */
async function nextSalaryNo(tx: Tx, firmId: string, fyId: string): Promise<string> {
  const rows = await tx.$queryRaw<{ max: bigint | null }[]>`
    SELECT MAX(NULLIF(regexp_replace("voucherNo", '\\D', '', 'g'), '')::bigint) AS max
    FROM "StaffSalary" WHERE "firmId" = ${firmId} AND "fyId" = ${fyId}`;
  const max = rows[0]?.max ? Number(rows[0].max) : 0;
  return `PAY-${String(max + 1).padStart(4, "0")}`;
}

function toDate(s: string): Date {
  return new Date(s.includes("T") ? s : `${s}T00:00:00`);
}

/**
 * The readable salary reference: "SUNIL KUMAR/08/2026". voucherNo keeps the
 * PAY-#### sequence; this is what every register and allocation grid shows,
 * so whose salary it is reads straight off the reference.
 */
function salaryRefNo(partyName: string, month: string): string {
  const [y, m] = month.split("-");
  return `${partyName.trim().toUpperCase()}/${m}/${y}`;
}

// ---------------------------------------------------------------- profile

const profileSchema = z.object({
  partyId: z.string().min(1),
  employeeId: z.string().nullish(),
  department: z.string().nullish(),
  designation: z.string().nullish(),
  joiningDate: z.string().nullish(),
  basicSalary: z.number().min(0).default(0),
  allowances: z.number().min(0).default(0),
});

export async function saveStaffProfile(
  input: unknown
): Promise<{ ok: true } | { ok: false; error: string }> {
  const session = requireSession();
  await authorize(session, "office", "edit");
  const parsed = profileSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid input" };
  const d = parsed.data;
  try {
    await withTenant(session.tenantId, async (tx) => {
      const values = {
        employeeId: d.employeeId || null,
        department: d.department || null,
        designation: d.designation || null,
        joiningDate: d.joiningDate ? toDate(d.joiningDate) : null,
        basicSalary: d.basicSalary,
        allowances: d.allowances,
      };
      const profile = await tx.staffProfile.upsert({
        where: { partyId: d.partyId },
        create: { tenantId: session.tenantId, partyId: d.partyId, ...values },
        update: values,
      });
      await audit(tx, session, {
        entity: "StaffProfile",
        entityId: profile.id,
        action: "UPDATE",
        after: profile,
      });
    });
    revalidatePath(REVALIDATE);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "Save failed" };
  }
}

// ---------------------------------------------------------------- advance

const advanceSchema = z.object({
  partyId: z.string().min(1, "Staff is required"),
  date: z.string().min(1, "Date is required"),
  amount: z.number().min(0.01, "Amount is required"),
  headId: z.string().min(1, "Bank/Cash head is required"),
  remarks: z.string().nullish(),
});

export async function saveStaffAdvance(
  input: unknown
): Promise<{ ok: true; advanceNo: string } | { ok: false; error: string }> {
  const session = requireSession();
  await authorize(session, "office", "create");
  const parsed = advanceSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid input" };
  const d = parsed.data;
  try {
    return await withTenant(session.tenantId, async (tx) => {
      const advanceNo = await nextNo(tx, "staffAdvance", session.firmId, session.fyId, "SADV-");
      const date = toDate(d.date);
      // the advance is a real Payment Voucher: it shows in the Voucher
      // Register, posts the money (bank Cr / staff Dr) itself, and the advance
      // cannot be deleted until that voucher is
      const voucher = await createModulePaymentVoucher(tx, session, {
        date,
        partyId: d.partyId,
        bankPartyId: d.headId,
        paid: d.amount,
        moduleLink: "STAFF_ADVANCE",
        allocations: [],
        narration: `Staff advance ${advanceNo}${d.remarks ? " — " + d.remarks : ""}`,
        partyNarration: `Advance given ${advanceNo}`,
      });
      const created = await tx.staffAdvance.create({
        data: {
          tenantId: session.tenantId,
          firmId: session.firmId,
          fyId: session.fyId,
          advanceNo,
          partyId: d.partyId,
          date,
          amount: d.amount,
          headId: d.headId,
          remarks: d.remarks || null,
          voucherId: voucher.id,
          createdById: session.userId,
        },
      });
      await audit(tx, session, {
        entity: "StaffAdvance",
        entityId: created.id,
        action: "CREATE",
        after: created,
      });
      revalidatePath(REVALIDATE);
      return { ok: true as const, advanceNo };
    });
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "Save failed" };
  }
}

// ---------------------------------------------------------------- loan

const loanSchema = z.object({
  partyId: z.string().min(1, "Staff is required"),
  date: z.string().min(1, "Date is required"),
  amount: z.number().min(0.01, "Loan amount is required"),
  emiAmount: z.number().min(0).default(0),
  headId: z.string().min(1, "Bank/Cash head is required"),
  remarks: z.string().nullish(),
});

export async function saveStaffLoan(
  input: unknown
): Promise<{ ok: true; loanNo: string } | { ok: false; error: string }> {
  const session = requireSession();
  await authorize(session, "office", "create");
  const parsed = loanSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid input" };
  const d = parsed.data;
  try {
    return await withTenant(session.tenantId, async (tx) => {
      const loanNo = await nextNo(tx, "staffLoan", session.firmId, session.fyId, "SLN-");
      const date = toDate(d.date);
      const voucher = await createModulePaymentVoucher(tx, session, {
        date,
        partyId: d.partyId,
        bankPartyId: d.headId,
        paid: d.amount,
        moduleLink: "OTHERS",
        allocations: [],
        narration: `Staff loan ${loanNo}${d.remarks ? " — " + d.remarks : ""}`,
        partyNarration: `Loan given ${loanNo}`,
      });
      const created = await tx.staffLoan.create({
        data: {
          tenantId: session.tenantId,
          firmId: session.firmId,
          fyId: session.fyId,
          loanNo,
          partyId: d.partyId,
          date,
          amount: d.amount,
          emiAmount: d.emiAmount,
          headId: d.headId,
          remarks: d.remarks || null,
          voucherId: voucher.id,
          createdById: session.userId,
        },
      });
      await audit(tx, session, {
        entity: "StaffLoan",
        entityId: created.id,
        action: "CREATE",
        after: created,
      });
      revalidatePath(REVALIDATE);
      return { ok: true as const, loanNo };
    });
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "Save failed" };
  }
}

// ---------------------------------------------------------------- salary

const salarySchema = z.object({
  partyId: z.string().min(1, "Staff is required"),
  // month 01-12 enforced, not just the shape: "2025-00" parses to Invalid Date
  // in every reader and would 500 the payables register and voucher grid
  month: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, "Month must be YYYY-MM (month 01-12)"),
  basic: z.number().min(0).default(0),
  allowances: z.number().min(0).default(0),
  overtime: z.number().min(0).default(0),
  incentives: z.number().min(0).default(0),
  bonus: z.number().min(0).default(0),
  otherEarnings: z.number().min(0).default(0),
  attendanceAdj: z.number().min(0).default(0),
  leaveDeduction: z.number().min(0).default(0),
  penalties: z.number().min(0).default(0),
  otherDeductions: z.number().min(0).default(0),
  advanceId: z.string().nullish(),
  advanceRecovery: z.number().min(0).default(0),
  loanId: z.string().nullish(),
  loanRecovery: z.number().min(0).default(0),
  remarks: z.string().nullish(),
  // optional immediate payment
  markPaid: z.boolean().default(false),
  paymentDate: z.string().nullish(),
  paymentHeadId: z.string().nullish(),
});

async function advanceAdjustedTotal(tx: Tx, advanceId: string, excludeSalaryId?: string) {
  const rows = await tx.staffSalary.findMany({
    where: { advanceId, deletedAt: null, ...(excludeSalaryId ? { id: { not: excludeSalaryId } } : {}) },
    select: { advanceRecovery: true },
  });
  return round2(rows.reduce((s, r) => s + toNum(String(r.advanceRecovery)), 0));
}

async function loanRecoveredTotal(tx: Tx, loanId: string, excludeSalaryId?: string) {
  const rows = await tx.staffSalary.findMany({
    where: { loanId, deletedAt: null, ...(excludeSalaryId ? { id: { not: excludeSalaryId } } : {}) },
    select: { loanRecovery: true },
  });
  // plus what salary payment vouchers recovered against the loan
  const viaVoucher = await tx.voucherAllocation.findMany({
    where: { refType: "STAFF_LOAN", refId: loanId, voucher: { deletedAt: null } },
    select: { amount: true },
  });
  return round2(
    rows.reduce((s, r) => s + toNum(String(r.loanRecovery)), 0) +
      viaVoucher.reduce((s, a) => s + toNum(String(a.amount)), 0)
  );
}

/** Create or update a month's salary; reverses + re-posts the ledger. */
export async function processStaffSalary(
  input: unknown
): Promise<{ ok: true; id: string; netSalary: number } | { ok: false; error: string }> {
  const session = requireSession();
  await authorize(session, "office", "create");
  const parsed = salarySchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid input" };
  const d = parsed.data;

  const grossSalary = round2(
    d.basic + d.allowances + d.overtime + d.incentives + d.bonus + d.otherEarnings
  );
  const totalDeductions = round2(
    d.attendanceAdj +
      d.leaveDeduction +
      d.penalties +
      d.otherDeductions +
      d.advanceRecovery +
      d.loanRecovery
  );
  const netSalary = round2(grossSalary - totalDeductions);
  if (netSalary < 0) return { ok: false, error: "Deductions exceed the gross salary" };
  if (d.markPaid && (!d.paymentDate || !d.paymentHeadId)) {
    return { ok: false, error: "Payment date and bank/cash head are required to mark paid" };
  }
  if (d.advanceRecovery > 0 && !d.advanceId) {
    return { ok: false, error: "Select the advance being recovered" };
  }
  if (d.loanRecovery > 0 && !d.loanId) {
    return { ok: false, error: "Select the loan being recovered" };
  }

  try {
    const res = await withTenant(session.tenantId, async (tx) => {
      const staffParty = await tx.party.findFirst({ where: { id: d.partyId } });
      if (!staffParty) return { ok: false as const, error: "Staff member not found" };
      const existing = await tx.staffSalary.findFirst({
        // month embeds the year (yyyy-mm), so firm-wide is precise — and an
        // old-FY month's salary stays editable without switching FY
        where: {
          firmId: session.firmId,
          partyId: d.partyId,
          month: d.month,
          deletedAt: null,
        },
      });
      // a salary a payment voucher already settled cannot move underneath it:
      // marking it paid again or shrinking the net would pay the staff twice
      if (existing) {
        const settledHere = await settledByRef(tx, {
          firmId: session.firmId,
          fyId: session.fyId,
          refTypes: ["STAFF_PAYROLL"],
          refIds: [existing.id],
        });
        const settled = settledHere.get(existing.id) ?? 0;
        if (settled > 0.009) {
          if (d.markPaid) {
            return {
              ok: false as const,
              error: `${settled.toFixed(2)} of this salary is already settled by a payment voucher — delete that voucher before marking it paid here.`,
            };
          }
          if (netSalary < settled - 0.009) {
            return {
              ok: false as const,
              error: `Net salary cannot be below the ${settled.toFixed(2)} already settled by a voucher.`,
            };
          }
        }
      }

      // recoveries must not exceed the open balances — and the advance/loan
      // must belong to THIS staff member in THIS firm+FY, or a stale client
      // state could recover one employee's advance inside another's salary
      if (d.advanceId && d.advanceRecovery > 0) {
        const adv = await tx.staffAdvance.findFirst({
          // no FY filter: last year's open advance recovers from this year's
          // salary (FY continuity) — id + party + firm keep it precise
          where: {
            id: d.advanceId,
            partyId: d.partyId,
            firmId: session.firmId,
            deletedAt: null,
          },
        });
        if (!adv) return { ok: false as const, error: "Advance not found for this staff member" };
        const adjusted = await advanceAdjustedTotal(tx, d.advanceId, existing?.id);
        // a receipt voucher may have already settled part of this advance —
        // that portion is repaid in cash and must not be recovered again
        const viaVoucher = await settledByRef(tx, {
          firmId: session.firmId,
          fyId: session.fyId,
          refTypes: ["STAFF_ADVANCE"],
          refIds: [d.advanceId],
        });
        const balance = round2(
          toNum(String(adv.amount)) - adjusted - (viaVoucher.get(d.advanceId) ?? 0)
        );
        if (d.advanceRecovery > balance + 0.01) {
          return {
            ok: false as const,
            error: `Advance ${adv.advanceNo} balance is only ${balance.toFixed(2)}`,
          };
        }
      }
      if (d.loanId && d.loanRecovery > 0) {
        const loan = await tx.staffLoan.findFirst({
          // no FY filter: an old-year loan keeps recovering from new-year
          // salaries (FY continuity)
          where: {
            id: d.loanId,
            partyId: d.partyId,
            firmId: session.firmId,
            deletedAt: null,
          },
        });
        if (!loan) return { ok: false as const, error: "Loan not found for this staff member" };
        const recovered = await loanRecoveredTotal(tx, d.loanId, existing?.id);
        const balance = round2(toNum(String(loan.amount)) - recovered);
        if (d.loanRecovery > balance + 0.01) {
          return {
            ok: false as const,
            error: `Loan ${loan.loanNo} outstanding is only ${balance.toFixed(2)}`,
          };
        }
      }

      const values = {
        basic: d.basic,
        allowances: d.allowances,
        overtime: d.overtime,
        incentives: d.incentives,
        bonus: d.bonus,
        otherEarnings: d.otherEarnings,
        attendanceAdj: d.attendanceAdj,
        leaveDeduction: d.leaveDeduction,
        penalties: d.penalties,
        otherDeductions: d.otherDeductions,
        advanceId: d.advanceId || null,
        advanceRecovery: d.advanceRecovery,
        loanId: d.loanId || null,
        loanRecovery: d.loanRecovery,
        grossSalary,
        totalDeductions,
        netSalary,
        // "SUNIL KUMAR/08/2026" — refreshed on every save so a renamed party
        // propagates; voucherNo stays the immutable PAY-#### sequence
        refNo: salaryRefNo(staffParty.name, d.month),
        remarks: d.remarks || null,
        // payment fields are ALWAYS written, both ways. Leaving them untouched
        // when markPaid was off kept an edited salary PAID with a stale
        // paidAmount — the ledger re-posted the new net while the registers
        // still offered the difference for a second payment (double pay), and
        // un-paying from the edit form was silently impossible.
        // "Process & Pay" no longer marks the row paid here: the payment is a
        // Payment Voucher created right after the save (below), and its
        // allocation is what settles the salary
        paymentStatus: "PENDING",
        paymentDate: null,
        paymentHeadId: null,
        paidAmount: 0,
      };

      let salaryId: string;
      if (existing) {
        const updated = await tx.staffSalary.update({ where: { id: existing.id }, data: values });
        salaryId = updated.id;
        await reverseLedger(tx, "STAFF_SALARY", salaryId);
        await audit(tx, session, {
          entity: "StaffSalary",
          entityId: salaryId,
          action: "UPDATE",
          before: existing,
          after: updated,
        });
      } else {
        // The (firm, fy, staff, month) unique index counts soft-deleted rows
        // too, so a month that was deleted must be REVIVED rather than
        // re-created — a fresh create would die on the constraint and lock
        // that employee's month out forever. The delete already reversed the
        // old ledger, so reviving with the new figures posts clean.
        const deleted = await tx.staffSalary.findFirst({
          where: {
            firmId: session.firmId,
            partyId: d.partyId,
            month: d.month,
            deletedAt: { not: null },
          },
        });
        if (deleted) {
          const revived = await tx.staffSalary.update({
            where: { id: deleted.id },
            data: { ...values, deletedAt: null },
          });
          salaryId = revived.id;
          // the delete already reversed this id's entries; reversing again is a
          // no-op, and it protects against any stragglers from older data
          await reverseLedger(tx, "STAFF_SALARY", salaryId);
          await audit(tx, session, {
            entity: "StaffSalary",
            entityId: salaryId,
            action: "UPDATE",
            before: deleted,
            after: revived,
          });
        } else {
          // A salary needs a document number of its own before a payment voucher
          // can point at it — employee + month is not something an allocation can
          // reference. Blank refNo means "use the voucher number", the same rule
          // office transactions follow.
          const salaryNo = await nextSalaryNo(tx, session.firmId, session.fyId);
          const created = await tx.staffSalary.create({
            data: {
              tenantId: session.tenantId,
              firmId: session.firmId,
              fyId: session.fyId,
              partyId: d.partyId,
              month: d.month,
              voucherNo: salaryNo,
              createdById: session.userId,
              ...values,
            },
          });
          salaryId = created.id;
          await audit(tx, session, {
            entity: "StaffSalary",
            entityId: salaryId,
            action: "CREATE",
            after: created,
          });
        }
      }

      await postSalaryLedger(tx, session, salaryId);
      // "Process & Pay": the payment is a Payment Voucher allocated to this
      // salary — same path as the Pay button on the register
      if (d.markPaid && netSalary > 0.009) {
        const saved = await tx.staffSalary.findFirstOrThrow({ where: { id: salaryId } });
        await createModulePaymentVoucher(tx, session, {
          date: toDate(d.paymentDate as string),
          partyId: saved.partyId,
          bankPartyId: d.paymentHeadId as string,
          paid: netSalary,
          moduleLink: "STAFF_PAYROLL",
          allocations: [
            {
              refType: "STAFF_PAYROLL",
              refId: saved.id,
              refNo: saved.refNo || `SAL-${saved.month}`,
              billAmt: netSalary,
              amount: netSalary,
            },
          ],
          narration: `Staff salary ${saved.month} — ${saved.refNo || ""}`.trim(),
          partyNarration: `Salary paid ${saved.month}`,
        });
      }
      await syncLoanStatus(tx, d.loanId);
      // an edit that switched (or cleared) the loan re-opens the previous one:
      // its recovered total just dropped, so CLOSED may no longer be true
      if (existing?.loanId && existing.loanId !== (d.loanId || null)) {
        await syncLoanStatus(tx, existing.loanId);
      }
      revalidatePath(REVALIDATE);
      return { ok: true as const, id: salaryId, netSalary };
    });
    if (res.ok) revalidateOutstanding(session.tenantId);
    return res;
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "Save failed" };
  }
}

/** Pay (or re-pay after edit) a processed salary. */
type Recovery = { advances?: { id: string; amount: number }[]; loans?: { id: string; amount: number }[] };

/**
 * Validates the recoveries a salary payment wants to make against open
 * advances / loans and returns the allocation rows that record them on the
 * payment voucher (STAFF_ADVANCE / STAFF_LOAN allocations). A recovery is a
 * non-cash settlement: it reduces the salary outstanding AND the advance /
 * loan balance without any money moving — no ledger leg is needed.
 */
async function recoveryAllocations(
  tx: Tx,
  session: ReturnType<typeof requireSession>,
  partyId: string,
  r: Recovery | null | undefined
): Promise<{ rows: { refType: "STAFF_ADVANCE" | "STAFF_LOAN"; refId: string; refNo: string; billAmt: number; amount: number }[]; total: number; loanIds: string[] }> {
  const rows: { refType: "STAFF_ADVANCE" | "STAFF_LOAN"; refId: string; refNo: string; billAmt: number; amount: number }[] = [];
  for (const x of r?.advances ?? []) {
    const amt = round2(x.amount);
    if (amt <= 0) continue;
    const adv = await tx.staffAdvance.findFirst({ where: { id: x.id, partyId, firmId: session.firmId, deletedAt: null } });
    if (!adv) throw new Error("Advance not found for this staff member");
    const adjusted = await advanceAdjustedTotal(tx, adv.id);
    const viaVoucher = await settledByRef(tx, { firmId: session.firmId, fyId: session.fyId, refTypes: ["STAFF_ADVANCE"], refIds: [adv.id] });
    const balance = round2(toNum(String(adv.amount)) - adjusted - (viaVoucher.get(adv.id) ?? 0));
    if (amt > balance + 0.009) throw new Error(`Advance ${adv.advanceNo} balance is only ${balance.toFixed(2)}`);
    rows.push({ refType: "STAFF_ADVANCE", refId: adv.id, refNo: adv.advanceNo, billAmt: toNum(String(adv.amount)), amount: amt });
  }
  const loanIds: string[] = [];
  for (const x of r?.loans ?? []) {
    const amt = round2(x.amount);
    if (amt <= 0) continue;
    const loan = await tx.staffLoan.findFirst({ where: { id: x.id, partyId, firmId: session.firmId, deletedAt: null } });
    if (!loan) throw new Error("Loan not found for this staff member");
    const balance = round2(toNum(String(loan.amount)) - (await loanRecoveredTotal(tx, loan.id)));
    if (amt > balance + 0.009) throw new Error(`Loan ${loan.loanNo} balance is only ${balance.toFixed(2)}`);
    rows.push({ refType: "STAFF_LOAN", refId: loan.id, refNo: loan.loanNo, billAmt: toNum(String(loan.amount)), amount: amt });
    loanIds.push(loan.id);
  }
  return { rows, total: round2(rows.reduce((t, x) => t + x.amount, 0)), loanIds };
}

export async function payStaffSalary(input: {
  salaryId: string;
  paymentDate: string;
  paymentHeadId: string;
  /** cash to pay; blank / 0 = whatever is outstanding after recoveries */
  amount?: number | null;
  /** settle part of the salary against open advances / loans (no cash) */
  recovery?: Recovery | null;
}): Promise<{ ok: true; paid: number; recovered: number; remaining: number } | { ok: false; error: string }> {
  const session = requireSession();
  await authorize(session, "office", "edit");
  if (!input.paymentDate || !input.paymentHeadId) {
    return { ok: false, error: "Payment date and bank/cash head are required" };
  }
  try {
    const out = await withTenant(session.tenantId, async (tx) => {
      const before = await tx.staffSalary.findFirstOrThrow({
        where: { id: input.salaryId, firmId: session.firmId, deletedAt: null },
      });
      const settledHere = await settledByRef(tx, {
        firmId: session.firmId,
        fyId: session.fyId,
        refTypes: ["STAFF_PAYROLL"],
        refIds: [before.id],
      });
      const outstanding = round2(
        toNum(String(before.netSalary)) - toNum(String(before.paidAmount)) - (settledHere.get(before.id) ?? 0)
      );
      if (outstanding <= 0.009) throw new Error("This salary is already fully paid.");
      const rec = await recoveryAllocations(tx, session, before.partyId, input.recovery);
      if (rec.total > outstanding + 0.009) {
        throw new Error(`Recoveries ${rec.total.toFixed(2)} exceed the outstanding ${outstanding.toFixed(2)}.`);
      }
      const cashRoom = round2(outstanding - rec.total);
      const cash = input.amount && input.amount > 0 ? round2(input.amount) : cashRoom;
      if (cash > cashRoom + 0.009) {
        throw new Error(`Cash ${cash.toFixed(2)} + recoveries ${rec.total.toFixed(2)} exceed the outstanding ${outstanding.toFixed(2)}.`);
      }
      if (cash + rec.total <= 0.009) throw new Error("Nothing to pay or recover.");
      const settledNow = round2(cash + rec.total);
      const voucher = await createModulePaymentVoucher(tx, session, {
        date: toDate(input.paymentDate),
        partyId: before.partyId,
        bankPartyId: input.paymentHeadId,
        paid: cash,
        deduction: rec.total,
        moduleLink: "STAFF_PAYROLL",
        allocations: [
          {
            refType: "STAFF_PAYROLL",
            refId: before.id,
            refNo: before.refNo || `SAL-${before.month}`,
            billAmt: toNum(String(before.netSalary)),
            amount: cash,
            deduction: rec.total,
            remarks: rec.total > 0 ? `incl. ${rec.total.toFixed(2)} recovered against advance / loan` : undefined,
          },
          ...rec.rows,
        ],
        narration: `Staff salary ${before.month}${settledNow < outstanding - 0.009 ? " (part payment)" : ""}${rec.total > 0 ? ` — ${rec.total.toFixed(2)} adjusted against advance / loan` : ""} — ${before.refNo || ""}`.trim(),
        partyNarration: `Salary paid ${before.month}`,
      });
      for (const id of rec.loanIds) await syncLoanStatus(tx, id);
      await audit(tx, session, {
        entity: "StaffSalary",
        entityId: input.salaryId,
        action: "UPDATE",
        before,
        after: { paidByVoucher: voucher.voucherNo, cash, recovered: rec.total, remaining: round2(outstanding - settledNow) },
      });
      return { paid: cash, recovered: rec.total, remaining: round2(outstanding - settledNow) };
    });
    revalidatePath(REVALIDATE);
    revalidateOutstanding(session.tenantId);
    return { ok: true, ...out };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "Payment failed" };
  }
}

/**
 * Pay a staff member's RUNNING salary balance — every outstanding month,
 * oldest first — on ONE Payment Voucher with one allocation per month
 * settled (exactly like the driver salary "Pay" on the running balance).
 * Recoveries against open advances / loans settle first (no cash), then the
 * cash; a part payment clears the oldest months first and leaves the rest.
 */
export async function payStaffRunning(input: {
  partyId: string;
  paymentDate: string;
  paymentHeadId: string;
  /** cash; blank / 0 = the whole running balance after recoveries */
  amount?: number | null;
  recovery?: Recovery | null;
}): Promise<{ ok: true; paid: number; recovered: number; remaining: number; voucherNo: string } | { ok: false; error: string }> {
  const session = requireSession();
  await authorize(session, "office", "edit");
  if (!input.paymentDate || !input.paymentHeadId) {
    return { ok: false, error: "Payment date and bank/cash head are required" };
  }
  try {
    const out = await withTenant(session.tenantId, async (tx) => {
      const salaries = await tx.staffSalary.findMany({
        where: { firmId: session.firmId, partyId: input.partyId, deletedAt: null },
        orderBy: { month: "asc" },
      });
      const settled = await settledByRef(tx, {
        firmId: session.firmId,
        fyId: session.fyId,
        refTypes: ["STAFF_PAYROLL"],
        refIds: salaries.map((s) => s.id),
      });
      const open = salaries
        .map((s) => ({
          s,
          due: Math.max(0, round2(toNum(String(s.netSalary)) - toNum(String(s.paidAmount)) - (settled.get(s.id) ?? 0))),
        }))
        .filter((x) => x.due > 0.009);
      const running = round2(open.reduce((sum, x) => sum + x.due, 0));
      if (running <= 0.009) throw new Error("No outstanding salary balance.");
      const rec = await recoveryAllocations(tx, session, input.partyId, input.recovery);
      if (rec.total > running + 0.009) {
        throw new Error(`Recoveries ${rec.total.toFixed(2)} exceed the running balance ${running.toFixed(2)}.`);
      }
      const cashRoom = round2(running - rec.total);
      const cash = input.amount && input.amount > 0 ? round2(input.amount) : cashRoom;
      if (cash > cashRoom + 0.009) {
        throw new Error(`Cash ${cash.toFixed(2)} + recoveries ${rec.total.toFixed(2)} exceed the running balance ${running.toFixed(2)}.`);
      }
      if (cash + rec.total <= 0.009) throw new Error("Nothing to pay or recover.");

      // FIFO across months: recoveries settle first, then cash
      let recLeft = rec.total;
      let cashLeft = cash;
      const allocations: { refType: "STAFF_PAYROLL" | "STAFF_ADVANCE" | "STAFF_LOAN"; refId: string; refNo: string; billAmt: number; amount: number; deduction?: number }[] = [];
      for (const x of open) {
        if (recLeft + cashLeft <= 0.009) break;
        const r = Math.min(x.due, recLeft);
        recLeft = round2(recLeft - r);
        const c = Math.min(round2(x.due - r), cashLeft);
        cashLeft = round2(cashLeft - c);
        allocations.push({
          refType: "STAFF_PAYROLL",
          refId: x.s.id,
          refNo: x.s.refNo || `SAL-${x.s.month}`,
          billAmt: toNum(String(x.s.netSalary)),
          amount: c,
          deduction: r,
        });
      }
      allocations.push(...rec.rows);
      const party = await tx.party.findFirst({ where: { id: input.partyId }, select: { name: true } });
      const last = open[open.length - 1].s.month;
      const settledNow = round2(cash + rec.total);
      const voucher = await createModulePaymentVoucher(tx, session, {
        date: toDate(input.paymentDate),
        partyId: input.partyId,
        bankPartyId: input.paymentHeadId,
        paid: cash,
        deduction: rec.total,
        moduleLink: "STAFF_PAYROLL",
        allocations,
        narration: `Staff salary running balance up to ${last} — ${party?.name ?? ""}${settledNow < running - 0.009 ? " (part payment)" : ""}${rec.total > 0 ? ` — ${rec.total.toFixed(2)} adjusted against advance / loan` : ""}`.trim(),
        partyNarration: `Salary paid (running balance up to ${last})`,
      });
      for (const id of rec.loanIds) await syncLoanStatus(tx, id);
      await audit(tx, session, {
        entity: "StaffSalary",
        entityId: open[open.length - 1].s.id,
        action: "UPDATE",
        after: { runningPay: { voucherNo: voucher.voucherNo, cash, recovered: rec.total, months: allocations.filter((a) => a.refType === "STAFF_PAYROLL").length, remaining: round2(running - settledNow) } },
      });
      return { paid: cash, recovered: rec.total, remaining: round2(running - settledNow), voucherNo: voucher.voucherNo };
    });
    revalidatePath(REVALIDATE);
    revalidateOutstanding(session.tenantId);
    return { ok: true, ...out };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "Payment failed" };
  }
}

/**
 * Balanced salary posting:
 *   DEBIT  Staff Salary Expense    gross
 *   CREDIT staff party             net + advanceRecovery + loanRecovery
 *          (net stays payable until paid; recoveries clear the advance/loan
 *           debits already sitting on the party)
 *   CREDIT Penalty                 penalties
 *   CREDIT Salary Deductions (Staff)  attendance + leave + other deductions
 * and when PAID:
 *   CREDIT bank/cash               net,  DEBIT staff party net
 */
async function postSalaryLedger(
  tx: Tx,
  session: ReturnType<typeof requireSession>,
  salaryId: string
) {
  const s = await tx.staffSalary.findFirstOrThrow({ where: { id: salaryId } });
  const monthLabel = s.month;
  // the expense belongs to the salary month (accrued at month-end), even when
  // it is paid in a later month — only the money legs carry the payment date
  const [my, mm] = s.month.split("-").map(Number);
  const accrualDate = new Date(my, mm, 0);
  const common = {
    date: accrualDate,
    refType: "STAFF_SALARY",
    refId: s.id,
    // the same readable reference the registers show ("SUNIL KUMAR/08/2026")
    refNo: s.refNo || `SAL-${s.month}`,
  };
  const payCommon = { ...common, date: s.paymentDate ?? accrualDate };
  const gross = toNum(String(s.grossSalary));
  const net = toNum(String(s.netSalary));
  const advRec = toNum(String(s.advanceRecovery));
  const loanRec = toNum(String(s.loanRecovery));
  const penalties = toNum(String(s.penalties));
  const otherDed = round2(
    toNum(String(s.attendanceAdj)) + toNum(String(s.leaveDeduction)) + toNum(String(s.otherDeductions))
  );

  const entries: LedgerPostEntry[] = [];
  const expenseHead = await salaryHead(tx, session.tenantId, "Staff Salary Expense", "EXPENSE");
  entries.push({
    ...common,
    accountHeadId: expenseHead,
    side: "DEBIT",
    amount: gross,
    narration: `Salary for ${monthLabel}`,
  });
  entries.push({
    ...common,
    partyId: s.partyId,
    side: "CREDIT",
    amount: round2(net + advRec + loanRec),
    narration: `Salary ${monthLabel}${advRec ? ` (advance recovery ${advRec})` : ""}${loanRec ? ` (loan recovery ${loanRec})` : ""}`,
  });
  if (penalties > 0) {
    const h = await salaryHead(tx, session.tenantId, "Penalty", "EXPENSE");
    entries.push({ ...common, accountHeadId: h, side: "CREDIT", amount: penalties, narration: `Penalty — salary ${monthLabel}` });
  }
  if (otherDed > 0) {
    const h = await salaryHead(tx, session.tenantId, "Salary Deductions (Staff)", "INCOME");
    entries.push({ ...common, accountHeadId: h, side: "CREDIT", amount: otherDed, narration: `Deductions — salary ${monthLabel}` });
  }
  // money legs only for LEGACY own-paid rows (paidAmount > 0); payments made
  // now are Payment Vouchers with their own postings
  if (s.paymentStatus === "PAID" && s.paymentHeadId && net > 0 && toNum(String(s.paidAmount)) > 0) {
    entries.push({
      ...payCommon,
      partyId: s.paymentHeadId,
      side: "CREDIT",
      amount: net,
      narration: `Salary payment ${monthLabel}`,
    });
    entries.push({
      ...payCommon,
      partyId: s.partyId,
      side: "DEBIT",
      amount: net,
      narration: `Salary paid ${monthLabel}`,
    });
  }
  await postLedger(tx, session, entries);
}

async function syncLoanStatus(tx: Tx, loanId: string | null | undefined) {
  if (!loanId) return;
  const loan = await tx.staffLoan.findFirst({ where: { id: loanId, deletedAt: null } });
  if (!loan) return;
  const recovered = await loanRecoveredTotal(tx, loanId);
  const status = recovered + 0.01 >= toNum(String(loan.amount)) ? "CLOSED" : "OPEN";
  if (status !== loan.status) {
    await tx.staffLoan.update({ where: { id: loanId }, data: { status } });
  }
}

// ---------------------------------------------------------------- delete

/**
 * Deletes soft-delete the row and remove its ledger entries. A record that
 * something else already depends on (a salary recovery, a voucher allocation)
 * must be untangled first — the guard names what is blocking it.
 */
export async function deleteStaffAdvance(
  id: string
): Promise<{ ok: true } | { ok: false; error: string }> {
  const session = requireSession();
  await authorize(session, "office", "delete");
  try {
    return await withTenant(session.tenantId, async (tx) => {
      const adv = await tx.staffAdvance.findFirst({
        where: { id, firmId: session.firmId, deletedAt: null },
      });
      if (!adv) return { ok: false as const, error: "Advance not found" };
      const adjusted = await advanceAdjustedTotal(tx, id);
      if (adjusted > 0) {
        return {
          ok: false as const,
          error: `Advance ${adv.advanceNo} has ${adjusted.toFixed(2)} recovered through salary — delete or edit those salaries first`,
        };
      }
      const settled = await settledByRef(tx, {
        firmId: session.firmId,
        fyId: session.fyId,
        refTypes: ["STAFF_ADVANCE"],
        refIds: [id],
      });
      if ((settled.get(id) ?? 0) > 0) {
        return {
          ok: false as const,
          error: `Advance ${adv.advanceNo} is settled by a receipt voucher — delete that voucher first`,
        };
      }
      if (adv.voucherId) {
        const v = await tx.voucher.findFirst({ where: { id: adv.voucherId, deletedAt: null }, select: { voucherNo: true } });
        if (v) {
          return {
            ok: false as const,
            error: `Advance ${adv.advanceNo} was paid through voucher ${v.voucherNo} — delete that voucher (Accounts → Voucher Register); it removes the advance with it.`,
          };
        }
      }
      await tx.staffAdvance.update({ where: { id }, data: { deletedAt: new Date() } });
      await reverseLedger(tx, "STAFF_ADVANCE", id);
      await audit(tx, session, { entity: "StaffAdvance", entityId: id, action: "DELETE", before: adv });
      revalidatePath(REVALIDATE);
      return { ok: true as const };
    });
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "Delete failed" };
  }
}

export async function deleteStaffLoan(
  id: string
): Promise<{ ok: true } | { ok: false; error: string }> {
  const session = requireSession();
  await authorize(session, "office", "delete");
  try {
    return await withTenant(session.tenantId, async (tx) => {
      const loan = await tx.staffLoan.findFirst({
        where: { id, firmId: session.firmId, deletedAt: null },
      });
      if (!loan) return { ok: false as const, error: "Loan not found" };
      const recovered = await loanRecoveredTotal(tx, id);
      if (recovered > 0) {
        return {
          ok: false as const,
          error: `Loan ${loan.loanNo} has ${recovered.toFixed(2)} recovered through salary — delete or edit those salaries first`,
        };
      }
      if (loan.voucherId) {
        const v = await tx.voucher.findFirst({ where: { id: loan.voucherId, deletedAt: null }, select: { voucherNo: true } });
        if (v) {
          return {
            ok: false as const,
            error: `Loan ${loan.loanNo} was paid through voucher ${v.voucherNo} — delete that voucher (Accounts → Voucher Register); it removes the loan with it.`,
          };
        }
      }
      await tx.staffLoan.update({ where: { id }, data: { deletedAt: new Date() } });
      await reverseLedger(tx, "STAFF_LOAN", id);
      await audit(tx, session, { entity: "StaffLoan", entityId: id, action: "DELETE", before: loan });
      revalidatePath(REVALIDATE);
      return { ok: true as const };
    });
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "Delete failed" };
  }
}

/** Deletes the month's salary (paid or pending): ledger entries reversed, and
 *  any advance / loan recovered in it opens back up automatically. */
export async function deleteStaffSalary(
  id: string
): Promise<{ ok: true } | { ok: false; error: string }> {
  const session = requireSession();
  await authorize(session, "office", "delete");
  try {
    const res = await withTenant(session.tenantId, async (tx) => {
      const s = await tx.staffSalary.findFirst({
        where: { id, firmId: session.firmId, deletedAt: null },
      });
      if (!s) return { ok: false as const, error: "Salary not found" };
      const settled = await settledByRef(tx, {
        firmId: session.firmId,
        fyId: session.fyId,
        refTypes: ["STAFF_PAYROLL"],
        refIds: [id],
      });
      if ((settled.get(id) ?? 0) > 0) {
        return {
          ok: false as const,
          error: `Salary ${s.month} is settled by a payment voucher — delete that voucher first`,
        };
      }
      await tx.staffSalary.update({ where: { id }, data: { deletedAt: new Date() } });
      await reverseLedger(tx, "STAFF_SALARY", id);
      await syncLoanStatus(tx, s.loanId);
      await audit(tx, session, { entity: "StaffSalary", entityId: id, action: "DELETE", before: s });
      revalidatePath(REVALIDATE);
      return { ok: true as const };
    });
    if (res.ok) revalidateOutstanding(session.tenantId);
    return res;
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "Delete failed" };
  }
}

// ---------------------------------------------------------------- details

export interface StaffDetails {
  partyId: string;
  name: string;
  profile: {
    employeeId: string;
    department: string;
    designation: string;
    joiningDate: string | null;
    basicSalary: number;
    allowances: number;
  };
  advances: {
    id: string;
    advanceNo: string;
    date: string;
    amount: number;
    adjusted: number;
    balance: number;
    remarks: string;
  }[];
  loans: {
    id: string;
    loanNo: string;
    date: string;
    amount: number;
    emiAmount: number;
    recovered: number;
    outstanding: number;
    status: string;
    remarks: string;
  }[];
  salaries: {
    id: string;
    month: string;
    basic: number;
    allowances: number;
    overtime: number;
    incentives: number;
    bonus: number;
    otherEarnings: number;
    attendanceAdj: number;
    leaveDeduction: number;
    penalties: number;
    otherDeductions: number;
    advanceId: string | null;
    loanId: string | null;
    grossSalary: number;
    totalDeductions: number;
    advanceRecovery: number;
    loanRecovery: number;
    netSalary: number;
    paymentStatus: string;
    /** settled through payment-voucher allocations (live) */
    voucherSettled: number;
    /** fully covered by own payment + voucher settlements */
    isSettled: boolean;
    /** net − own paid − voucher settled */
    outstanding: number;
    /** outstanding of earlier months (months run oldest → newest) */
    prevPending: number;
    /** prevPending + outstanding — what "Pay running balance" pays */
    runningBalance: number;
    /** date of the latest payment voucher settling this month */
    voucherPaidDate: string | null;
    voucherNos: string[];
    paymentDate: string | null;
    paymentHeadId: string | null;
    remarks: string;
  }[];
  ledger: {
    date: string;
    refType: string;
    refNo: string;
    narration: string;
    debit: number;
    credit: number;
    balance: number;
  }[];
}

export async function getStaffDetails(
  partyId: string
): Promise<{ ok: true; data: StaffDetails } | { ok: false; error: string }> {
  const session = requireSession();
  // salary history, advances, loans and the party ledger are sensitive —
  // gated like every other read in this module
  await authorize(session, "office", "view");
  return withTenant(session.tenantId, async (tx) => {
    const party = await tx.party.findFirst({ where: { id: partyId } });
    if (!party) return { ok: false as const, error: "Staff not found" };
    // LIFETIME view (FY continuity): the list totals, the salary dialog's
    // open-advance/loan pickers and the save action all work firm-wide — an
    // old-year advance must be selectable for recovery here too, and the
    // ledger's running balance seeds from the lifetime opening
    const scope = { firmId: session.firmId, partyId, deletedAt: null };
    const [profile, advances, loans, salaries, entries] = await Promise.all([
      tx.staffProfile.findUnique({ where: { partyId } }),
      tx.staffAdvance.findMany({ where: scope, orderBy: { date: "asc" } }),
      tx.staffLoan.findMany({ where: scope, orderBy: { date: "asc" } }),
      tx.staffSalary.findMany({ where: scope, orderBy: { month: "asc" } }),
      tx.ledgerEntry.findMany({
        where: { firmId: session.firmId, partyId },
        orderBy: [{ date: "asc" }, { createdAt: "asc" }],
      }),
    ]);

    // voucher-side settlements: a receipt against an advance repays it in
    // cash, a payment voucher against a salary pays it — both must show here
    // or the screen offers balances that no longer exist
    const [advViaVoucher, salViaVoucher] = await Promise.all([
      settledByRef(tx, {
        firmId: session.firmId,
        fyId: session.fyId,
        refTypes: ["STAFF_ADVANCE"],
        refIds: advances.map((a) => a.id),
      }),
      settledByRef(tx, {
        firmId: session.firmId,
        fyId: session.fyId,
        refTypes: ["STAFF_PAYROLL"],
        refIds: salaries.map((s) => s.id),
      }),
    ]);
    // latest payment-voucher date per salary (the "paid on" of a voucher-paid month)
    const salVoucherRows = salaries.length
      ? await tx.voucherAllocation.findMany({
          where: {
            refType: "STAFF_PAYROLL",
            refId: { in: salaries.map((s) => s.id) },
            voucher: { deletedAt: null, firmId: session.firmId },
          },
          select: { refId: true, voucher: { select: { voucherDate: true, voucherNo: true } } },
        })
      : [];
    const salVoucherDate = new Map<string, Date>();
    const salVoucherNos = new Map<string, string[]>();
    for (const r of salVoucherRows) {
      const prev = salVoucherDate.get(r.refId);
      if (!prev || r.voucher.voucherDate > prev) salVoucherDate.set(r.refId, r.voucher.voucherDate);
      salVoucherNos.set(r.refId, [...(salVoucherNos.get(r.refId) ?? []), r.voucher.voucherNo]);
    }

    const outstandingOf = (s: (typeof salaries)[number]) =>
      Math.max(
        0,
        round2(toNum(String(s.netSalary)) - toNum(String(s.paidAmount)) - (salViaVoucher.get(s.id) ?? 0))
      );
    const advAdjusted = new Map<string, number>();
    const loanRecovered = new Map<string, number>();
    const loanViaVoucher = loans.length
      ? await tx.voucherAllocation.findMany({
          where: { refType: "STAFF_LOAN", refId: { in: loans.map((l) => l.id) }, voucher: { deletedAt: null } },
          select: { refId: true, amount: true },
        })
      : [];
    for (const a of loanViaVoucher) {
      loanRecovered.set(a.refId, round2((loanRecovered.get(a.refId) ?? 0) + toNum(String(a.amount))));
    }
    for (const s of salaries) {
      if (s.advanceId)
        advAdjusted.set(
          s.advanceId,
          round2((advAdjusted.get(s.advanceId) ?? 0) + toNum(String(s.advanceRecovery)))
        );
      if (s.loanId)
        loanRecovered.set(
          s.loanId,
          round2((loanRecovered.get(s.loanId) ?? 0) + toNum(String(s.loanRecovery)))
        );
    }

    let running =
      party.openingSide === "DEBIT"
        ? toNum(String(party.openingBalance))
        : -toNum(String(party.openingBalance));
    const ledger = entries.map((e) => {
      const amt = toNum(String(e.amount));
      const debit = e.side === "DEBIT" ? amt : 0;
      const credit = e.side === "CREDIT" ? amt : 0;
      running = round2(running + debit - credit);
      return {
        date: e.date.toISOString(),
        refType: e.refType,
        refNo: e.refNo,
        narration: e.narration ?? "",
        debit,
        credit,
        balance: running,
      };
    });

    return {
      ok: true as const,
      data: {
        partyId,
        name: party.name,
        profile: {
          employeeId: profile?.employeeId ?? "",
          department: profile?.department ?? "",
          designation: profile?.designation ?? "",
          joiningDate: profile?.joiningDate ? profile.joiningDate.toISOString() : null,
          basicSalary: toNum(String(profile?.basicSalary ?? 0)),
          allowances: toNum(String(profile?.allowances ?? 0)),
        },
        advances: advances.map((a) => {
          // payroll recoveries + receipt-voucher repayments both consume it
          const adjusted = round2((advAdjusted.get(a.id) ?? 0) + (advViaVoucher.get(a.id) ?? 0));
          return {
            id: a.id,
            advanceNo: a.advanceNo,
            date: a.date.toISOString(),
            amount: toNum(String(a.amount)),
            adjusted,
            balance: round2(toNum(String(a.amount)) - adjusted),
            remarks: a.remarks ?? "",
          };
        }),
        loans: loans.map((l) => {
          const recovered = loanRecovered.get(l.id) ?? 0;
          return {
            id: l.id,
            loanNo: l.loanNo,
            date: l.date.toISOString(),
            amount: toNum(String(l.amount)),
            emiAmount: toNum(String(l.emiAmount)),
            recovered,
            outstanding: round2(toNum(String(l.amount)) - recovered),
            status: l.status,
            remarks: l.remarks ?? "",
          };
        }),
        salaries: salaries.map((s, i) => ({
          id: s.id,
          month: s.month,
          outstanding: outstandingOf(s),
          prevPending: round2(salaries.slice(0, i).reduce((sum, x) => sum + outstandingOf(x), 0)),
          runningBalance: round2(salaries.slice(0, i + 1).reduce((sum, x) => sum + outstandingOf(x), 0)),
          basic: toNum(String(s.basic)),
          allowances: toNum(String(s.allowances)),
          overtime: toNum(String(s.overtime)),
          incentives: toNum(String(s.incentives)),
          bonus: toNum(String(s.bonus)),
          otherEarnings: toNum(String(s.otherEarnings)),
          attendanceAdj: toNum(String(s.attendanceAdj)),
          leaveDeduction: toNum(String(s.leaveDeduction)),
          penalties: toNum(String(s.penalties)),
          otherDeductions: toNum(String(s.otherDeductions)),
          advanceId: s.advanceId,
          loanId: s.loanId,
          grossSalary: toNum(String(s.grossSalary)),
          totalDeductions: toNum(String(s.totalDeductions)),
          advanceRecovery: toNum(String(s.advanceRecovery)),
          loanRecovery: toNum(String(s.loanRecovery)),
          netSalary: toNum(String(s.netSalary)),
          paymentStatus: s.paymentStatus,
          voucherSettled: salViaVoucher.get(s.id) ?? 0,
          // a salary is settled when own payment + voucher allocations cover
          // the net — a voucher-paid month must not read as Pending forever
          isSettled:
            round2(toNum(String(s.paidAmount)) + (salViaVoucher.get(s.id) ?? 0)) >=
            toNum(String(s.netSalary)) - 0.009,
          voucherPaidDate: salVoucherDate.get(s.id)?.toISOString() ?? null,
          voucherNos: salVoucherNos.get(s.id) ?? [],
          paymentDate: s.paymentDate ? s.paymentDate.toISOString() : null,
          paymentHeadId: s.paymentHeadId,
          remarks: s.remarks ?? "",
        })),
        ledger,
      },
    };
  });
}
