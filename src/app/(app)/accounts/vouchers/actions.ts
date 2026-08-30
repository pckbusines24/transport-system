"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { Prisma, DocNumberType, VoucherType, ModuleLink } from "@prisma/client";
import { requireSession } from "@/lib/session";
import { withTenant, Tx } from "@/lib/db";
import { authorize } from "@/lib/authz";
import { audit } from "@/lib/audit";
import { assertDateInFy } from "@/lib/fy-guard";
import { syncSequenceTo } from "@/lib/sequences";
import { postLedger, reverseLedger, LedgerPostEntry } from "@/lib/ledger";
import { round2 } from "@/lib/calc/tds";
import { adjustmentsTotal, applyAdjustments, ensureAdjustmentHead } from "@/lib/adjust-engine";
import { tdsHead } from "@/lib/account-heads";
import {
  payableSettlement,
  refPositions,
  ALL_PAYABLE_REF_TYPES,
  ALL_RECEIVABLE_REF_TYPES,
} from "@/lib/settlement";
import {
  externallyRecoveredShortage,
  raiseShortage,
  recoverShortage,
  releaseShortage,
} from "@/lib/shortage";
import {
  applyManualAdvanceUses,
  listOpenAdvances,
  restoreAdvanceUses,
  type OpenAdvance,
} from "@/lib/party-advance";

const DOC_TYPE_BY_VOUCHER: Record<VoucherType, DocNumberType> = {
  RECEIPT: "VOUCHER_RECEIPT",
  PAYMENT: "VOUCHER_PAYMENT",
  CONTRA: "VOUCHER_CONTRA",
  JOURNAL: "VOUCHER_JOURNAL",
};

const adjustmentSchema = z.object({
  adjustmentType: z.string().min(1),
  referenceType: z.string().min(1),
  referenceNo: z.string().min(1, "Reference number is required for every adjustment"),
  referenceDate: z.string().nullish(),
  amount: z.number().min(0).default(0),
  remarks: z.string().nullish(),
});

// manual adjustment of a previously received/paid advance against this
// voucher's reference allocations
const advanceUseSchema = z.object({
  advanceId: z.string().min(1),
  amount: z.number().min(0).default(0),
});

const allocationSchema = z.object({
  refId: z.string().min(1),
  refNo: z.string().min(1),
  /** per-row module — set when the grid runs in "All modules" mode */
  refType: z
    .enum([
      "BILLING",
      "GST_BILLING",
      "FREIGHT_CHALLAN",
      "BROKER_ENTRY",
      "LORRY_HIRE",
      "CASH_MEMO",
      "OFFICE_EXPENSE",
      "OFFICE_INCOME",
      "STAFF_PAYROLL",
      "VEHICLE_EXPENSE",
      "STAFF_ADVANCE",
      "DRIVER_SETTLEMENT",
      "ADBLUE_PURCHASE",
    ])
    .nullish(),
  billAmt: z.number().min(0).default(0),
  tdsPct: z.number().min(0).default(0),
  tdsAmt: z.number().min(0).default(0),
  deduction: z.number().min(0).default(0),
  otherAmt: z.number().min(0).default(0),
  /** round-off may be negative — a little extra paid rather than knocked off,
   *  but it is a rounding, never a value channel */
  roundOff: z
    .number()
    .default(0)
    .refine((v) => Math.abs(v) <= 999.99, "Round-off cannot exceed ₹999.99 either way"),
  amount: z.number().min(0).default(0),
  remarks: z.string().nullish(),
});

const voucherSchema = z.object({
  id: z.string().nullish(),
  type: z.enum(["RECEIPT", "PAYMENT", "CONTRA", "JOURNAL"]),
  voucherNo: z.string().trim().min(1, "Voucher number is required"),
  voucherDate: z.string().min(1, "Date is required"), // ISO yyyy-mm-dd
  entryType: z.enum(["CASH", "BANK", "CARD", "CONTRA"]).default("CASH"),
  moduleLink: z
    .enum([
      "BILLING",
      "LORRY_HIRE",
      "BROKER_ENTRY",
      "FREIGHT_CHALLAN",
      "CASH_MEMO",
      "GST_BILLING",
      "LR_ENTRY",
      "OFFICE_EXPENSE",
      "OFFICE_INCOME",
      "STAFF_PAYROLL",
      "VEHICLE_EXPENSE",
      "STAFF_ADVANCE",
      "DRIVER_SETTLEMENT",
      "ADBLUE_PURCHASE",
      "OTHERS",
    ])
    .default("OTHERS"),
  partyId: z.string().nullish(),
  vehicleId: z.string().nullish(),
  accountHeadId: z.string().nullish(),
  ledgerPosting: z.enum(["PARTY", "VEHICLE", "BOTH"]).default("PARTY"),
  // journals may credit a ledger head instead of a party/bank account, so one
  // of the two is required rather than bankPartyId always
  bankPartyId: z.string().nullish(),
  creditHeadId: z.string().nullish(),
  chequeNo: z.string().nullish(),
  chequeDate: z.string().nullish(),
  // 0 is allowed only for a pure advance-adjustment receipt/payment — enforced
  // below, since journals/contras always move value
  amount: z.number().min(0),
  tdsAmt: z.number().min(0).default(0),
  deduction: z.number().min(0).default(0),
  otherAmt: z.number().min(0).default(0),
  remarks: z.string().nullish(),
  allocations: z.array(allocationSchema).default([]),
  // central adjustment engine lines (shared by receipt / payment / journal)
  adjustments: z.array(adjustmentSchema).default([]),
  // open party advances adjusted against this voucher's allocations
  advanceAdjustments: z.array(advanceUseSchema).default([]),
  // OPPOSITE-direction advances this voucher refunds: a payment returns an
  // advance RECEIVED from the party, a receipt takes back an advance PAID —
  // the money moved covers it and the advance closes, no mirror advance forms
  advanceRefunds: z.array(advanceUseSchema).default([]),
  // chalan-cancel advances this voucher recovers (receipt) or writes off
  // (journal against the broker's credit side)
  cancelAdvanceUses: z.array(advanceUseSchema).default([]),
});

export type SaveVoucherResult = { ok: true; id: string } | { ok: false; error: string };

function toDate(s: string): Date {
  return new Date(s.includes("T") ? s : `${s}T00:00:00`);
}

