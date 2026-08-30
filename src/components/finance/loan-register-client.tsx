"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import type { ColumnDef } from "@tanstack/react-table";
import { IndianRupee, Pencil, Plus, Printer, Trash2, Wallet } from "lucide-react";
import { formatDate, formatMoney, parseDdMmYyyy } from "@/lib/utils";
import { LOAN_TYPE_LABEL } from "@/lib/loan";
import { Badge } from "@/components/ui/badge";
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useToast } from "@/components/ui/use-toast";
import { DataTable, type DataTableColumnMeta } from "@/components/data/data-table";
import { DateInput } from "@/components/data/date-input";
import { ExportButton } from "@/components/data/export-button";
import { MasterCombobox, type MasterOption } from "@/components/data/master-combobox";
import { deleteLoan, saveLoan } from "@/app/(app)/finance/actions";
import { EmiPayDialog, type EmiPayTarget } from "@/components/finance/emi-pay-dialog";
import type { LoanRow } from "@/app/(app)/finance/queries";

function textToIso(text: string): string {
  const d = parseDdMmYyyy(text);
  if (!d) return "";
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${d.getFullYear()}-${mm}-${dd}`;
}

const emptyLoan = {
  id: null as string | null,
  loanNo: "",
  dateText: formatDate(new Date()),
  partyId: null as string | null,
  loanType: "BUSINESS_TAKEN",
  purpose: "",
  vehicleId: null as string | null,
  amount: 0,
  interestMode: "NONE",
  interestRate: 0,
  emiApplicable: false,
  emiAmount: 0,
  emiStartText: "",
  emiFrequency: "MONTHLY",
  tenureMonths: 0,
  tdsApplicable: false,
  tdsPct: 0,
  bankPartyId: null as string | null,
  postDisbursement: true,
  remarks: "",
};

/**
 * Loan Register — the whole module in one screen. A user only ever needs three
 * actions: create the loan, pay an instalment, close it. Interest, TDS, the
 * voucher and every ledger posting happen in the background.
 */
export function LoanRegisterClient({
  loans,
  partyOptions,
  bankOptions,
  vehicleOptions,
  canDelete,
}: {
  loans: LoanRow[];
  partyOptions: MasterOption[];
  bankOptions: MasterOption[];
  vehicleOptions: MasterOption[];
  canDelete: boolean;
}) {
  const router = useRouter();
  const { toast } = useToast();
  const [busy, setBusy] = React.useState(false);
  const [loanOpen, setLoanOpen] = React.useState(false);
  const [loanForm, setLoanForm] = React.useState(emptyLoan);
  // shared EMI popup (same component the EMI Due page uses)
  const [emiTarget, setEmiTarget] = React.useState<EmiPayTarget | null>(null);
  const [toDelete, setToDelete] = React.useState<LoanRow | null>(null);
  const [view, setView] = React.useState<LoanRow | null>(null);

  const setLoan = (p: Partial<typeof emptyLoan>) => setLoanForm((f) => ({ ...f, ...p }));

  const openNew = () => {
    setLoanForm(emptyLoan);
    setLoanOpen(true);
  };

  const openEdit = React.useCallback((l: LoanRow) => {
    setLoanForm({
      id: l.id,
      loanNo: l.loanNo,
      dateText: formatDate(l.date),
      partyId: l.partyId,
      loanType: l.loanType,
      purpose: l.purpose,
      vehicleId: l.vehicleId,
      amount: l.amount,
      interestMode: l.interestMode,
      interestRate: l.interestRate,
      emiApplicable: l.emiAmount > 0,
      emiAmount: l.emiAmount,
      emiStartText: l.emiStartDate ? formatDate(l.emiStartDate) : "",
      emiFrequency: l.emiFrequency,
      tenureMonths: l.tenureMonths,
      tdsApplicable: l.tdsApplicable,
      tdsPct: l.tdsPct,
      bankPartyId: null,
      // the disbursement was posted when the loan was created; re-posting it on
      // an edit would double the money that changed hands
      postDisbursement: false,
      remarks: l.remarks,
    });
    setLoanOpen(true);
  }, []);

  /** Open the shared EMI popup with every figure pre-calculated. */
  const openEmi = React.useCallback((l: LoanRow, settlement: boolean) =>
    setEmiTarget({ loanId: l.id, loanNo: l.loanNo, settlement }), []);

  const submitLoan = async () => {
    setBusy(true);
    try {
      const res = await saveLoan({
        id: loanForm.id,
        loanNo: loanForm.loanNo,
        date: textToIso(loanForm.dateText),
        partyId: loanForm.partyId ?? "",
        loanType: loanForm.loanType,
        purpose: loanForm.purpose,
        vehicleId: loanForm.vehicleId,
        amount: loanForm.amount,
        interestMode: loanForm.interestMode,
        interestRate: loanForm.interestRate,
        emiApplicable: loanForm.emiApplicable,
        emiAmount: loanForm.emiAmount,
        emiStartDate: loanForm.emiStartText ? textToIso(loanForm.emiStartText) : null,
        emiFrequency: loanForm.emiFrequency,
        tenureMonths: loanForm.tenureMonths,
        tdsApplicable: loanForm.tdsApplicable,
        tdsPct: loanForm.tdsPct,
        bankPartyId: loanForm.bankPartyId,
        postDisbursement: loanForm.postDisbursement,
        remarks: loanForm.remarks,
      });
      if (res.ok) {
        toast({ title: `Loan ${loanForm.loanNo} saved` });
        setLoanOpen(false);
        router.refresh();
      } else toast({ variant: "destructive", title: "Save failed", description: res.error });
    } finally {
      setBusy(false);
    }
  };

  const confirmDelete = async () => {
    if (!toDelete) return;
    setBusy(true);
    try {
      const res = await deleteLoan(toDelete.id);
      if (res.ok) {
        toast({ title: `Loan ${toDelete.loanNo} deleted` });
        setToDelete(null);
        router.refresh();
      } else toast({ variant: "destructive", title: "Delete failed", description: res.error });
    } finally {
      setBusy(false);
    }
  };

  const money = React.useMemo(() => ({ numeric: true } satisfies DataTableColumnMeta<LoanRow>), []);

  const columns: ColumnDef<LoanRow>[] = React.useMemo(() => [
    { accessorKey: "loanNo", header: "Loan No" },
    { accessorKey: "date", header: "Date", cell: ({ row }) => formatDate(row.original.date) },
    { accessorKey: "party", header: "Party" },
    {
      accessorKey: "loanType",
      header: "Loan Type",
      cell: ({ row }) => LOAN_TYPE_LABEL[row.original.loanType] ?? row.original.loanType,
    },
    { accessorKey: "vehicle", header: "Vehicle" },
    {
      accessorKey: "amount",
      header: "Loan Amount",
      cell: ({ row }) => formatMoney(row.original.amount),
      meta: money,
    },
    {
      accessorKey: "outstanding",
      header: "Outstanding",
      cell: ({ row }) => formatMoney(row.original.outstanding),
      meta: money,
    },
    {
      accessorKey: "nextDueDate",
      header: "Next EMI",
      cell: ({ row }) =>
        row.original.nextDueDate ? formatDate(row.original.nextDueDate) : "",
    },
    {
      accessorKey: "status",
      header: "Status",
      cell: ({ row }) => (
        <Badge variant={row.original.status === "CLOSED" ? "outline" : "default"}>
          {row.original.status}
        </Badge>
      ),
    },
    {
      id: "actions",
      header: "",
      enableSorting: false,
      cell: ({ row }) => {
        const l = row.original;
        const open = l.status !== "CLOSED";
        return (
          <div className="flex items-center gap-1" onClick={(e) => e.stopPropagation()}>
            <Button
              variant="ghost"
              size="sm"
              className="h-7 px-2 text-xs"
              onClick={() => setView(l)}
              title="View"
            >
              View
            </Button>
            {open && (
              <>
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-7 w-7 text-primary"
                  title="Pay EMI"
                  onClick={() => void openEmi(l, false)}
                >
                  <IndianRupee className="h-3.5 w-3.5" />
                </Button>
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-7 w-7"
                  title="Full Settlement"
                  onClick={() => void openEmi(l, true)}
                >
                  <Wallet className="h-3.5 w-3.5" />
                </Button>
              </>
            )}
            <Button
              variant="ghost"
              size="icon"
              className="h-7 w-7"
              title="Edit"
              onClick={() => openEdit(l)}
            >
              <Pencil className="h-3.5 w-3.5" />
            </Button>
            <Button variant="ghost" size="icon" className="h-7 w-7" asChild>
              <Link href={`/print/loan/${l.id}`} target="_blank" title="Print">
                <Printer className="h-3.5 w-3.5" />
              </Link>
            </Button>
            {canDelete && (
              <Button
                variant="ghost"
                size="icon"
                className="h-7 w-7 text-destructive"
                title="Delete"
                onClick={() => setToDelete(l)}
              >
                <Trash2 className="h-3.5 w-3.5" />
              </Button>
            )}
          </div>
        );
      },
    },
  ], [canDelete, money, openEdit, openEmi]);

  const isVehicleLoan = loanForm.loanType === "VEHICLE";

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm text-muted-foreground">
          Create the loan, pay each EMI, close it. The voucher, ledger postings, interest, TDS and
          vehicle cost are handled automatically.
        </p>
        <div className="flex gap-2">
          <ExportButton
            rows={loans}
            fileName="loan-register"
            columns={[
              { header: "Loan No", key: "loanNo" },
              { header: "Date", accessor: (r) => formatDate(r.date) },
              { header: "Party", key: "party" },
              { header: "Loan Type", accessor: (r) => LOAN_TYPE_LABEL[r.loanType] ?? r.loanType },
              { header: "Vehicle", key: "vehicle" },
              { header: "Loan Amount", key: "amount", numeric: true },
              { header: "Outstanding", key: "outstanding", numeric: true },
              { header: "Next EMI", accessor: (r) => (r.nextDueDate ? formatDate(r.nextDueDate) : "") },
              { header: "Status", key: "status" },
            ]}
          />
          <Button size="sm" onClick={openNew}>
            <Plus className="h-4 w-4" /> New Loan
          </Button>
        </div>
      </div>

      <DataTable columns={columns} data={loans} emptyMessage="No loans yet." />

      {/* ---------------- new / edit loan ---------------- */}
      <Dialog open={loanOpen} onOpenChange={setLoanOpen}>
        <DialogContent className="max-h-[95vh] overflow-y-auto sm:max-w-3xl">
          <DialogHeader>
            <DialogTitle>{loanForm.id ? "Edit" : "New"} Loan</DialogTitle>
            <DialogDescription>
              Everything except the loan number, party and amount is optional — an interest-free
              hand loan needs nothing more.
            </DialogDescription>
          </DialogHeader>
          <div className="grid gap-3 sm:grid-cols-3">
            <div className="space-y-1">
              <Label className="text-xs">Loan No *</Label>
              <Input
                className="h-8"
                value={loanForm.loanNo}
                onChange={(e) => setLoan({ loanNo: e.target.value })}
              />
            </div>
            <div className="space-y-1">
              <Label className="text-xs">Date *</Label>
              <DateInput
                className="h-8"
                value={loanForm.dateText}
                onChange={(t) => setLoan({ dateText: t })}
              />
            </div>
            <div className="space-y-1">
              <Label className="text-xs">Loan Type *</Label>
              <Select
                value={loanForm.loanType}
                onValueChange={(v) => setLoan({ loanType: v, vehicleId: v === "VEHICLE" ? loanForm.vehicleId : null })}
              >
                <SelectTrigger className="h-8"><SelectValue /></SelectTrigger>
                <SelectContent>
                  {Object.entries(LOAN_TYPE_LABEL).map(([v, label]) => (
                    <SelectItem key={v} value={v}>
                      {label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1">
              <Label className="text-xs">Party / Finance Company *</Label>
              <MasterCombobox
                options={partyOptions}
                value={loanForm.partyId}
                onChange={(v) => setLoan({ partyId: v })}
                placeholder="Select party..."
              />
            </div>
            {isVehicleLoan && (
              <div className="space-y-1">
                <Label className="text-xs">Vehicle No *</Label>
                <MasterCombobox
                  options={vehicleOptions}
                  value={loanForm.vehicleId}
                  onChange={(v) => setLoan({ vehicleId: v })}
                  placeholder="Select vehicle..."
                />
              </div>
            )}
            <div className="space-y-1">
              <Label className="text-xs">Loan Amount *</Label>
              <Input
                type="number"
                className="h-8 text-right"
                value={loanForm.amount ? String(loanForm.amount) : ""}
                onChange={(e) => setLoan({ amount: Number(e.target.value) || 0 })}
              />
            </div>
            <div className="space-y-1 sm:col-span-2">
              <Label className="text-xs">Loan Purpose</Label>
              <Input
                className="h-8"
                value={loanForm.purpose}
                onChange={(e) => setLoan({ purpose: e.target.value })}
              />
            </div>
            <div className="space-y-1">
              <Label className="text-xs">Interest</Label>
              <Select
                value={loanForm.interestMode}
                onValueChange={(v) => setLoan({ interestMode: v })}
              >
                <SelectTrigger className="h-8"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="NONE">No interest</SelectItem>
                  <SelectItem value="FLAT">Flat</SelectItem>
                  <SelectItem value="REDUCING">Reducing balance</SelectItem>
                </SelectContent>
              </Select>
            </div>
            {loanForm.interestMode !== "NONE" && (
              <div className="space-y-1">
                <Label className="text-xs">Interest Rate (% p.a.)</Label>
                <Input
                  type="number"
                  step="0.01"
                  className="h-8 text-right"
                  value={loanForm.interestRate ? String(loanForm.interestRate) : ""}
                  onChange={(e) => setLoan({ interestRate: Number(e.target.value) || 0 })}
                />
              </div>
            )}
            <div className="space-y-1">
              <Label className="text-xs">EMI</Label>
              <Select
                value={loanForm.emiApplicable ? "YES" : "NO"}
                onValueChange={(v) => setLoan({ emiApplicable: v === "YES" })}
              >
                <SelectTrigger className="h-8"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="NO">Not applicable</SelectItem>
                  <SelectItem value="YES">Applicable</SelectItem>
                </SelectContent>
              </Select>
            </div>
            {loanForm.emiApplicable && (
              <>
                <div className="space-y-1">
                  <Label className="text-xs">EMI Amount *</Label>
                  <Input
                    type="number"
                    className="h-8 text-right"
                    value={loanForm.emiAmount ? String(loanForm.emiAmount) : ""}
                    onChange={(e) => setLoan({ emiAmount: Number(e.target.value) || 0 })}
                  />
                </div>
                <div className="space-y-1">
                  <Label className="text-xs">EMI Start Date</Label>
                  <DateInput
                    className="h-8"
                    value={loanForm.emiStartText}
                    onChange={(t) => setLoan({ emiStartText: t })}
                  />
                </div>
                <div className="space-y-1">
                  <Label className="text-xs">EMI Frequency</Label>
                  <Select
                    value={loanForm.emiFrequency}
                    onValueChange={(v) => setLoan({ emiFrequency: v })}
                  >
                    <SelectTrigger className="h-8"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="MONTHLY">Monthly</SelectItem>
                      <SelectItem value="QUARTERLY">Quarterly</SelectItem>
                      <SelectItem value="YEARLY">Yearly</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-1">
                  <Label className="text-xs">Tenure (months)</Label>
                  <Input
                    type="number"
                    className="h-8 text-right"
                    value={loanForm.tenureMonths ? String(loanForm.tenureMonths) : ""}
                    onChange={(e) => setLoan({ tenureMonths: Number(e.target.value) || 0 })}
                  />
                </div>
              </>
            )}
            <div className="space-y-1">
              <Label className="text-xs">TDS on Interest</Label>
              <Select
                value={loanForm.tdsApplicable ? "YES" : "NO"}
                onValueChange={(v) => setLoan({ tdsApplicable: v === "YES" })}
              >
                <SelectTrigger className="h-8"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="NO">Not applicable</SelectItem>
                  <SelectItem value="YES">Applicable</SelectItem>
                </SelectContent>
              </Select>
            </div>
            {loanForm.tdsApplicable && (
              <div className="space-y-1">
                <Label className="text-xs">TDS %</Label>
                <Input
                  type="number"
                  step="0.01"
                  className="h-8 text-right"
                  value={loanForm.tdsPct ? String(loanForm.tdsPct) : ""}
                  onChange={(e) => setLoan({ tdsPct: Number(e.target.value) || 0 })}
                />
                <p className="text-[11px] text-muted-foreground">
                  Applied to the interest only — never to principal.
                </p>
              </div>
            )}
            {!loanForm.id && (
              <>
                <div className="space-y-1">
                  <Label className="text-xs">Disbursement</Label>
                  <Select
                    value={loanForm.postDisbursement ? "YES" : "NO"}
                    onValueChange={(v) => setLoan({ postDisbursement: v === "YES" })}
                  >
                    <SelectTrigger className="h-8"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="YES">Post it now</SelectItem>
                      <SelectItem value="NO">Already received / older loan</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                {loanForm.postDisbursement && (
                  <div className="space-y-1">
                    <Label className="text-xs">Bank / Cash Account *</Label>
                    <MasterCombobox
                      options={bankOptions}
                      value={loanForm.bankPartyId}
                      onChange={(v) => setLoan({ bankPartyId: v })}
                      placeholder="Select account..."
                    />
                  </div>
                )}
              </>
            )}
            <div className="space-y-1 sm:col-span-3">
              <Label className="text-xs">Remarks</Label>
              <Input
                className="h-8"
                value={loanForm.remarks}
                onChange={(e) => setLoan({ remarks: e.target.value })}
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setLoanOpen(false)} disabled={busy}>
              Cancel
            </Button>
            <Button
              onClick={submitLoan}
              disabled={busy || !loanForm.loanNo || !loanForm.partyId || loanForm.amount <= 0}
            >
              {busy ? "Saving..." : "Save Loan"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ---------------- EMI / settlement ---------------- */}
      {/* THE EMI popup — shared with the EMI Due page */}
      <EmiPayDialog
        target={emiTarget}
        onClose={() => setEmiTarget(null)}
        onPaid={() => router.refresh()}
        bankOptions={bankOptions}
      />

      {/* ---------------- view ---------------- */}
      <Dialog open={!!view} onOpenChange={(o: boolean) => !o && setView(null)}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>Loan {view?.loanNo}</DialogTitle>
            <DialogDescription>
              {view ? LOAN_TYPE_LABEL[view.loanType] ?? view.loanType : ""} · {view?.party}
            </DialogDescription>
          </DialogHeader>
          {view && (
            <div className="grid grid-cols-2 gap-2 text-sm">
              {(
                [
                  ["Date", formatDate(view.date)],
                  ["Vehicle", view.vehicle || "—"],
                  ["Purpose", view.purpose || "—"],
                  ["Loan Amount", formatMoney(view.amount)],
                  ["Principal Repaid", formatMoney(view.repaid)],
                  ["Outstanding", formatMoney(view.outstanding)],
                  ["Interest Paid", formatMoney(view.interestPaid)],
                  ["EMI", view.emiAmount ? formatMoney(view.emiAmount) : "—"],
                  ["EMIs Paid", String(view.emiCount)],
                  ["EMIs Remaining", view.remainingEmis == null ? "—" : String(view.remainingEmis)],
                  ["Next EMI", view.nextDueDate ? formatDate(view.nextDueDate) : "—"],
                  [
                    "Interest",
                    view.interestMode === "NONE"
                      ? "None"
                      : `${view.interestMode === "FLAT" ? "Flat" : "Reducing"} @ ${view.interestRate}%`,
                  ],
                  ["TDS", view.tdsApplicable ? `${view.tdsPct}% on interest` : "Not applicable"],
                  ["Status", view.status],
                ] as [string, string][]
              ).map(([k, v]) => (
                <React.Fragment key={k}>
                  <div className="text-muted-foreground">{k}</div>
                  <div className="font-medium">{v}</div>
                </React.Fragment>
              ))}
            </div>
          )}
          <DialogFooter>
            <Button variant="outline" asChild>
              <Link href={`/print/loan/${view?.id}`} target="_blank">
                Print
              </Link>
            </Button>
            <Button onClick={() => setView(null)}>Close</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ---------------- delete ---------------- */}
      <Dialog open={!!toDelete} onOpenChange={(o: boolean) => !o && setToDelete(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete loan {toDelete?.loanNo}?</DialogTitle>
            <DialogDescription>
              The loan and its disbursement posting are removed. A loan that already has
              instalments cannot be deleted — delete those first, so no voucher is ever orphaned.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setToDelete(null)} disabled={busy}>
              Cancel
            </Button>
            <Button variant="destructive" onClick={confirmDelete} disabled={busy}>
              {busy ? "Deleting..." : "Delete"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
