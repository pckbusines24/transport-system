import { requireSession } from "@/lib/session";
import { authorize } from "@/lib/authz";
import { PageHeader } from "@/components/app/page-header";
import { TabNav, type TabDef } from "@/components/app/tab-nav";
import { VehicleExpensesTab } from "./expenses-tab";
import { VehicleExpenseAllocationTab } from "./allocation-tab";
import { VehicleExpenseDetailTab } from "./expense-detail-tab";
import { VehicleFinanceTab } from "./finance-tab";
import { VehicleTrackingTab } from "./tracking-tab";
import { VehiclePnlTab } from "./pnl-tab";

export const dynamic = "force-dynamic";

const BASE = "/vehicle/management";

const TABS: TabDef[] = [
  { value: "expenses", label: "Vehicle Expenses" },
  { value: "allocation", label: "Expense Allocation" },
  { value: "expense-detail", label: "Expense Detail" },
  { value: "finance", label: "Finance" },
  { value: "tracking", label: "Vehicle Tracking" },
  { value: "pnl", label: "Trip Profit & Loss" },
];

const SUBTITLE: Record<string, string> = {
  expenses: "Every expense booked against a vehicle, with its head and payment account.",
  allocation:
    "Bulk stock already purchased, handed to the vehicles that use it — on the date they use it.",
  "expense-detail":
    "Totals, income, monthly trend and ownership compare — with every entry one click away.",
  finance: "Loans running against the fleet, their EMIs and what is still outstanding.",
  tracking: "Where each vehicle is and what it is running.",
  pnl: "Earnings less running costs, per vehicle.",
};

/** Vehicle Management — expenses, summary, tracking and P&L in one screen. */
export default async function VehicleManagementPage({
  searchParams,
}: {
  searchParams: Record<string, string | undefined>;
}) {
  const session = requireSession();
  await authorize(session, "vehicle", "view");

  // "summary" folded into Expense Detail; old links keep working
  const requested = searchParams.tab === "summary" ? "expense-detail" : searchParams.tab;
  const tab = TABS.some((t) => t.value === requested) ? (requested as string) : "expenses";

  return (
    <div className="space-y-4 p-4">
      <PageHeader title="Vehicle Management" subtitle={SUBTITLE[tab]} />
      <TabNav tabs={TABS} active={tab} basePath={BASE} />
      {/* only the active tab is queried */}
      {tab === "expenses" && <VehicleExpensesTab searchParams={searchParams} />}
      {tab === "allocation" && <VehicleExpenseAllocationTab searchParams={searchParams} />}
      {tab === "expense-detail" && <VehicleExpenseDetailTab searchParams={searchParams} />}
      {tab === "finance" && <VehicleFinanceTab />}
      {tab === "tracking" && <VehicleTrackingTab />}
      {tab === "pnl" && <VehiclePnlTab searchParams={searchParams} />}
    </div>
  );
}
