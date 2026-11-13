"use client";

import * as React from "react";
import Link from "next/link";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { useToast } from "@/components/ui/use-toast";
import { DateInput } from "@/components/data/date-input";
import { Field, NumInput, BankCashCombobox } from "@/components/fleet/fields";
import { formatDate, formatMoney, parseDdMmYyyy } from "@/lib/utils";
import {
  AdvanceAdjustGrid,
  advanceAdjustError,
  advanceAdjustLines,
} from "@/components/chalan/advance-adjust-grid";
import type { OpenAdvance } from "@/lib/party-advance";
import { saveBalancePayment } from "@/app/(app)/chalan/actions";

/**
 * A chalan's balance payment (PENDING -> PAID) — the one payment form, used
 * by the chalan screen and by the Balance Paid Follow-up dashboard. Both call
 * the same saveBalancePayment, so there is a single settlement / voucher /
 * ledger path.
 */
export interface BalancePaymentInfo {
  chalanId: string;
  chalanNo: string;
  /** payable before any voucher settlement (the chalan screen passes its live figure) */
  grossBalance: number;
  /** already settled against this chalan from a Payment Voucher */
  voucherSettled: number;
  paymentStatus: string;
  isFinal: boolean;
  podTotal: number;
  podDone: number;
  /** total shortage weight recorded across the LRs' PODs */
  podShortageWt: number;
  /** the saved settlement's inputs, to prefill an update */
  balRoundOff: number;
  balShortage: number;
  balPaymentDate: string | null;
  balPaymentHeadId: string | null;
  balPaymentMode: string;
  balRemarks: string;
  balReference: string;
  balAdvanceLines: { advanceId: string; amount: number }[];
  /** combined SAVED settlement — display only */
  settledPaid?: number;
  settledShortage?: number;
  settledRoundOff?: number;
  settledAdvanceAdj?: number;
}

