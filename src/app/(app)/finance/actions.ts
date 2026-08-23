"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { requireSession } from "@/lib/session";
import { withTenant, type Tx } from "@/lib/db";
import { authorize } from "@/lib/authz";
import { audit } from "@/lib/audit";
import { nextDocNumber } from "@/lib/sequences";
import { ensureAccountHead, postLedger, reverseLedger, type LedgerPostEntry } from "@/lib/ledger";
import { tdsHead } from "@/lib/account-heads";
import { round2 } from "@/lib/calc/tds";
import { toNum } from "@/lib/utils";
import { isLoanTaken, nextDueDate, suggestNextEmi, type EmiSuggestion } from "@/lib/loan";

/**
 * Finance & Loan Management.
 *
 * Loans live in their own register but move no money of their own: every
 * instalment, settlement and personal transfer creates an ordinary Payment or
 * Receipt Voucher and posts through the shared ledger engine, exactly like a
 * driver settlement does. Nothing here is a second accounting engine.
 *
 * Direction follows the loan: money taken is a liability the company repays
 * (PAYMENT vouchers, interest is an expense, TDS is payable); money given is a
 * receivable (RECEIPT vouchers, interest is income, TDS is receivable).
 */

const REVALIDATE = "/finance";

const loanSchema = z.object({
  id: z.string().nullish(),
  loanNo: z.string().trim().min(1, "Loan number is required"),
  date: z.string().min(1, "Date is required"),
  partyId: z.string().min(1, "Party is required"),
  loanType: z.enum([
    "BUSINESS_TAKEN",
    "BUSINESS_GIVEN",
    "VEHICLE",
    "PERSONAL_TAKEN",
    "PERSONAL_GIVEN",
  ]),
  purpose: z.string().nullish(),
  vehicleId: z.string().nullish(),
  amount: z.number().min(0.01, "Loan amount is required"),
  interestMode: z.enum(["NONE", "FLAT", "REDUCING"]).default("NONE"),
  interestRate: z.number().min(0).default(0),
  emiApplicable: z.boolean().default(false),
  emiAmount: z.number().min(0).default(0),
  emiStartDate: z.string().nullish(),
  emiFrequency: z.enum(["MONTHLY", "QUARTERLY", "YEARLY"]).default("MONTHLY"),
  tenureMonths: z.number().min(0).default(0),
  tdsApplicable: z.boolean().default(false),
  tdsPct: z.number().min(0).default(0),
  /** bank/cash account the loan was received into or disbursed from */
  bankPartyId: z.string().nullish(),
  /** post the disbursement itself; off when the loan predates the software */
  postDisbursement: z.boolean().default(true),
  remarks: z.string().nullish(),
});

const toDate = (s: string) => new Date(`${s}T00:00:00`);

