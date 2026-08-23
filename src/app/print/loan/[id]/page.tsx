import { notFound } from "next/navigation";
import { requireSession } from "@/lib/session";
import { authorize } from "@/lib/authz";
import { withTenant } from "@/lib/db";
import { formatDate, formatMoney, toNum } from "@/lib/utils";
import { LOAN_TYPE_LABEL, nextDueDate } from "@/lib/loan";
import { PrintToolbar } from "../../driver-fnf/[id]/print-toolbar";

export const dynamic = "force-dynamic";

/**
 * Loan statement — the loan's terms on top, every instalment below, and what is
 * still outstanding at the end. Printed straight from the recorded instalments,
 * so it always agrees with the register and the ledgers.
 */
export default async function LoanPrintPage({ params }: { params: { id: string } }) {
  const session = requireSession();
  await authorize(session, "vouchers", "print");

  const data = await withTenant(session.tenantId, async (tx) => {
    const loan = await tx.loan.findFirst({
      // firm-scoped: another firm's loan must not print under this session
      where: { id: params.id, firmId: session.firmId, deletedAt: null },
      include: { emis: { where: { deletedAt: null }, orderBy: { payDate: "asc" } } },
    });
    if (!loan) return null;
    const [firm, party, vehicle] = await Promise.all([
      tx.firm.findUnique({ where: { id: loan.firmId } }),
      tx.party.findUnique({ where: { id: loan.partyId } }),
      loan.vehicleId
        ? tx.vehicle.findUnique({ where: { id: loan.vehicleId } })
        : Promise.resolve(null),
    ]);
    return { loan, firm, party, vehicle };
  });

  if (!data) notFound();
  const { loan, firm, party, vehicle } = data;

  const amount = toNum(String(loan.amount));
  const repaid = loan.emis.reduce((s, e) => s + toNum(String(e.principal)), 0);
  const interestPaid = loan.emis.reduce((s, e) => s + toNum(String(e.interest)), 0);
  const tdsTotal = loan.emis.reduce((s, e) => s + toNum(String(e.tdsAmt)), 0);
  const outstanding = Math.round((amount - repaid) * 100) / 100;
  const due =
    loan.status === "CLOSED"
      ? null
      : nextDueDate(loan.emiStartDate, loan.emiFrequency, loan.emis.length);

  const terms: [string, string][] = [
    ["Loan No", loan.loanNo],
    ["Date", formatDate(loan.date)],
    ["Party", party?.name ?? ""],
    ["Loan Type", LOAN_TYPE_LABEL[loan.loanType] ?? loan.loanType],
    ["Vehicle", vehicle?.number ?? "—"],
    ["Purpose", loan.purpose ?? "—"],
    ["Loan Amount", formatMoney(amount)],
    [
      "Interest",
      loan.interestMode === "NONE"
        ? "None"
        : `${loan.interestMode === "FLAT" ? "Flat" : "Reducing balance"} @ ${toNum(String(loan.interestRate))}% p.a.`,
    ],
    [
      "EMI",
      loan.emiAmount && toNum(String(loan.emiAmount)) > 0
        ? `${formatMoney(toNum(String(loan.emiAmount)))} ${loan.emiFrequency.toLowerCase()}`
        : "—",
    ],
    ["EMI Start", loan.emiStartDate ? formatDate(loan.emiStartDate) : "—"],
    ["Tenure", loan.tenureMonths ? `${loan.tenureMonths} months` : "—"],
    ["TDS on Interest", loan.tdsApplicable ? `${toNum(String(loan.tdsPct))}%` : "Not applicable"],
    ["Status", loan.status],
  ];

  return (
    <div className="min-h-screen bg-neutral-200 text-black print:bg-white">
      <style
        dangerouslySetInnerHTML={{
          __html: `
            @media print {
              .no-print { display: none !important; }
              body { background: #fff; }
            }
            @page { size: A4; margin: 10mm; }
          `,
        }}
      />
      <PrintToolbar />

      <div className="mx-auto max-w-[190mm] border border-black bg-white p-5 text-[12px]">
        <div className="border-b-2 border-black pb-2 text-center">
          <div className="text-[18px] font-black uppercase">{firm?.name}</div>
          <div className="text-[10px]">
            {[firm?.address1, firm?.address2].filter(Boolean).join(", ")}
          </div>
          <div className="mt-2 text-[14px] font-bold tracking-wide">LOAN STATEMENT</div>
        </div>

        <div className="mt-3 grid grid-cols-2 gap-x-6 gap-y-1">
          {terms.map(([k, v]) => (
            <div key={k} className="flex justify-between border-b border-dotted border-neutral-400 py-0.5">
              <span className="text-neutral-600">{k}</span>
              <span className="font-semibold">{v}</span>
            </div>
          ))}
        </div>

        <div className="mt-4 text-[13px] font-bold">Instalments</div>
        <table className="mt-1 w-full border-collapse text-[11px]">
          <thead>
            <tr className="border-y border-black text-left">
              <th className="py-1">S.No</th>
              <th>Due Date</th>
              <th>Paid On</th>
              <th className="text-right">Principal</th>
              <th className="text-right">Interest</th>
              <th className="text-right">Penalty</th>
              <th className="text-right">Other</th>
              <th className="text-right">TDS</th>
              <th className="text-right">Instalment</th>
              <th>Voucher</th>
            </tr>
          </thead>
          <tbody>
            {loan.emis.map((e) => (
              <tr key={e.id} className="border-b border-neutral-300">
                <td className="py-0.5">
                  {e.emiNo}
                  {e.isSettlement ? " (settlement)" : ""}
                </td>
                <td>{e.dueDate ? formatDate(e.dueDate) : "—"}</td>
                <td>{formatDate(e.payDate)}</td>
                <td className="text-right">{formatMoney(toNum(String(e.principal)))}</td>
                <td className="text-right">{formatMoney(toNum(String(e.interest)))}</td>
                <td className="text-right">{formatMoney(toNum(String(e.penalty)))}</td>
                <td className="text-right">{formatMoney(toNum(String(e.otherAmt)))}</td>
                <td className="text-right">{formatMoney(toNum(String(e.tdsAmt)))}</td>
                <td className="text-right font-semibold">
                  {formatMoney(toNum(String(e.total)))}
                </td>
                <td>{e.voucherNo ?? ""}</td>
              </tr>
            ))}
            {!loan.emis.length && (
              <tr>
                <td colSpan={10} className="py-3 text-center text-neutral-500">
                  No instalment paid yet.
                </td>
              </tr>
            )}
          </tbody>
        </table>

        <div className="mt-4 ml-auto w-72 space-y-1">
          {(
            [
              ["Loan Amount", amount],
              ["Principal Repaid", Math.round(repaid * 100) / 100],
              ["Interest Paid", Math.round(interestPaid * 100) / 100],
              ["TDS Deducted", Math.round(tdsTotal * 100) / 100],
            ] as [string, number][]
          ).map(([k, v]) => (
            <div key={k} className="flex justify-between border-b border-dotted border-neutral-400">
              <span className="text-neutral-600">{k}</span>
              <span>{formatMoney(v)}</span>
            </div>
          ))}
          <div className="flex justify-between border-y-2 border-black py-1 text-[13px] font-black">
            <span>Outstanding Principal</span>
            <span>{formatMoney(outstanding)}</span>
          </div>
          {due && (
            <div className="flex justify-between text-[11px]">
              <span className="text-neutral-600">Next EMI Due</span>
              <span className="font-semibold">{formatDate(due)}</span>
            </div>
          )}
        </div>

        <div className="mt-10 flex justify-between text-[11px]">
          <div>Borrower / Lender Signature</div>
          <div>For {firm?.name}</div>
        </div>
      </div>
    </div>
  );
}
