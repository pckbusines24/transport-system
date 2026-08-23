import { requireSession } from "@/lib/session";
import { authorize } from "@/lib/authz";
import { PageHeader } from "@/components/app/page-header";
import { TabNav, type TabDef } from "@/components/app/tab-nav";
import { OfficeIncomeExpenseTab } from "./income-expense-tab";
import { StaffPayrollTab } from "./staff-tab";

export const dynamic = "force-dynamic";

const BASE = "/accounts/office";

const TABS: TabDef[] = [
  { value: "income-expense", label: "Office Income & Expense" },
  { value: "staff", label: "Staff Payroll & Advances" },
];

const SUBTITLE: Record<string, string> = {
  "income-expense":
    "Day-to-day office income and expenditure, posted straight to the cash / bank book and its account head.",
  staff: "Staff salaries, advances and loans, with each settlement posted to the staff ledger.",
};

/** Office Management — office transactions and staff payroll in one screen. */
export default async function OfficeManagementPage({
  searchParams,
}: {
  searchParams: Record<string, string | undefined>;
}) {
  const session = requireSession();
  await authorize(session, "office", "view");

  const tab = TABS.some((t) => t.value === searchParams.tab)
    ? (searchParams.tab as string)
    : "income-expense";

  return (
    <div className="space-y-4 p-4">
      <PageHeader title="Office Management" subtitle={SUBTITLE[tab]} />
      <TabNav tabs={TABS} active={tab} basePath={BASE} />
      {/* only the active tab is queried */}
      {tab === "staff" ? (
        <StaffPayrollTab />
      ) : (
        <OfficeIncomeExpenseTab searchParams={searchParams} />
      )}
    </div>
  );
}
