import { requireSession } from "@/lib/session";
import { authorize } from "@/lib/authz";
import { getPartyOptions, getBankOptions, getVehicleOptions } from "@/lib/lookups";
import { PageHeader } from "@/components/app/page-header";
import { TabNav, type TabDef } from "@/components/app/tab-nav";
import { LoanRegisterClient } from "@/components/finance/loan-register-client";
import { FinanceTxnClient } from "@/components/finance/finance-txn-client";
import { FinanceReportsTab } from "./reports-tab";
import { getFinanceData } from "./queries";

export const dynamic = "force-dynamic";

const BASE = "/finance";

const TABS: TabDef[] = [
  { value: "loans", label: "Loan Register" },
  { value: "others", label: "Other Receipts / Payments" },
  { value: "reports", label: "Reports" },
];

const SUBTITLE: Record<string, string> = {
  loans: "Every loan taken or given, its instalments and what is still outstanding.",
  others: "Personal and other non-operational money — kept out of the freight reports.",
  reports: "Loan, EMI, interest and outstanding registers.",
};

/**
 * Finance & Loan Management — loans, non-operational money, and their reports.
 * Nothing here posts on its own: every payment goes through the existing
 * voucher + ledger engine, so the Voucher Register, Ledger Summary, Trial
 * Balance and P&L pick it all up without a second accounting path.
 */
export default async function FinancePage({
  searchParams,
}: {
  searchParams: Record<string, string | undefined>;
}) {
  const session = requireSession();
  await authorize(session, "finance", "view");
  const canDelete = session.role === "ADMIN" || session.role === "OWNER";

  const tab = TABS.some((t) => t.value === searchParams.tab)
    ? (searchParams.tab as string)
    : "loans";

  const [{ loans, txns }, partyOptions, bankOptions, vehicleOptions] = await Promise.all([
    getFinanceData(),
    getPartyOptions(),
    getBankOptions(),
    getVehicleOptions(),
  ]);

  return (
    <div className="space-y-4 p-4">
      <PageHeader title="Finance &amp; Loan Management" subtitle={SUBTITLE[tab]} />
      <TabNav tabs={TABS} active={tab} basePath={BASE} />
      {tab === "loans" && (
        <LoanRegisterClient
          loans={loans}
          partyOptions={partyOptions}
          bankOptions={bankOptions}
          vehicleOptions={vehicleOptions}
          canDelete={canDelete}
        />
      )}
      {tab === "others" && (
        <FinanceTxnClient
          rows={txns}
          partyOptions={partyOptions}
          bankOptions={bankOptions}
          canDelete={canDelete}
        />
      )}
      {tab === "reports" && <FinanceReportsTab searchParams={searchParams} />}
    </div>
  );
}
