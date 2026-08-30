import { requireSession } from "@/lib/session";
import { authorize } from "@/lib/authz";
import { withTenant } from "@/lib/db";
import {
  BILLING_CONCEPTS,
  CHALAN_CONCEPTS,
  SLIP_P_CONCEPTS,
  VOUCHER_CONCEPTS,
  type TallyConcept,
} from "@/lib/tally-map";
import { TallyMappingClient, type MapSection } from "@/components/settings/tally-mapping-client";

export const dynamic = "force-dynamic";

const concepts = (module: string, list: TallyConcept[]): MapSection["rows"] =>
  list.map((c) => ({
    module,
    sourceKey: c.key,
    label: c.label,
    hint: c.hint,
    fallback: c.fallback,
  }));

/** Settings → Tally Mapping: every software-side posting slot, module-wise,
 *  against the Tally ledger name the user types. One-time setup. */
export default async function TallyMappingPage() {
  const session = requireSession();
  await authorize(session, "tally", "view");

  const { heads, moneyParties, rows } = await withTenant(session.tenantId, async (tx) => {
    const [heads, moneyParties, rows] = await Promise.all([
      tx.accountHead.findMany({ orderBy: [{ kind: "asc" }, { name: "asc" }] }),
      tx.party.findMany({
        where: { isActive: true, ledgerGroup: { in: ["BANK", "CASH", "CARD"] } },
        orderBy: { name: "asc" },
      }),
      tx.tallyLedgerMap.findMany({ where: { firmId: session.firmId } }),
    ]);
    return { heads, moneyParties, rows };
  });

  const sections: MapSection[] = [
    {
      title: "📦 Chalan",
      desc: "Purchase component-wise + TDS as a separate journal + Commission-Mamool together + Courier separate",
      rows: concepts("CHALAN", CHALAN_CONCEPTS),
    },
    {
      title: "📄 Billing",
      desc: "Sales carries the full bill amount in one line; receipt has separate TDS Receivable / Shortage lines",
      rows: concepts("BILLING", BILLING_CONCEPTS),
    },
    {
      title: "🚛 Broker Slip — Party Side",
      desc: "Owner side uses the same ledgers as Chalan (the ones above)",
      rows: concepts("SLIP_P", SLIP_P_CONCEPTS),
    },
    {
      title: "💳 Receipt / Payment Vouchers",
      desc: "Deduction lines on the Accounts vouchers (TDS, shortage, other, round off)",
      rows: concepts("VOUCHER", VOUCHER_CONCEPTS),
    },
    {
      title: "⛽ Income / Expense Heads",
      desc: "Vehicle & office expenses and the head-wise advances on Chalan — all of them use this mapping",
      rows: heads.map((h) => ({
        module: "HEAD",
        sourceKey: h.id,
        label: h.name,
        hint: h.kind === "INCOME" ? "Income head" : "Expense head",
        fallback: h.name.toUpperCase(),
      })),
    },
    {
      title: "🏦 Bank / Cash / Card",
      desc: "Exact names of these accounts in Tally (not auto-created — enter the exact name)",
      rows: moneyParties.map((p) => ({
        module: "BANKCASH",
        sourceKey: p.id,
        label: p.name,
        hint: p.ledgerGroup,
        fallback: p.name.toUpperCase(),
      })),
    },
  ];

  return (
    <div className="space-y-4 p-4">
      <h1 className="text-xl font-semibold">Tally Ledger Mapping</h1>
      <p className="text-sm text-muted-foreground">
        Against each software head, write the Tally ledger name — the export will post the entry
        into it. Left blank, the software name goes across and that ledger is created automatically
        on Tally import. Parties go across with the same name (for a different name, fill
        &quot;Tally Name&quot; in Party Master).
      </p>
      <TallyMappingClient
        sections={sections}
        existing={rows.map((r) => ({ module: r.module, sourceKey: r.sourceKey, tallyName: r.tallyName }))}
      />
    </div>
  );
}