export async function saveVoucher(input: unknown): Promise<SaveVoucherResult> {
  const session = requireSession();
  const parsed = voucherSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid input" };
  }
  const data = parsed.data;
  await authorize(session, "vouchers", data.id ? "edit" : "create");

  if (data.type !== "CONTRA" && !data.partyId && !data.accountHeadId) {
    return { ok: false, error: "Party or Account Head is required" };
  }
  if (data.type === "CONTRA" && !data.partyId) {
    return { ok: false, error: "Counter Bank/Cash account is required for contra" };
  }
  // A journal adjusts any two ledgers: either side may be a party, a bank/cash
  // account or an income/expense head, so each side only has to be SOMETHING.
  if (data.type === "JOURNAL" && !data.partyId && !data.accountHeadId) {
    return { ok: false, error: "Debit ledger is required for a journal voucher" };
  }
  if (data.type === "JOURNAL" && !data.bankPartyId && !data.creditHeadId) {
    return { ok: false, error: "Credit ledger is required for a journal voucher" };
  }
  if (data.type !== "JOURNAL" && !data.bankPartyId) {
    return { ok: false, error: "Bank/Cash account is required" };
  }
  if (
    data.type === "JOURNAL" &&
    ((data.partyId && data.partyId === data.bankPartyId) ||
      (data.accountHeadId && data.accountHeadId === data.creditHeadId))
  ) {
    return { ok: false, error: "Debit and credit ledgers must be different" };
  }
  if (data.type === "CONTRA" && data.adjustments.length > 0) {
    return { ok: false, error: "Adjustments are not applicable on contra vouchers" };
  }

  // never trust client totals — adjustments reduce the net like deductions
  const adjTotal = adjustmentsTotal(data.adjustments);
  const netAmount = round2(
    data.amount - data.tdsAmt - data.deduction + data.otherAmt - adjTotal
  );
  const isMoneyType = data.type === "RECEIPT" || data.type === "PAYMENT";
  const advanceKind = data.type === "RECEIPT" ? "RECEIVED" : "PAID";
  const advUseTotal = round2(
    data.advanceAdjustments.reduce((s, a) => s + a.amount, 0)
  );
  if (advUseTotal > 0.009 && (!isMoneyType || !data.partyId || data.accountHeadId)) {
    return {
      ok: false,
      error: "Advance adjustment is only available on receipt/payment vouchers against a party",
    };
  }
  // refunds run OPPOSITE to the voucher direction: payment refunds a RECEIVED
  // advance, receipt takes back a PAID one
  const refundKind = data.type === "RECEIPT" ? "PAID" : "RECEIVED";
  const refundTotal = round2(data.advanceRefunds.reduce((s, a) => s + a.amount, 0));
  if (refundTotal > 0.009 && (!isMoneyType || !data.partyId || data.accountHeadId)) {
    return {
      ok: false,
      error: "Advance refund is only available on receipt/payment vouchers against a party",
    };
  }
  const cancelUseTotal = round2(data.cancelAdvanceUses.reduce((s, a) => s + a.amount, 0));
  if (cancelUseTotal > 0.009) {
    if (data.type === "RECEIPT") {
      if (!data.partyId)
        return { ok: false, error: "Party is required to recover cancel advances" };
    } else if (data.type === "JOURNAL") {
      if (!data.bankPartyId)
        return {
          ok: false,
          error: "The credit side must be the broker party to write off a cancel advance",
        };
    } else {
      return {
        ok: false,
        error: "Cancel-advance recovery is only available on receipt or journal vouchers",
      };
    }
  }
  const pureAdvanceAdjust = isMoneyType && advUseTotal > 0.009;
  // a receipt/payment may also move no money when the selected references are
  // settled purely by TDS / shortage / other deduction / round-off — the party
  // is settled gross against the deduction heads and the bank leg drops out
  const allocAdjustSettle = round2(
    data.allocations.reduce((s, a) => s + a.tdsAmt + a.deduction + a.otherAmt + a.roundOff, 0)
  );
  const pureDeductionSettle = isMoneyType && allocAdjustSettle > 0.009;
  if (data.amount <= 0 && !pureAdvanceAdjust && !pureDeductionSettle) {
    return { ok: false, error: "Amount is required" };
  }
  if (netAmount < 0) {
    return { ok: false, error: "Deductions + adjustments exceed the voucher amount" };
  }
  if (netAmount <= 0 && data.type !== "JOURNAL" && !pureAdvanceAdjust && !pureDeductionSettle) {
    return { ok: false, error: "Net amount must be positive" };
  }
  // Header figures and allocation rows must tell the same story: the ledger
  // posts TDS/deductions from the HEADER while settlement reads the ROWS — a
  // crafted payload that differs between the two would mark documents settled
  // for money the ledger never saw (or vice versa). Header-only TDS with no
  // row TDS stays allowed (the "direct TDS" entry).
  if (data.type !== "CONTRA" && data.allocations.length) {
    const rowTds = round2(data.allocations.reduce((s, a) => s + a.tdsAmt, 0));
    const rowDed = round2(data.allocations.reduce((s, a) => s + a.deduction + a.otherAmt, 0));
    if (rowTds > 0.009 && Math.abs(round2(data.tdsAmt) - rowTds) > 0.02) {
      return {
        ok: false,
        error: `Header TDS (${data.tdsAmt}) must equal the TDS on the allocation rows (${rowTds}).`,
      };
    }
    // Row deductions (shortage + other ded.) are funded by the HEADER
    // deduction ALONE — the entry screen folds both into it. Header otherAmt
    // is the OPPOSITE concept (charges ADDED to the net) and must never stand
    // in for a row deduction: the poster would clamp its Shortage leg to zero
    // and commit more credit than debit. Validating the two header fields
    // separately keeps the DR and CR the poster produces equal for every
    // accepted payload.
    if (rowDed > 0.009 && Math.abs(round2(data.deduction) - rowDed) > 0.02) {
      return {
        ok: false,
        error: `Header deduction (${round2(data.deduction)}) must equal the shortage + other deductions on the allocation rows (${rowDed}).`,
      };
    }
  }

  // two operators prefill the same next number: retry a create with a bumped
  // number instead of failing on the unique constraint (edits never renumber)
  const maxAttempts = data.id ? 1 : 3;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
  try {
    const id = await withTenant(session.tenantId, async (tx) => {
      const voucherDate = toDate(data.voucherDate);
      // an edit stays in the voucher's own financial year — its date, ledger
      // legs, shortage entries and advance rows all keep that year's stamp;
      // only a fresh voucher belongs to the session FY (FY continuity)
      const docFyId = data.id
        ? ((
            await tx.voucher.findFirst({
              where: { id: data.id, firmId: session.firmId },
              select: { fyId: true },
            })
          )?.fyId ?? session.fyId)
        : session.fyId;
      const docSession = { ...session, fyId: docFyId };
      // wrong-FY guard: the date must belong to the document's own FY
      await assertDateInFy(tx, { fyId: docFyId }, voucherDate, "voucher entry");
      const base = {
        voucherNo: data.voucherNo,
        voucherDate,
        type: data.type as VoucherType,
        entryType: data.entryType,
        moduleLink: data.moduleLink as ModuleLink,
        partyId: data.partyId || null,
        vehicleId: data.vehicleId || null,
        accountHeadId: data.accountHeadId || null,
        ledgerPosting: data.ledgerPosting,
        bankPartyId: data.bankPartyId || null,
        creditHeadId: data.creditHeadId || null,
        chequeNo: data.chequeNo || null,
        chequeDate: data.chequeDate ? toDate(data.chequeDate) : null,
        amount: data.amount,
        tdsAmt: data.tdsAmt,
        deduction: data.deduction,
        otherAmt: data.otherAmt,
        netAmount,
        remarks: data.remarks || null,
      };
      const allocations = data.allocations.map((a) => ({
        tenantId: session.tenantId,
        refType: (a.refType ?? data.moduleLink) as ModuleLink,
        refId: a.refId,
        refNo: a.refNo,
        billAmt: a.billAmt,
        tdsPct: a.tdsPct,
        tdsAmt: a.tdsAmt,
        deduction: a.deduction,
        otherAmt: a.otherAmt,
        roundOff: a.roundOff,
        amount: a.amount,
        remarks: a.remarks || null,
      }));

      // ---- validation: never over-settle, never allocate beyond the money
      // moved (net amount = header amount − TDS − deductions)
      const allocatedSum = round2(data.allocations.reduce((s, a) => s + a.amount, 0));
      // refunds consume the money moved too — allocations and refunds together
      // can never exceed what the voucher funds
      if (round2(allocatedSum + refundTotal) > round2(netAmount + advUseTotal) + 0.01) {
        throw new Error(
          `Allocated ${allocatedSum}${refundTotal > 0 ? ` plus advance refund ${refundTotal}` : ""} exceeds the received/paid amount ${netAmount}` +
            (advUseTotal > 0 ? ` plus advance adjusted ${advUseTotal}.` : ".")
        );
      }
      // an adjusted advance exists only to settle references — it cannot turn
      // into unallocated money (that would silently convert one advance into
      // another and desync the reference trail)
      if (advUseTotal > allocatedSum + 0.01) {
        throw new Error(
          `Advance adjusted ${advUseTotal} exceeds the ${allocatedSum} allocated to references — allocate the adjusted amount against pending references.`
        );
      }
      {
        const byType = new Map<ModuleLink, typeof data.allocations>();
        for (const a of data.allocations) {
          const t = (a.refType ?? data.moduleLink) as ModuleLink;
          byType.set(t, [...(byType.get(t) ?? []), a]);
        }
        for (const [refType, rows] of Array.from(byType.entries())) {
          const refIds = rows.map((r) => r.refId);
          const already = await allocatedByRef(
            tx,
            { firmId: session.firmId, fyId: session.fyId },
            refType,
            refIds,
            data.id
          );
          // gross document value per ref, per module — scoped to THIS firm and
          // live rows only (no FY filter: a carried document from an earlier
          // year is settleable here; the exact ids keep the lookup precise)
          const docScope = { id: { in: refIds }, firmId: session.firmId, deletedAt: null };
          const gross = new Map<string, number>();
          if (refType === "BILLING" || refType === "GST_BILLING") {
            const invs = await tx.invoice.findMany({ where: docScope });
            // ceiling = the SAME base the Outstanding register settles against:
            // netTotal (GST included) less the advance — grandTotal excluded
            // the GST, so a GST bill could never be settled in full
            invs.forEach((i) => gross.set(i.id, round2(Number(i.netTotal) - Number(i.advance))));
          } else if (refType === "FREIGHT_CHALLAN") {
            // net off what the chalan's own balance-payment screen already
            // settled, else the voucher could pay the same balance twice
            const cs = await tx.chalan.findMany({ where: { ...docScope, cancelledAt: null } });
            cs.forEach((c) =>
              gross.set(
                c.id,
                round2(
                  Number(c.balance) -
                    Number(c.balPaidAmount) -
                    Number(c.balShortage) -
                    Number(c.balRoundOff) -
                    Number(c.balAdvanceAdjusted)
                )
              )
            );
          } else if (refType === "BROKER_ENTRY") {
            const ss = await tx.brokerSlip.findMany({ where: docScope });
            ss.forEach((s) =>
              gross.set(
                s.id,
                round2(
                  Number(s.vBalance) -
                    Number(s.vPaidAmount) -
                    Number(s.vShortage) -
                    Number(s.vRoundOff)
                )
              )
            );
          } else if (refType === "LORRY_HIRE") {
            const hs = await tx.hireSlip.findMany({ where: docScope });
            hs.forEach((h) => gross.set(h.id, Number(h.balance)));
          } else if (refType === "CASH_MEMO") {
            const ds = await tx.delivery.findMany({ where: docScope });
            ds.forEach((d2) => gross.set(d2.id, Number(d2.total)));
          } else if (refType === "OFFICE_EXPENSE" || refType === "OFFICE_INCOME") {
            const ots = await tx.officeTransaction.findMany({ where: docScope });
            ots.forEach((o) =>
              // an entry already paid at source has nothing left to settle, so
              // its ceiling is zero rather than its amount
              gross.set(o.id, o.paymentMode ? 0 : Number(o.amount))
            );
          } else if (refType === "STAFF_PAYROLL") {
            const sal = await tx.staffSalary.findMany({ where: docScope });
            sal.forEach((s) =>
              gross.set(s.id, round2(Number(s.netSalary) - Number(s.paidAmount)))
            );
          } else if (refType === "VEHICLE_EXPENSE") {
            const vex = await tx.vehicleExpenseVoucher.findMany({ where: docScope });
            // paid at entry = the money already moved; nothing left to settle
            vex.forEach((v) => gross.set(v.id, v.paymentMode ? 0 : Number(v.amount)));
          } else if (refType === "STAFF_ADVANCE") {
            const advs = await tx.staffAdvance.findMany({ where: docScope });
            const recovered = await tx.staffSalary.groupBy({
              by: ["advanceId"],
              where: { advanceId: { in: refIds }, deletedAt: null },
              _sum: { advanceRecovery: true },
            });
            const byAdvance = new Map(
              recovered.map((r) => [r.advanceId ?? "", Number(r._sum.advanceRecovery ?? 0)])
            );
            // what payroll already recovered cannot be received again in cash
            advs.forEach((a) =>
              gross.set(a.id, round2(Number(a.amount) - (byAdvance.get(a.id) ?? 0)))
            );
          } else if (refType === "ADBLUE_PURCHASE") {
            const refills = await tx.adblueTxn.findMany({ where: docScope });
            // unbilled stock owes nothing yet, and a refill paid at entry is done
            refills.forEach((r) =>
              gross.set(r.id, r.billNo && !r.paymentMode ? Number(r.amount) : 0)
            );
          } else if (refType === "DRIVER_SETTLEMENT") {
            const sets = await tx.driverSettlement.findMany({ where: docScope });
            // settling from the driver-settlement screen creates its own voucher
            // and marks the row SETTLED — it must not be payable twice. The
            // SIGN carries the direction: a positive row (company owes the
            // driver) is settleable only by a PAYMENT, a negative row (the
            // driver owes) only by a RECEIPT — a payment must never "pay out"
            // a recovery.
            sets.forEach((s) => {
              const amt = Number(s.amount);
              const directionOk =
                (data.type === "PAYMENT" && amt > 0) || (data.type === "RECEIPT" && amt < 0);
              gross.set(s.id, s.status === "SETTLED" || !directionOk ? 0 : Math.abs(amt));
            });
          }
          // a handled refType whose document did not survive the scoped lookup
          // is a stale / deleted / foreign reference — never an open ceiling
          const scopedTypes: ModuleLink[] = [
            "BILLING", "GST_BILLING", "FREIGHT_CHALLAN", "BROKER_ENTRY", "LORRY_HIRE",
            "CASH_MEMO", "OFFICE_EXPENSE", "OFFICE_INCOME", "STAFF_PAYROLL",
            "VEHICLE_EXPENSE", "STAFF_ADVANCE", "ADBLUE_PURCHASE", "DRIVER_SETTLEMENT",
          ];
          if (scopedTypes.includes(refType)) {
            for (const r of rows) {
              if (!gross.has(r.refId)) {
                throw new Error(
                  `Ref ${r.refNo}: document not found in this firm/financial year (it may be deleted) — refresh and retry.`
                );
              }
            }
          }
          // aggregate PER REFERENCE before checking: two rows against the same
          // document must not each pass the ceiling individually
          const settlePerRef = new Map<string, number>();
          for (const r of rows) {
            settlePerRef.set(
              r.refId,
              round2(
                (settlePerRef.get(r.refId) ?? 0) +
                  r.amount + r.tdsAmt + r.deduction + r.otherAmt + r.roundOff
              )
            );
          }
          for (const [refId, settle] of Array.from(settlePerRef.entries())) {
            const refNo = rows.find((r) => r.refId === refId)?.refNo ?? refId;
            const pending = round2((gross.get(refId) ?? Infinity) - (already.get(refId) ?? 0));
            if (settle > pending + 0.01) {
              throw new Error(
                `Ref ${refNo}: adjustment ${settle} exceeds the pending amount ${pending}. Duplicate or over-settlement is not allowed.`
              );
            }
          }
        }
      }

      let savedId: string;
      // the previous save's shortage-relevant figures (edit path) — decide
      // below whether the raised shortage entry must be torn down or kept
      let prevRowShortage = 0;
      let prevShortageMode: "RAISE" | "RECOVER" | null = null;
      let prevShortagePartyId: string | null = null;
      if (data.id) {
        // scoped to the session's firm/FY: reversing and re-posting under the
        // wrong scope would silently migrate accounting across firms/years
        const before = await tx.voucher.findFirst({
          where: { id: data.id, firmId: session.firmId },
          include: { allocations: true },
        });
        if (!before) throw new Error("Voucher not found in this firm");
        if (before.deletedAt) throw new Error("Voucher has been deleted");
        // auto-created settlement vouchers are delete-and-redo only: their
        // header semantics and document sync live in the chalan/slip actions,
        // and a register edit would silently desync both
        if (
          before.allocations.some(
            (a) =>
              a.remarks === "CHALAN_BAL_SETTLEMENT" ||
              a.remarks === "BROKER_SLIP_P_SETTLEMENT" ||
              a.remarks === "BROKER_SLIP_V_SETTLEMENT"
          )
        ) {
          throw new Error(
            "This is a chalan/broker-slip settlement voucher — DELETE it here and settle again from the document; it cannot be edited from the register."
          );
        }
        prevRowShortage = round2(
          before.allocations.reduce((s, a) => s + Number(a.deduction), 0)
        );
        prevShortagePartyId = before.partyId;
        prevShortageMode =
          prevRowShortage > 0.009 && before.partyId
            ? before.type === "PAYMENT"
              ? "RECOVER"
              : before.type === "RECEIPT"
                ? "RAISE"
                : null
            : null;
        await tx.voucherAllocation.deleteMany({ where: { voucherId: data.id } });
        const updated = await tx.voucher.update({
          where: { id: data.id },
          data: { ...base, allocations: { create: allocations } },
          include: { allocations: true },
        });
        savedId = updated.id;
        await reverseLedger(tx, "VOUCHER", savedId);
        await audit(tx, session, {
          entity: "Voucher",
          entityId: savedId,
          action: "UPDATE",
          before,
          after: updated,
        });
      } else {
        const created = await tx.voucher.create({
          data: {
            tenantId: session.tenantId,
            firmId: session.firmId,
            fyId: session.fyId,
            createdById: session.userId,
            ...base,
            allocations: { create: allocations },
          },
          include: { allocations: true },
        });
        savedId = created.id;
        await audit(tx, session, {
          entity: "Voucher",
          entityId: savedId,
          action: "CREATE",
          after: created,
        });
      }

      // ---- ledger posting (central adjustment engine) ----
      const narration =
        data.remarks || `${data.type} voucher ${data.voucherNo} (${data.moduleLink})`;
      // Reference No carries the ORIGINAL document reference (bill / invoice /
      // chalan / slip no from the allocations) so the whole lifecycle of a
      // document can be traced by one reference; the voucher number stays
      // available via refId -> voucher lookup (shown as its own column).
      const allocRefNos = Array.from(new Set(data.allocations.map((a) => a.refNo).filter(Boolean)));
      const docRefNo = allocRefNos.length ? allocRefNos.join(", ") : data.voucherNo;
      const common = {
        date: voucherDate,
        refType: "VOUCHER",
        refId: savedId,
        refNo: docRefNo,
        narration,
      };
      const entries: LedgerPostEntry[] = [];
      // bank/cash (or journal credit account) side: Receipt -> money in (DEBIT
      // bank), Payment -> money out (CREDIT bank). Journal -> CREDIT the
      // counter account (no cash/bank movement semantics). Contra -> DEBIT
      // destination bank, CREDIT source party.
      const bankSide = data.type === "PAYMENT" || data.type === "JOURNAL" ? "CREDIT" : "DEBIT";
      const counterSide = bankSide === "CREDIT" ? "DEBIT" : "CREDIT";
      // a journal may credit a ledger head instead of a bank/cash party
      entries.push({
        ...common,
        partyId: data.creditHeadId ? null : data.bankPartyId,
        accountHeadId: data.creditHeadId || null,
        side: bankSide,
        amount: netAmount,
      });

      const postParty = data.ledgerPosting === "PARTY" || data.ledgerPosting === "BOTH";
      const postVehicle = data.ledgerPosting === "VEHICLE" || data.ledgerPosting === "BOTH";
      if (data.type === "CONTRA") {
        entries.push({ ...common, partyId: data.partyId, side: counterSide, amount: netAmount });
      } else {
        // Header deductions post to the COMMON ledger head for each concept —
        // TDS to the statutory payable/receivable ledger (never a "TDS
        // Adjustment" head), shortage to the one Shortage ledger the chalan
        // and broker slip also use.
        //
        // TWO fixes live here:
        //  1. The shortage REGISTER (recoverShortage/raiseShortage below)
        //     posts the single Shortage-head leg for money vouchers against a
        //     party. Posting it from the header TOO doubled the Shortage head
        //     and broke the trial balance by exactly the shortage — only the
        //     remainder the register will NOT record posts directly.
        //  2. A per-row "Other Ded." is a deduction that belongs to the Other
        //     Charges ledger — it used to be misfiled under Shortage because
        //     the entry screen folds it into the header deduction.
        const rowShortage = round2(data.allocations.reduce((s, a) => s + a.deduction, 0));
        const rowOther = round2(data.allocations.reduce((s, a) => s + a.otherAmt, 0));
        const registeredShortage =
          data.partyId && (data.type === "PAYMENT" || data.type === "RECEIPT")
            ? rowShortage
            : 0;
        const directShortage = round2(
          Math.max(0, data.deduction - rowOther - registeredShortage)
        );
        const totalShortage = round2(registeredShortage + directShortage);

        // the party is settled for the GROSS amount — deductions and
        // adjustments are posted to their own heads so nothing stays
        // outstanding against the party. The party/vehicle ledger shows the
        // settlement the way the voucher was typed: the money portion plus
        // each deduction as its own labelled line (like Round Off below).
        // The lines sum to the same gross, so balances never change.
        const vLabel = `${data.type.toLowerCase()} voucher ${data.voucherNo}`;
        const grossBreakup: { amount: number; narration: string }[] = (() => {
          const main = round2(data.amount - data.tdsAmt - totalShortage - rowOther);
          if (main < 0 || (data.tdsAmt <= 0 && totalShortage <= 0 && rowOther <= 0)) {
            return [{ amount: data.amount, narration }];
          }
          const parts: { amount: number; narration: string }[] = [];
          if (main > 0) parts.push({ amount: main, narration });
          if (data.tdsAmt > 0)
            parts.push({ amount: round2(data.tdsAmt), narration: `TDS deducted — ${vLabel}` });
          if (totalShortage > 0)
            parts.push({ amount: totalShortage, narration: `Shortage — ${vLabel}` });
          if (rowOther > 0)
            parts.push({ amount: rowOther, narration: `Other deduction — ${vLabel}` });
          return parts;
        })();
        if (postParty && (data.partyId || data.accountHeadId)) {
          for (const part of grossBreakup) {
            entries.push({
              ...common,
              partyId: data.partyId || null,
              accountHeadId: data.partyId ? null : data.accountHeadId,
              side: counterSide,
              amount: part.amount,
              narration: part.narration,
            });
          }
        }
        if (postVehicle && data.vehicleId) {
          for (const part of grossBreakup) {
            entries.push({
              ...common,
              vehicleId: data.vehicleId,
              side: counterSide,
              amount: part.amount,
              narration: part.narration,
            });
          }
        }
        const legacy: [string, number, "bank" | "counter"][] = [
          [tdsHead(data.type), data.tdsAmt, "bank"],
          ["Shortage", directShortage, "bank"],
          // row-level other deductions reduce what moves — deduction side
          ["Other Charges", rowOther, "bank"],
          // header otherAmt is the opposite concept: charges ADDED to the net
          ["Other Charges", data.otherAmt, "counter"],
        ];
        for (const [name, amt, dir] of legacy) {
          if (amt > 0) {
            const headId = await ensureAdjustmentHead(tx, session.tenantId, name, data.type);
            entries.push({
              ...common,
              accountHeadId: headId,
              side: dir === "bank" ? bankSide : counterSide,
              amount: round2(amt),
              narration: `${name} on ${data.type.toLowerCase()} voucher ${data.voucherNo}`,
            });
          }
        }
        // Per-allocation round-off settles the reference and posts here — and
        // ONLY here. The header amount/deduction sent by the entry screen
        // exclude it, so this pair is the single posting of the rounding:
        // party (or vehicle) leg settles the counter ledger for it, the mirror
        // leg goes to the one common Round Off head. Knocked off the
        // payable/receivable => Round Off income, added to it (a negative
        // round-off) => Round Off expense, same head either way.
        const allocRoundOff = round2(data.allocations.reduce((s, a) => s + a.roundOff, 0));
        if (Math.abs(allocRoundOff) > 0.009) {
          const amount = Math.abs(allocRoundOff);
          const partySide = allocRoundOff > 0 ? counterSide : bankSide;
          const headSide = allocRoundOff > 0 ? bankSide : counterSide;
          const roNarration = `Round off on ${data.type.toLowerCase()} voucher ${data.voucherNo}`;
          // the counter leg lands wherever the main gross leg went, so the
          // rounding can never strand a ledger this voucher does not post to
          const counterLegs: LedgerPostEntry[] = [];
          if (postParty && (data.partyId || data.accountHeadId)) {
            counterLegs.push({
              ...common,
              partyId: data.partyId || null,
              accountHeadId: data.partyId ? null : data.accountHeadId,
              side: partySide,
              amount,
              narration: roNarration,
            });
          }
          if (postVehicle && data.vehicleId) {
            counterLegs.push({
              ...common,
              vehicleId: data.vehicleId,
              side: partySide,
              amount,
              narration: roNarration,
            });
          }
          if (counterLegs.length) {
            const headId = await ensureAdjustmentHead(tx, session.tenantId, "Round Off", data.type);
            entries.push(...counterLegs, {
              ...common,
              accountHeadId: headId,
              side: headSide,
              amount,
              narration: roNarration,
            });
          }
        }
      }

      // reference-based adjustment lines — persisted + posted by the engine
      const { entries: adjEntries } = await applyAdjustments(tx, session, {
        voucherId: savedId,
        voucherNo: data.voucherNo,
        voucherType: data.type,
        voucherDate,
        lines: data.type === "CONTRA" ? [] : data.adjustments,
      });
      entries.push(...adjEntries);

      // a pure advance-adjustment voucher moves no money, so zero-value legs
      // (bank/party) are dropped rather than posted
      // docSession: an old voucher's re-posted legs stay stamped in ITS year
      await postLedger(tx, docSession, entries.filter((e) => e.amount > 0.009));

      // Per-reference shortage on a voucher allocation. A PAYMENT deducts it
      // from what we hand over, so it is RECOVERED; a RECEIPT means the party
      // paid us less, so the company bears it — an EXPENSE. Those are the only
      // two voucher cases that touch the shortage ledger.
      // The register's single Shortage-head leg IS the posting for this
      // shortage — the header block above deliberately leaves it out (posting
      // both doubled the head and unbalanced the books).
      const allocShortage = round2(
        data.allocations.reduce((s, a) => s + a.deduction, 0)
      );
      const shortageMode: "RAISE" | "RECOVER" | null =
        allocShortage > 0.009 && data.partyId
          ? data.type === "PAYMENT"
            ? "RECOVER"
            : data.type === "RECEIPT"
              ? "RAISE"
              : null
          : null;
      // Releasing on EVERY save soft-deleted the raised entry and defeated
      // raiseShortage's idempotent reuse — an edit silently reset recoveries
      // other documents had already booked against it. Tear down only when
      // the shortage-relevant figures actually changed; an unchanged save
      // reuses the existing entry (recoveries intact) via raiseShortage /
      // recoverShortage themselves. A change that would orphan recoveries
      // from OTHER documents is blocked instead.
      const shortageChanged =
        prevShortageMode !== shortageMode ||
        prevShortagePartyId !== (data.partyId || null) ||
        Math.abs(prevRowShortage - allocShortage) > 0.009;
      if (data.id && shortageChanged) {
        const extRecovered = await externallyRecoveredShortage(tx, "VOUCHER", savedId);
        if (extRecovered > 0.009) {
          throw new Error(
            "The shortage raised by this voucher already has recoveries booked from other documents — release those recoveries first."
          );
        }
        await releaseShortage(tx, "VOUCHER", savedId);
      }
      if (shortageMode) {
        const refNos = Array.from(new Set(data.allocations.filter((a) => a.deduction > 0).map((a) => a.refNo)));
        const shortageArgs = {
          date: voucherDate,
          module: "VOUCHER" as const,
          refId: savedId,
          refNo: refNos.join(", ") || data.voucherNo,
          partyId: data.partyId,
          partyKind: "PARTY" as const,
          amount: allocShortage,
          remarks: `${data.type === "PAYMENT" ? "Deducted on" : "Short received against"} voucher ${data.voucherNo}`,
        };
        if (data.type === "PAYMENT") {
          await recoverShortage(tx, docSession, { ...shortageArgs, source: "PARTY" });
        } else {
          await raiseShortage(tx, docSession, shortageArgs);
        }
      }

      await syncSequenceTo(tx, {
        tenantId: session.tenantId,
        firmId: session.firmId,
        fyId: session.fyId,
        docType: DOC_TYPE_BY_VOUCHER[data.type as VoucherType],
        savedNumber: data.voucherNo,
      });

      // ---- manual advance adjustment (previously received/paid advances
      // consumed against this voucher's reference allocations) ----
      // Release whatever this voucher consumed before (edit path), then apply
      // the requested lines — each validated against the advance's live open
      // balance, party and direction inside the same transaction.
      await restoreAdvanceUses(tx, "VOUCHER", savedId);
      // chalan-cancel recoveries: only THAT party's open CHALAN_CANCEL
      // advances qualify (receipt = money back, journal = bad-debt write-off)
      const cancelLines = data.cancelAdvanceUses.filter((l) => l.amount > 0.009);
      const cancelParty = data.type === "JOURNAL" ? data.bankPartyId : data.partyId;
      if (cancelLines.length) {
        const advs = await tx.partyAdvance.findMany({
          where: { id: { in: cancelLines.map((l) => l.advanceId) }, deletedAt: null },
        });
        for (const l of cancelLines) {
          const adv = advs.find((a) => a.id === l.advanceId);
          if (!adv || adv.partyId !== cancelParty || adv.source !== "CHALAN_CANCEL" || adv.kind !== "PAID") {
            throw new Error("Only this party's open chalan-cancel advances can be recovered here");
          }
        }
      }
      if (advUseTotal > 0.009 && data.partyId) {
        const own = await tx.partyAdvance.findFirst({
          where: {
            voucherId: savedId,
            id: { in: data.advanceAdjustments.map((l) => l.advanceId) },
          },
        });
        if (own) throw new Error("A voucher cannot adjust the advance it created itself.");
        // direction check that the kinds param used to enforce
        const adjAdvs = await tx.partyAdvance.findMany({
          where: { id: { in: data.advanceAdjustments.map((l) => l.advanceId) } },
        });
        for (const a of adjAdvs) {
          if (a.kind !== advanceKind) {
            throw new Error(
              `Voucher ${a.voucherNo ?? a.id} is an advance ${a.kind.toLowerCase()} and cannot be adjusted here`
            );
          }
          // a cancellation recovery is not an ordinary advance — it closes
          // only through the Recover Cancel Advances flow, never this grid
          if (a.source === "CHALAN_CANCEL") {
            throw new Error(
              "Chalan-cancel advances close through the Recover Cancel Advances section, not the Adjust Advance grid"
            );
          }
        }
      }
      // ---- advance refund: the opposite-direction advance is returned in
      // cash — its balance closes against this voucher's money, and the
      // refunded portion never becomes a mirror advance
      const refundLines = data.advanceRefunds.filter((l) => l.amount > 0.009);
      if (refundTotal > 0.009 && data.partyId) {
        const ownRefund = await tx.partyAdvance.findFirst({
          where: { voucherId: savedId, id: { in: refundLines.map((l) => l.advanceId) } },
        });
        if (ownRefund) throw new Error("A voucher cannot refund the advance it created itself.");
        const refAdvs = await tx.partyAdvance.findMany({
          where: { id: { in: refundLines.map((l) => l.advanceId) } },
        });
        for (const a of refAdvs) {
          if (a.kind !== refundKind) {
            throw new Error(
              `Voucher ${a.voucherNo ?? a.id} is an advance ${a.kind.toLowerCase()} — it cannot be refunded on a ${data.type.toLowerCase()} voucher`
            );
          }
          if (a.source === "CHALAN_CANCEL") {
            throw new Error(
              "Chalan-cancel advances close through the Recover Cancel Advances section, not as a refund"
            );
          }
        }
      }
      // one combined apply per voucher (the helper releases prior uses itself,
      // so it must never run twice for the same voucher)
      const moneyLines = [
        ...(advUseTotal > 0.009 && data.partyId ? data.advanceAdjustments : []),
        ...(refundTotal > 0.009 && data.partyId ? refundLines : []),
        ...(data.type === "RECEIPT" ? cancelLines : []),
      ];
      if (moneyLines.length && data.partyId) {
        await applyManualAdvanceUses(tx, {
          tenantId: session.tenantId,
          firmId: session.firmId,
          fyId: docFyId,
          partyId: data.partyId,
          refType: "VOUCHER",
          refId: savedId,
          // carry the settled document references, so the Advance Register's
          // "Used Against" reads "SBRL/001" rather than a bare voucher number
          refNo: docRefNo,
          date: voucherDate,
          lines: moneyLines,
        });
      } else if (data.type === "JOURNAL" && cancelLines.length && data.bankPartyId) {
        await applyManualAdvanceUses(tx, {
          tenantId: session.tenantId,
          firmId: session.firmId,
          fyId: docFyId,
          partyId: data.bankPartyId,
          refType: "VOUCHER",
          refId: savedId,
          refNo: docRefNo,
          date: voucherDate,
          lines: cancelLines,
        });
      }

      // an auto-advance that other documents already consumed is anchored to
      // its party and direction — an edit must never migrate it to another
      // party or flip it by changing the voucher type
      if (data.id) {
        const priorAdv = await tx.partyAdvance.findFirst({
          where: { voucherId: savedId, deletedAt: null },
        });
        if (
          priorAdv &&
          Number(priorAdv.consumedAmount) > 0.009 &&
          (!isMoneyType ||
            priorAdv.kind !== advanceKind ||
            priorAdv.partyId !== (data.partyId || null))
        ) {
          throw new Error(
            "The advance created by this voucher is already adjusted against bills — its party and voucher type cannot change. Remove those adjustments first."
          );
        }
      }

      // ---- automatic party advance (receive-as-advance / over-payment /
      // advance-payment / over-payment on payables) ----
      // Any unallocated remainder of a party receipt OR payment becomes an
      // advance balance for that party — no second voucher is ever needed.
      if ((data.type === "RECEIPT" || data.type === "PAYMENT") && data.partyId && !data.accountHeadId) {
        // advance = money moved that no reference consumed; allocations funded
        // by adjusted advances are not this voucher's money, and money that
        // recovered a cancel advance is spoken for too
        if (data.type === "RECEIPT" && cancelUseTotal > 0.009) {
          if (
            round2(allocatedSum + cancelUseTotal + refundTotal) >
            round2(netAmount + advUseTotal) + 0.01
          ) {
            throw new Error(
              "Cancel-advance recovery plus allocations and refunds exceed the money received"
            );
          }
        }
        // money that refunded an opposite advance is spoken for — it must
        // never re-emerge as a new advance of this voucher's own direction
        const unallocated = round2(
          netAmount + advUseTotal - allocatedSum - cancelUseTotal - refundTotal
        );
        const existingAdv = await tx.partyAdvance.findFirst({
          where: { voucherId: savedId, deletedAt: null },
        });
        if (unallocated > 0.009) {
          if (existingAdv) {
            if (Number(existingAdv.consumedAmount) > unallocated + 0.01) {
              throw new Error(
                `Advance from this voucher is already consumed (${existingAdv.consumedAmount}) — cannot reduce it below that.`
              );
            }
            await tx.partyAdvance.update({
              where: { id: existingAdv.id },
              data: {
                partyId: data.partyId,
                kind: advanceKind,
                date: voucherDate,
                voucherNo: data.voucherNo,
                amount: unallocated,
                remarks: data.remarks || null,
              },
            });
          } else {
            await tx.partyAdvance.create({
              data: {
                tenantId: session.tenantId,
                firmId: session.firmId,
                // the advance is born from the voucher's money — same year
                fyId: docFyId,
                partyId: data.partyId,
                kind: advanceKind,
                date: voucherDate,
                voucherId: savedId,
                voucherNo: data.voucherNo,
                amount: unallocated,
                remarks: data.remarks || null,
              },
            });
          }
        } else if (existingAdv) {
          if (Number(existingAdv.consumedAmount) > 0.009) {
            throw new Error(
              "This voucher's advance has already been consumed by a bill — it cannot be fully allocated now."
            );
          }
          await tx.partyAdvance.update({
            where: { id: existingAdv.id },
            data: { deletedAt: new Date() },
          });
        }
      }

      return savedId;
    });

    revalidatePath("/accounts/vouchers");
    revalidatePath("/accounts/vouchers/register");
    return { ok: true, id };
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
      const m = data.voucherNo.match(/^(.*?)(\d+)\s*$/);
      if (attempt < maxAttempts - 1 && m) {
        data.voucherNo = `${m[1]}${Number(m[2]) + 1}`;
        continue;
      }
      return { ok: false, error: "Voucher number already exists" };
    }
    return { ok: false, error: err instanceof Error ? err.message : "Failed to save voucher" };
  }
  }
  return { ok: false, error: "Voucher number already exists" };
}