export function BalancePaymentPanel({
  info,
  banks,
  advOptions,
  advLoading,
  onSaved,
}: {
  info: BalancePaymentInfo;
  banks: { value: string; label: string; meta?: string }[];
  /** the broker's open advance vouchers for the BALANCE section */
  advOptions: OpenAdvance[];
  advLoading: boolean;
  /** after a successful save — the caller decides where to go next */
  onSaved: (paidAmount: number) => void;
}) {
  const { toast } = useToast();
  const [roundOff, setRoundOff] = React.useState(info.balRoundOff);
  const [shortage, setShortage] = React.useState(info.balShortage);
  const [dateText, setDateText] = React.useState(
    info.balPaymentDate ? formatDate(new Date(info.balPaymentDate)) : formatDate(new Date())
  );
  const [headId, setHeadId] = React.useState<string | null>(info.balPaymentHeadId);
  const [mode, setMode] = React.useState(info.balPaymentMode || "BANK");
  const [remarks, setRemarks] = React.useState(info.balRemarks);
  const [reference, setReference] = React.useState(info.balReference);
  const [adjValues, setAdjValues] = React.useState<Record<string, number>>(() => {
    const v: Record<string, number> = {};
    for (const l of info.balAdvanceLines) v[l.advanceId] = l.amount;
    return v;
  });
  const [saving, setSaving] = React.useState(false);
  const [confirmOpen, setConfirmOpen] = React.useState(false);
  const [paymentStatus, setPaymentStatus] = React.useState(info.paymentStatus);

  const { chalanId, chalanNo, isFinal, podTotal, podDone, voucherSettled } = info;
  const allPodDone = podTotal > 0 && podDone >= podTotal;

  // only what a Payment Voucher has not already settled is available here —
  // the two modules share one outstanding
  const open = Math.round((info.grossBalance - voucherSettled) * 100) / 100;
  const settleable = Math.round((open - roundOff - shortage) * 100) / 100;
  const adjTotal = Math.round(Object.values(adjValues).reduce((s, n) => s + (n || 0), 0) * 100) / 100;
  const paidPreview = Math.round((settleable - adjTotal) * 100) / 100;
  const adjError = advanceAdjustError(advOptions, adjValues, settleable);

  const isoDate = (d: Date) =>
    `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

  const handlePay = () => {
    if (!allPodDone) {
      toast({
        variant: "destructive",
        title: "POD not complete",
        description: `POD is ${podDone}/${podTotal} — all LRs must have a confirmed POD first.`,
      });
      return;
    }
    if (!parseDdMmYyyy(dateText)) {
      toast({ variant: "destructive", title: "Valid payment date is required" });
      return;
    }
    if (adjError) {
      toast({ variant: "destructive", title: "Advance adjustment invalid", description: adjError });
      return;
    }
    // the head is only needed when money actually leaves the bank/cash book
    if (paidPreview > 0.009 && !headId) {
      toast({ variant: "destructive", title: "Select the bank/cash payment head" });
      return;
    }
    // print first, then save — the popup offers both
    setConfirmOpen(true);
  };

  /** Print link carrying the typed (unsaved) balance payment, so the print
      shows it as it will read once saved. */
  const printHref = () => {
    const d = parseDdMmYyyy(dateText);
    const q = new URLSearchParams({
      preview: "1",
      paid: String(paidPreview),
      ro: String(roundOff || 0),
      sh: String(shortage || 0),
      adv: String(adjTotal || 0),
      mode,
      head: headId ?? "",
      rem: remarks,
      ref: reference,
    });
    if (d) q.set("date", isoDate(d));
    return `/print/chalan/${chalanId}?${q.toString()}`;
  };

  const save = async () => {
    const d = parseDdMmYyyy(dateText);
    if (!d) return;
    setConfirmOpen(false);
    setSaving(true);
    try {
      const res = await saveBalancePayment({
        chalanId,
        roundOff,
        shortage,
        paymentDate: isoDate(d),
        paymentHeadId: headId,
        paymentMode: mode as "CASH" | "BANK" | "CARD" | "UPI" | "CHEQUE" | "NEFT_RTGS" | "ADVANCE_ADJ",
        remarks,
        reference: reference || null,
        advanceLines: advanceAdjustLines(advOptions, adjValues).map((l) => ({
          advanceId: l.advanceId,
          amount: l.amount,
        })),
      });
      if (res.ok) {
        setPaymentStatus("PAID");
        toast({
          title: "Balance settled — chalan marked PAID",
          description: `Paid ${formatMoney(res.paidAmount)} — posted to the bank/cash book.`,
        });
        onSaved(res.paidAmount);
      } else {
        toast({ variant: "destructive", title: "Balance payment failed", description: res.error });
      }
    } finally {
      setSaving(false);
    }
  };

  return (
    <>
      <Card id="balance" className={isFinal ? "border-primary/50" : "opacity-70"}>
        <CardHeader className="p-4 pb-2">
          <CardTitle className="flex items-center justify-between text-sm">
            <span className="flex flex-wrap items-center gap-2">
              Balance Payment
              {paymentStatus === "PAID" ? <Badge>PAID</Badge> : <Badge variant="destructive">Pending Balance</Badge>}
            </span>
            {!isFinal ? (
              <span className="text-xs font-normal text-muted-foreground">
                Finalize the chalan first to settle its balance
              </span>
            ) : !allPodDone ? (
              <Badge variant="destructive">POD {podDone}/{podTotal} — complete all PODs to pay balance</Badge>
            ) : (
              <Badge>POD {podDone}/{podTotal} complete</Badge>
            )}
          </CardTitle>
        </CardHeader>
        <CardContent className="grid gap-3 p-4 pt-2 sm:grid-cols-2 lg:grid-cols-4">
          {/* saved settlement at a glance — the money lives on the settlement
              voucher, so the input previews below read 0 once everything is settled */}
          {info.paymentStatus === "PAID" && (
            <div className="rounded-md border bg-muted/40 p-2 text-xs sm:col-span-2 lg:col-span-4">
              <b>Settled:</b> Paid {formatMoney(info.settledPaid ?? 0)}
              {(info.settledShortage ?? 0) > 0.009 && <> · Shortage {formatMoney(info.settledShortage ?? 0)}</>}
              {Math.abs(info.settledRoundOff ?? 0) > 0.009 && (
                <> · Round off {formatMoney(info.settledRoundOff ?? 0)}</>
              )}
              {(info.settledAdvanceAdj ?? 0) > 0.009 && (
                <> · Advance adjusted {formatMoney(info.settledAdvanceAdj ?? 0)}</>
              )}
              {info.balPaymentDate && <> — on {formatDate(info.balPaymentDate)}</>}
              {info.balPaymentMode && <> ({info.balPaymentMode})</>}
              {info.balReference && <> · Ref {info.balReference}</>}
              <span className="text-muted-foreground"> · edit/delete: Voucher Register</span>
            </div>
          )}
          <Field label="Balance Amount">
            <div className="space-y-1">
              <NumInput value={open} readOnly />
              {voucherSettled > 0 && (
                <div className="text-xs text-muted-foreground">
                  {formatMoney(voucherSettled)} of {formatMoney(info.grossBalance)} already settled by a payment
                  voucher
                </div>
              )}
            </div>
          </Field>
          <Field label="Round Off (−)">
            <NumInput value={roundOff} onChange={setRoundOff} />
          </Field>
          <Field label="Shortage (−)">
            <div className="space-y-1">
              <NumInput value={shortage} onChange={setShortage} />
              {info.podShortageWt > 0 && (
                <div className="text-xs text-muted-foreground">
                  POD shortage: {info.podShortageWt} (wt) — enter the amount to deduct
                </div>
              )}
            </div>
          </Field>
          <Field label="Advance Adjusted (−)">
            <NumInput value={adjTotal} readOnly />
          </Field>
          <Field label="Final Paid Amount">
            <NumInput value={paidPreview} readOnly />
          </Field>
          <div className="sm:col-span-2 lg:col-span-4">
            <div className="mb-1 text-xs text-muted-foreground">
              Advance Adjustment — settle the balance against this party&apos;s advance vouchers
            </div>
            <AdvanceAdjustGrid
              advances={advOptions}
              values={adjValues}
              onChange={setAdjValues}
              payable={settleable}
              loading={advLoading}
            />
          </div>
          <Field label="Payment Date">
            <DateInput value={dateText} onChange={(t) => setDateText(t)} />
          </Field>
          <Field label="Payment Head (Bank / Cash)">
            <BankCashCombobox options={banks} value={headId} onChange={setHeadId} placeholder="Select head..." />
          </Field>
          <Field label="Payment Mode">
            <select
              className="h-9 w-full rounded-md border border-input bg-background px-2 text-sm"
              value={mode}
              onChange={(e) => setMode(e.target.value)}
            >
              <option value="BANK">Bank Transfer</option>
              <option value="CASH">Cash</option>
              <option value="CARD">Card</option>
              <option value="UPI">UPI</option>
              <option value="CHEQUE">Cheque</option>
              <option value="NEFT_RTGS">NEFT / RTGS</option>
              <option value="ADVANCE_ADJ">Advance Adjustment</option>
            </select>
          </Field>
          <Field label="UTR / Cheque / Txn No">
            <Input value={reference} onChange={(e) => setReference(e.target.value)} maxLength={60} />
          </Field>
          <Field label="Remarks">
            <Input value={remarks} onChange={(e) => setRemarks(e.target.value)} />
          </Field>
          <div className="flex items-end sm:col-span-2 lg:col-span-4">
            <Button type="button" onClick={handlePay} disabled={saving || !isFinal || !allPodDone || !!adjError}>
              {saving ? "Saving..." : paymentStatus === "PAID" ? "Print & Update" : "Print & Save"}
            </Button>
          </div>
        </CardContent>
      </Card>

      <Dialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Balance payment — chalan {chalanNo}</DialogTitle>
            <DialogDescription>
              Print the chalan with this balance payment to check the figures, then save it. Nothing is saved
              until you click Save.
            </DialogDescription>
          </DialogHeader>
          <div className="text-sm">
            Paying <span className="font-semibold tabular-nums">{formatMoney(paidPreview)}</span>
          </div>
          <DialogFooter className="gap-2 sm:gap-2">
            <Button type="button" variant="outline" onClick={() => setConfirmOpen(false)}>
              Cancel
            </Button>
            <Button asChild type="button" variant="outline">
              <Link href={printHref()} target="_blank">
                Print
              </Link>
            </Button>
            <Button type="button" onClick={() => void save()} disabled={saving}>
              Save
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
