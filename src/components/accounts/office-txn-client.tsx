"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import type { ColumnDef } from "@tanstack/react-table";
import { Plus } from "lucide-react";
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
import { FilterBar } from "@/components/data/filter-bar";
import { MasterCombobox, type MasterOption } from "@/components/data/master-combobox";
import {
  deleteOfficeTransaction,
  saveOfficeTransaction,
} from "@/app/(app)/accounts/office/actions";

export interface OfficeTxnRow {
  id: string;
  voucherNo: string;
  date: string;
  txnType: string; // INCOME | EXPENSE
  headId: string;
  head: string;
  partyId: string | null;
  party: string;
  paymentMode: string; // "" = on credit (pending settlement)
  bankPartyId: string | null;
  bank: string;
  amount: number;
  gstPct: number;
  gstAmount: number;
  /** blank on entry falls back to the voucher number, and is stored that way */
  refNo: string;
  remarks: string;
  attachmentPath: string | null;
  /** optional head-wise split of the same bill */
  lines: { headId: string; head: string; amount: number; remarks: string }[];
  /** live position from the shared settlement engine */
  settled: number;
  outstanding: number;
  status: string;
}

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
  txnType: "EXPENSE" as "INCOME" | "EXPENSE",
  headId: null as string | null,
  partyId: null as string | null,
  paymentMode: "CASH" as "CASH" | "BANK" | "CARD" | "CREDIT",
  bankPartyId: null as string | null,
  amount: 0,
  gstPct: 0,
  gstAmount: 0,
  refNo: "",
  remarks: "",
  attachmentPath: null as string | null,
  attachmentName: "",
  // one bill, many heads: optional split rows (head + amount + note)
  lines: [] as { headId: string | null; amount: number; remarks: string }[],
};