export async function deleteVoucher(
  id: string
): Promise<{ ok: true } | { ok: false; error: string }> {
  const session = requireSession();
  if (session.role !== "ADMIN" && session.role !== "OWNER") {
    return { ok: false, error: "Only Admin/Owner may delete vouchers" };
  }
  await authorize(session, "vouchers", "delete");
  try {
    await withTenant(session.tenantId, async (tx) => {
      const before = await tx.voucher.findFirst({
        // no FY filter: an old-year voucher deletes from here too (id + firm
        // keep it precise) — its chalan sync below needs the allocations
        where: { id, firmId: session.firmId },
        include: { allocations: true },
      });
      if (!before) throw new Error("Voucher not found in this firm");
      const adv = await tx.partyAdvance.findFirst({ where: { voucherId: id, deletedAt: null } });
      if (adv && Number(adv.consumedAmount) > 0.009) {
        throw new Error(
          "The advance created by this voucher is already consumed by a bill — remove that adjustment first."
        );
      }
      if (adv) {
        await tx.partyAdvance.update({ where: { id: adv.id }, data: { deletedAt: new Date() } });
      }
      // a shortage this voucher raised may already be recovered by OTHER
      // documents — deleting would orphan those recoveries and lose money
      // already collected elsewhere
      const extRecovered = await externallyRecoveredShortage(tx, "VOUCHER", id);
      if (extRecovered > 0.009) {
        throw new Error(
          "The shortage raised by this voucher already has recoveries booked from other documents — release those recoveries first."
        );
      }
      await tx.voucher.update({ where: { id }, data: { deletedAt: new Date() } });
      // driver settlements this voucher had settled become payable again
      await tx.driverSettlement.updateMany({
        where: { voucherId: id, deletedAt: null },
        data: { status: "PENDING", settledDate: null, voucherId: null, voucherNo: null },
      });
      // give back whatever OTHER advances this voucher had adjusted
      await restoreAdvanceUses(tx, "VOUCHER", id);
      await reverseLedger(tx, "VOUCHER", id);
      await releaseShortage(tx, "VOUCHER", id);
      // a chalan whose balance THIS voucher had settled (balance payments are
      // real vouchers now) opens again: its status returns to PENDING and the
      // balance-payment shortage recovery is released with the money
      for (const alloc of before.allocations.filter((a) => a.refType === "FREIGHT_CHALLAN")) {
        // voucher-scoped key: only THIS voucher's recovery is torn down —
        // another voucher's settlement of the same chalan stays intact
        await releaseShortage(tx, "CHALAN", `${alloc.refId}:BAL:${id}`);
        const chalan = await tx.chalan.findFirst({
          where: { id: alloc.refId, firmId: session.firmId, deletedAt: null, cancelledAt: null },
        });
        if (chalan && chalan.paymentStatus === "PAID") {
          const pos = await payableSettlement(tx, {
            firmId: session.firmId,
            refType: "FREIGHT_CHALLAN",
            docs: [
              {
                id: chalan.id,
                balance: Number(chalan.balance),
                ownPaid: Number(chalan.balPaidAmount),
                ownShortage: Number(chalan.balShortage),
                ownRoundOff: Number(chalan.balRoundOff),
                ownAdvanceAdjusted: Number(chalan.balAdvanceAdjusted),
              },
            ],
            excludeVoucherId: id,
          });
          if ((pos.get(chalan.id)?.outstanding ?? 0) > 0.009) {
            await tx.chalan.update({
              where: { id: chalan.id },
              data: {
                paymentStatus: "PENDING",
                // the advance-adjusted part stays settled (its consumption is
                // not restored) — keep its date, or as-on reports would zero
                // it and overstate the payable
                ...(Number(chalan.balAdvanceAdjusted) > 0.009 ? {} : { balPaymentDate: null }),
              },
            });
          }
        }
      }
      // owner side of a broker slip settled by THIS voucher opens again
      for (const alloc of before.allocations.filter((a) => a.refType === "BROKER_ENTRY")) {
        await releaseShortage(tx, "BROKER_SLIP", `${alloc.refId}:V:${id}`);
        const slip = await tx.brokerSlip.findFirst({
          where: { id: alloc.refId, firmId: session.firmId, deletedAt: null },
        });
        if (slip && slip.vPaymentStatus === "PAID") {
          const pos = await payableSettlement(tx, {
            firmId: session.firmId,
            refType: "BROKER_ENTRY",
            docs: [
              {
                id: slip.id,
                balance: Number(slip.vBalance),
                ownPaid: Number(slip.vPaidAmount),
                ownShortage: Number(slip.vShortage),
                ownRoundOff: Number(slip.vRoundOff),
              },
            ],
            excludeVoucherId: id,
          });
          if ((pos.get(slip.id)?.outstanding ?? 0) > 0.009) {
            await tx.brokerSlip.update({
              where: { id: slip.id },
              data: { vPaymentStatus: "PENDING", vPaymentDate: null },
            });
          }
        }
      }
      // party-side mirror voucher (marker allocation): reopen that side fully
      for (const alloc of before.allocations.filter(
        (a) => a.remarks === "BROKER_SLIP_P_SETTLEMENT"
      )) {
        await releaseShortage(tx, "BROKER_SLIP", `${alloc.refId}:P:${id}`);
        await tx.brokerSlip.updateMany({
          where: { id: alloc.refId, firmId: session.firmId, deletedAt: null },
          data: {
            pPaymentStatus: "PENDING",
            pPaidAmount: 0,
            pShortage: 0,
            pRoundOff: 0,
            pPaymentDate: null,
          },
        });
      }
      await audit(tx, session, { entity: "Voucher", entityId: id, action: "DELETE", before });
    });
    revalidatePath("/accounts/vouchers");
    revalidatePath("/accounts/vouchers/register");
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "Failed to delete voucher" };
  }
}

