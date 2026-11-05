import * as React from "react";
import { requireSession } from "@/lib/session";
import { authorize } from "@/lib/authz";
import { withTenant } from "@/lib/db";
import { formatDate, formatMoney, istDayEnd, istDayStart } from "@/lib/utils";
import { buildTdsPayableRows } from "@/app/(app)/accounts/tds/payable-rows";
import {
  buildQuarterlyData,
  QUARTERS,
  QUARTER_MONTHS,
} from "@/app/(app)/reports/tds-quarterly/data";
import { PrintToolbar } from "./print-toolbar";

export const dynamic = "force-dynamic";

/**
 * Printable TDS Report – Quarterly Wise (payable only). Reads the SAME
 * builder + grouping the on-screen report uses, with the same filter params,
 * so paper and screen can never disagree. Landscape-width layout; the browser
 * print dialog's "Save as PDF" is the PDF export.
 */
export default async function TdsQuarterlyPrintPage({
  searchParams,
}: {
  searchParams: {
    party?: string;
    rate?: string;
    quarter?: string;
    date_from?: string;
    date_to?: string;
  };
}) {
  const session = requireSession();
  await authorize(session, "reports", "view");

  const dateWhere =
    searchParams.date_from || searchParams.date_to
      ? {
          ...(searchParams.date_from ? { gte: istDayStart(searchParams.date_from) } : {}),
          ...(searchParams.date_to ? { lte: istDayEnd(searchParams.date_to) } : {}),
        }
      : undefined;

  const { firm, rows, parties } = await withTenant(session.tenantId, async (tx) => {
    const [firm, built] = await Promise.all([
      tx.firm.findUnique({ where: { id: session.firmId } }),
      buildTdsPayableRows(tx, session, dateWhere),
    ]);
    return { firm, ...built };
  });

  const partyName = searchParams.party
    ? parties.find((p) => p.id === searchParams.party)?.name ?? ""
    : undefined;
  // filter on the stable party id (same as the on-screen report); the name is
  // only used for the printed filter line below
  const data = buildQuarterlyData(rows, {
    partyId: searchParams.party,
    rate: searchParams.rate,
    quarter: searchParams.quarter,
  });

  const filterLine = [
    partyName && `Party: ${partyName}`,
    searchParams.rate && `TDS Rate: ${searchParams.rate}%`,
    searchParams.quarter && `Quarter: ${searchParams.quarter}`,
    searchParams.date_from && `From: ${formatDate(searchParams.date_from)}`,
    searchParams.date_to && `To: ${formatDate(searchParams.date_to)}`,
  ]
    .filter(Boolean)
    .join(" | ");

  const money = (n: number) => (Math.abs(n) > 0.009 ? formatMoney(n) : "-");
  const num = "border border-black px-1 py-0.5 text-right tabular-nums";
  const txt = "border border-black px-1 py-0.5";

  return (
    <div className="bg-white p-4 text-black">
      <PrintToolbar />
      <div className="mx-auto max-w-[277mm] border border-black p-4 text-sm">
        <div className="border-b border-black pb-2 text-center">
          <div className="text-xl font-bold uppercase">{firm?.name}</div>
          <div className="text-xs">
            {[firm?.address1, firm?.address2].filter(Boolean).join(", ")}
          </div>
          <div className="text-xs">
            {[
              firm?.gstin && `GSTIN: ${firm.gstin}`,
              firm?.pan && `PAN: ${firm.pan}`,
            ]
              .filter(Boolean)
              .join(" | ")}
          </div>
          <div className="mt-1 text-sm font-semibold">
            TDS REPORT – QUARTERLY WISE (PAYABLE){session.fyLabel ? ` — FY ${session.fyLabel}` : ""}
          </div>
          <div className="text-[11px]">
            TDS deducted by us from parties/suppliers · Q1 Apr–Jun · Q2 Jul–Sep · Q3 Oct–Dec · Q4
            Jan–Mar{filterLine ? ` · ${filterLine}` : ""}
          </div>
        </div>

        <table className="mt-3 w-full border-collapse text-xs">
          <thead>
            <tr>
              <th className={`${txt} text-left`}>Party</th>
              <th className={`${txt} text-left`}>Rate</th>
              {QUARTERS.map((q, i) => (
                <th key={q} colSpan={2} className={`${txt} text-center`}>
                  {q} ({QUARTER_MONTHS[i]})
                </th>
              ))}
              <th colSpan={2} className={`${txt} text-center`}>
                FY Total
              </th>
            </tr>
            <tr>
              <th className={txt} />
              <th className={txt} />
              {QUARTERS.map((q) => (
                <React.Fragment key={q}>
                  <th className={`${num} font-semibold`}>Base</th>
                  <th className={`${num} font-semibold`}>TDS</th>
                </React.Fragment>
              ))}
              <th className={`${num} font-semibold`}>Base</th>
              <th className={`${num} font-semibold`}>TDS</th>
            </tr>
          </thead>
          <tbody>
            {data.parties.length === 0 && (
              <tr>
                <td colSpan={12} className={`${txt} py-4 text-center`}>
                  No payable TDS transactions for the selected filters.
                </td>
              </tr>
            )}
            {data.parties.map((p) => (
              <React.Fragment key={p.party}>
                {p.rates.map((g, gi) => (
                  <tr key={`${p.party}-${g.label}`}>
                    <td className={txt}>
                      {gi === 0 ? `${p.party}${p.pan ? ` (${p.pan})` : ""}` : ""}
                    </td>
                    <td className={txt}>{g.label}</td>
                    {QUARTERS.map((q, qi) => (
                      <React.Fragment key={q}>
                        <td className={num}>{money(g.cells[qi].base)}</td>
                        <td className={num}>{money(g.cells[qi].tds)}</td>
                      </React.Fragment>
                    ))}
                    <td className={`${num} font-semibold`}>{money(g.totalBase)}</td>
                    <td className={`${num} font-semibold`}>{money(g.totalTds)}</td>
                  </tr>
                ))}
                {p.rates.length > 1 && (
                  <tr className="font-semibold">
                    <td className={txt}>{p.party} — Total</td>
                    <td className={txt} />
                    {QUARTERS.map((q, qi) => (
                      <React.Fragment key={q}>
                        <td className={num}>{money(p.cells[qi].base)}</td>
                        <td className={num}>{money(p.cells[qi].tds)}</td>
                      </React.Fragment>
                    ))}
                    <td className={num}>{money(p.totalBase)}</td>
                    <td className={num}>{money(p.totalTds)}</td>
                  </tr>
                )}
              </React.Fragment>
            ))}
            {data.parties.length > 0 && (
              <tr className="font-bold">
                <td className={txt}>GRAND TOTAL</td>
                <td className={txt} />
                {QUARTERS.map((q, qi) => (
                  <React.Fragment key={q}>
                    <td className={num}>{money(data.grand.cells[qi].base)}</td>
                    <td className={num}>{money(data.grand.cells[qi].tds)}</td>
                  </React.Fragment>
                ))}
                <td className={num}>{money(data.grand.totalBase)}</td>
                <td className={num}>{money(data.grand.totalTds)}</td>
              </tr>
            )}
          </tbody>
        </table>

        <div className="mt-6 flex justify-between text-xs">
          <div>Printed on {formatDate(new Date())}</div>
          <div>For {firm?.name}</div>
        </div>
      </div>
    </div>
  );
}