export function OfficeTxnClient({
  rows,
  headOptions,
  partyOptions,
  bankOptions,
  canDelete,
}: {
  rows: OfficeTxnRow[];
  headOptions: MasterOption[];
  partyOptions: MasterOption[];
  bankOptions: MasterOption[];
  canDelete: boolean;
}) {
  const router = useRouter();
  const { toast } = useToast();
  const [open, setOpen] = React.useState(false);
  const [form, setForm] = React.useState(emptyForm);
  const [busy, setBusy] = React.useState(false);
  const [uploading, setUploading] = React.useState(false);
  const fileRef = React.useRef<HTMLInputElement>(null);

  const set = (patch: Partial<typeof emptyForm>) => setForm((f) => ({ ...f, ...patch }));

  const openNew = (txnType: "INCOME" | "EXPENSE") => {
    setForm({ ...emptyForm, txnType });
    setOpen(true);
  };
  const openEdit = React.useCallback((row: OfficeTxnRow) => {
    setForm({
      id: row.id,
      dateText: formatDate(row.date),
      txnType: row.txnType as "INCOME" | "EXPENSE",
      headId: row.headId,
      partyId: row.partyId,
      paymentMode: (row.paymentMode || "CREDIT") as "CASH" | "BANK" | "CARD" | "CREDIT",
      bankPartyId: row.bankPartyId,
      amount: row.amount,
      gstPct: row.gstPct,
      gstAmount: row.gstAmount,
      refNo: row.refNo,
      remarks: row.remarks,
      attachmentPath: row.attachmentPath,
      attachmentName: "",
      lines: row.lines.map((l) => ({ headId: l.headId, amount: l.amount, remarks: l.remarks })),
    });
    setOpen(true);
  }, []);

  const uploadAttachment = async (file: File | null) => {
    if (!file) return;
    setUploading(true);
    try {
      const fd = new FormData();
      fd.append("file", file);
      const res = await fetch("/api/uploads/docreg", { method: "POST", body: fd });
      const json = await res.json();
      if (!res.ok || !json.ok) throw new Error(json.error ?? "Upload failed");
      set({ attachmentPath: json.path, attachmentName: file.name });
      toast({ title: "Attachment ready — will be saved with the entry" });
    } catch (err) {
      toast({
        variant: "destructive",
        title: "Upload failed",
        description: err instanceof Error ? err.message : undefined,
      });
    } finally {
      setUploading(false);
      if (fileRef.current) fileRef.current.value = "";
    }
  };

  const heads = headOptions.filter((h) => h.meta === form.txnType);

  // valid split lines; when ≥2 the bill is multi-head and their sum drives it
  const splitLines = form.lines.filter((l) => l.headId && l.amount > 0);
  const splitTotal = Math.round(splitLines.reduce((s, l) => s + l.amount, 0) * 100) / 100;
  const usingSplit = splitLines.length >= 2;

  const submit = async () => {
    setBusy(true);
    try {
      const res = await saveOfficeTransaction({
        id: form.id,
        date: textToIso(form.dateText),
        txnType: form.txnType,
        headId: usingSplit ? splitLines[0].headId ?? "" : form.headId ?? "",
        lines: usingSplit
          ? splitLines.map((l) => ({ headId: l.headId as string, amount: l.amount, remarks: l.remarks || null }))
          : [],
        partyId: form.partyId,
        paymentMode: form.paymentMode === "CREDIT" ? null : form.paymentMode,
        bankPartyId: form.paymentMode === "CREDIT" ? null : form.bankPartyId,
        amount: usingSplit ? splitTotal : form.amount,
        gstPct: form.gstPct,
        gstAmount: form.gstAmount,
        refNo: form.refNo,
        remarks: form.remarks,
        attachmentPath: form.attachmentPath,
      });
      if (res.ok) {
        toast({
          title: `${res.voucherNo} saved`,
          description: "Ledger entries posted automatically (head, bank/cash, supplier/party).",
        });
        setOpen(false);
        router.refresh();
      } else toast({ variant: "destructive", title: "Save failed", description: res.error });
    } finally {
      setBusy(false);
    }
  };

  const remove = React.useCallback(async (row: OfficeTxnRow) => {
    if (!confirm(`Delete ${row.voucherNo}? Ledger postings will be reversed.`)) return;
    const res = await deleteOfficeTransaction(row.id);
    if (res.ok) {
      toast({ title: `${row.voucherNo} deleted` });
      router.refresh();
    } else toast({ variant: "destructive", title: "Delete failed", description: res.error });
  }, [router, toast]);

  const columns: ColumnDef<OfficeTxnRow>[] = React.useMemo(() => [
    { accessorKey: "voucherNo", header: "Voucher No" },
    {
      accessorKey: "date",
      header: "Date",
      cell: ({ row }) => formatDate(row.original.date),
    },
    {
      accessorKey: "txnType",
      header: "Type",
      cell: ({ row }) =>
        row.original.txnType === "INCOME" ? (
          <Badge>Income</Badge>
        ) : (
          <Badge variant="destructive">Expense</Badge>
        ),
    },
    { accessorKey: "head", header: "Head" },
    { accessorKey: "party", header: "Supplier / Party" },
    {
      accessorKey: "paymentMode",
      header: "Mode",
      cell: ({ row }) =>
        row.original.paymentMode ? (
          <Badge variant="secondary">{row.original.paymentMode}</Badge>
        ) : (
          <Badge variant="outline">CREDIT</Badge>
        ),
    },
    { accessorKey: "bank", header: "Cash / Bank A/c" },
    {
      accessorKey: "amount",
      header: "Amount",
      cell: ({ row }) => formatMoney(row.original.amount),
      meta: {
        numeric: true,
        total: (rs) => formatMoney(rs.reduce((s, r) => s + r.amount, 0)),
      } satisfies DataTableColumnMeta<OfficeTxnRow>,
    },
    { accessorKey: "refNo", header: "Reference No" },
    {
      accessorKey: "settled",
      header: "Settled",
      cell: ({ row }) => formatMoney(row.original.settled),
      meta: {
        numeric: true,
        total: (rs) => formatMoney(rs.reduce((s, r) => s + r.settled, 0)),
      } satisfies DataTableColumnMeta<OfficeTxnRow>,
    },
    {
      accessorKey: "outstanding",
      header: "Outstanding",
      cell: ({ row }) => formatMoney(row.original.outstanding),
      meta: {
        numeric: true,
        total: (rs) => formatMoney(rs.reduce((s, r) => s + r.outstanding, 0)),
      } satisfies DataTableColumnMeta<OfficeTxnRow>,
    },
    {
      accessorKey: "status",
      header: "Status",
      cell: ({ row }) => {
        const s = row.original.status;
        return (
          <Badge
            variant={
              s === "PAID" || s === "SETTLED AT ENTRY"
                ? "secondary"
                : s === "PARTLY PAID"
                  ? "outline"
                  : "destructive"
            }
          >
            {s}
          </Badge>
        );
      },
    },
    { accessorKey: "remarks", header: "Remarks" },
    {
      id: "attachment",
      header: "Doc",
      cell: ({ row }) =>
        row.original.attachmentPath ? (
          <a
            href={`/api/uploads/${row.original.attachmentPath}`}
            target="_blank"
            rel="noreferrer"
            className="text-xs text-primary underline"
            onClick={(e) => e.stopPropagation()}
          >
            View
          </a>
        ) : null,
    },
    {
      id: "actions",
      header: "",
      cell: ({ row }) => (
        <div className="flex gap-1" onClick={(e) => e.stopPropagation()}>
          <Button variant="ghost" size="sm" className="h-6 px-2 text-xs" onClick={() => openEdit(row.original)}>
            Edit
          </Button>
          {canDelete && (
            <Button
              variant="ghost"
              size="sm"
              className="h-6 px-2 text-xs text-destructive"
              onClick={() => void remove(row.original)}
            >
              Delete
            </Button>
          )}
        </div>
      ),
    },
  ], [canDelete, openEdit, remove]);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h1 className="text-xl font-semibold">Office Income &amp; Expense</h1>
        <div className="flex flex-wrap gap-2">
          <ExportButton
            rows={rows}
            fileName="office-income-expense-register"
            sheetName="Office Register"
            columns={[
              { header: "Date", accessor: (r) => formatDate(r.date) },
              { header: "Voucher No", key: "voucherNo" },
              { header: "Type", key: "txnType" },
              { header: "Head", key: "head" },
              { header: "Supplier / Party", key: "party" },
              { header: "Payment Mode", key: "paymentMode" },
              { header: "Cash / Bank A/c", key: "bank" },
              { header: "Amount", key: "amount", numeric: true },
              { header: "GST %", key: "gstPct", numeric: true },
              { header: "GST Amount", key: "gstAmount", numeric: true },
              { header: "Reference No", key: "refNo" },
              { header: "Settled", key: "settled", numeric: true },
              { header: "Outstanding", key: "outstanding", numeric: true },
              { header: "Status", key: "status" },
              { header: "Remarks", key: "remarks" },
            ]}
          />
          <Button variant="outline" size="sm" onClick={() => openNew("INCOME")}>
            <Plus className="h-4 w-4" /> Income
          </Button>
          <Button size="sm" onClick={() => openNew("EXPENSE")}>
            <Plus className="h-4 w-4" /> Expense
          </Button>
        </div>
      </div>
      <p className="text-sm text-muted-foreground">
        Entries post automatically: head ledger ↔ cash/bank, routed through the supplier / party
        ledger when one is selected. No manual journal voucher needed.
      </p>
      <FilterBar
        filters={[
          { type: "text", key: "q", label: "Voucher / Reference No..." },
          { type: "daterange", key: "date", label: "Date" },
          {
            type: "select",
            key: "type",
            label: "Type",
            options: [
              { value: "EXPENSE", label: "Expense Register" },
              { value: "INCOME", label: "Income Register" },
            ],
          },
          { type: "combobox", key: "head", label: "Head", options: headOptions },
          { type: "combobox", key: "party", label: "Supplier / Party", options: partyOptions },
          {
            type: "select",
            key: "mode",
            label: "Payment Mode",
            options: [
              { value: "CASH", label: "Cash" },
              { value: "BANK", label: "Bank" },
              { value: "CREDIT", label: "Credit (pending)" },
            ],
          },
        ]}
      />
      <DataTable
        columns={columns}
        data={rows}
        emptyMessage="No office transactions yet."
        onRowClick={(row) => openEdit(row)}
      />

      <input
        ref={fileRef}
        type="file"
        accept=".pdf,.jpg,.jpeg,.png,application/pdf,image/jpeg,image/png"
        className="hidden"
        onChange={(e) => void uploadAttachment(e.target.files?.[0] ?? null)}
      />

      {/* entry dialog */}
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-h-[95vh] overflow-y-auto sm:max-w-5xl">
          <DialogHeader>
            <DialogTitle>
              {form.id ? "Edit" : "New"} Office {form.txnType === "INCOME" ? "Income" : "Expense"}
              {form.id ? "" : " — voucher number auto-generates on save"}
            </DialogTitle>
            <DialogDescription>
              Supplier / Party and Payment Mode are both optional. Pick &quot;Credit&quot; (with a
              party) to leave the amount outstanding on their ledger for later settlement via a
              payment / receipt voucher; pick Cash / Bank to pay or receive now. Reference No
              accepts any external document number.
            </DialogDescription>
          </DialogHeader>
          <div className="grid gap-3 sm:grid-cols-3">
            <div className="space-y-1">
              <Label className="text-xs">Date *</Label>
              <DateInput className="h-8" value={form.dateText} onChange={(t) => set({ dateText: t })} />
            </div>
            <div className="space-y-1">
              <Label className="text-xs">Transaction Type</Label>
              <Select
                value={form.txnType}
                onValueChange={(v) => set({ txnType: v as "INCOME" | "EXPENSE", headId: null })}
              >
                <SelectTrigger className="h-8">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="EXPENSE">Expense</SelectItem>
                  <SelectItem value="INCOME">Income</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1">
              <Label className="text-xs">
                {form.txnType === "INCOME" ? "Income Head *" : "Expense Head *"}
              </Label>
              <MasterCombobox
                options={heads}
                value={form.headId}
                onChange={(v) => set({ headId: v })}
                placeholder="From heads master..."
              />
            </div>
            <div className="space-y-1">
              <Label className="text-xs">Supplier / Party (optional)</Label>
              <MasterCombobox
                options={partyOptions}
                value={form.partyId}
                onChange={(v) => set({ partyId: v })}
                placeholder="None..."
              />
            </div>
            <div className="space-y-1">
              <Label className="text-xs">Payment Mode (optional)</Label>
              <Select
                value={form.paymentMode}
                onValueChange={(v) =>
                  set({
                    paymentMode: v as "CASH" | "BANK" | "CARD" | "CREDIT",
                    ...(v === "CREDIT" ? { bankPartyId: null } : {}),
                  })
                }
              >
                <SelectTrigger className="h-8">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="CASH">Cash</SelectItem>
                  <SelectItem value="BANK">Bank</SelectItem>
                  <SelectItem value="CARD">Card</SelectItem>
                  <SelectItem value="CREDIT">Credit — settle later via voucher</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1">
              <Label className="text-xs">
                {form.paymentMode === "CREDIT" ? "Cash / Bank Account" : "Cash / Bank Account *"}
              </Label>
              {form.paymentMode === "CREDIT" ? (
                <div className="flex h-8 items-center rounded-md border border-dashed px-2 text-xs text-muted-foreground">
                  Not needed — amount stays outstanding on the party ledger
                </div>
              ) : (
                <MasterCombobox
                  options={bankOptions.filter((b) =>
                    b.meta === form.paymentMode
                  )}
                  value={form.bankPartyId}
                  onChange={(v) => set({ bankPartyId: v })}
                  placeholder="Select account..."
                />
              )}
            </div>
            <div className="space-y-1">
              <Label className="text-xs">Amount *</Label>
              <Input
                type="number"
                step="0.01"
                className="h-8 text-right"
                value={form.amount ? String(form.amount) : ""}
                onChange={(e) => set({ amount: Number(e.target.value) || 0 })}
              />
            </div>
            <div className="space-y-1">
              <Label className="text-xs">GST % (optional)</Label>
              <Input
                type="number"
                step="0.01"
                className="h-8 text-right"
                value={form.gstPct ? String(form.gstPct) : ""}
                onChange={(e) => {
                  const pct = Number(e.target.value) || 0;
                  set({
                    gstPct: pct,
                    gstAmount:
                      pct > 0 && form.amount > 0
                        ? Math.round(((form.amount * pct) / (100 + pct)) * 100) / 100
                        : 0,
                  });
                }}
              />
            </div>
            <div className="space-y-1">
              <Label className="text-xs">GST Amount (incl. in amount)</Label>
              <Input
                type="number"
                step="0.01"
                className="h-8 text-right"
                value={form.gstAmount ? String(form.gstAmount) : ""}
                onChange={(e) => set({ gstAmount: Number(e.target.value) || 0 })}
              />
            </div>
            <div className="space-y-1">
              <Label className="text-xs">Reference No (bill / invoice / receipt / challan / LR)</Label>
              <Input
                className="h-8"
                placeholder="Any format, letters & numbers"
                value={form.refNo}
                onChange={(e) => set({ refNo: e.target.value })}
              />
            </div>
            <div className="space-y-1 sm:col-span-2">
              <Label className="text-xs">Remarks</Label>
              <Input className="h-8" value={form.remarks} onChange={(e) => set({ remarks: e.target.value })} />
            </div>

            {/* one bill, many heads: optional head-wise split */}
            <div className="space-y-1 sm:col-span-3">
              <div className="flex items-center justify-between">
                <Label className="text-xs">
                  Head-wise Split (optional — same bill, alag-alag heads; jaise Spare Parts +
                  Repair Labour)
                </Label>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="h-6 px-2 text-xs"
                  onClick={() =>
                    set({ lines: [...form.lines, { headId: null, amount: 0, remarks: "" }] })
                  }
                >
                  + Line
                </Button>
              </div>
              {form.lines.map((l, i) => (
                <div key={i} className="flex flex-wrap items-center gap-1.5">
                  <div className="w-56">
                    <MasterCombobox
                      options={heads}
                      value={l.headId}
                      onChange={(v) =>
                        set({ lines: form.lines.map((x, j) => (j === i ? { ...x, headId: v } : x)) })
                      }
                      placeholder="Head..."
                    />
                  </div>
                  <Input
                    type="number"
                    step="0.01"
                    className="h-8 w-28 text-right"
                    placeholder="Amount"
                    value={l.amount ? String(l.amount) : ""}
                    onChange={(e) =>
                      set({
                        lines: form.lines.map((x, j) =>
                          j === i ? { ...x, amount: Number(e.target.value) || 0 } : x
                        ),
                      })
                    }
                  />
                  <Input
                    className="h-8 w-44"
                    placeholder="Note (optional)"
                    value={l.remarks}
                    onChange={(e) =>
                      set({
                        lines: form.lines.map((x, j) =>
                          j === i ? { ...x, remarks: e.target.value } : x
                        ),
                      })
                    }
                  />
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="h-8 px-2 text-destructive"
                    onClick={() => set({ lines: form.lines.filter((_, j) => j !== i) })}
                  >
                    ✕
                  </Button>
                </div>
              ))}
              {usingSplit && (
                <p className="text-xs text-muted-foreground">
                  Split total <b className="tabular-nums">{splitTotal.toFixed(2)}</b> becomes the
                  bill amount — each head posts its share to the ledger/P&amp;L; supplier and
                  payment apply on the full total.
                </p>
              )}
            </div>
            <div className="space-y-1 sm:col-span-3">
              <Label className="text-xs">Attachment (optional — PDF / JPG / PNG)</Label>
              <div className="flex flex-wrap items-center gap-2">
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  disabled={uploading}
                  onClick={() => fileRef.current?.click()}
                >
                  {uploading ? "Uploading..." : form.attachmentPath ? "Replace" : "Upload"}
                </Button>
                {form.attachmentPath && (
                  <a
                    href={`/api/uploads/${form.attachmentPath}`}
                    target="_blank"
                    rel="noreferrer"
                    className="text-xs text-primary underline"
                  >
                    {form.attachmentName || "View attachment"}
                  </a>
                )}
              </div>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setOpen(false)} disabled={busy}>
              Cancel
            </Button>
            <Button
              onClick={submit}
              disabled={
                busy ||
                (usingSplit ? splitTotal <= 0 : !form.headId || form.amount <= 0) ||
                (form.paymentMode === "CREDIT" ? !form.partyId : !form.bankPartyId)
              }
            >
              {busy ? "Saving..." : form.id ? "Update & Re-post" : "Save & Post"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