// ---------- allocation candidates ----------

export interface AllocationCandidate {
  refId: string;
  refNo: string;
  date: string; // ISO
  billAmt: number;
  outstanding: number;
  tdsPct: number;
  /** source module (needed when the grid runs in "All modules" mode) */
  module: ModuleLink;
}

/**
 * Amount already settled against a set of refs (excluding a voucher being
 * edited). Every approved deduction settles the document just like money, so
 * TDS, shortage, other and round-off count alongside the cash.
 */
async function allocatedByRef(
  tx: Tx,
  scope: { firmId: string; fyId?: string },
  refType: ModuleLink,
  refIds: string[],
  excludeVoucherId?: string | null
): Promise<Map<string, number>> {
  if (!refIds.length) return new Map();
  const rows = await tx.voucherAllocation.groupBy({
    by: ["refId"],
    where: {
      refType,
      refId: { in: refIds },
      // firm-wide like settledByRef/payableSettlement (FY continuity): a
      // document settled last year must never look open this year
      voucher: {
        deletedAt: null,
        firmId: scope.firmId,
        ...(excludeVoucherId ? { id: { not: excludeVoucherId } } : {}),
      },
    },
    _sum: { amount: true, tdsAmt: true, deduction: true, otherAmt: true, roundOff: true },
  });
  return new Map(
    rows.map((r) => [
      r.refId,
      round2(
        Number(r._sum.amount ?? 0) +
          Number(r._sum.tdsAmt ?? 0) +
          Number(r._sum.deduction ?? 0) +
          Number(r._sum.otherAmt ?? 0) +
          Number(r._sum.roundOff ?? 0)
      ),
    ])
  );
}