export async function saveLoan(
  input: unknown
): Promise<{ ok: true; id: string } | { ok: false; error: string }> {
  const session = requireSession();
  const parsed = loanSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid input" };
  const d = parsed.data;
  await authorize(session, "finance", d.id ? "edit" : "create");

  if (d.loanType === "VEHICLE" && !d.vehicleId) {
    return { ok: false, error: "Vehicle is required for a vehicle loan." };
  }
  if (d.emiApplicable && d.emiAmount <= 0) {
    return { ok: false, error: "Enter the EMI amount, or turn EMI off." };
  }
  if (d.postDisbursement && !d.bankPartyId) {
    return {
      ok: false,
      error: "Choose the bank/cash account the loan was received into or paid out from.",
    };
  }

  try {
    return await withTenant(session.tenantId, async (tx) => {
      // One loan, one vehicle: a second loan on the same vehicle would make the
      // vehicle's finance tab and its EMI cost ambiguous.
      if (d.loanType === "VEHICLE" && d.vehicleId) {
        const clash = await tx.loan.findFirst({
          where: {
            firmId: session.firmId,
            fyId: session.fyId,
            vehicleId: d.vehicleId,
            status: "ACTIVE",
            deletedAt: null,
            ...(d.id ? { id: { not: d.id } } : {}),
          },
        });
        if (clash) {
          return {
            ok: false as const,
            error: `Loan ${clash.loanNo} is already running against this vehicle.`,
          };
        }
      }

      const values = {
        loanNo: d.loanNo,
        date: toDate(d.date),
        partyId: d.partyId,
        loanType: d.loanType,
        purpose: d.purpose?.trim() || null,
        // only a VEHICLE loan carries a vehicle — a stray vehicleId on any
        // other loan type would drag its EMIs into the vehicle P&Ls
        vehicleId: d.loanType === "VEHICLE" ? d.vehicleId || null : null,
        amount: d.amount,
        interestMode: d.interestMode,
        interestRate: d.interestRate,
        emiApplicable: d.emiApplicable,
        emiAmount: d.emiApplicable ? d.emiAmount : 0,
        emiStartDate: d.emiStartDate ? toDate(d.emiStartDate) : null,
        emiFrequency: d.emiFrequency,
        tenureMonths: d.tenureMonths,
        tdsApplicable: d.tdsApplicable,
        tdsPct: d.tdsApplicable ? d.tdsPct : 0,
        remarks: d.remarks || null,
      };

      let id: string;
      if (d.id) {
        const before = await tx.loan.findFirstOrThrow({
          // firm-scoped: a loan id from another firm must not be editable here
          where: { id: d.id, firmId: session.firmId, deletedAt: null },
          include: { emis: { where: { deletedAt: null } } },
        });
        const repaid = round2(
          before.emis.reduce((s, e) => s + toNum(String(e.principal)), 0)
        );
        if (d.amount < repaid - 0.009) {
          return {
            ok: false as const,
            error: `${repaid} of principal is already repaid — the loan cannot be reduced to ${d.amount}.`,
          };
        }
        const updated = await tx.loan.update({
          where: { id: d.id },
          data: {
            ...values,
            // status re-syncs with the edited amount: raising a CLOSED loan's
            // amount above what is repaid REOPENS it (else it would be
            // invisible on EMI-due and unpayable forever), and an amount now
            // fully covered closes it
            status: d.amount > repaid + 0.009 ? "ACTIVE" : "CLOSED",
          },
        });
        id = updated.id;
        await audit(tx, session, {
          entity: "Loan",
          entityId: id,
          action: "UPDATE",
          before,
          after: updated,
        });
      } else {
        const created = await tx.loan.create({
          data: {
            tenantId: session.tenantId,
            firmId: session.firmId,
            fyId: session.fyId,
            createdById: session.userId,
            ...values,
          },
        });
        id = created.id;
        await audit(tx, session, { entity: "Loan", entityId: id, action: "CREATE", after: created });
      }

      // Disbursement: money in on a loan taken, money out on a loan given. Both
      // legs are party <-> bank — no expense, because borrowing is not a cost.
      await reverseLedger(tx, "LOAN", id);
      if (d.postDisbursement && d.bankPartyId) {
        const taken = isLoanTaken(d.loanType);
        const common = {
          date: values.date,
          refType: "LOAN",
          refId: id,
          refNo: d.loanNo,
          narration: `Loan ${d.loanNo} ${taken ? "received" : "given"}${d.purpose ? " — " + d.purpose : ""}`,
        };
        await postLedger(tx, session, [
          {
            ...common,
            partyId: d.bankPartyId,
            side: taken ? "DEBIT" : "CREDIT",
            amount: d.amount,
          },
          {
            ...common,
            partyId: d.partyId,
            side: taken ? "CREDIT" : "DEBIT",
            amount: d.amount,
          },
        ]);
      }

      revalidatePath(REVALIDATE);
      return { ok: true as const, id };
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "Save failed";
    if (msg.includes("Unique constraint")) {
      return { ok: false, error: `Loan number ${d.loanNo} already exists in this financial year.` };
    }
    return { ok: false, error: msg };
  }
}

export async function deleteLoan(
  id: string
): Promise<{ ok: true } | { ok: false; error: string }> {
  const session = requireSession();
  if (session.role !== "ADMIN" && session.role !== "OWNER") {
    return { ok: false, error: "Only Admin/Owner may delete loans" };
  }
  await authorize(session, "finance", "delete");
  try {
    return await withTenant(session.tenantId, async (tx) => {
      const before = await tx.loan.findFirstOrThrow({
        where: { id, firmId: session.firmId, deletedAt: null },
        include: { emis: { where: { deletedAt: null } } },
      });
      if (before.emis.length) {
        return {
          ok: false as const,
          error: `This loan has ${before.emis.length} instalment(s) recorded — delete those first.`,
        };
      }
      await tx.loan.update({ where: { id }, data: { deletedAt: new Date() } });
      await reverseLedger(tx, "LOAN", id);
      await audit(tx, session, { entity: "Loan", entityId: id, action: "DELETE", before });
      revalidatePath(REVALIDATE);
      return { ok: true as const };
    });
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Delete failed" };
  }
}

// ---------------------------------------------------------------- instalments

const emiSchema = z.object({
  loanId: z.string().min(1),
  payDate: z.string().min(1, "Payment date is required"),
  principal: z.number().min(0).default(0),
  interest: z.number().min(0).default(0),
  penalty: z.number().min(0).default(0),
  otherAmt: z.number().min(0).default(0),
  tdsAmt: z.number().min(0).default(0),
  bankPartyId: z.string().min(1, "Bank / Cash account is required"),
  /** closing instalment: whatever is left is cleared and the loan closes */
  isSettlement: z.boolean().default(false),
  remarks: z.string().nullish(),
});

/**
 * Record one instalment (or the closing settlement) and post it.
 *
 * Creates a real Payment/Receipt Voucher so the instalment shows up in the
 * Voucher Register and every ledger report alongside everything else.
 *
 * VEHICLE loans post the WHOLE instalment (principal + interest + penalty +
 * charges) to one "Vehicle EMI Expense" head, stamped with the vehicle — this
 * ERP keeps no fixed assets, depreciation or loan-liability accounting, so
 * splitting the EMI buys nothing and the full amount is simply the cost of
 * operating the vehicle. The loan module still tracks principal/interest for
 * outstanding, reminders and TDS (TDS stays limited to the interest).
 * Non-vehicle loans keep the standard split: principal settles the loan
 * party, interest/penalty/charges post to their own heads. On a relative
 * vehicle the whole instalment transfers to the owner's ledger as before.
 */
export async function payLoanEmi(
  input: unknown
): Promise<{ ok: true; voucherNo: string } | { ok: false; error: string }> {
  const session = requireSession();
  const parsed = emiSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid input" };
  const d = parsed.data;
  await authorize(session, "finance", "create");

  try {
    return await withTenant(session.tenantId, async (tx) => {
      const loan = await tx.loan.findFirstOrThrow({
        // firm-scoped: paying an EMI on another firm's loan would post the
        // voucher and ledger legs into the wrong firm's books
        where: { id: d.loanId, firmId: session.firmId, deletedAt: null },
        include: { emis: { where: { deletedAt: null } } },
      });
      if (loan.status === "CLOSED") {
        return { ok: false as const, error: "This loan is already closed." };
      }

      const repaid = round2(loan.emis.reduce((s, e) => s + toNum(String(e.principal)), 0));
      const outstanding = round2(toNum(String(loan.amount)) - repaid);
      if (d.principal > outstanding + 0.009) {
        return {
          ok: false as const,
          error: `Principal ${d.principal} exceeds the ${outstanding} still outstanding.`,
        };
      }
      // TDS comes out of the interest, never the principal — a deduction bigger
      // than the interest would mean deducting tax on capital repayment
      if (d.tdsAmt > d.interest + 0.009) {
        return { ok: false as const, error: "TDS cannot exceed the interest in this instalment." };
      }
      const total = round2(d.principal + d.interest + d.penalty + d.otherAmt);
      if (total <= 0) return { ok: false as const, error: "Nothing to pay in this instalment." };
      const netPaid = round2(total - d.tdsAmt);

      const taken = isLoanTaken(loan.loanType);
      const payDate = toDate(d.payDate);
      const voucherNo = await nextDocNumber(tx, {
        tenantId: session.tenantId,
        firmId: session.firmId,
        fyId: session.fyId,
        docType: taken ? "VOUCHER_PAYMENT" : "VOUCHER_RECEIPT",
      });

      const label = d.isSettlement ? "settlement" : `EMI ${loan.emis.length + 1}`;
      const narration = `Loan ${loan.loanNo} ${label}${d.remarks ? " — " + d.remarks : ""}`;
      const voucher = await tx.voucher.create({
        data: {
          tenantId: session.tenantId,
          firmId: session.firmId,
          fyId: session.fyId,
          voucherNo,
          voucherDate: payDate,
          type: taken ? "PAYMENT" : "RECEIPT",
          entryType: "BANK",
          moduleLink: "OTHERS",
          partyId: loan.partyId,
          vehicleId: loan.vehicleId,
          bankPartyId: d.bankPartyId,
          amount: total,
          tdsAmt: d.tdsAmt,
          netAmount: netPaid,
          remarks: narration,
          createdById: session.userId,
        },
      });

      const emi = await tx.loanEmi.create({
        data: {
          tenantId: session.tenantId,
          firmId: session.firmId,
          fyId: session.fyId,
          loanId: loan.id,
          emiNo: loan.emis.length + 1,
          dueDate: nextDueDate(loan.emiStartDate, loan.emiFrequency, loan.emis.length),
          payDate,
          principal: d.principal,
          interest: d.interest,
          penalty: d.penalty,
          otherAmt: d.otherAmt,
          tdsAmt: d.tdsAmt,
          total,
          netPaid,
          isSettlement: d.isSettlement,
          bankPartyId: d.bankPartyId,
          voucherId: voucher.id,
          voucherNo,
          remarks: d.remarks || null,
          createdById: session.userId,
        },
      });

      const common = {
        date: payDate,
        refType: "VOUCHER",
        refId: voucher.id,
        refNo: loan.loanNo,
        narration,
      };
      const entries: LedgerPostEntry[] = [];
      // bank moves the NET; the deducted tax sits in the TDS ledger
      entries.push({
        ...common,
        partyId: d.bankPartyId,
        side: taken ? "CREDIT" : "DEBIT",
        amount: netPaid,
      });
      if (d.tdsAmt > 0) {
        const head = await ensureAccountHead(
          tx,
          session,
          tdsHead(taken ? "PAYMENT" : "RECEIPT"),
          taken ? "INCOME" : "EXPENSE"
        );
        entries.push({
          ...common,
          accountHeadId: head,
          side: taken ? "CREDIT" : "DEBIT",
          amount: d.tdsAmt,
          narration: `TDS on interest — loan ${loan.loanNo}`,
        });
      }
      // A VEHICLE loan's whole instalment is one operating cost: no fixed
      // assets or loan-liability ledgers exist in this ERP, so the full EMI
      // debits "Vehicle EMI Expense" (vehicle-stamped) and nothing splits.
      // Keyed on the loan TYPE, not vehicleId — a legacy non-vehicle loan
      // carrying a stray vehicleId must keep the standard split.
      const vehicleEmiRule = loan.loanType === "VEHICLE";
      if (vehicleEmiRule) {
        const headId = await ensureAccountHead(tx, session, "Vehicle EMI Expense", "EXPENSE");
        entries.push({
          ...common,
          accountHeadId: headId,
          vehicleId: loan.vehicleId,
          side: "DEBIT",
          amount: total,
          narration: `Vehicle EMI — loan ${loan.loanNo} ${label}`,
        });
      } else {
        // principal settles the loan account itself
        if (d.principal > 0) {
          entries.push({
            ...common,
            partyId: loan.partyId,
            side: taken ? "DEBIT" : "CREDIT",
            amount: d.principal,
            narration: `Principal repaid — loan ${loan.loanNo}`,
          });
        }
        // interest, penalty and charges are the actual cost (or income)
        const costLines: [string, number][] = [
          [taken ? "Interest Expense" : "Interest Income", d.interest],
          ["Penalty", d.penalty],
          ["Other Charges", d.otherAmt],
        ];
        for (const [headName, amount] of costLines) {
          if (amount <= 0) continue;
          const headId = await ensureAccountHead(tx, session, headName, taken ? "EXPENSE" : "INCOME");
          entries.push({
            ...common,
            accountHeadId: headId,
            vehicleId: loan.vehicleId,
            side: taken ? "DEBIT" : "CREDIT",
            amount,
            narration: `${headName} — loan ${loan.loanNo} ${label}`,
          });
        }
      }

      // Relative vehicle: the company paid an EMI on a vehicle it does not own,
      // so the whole instalment belongs on the relative owner's ledger. Same
      // rule diesel and every other expense head already follow.
      if (vehicleEmiRule && loan.vehicleId) {
        const vehicle = await tx.vehicle.findFirst({ where: { id: loan.vehicleId } });
        if (vehicle?.ownershipType === "RELATIVE" && vehicle.ownerId) {
          // credit the same head the EMI debited, so the transfer nets it out
          const headId = await ensureAccountHead(tx, session, "Vehicle EMI Expense", "EXPENSE");
          entries.push(
            {
              ...common,
              partyId: vehicle.ownerId,
              side: "DEBIT",
              amount: total,
              narration: `Loan ${loan.loanNo} ${label} for relative vehicle ${vehicle.number} — transferred to owner`,
            },
            {
              ...common,
              accountHeadId: headId,
              side: "CREDIT",
              amount: total,
              narration: `Loan ${loan.loanNo} ${label} ${vehicle.number} — shifted to relative owner ledger`,
            }
          );
        }
      }
      await postLedger(tx, session, entries);

      // the loan closes when it is settled, or when the last rupee of principal
      // has come back
      const stillOut = round2(outstanding - d.principal);
      if (d.isSettlement || stillOut <= 0.009) {
        await tx.loan.update({
          where: { id: loan.id },
          data: { status: "CLOSED", closedDate: payDate },
        });
      }

      await audit(tx, session, {
        entity: "LoanEmi",
        entityId: emi.id,
        action: "CREATE",
        after: emi,
      });
      revalidatePath(REVALIDATE);
      revalidatePath("/accounts/vouchers/register");
      revalidatePath("/vehicle/management");
      return { ok: true as const, voucherNo };
    });
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Payment failed" };
  }
}

/** Undo an instalment — its voucher, its postings and the loan's closure. */
export async function deleteLoanEmi(
  id: string
): Promise<{ ok: true } | { ok: false; error: string }> {
  const session = requireSession();
  if (session.role !== "ADMIN" && session.role !== "OWNER") {
    return { ok: false, error: "Only Admin/Owner may delete an instalment" };
  }
  await authorize(session, "finance", "delete");
  try {
    await withTenant(session.tenantId, async (tx) => {
      const before = await tx.loanEmi.findFirstOrThrow({
        where: { id, deletedAt: null, loan: { firmId: session.firmId } },
      });
      await tx.loanEmi.update({ where: { id }, data: { deletedAt: new Date() } });
      if (before.voucherId) {
        await tx.voucher.update({
          where: { id: before.voucherId },
          data: { deletedAt: new Date() },
        });
        await reverseLedger(tx, "VOUCHER", before.voucherId);
      }
      // removing an instalment always reopens the loan: there is outstanding
      // again by definition
      await tx.loan.update({
        where: { id: before.loanId },
        data: { status: "ACTIVE", closedDate: null },
      });
      await audit(tx, session, { entity: "LoanEmi", entityId: id, action: "DELETE", before });
    });
    revalidatePath(REVALIDATE);
    revalidatePath("/accounts/vouchers/register");
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Delete failed" };
  }
}

/** Figures the EMI screen opens with — all of them editable by the user. */
export async function getEmiSuggestion(loanId: string): Promise<
  (EmiSuggestion & { outstanding: number; loanNo: string }) | null
> {
  const session = requireSession();
  return withTenant(session.tenantId, async (tx) => {
    const loan = await tx.loan.findFirst({
      where: { id: loanId, firmId: session.firmId, deletedAt: null },
      include: { emis: { where: { deletedAt: null } } },
    });
    if (!loan) return null;
    const amount = toNum(String(loan.amount));
    const outstanding = round2(
      amount - loan.emis.reduce((s, e) => s + toNum(String(e.principal)), 0)
    );
    const suggestion = suggestNextEmi({
      interestMode: loan.interestMode,
      ratePct: toNum(String(loan.interestRate)),
      amount,
      outstanding,
      emiAmount: toNum(String(loan.emiAmount)),
      frequency: loan.emiFrequency,
      emiStartDate: loan.emiStartDate,
      paidCount: loan.emis.length,
      tdsApplicable: loan.tdsApplicable,
      tdsPct: toNum(String(loan.tdsPct)),
    });
    return { ...suggestion, outstanding, loanNo: loan.loanNo };
  });
}

// ------------------------------------------------- other receipts & payments

const financeTxnSchema = z.object({
  id: z.string().nullish(),
  date: z.string().min(1, "Date is required"),
  direction: z.enum(["RECEIPT", "PAYMENT"]),
  txnType: z.enum([
    "PERSONAL",
    "TEMPORARY_LOAN",
    "FAMILY_TRANSFER",
    "SECURITY_DEPOSIT",
    "MISC",
  ]),
  partyId: z.string().min(1, "Party is required"),
  amount: z.number().min(0.01, "Amount is required"),
  entryType: z.enum(["CASH", "BANK", "CARD"]).default("CASH"),
  bankPartyId: z.string().min(1, "Cash / Bank account is required"),
  remarks: z.string().nullish(),
});

// module-local: a "use server" file may only EXPORT async functions
const FINANCE_TXN_LABEL: Record<string, string> = {
  PERSONAL: "Personal",
  TEMPORARY_LOAN: "Temporary Loan",
  FAMILY_TRANSFER: "Family Transfer",
  SECURITY_DEPOSIT: "Security Deposit",
  MISC: "Miscellaneous",
};

/**
 * A non-operational receipt or payment. It posts party <-> bank and nothing
 * else: no freight, no expense head, so it can never reach an operational
 * report while still being visible in the ledgers and the voucher register.
 */
export async function saveFinanceTxn(
  input: unknown
): Promise<{ ok: true; voucherNo: string } | { ok: false; error: string }> {
  const session = requireSession();
  const parsed = financeTxnSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid input" };
  const d = parsed.data;
  await authorize(session, "finance", d.id ? "edit" : "create");

  try {
    return await withTenant(session.tenantId, async (tx) => {
      const date = toDate(d.date);
      const receipt = d.direction === "RECEIPT";
      const label = `${FINANCE_TXN_LABEL[d.txnType]} ${receipt ? "receipt" : "payment"}`;

      let id: string;
      let voucherNo: string;
      let voucherId: string | null;
      if (d.id) {
        const before = await tx.financeTxn.findFirstOrThrow({
          where: { id: d.id, firmId: session.firmId, fyId: session.fyId, deletedAt: null },
        });
        voucherNo = before.voucherNo;
        voucherId = before.voucherId;
        const updated = await tx.financeTxn.update({
          where: { id: d.id },
          data: {
            date,
            direction: d.direction,
            txnType: d.txnType,
            partyId: d.partyId,
            amount: d.amount,
            entryType: d.entryType,
            bankPartyId: d.bankPartyId,
            remarks: d.remarks || null,
          },
        });
        id = updated.id;
        if (voucherId) {
          await tx.voucher.update({
            where: { id: voucherId },
            data: {
              voucherDate: date,
              type: receipt ? "RECEIPT" : "PAYMENT",
              entryType: d.entryType,
              partyId: d.partyId,
              bankPartyId: d.bankPartyId,
              amount: d.amount,
              netAmount: d.amount,
              remarks: `${label}${d.remarks ? " — " + d.remarks : ""}`,
            },
          });
          await reverseLedger(tx, "VOUCHER", voucherId);
        }
        await audit(tx, session, {
          entity: "FinanceTxn",
          entityId: id,
          action: "UPDATE",
          before,
          after: updated,
        });
      } else {
        voucherNo = await nextDocNumber(tx, {
          tenantId: session.tenantId,
          firmId: session.firmId,
          fyId: session.fyId,
          docType: receipt ? "VOUCHER_RECEIPT" : "VOUCHER_PAYMENT",
        });
        const voucher = await tx.voucher.create({
          data: {
            tenantId: session.tenantId,
            firmId: session.firmId,
            fyId: session.fyId,
            voucherNo,
            voucherDate: date,
            type: receipt ? "RECEIPT" : "PAYMENT",
            entryType: d.entryType,
            moduleLink: "OTHERS",
            partyId: d.partyId,
            bankPartyId: d.bankPartyId,
            amount: d.amount,
            netAmount: d.amount,
            remarks: `${label}${d.remarks ? " — " + d.remarks : ""}`,
            createdById: session.userId,
          },
        });
        voucherId = voucher.id;
        const created = await tx.financeTxn.create({
          data: {
            tenantId: session.tenantId,
            firmId: session.firmId,
            fyId: session.fyId,
            voucherNo,
            date,
            direction: d.direction,
            txnType: d.txnType,
            partyId: d.partyId,
            amount: d.amount,
            entryType: d.entryType,
            bankPartyId: d.bankPartyId,
            voucherId: voucher.id,
            remarks: d.remarks || null,
            createdById: session.userId,
          },
        });
        id = created.id;
        await audit(tx, session, {
          entity: "FinanceTxn",
          entityId: id,
          action: "CREATE",
          after: created,
        });
      }

      if (voucherId) {
        const common = {
          date,
          refType: "VOUCHER",
          refId: voucherId,
          refNo: voucherNo,
          narration: `${label}${d.remarks ? " — " + d.remarks : ""}`,
        };
        await postLedger(tx, session, [
          {
            ...common,
            partyId: d.bankPartyId,
            side: receipt ? "DEBIT" : "CREDIT",
            amount: d.amount,
          },
          {
            ...common,
            partyId: d.partyId,
            side: receipt ? "CREDIT" : "DEBIT",
            amount: d.amount,
          },
        ]);
      }

      revalidatePath(REVALIDATE);
      revalidatePath("/accounts/vouchers/register");
      return { ok: true as const, voucherNo };
    });
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Save failed" };
  }
}

export async function deleteFinanceTxn(
  id: string
): Promise<{ ok: true } | { ok: false; error: string }> {
  const session = requireSession();
  if (session.role !== "ADMIN" && session.role !== "OWNER") {
    return { ok: false, error: "Only Admin/Owner may delete these entries" };
  }
  await authorize(session, "finance", "delete");
  try {
    await withTenant(session.tenantId, async (tx: Tx) => {
      const before = await tx.financeTxn.findFirstOrThrow({
        where: { id, firmId: session.firmId, fyId: session.fyId, deletedAt: null },
      });
      await tx.financeTxn.update({ where: { id }, data: { deletedAt: new Date() } });
      if (before.voucherId) {
        await tx.voucher.update({
          where: { id: before.voucherId },
          data: { deletedAt: new Date() },
        });
        await reverseLedger(tx, "VOUCHER", before.voucherId);
      }
      await audit(tx, session, { entity: "FinanceTxn", entityId: id, action: "DELETE", before });
    });
    revalidatePath(REVALIDATE);
    revalidatePath("/accounts/vouchers/register");
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Delete failed" };
  }
}
