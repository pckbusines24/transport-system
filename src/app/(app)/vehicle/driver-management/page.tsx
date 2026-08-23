import { requireSession } from "@/lib/session";
import { authorize } from "@/lib/authz";
import { PageHeader } from "@/components/app/page-header";
import { TabNav, type TabDef } from "@/components/app/tab-nav";
import { DriverSalaryClient } from "@/components/vehicle/driver-salary-client";
import { DriverSettlementClient } from "@/components/vehicle/driver-settlement-client";
import { DriverAdvanceClient } from "@/components/vehicle/driver-advance-client";
import { DriverFnfClient } from "@/components/vehicle/driver-fnf-client";
import { loadAdvanceTab, loadFnfTab, loadSalaryTab, loadSettlementTab } from "./_data";
import { DriverInfoTab } from "./info-tab";

export const dynamic = "force-dynamic";

const BASE = "/vehicle/driver-management";

const TABS: TabDef[] = [
  { value: "info", label: "Driver Info" },
  { value: "salary", label: "Driver Salary" },
  { value: "settlement", label: "Driver Settlement" },
  { value: "advance", label: "Driver Advance" },
  { value: "fnf", label: "Driver Final Settlement" },
];

const SUBTITLE =
  "Driver records, salary, +/- settlement, advances and full & final settlement — one place, one ledger.";

/**
 * Driver Management — the four driver money screens grouped behind one header
 * and an underline tab row. Each tab still renders its original client
 * component with every feature intact; only the per-page <h1> is suppressed,
 * since this page owns the heading.
 */
export default async function DriverManagementPage({
  searchParams,
}: {
  searchParams: {
    tab?: string;
    driver?: string;
    vehicle?: string;
    status?: string;
    date_from?: string;
    date_to?: string;
  };
}) {
  const session = requireSession();
  await authorize(session, "driver", "view");

  const tab = TABS.some((t) => t.value === searchParams.tab)
    ? (searchParams.tab as string)
    : "info";

  return (
    <div className="space-y-4 p-4">
      <PageHeader title="Driver Management" subtitle={SUBTITLE} />
      <TabNav tabs={TABS} active={tab} basePath={BASE} />
      {/* only the active tab is loaded, so this costs no more than the
          single-purpose pages it replaces */}
      {tab === "info" && <DriverInfoTab searchParams={searchParams} />}
      {tab === "salary" && <SalaryTab filters={searchParams} />}
      {tab === "settlement" && <SettlementTab filters={searchParams} />}
      {tab === "advance" && <AdvanceTab filters={searchParams} />}
      {tab === "fnf" && <FnfTab />}
    </div>
  );
}

async function SalaryTab({ filters }: { filters: Parameters<typeof loadSalaryTab>[0] }) {
  const data = await loadSalaryTab(filters);
  return <DriverSalaryClient {...data} hideTitle />;
}

async function SettlementTab({ filters }: { filters: Parameters<typeof loadSettlementTab>[0] }) {
  const data = await loadSettlementTab(filters);
  return <DriverSettlementClient {...data} hideTitle />;
}

async function AdvanceTab({ filters }: { filters: Parameters<typeof loadAdvanceTab>[0] }) {
  const data = await loadAdvanceTab(filters);
  return <DriverAdvanceClient {...data} hideTitle />;
}

async function FnfTab() {
  const data = await loadFnfTab();
  return <DriverFnfClient {...data} hideTitle />;
}