/**
 * List open documents for the allocation grid, per moduleLink:
 *  - BILLING / GST_BILLING: party invoices with unallocated balance
 *  - FREIGHT_CHALLAN: broker's final chalans with outstanding balance
 *  - BROKER_ENTRY: broker slips with vehicle-side balance
 *  - LORRY_HIRE: hire slips with balance
 *  - CASH_MEMO: deliveries
 */
export async function getAllocationCandidates(input: {
  moduleLink: ModuleLink | "ALL";
  partyId?: string | null;
  voucherId?: string | null;
  /** restricts "ALL" to the modules that voucher direction can settle —
   *  a Receipt must never offer payables and vice versa */
  voucherType?: "RECEIPT" | "PAYMENT" | null;
}): Promise<AllocationCandidate[]> {
  const session = requireSession();
  const { partyId, voucherId } = input;
  const links: ModuleLink[] =
    input.moduleLink === "ALL"
      ? input.voucherType === "RECEIPT"
        ? [...ALL_RECEIVABLE_REF_TYPES, "CASH_MEMO"]
        : input.voucherType === "PAYMENT"
          ? [...ALL_PAYABLE_REF_TYPES]
          : [
              "BILLING",
              "GST_BILLING",
              "FREIGHT_CHALLAN",
              "BROKER_ENTRY",
              "LORRY_HIRE",
              "CASH_MEMO",
              "OFFICE_EXPENSE",
              "OFFICE_INCOME",
              "STAFF_PAYROLL",
              "VEHICLE_EXPENSE",
              "STAFF_ADVANCE",
              "DRIVER_SETTLEMENT",
              "ADBLUE_PURCHASE",
            ]
      : [input.moduleLink];

  return withTenant(session.tenantId, async (tx) => {
    // FY continuity: outstanding documents from EVERY year are offered — an
    // unpaid bill from last March must be settleable by this April's voucher
    const scope = { firmId: session.firmId, deletedAt: null as null };
    const out: AllocationCandidate[] = [];
    for (const moduleLink of links) {

    if (moduleLink === "BILLING" || moduleLink === "GST_BILLING") {
      const invoices = await tx.invoice.findMany({
        where: {
          ...scope,
          ...(partyId ? { partyId } : {}),
          ...(moduleLink === "GST_BILLING" ? { kind: "GST" } : { kind: { not: "GST" } }),
        },
        orderBy: { invoiceDate: "asc" },
      });
      const paid = await allocatedByRef(tx, scope, moduleLink, invoices.map((i) => i.id), voucherId);
      for (const inv of invoices) {
        const bill = Number(inv.grandTotal);
        // outstanding on the SAME base the save-time ceiling and settlement
        // use: netTotal (GST included) less the advance — grandTotal excludes
        // the GST, so a GST bill could never be settled in full from the grid
        const outstanding = round2(Number(inv.netTotal) - Number(inv.advance) - (paid.get(inv.id) ?? 0));
        if (outstanding > 0)
          out.push({
            refId: inv.id,
            refNo: inv.invoiceNo,
            date: inv.invoiceDate.toISOString(),
            billAmt: bill,
            outstanding,
            tdsPct: Number(inv.tdsPct),
            module: moduleLink,
          });
      }
    } else if (moduleLink === "FREIGHT_CHALLAN") {
      const chalans = await tx.chalan.findMany({
        // a cancelled chalan owes nothing — it must never be offered to settle
        where: { ...scope, isFinal: true, cancelledAt: null, ...(partyId ? { brokerId: partyId } : {}) },
        orderBy: { chalanDate: "asc" },
      });
      // a chalan settled on its own balance-payment screen must not reappear
      // here as fully outstanding — both settlement paths are counted
      const pos = await payableSettlement(tx, {
        firmId: session.firmId,
        fyId: session.fyId,
        refType: moduleLink,
        excludeVoucherId: voucherId,
        docs: chalans.map((c) => ({
          id: c.id,
          balance: Number(c.balance),
          ownPaid: Number(c.balPaidAmount),
          ownShortage: Number(c.balShortage),
          ownRoundOff: Number(c.balRoundOff),
          ownAdvanceAdjusted: Number(c.balAdvanceAdjusted),
        })),
      });
      for (const c of chalans) {
        const outstanding = pos.get(c.id)?.outstanding ?? 0;
        if (outstanding > 0)
          out.push({
            refId: c.id,
            refNo: c.chalanNo,
            date: c.chalanDate.toISOString(),
            billAmt: Number(c.grandTotal),
            outstanding,
            tdsPct: Number(c.tdsPct),
            module: moduleLink,
          });
      }
    } else if (moduleLink === "BROKER_ENTRY") {
      const slips = await tx.brokerSlip.findMany({
        where: {
          ...scope,
          ...(partyId ? { OR: [{ transporterId: partyId }, { ownerId: partyId }] } : {}),
        },
        orderBy: { slipDate: "asc" },
      });
      // same for the owner side of a broker slip
      const pos = await payableSettlement(tx, {
        firmId: session.firmId,
        fyId: session.fyId,
        refType: moduleLink,
        excludeVoucherId: voucherId,
        docs: slips.map((s) => ({
          id: s.id,
          balance: Number(s.vBalance),
          ownPaid: Number(s.vPaidAmount),
          ownShortage: Number(s.vShortage),
          ownRoundOff: Number(s.vRoundOff),
        })),
      });
      for (const s of slips) {
        const outstanding = pos.get(s.id)?.outstanding ?? 0;
        if (outstanding > 0)
          out.push({
            refId: s.id,
            refNo: s.slipNo,
            date: s.slipDate.toISOString(),
            billAmt: Number(s.vNetAmt),
            outstanding,
            tdsPct: Number(s.vTdsPct),
            module: moduleLink,
          });
      }
    } else if (moduleLink === "LORRY_HIRE") {
      const slips = await tx.hireSlip.findMany({
        where: { ...scope },
        orderBy: { slipDate: "asc" },
      });
      const paid = await allocatedByRef(tx, scope, moduleLink, slips.map((s) => s.id), voucherId);
      for (const s of slips) {
        const outstanding = round2(Number(s.balance) - (paid.get(s.id) ?? 0));
        if (outstanding > 0)
          out.push({
            refId: s.id,
            refNo: s.slipNo,
            date: s.slipDate.toISOString(),
            billAmt: Number(s.totalHire),
            outstanding,
            tdsPct: 0,
            module: moduleLink,
          });
      }
    } else if (moduleLink === "CASH_MEMO") {
      const deliveries = await tx.delivery.findMany({
        where: { ...scope, type: "CASH_MEMO", ...(partyId ? { partyId } : {}) },
        orderBy: { delDate: "asc" },
      });
      const paid = await allocatedByRef(tx, scope, moduleLink, deliveries.map((d) => d.id), voucherId);
      for (const d of deliveries) {
        const outstanding = round2(Number(d.total) - (paid.get(d.id) ?? 0));
        if (outstanding > 0)
          out.push({
            refId: d.id,
            refNo: d.delNo,
            date: d.delDate.toISOString(),
            billAmt: Number(d.total),
            outstanding,
            tdsPct: 0,
            module: moduleLink,
          });
      }
    } else if (moduleLink === "OFFICE_EXPENSE" || moduleLink === "OFFICE_INCOME") {
      // Only entries left ON CREDIT are outstanding. One with a payment mode
      // was settled in cash or bank at entry — the money has already moved, and
      // offering it for settlement again would pay it twice.
      const txns = await tx.officeTransaction.findMany({
        where: {
          ...scope,
          txnType: moduleLink === "OFFICE_EXPENSE" ? "EXPENSE" : "INCOME",
          paymentMode: null,
          // an entry with no party has nobody to owe or be owed by
          partyId: partyId ? partyId : { not: null },
        },
        orderBy: { date: "asc" },
      });
      const pos = await refPositions(tx, {
        firmId: session.firmId,
        fyId: session.fyId,
        refType: moduleLink,
        excludeVoucherId: voucherId,
        docs: txns.map((t) => ({ id: t.id, original: Number(t.amount) })),
      });
      for (const t of txns) {
        const outstanding = pos.get(t.id)?.outstanding ?? 0;
        if (outstanding > 0)
          out.push({
            refId: t.id,
            // blank reference falls back to the voucher number, matching what
            // was persisted on save and what the ledger already shows
            refNo: t.refNo || t.voucherNo,
            date: t.date.toISOString(),
            billAmt: Number(t.amount),
            outstanding,
            tdsPct: 0,
            module: moduleLink,
          });
      }
    } else if (moduleLink === "STAFF_PAYROLL") {
      const salaries = await tx.staffSalary.findMany({
        where: { ...scope, ...(partyId ? { partyId } : {}) },
        orderBy: { month: "asc" },
      });
      // a salary can be settled on the payroll screen too, so both paths count
      const pos = await refPositions(tx, {
        firmId: session.firmId,
        fyId: session.fyId,
        refType: moduleLink,
        excludeVoucherId: voucherId,
        docs: salaries.map((s) => ({
          id: s.id,
          original: Number(s.netSalary),
          ownSettled: Number(s.paidAmount),
        })),
      });
      for (const s of salaries) {
        const outstanding = pos.get(s.id)?.outstanding ?? 0;
        // a malformed month degrades to the entry date rather than throwing
        const monthDate = new Date(`${s.month}-01T00:00:00`);
        if (outstanding > 0)
          out.push({
            refId: s.id,
            refNo: s.refNo || s.voucherNo || s.month,
            date: (Number.isNaN(monthDate.getTime()) ? s.createdAt : monthDate).toISOString(),
            billAmt: Number(s.netSalary),
            outstanding,
            tdsPct: 0,
            module: moduleLink,
          });
      }
    } else if (moduleLink === "VEHICLE_EXPENSE") {
      // only bills left ON CREDIT are outstanding — one with a payment mode was
      // settled in cash or bank at entry, and offering it again would pay twice
      const bills = await tx.vehicleExpenseVoucher.findMany({
        where: {
          ...scope,
          paymentMode: null,
          partyId: partyId ? partyId : { not: null },
        },
        orderBy: { date: "asc" },
      });
      const pos = await refPositions(tx, {
        firmId: session.firmId,
        fyId: session.fyId,
        refType: moduleLink,
        excludeVoucherId: voucherId,
        docs: bills.map((b) => ({ id: b.id, original: Number(b.amount) })),
      });
      for (const b of bills) {
        const outstanding = pos.get(b.id)?.outstanding ?? 0;
        if (outstanding > 0)
          out.push({
            refId: b.id,
            // blank reference falls back to the voucher number, the same rule
            // office bills and salaries follow
            refNo: b.refNo || b.voucherNo,
            date: b.date.toISOString(),
            billAmt: Number(b.amount),
            outstanding,
            tdsPct: 0,
            module: moduleLink,
          });
      }
    } else if (moduleLink === "STAFF_ADVANCE") {
      // an advance is money the staff member owes back: it is RECEIVED, either
      // as a payroll deduction (handled on the salary screen) or in cash here
      const advances = await tx.staffAdvance.findMany({
        where: { ...scope, ...(partyId ? { partyId } : {}) },
        orderBy: { date: "asc" },
      });
      const recovered = await tx.staffSalary.groupBy({
        by: ["advanceId"],
        where: { advanceId: { in: advances.map((a) => a.id) }, deletedAt: null },
        _sum: { advanceRecovery: true },
      });
      const byAdvance = new Map(
        recovered.map((r) => [r.advanceId ?? "", Number(r._sum.advanceRecovery ?? 0)])
      );
      const pos = await refPositions(tx, {
        firmId: session.firmId,
        fyId: session.fyId,
        refType: moduleLink,
        excludeVoucherId: voucherId,
        docs: advances.map((a) => ({
          id: a.id,
          original: Number(a.amount),
          ownSettled: byAdvance.get(a.id) ?? 0,
        })),
      });
      for (const a of advances) {
        const outstanding = pos.get(a.id)?.outstanding ?? 0;
        if (outstanding > 0)
          out.push({
            refId: a.id,
            refNo: a.advanceNo,
            date: a.date.toISOString(),
            billAmt: Number(a.amount),
            outstanding,
            tdsPct: 0,
            module: moduleLink,
          });
      }
    } else if (moduleLink === "ADBLUE_PURCHASE") {
      // a billed refill left on credit. Stock still waiting for its invoice owes
      // nothing yet, and one paid at entry has already moved the money.
      const refills = await tx.adblueTxn.findMany({
        where: {
          ...scope,
          type: "REFILL",
          billNo: { not: null },
          paymentMode: null,
          supplierId: partyId ? partyId : { not: null },
        },
        orderBy: { date: "asc" },
      });
      const pos = await refPositions(tx, {
        firmId: session.firmId,
        fyId: session.fyId,
        refType: moduleLink,
        excludeVoucherId: voucherId,
        docs: refills.map((r) => ({ id: r.id, original: Number(r.amount) })),
      });
      for (const r of refills) {
        const outstanding = pos.get(r.id)?.outstanding ?? 0;
        if (outstanding > 0)
          out.push({
            refId: r.id,
            refNo: r.billNo!,
            date: (r.billDate ?? r.date).toISOString(),
            billAmt: Number(r.amount),
            outstanding,
            tdsPct: 0,
            module: moduleLink,
          });
      }
    } else if (moduleLink === "DRIVER_SETTLEMENT") {
      // a pending trip settlement balance: positive = the company pays the
      // driver, negative = the driver pays the company. Settling it from its own
      // screen creates a voucher and marks it SETTLED, so only PENDING rows are
      // offered here and the same balance can never be settled twice.
      const settlements = await tx.driverSettlement.findMany({
        where: { ...scope, status: "PENDING" },
        orderBy: { date: "asc" },
      });
      const drivers = settlements.length
        ? await tx.driver.findMany({
            where: { id: { in: settlements.map((s) => s.driverId) } },
            select: { id: true, partyId: true, driverCode: true },
          })
        : [];
      const driverById = new Map(drivers.map((d) => [d.id, d]));
      const mine = settlements.filter((s) => {
        if (partyId && driverById.get(s.driverId)?.partyId !== partyId) return false;
        // the sign IS the direction: positive (company owes the driver) only on
        // a PAYMENT, negative (driver owes the company) only on a RECEIPT — a
        // payment voucher must never "pay out" a recovery
        const amt = Number(s.amount);
        if (input.voucherType === "PAYMENT") return amt > 0;
        if (input.voucherType === "RECEIPT") return amt < 0;
        return true;
      });
      const pos = await refPositions(tx, {
        firmId: session.firmId,
        fyId: session.fyId,
        refType: moduleLink,
        excludeVoucherId: voucherId,
        docs: mine.map((s) => ({ id: s.id, original: Math.abs(Number(s.amount)) })),
      });
      for (const s of mine) {
        const outstanding = pos.get(s.id)?.outstanding ?? 0;
        if (outstanding > 0)
          out.push({
            refId: s.id,
            refNo: s.voucherNo || s.tripRef || `SETT-${driverById.get(s.driverId)?.driverCode ?? ""}`,
            date: s.date.toISOString(),
            billAmt: Math.abs(Number(s.amount)),
            outstanding,
            tdsPct: 0,
            module: moduleLink,
          });
      }
    }
    }
    return out;
  });
}

