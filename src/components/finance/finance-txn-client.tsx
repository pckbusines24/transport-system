"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import type { ColumnDef } from "@tanstack/react-table";
import { Pencil, Plus, Trash2 } from "lucide-react";
import { formatDate, formatMoney, parseDdMmYyyy } from "@/lib/utils";
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
import { deleteFinanceTxn, saveFinanceTxn } from "@/app/(app)/finance/actions";
import type { FinanceTxnRow } from "@/app/(app)/finance/queries";

const TYPE_LABEL: Record<string, string> = {
  PERSONAL: "Personal",
  TEMPORARY_LOAN: "Temporary Loan",
  FAMILY_TRANSFER: "Family Transfer",
  SECURITY_DEPOSIT: "Security Deposit",
  MISC: "Miscellaneous",
};

function textToIso(text: string): string {
  const d = parseDdMmYyyy(text);
  if (!d) return "";
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${d.getFullYear()}-${mm}-${dd}`;
}

const emptyForm = {
  id: null as string | null,
  dateText: formatDate(new Date()),
  direction: "PAYMENT" as "RECEIPT" | "PAYMENT",
  txnType: "PERSONAL",
  partyId: null as string | null,
  amount: 0,
  entryType: "CASH" as "CASH" | "BANK",
  bankPartyId: null as string | null,
  remarks: "",
};

/**
 * Other Receipts & Payments — money that has nothing to do with transport
 * operations. Each entry creates an ordinary Receipt/Payment voucher and posts
 * party against bank, so it appears in the ledgers and the voucher register but
 * never in a freight, chalan or billing report.
 */
export function FinanceTxnClient({
  rows,
  partyOptions,
  bankOptions,
  canDelete,
}: {
  rows: FinanceTxnRow[];
  partyOptions: MasterOption[];
  bankOptions: MasterOption[];
  canDelete: boolean;
}) {
  const router = useRouter();
  const { toast } = useToast();
  const [busy, setBusy] = React.useState(false);
  const [open, setOpen] = React.useState(false);
  const [form, setForm] = React.useState(emptyForm);
  const [toDelete, setToDelete] = React.useState<FinanceTxnRow | null>(null);
  const set = (p: Partial<typeof emptyForm>) => setForm((f) => ({ ...f, ...p }));

  const submit = async () => {
    setBusy(true);
    try {
      const res = await saveFinanceTxn({
        id: form.id,
        date: textToIso(form.dateText),
        direction: form.direction,
        txnType: form.txnType,
        partyId: form.partyId ?? "",
        amount: form.amount,
        entryType: form.entryType,
        bankPartyId: form.bankPartyId ?? "",
        remarks: form.remarks,
      });
      if (res.ok) {
        toast({ title: `Saved`, description: `Voucher ${res.voucherNo} posted` });
        setOpen(false);
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
      const res = await deleteFinanceTxn(toDelete.id);
      if (res.ok) {
        toast({ title: "Entry deleted" });
        setToDelete(null);
        router.refresh();
      } else toast({ variant: "destructive", title: "Delete failed", description: res.error });
    } finally {
      setBusy(false);
    }
  };

  const columns: ColumnDef<FinanceTxnRow>[] = React.useMemo(() => [
    { accessorKey: "voucherNo", header: "Voucher No" },
    { accessorKey: "date", header: "Date", cell: ({ row }) => formatDate(row.original.date) },
    {
      accessorKey: "direction",
      header: "Type",
      cell: ({ row }) => (
        <Badge variant={row.original.direction === "RECEIPT" ? "default" : "destructive"}>
          {row.original.direction}
        </Badge>
      ),
    },
    {
      accessorKey: "txnType",
      header: "Nature",
      cell: ({ row }) => TYPE_LABEL[row.original.txnType] ?? row.original.txnType,
    },
    { accessorKey: "party", header: "Party" },
    { accessorKey: "bank", header: "Cash / Bank" },
    {
      accessorKey: "amount",
      header: "Amount",
      cell: ({ row }) => formatMoney(row.original.amount),
      meta: {
        numeric: true,
        total: (all: FinanceTxnRow[]) =>
          formatMoney(all.reduce((s, r) => s + r.amount, 0)),
      } satisfies DataTableColumnMeta<FinanceTxnRow>,
    },
    { accessorKey: "remarks", header: "Remarks" },
    {
      id: "actions",
      header: "",
      enableSorting: false,
      cell: ({ row }) => (
        <div className="flex items-center gap-1" onClick={(e) => e.stopPropagation()}>
          <Button
            variant="ghost"
            size="icon"
            className="h-7 w-7"
            title="Edit"
            onClick={() => {
              const r = row.original;
              setForm({
                id: r.id,
                dateText: formatDate(r.date),
                direction: r.direction as "RECEIPT" | "PAYMENT",
                txnType: r.txnType,
                partyId: r.partyId,
                amount: r.amount,
                entryType: r.entryType as "CASH" | "BANK",
                bankPartyId: r.bankPartyId,
                remarks: r.remarks,
              });
              setOpen(true);
            }}
          >
            <Pencil className="h-3.5 w-3.5" />
          </Button>
          {canDelete && (
            <Button
              variant="ghost"
              size="icon"
              className="h-7 w-7 text-destructive"
              title="Delete"
              onClick={() => setToDelete(row.original)}
            >
              <Trash2 className="h-3.5 w-3.5" />
            </Button>
          )}
        </div>
      ),
    },
  ], [canDelete]);

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm text-muted-foreground">
          Personal, family and other non-operational money. Each entry posts a voucher against the
          party and the cash/bank account — and nothing else, so operational reports stay clean.
        </p>
        <div className="flex gap-2">
          <ExportButton
            rows={rows}
            fileName="other-receipts-payments"
            columns={[
              { header: "Voucher No", key: "voucherNo" },
              { header: "Date", accessor: (r) => formatDate(r.date) },
              { header: "Type", key: "direction" },
              { header: "Nature", accessor: (r) => TYPE_LABEL[r.txnType] ?? r.txnType },
              { header: "Party", key: "party" },
              { header: "Cash / Bank", key: "bank" },
              { header: "Amount", key: "amount", numeric: true },
              { header: "Remarks", key: "remarks" },
            ]}
          />
          <Button
            size="sm"
            onClick={() => {
              setForm(emptyForm);
              setOpen(true);
            }}
          >
            <Plus className="h-4 w-4" /> New Entry
          </Button>
        </div>
      </div>

      <DataTable columns={columns} data={rows} emptyMessage="Nothing recorded yet." />

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>{form.id ? "Edit" : "New"} Receipt / Payment</DialogTitle>
            <DialogDescription>
              The voucher number is generated automatically from the same series the Voucher module
              uses.
            </DialogDescription>
          </DialogHeader>
          <div className="grid gap-3 sm:grid-cols-3">
            <div className="space-y-1">
              <Label className="text-xs">Date *</Label>
              <DateInput
                className="h-8"
                value={form.dateText}
                onChange={(t) => set({ dateText: t })}
              />
            </div>
            <div className="space-y-1">
              <Label className="text-xs">Receipt / Payment *</Label>
              <Select
                value={form.direction}
                onValueChange={(v) => set({ direction: v as "RECEIPT" | "PAYMENT" })}
              >
                <SelectTrigger className="h-8"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="RECEIPT">Receipt (money in)</SelectItem>
                  <SelectItem value="PAYMENT">Payment (money out)</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1">
              <Label className="text-xs">Transaction Type *</Label>
              <Select value={form.txnType} onValueChange={(v) => set({ txnType: v })}>
                <SelectTrigger className="h-8"><SelectValue /></SelectTrigger>
                <SelectContent>
                  {Object.entries(TYPE_LABEL).map(([v, label]) => (
                    <SelectItem key={v} value={v}>
                      {label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1">
              <Label className="text-xs">Party *</Label>
              <MasterCombobox
                options={partyOptions}
                value={form.partyId}
                onChange={(v) => set({ partyId: v })}
                placeholder="Select party..."
              />
            </div>
            <div className="space-y-1">
              <Label className="text-xs">Amount *</Label>
              <Input
                type="number"
                className="h-8 text-right"
                value={form.amount ? String(form.amount) : ""}
                onChange={(e) => set({ amount: Number(e.target.value) || 0 })}
              />
            </div>
            <div className="space-y-1">
              <Label className="text-xs">Mode</Label>
              <Select
                value={form.entryType}
                onValueChange={(v) => set({ entryType: v as "CASH" | "BANK" })}
              >
                <SelectTrigger className="h-8"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="CASH">Cash</SelectItem>
                  <SelectItem value="BANK">Bank</SelectItem>
                  <SelectItem value="CARD">Card</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1 sm:col-span-2">
              <Label className="text-xs">Cash / Bank Account *</Label>
              <MasterCombobox
                options={bankOptions.filter((b) => !b.meta || b.meta === form.entryType)}
                value={form.bankPartyId}
                onChange={(v) => set({ bankPartyId: v })}
                placeholder="Select account..."
              />
            </div>
            <div className="space-y-1 sm:col-span-3">
              <Label className="text-xs">Remarks</Label>
              <Input
                className="h-8"
                value={form.remarks}
                onChange={(e) => set({ remarks: e.target.value })}
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setOpen(false)} disabled={busy}>
              Cancel
            </Button>
            <Button
              onClick={submit}
              disabled={busy || !form.partyId || !form.bankPartyId || form.amount <= 0}
            >
              {busy ? "Saving..." : "Save"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={!!toDelete} onOpenChange={(o: boolean) => !o && setToDelete(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete {toDelete?.voucherNo}?</DialogTitle>
            <DialogDescription>
              The entry and the voucher it created are removed together, so no posting is left
              behind.
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
