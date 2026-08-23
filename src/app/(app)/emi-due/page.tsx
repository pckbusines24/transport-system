import { requireSession } from "@/lib/session";
import { authorize } from "@/lib/authz";
import { withTenant } from "@/lib/db";
import { getFinanceData } from "../finance/queries";
import { EmiDueClient } from "./emi-due-client";

export const dynamic = "force-dynamic";

/**
 * EMI Due — every ACTIVE loan with EMIs, its next due date derived from the
 * schedule and the instalments actually paid (the same read model the Loan
 * Register uses, so both screens always agree). Payment opens the SAME EMI
 * popup as Loan Management — same suggestion, voucher and ledger logic.
 */
export default async function EmiDuePage() {
  const session = requireSession();
  await authorize(session, "finance", "view");

  const { loans } = await getFinanceData();
  const bankOptions = await withTenant(session.tenantId, (tx) =>
    tx.party.findMany({
      where: { isActive: true, ledgerGroup: { in: ["BANK", "CASH", "CARD"] } },
      orderBy: { name: "asc" },
      select: { id: true, name: true },
    })
  );

  const rows = loans
    .filter((l) => l.status === "ACTIVE" && l.outstanding > 0.009 && (l.emiAmount > 0 || l.nextDueDate))
    .map((l) => ({
      loanId: l.id,
      loanNo: l.loanNo,
      party: l.party,
      vehicle: l.vehicle,
      loanType: l.loanType,
      emiAmount: l.emiAmount,
      outstanding: l.outstanding,
      nextDueDate: l.nextDueDate,
      remainingEmis: l.remainingEmis,
    }))
    .sort((a, b) => (a.nextDueDate ?? "9999").localeCompare(b.nextDueDate ?? "9999"));

  return (
    <EmiDueClient rows={rows} bankOptions={bankOptions.map((b) => ({ value: b.id, label: b.name }))} />
  );
}