export async function getAccountHeadOptions(): Promise<
  { value: string; label: string; meta?: string }[]
> {
  const session = requireSession();
  const heads = await withTenant(session.tenantId, (tx) =>
    tx.accountHead.findMany({ orderBy: { name: "asc" } })
  );
  return heads.map((h) => ({ value: h.id, label: h.name, meta: h.kind }));
}

/**
 * Open advances of a party for the voucher's Adjust Advance grid — strictly
 * the direction the voucher type may consume (Receipt adjusts advances
 * RECEIVED from the party, Payment adjusts advances PAID to the party), never
 * another party's and never a fully consumed one.
 *
 * `refund: true` flips the direction for the Refund Advance grid: a Payment
 * refunds advances RECEIVED from the party, a Receipt takes back advances
 * PAID to it. Chalan-cancel advances are excluded there — they close through
 * their own recovery flow.
 */
export async function getOpenAdvances(input: {
  partyId: string;
  type: "RECEIPT" | "PAYMENT";
  voucherId?: string | null;
  refund?: boolean;
}): Promise<OpenAdvance[]> {
  const session = requireSession();
  const sameKind = input.type === "RECEIPT" ? "RECEIVED" : "PAID";
  const oppositeKind = input.type === "RECEIPT" ? "PAID" : "RECEIVED";
  return withTenant(session.tenantId, async (tx) => {
    const rows = await listOpenAdvances(tx, {
      firmId: session.firmId,
      fyId: session.fyId,
      partyId: input.partyId,
      kinds: [input.refund ? oppositeKind : sameKind],
      // cancellation recoveries never appear as ordinary advances — adjust OR
      // refund; they close only through their own recovery flow
      excludeSources: ["CHALAN_CANCEL"],
      includeRefType: "VOUCHER",
      includeRefId: input.voucherId ?? undefined,
    });
    // a voucher must not offer the advance it created itself
    return input.voucherId ? rows.filter((r) => r.voucherId !== input.voucherId) : rows;
  });
}

