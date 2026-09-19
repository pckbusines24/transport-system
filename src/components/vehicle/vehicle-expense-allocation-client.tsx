"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import type { ColumnDef } from "@tanstack/react-table";
import { Loader2, Plus, Trash2 } from "lucide-react";
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
import { DataTable, type DataTableColumnMeta } from "@/components/data/data-table";
import { ExportButton } from "@/components/data/export-button";
import { FilterBar } from "@/components/data/filter-bar";
import type { MasterOption } from "@/components/data/master-combobox";
import { VehicleCombobox } from "@/components/fleet/fields";
import {
  allocateVehicleExpense,
  deleteVehicleExpenseAllocation,
  type AllocationRow,
  type UnallocatedPurchase,
} from "@/app/(app)/vehicle/expenses/allocation-actions";

function textToIso(text: string): string {
  const d = parseDdMmYyyy(text);
  if (!d) return "";
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${d.getFullYear()}-${mm}-${dd}`;
}

interface FormRow {
  vehicleId: string | null;
  qty: number;
  amount: number;
  remarks: string;
}

const emptyRow = (): FormRow => ({ vehicleId: null, qty: 0, amount: 0, remarks: "" });

/**
 * Allocation screen: unallocated purchases on top, allocation history below.
 * Allocating never posts accounting — the purchase already did — so the dialog
 * only asks who took how much, and when.
 */
export function VehicleExpenseAllocationClient({
  purchases,
  history,
  vehicleOptions,
}: {
  purchases: UnallocatedPurchase[];
  history: AllocationRow[];
  vehicleOptions: MasterOption[];
}) {
  const router = useRouter();
  const { toast } = useToast();
  const [open, setOpen] = React.useState<UnallocatedPurchase | null>(null);
  const [dateText, setDateText] = React.useState(formatDate(new Date()));
  const [rows, setRows] = React.useState<FormRow[]>([emptyRow()]);
  const [saving, setSaving] = React.useState(false);

  const start = (p: UnallocatedPurchase) => {
    setOpen(p);
    setDateText(formatDate(new Date()));
    setRows([emptyRow()]);
  };

  const setRow = (i: number, patch: Partial<FormRow>) =>
    setRows((rs) => rs.map((r, idx) => (idx === i ? { ...r, ...patch } : r)));

  const allocatedAmt = Math.round(rows.reduce((s, r) => s + (r.amount || 0), 0) * 100) / 100;
  const allocatedQty = Math.round(rows.reduce((s, r) => s + (r.qty || 0), 0) * 100) / 100;
  const overAmount = !!open && allocatedAmt > open.remainingAmount + 0.009;
  const overQty =
    !!open && open.remainingQty != null && allocatedQty > open.remainingQty + 0.009;

  /**
   * Rate from the purchase, so entering "3 chains" fills 30,000 of a 100,000 /
   * 10-chain bill. Typing over the amount is always allowed — a damaged tyre may
   * be worth booking differently from its share of the invoice.
   */
  const rateOf = (p: UnallocatedPurchase) =>
    p.qty && p.qty > 0 ? p.amount / p.qty : null;

  const save = async () => {
    if (!open) return;
    const iso = textToIso(dateText);
    if (!iso) return toast({ variant: "destructive", title: "Valid allocation date required" });
    const usable = rows.filter((r) => r.vehicleId && r.amount > 0);
    if (!usable.length) {
      return toast({ variant: "destructive", title: "Add at least one vehicle with an amount" });
    }
    setSaving(true);
    try {
      const res = await allocateVehicleExpense({
        voucherId: open.id,
        rows: usable.map((r) => ({
          vehicleId: r.vehicleId,
          qty: r.qty || null,
          amount: r.amount,
          allocDate: iso,
          remarks: r.remarks || null,
        })),
      });
      if (res.ok) {
        toast({ title: "Allocated" });
        setOpen(null);
        router.refresh();
      } else {
        toast({ variant: "destructive", title: "Allocation failed", description: res.error });
      }
    } finally {
      setSaving(false);
    }
  };

  const removeAllocation = async (id: string) => {
    const res = await deleteVehicleExpenseAllocation(id);
    if (res.ok) {
      toast({ title: "Allocation removed" });
      router.refresh();
    } else {
      toast({ variant: "destructive", title: "Delete failed", description: res.error });
    }
  };

  const money = { numeric: true } satisfies DataTableColumnMeta<never>;

  const purchaseColumns: ColumnDef<UnallocatedPurchase, unknown>[] = [
    { accessorKey: "voucherNo", header: "Voucher No" },
    {
      accessorKey: "date",
      header: "Purchase Date",
      cell: ({ row }) => formatDate(row.original.date),
    },
    { accessorKey: "supplier", header: "Supplier" },
    {
      accessorKey: "itemName",
      header: "Item",
      cell: ({ row }) => row.original.itemName || row.original.head,
    },
    {
      accessorKey: "qty",
      header: "Purchased Qty",
      meta: money,
      cell: ({ row }) => row.original.qty ?? "",
    },
    {
      accessorKey: "allocatedQty",
      header: "Allocated Qty",
      meta: money,
      cell: ({ row }) => (row.original.qty == null ? "" : row.original.allocatedQty),
    },
    {
      accessorKey: "remainingQty",
      header: "Remaining Qty",
      meta: money,
      cell: ({ row }) => row.original.remainingQty ?? "",
    },
    {
      accessorKey: "amount",
      header: "Amount",
      meta: money,
      cell: ({ row }) => formatMoney(row.original.amount),
    },
    {
      accessorKey: "allocatedAmount",
      header: "Allocated",
      meta: money,
      cell: ({ row }) => formatMoney(row.original.allocatedAmount),
    },
    {
      accessorKey: "remainingAmount",
      header: "Remaining",
      meta: money,
      cell: ({ row }) => formatMoney(row.original.remainingAmount),
    },
    {
      id: "actions",
      header: "",
      cell: ({ row }) => (
        <Button size="sm" variant="outline" onClick={() => start(row.original)}>
          Allocate
        </Button>
      ),
    },
  ];

  const historyColumns: ColumnDef<AllocationRow, unknown>[] = [
    {
      accessorKey: "allocDate",
      header: "Allocation Date",
      cell: ({ row }) => formatDate(row.original.allocDate),
    },
    { accessorKey: "vehicle", header: "Vehicle" },
    {
      accessorKey: "itemName",
      header: "Item",
      cell: ({ row }) => row.original.itemName || row.original.head,
    },
    {
      accessorKey: "qty",
      header: "Qty",
      meta: money,
      cell: ({ row }) => row.original.qty ?? "",
    },
    {
      accessorKey: "amount",
      header: "Amount",
      meta: money,
      cell: ({ row }) => formatMoney(row.original.amount),
    },
    { accessorKey: "voucherNo", header: "Source Voucher" },
    {
      accessorKey: "purchaseDate",
      header: "Purchase Date",
      cell: ({ row }) => formatDate(row.original.purchaseDate),
    },
    { accessorKey: "supplier", header: "Supplier" },
    { accessorKey: "remarks", header: "Remarks" },
    {
      id: "actions",
      header: "",
      cell: ({ row }) => (
        <Button
          size="icon"
          variant="ghost"
          onClick={() => removeAllocation(row.original.id)}
          aria-label="Remove allocation"
        >
          <Trash2 className="h-4 w-4" />
        </Button>
      ),
    },
  ];

  return (
    <div className="space-y-6">
      <section className="space-y-2">
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-semibold">
            Unallocated Vehicle Expenses ({purchases.length})
          </h2>
          <ExportButton
            rows={purchases as unknown as Record<string, unknown>[]}
            columns={[
              { key: "voucherNo", header: "Voucher No" },
              { key: "date", header: "Purchase Date" },
              { key: "supplier", header: "Supplier" },
              { key: "itemName", header: "Item" },
              { key: "qty", header: "Purchased Qty" },
              { key: "allocatedQty", header: "Allocated Qty" },
              { key: "remainingQty", header: "Remaining Qty" },
              { key: "amount", header: "Amount" },
              { key: "remainingAmount", header: "Remaining Amount" },
            ]}
            fileName="unallocated-vehicle-expenses"
          />
        </div>
        <p className="text-xs text-muted-foreground">
          Bulk stock already purchased and accounted for, waiting to be handed to the vehicles that
          use it. Allocating moves cost into the vehicle registers — it never posts accounting
          again.
        </p>
        <DataTable
          columns={purchaseColumns}
          data={purchases}
          emptyMessage="Nothing unallocated — every purchase is booked against a vehicle."
        />
      </section>

      <section className="space-y-2">
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-semibold">Allocation History ({history.length})</h2>
          <ExportButton
            rows={history as unknown as Record<string, unknown>[]}
            columns={[
              { key: "allocDate", header: "Allocation Date" },
              { key: "vehicle", header: "Vehicle" },
              { key: "itemName", header: "Item" },
              { key: "qty", header: "Qty" },
              { key: "amount", header: "Amount" },
              { key: "voucherNo", header: "Source Voucher" },
              { key: "supplier", header: "Supplier" },
              { key: "remarks", header: "Remarks" },
            ]}
            fileName="vehicle-expense-allocations"
          />
        </div>
        <FilterBar
          filters={[
            { type: "daterange", key: "date", label: "Allocation Date" },
            {
              type: "combobox",
              key: "vehicle",
              label: "Vehicle",
              options: vehicleOptions.map((v) => ({ value: v.value, label: v.label })),
            },
          ]}
        />
        <DataTable
          columns={historyColumns}
          data={history}
          emptyMessage="No allocations yet."
        />
      </section>

      <Dialog open={!!open} onOpenChange={(o) => !o && setOpen(null)}>
        <DialogContent className="max-w-3xl">
          <DialogHeader>
            <DialogTitle>Allocate {open?.itemName || open?.head}</DialogTitle>
            <DialogDescription>
              {open
                ? `${open.voucherNo} · ${open.supplier || "no supplier"} · ${formatMoney(
                    open.remainingAmount
                  )} unallocated${
                    open.remainingQty != null ? ` · ${open.remainingQty} remaining` : ""
                  }`
                : ""}
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-3">
            <div className="w-48 space-y-1">
              <Label className="text-xs">Allocation Date *</Label>
              <Input
                className="h-9"
                value={dateText}
                onChange={(e) => setDateText(e.target.value)}
                placeholder="dd/mm/yyyy"
              />
              <p className="text-[11px] text-muted-foreground">
                The vehicle&apos;s P&amp;L books this cost on this date, not the purchase date.
              </p>
            </div>

            <div className="space-y-2">
              {rows.map((r, i) => (
                <div key={i} className="grid grid-cols-12 items-end gap-2">
                  <div className="col-span-4 space-y-1">
                    <Label className="text-xs">Vehicle</Label>
                    <VehicleCombobox
                      options={vehicleOptions}
                      value={r.vehicleId}
                      onChange={(v) => setRow(i, { vehicleId: v })}
                      placeholder="Vehicle..."
                    />
                  </div>
                  <div className="col-span-2 space-y-1">
                    <Label className="text-xs">Qty</Label>
                    <Input
                      type="number"
                      className="h-9 text-right"
                      value={r.qty ? String(r.qty) : ""}
                      onChange={(e) => {
                        const qty = Number(e.target.value) || 0;
                        const rate = open ? rateOf(open) : null;
                        // amount follows the purchase rate until it is typed over
                        setRow(i, {
                          qty,
                          ...(rate ? { amount: Math.round(qty * rate * 100) / 100 } : {}),
                        });
                      }}
                    />
                  </div>
                  <div className="col-span-2 space-y-1">
                    <Label className="text-xs">Amount *</Label>
                    <Input
                      type="number"
                      className="h-9 text-right"
                      value={r.amount ? String(r.amount) : ""}
                      onChange={(e) => setRow(i, { amount: Number(e.target.value) || 0 })}
                    />
                  </div>
                  <div className="col-span-3 space-y-1">
                    <Label className="text-xs">Remarks</Label>
                    <Input
                      className="h-9"
                      value={r.remarks}
                      onChange={(e) => setRow(i, { remarks: e.target.value })}
                    />
                  </div>
                  <div className="col-span-1">
                    <Button
                      size="icon"
                      variant="ghost"
                      onClick={() => setRows((rs) => (rs.length === 1 ? rs : rs.filter((_, x) => x !== i)))}
                      aria-label="Remove row"
                    >
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  </div>
                </div>
              ))}
              <Button size="sm" variant="outline" onClick={() => setRows((rs) => [...rs, emptyRow()])}>
                <Plus className="mr-1 h-4 w-4" /> Add vehicle
              </Button>
            </div>

            <div className="flex gap-4 text-xs">
              <span className={overAmount ? "font-semibold text-destructive" : ""}>
                Allocating {formatMoney(allocatedAmt)}
                {open ? ` of ${formatMoney(open.remainingAmount)}` : ""}
              </span>
              {open?.remainingQty != null && (
                <span className={overQty ? "font-semibold text-destructive" : ""}>
                  Qty {allocatedQty} of {open.remainingQty}
                </span>
              )}
            </div>
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={() => setOpen(null)}>
              Cancel
            </Button>
            <Button onClick={save} disabled={saving || overAmount || overQty}>
              {saving && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              Save Allocation
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
