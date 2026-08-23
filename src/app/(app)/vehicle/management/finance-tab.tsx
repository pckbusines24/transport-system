import Link from "next/link";
import { formatDate, formatMoney } from "@/lib/utils";
import { LOAN_TYPE_LABEL } from "@/lib/loan";
import { requireSession } from "@/lib/session";
import { authorize } from "@/lib/authz";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { SimpleReport, type ReportColumn } from "@/components/accounts/simple-report";
import { getFinanceData } from "@/app/(app)/finance/queries";

const COLUMNS: ReportColumn[] = [
  { key: "vehicle", header: "Vehicle" },
  { key: "party", header: "Finance Company" },
  { key: "loanNo", header: "Loan No" },
  { key: "loanType", header: "Loan Type" },
  { key: "amount", header: "Loan Amount", kind: "money" },
  { key: "outstanding", header: "Outstanding Loan", kind: "money" },
  { key: "emiAmount", header: "EMI Amount", kind: "money" },
  { key: "nextDue", header: "Next EMI Date" },
  { key: "remainingEmis", header: "Remaining EMIs", kind: "money" },
  { key: "interest", header: "Interest Rate" },
  { key: "status", header: "Loan Status", kind: "badge" },
];

/**
 * Finance position of the fleet — one row per financed vehicle, straight from
 * the Loan Register, so the two can never disagree.
 */
export async function VehicleFinanceTab() {
  const session = requireSession();
  await authorize(session, "vehicle", "view");

  const { loans } = await getFinanceData();
  const financed = loans.filter((l) => l.vehicleId);

  const rows = financed.map((l) => ({
    vehicle: l.vehicle,
    party: l.party,
    loanNo: l.loanNo,
    loanType: LOAN_TYPE_LABEL[l.loanType] ?? l.loanType,
    amount: l.amount,
    outstanding: l.outstanding,
    emiAmount: l.emiAmount,
    nextDue: l.nextDueDate ? formatDate(l.nextDueDate) : "",
    remainingEmis: l.remainingEmis ?? 0,
    interest:
      l.interestMode === "NONE"
        ? "None"
        : `${l.interestMode === "FLAT" ? "Flat" : "Reducing"} ${l.interestRate}%`,
    status: l.status,
  }));

  const totalOutstanding = rows.reduce((s, r) => s + r.outstanding, 0);

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap gap-2 text-sm">
          <Badge variant="outline">
            {financed.length} financed vehicle{financed.length === 1 ? "" : "s"}
          </Badge>
          <Badge variant="outline">Outstanding {formatMoney(totalOutstanding)}</Badge>
        </div>
        <Button size="sm" asChild>
          <Link href="/finance?tab=loans">Open Loan Details</Link>
        </Button>
      </div>
      <SimpleReport
        title="Every loan linked to a vehicle. The FULL EMI posts to Vehicle EMI Expense and reaches that vehicle's P&L on the date it is paid; on a relative-owned vehicle the instalment transfers to the owner's ledger."
        columns={COLUMNS}
        rows={rows}
        fileName="vehicle-finance"
        emptyMessage="No vehicle is financed yet — add a Vehicle Loan in Finance & Loan Management."
      />
    </div>
  );
}