export interface OpenCancelAdvance {
  id: string;
  chalanNo: string;
  date: string;
  amount: number;
  available: number;
  remarks: string | null;
}

/** Open chalan-cancel advances of a party — offered for recovery on receipt
 *  vouchers and for bad-debt write-off on journals. */
export async function getOpenCancelAdvances(partyId: string): Promise<OpenCancelAdvance[]> {
  const session = requireSession();
  return withTenant(session.tenantId, async (tx) => {
    const advances = await tx.partyAdvance.findMany({
      where: {
        // FY continuity: an unrecovered cancel-advance from last year stays
        // recoverable this year (the save path is firm-scoped to match)
        firmId: session.firmId,
        partyId,
        deletedAt: null,
        source: "CHALAN_CANCEL",
        kind: "PAID",
      },
      orderBy: { date: "asc" },
    });
    return advances
      .map((a) => ({
        id: a.id,
        chalanNo: a.voucherNo ?? "",
        date: a.date.toISOString().slice(0, 10),
        amount: round2(Number(a.amount)),
        available: round2(Number(a.amount) - Number(a.consumedAmount)),
        remarks: a.remarks,
      }))
      .filter((a) => a.available > 0.009);
  });
}

/** Open advance balances of a party (shown in the voucher form). */
export async function getPartyAdvanceInfo(
  partyId: string
): Promise<{ received: number; paid: number }> {
  const session = requireSession();
  const { partyAdvanceBalance } = await import("@/lib/party-advance");
  return withTenant(session.tenantId, async (tx) => ({
    received: await partyAdvanceBalance(tx, session.firmId, partyId, "RECEIVED", session.fyId),
    paid: await partyAdvanceBalance(tx, session.firmId, partyId, "PAID", session.fyId),
  }));
}
