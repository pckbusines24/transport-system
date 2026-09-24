import type { ModuleLink, VoucherEntryType } from "@prisma/client";
import type { Tx } from "@/lib/db";
import type { Session } from "@/lib/session";
import { nextDocNumber } from "@/lib/sequences";
import { postLedger } from "@/lib/ledger";
import { round2 } from "@/lib/calc/tds";

/**
 * A payment made from inside a module (payroll, driver salary, …) is a real
 * Payment Voucher: it gets a voucher number, appears in the Voucher Register,
 * carries an allocation back to the document it settled, and posts its
 * money legs under refType VOUCHER — so the register, the books, the Tally
 * export and the voucher delete path all treat it exactly like a voucher
 * entered by hand. The source document cannot be deleted while the voucher
 * exists; deleting the voucher reopens the document.
 */
export interface ModulePaymentInput {
  date: Date;
  /** party being paid (staff / driver / owner ledger) */
  partyId: string;
  /** bank / cash / card account the money leaves */
  bankPartyId: string;
  /** money actually paid */
  paid: number;
  /** non-cash settlement booked on the same voucher (shortage adjusted, …) */
  deduction?: number;
  moduleLink: ModuleLink;
  /** one row per document this voucher settles (amount + deduction per row must sum to the header) */
  allocations: { refType: ModuleLink; refId: string; refNo: string; billAmt: number; amount: number; deduction?: number; remarks?: string }[];
  narration: string;
  /** narration on the party (debit) leg — defaults to `narration` */
  partyNarration?: string;
}

export async function entryTypeForAccount(tx: Tx, partyId: string): Promise<VoucherEntryType> {
  const p = await tx.party.findUnique({ where: { id: partyId }, select: { ledgerGroup: true } });
  return p?.ledgerGroup === "CASH" ? "CASH" : p?.ledgerGroup === "CARD" ? "CARD" : "BANK";
}

export async function createModulePaymentVoucher(
  tx: Tx,
  session: Session & { firmId: string; fyId: string },
  input: ModulePaymentInput
): Promise<{ id: string; voucherNo: string }> {
  const deduction = round2(input.deduction ?? 0);
  const paid = round2(input.paid);
  const voucherNo = await nextDocNumber(tx, {
    tenantId: session.tenantId,
    firmId: session.firmId,
    fyId: session.fyId,
    docType: "VOUCHER_PAYMENT",
  });
  const entryType = await entryTypeForAccount(tx, input.bankPartyId);
  const voucher = await tx.voucher.create({
    data: {
      tenantId: session.tenantId,
      firmId: session.firmId,
      fyId: session.fyId,
      createdById: session.userId,
      voucherNo,
      voucherDate: input.date,
      type: "PAYMENT",
      entryType,
      moduleLink: input.moduleLink,
      partyId: input.partyId,
      bankPartyId: input.bankPartyId,
      // header follows the voucher module: amount = gross settled, netAmount = money moved
      amount: round2(paid + deduction),
      deduction,
      netAmount: paid,
      remarks: input.narration,
      allocations: {
        create: input.allocations.map((a) => ({
          tenantId: session.tenantId,
          refType: a.refType,
          refId: a.refId,
          refNo: a.refNo,
          billAmt: a.billAmt,
          amount: round2(a.amount),
          deduction: round2(a.deduction ?? 0),
          remarks: a.remarks ?? null,
        })),
      },
    },
    select: { id: true, voucherNo: true },
  });
  if (paid > 0) {
    const common = { date: input.date, refType: "VOUCHER", refId: voucher.id, refNo: voucherNo };
    await postLedger(tx, session, [
      { ...common, partyId: input.bankPartyId, side: "CREDIT", amount: paid, narration: input.narration },
      { ...common, partyId: input.partyId, side: "DEBIT", amount: paid, narration: input.partyNarration ?? input.narration },
    ]);
  }
  return voucher;
}
