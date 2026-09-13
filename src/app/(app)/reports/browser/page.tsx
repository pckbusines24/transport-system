import { requireSession } from "@/lib/session";
import { authorize } from "@/lib/authz";
import { withTenant } from "@/lib/db";
import { COMMON_HEADS } from "@/lib/account-heads";
import { BrowserClient, type FyChips, type MonthChip } from "./browser-client";
import type { BrowseSrc } from "./actions";
import { partyMeta } from "@/lib/party-option";

export const dynamic = "force-dynamic";

const TITLES: Record<BrowseSrc, string> = {
  LR: "LR Register — Month Browser",
  CHALAN_MARKET: "Chalan Register (Market / Broker) — Month Browser",
  CHALAN_OWNREL: "Chalan Register (Own / Relative) — Month Browser",
  POD: "POD Register — Month Browser",
  BROKER: "Broker Register — Month Browser",
  BILLING: "Billing Register — Month Browser",
  OUT_RECV: "Outstanding Receivable — Month Browser",
  OUT_PAY: "Outstanding Payable — Month Browser",
  VOUCHER: "Voucher Register — Month Browser",
  BOOK_BANK: "Bank Book — Month Browser",
  BOOK_CASH: "Cash Book — Month Browser",
  BOOK_CARD: "Card Book — Month Browser",
  LEDGER: "Ledger Summary — Month Browser",
  COMMON: "Common Ledgers — Month Browser",
  TDS_PAY: "TDS Payable — Month Browser",
  TDS_RECV: "TDS Receivable — Month Browser",
};

const MONTH_NAMES = ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"];

export default async function ReportsBrowserPage({
  searchParams,
}: {
  searchParams: { src?: string };
}) {
  const session = requireSession();
  await authorize(session, "reports", "view");
  const src = (searchParams.src && searchParams.src in TITLES ? searchParams.src : "LR") as BrowseSrc;

  const { fyChips, partyOptions, vehicleOptions, headOptions, partyLabel } = await withTenant(
    session.tenantId,
    async (tx) => {
      // FY continuity: month chips for EVERY financial year of the firm — an
      // in-report FY dropdown swaps the chip row, no session-FY switch needed
      const fys = await tx.financialYear.findMany({
        where: { firmId: session.firmId },
        orderBy: { startDate: "desc" },
      });
      const fyChips: FyChips[] = fys.map((fy) => {
        const months: MonthChip[] = [{ value: "ALL", label: "ALL" }];
        const d = new Date(fy.startDate);
        d.setDate(1);
        const end = new Date(fy.endDate);
        while (d <= end && months.length <= 13) {
          const value = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
          months.push({ value, label: `${MONTH_NAMES[d.getMonth()]} ${String(d.getFullYear()).slice(2)}` });
          d.setMonth(d.getMonth() + 1);
        }
        return { fyId: fy.id, label: fy.label, months };
      });

      // which pickers the source needs
      let partyOptions: { value: string; label: string }[] = [];
      let vehicleOptions: { value: string; label: string }[] = [];
      let headOptions: string[] = [];
      let partyLabel = "Party...";

      const activeParties = () =>
        tx.party.findMany({
          where: { isActive: true, ledgerGroup: { notIn: ["BANK", "CASH", "CARD"] } },
          orderBy: { name: "asc" },
          select: { id: true, name: true, transportName: true, alias: true },
        });
      const activeVehicles = () =>
        tx.vehicle.findMany({ where: { isActive: true }, orderBy: { number: "asc" }, select: { id: true, number: true } });

      if (src === "BOOK_BANK" || src === "BOOK_CASH" || src === "BOOK_CARD") {
        const group = src === "BOOK_BANK" ? "BANK" : src === "BOOK_CASH" ? "CASH" : "CARD";
        const accounts = await tx.party.findMany({ where: { ledgerGroup: group }, orderBy: { name: "asc" } });
        partyOptions = accounts.map((a) => ({ value: a.id, label: a.name }));
        partyLabel = "Account (for running balance)...";
      } else if (src === "LEDGER") {
        const parties = await activeParties();
        partyOptions = parties.map((p) => ({ value: p.id, label: p.name, meta: partyMeta(p) }));
        partyLabel = "Select ledger *";
      } else if (src === "COMMON") {
        headOptions = COMMON_HEADS.filter((h) => h.name !== "TDS Payable" && h.name !== "TDS Receivable").map((h) => h.name);
      } else if (src === "TDS_PAY" || src === "TDS_RECV") {
        // no pickers — the head IS the report
      } else {
        const [parties, vehicles] = await Promise.all([activeParties(), activeVehicles()]);
        partyOptions = parties.map((p) => ({ value: p.id, label: p.name, meta: partyMeta(p) }));
        vehicleOptions = vehicles.map((v) => ({ value: v.id, label: v.number }));
        if (src === "CHALAN_MARKET") partyLabel = "Broker...";
        if (src === "BILLING" || src === "OUT_RECV") partyLabel = "Bill party...";
        if (src === "POD") partyOptions = [];
      }
      return { fyChips, partyOptions, vehicleOptions, headOptions, partyLabel };
    }
  );

  return (
    <BrowserClient
      key={src}
      src={src}
      title={TITLES[src]}
      fyChips={fyChips}
      defaultFy={session.fyId}
      partyOptions={partyOptions}
      partyLabel={partyLabel}
      vehicleOptions={vehicleOptions}
      headOptions={headOptions}
      requireParty={src === "LEDGER"}
      hasObd={src === "LR"}
    />
  );
}
