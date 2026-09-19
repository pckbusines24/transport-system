"use client";

import * as React from "react";
import { formatDate, formatMoney, parseDdMmYyyy } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useToast } from "@/components/ui/use-toast";
import { DateInput } from "@/components/data/date-input";
import type { MasterOption } from "@/components/data/master-combobox";
import { BankCashCombobox } from "@/components/fleet/fields";
import { getEmiSuggestion, payLoanEmi } from "@/app/(app)/finance/actions";

/**
 * THE EMI payment popup — one component shared by the Loan Register and the
 * EMI Due page, so the same suggestion, validation, voucher and ledger logic
 * applies no matter where the payment starts.
 */

export interface EmiPayTarget {
  loanId: string;
  loanNo: string;
  settlement: boolean;
}

function textToIso(text: string): string {
  const d = parseDdMmYyyy(text);
  if (!d) return "";
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${d.getFullYear()}-${mm}-${dd}`;
}

const emptyForm = {
  payDateText: formatDate(new Date()),
  outstanding: 0,
  principal: 0,
  interest: 0,
  penalty: 0,
  otherAmt: 0,
  tdsAmt: 0,
  bankPartyId: null as string | null,
  remarks: "",
};

export function EmiPayDialog({
  target,
  onClose,
  onPaid,
  bankOptions,
}: {
  /** null = closed */
  target: EmiPayTarget | null;
  onClose: () => void;
  onPaid: () => void;
  bankOptions: MasterOption[];
}) {
  const { toast } = useToast();
  const [busy, setBusy] = React.useState(false);
  const [form, setForm] = React.useState(emptyForm);
  const set = (p: Partial<typeof emptyForm>) => setForm((f) => ({ ...f, ...p }));

  // every figure pre-calculated by the same server suggestion the register uses
  React.useEffect(() => {
    if (!target) return;
    let cancelled = false;
    void getEmiSuggestion(target.loanId).then((s) => {
      if (cancelled) return;
      if (!s) {
        toast({ variant: "destructive", title: "Loan not found" });
        onClose();
        return;
      }
      setForm({
        ...emptyForm,
        payDateText: formatDate(new Date()),
        outstanding: s.outstanding,
        principal: target.settlement ? s.outstanding : s.principal,
        interest: s.interest,
        tdsAmt: s.tds,
      });
    });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [target?.loanId, target?.settlement]);

  const total =
    Math.round((form.principal + form.interest + form.penalty + form.otherAmt) * 100) / 100;
  const net = Math.round((total - form.tdsAmt) * 100) / 100;

  const submit = async () => {
    if (!target) return;
    setBusy(true);
    try {
      const res = await payLoanEmi({
        loanId: target.loanId,
        payDate: textToIso(form.payDateText),
        principal: form.principal,
        interest: form.interest,
        penalty: form.penalty,
        otherAmt: form.otherAmt,
        tdsAmt: form.tdsAmt,
        bankPartyId: form.bankPartyId ?? "",
        isSettlement: target.settlement,
        remarks: form.remarks,
      });
      if (res.ok) {
        toast({
          title: target.settlement ? "Loan closed" : "EMI recorded",
          description: `Voucher ${res.voucherNo} posted`,
        });
        onClose();
        onPaid();
      } else toast({ variant: "destructive", title: "Payment failed", description: res.error });
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={!!target} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>
            {target?.settlement ? "Full Settlement" : "Pay EMI"} — {target?.loanNo}
          </DialogTitle>
          <DialogDescription>
            Outstanding principal {formatMoney(form.outstanding)}. Every figure below is
            calculated for you and can be changed if the lender&apos;s statement differs.
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-3 sm:grid-cols-3">
          <div className="space-y-1">
            <Label className="text-xs">Payment Date *</Label>
            <DateInput className="h-8" value={form.payDateText} onChange={(t) => set({ payDateText: t })} />
          </div>
          <div className="space-y-1">
            <Label className="text-xs">Principal</Label>
            <Input
              type="number"
              className="h-8 text-right"
              value={form.principal ? String(form.principal) : ""}
              onChange={(e) => set({ principal: Number(e.target.value) || 0 })}
            />
          </div>
          <div className="space-y-1">
            <Label className="text-xs">Interest</Label>
            <Input
              type="number"
              className="h-8 text-right"
              value={form.interest ? String(form.interest) : ""}
              onChange={(e) => set({ interest: Number(e.target.value) || 0 })}
            />
          </div>
          <div className="space-y-1">
            <Label className="text-xs">Penalty</Label>
            <Input
              type="number"
              className="h-8 text-right"
              value={form.penalty ? String(form.penalty) : ""}
              onChange={(e) => set({ penalty: Number(e.target.value) || 0 })}
            />
          </div>
          <div className="space-y-1">
            <Label className="text-xs">Other Charges</Label>
            <Input
              type="number"
              className="h-8 text-right"
              value={form.otherAmt ? String(form.otherAmt) : ""}
              onChange={(e) => set({ otherAmt: Number(e.target.value) || 0 })}
            />
          </div>
          <div className="space-y-1">
            <Label className="text-xs">Less TDS (on interest)</Label>
            <Input
              type="number"
              className="h-8 text-right"
              value={form.tdsAmt ? String(form.tdsAmt) : ""}
              onChange={(e) => set({ tdsAmt: Number(e.target.value) || 0 })}
            />
          </div>
          <div className="space-y-1 sm:col-span-2">
            <Label className="text-xs">Bank / Cash *</Label>
            <BankCashCombobox
              options={bankOptions}
              value={form.bankPartyId}
              onChange={(v) => set({ bankPartyId: v })}
              placeholder="Select account..."
            />
          </div>
          <div className="space-y-1">
            <Label className="text-xs">Remarks</Label>
            <Input className="h-8" value={form.remarks} onChange={(e) => set({ remarks: e.target.value })} />
          </div>
        </div>
        <div className="flex flex-wrap gap-4 rounded-md border bg-muted/40 p-2 text-xs">
          <span>
            Instalment <b>{formatMoney(total)}</b>
          </span>
          <span>
            Bank movement <b>{formatMoney(net)}</b>
          </span>
          <span>
            Outstanding after <b>{formatMoney(Math.max(0, form.outstanding - form.principal))}</b>
          </span>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button onClick={submit} disabled={busy || total <= 0 || !form.bankPartyId}>
            {busy ? "Saving..." : target?.settlement ? "Close Loan" : "Save EMI"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
