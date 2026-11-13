"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { useToast } from "@/components/ui/use-toast";
import { ExportButton } from "@/components/data/export-button";
import { formatDate, formatMoney } from "@/lib/utils";
import type { OpenAdvance } from "@/lib/party-advance";
import { getBrokerAdvances, getChalanBalancePayContext } from "@/app/(app)/chalan/actions";
import { BalancePaymentPanel, type BalancePaymentInfo } from "@/components/chalan/balance-payment-panel";

export interface BalanceFollowUpRow {
  chalanId: string;
  chalanNo: string;
  lrNos: string;
  vehicleNo: string;
  broker: string;
  /** first party, "+N" when the chalan's LRs belong to several */
  party: string;
  partyNames: string[];
  /** IST calendar day of the LAST POD entry, yyyy-mm-dd */
  podEntryIso: string;
  dueIso: string;
  total: number;
  paid: number;
  balance: number;
  pendingDays: number;
  status: "UNPAID" | "PARTIAL";
}

const isoToText = (iso: string) => formatDate(new Date(`${iso}T00:00:00+05:30`));

interface PayState {
  chalanNo: string;
  info: BalancePaymentInfo | null;
  banks: { value: string; label: string; meta?: string }[];
  advOptions: OpenAdvance[];
  advLoading: boolean;
}

export function BalanceFollowUpTable({
  rows,
  allRows,
  startIndex,
  totalBalance,
}: {
  /** this page */
  rows: BalanceFollowUpRow[];
  /** every filtered row — the export takes all of them, not one page */
  allRows: BalanceFollowUpRow[];
  startIndex: number;
  totalBalance: number;
}) {
  const router = useRouter();
  const { toast } = useToast();
  const [pay, setPay] = React.useState<PayState | null>(null);

  // the pop-up keeps the page, filters, search and page number untouched;
  // after the save only the data refreshes (a fully paid chalan drops out)
  const openPay = async (r: BalanceFollowUpRow) => {
    setPay({ chalanNo: r.chalanNo, info: null, banks: [], advOptions: [], advLoading: true });
    const res = await getChalanBalancePayContext(r.chalanId);
    if (!res.ok) {
      setPay(null);
      toast({ variant: "destructive", title: "Could not open the payment", description: res.error });
      return;
    }
    setPay((p) => (p ? { ...p, info: res.info, banks: res.banks } : p));
    const adv = await getBrokerAdvances(res.brokerId, r.chalanId, "BALANCE").catch(() => []);
    setPay((p) => (p ? { ...p, advOptions: adv, advLoading: false } : p));
  };

  const cell = "border px-2 py-1";

  return (
    <div className="space-y-2">
      <div className="flex justify-end">
        <ExportButton
          rows={allRows.map((r) => ({
            ...r,
            podEntry: isoToText(r.podEntryIso),
            due: isoToText(r.dueIso),
            category: "Broker",
          }))}
          fileName="balance-paid-follow-up"
          sheetName="Balance Follow-up"
          columns={[
            { header: "LR / Bilty No", key: "lrNos" },
            { header: "Chalan No", key: "chalanNo" },
            { header: "Vehicle No", key: "vehicleNo" },
            { header: "Vehicle Category", key: "category" },
            { header: "Broker", key: "broker" },
            { header: "Party", key: "party" },
            { header: "POD Entry Date", key: "podEntry" },
            { header: "Follow-up Due Date", key: "due" },
            { header: "Total Chalan Amount", key: "total", numeric: true },
            { header: "Paid Amount", key: "paid", numeric: true },
            { header: "Balance Amount", key: "balance", numeric: true },
            { header: "Pending Days", key: "pendingDays", numeric: true },
            { header: "Payment Status", key: "status" },
          ]}
          summary={[
            { label: "Chalans", value: allRows.length },
            { label: "Pending Balance", value: totalBalance },
          ]}
        />
      </div>

      <div className="overflow-x-auto rounded-md border">
        <table className="w-full border-collapse text-xs">
          <thead>
            <tr>
              {[
                "Sr.",
                "LR / Bilty No",
                "Chalan No",
                "Vehicle No",
                "Category",
                "Broker",
                "Party",
                "POD Entry",
                "Due Date",
                "Total",
                "Paid",
                "Balance",
                "Pending Days",
                "Status",
                "",
              ].map((h, i) => (
                <th key={`${h}-${i}`} className={`${cell} bg-muted/60 text-left font-semibold`}>
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => (
              <tr key={r.chalanId}>
                <td className={cell}>{startIndex + i + 1}</td>
                <td className={cell}>{r.lrNos}</td>
                <td className={`${cell} font-medium`}>
                  <a className="text-primary hover:underline" href={`/chalan?id=${r.chalanId}`}>
                    {r.chalanNo}
                  </a>
                </td>
                <td className={`${cell} whitespace-nowrap`}>{r.vehicleNo}</td>
                <td className={cell}>Broker</td>
                <td className={cell}>{r.broker}</td>
                <td className={cell} title={r.partyNames.join(", ")}>
                  {r.party}
                </td>
                <td className={`${cell} whitespace-nowrap`}>{isoToText(r.podEntryIso)}</td>
                <td className={`${cell} whitespace-nowrap`}>{isoToText(r.dueIso)}</td>
                <td className={`${cell} text-right tabular-nums`}>{formatMoney(r.total)}</td>
                <td className={`${cell} text-right tabular-nums`}>{formatMoney(r.paid)}</td>
                <td className={`${cell} text-right font-semibold tabular-nums`}>{formatMoney(r.balance)}</td>
                <td className={cell}>
                  <Badge variant={r.pendingDays > 7 ? "destructive" : "outline"}>{r.pendingDays} days</Badge>
                </td>
                <td className={cell}>
                  <Badge variant={r.status === "PARTIAL" ? "secondary" : "destructive"}>{r.status}</Badge>
                </td>
                <td className={cell}>
                  <Button size="sm" className="h-7" onClick={() => void openPay(r)}>
                    Pay Now
                  </Button>
                </td>
              </tr>
            ))}
            {!rows.length && (
              <tr>
                <td colSpan={15} className={`${cell} py-6 text-center text-muted-foreground`}>
                  No broker chalan balance is pending past its follow-up date.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      <Dialog open={!!pay} onOpenChange={(o) => !o && setPay(null)}>
        <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-4xl">
          <DialogHeader>
            <DialogTitle>Balance payment — chalan {pay?.chalanNo}</DialogTitle>
          </DialogHeader>
          {pay && !pay.info && <div className="p-6 text-sm text-muted-foreground">Loading...</div>}
          {pay?.info && (
            <BalancePaymentPanel
              key={pay.info.chalanId}
              info={pay.info}
              banks={pay.banks}
              advOptions={pay.advOptions}
              advLoading={pay.advLoading}
              onSaved={() => {
                // same page, same filters: only the data refreshes
                setPay(null);
                router.refresh();
              }}
            />
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}
