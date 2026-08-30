import Link from "next/link";
import { requireSession } from "@/lib/session";
import { authorize } from "@/lib/authz";
import { withTenant } from "@/lib/db";
import { voucherHash } from "@/lib/tally";
import { Button } from "@/components/ui/button";
import { FilterBar } from "@/components/data/filter-bar";
import { TallyExportClient, type TallyExportRow } from "@/components/reports/tally-export-client";
import { buildModuleDocs, type TallyModule } from "./build";

export const dynamic = "force-dynamic";

const MODULES: { value: TallyModule; label: string }[] = [
  { value: "CHALAN", label: "Chalan (Purchase side)" },
  { value: "BILLING", label: "Billing (Sales)" },
  { value: "SLIP", label: "Broker Slip (both sides)" },
  { value: "VOUCHERS", label: "Receipts / Payments (Accounts)" },
  { value: "EXPENSES", label: "Vehicle Expenses" },
  { value: "OFFICE", label: "Office Income / Expenses" },
];

const HINTS: Record<TallyModule, string> = {
  CHALAN:
    "Only FINAL chalans of Broker / Relative vehicles — an own vehicle's chalan does not go to Tally. The period matches on any chalan/advance/balance entry.",
  BILLING:
    "Each bill is one Sales voucher — full amount in a single line, ref = bill no. Money-received entries go from the 'Receipts / Payments' module.",
  SLIP: "Party side (Sales + deduction journals + receipts) always; owner side only on Broker/Relative vehicles — an own vehicle gets the party side only.",
  VOUCHERS:
    "Receipt/Payment vouchers from Accounts — separate TDS/Shortage/Other/Round-off lines, bill-wise Agst Refs from the allocations (billing receipts, voucher-settled chalans and supplier payments all come from here).",
  EXPENSES:
    "Vehicle expense vouchers — paid ones as Payment (Dr head / Cr bank-cash-card), credit ones as Journal (Cr supplier). No entry goes across for the vehicle-wise allocation.",
  OFFICE: "Office income/expense entries — paid → Payment/Receipt, credit → Journal with the supplier.",
};

/** Reports → Tally Export: all modules in the user's exact Tally entry style,
 *  with a duplicate-proof export register. */
export default async function TallyExportPage({
  searchParams,
}: {
  searchParams: { date_from?: string; date_to?: string; module?: string };
}) {
  const session = requireSession();
  await authorize(session, "tally", "view");

  const activeModule = (MODULES.some((m) => m.value === searchParams.module)
    ? searchParams.module
    : "CHALAN") as TallyModule;
  const dateFrom = searchParams.date_from ? new Date(`${searchParams.date_from}T00:00:00`) : null;
  const dateTo = searchParams.date_to ? new Date(`${searchParams.date_to}T23:59:59`) : null;

  const rows = await withTenant(session.tenantId, async (tx) => {
    const { docs } = await buildModuleDocs(tx, session, activeModule, { dateFrom, dateTo });
    const keys = docs.flatMap((d) => d.vouchers.map((v) => v.key));
    const registry = new Map(
      (
        await tx.tallyExportEntry.findMany({
          where: { firmId: session.firmId, key: { in: keys } },
        })
      ).map((r) => [r.key, r.hash])
    );
    return docs.map((d): TallyExportRow => {
      let fresh = 0;
      let changed = 0;
      let done = 0;
      for (const v of d.vouchers) {
        const prev = registry.get(v.key);
        if (prev === undefined) fresh += 1;
        else if (prev === voucherHash(v)) done += 1;
        else changed += 1;
      }
      return {
        docId: d.id,
        refNo: d.refNo,
        dateIso: d.dateIso,
        party: d.party,
        detail: d.detail,
        amount: d.amount,
        voucherCount: d.vouchers.length,
        fresh,
        changed,
        done,
      };
    });
  });

  return (
    <div className="space-y-4 p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h1 className="text-xl font-semibold">Tally Export</h1>
        <Button asChild variant="outline" size="sm">
          <Link href="/settings/tally">Ledger Mapping</Link>
        </Button>
      </div>
      <p className="text-sm text-muted-foreground">
        {HINTS[activeModule]} After the download, in Tally Prime: <b>Alt+O → Import → Transactions</b>;
        the first time, &quot;Party Masters&quot; as well. Each voucher goes across only once — a changed
        document shows as &quot;CHANGED&quot; and goes across again.
      </p>
      <FilterBar
        filters={[
          {
            type: "select",
            key: "module",
            label: "Module",
            options: MODULES.map((m) => ({ value: m.value, label: m.label })),
          },
          { type: "daterange", key: "date", label: "Period (any entry)" },
        ]}
      />
      {/* key: filter/module change remounts the client so the selection resets */}
      <TallyExportClient
        key={`${activeModule}:${searchParams.date_from ?? ""}:${searchParams.date_to ?? ""}`}
        rows={rows}
        module={activeModule}
        dateFrom={searchParams.date_from ?? null}
        dateTo={searchParams.date_to ?? null}
      />
    </div>
  );
}
