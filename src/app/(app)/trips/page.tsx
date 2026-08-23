import { requireSession } from "@/lib/session";
import { authorize } from "@/lib/authz";
import { PageHeader } from "@/components/app/page-header";
import { TabNav, type TabDef } from "@/components/app/tab-nav";
import { TripRegisterTab } from "./register-tab";
import { TripSheetsTab } from "./sheets-tab";
import { TripExpensesTab } from "./expenses-tab";

export const dynamic = "force-dynamic";

const BASE = "/trips";

const TABS: TabDef[] = [
  { value: "register", label: "Trip Register" },
  { value: "sheets", label: "Trip Sheets" },
  { value: "expenses", label: "Trip Expenses" },
];

const SUBTITLE: Record<string, string> = {
  register: "Every trip sheet raised, with its settlement position.",
  sheets:
    "Every trip settles separately — Raigarh → Chennai and Chennai → Raigarh are two independent trip sheets, even for the same vehicle.",
  expenses: "Expenses are recorded on each trip sheet; this is a consolidated register.",
};

/** Trip Management — trip sheet entry and the consolidated expense register. */
export default async function TripManagementPage({
  searchParams,
}: {
  searchParams: Record<string, string | undefined>;
}) {
  const session = requireSession();
  await authorize(session, "trips", "view");

  // register-first, as the module has always worked — but arriving with a trip
  // (or "new") means the sheet was asked for, so open straight onto it
  const tab = TABS.some((t) => t.value === searchParams.tab)
    ? (searchParams.tab as string)
    : searchParams.id || searchParams.new
      ? "sheets"
      : "register";

  return (
    <div className="space-y-4 p-4">
      <PageHeader title="Trip Management" subtitle={SUBTITLE[tab]} />
      <TabNav tabs={TABS} active={tab} basePath={BASE} />
      {/* only the active tab is queried */}
      {tab === "register" && <TripRegisterTab searchParams={searchParams} />}
      {tab === "sheets" && <TripSheetsTab searchParams={searchParams} />}
      {tab === "expenses" && <TripExpensesTab searchParams={searchParams} />}
    </div>
  );
}
