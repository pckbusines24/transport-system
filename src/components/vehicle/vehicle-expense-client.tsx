"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import type { ColumnDef } from "@tanstack/react-table";
import { Download, Loader2, Plus, Trash2, Upload } from "lucide-react";
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
import { FileUploadField } from "@/components/data/file-upload-field";
import { FilterBar } from "@/components/data/filter-bar";
import { MasterCombobox, type MasterOption } from "@/components/data/master-combobox";
import {
  deleteVehicleExpenseTxn,
  saveVehicleExpenseTxn,
} from "@/app/(app)/vehicle/expenses/actions";
import {
  downloadVehicleExpenseTemplate,
  importVehicleExpenses,
} from "@/app/(app)/vehicle/expenses/import-actions";

export interface VehicleExpenseItemRow {
  vehicleId: string;
  vehicle: string;
  ownership: string;
  amount: number;
}

export interface VehicleExpenseRow {
  id: string;
  voucherNo: string;
  date: string;
  txnType: string;
  headId: string;
  head: string;
  partyId: string | null;
  party: string;
  paymentMode: string; // "" = credit
  bankPartyId: string | null;
  bank: string;
  paymentDate: string | null;
  amount: number;
  itemName: string;
  qty: number | null;
  refNo: string;
  remarks: string;
  attachmentPath: string | null;
  attachmentName: string;
  items: VehicleExpenseItemRow[];
  /** optional head-wise split of the same bill */
  lines: { headId: string; head: string; amount: number; remarks: string }[];
}

