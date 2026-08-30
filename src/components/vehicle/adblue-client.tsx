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
import { deleteAdblueTxn, saveAdblueTxn } from "@/app/(app)/vehicle/adblue/actions";

export interface AdblueRow {
  id: string;
  type: string; // REFILL | ISSUE
  date: string;
  supplierName: string;
  supplierId: string | null;
  vehicleId: string | null;
  vehicle: string;
  destination: string;
  qty: number;
  amount: number;
  billNo: string;
  billDate: string | null;
  gstPct: number;
  gstAmount: number;
  paymentMode: string; // "" = on credit
  bankPartyId: string | null;
  refNo: string;
  remarks: string;
  /** PENDING BILL | BILL UPDATED | PARTLY PAID | PAID */
  status: string;
  /** days a receipt has been waiting for its invoice */
  pendingDays: number | null;
}

function textToIso(text: string): string {
  const d = parseDdMmYyyy(text);
  if (!d) return "";
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${d.getFullYear()}-${mm}-${dd}`;
}

const litres = (n: number) => `${n.toLocaleString("en-IN")} L`;

const emptyForm = {
  id: null as string | null,
  type: "REFILL" as "REFILL" | "ISSUE",
  dateText: formatDate(new Date()),
  supplierName: "",
  vehicleId: null as string | null,
  destination: "",
  qty: 0,
  amount: 0,
  supplierId: null as string | null,
  billNo: "",
  billDateText: "",
  gstPct: 0,
  gstAmount: 0,
  paymentMode: "CREDIT" as "CASH" | "BANK" | "CARD" | "CREDIT",
  bankPartyId: null as string | null,
  refNo: "",
  remarks: "",
};

export function AdblueClient({
  rows,
  totals,
  vehicleOptions,
  bankOptions,
  partyOptions,
  canDelete,
}: {
  rows: AdblueRow[];
  totals: { totalRefill: number; totalIssued: number; closing: number };
  vehicleOptions: MasterOption[];
  bankOptions: MasterOption[];
  partyOptions: MasterOption[];
  canDelete: boolean;
}) {
  const router = useRouter();
  const { toast } = useToast();
  const [busy, setBusy] = React.useState(false);
  const [open, setOpen] = React.useState(false);
  const [form, setForm] = React.useState(emptyForm);
  const set = (p: Partial<typeof emptyForm>) => setForm((f) => ({ ...f, ...p }));

  const openNew = (type: "REFILL" | "ISSUE") => {
    setForm({ ...emptyForm, type });
    setOpen(true);
  };

  const submit = async () => {
    setBusy(true);
    try {
      const res = await saveAdblueTxn({
        id: form.id,
        type: form.type,
        date: textToIso(form.dateText),
        supplierName: form.supplierName,
        vehicleId: form.vehicleId,
        destination: form.destination,
        qty: form.qty,
        supplierId: form.supplierId,
        amount: form.amount,
        billNo: form.billNo,
        billDate: form.billDateText ? textToIso(form.billDateText) : null,
        gstPct: form.gstPct,
        gstAmount: form.gstAmount,
        paymentMode: form.paymentMode === "CREDIT" ? null : form.paymentMode,
        bankPartyId: form.paymentMode === "CREDIT" ? null : form.bankPartyId,
        refNo: form.refNo,
        remarks: form.remarks,
      });
      if (res.ok) {
        toast({ title: `AdBlue ${form.type === "REFILL" ? "refill" : "issue"} saved — stock updated` });
        setOpen(false);
        router.refresh();
      } else toast({ variant: "destructive", title: "Save failed", description: res.error });
    } finally {
      setBusy(false);
    }
  };

  const columns: ColumnDef<AdblueRow>[] = React.useMemo(() => [
    { accessorKey: "date", header: "Date", cell: ({ row }) => formatDate(row.original.date) },
    {
      accessorKey: "type",
      header: "Type",
      cell: ({ row }) =>
        row.original.type === "REFILL" ? (
          <Badge>REFILL</Badge>
        ) : (
          <Badge variant="destructive">ISSUE</Badge>
        ),
    },
    { accessorKey: "supplierName", header: "Supplier" },
    { accessorKey: "vehicle", header: "Vehicle" },
    { accessorKey: "destination", header: "Destination" },
    {
      accessorKey: "qty",
      header: "Litres",
      cell: ({ row }) => (
        <span className={row.original.type === "REFILL" ? "text-emerald-600" : ""}>
          {row.original.type === "REFILL" ? "+" : "−"}
          {row.original.qty.toLocaleString("en-IN")}
        </span>
      ),
      meta: { numeric: true } satisfies DataTableColumnMeta<AdblueRow>,
    },
    { accessorKey: "billNo", header: "Bill No" },
    {
      accessorKey: "amount",
      header: "Purchase Amt",
      cell: ({ row }) => (row.original.amount ? formatMoney(row.original.amount) : ""),
      meta: { numeric: true } satisfies DataTableColumnMeta<AdblueRow>,
    },
    {
      accessorKey: "status",
      header: "Status",
      cell: ({ row }) =>
        row.original.type === "ISSUE" ? null : (
          <Badge variant={row.original.status === "PENDING BILL" ? "destructive" : "outline"}>
            {row.original.status}
          </Badge>
        ),
    },
    {
      accessorKey: "pendingDays",
      header: "Pending Days",
      cell: ({ row }) => row.original.pendingDays ?? "",
      meta: { numeric: true } satisfies DataTableColumnMeta<AdblueRow>,
    },
    { accessorKey: "remarks", header: "Remarks" },
    {
      id: "actions",
      header: "",
      cell: ({ row }) => (
        <div className="flex gap-1" onClick={(e) => e.stopPropagation()}>
          <Button
            variant="ghost"
            size="sm"
            className="h-6 px-2 text-xs"
            onClick={() => {
              setForm({
                id: row.original.id,
                type: row.original.type as "REFILL" | "ISSUE",
                dateText: formatDate(row.original.date),
                supplierName: row.original.supplierName,
                supplierId: row.original.supplierId,
                vehicleId: row.original.vehicleId,
                destination: row.original.destination,
                qty: row.original.qty,
                amount: row.original.amount,
                billNo: row.original.billNo,
                billDateText: row.original.billDate ? formatDate(row.original.billDate) : "",
                gstPct: row.original.gstPct,
                gstAmount: row.original.gstAmount,
                paymentMode: (row.original.paymentMode || "CREDIT") as "CASH" | "BANK" | "CARD" | "CREDIT",
                bankPartyId: row.original.bankPartyId,
                refNo: row.original.refNo,
                remarks: row.original.remarks,
              });
              setOpen(true);
            }}
          >
            Edit
          </Button>
          {canDelete && (
            <Button
              variant="ghost"
              size="sm"
              className="h-6 px-2 text-xs text-destructive"
              onClick={async () => {
                if (!confirm("Delete this entry? Stock balance will adjust.")) return;
                const res = await deleteAdblueTxn(row.original.id);
                if (res.ok) {
                  toast({ title: "Entry deleted" });
                  router.refresh();
                } else toast({ variant: "destructive", title: "Delete failed", description: res.error });
              }}
            >
              Delete
            </Button>
          )}
        </div>
      ),
    },
  ], [canDelete, router, toast]);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h1 className="text-xl font-semibold">AdBlue (Urea) Stock</h1>
        <div className="flex flex-wrap gap-2">
          <ExportButton
            rows={rows}
            fileName="adblue-register"
            sheetName="AdBlue Register"
            columns={[
              { header: "Date", accessor: (r) => formatDate(r.date) },
              { header: "Type", key: "type" },
              { header: "Supplier", key: "supplierName" },
              { header: "Vehicle", key: "vehicle" },
              { header: "Destination", key: "destination" },
              { header: "Litres", key: "qty", numeric: true },
              { header: "Challan No", key: "refNo" },
              { header: "Bill No", key: "billNo" },
              { header: "Purchase Amount", key: "amount", numeric: true },
              { header: "Pending Days", key: "pendingDays", numeric: true },
              { header: "Status", key: "status" },
              { header: "Remarks", key: "remarks" },
            ]}
          />
          <Button variant="outline" size="sm" onClick={() => openNew("REFILL")}>
            <Plus className="h-4 w-4" /> Total Refill
          </Button>
          <Button size="sm" onClick={() => openNew("ISSUE")}>
            <Plus className="h-4 w-4" /> Issue to Vehicle
          </Button>
        </div>
      </div>

      {/* stock position */}
      <div className="grid grid-cols-3 gap-2 sm:max-w-xl">
        {(
          [
            ["Total Refill", totals.totalRefill],
            ["Total Issued", totals.totalIssued],
            ["Closing Balance", totals.closing],
          ] as [string, number][]
        ).map(([label, v]) => (
          <div key={label} className="rounded-md border p-3">
            <div className="text-[11px] text-muted-foreground">{label}</div>
            <div className={`text-lg font-semibold ${label === "Closing Balance" && v < 0 ? "text-destructive" : ""}`}>
              {litres(v)}
            </div>
          </div>
        ))}
      </div>
      <p className="text-sm text-muted-foreground">
        Stock first, bill later: a refill increases litres immediately and posts nothing until its
        invoice is entered on the same row. Purchase accounting never touches vehicle P&amp;L &mdash;
        urea reaches a vehicle only through trip-sheet consumption (issued litres, at the rate
        entered there).
      </p>

      <FilterBar
        filters={[
          {
            type: "select",
            key: "type",
            label: "Type",
            options: [
              { value: "REFILL", label: "Refill (Stock In)" },
              { value: "ISSUE", label: "Issue (Consumption)" },
            ],
          },
          {
            type: "select",
            key: "status",
            label: "Bill Status",
            options: [
              { value: "PENDING", label: "Pending Bill" },
              { value: "BILLED", label: "Bill Updated" },
              { value: "PARTLY", label: "Partly Paid" },
              { value: "PAID", label: "Paid" },
            ],
          },
          { type: "combobox", key: "vehicle", label: "Vehicle", options: vehicleOptions },
          { type: "daterange", key: "date", label: "Date" },
        ]}
      />
      <DataTable columns={columns} data={rows} emptyMessage="No AdBlue entries yet." />

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-xl">
          <DialogHeader>
            <DialogTitle>
              {form.id ? "Edit" : "New"} AdBlue {form.type === "REFILL" ? "Refill (Stock In)" : "Issue (Vehicle Consumption)"}
            </DialogTitle>
            <DialogDescription>
              Litres only — stock {form.type === "REFILL" ? "increases" : "decreases"}; no
              accounting entry is created.
            </DialogDescription>
          </DialogHeader>
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1">
              <Label className="text-xs">Date *</Label>
              <DateInput className="h-8" value={form.dateText} onChange={(t) => set({ dateText: t })} />
            </div>
            {form.type === "REFILL" ? (
              <div className="space-y-1">
                <Label className="text-xs">Supplier Name (optional)</Label>
                <Input
                  className="h-8"
                  value={form.supplierName}
                  onChange={(e) => set({ supplierName: e.target.value })}
                />
              </div>
            ) : (
              <div className="space-y-1">
                <Label className="text-xs">Destination</Label>
                <Input
                  className="h-8"
                  value={form.destination}
                  onChange={(e) => set({ destination: e.target.value })}
                />
              </div>
            )}
            <div className="space-y-1">
              <Label className="text-xs">
                Vehicle No {form.type === "ISSUE" ? "*" : "(optional)"}
              </Label>
              <MasterCombobox
                options={vehicleOptions}
                value={form.vehicleId}
                onChange={(v) => set({ vehicleId: v })}
                placeholder="Select vehicle..."
              />
            </div>
            <div className="space-y-1">
              <Label className="text-xs">
                {form.type === "REFILL" ? "Total Refill (Litres) *" : "Quantity Issued (Litres) *"}
              </Label>
              <Input
                type="number"
                step="0.01"
                className="h-8 text-right"
                value={form.qty ? String(form.qty) : ""}
                onChange={(e) => set({ qty: Number(e.target.value) || 0 })}
              />
            </div>
            {form.type === "REFILL" && (
              <>
                <div className="space-y-1">
                  <Label className="text-xs">Challan No (optional)</Label>
                  <Input className="h-8" value={form.refNo} onChange={(e) => set({ refNo: e.target.value })} />
                </div>
                <div className="space-y-1 sm:col-span-2">
                  <p className="rounded-md border bg-muted/40 p-2 text-[11px] text-muted-foreground">
                    <b>Bill details are optional.</b> Leave them blank while the invoice is awaited
                    &mdash; stock increases now and nothing is posted. Fill them in on this same
                    entry when the bill arrives, and the accounting is booked then.
                  </p>
                </div>
                <div className="space-y-1">
                  <Label className="text-xs">Supplier Ledger</Label>
                  <MasterCombobox
                    options={partyOptions}
                    value={form.supplierId}
                    onChange={(v) => set({ supplierId: v })}
                    placeholder="Select supplier..."
                  />
                </div>
                <div className="space-y-1">
                  <Label className="text-xs">Bill No</Label>
                  <Input className="h-8" value={form.billNo} onChange={(e) => set({ billNo: e.target.value })} />
                </div>
                <div className="space-y-1">
                  <Label className="text-xs">Bill Date</Label>
                  <DateInput
                    className="h-8"
                    value={form.billDateText}
                    onChange={(t) => set({ billDateText: t })}
                  />
                </div>
                <div className="space-y-1">
                  <Label className="text-xs">Purchase Amount (incl. GST)</Label>
                  <Input
                    type="number"
                    step="0.01"
                    className="h-8 text-right"
                    value={form.amount ? String(form.amount) : ""}
                    onChange={(e) => set({ amount: Number(e.target.value) || 0 })}
                  />
                </div>
                <div className="space-y-1">
                  <Label className="text-xs">GST %</Label>
                  <Input
                    type="number"
                    step="0.01"
                    className="h-8 text-right"
                    value={form.gstPct ? String(form.gstPct) : ""}
                    onChange={(e) => {
                      const gstPct = Number(e.target.value) || 0;
                      // informational split of the amount already entered
                      const gstAmount = form.amount
                        ? Math.round((form.amount - form.amount / (1 + gstPct / 100)) * 100) / 100
                        : 0;
                      set({ gstPct, gstAmount });
                    }}
                  />
                </div>
                <div className="space-y-1">
                  <Label className="text-xs">GST Amount</Label>
                  <Input
                    type="number"
                    step="0.01"
                    className="h-8 text-right"
                    value={form.gstAmount ? String(form.gstAmount) : ""}
                    onChange={(e) => set({ gstAmount: Number(e.target.value) || 0 })}
                  />
                </div>
                <div className="space-y-1">
                  <Label className="text-xs">Payment</Label>
                  <Select
                    value={form.paymentMode}
                    onValueChange={(v) => set({ paymentMode: v as "CASH" | "BANK" | "CARD" | "CREDIT" })}
                  >
                    <SelectTrigger className="h-8"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="CREDIT">On credit (settle by voucher)</SelectItem>
                      <SelectItem value="CASH">Paid &mdash; Cash</SelectItem>
                      <SelectItem value="BANK">Paid &mdash; Bank</SelectItem>
                      <SelectItem value="CARD">Paid &mdash; Card</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                {form.paymentMode !== "CREDIT" && (
                  <div className="space-y-1">
                    <Label className="text-xs">Paid From (Cash / Bank) *</Label>
                    <MasterCombobox
                      options={bankOptions}
                      value={form.bankPartyId}
                      onChange={(v) => set({ bankPartyId: v })}
                      placeholder="Select account..."
                    />
                  </div>
                )}
                {form.amount > 0 && (
                  <div className="space-y-1 sm:col-span-2">
                    <p className="text-[11px] text-muted-foreground">
                      Books Urea Expense Dr / Supplier Cr. It never reaches vehicle P&amp;L &mdash;
                      urea hits a vehicle only through trip-sheet consumption.
                    </p>
                  </div>
                )}
              </>
            )}
            <div className="space-y-1">
              <Label className="text-xs">Remarks</Label>
              <Input className="h-8" value={form.remarks} onChange={(e) => set({ remarks: e.target.value })} />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setOpen(false)} disabled={busy}>Cancel</Button>
            <Button
              disabled={busy || form.qty <= 0 || (form.type === "ISSUE" && !form.vehicleId)}
              onClick={submit}
            >
              {busy ? "Saving..." : "Save Entry"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
