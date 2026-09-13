import { requireSession } from "@/lib/session";
import { authorize } from "@/lib/authz";
import { PageHeader } from "@/components/app/page-header";
import { TabNav, type TabDef } from "@/components/app/tab-nav";
import { loadSpareParts } from "./_data";
import { SparePartsDashboard } from "@/components/vehicle/spare-parts-dashboard";
import { SparePartsClient } from "@/components/vehicle/spare-parts-client";
import { SparePartsVehicleView } from "@/components/vehicle/spare-parts-vehicle";
import { SparePartsReports } from "@/components/vehicle/spare-parts-reports";

export const dynamic = "force-dynamic";

const BASE = "/vehicle/spare-parts";

const TABS: TabDef[] = [
  { value: "dashboard", label: "Dashboard" },
  { value: "parts", label: "Spare Parts" },
  { value: "warranty", label: "Warranty" },
  { value: "vehicle", label: "Vehicle-wise" },
  { value: "reports", label: "Reports" },
];

const SUBTITLE: Record<string, string> = {
  dashboard: "Which part is where, and which warranties need attention.",
  parts:
    "Every spare part by its unique serial number — purchase, installation, vehicle, KM and warranty. Information only, no accounting effect.",
  warranty: "Warranty position of every part: active, expiring soon, expiring within 30 days, expired.",
  vehicle: "What is fitted in a vehicle now, what was fitted before, and how often it changes.",
  reports: "Vehicle-wise, part-wise, warranty and replacement reports — searchable and exportable.",
};

/**
 * Spare Parts & Warranty Management — an operational tracking module.
 * Nothing here posts to accounts, vouchers, stock value, P&L or Tally.
 */
export default async function SparePartsPage({
  searchParams,
}: {
  searchParams: Record<string, string | undefined>;
}) {
  const session = requireSession();
  await authorize(session, "spareparts", "view");

  const tab = TABS.some((t) => t.value === searchParams.tab) ? (searchParams.tab as string) : "dashboard";
  const { parts, vehicleOptions } = await loadSpareParts();
  const canDelete = session.role === "ADMIN" || session.role === "OWNER";

  return (
    <div className="space-y-4 p-4">
      <PageHeader title="Spare Parts & Warranty" subtitle={SUBTITLE[tab]} />
      <TabNav tabs={TABS} active={tab} basePath={BASE} />
      {tab === "dashboard" && <SparePartsDashboard parts={parts} />}
      {tab === "parts" && (
        <SparePartsClient
          parts={parts}
          vehicleOptions={vehicleOptions}
          canDelete={canDelete}
          mode="parts"
          initialQuery={searchParams.q ?? ""}
          initialStatus={searchParams.status ?? ""}
          initialWarranty={searchParams.warranty ?? ""}
          openPartId={searchParams.part ?? null}
        />
      )}
      {tab === "warranty" && (
        <SparePartsClient
          parts={parts.filter((p) => p.warrantyApplicable)}
          vehicleOptions={vehicleOptions}
          canDelete={canDelete}
          mode="warranty"
          initialQuery={searchParams.q ?? ""}
          initialStatus=""
          initialWarranty={searchParams.warranty ?? ""}
          openPartId={searchParams.part ?? null}
        />
      )}
      {tab === "vehicle" && (
        <SparePartsVehicleView
          parts={parts}
          vehicleOptions={vehicleOptions}
          initialVehicleId={searchParams.vehicleId ?? null}
        />
      )}
      {tab === "reports" && <SparePartsReports parts={parts} vehicleOptions={vehicleOptions} />}
    </div>
  );
}