function textToIso(text: string): string {
  const d = parseDdMmYyyy(text);
  if (!d) return "";
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${d.getFullYear()}-${mm}-${dd}`;
}

interface FormItem {
  vehicleId: string | null;
  amount: number;
}

const emptyForm = {
  id: null as string | null,
  dateText: formatDate(new Date()),
  txnType: "EXPENSE" as "EXPENSE" | "INCOME",
  headId: null as string | null,
  partyId: null as string | null,
  paymentMode: "CASH" as "CASH" | "BANK" | "CARD" | "CREDIT",
  bankPartyId: null as string | null,
  paymentDateText: formatDate(new Date()),
  refNo: "",
  remarks: "",
  itemName: "",
  qty: 0,
  bulkAmount: 0,
  attachmentPath: null as string | null,
  attachmentName: "",
  items: [{ vehicleId: null, amount: 0 }] as FormItem[],
  // one bill, many heads: optional split rows (head + amount + note)
  lines: [] as { headId: string | null; amount: number; remarks: string }[],
};

export function VehicleExpenseClient({
  rows,
  vehicleOptions,
  headOptions,
  partyOptions,
  bankOptions,
  canDelete,
}: {
  rows: VehicleExpenseRow[];
  vehicleOptions: MasterOption[];
  headOptions: MasterOption[];
  partyOptions: MasterOption[];
  bankOptions: MasterOption[];
  canDelete: boolean;
}) {
  const router = useRouter();
  const { toast } = useToast();
  const [busy, setBusy] = React.useState(false);
  const [open, setOpen] = React.useState(false);
  const [form, setForm] = React.useState(emptyForm);
  const set = (p: Partial<typeof emptyForm>) => setForm((f) => ({ ...f, ...p }));
  const setItem = (idx: number, p: Partial<FormItem>) =>
    setForm((f) => ({ ...f, items: f.items.map((it, i) => (i === idx ? { ...it, ...p } : it)) }));

  const validItems = form.items.filter((i) => i.vehicleId && i.amount > 0);
  const total = Math.round(validItems.reduce((s, i) => s + i.amount, 0) * 100) / 100;
  const heads = headOptions.filter((h) => h.meta === form.txnType);

  // valid split lines; when ≥2 the bill is multi-head — their sum must match
  // the bill total (vehicle splits or bulk amount)
  const splitLines = form.lines.filter((l) => l.headId && l.amount > 0);
  const splitTotal = Math.round(splitLines.reduce((s, l) => s + l.amount, 0) * 100) / 100;
  const usingSplit = splitLines.length >= 2;
  const billTotal = validItems.length ? total : form.bulkAmount;

  /** split a total equally across the current vehicle rows */
  const splitEqually = (grand: number) => {
    const n = form.items.filter((i) => i.vehicleId).length || form.items.length;
    if (!n || grand <= 0) return;
    const share = Math.round((grand / n) * 100) / 100;
    setForm((f) => ({ ...f, items: f.items.map((it) => ({ ...it, amount: share })) }));
  };

  const openEdit = React.useCallback((row: VehicleExpenseRow) => {
    setForm({
      id: row.id,
      dateText: formatDate(row.date),
      txnType: row.txnType as "EXPENSE" | "INCOME",
      headId: row.headId,
      partyId: row.partyId,
      paymentMode: (row.paymentMode || "CREDIT") as "CASH" | "BANK" | "CARD" | "CREDIT",
      bankPartyId: row.bankPartyId,
      paymentDateText: row.paymentDate ? formatDate(row.paymentDate) : formatDate(row.date),
      refNo: row.refNo,
      remarks: row.remarks,
      itemName: row.itemName,
      qty: row.qty ?? 0,
      // a purchase with no vehicle split keeps its own amount
      bulkAmount: row.items.length ? 0 : row.amount,
      attachmentPath: row.attachmentPath,
      attachmentName: row.attachmentName,
      items: row.items.map((i) => ({ vehicleId: i.vehicleId, amount: i.amount })),
      lines: row.lines.map((l) => ({ headId: l.headId, amount: l.amount, remarks: l.remarks })),
    });
    setOpen(true);
  }, []);

  const submit = async () => {
    setBusy(true);
    try {
      const res = await saveVehicleExpenseTxn({
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
        paymentDate:
          form.paymentMode === "CREDIT" ? null : textToIso(form.paymentDateText) || null,
        refNo: form.refNo,
        remarks: form.remarks,
        attachmentPath: form.attachmentPath,
        attachmentName: form.attachmentName,
        itemName: form.itemName || null,
        qty: form.qty || null,
        // bill amount travels whenever entered — with vehicle splits it may
        // exceed them (remainder stays unallocated bulk stock)
        amount: form.bulkAmount > 0 ? form.bulkAmount : validItems.length ? null : form.bulkAmount,
        items: validItems.map((i) => ({ vehicleId: i.vehicleId!, amount: i.amount })),
      });
      if (res.ok) {
        toast({
          title: `${res.voucherNo} saved`,
          description:
            "Single accounting voucher posted; relative-vehicle shares moved to owner ledgers.",
        });
        setOpen(false);
        router.refresh();
      } else toast({ variant: "destructive", title: "Save failed", description: res.error });
    } finally {
      setBusy(false);
    }
  };

  const columns: ColumnDef<VehicleExpenseRow>[] = React.useMemo(() => [
    { accessorKey: "voucherNo", header: "Voucher No" },
    { accessorKey: "date", header: "Date", cell: ({ row }) => formatDate(row.original.date) },
    { accessorKey: "head", header: "Head" },
    {
      id: "vehicles",
      header: "Vehicles",
      cell: ({ row }) => (
        <div className="flex max-w-md flex-wrap gap-1">
          {row.original.items.map((i, idx) => (
            <Badge key={idx} variant="outline" className="font-normal">
              {i.vehicle}
              {i.ownership === "RELATIVE" ? " (Rel)" : ""} — {formatMoney(i.amount)}
            </Badge>
          ))}
        </div>
      ),
    },
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
    {
      accessorKey: "amount",
      header: "Total Amount",
      cell: ({ row }) => formatMoney(row.original.amount),
      meta: {
        numeric: true,
        total: (rs) => formatMoney(rs.reduce((s, r) => s + r.amount, 0)),
      } satisfies DataTableColumnMeta<VehicleExpenseRow>,
    },
    { accessorKey: "refNo", header: "Ref No" },
    {
      id: "attachment",
      header: "Bill",
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
          <Button
            variant="ghost"
            size="sm"
            className="h-6 px-2 text-xs"
            onClick={() => openEdit(row.original)}
          >
            Edit
          </Button>
          {canDelete && (
            <Button
              variant="ghost"
              size="sm"
              className="h-6 px-2 text-xs text-destructive"
              onClick={async () => {
                if (!confirm(`Delete ${row.original.voucherNo}? Ledger will be reversed.`)) return;
                const res = await deleteVehicleExpenseTxn(row.original.id);
                if (res.ok) {
                  toast({ title: `${row.original.voucherNo} deleted` });
                  router.refresh();
                } else
                  toast({ variant: "destructive", title: "Delete failed", description: res.error });
              }}
            >
              Delete
            </Button>
          )}
        </div>
      ),
    },
  ], [canDelete, openEdit, router, toast]);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h1 className="text-xl font-semibold">Vehicle Expenses</h1>
        <div className="flex flex-wrap gap-2">
          <ExportButton
            rows={rows.flatMap((r) =>
              r.items.map((i) => ({
                ...r,
                vehicle: i.vehicle,
                ownership: i.ownership,
                itemAmount: i.amount,
              }))
            )}
            fileName="vehicle-expense-register"
            sheetName="Vehicle Expenses"
            columns={[
              { header: "Voucher No", key: "voucherNo" },
              { header: "Date", accessor: (r) => formatDate(String(r.date)) },
              { header: "Type", key: "txnType" },
              { header: "Head", key: "head" },
              { header: "Vehicle", key: "vehicle" },
              { header: "Vehicle Type", key: "ownership" },
              { header: "Vehicle Amount", key: "itemAmount", numeric: true },
              { header: "Supplier / Party", key: "party" },
              { header: "Mode", accessor: (r) => r.paymentMode || "CREDIT" },
              { header: "Ref No", key: "refNo" },
              { header: "Remarks", key: "remarks" },
            ]}
          />
          <ImportControls />
          <Button size="sm" onClick={() => { setForm(emptyForm); setOpen(true); }}>
            <Plus className="h-4 w-4" /> New Entry
          </Button>
        </div>
      </div>
      <p className="text-sm text-muted-foreground">
        One bill, unlimited vehicles — a single accounting voucher with vehicle-wise records.
        Relative-vehicle shares transfer automatically to the owner&apos;s ledger. Trip sheets only
        fetch Diesel / Toll from here.
      </p>
      <FilterBar
        filters={[
          { type: "text", key: "q", label: "Voucher / Ref No..." },
          { type: "combobox", key: "vehicle", label: "Vehicle", options: vehicleOptions },
          { type: "combobox", key: "head", label: "Head", options: headOptions },
          {
            type: "select",
            key: "ownership",
            label: "Vehicle Type",
            options: [
              { value: "OWNER", label: "Own" },
              { value: "RELATIVE", label: "Relative" },
              { value: "BROKER", label: "Market / Broker" },
            ],
          },
          {
            type: "select",
            key: "type",
            label: "Type",
            options: [
              { value: "EXPENSE", label: "Expense" },
              { value: "INCOME", label: "Income" },
            ],
          },
          { type: "daterange", key: "date", label: "Date" },
        ]}
      />
      <DataTable columns={columns} data={rows} emptyMessage="No vehicle expenses yet." />

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-h-[95vh] overflow-y-auto sm:max-w-4xl">
          <DialogHeader>
            <DialogTitle>
              {form.id ? "Edit" : "New"} Vehicle {form.txnType === "EXPENSE" ? "Expense" : "Income"}
              {form.id ? "" : " — voucher number auto-generates"}
            </DialogTitle>
            <DialogDescription>
              Heads come from the common Income &amp; Expense Head master. Add unlimited vehicles —
              the total is the sum of vehicle amounts, booked as ONE accounting voucher.
            </DialogDescription>
          </DialogHeader>
          <div className="grid gap-3 sm:grid-cols-3">
            <div className="space-y-1">
              <Label className="text-xs">Date *</Label>
              <DateInput className="h-8" value={form.dateText} onChange={(t) => set({ dateText: t })} />
            </div>
            <div className="space-y-1">
              <Label className="text-xs">Type</Label>
              <Select
                value={form.txnType}
                onValueChange={(v) => set({ txnType: v as "EXPENSE" | "INCOME", headId: null })}
              >
                <SelectTrigger className="h-8"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="EXPENSE">Expense (default)</SelectItem>
                  <SelectItem value="INCOME">Income</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1">
              <Label className="text-xs">
                {form.txnType === "EXPENSE" ? "Expense Head *" : "Income Head *"}
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
                <SelectTrigger className="h-8"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="CASH">Cash</SelectItem>
                  <SelectItem value="BANK">Bank</SelectItem>
                  <SelectItem value="CARD">Card</SelectItem>
                  <SelectItem value="CREDIT">Credit — settle later</SelectItem>
                </SelectContent>
              </Select>
            </div>
            {form.paymentMode !== "CREDIT" && (
              <>
                <div className="space-y-1">
                  <Label className="text-xs">Cash / Bank Account *</Label>
                  <MasterCombobox
                    options={bankOptions.filter((b) =>
                      b.meta === form.paymentMode
                    )}
                    value={form.bankPartyId}
                    onChange={(v) => set({ bankPartyId: v })}
                    placeholder="Select account..."
                  />
                </div>
                <div className="space-y-1">
                  <Label className="text-xs">Payment Date (may differ from bill date)</Label>
                  <DateInput
                    className="h-8"
                    value={form.paymentDateText}
                    onChange={(t) => set({ paymentDateText: t })}
                  />
                </div>
              </>
            )}
            <div className="space-y-1">
              <Label className="text-xs">Item / Material</Label>
              <Input
                className="h-8"
                placeholder="e.g. Chain, Tyre, Battery"
                value={form.itemName}
                onChange={(e) => set({ itemName: e.target.value })}
              />
            </div>
            <div className="space-y-1">
              <Label className="text-xs">Quantity</Label>
              <Input
                type="number"
                className="h-8 text-right"
                placeholder="e.g. 10"
                value={form.qty ? String(form.qty) : ""}
                onChange={(e) => set({ qty: Number(e.target.value) || 0 })}
              />
            </div>
            <div className="space-y-1">
              <Label className="text-xs">Reference / Bill No</Label>
              <Input className="h-8" value={form.refNo} onChange={(e) => set({ refNo: e.target.value })} />
            </div>
            <div className="space-y-1 sm:col-span-2">
              <Label className="text-xs">Remarks</Label>
              <Input className="h-8" value={form.remarks} onChange={(e) => set({ remarks: e.target.value })} />
            </div>
          </div>

          {/* vehicle allocation grid */}
          <div className="space-y-2">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <Label className="text-xs font-medium">
                Vehicle Selection — optional ({validItems.length} vehicle
                {validItems.length === 1 ? "" : "s"} — total {formatMoney(total)})
              </Label>
              <div className="flex flex-wrap gap-2">
                <SplitControl onSplit={splitEqually} />
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="h-7"
                  onClick={() =>
                    set({ items: [...form.items, { vehicleId: null, amount: 0 }] })
                  }
                >
                  <Plus className="h-3 w-3" /> Add Vehicle
                </Button>
              </div>
            </div>
            {validItems.length === 0 && (
              <div className="grid gap-1 rounded-md border bg-muted/40 p-2 sm:grid-cols-[1fr_160px]">
                <p className="text-xs text-muted-foreground">
                  No vehicle selected — this is a <b>bulk purchase</b>. It posts the accounting now
                  and waits in <b>Expense Allocation</b> until vehicles consume it.
                </p>
                <div className="space-y-1">
                  <Label className="text-xs">Purchase Amount *</Label>
                  <Input
                    type="number"
                    className="h-8 text-right"
                    value={form.bulkAmount ? String(form.bulkAmount) : ""}
                    onChange={(e) => set({ bulkAmount: Number(e.target.value) || 0 })}
                  />
                </div>
              </div>
            )}
            {form.items.map((it, i) => (
              <div key={i} className="grid grid-cols-[1fr_140px_2rem] gap-1">
                <MasterCombobox
                  options={vehicleOptions.filter(
                    (v) =>
                      v.value === it.vehicleId ||
                      !form.items.some((x) => x.vehicleId === v.value)
                  )}
                  value={it.vehicleId}
                  onChange={(v) => setItem(i, { vehicleId: v })}
                  placeholder="Select vehicle..."
                />
                <Input
                  type="number"
                  className="h-9 text-right"
                  placeholder="Amount"
                  value={it.amount ? String(it.amount) : ""}
                  onChange={(e) => setItem(i, { amount: Number(e.target.value) || 0 })}
                />
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="h-9 w-8 p-0 text-destructive"
                  disabled={form.items.length === 1 && !form.items[0].vehicleId}
                  onClick={() =>
                    set({ items: form.items.filter((_, idx) => idx !== i) })
                  }
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </Button>
              </div>
            ))}
          </div>

          {/* one bill, many heads: optional head-wise split */}
          <div className="space-y-1">
            <div className="flex items-center justify-between">
              <Label className="text-xs">
                Head-wise Split (optional — same bill, different heads; e.g. Spare Parts + Repair
                Labour)
              </Label>
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="h-6 px-2 text-xs"
                onClick={() => set({ lines: [...form.lines, { headId: null, amount: 0, remarks: "" }] })}
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
                      lines: form.lines.map((x, j) => (j === i ? { ...x, remarks: e.target.value } : x)),
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
              <p className={`text-xs ${Math.abs(splitTotal - billTotal) > 0.009 ? "font-medium text-destructive" : "text-muted-foreground"}`}>
                Split total <b className="tabular-nums">{splitTotal.toFixed(2)}</b>
                {Math.abs(splitTotal - billTotal) > 0.009
                  ? ` — must match the bill total ${billTotal.toFixed(2)}`
                  : " — each head posts its share to the ledger/P&L; supplier, payment and vehicle allocation apply on the full total"}
              </p>
            )}
          </div>

          <div className="grid gap-2 sm:grid-cols-2">
            <FileUploadField
              label="Attachment (Bill / Image / PDF)"
              endpoint="/api/uploads/docreg"
              filePath={form.attachmentPath}
              fileName={form.attachmentName || null}
              onChange={(path, name) =>
                set({ attachmentPath: path, attachmentName: name ?? "" })
              }
            />
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={() => setOpen(false)} disabled={busy}>Cancel</Button>
            <Button
              disabled={
                busy ||
                (usingSplit ? Math.abs(splitTotal - billTotal) > 0.009 : !form.headId) ||
                (validItems.length === 0 && form.bulkAmount <= 0) ||
                (form.paymentMode === "CREDIT" ? !form.partyId : !form.bankPartyId)
              }
              onClick={submit}
            >
              {busy ? "Saving..." : form.id ? "Update & Re-post" : "Save & Post"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

/** Excel template (dynamic master dropdowns) + bulk import controls */
function ImportControls() {
  const router = useRouter();
  const { toast } = useToast();
  const fileRef = React.useRef<HTMLInputElement>(null);
  const [busy, setBusy] = React.useState<"template" | "import" | null>(null);

  const downloadTemplate = async () => {
    setBusy("template");
    try {
      const res = await downloadVehicleExpenseTemplate();
      if (!res.ok) {
        toast({ variant: "destructive", title: "Template failed", description: res.error });
        return;
      }
      const bin = atob(res.base64);
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      const blob = new Blob([bytes], {
        type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      });
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = "vehicle-expenses-template.xlsx";
      a.click();
      URL.revokeObjectURL(a.href);
      toast({
        title: "Template downloaded",
        description: "Dropdowns contain the current master data. Voucher numbers auto-generate.",
      });
    } finally {
      setBusy(null);
    }
  };

  const doImport = async (file: File) => {
    setBusy("import");
    try {
      const fd = new FormData();
      fd.append("file", file);
      const s = await importVehicleExpenses(fd);
      toast({
        variant: s.failed > 0 || !s.ok ? "destructive" : undefined,
        title: `Import finished — Imported: ${s.imported} · Skipped: ${s.skipped} · Failed: ${s.failed}`,
        description: s.errors.slice(0, 5).join(" | ") || undefined,
      });
      router.refresh();
    } finally {
      setBusy(null);
      if (fileRef.current) fileRef.current.value = "";
    }
  };

  return (
    <span className="flex items-center gap-1">
      <input
        ref={fileRef}
        type="file"
        accept=".xlsx,.csv"
        className="hidden"
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) void doImport(f);
        }}
      />
      {/* labels drop below sm, matching the shared Export / Import buttons */}
      <Button
        type="button"
        variant="outline"
        size="sm"
        disabled={busy !== null}
        onClick={downloadTemplate}
        title="Download an Excel template with the expected columns"
        aria-label="Excel template"
        className="max-sm:px-2.5"
      >
        {busy === "template" ? (
          <Loader2 className="h-4 w-4 animate-spin" />
        ) : (
          <Download className="h-4 w-4" />
        )}
        <span className="hidden sm:inline">
          {busy === "template" ? "Preparing..." : "Excel Template"}
        </span>
      </Button>
      <Button
        type="button"
        variant="outline"
        size="sm"
        disabled={busy !== null}
        onClick={() => fileRef.current?.click()}
        title="Import expenses from an Excel (.xlsx) or CSV file"
        aria-label="Import Excel"
        className="max-sm:px-2.5"
      >
        {busy === "import" ? (
          <Loader2 className="h-4 w-4 animate-spin" />
        ) : (
          <Upload className="h-4 w-4" />
        )}
        <span className="hidden sm:inline">
          {busy === "import" ? "Importing..." : "Import Excel"}
        </span>
      </Button>
    </span>
  );
}

/** "total amount + split equally" helper control */
function SplitControl({ onSplit }: { onSplit: (grand: number) => void }) {
  const [grand, setGrand] = React.useState(0);
  return (
    <div className="flex items-center gap-1">
      <Input
        type="number"
        className="h-7 w-28 text-right text-xs"
        placeholder="Bill total..."
        value={grand ? String(grand) : ""}
        onChange={(e) => setGrand(Number(e.target.value) || 0)}
      />
      <Button
        type="button"
        variant="secondary"
        size="sm"
        className="h-7 text-xs"
        disabled={grand <= 0}
        onClick={() => onSplit(grand)}
      >
        Split Equally
      </Button>
    </div>
  );
}
