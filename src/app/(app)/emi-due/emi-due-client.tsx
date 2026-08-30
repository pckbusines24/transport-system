"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { formatDate, formatMoney } from "@/lib/utils";
import { LOAN_TYPE_LABEL } from "@/lib/loan";
import { Badge } from "@/components/ui/badge";
import { InfoHint } from "@/components/ui/info-hint";
import { Button } from "@/components/ui/button";
import type { MasterOption } from "@/components/data/master-combobox";
import { EmiPayDialog, type EmiPayTarget } from "@/components/finance/emi-pay-dialog";

export interface EmiDueRow {
  loanId: string;
  loanNo: string;
  party: string;
  vehicle: string;
  loanType: string;
  emiAmount: number;
  outstanding: number;
  nextDueDate: string | null;
  remainingEmis: number | null;
}

export function EmiDueClient({
  rows,
  bankOptions,
}: {
  rows: EmiDueRow[];
  bankOptions: MasterOption[];
}) {
  const router = useRouter();
  const [target, setTarget] = React.useState<EmiPayTarget | null>(null);
  const today = new Date();
  today.setHours(23, 59, 59, 999);

  const overdue = rows.filter((r) => r.nextDueDate && new Date(r.nextDueDate) <= today).length;

  return (
    <div className="space-y-3 p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h1 className="page-title flex items-center gap-2">
            EMI Due
            <InfoHint>
              Next due date follows the loan&apos;s schedule and updates automatically after every
              payment — pay early and the cycle still runs from the schedule. Payment uses the
              same popup, voucher and ledger flow as Loan Management.
            </InfoHint>
          </h1>
        </div>
        <div className="rounded-md border bg-muted/40 px-3 py-1.5 text-sm">
          {rows.length} active EMI loan(s)
          {overdue > 0 && <b className="ml-2 text-destructive">{overdue} due / overdue</b>}
        </div>
      </div>

      {/* full list, no pagination */}
      <div className="overflow-x-auto rounded-md border">
        <table className="w-full text-sm">
          <thead className="sticky top-0 bg-muted/80 backdrop-blur">
            <tr>
              {["S.No.", "Vehicle No.", "Loan No", "Lender", "Type", "EMI Amount", "Outstanding", "EMIs Left", "Next EMI Date", "Pay EMI"].map((h) => (
                <th key={h} className="whitespace-nowrap px-2 py-1.5 text-left text-xs font-medium text-muted-foreground">
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 ? (
              <tr>
                <td colSpan={10} className="h-20 text-center text-muted-foreground">
                  No active EMI loans — all cleared!
                </td>
              </tr>
            ) : (
              rows.map((r, i) => {
                const due = r.nextDueDate ? new Date(r.nextDueDate) : null;
                const isDue = !!due && due <= today;
                return (
                  <tr key={r.loanId} className="border-t hover:bg-muted/40">
                    <td className="px-2 py-1.5 tabular-nums">{i + 1}</td>
                    <td className="px-2 py-1.5 font-medium">{r.vehicle || "—"}</td>
                    <td className="px-2 py-1.5">{r.loanNo}</td>
                    <td className="px-2 py-1.5">{r.party}</td>
                    <td className="px-2 py-1.5 text-xs">{LOAN_TYPE_LABEL[r.loanType] ?? r.loanType}</td>
                    <td className="px-2 py-1.5 text-right tabular-nums">
                      {r.emiAmount ? formatMoney(r.emiAmount) : "—"}
                    </td>
                    <td className="px-2 py-1.5 text-right tabular-nums">{formatMoney(r.outstanding)}</td>
                    <td className="px-2 py-1.5 text-center tabular-nums">{r.remainingEmis ?? "—"}</td>
                    <td className="whitespace-nowrap px-2 py-1.5">
                      {r.nextDueDate ? (
                        isDue ? (
                          <Badge variant="destructive">{formatDate(r.nextDueDate)} — Due</Badge>
                        ) : (
                          <span className="font-medium">{formatDate(r.nextDueDate)}</span>
                        )
                      ) : (
                        <span className="text-muted-foreground">No schedule</span>
                      )}
                    </td>
                    <td className="px-2 py-1.5">
                      <Button
                        size="sm"
                        variant={isDue ? "default" : "secondary"}
                        className="h-7 px-3 text-xs"
                        onClick={() => setTarget({ loanId: r.loanId, loanNo: r.loanNo, settlement: false })}
                      >
                        Pay EMI
                      </Button>
                    </td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>

      {/* the SAME popup Loan Management uses */}
      <EmiPayDialog
        target={target}
        onClose={() => setTarget(null)}
        onPaid={() => router.refresh()}
        bankOptions={bankOptions}
      />
    </div>
  );
}
