import { requireSession } from "@/lib/session";
import { withTenant } from "@/lib/db";
import { round2 } from "@/lib/calc/tds";
import { toNum } from "@/lib/utils";
import { settledByRef } from "@/lib/settlement";
import { StaffPayrollClient, type StaffRow } from "@/components/accounts/staff-payroll-client";

export const dynamic = "force-dynamic";

export async function StaffPayrollTab() {
  const session = requireSession();

  const { staff, profiles, advances, loans, salaries, banks, salSettled, advSettled } =
    await withTenant(session.tenantId, async (tx) => {
      // FY continuity: the staff account is lifetime — open advances/loans and
      // salary dues from earlier years stay visible until squared off
      const scope = { firmId: session.firmId, deletedAt: null };
      const [staff, profiles, advances, loans, salaries, banks] = await Promise.all([
        tx.party.findMany({ where: { ledgerGroup: "STAFF" }, orderBy: { name: "asc" } }),
        tx.staffProfile.findMany(),
        tx.staffAdvance.findMany({ where: scope }),
        tx.staffLoan.findMany({ where: scope }),
        tx.staffSalary.findMany({ where: scope }),
        tx.party.findMany({
          where: { isActive: true, ledgerGroup: { in: ["BANK", "CASH", "CARD"] } },
          orderBy: { name: "asc" },
        }),
      ]);
      // voucher-side settlements count too, or a voucher-paid salary reads as
      // pending and a receipt-repaid advance still shows a balance
      const [salSettled, advSettled] = await Promise.all([
        settledByRef(tx, {
          firmId: session.firmId,
          fyId: session.fyId,
          refTypes: ["STAFF_PAYROLL"],
          refIds: salaries.map((s) => s.id),
        }),
        settledByRef(tx, {
          firmId: session.firmId,
          fyId: session.fyId,
          refTypes: ["STAFF_ADVANCE"],
          refIds: advances.map((a) => a.id),
        }),
      ]);
      return { staff, profiles, advances, loans, salaries, banks, salSettled, advSettled };
    });

  const profileByParty = new Map(profiles.map((p) => [p.partyId, p]));

  const rows: StaffRow[] = staff.map((p) => {
    const prof = profileByParty.get(p.id);
    const myAdvances = advances.filter((a) => a.partyId === p.id);
    const myLoans = loans.filter((l) => l.partyId === p.id);
    const mySalaries = salaries.filter((s) => s.partyId === p.id);
    const advTotal = round2(myAdvances.reduce((s, a) => s + toNum(String(a.amount)), 0));
    const advAdjusted = round2(
      mySalaries.reduce((s, r) => s + (r.advanceId ? toNum(String(r.advanceRecovery)) : 0), 0) +
        myAdvances.reduce((s, a) => s + (advSettled.get(a.id) ?? 0), 0)
    );
    const loanTotal = round2(myLoans.reduce((s, l) => s + toNum(String(l.amount)), 0));
    const loanRecovered = round2(
      mySalaries.reduce((s, r) => s + (r.loanId ? toNum(String(r.loanRecovery)) : 0), 0)
    );
    // settled = own payment + voucher allocations, the payables-register rule
    const salSettledOf = (r: (typeof mySalaries)[number]) =>
      round2(toNum(String(r.paidAmount)) + (salSettled.get(r.id) ?? 0));
    const paidSalaries = mySalaries.filter(
      (s) => s.paymentStatus === "PAID" || salSettledOf(s) >= toNum(String(s.netSalary)) - 0.009
    );
    const pendingSalary = round2(
      mySalaries.reduce(
        (s, r) => s + Math.max(0, round2(toNum(String(r.netSalary)) - salSettledOf(r))),
        0
      )
    );
    const lastPaid = paidSalaries
      .filter((s) => s.paymentDate)
      .sort((a, b) => (a.paymentDate! < b.paymentDate! ? 1 : -1))[0];
    const lastAdvance = [...myAdvances].sort((a, b) => (a.date < b.date ? 1 : -1))[0];
    return {
      partyId: p.id,
      name: p.name,
      isActive: p.isActive,
      employeeId: prof?.employeeId ?? "",
      department: prof?.department ?? "",
      designation: prof?.designation ?? "",
      joiningDate: prof?.joiningDate ? prof.joiningDate.toISOString() : null,
      basicSalary: toNum(String(prof?.basicSalary ?? 0)),
      allowances: toNum(String(prof?.allowances ?? 0)),
      salariesProcessed: mySalaries.length,
      salariesPaid: paidSalaries.length,
      pendingSalary,
      advanceTotal: advTotal,
      advanceBalance: round2(advTotal - advAdjusted),
      loanTotal,
      loanOutstanding: round2(loanTotal - loanRecovered),
      totalRecoveries: round2(advAdjusted + loanRecovered),
      lastSalaryPaid: lastPaid?.paymentDate ? lastPaid.paymentDate.toISOString() : null,
      lastAdvanceDate: lastAdvance ? lastAdvance.date.toISOString() : null,
    };
  });

  return (
    <div className="space-y-4">
      <StaffPayrollClient
        rows={rows}
        bankOptions={banks.map((b) => ({ value: b.id, label: b.name, meta: b.ledgerGroup }))}
      />
    </div>
  );
}
