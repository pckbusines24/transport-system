import type { LedgerGroup } from "@prisma/client";
import { requireSession } from "@/lib/session";
import { authorize } from "@/lib/authz";
import { FilterBar, type FilterDef } from "@/components/data/filter-bar";
import { SimpleReport } from "@/components/accounts/simple-report";
import { BOOK_COLUMNS, ledgerBookRows } from "../_lib/book";

export const dynamic = "force-dynamic";

/**
 * Bank / Cash / Card Book — one register for every money account. A CARD
 * (fuel / fleet card) is just another account: payments draw it down, a
 * contra voucher from a bank recharges it.
 */
export default async function BankBookPage({
  searchParams,
}: {
  searchParams: {
    date_from?: string;
    date_to?: string;
    party?: string;
    type?: string;
    account?: string;
    ref?: string;
    voucher?: string;
    side?: string;
  };
}) {
  const session = requireSession();
  await authorize(session, "reports", "view");

  const type = ["BANK", "CASH", "CARD"].includes(searchParams.type ?? "")
    ? (searchParams.type as LedgerGroup)
    : undefined;

  const side = searchParams.side === "DEBIT" || searchParams.side === "CREDIT" ? searchParams.side : undefined;
  const { rows, parties, counters } = await ledgerBookRows({
    session,
    groups: type ? [type] : ["BANK", "CASH", "CARD"],
    partyId: searchParams.party,
    dateFrom: searchParams.date_from,
    dateTo: searchParams.date_to,
    refNo: searchParams.ref?.trim() || undefined,
    voucherNo: searchParams.voucher?.trim() || undefined,
    counter: searchParams.account || undefined,
    side,
  });

  const filters: FilterDef[] = [
    { type: "daterange", key: "date", label: "Date" },
    {
      type: "select",
      key: "type",
      label: "Account Type",
      options: [
        { value: "BANK", label: "Bank" },
        { value: "CASH", label: "Cash" },
        { value: "CARD", label: "Card" },
      ],
    },
    {
      type: "combobox",
      key: "party",
      label: "Account",
      options: parties.map((p) => ({ value: p.id, label: `${p.name} (${p.ledgerGroup})` })),
    },
    {
      type: "combobox",
      key: "account",
      label: "Account (counter ledger)",
      options: counters.map((c) => ({ value: c, label: c })),
    },
    { type: "text", key: "ref", label: "Reference No" },
    { type: "text", key: "voucher", label: "Voucher No" },
    {
      type: "select",
      key: "side",
      label: "Debit / Credit",
      options: [
        { value: "DEBIT", label: "Debit only" },
        { value: "CREDIT", label: "Credit only" },
      ],
    },
  ];

  return (
    <div className="space-y-4 p-4">
      <h1 className="page-title">Bank / Cash / Card Book</h1>
      <FilterBar filters={filters} />
      <SimpleReport
        title={
          searchParams.party
            ? "Running balance shown for selected account"
            : "Select an account to see running balance"
        }
        columns={BOOK_COLUMNS}
        rows={rows}
        fileName="bank-cash-card-book"
        emptyMessage="No entries in this period."
      />
    </div>
  );
}
