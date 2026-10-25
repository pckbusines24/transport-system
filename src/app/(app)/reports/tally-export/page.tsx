import Link from "next/link";
import { requireSession } from "@/lib/session";
import { authorize } from "@/lib/authz";
import { withTenant } from "@/lib/db";
import { planDoc } from "@/lib/tally-sync";
import { Button } from "@/components/ui/button";
import { FilterBar } from "@/components/data/filter-bar";
import {
  TallyExportClient,
  type TallyExportRow,
  type TallyPendingFile,
} from "@/components/reports/tally-export-client";
import type { TallyModule } from "./build";
import { loadExportState } from "./sync-state";

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
    "Only FINAL chalans of Broker / Relative vehicles — an own vehicle's chalan does not go to Tally. The period matches on any chalan/advance/balance entry. An edited chalan updates its own vouchers in Tally, a zero amount or a cancelled chalan removes them; Detention, ODC, Fine Slip and Mamool go as their own journals.",
  BILLING:
    "Each bill is one Sales voucher — full amount in a single line, ref = bill no. An edited bill updates its voucher in Tally, a deleted bill removes it. Money-received entries go from the 'Receipts / Payments' module.",
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

  const { rows, pendingFiles } = await withTenant(session.tenantId, async (tx) => {
    const state = await loadExportState(tx, session, activeModule, { dateFrom, dateTo });
    const rows = state.docs.map((d): TallyExportRow => {
      const plan = planDoc(d, state.rowsByDoc.get(d.id) ?? [], { sync: state.sync });
      return {
        docId: d.id,
        refNo: d.refNo,
        dateIso: d.dateIso,
        party: d.party,
        detail: d.detail,
        amount: d.amount,
        voucherCount: d.vouchers.length,
        fresh: plan.fresh,
        changed: plan.changed,
        done: plan.done,
        obsolete: plan.obsolete,
        status: state.pendingDocIds.has(d.id) ? "AWAITING" : plan.status,
        blocked: plan.blocked,
      };
    });
    const files = await tx.tallyExportBatch.findMany({
      where: { firmId: session.firmId, module: activeModule, status: "PENDING" },
      orderBy: { createdAt: "desc" },
      select: { id: true, fileName: true, createdAt: true, vouchers: true, deletes: true },
    });
    const pendingFiles: TallyPendingFile[] = files.map((f) => ({
      id: f.id,
      fileName: f.fileName,
      createdIso: f.createdAt.toISOString(),
      vouchers: f.vouchers,
      deletes: f.deletes,
    }));
    return { rows, pendingFiles };
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
        the first time, &quot;Party Masters&quot; as well. Then come back here and press <b>Imported OK</b> on
        the file (or <b>Import failed</b>) — only then do its entries count as exported.
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
        pendingFiles={pendingFiles}
        dateFrom={searchParams.date_from ?? null}
        dateTo={searchParams.date_to ?? null}
      />
    </div>
  );
}
