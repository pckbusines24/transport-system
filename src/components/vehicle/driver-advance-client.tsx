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
  deleteDriverAdvance,
  saveDriverAdvance,
} from "@/app/(app)/vehicle/driver-advances/actions";

export interface DriverAdvanceRow {
  id: string;
  date: string;
  driverId: string;
  driver: string;
  vehicleId: string | null;
  vehicle: string;
  tripRef: string;
  amount: number;
  paymentMode: string;
  bankPartyId: string | null;
  bank: string;
  voucherRef: string;
  remarks: string;
  status: string;
  adjustedDate: string | null;
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
  driverId: null as string | null,
  vehicleId: null as string | null,
  tripRef: "",
  amount: 0,
  paymentMode: "CASH" as "CASH" | "BANK" | "CARD",
  bankPartyId: null as string | null,
  voucherRef: "",
  remarks: "",
};

export function DriverAdvanceClient({
  rows,
  driverOptions,
  allDriverOptions,
  vehicleOptions,
  bankOptions,
  canDelete,
  hideTitle = false,
}: {
  rows: DriverAdvanceRow[];
  driverOptions: MasterOption[];
  allDriverOptions: MasterOption[];
  vehicleOptions: MasterOption[];
  bankOptions: MasterOption[];
  canDelete: boolean;
  /** set when rendered inside the grouped Driver Management page */
  hideTitle?: boolean;
}) {
  const router = useRouter();
  const { toast } = useToast();
  const [busy, setBusy] = React.useState(false);
  const [open, setOpen] = React.useState(false);
  const [form, setForm] = React.useState(emptyForm);
  const set = (p: Partial<typeof emptyForm>) => setForm((f) => ({ ...f, ...p }));

  const submit = async () => {
    setBusy(true);
    try {
      const res = await saveDriverAdvance({
        id: form.id,
        date: textToIso(form.dateText),
        driverId: form.driverId ?? "",
        vehicleId: form.vehicleId,
        tripRef: form.tripRef,
        amount: form.amount,
        paymentMode: form.paymentMode,
        bankPartyId: form.bankPartyId,
        voucherRef: form.voucherRef,
        remarks: form.remarks,
      });
      if (res.ok) {
        toast({ title: "Driver advance saved", description: "Ledger updated (driver ↔ cash/bank)." });
        setOpen(false);
        router.refresh();
      } else toast({ variant: "destructive", title: "Save failed", description: res.error });
    } finally {
      setBusy(false);
    }
  };

  const remove = React.useCallback(async (row: DriverAdvanceRow) => {
    if (!confirm(`Delete this advance of ${formatMoney(row.amount)} to ${row.driver}?`)) return;
    const res = await deleteDriverAdvance(row.id);
    if (res.ok) {
      toast({ title: "Advance deleted; ledger reversed" });
      router.refresh();
    } else toast({ variant: "destructive", title: "Delete failed", description: res.error });
  }, [router, toast]);

  const columns: ColumnDef<DriverAdvanceRow>[] = React.useMemo(() => [
    { accessorKey: "date", header: "Date", cell: ({ row }) => formatDate(row.original.date) },
    { accessorKey: "driver", header: "Driver" },
    { accessorKey: "vehicle", header: "Vehicle" },
    { accessorKey: "tripRef", header: "Trip Ref" },
    {
      accessorKey: "amount",
      header: "Advance Amt",
      cell: ({ row }) => formatMoney(row.original.amount),
      meta: {
        numeric: true,
        total: (rs) => formatMoney(rs.reduce((s, r) => s + r.amount, 0)),
      } satisfies DataTableColumnMeta<DriverAdvanceRow>,
    },
    {
      accessorKey: "paymentMode",
      header: "Mode",
      cell: ({ row }) => <Badge variant="secondary">{row.original.paymentMode}</Badge>,
    },
    { accessorKey: "bank", header: "Cash / Bank A/c" },
    { accessorKey: "voucherRef", header: "Voucher Ref" },
    {
      accessorKey: "status",
      header: "Status",
      cell: ({ row }) =>
        row.original.status === "PENDING" ? (
          <Badge variant="outline">PENDING</Badge>
        ) : (
          <Badge>ADJUSTED</Badge>
        ),
    },
    {
      accessorKey: "adjustedDate",
      header: "Adjusted Date",
      cell: ({ row }) =>
        row.original.adjustedDate ? formatDate(row.original.adjustedDate) : "",
    },
    { accessorKey: "remarks", header: "Remarks" },
    {
      id: "actions",
      header: "",
      cell: ({ row }) =>
        row.original.status === "PENDING" ? (
          <div className="flex gap-1" onClick={(e) => e.stopPropagation()}>
            <Button
              variant="ghost"
              size="sm"
              className="h-6 px-2 text-xs"
              onClick={() => {
                setForm({
                  id: row.original.id,
                  dateText: formatDate(row.original.date),
                  driverId: row.original.driverId,
                  vehicleId: row.original.vehicleId,
                  tripRef: row.original.tripRef,
                  amount: row.original.amount,
                  paymentMode: row.original.paymentMode as "CASH" | "BANK" | "CARD",
                  bankPartyId: row.original.bankPartyId,
                  voucherRef: row.original.voucherRef,
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
                onClick={() => void remove(row.original)}
              >
                Delete
              </Button>
            )}
          </div>
        ) : null,
    },
  ], [canDelete, remove]);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        {/* the grouped Driver Management page owns the heading; the empty div
            keeps the action bar right-aligned */}
        {hideTitle ? <div /> : <h1 className="text-xl font-semibold">Driver Advance Register</h1>}
        <div className="flex flex-wrap gap-2">
          <ExportButton
            rows={rows}
            fileName="driver-advance-register"
            sheetName="Driver Advances"
            columns={[
              { header: "Date", accessor: (r) => formatDate(r.date) },
              { header: "Driver", key: "driver" },
              { header: "Vehicle", key: "vehicle" },
              { header: "Trip Ref", key: "tripRef" },
              { header: "Advance Amount", key: "amount", numeric: true },
              { header: "Payment Mode", key: "paymentMode" },
              { header: "Cash / Bank A/c", key: "bank" },
              { header: "Voucher Ref", key: "voucherRef" },
              { header: "Status", key: "status" },
              { header: "Remarks", key: "remarks" },
            ]}
          />
          <Button size="sm" onClick={() => { setForm(emptyForm); setOpen(true); }}>
            <Plus className="h-4 w-4" /> New Advance
          </Button>
        </div>
      </div>
      <p className="text-sm text-muted-foreground">
        Primary source of driver advance data — trip sheets fetch (never create) advances from
        this register by vehicle, driver and date range. Adjusted advances are locked.
      </p>
      <FilterBar
        filters={[
          { type: "combobox", key: "driver", label: "Driver", options: allDriverOptions },
          { type: "combobox", key: "vehicle", label: "Vehicle", options: vehicleOptions },
          {
            type: "select",
            key: "status",
            label: "Status",
            options: [
              { value: "PENDING", label: "Pending" },
              { value: "ADJUSTED", label: "Adjusted" },
            ],
          },
          { type: "daterange", key: "date", label: "Date" },
        ]}
      />
      <DataTable columns={columns} data={rows} emptyMessage="No driver advances yet." />

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-h-[95vh] overflow-y-auto sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>{form.id ? "Edit" : "New"} Driver Advance</DialogTitle>
            <DialogDescription>
              Posts to the driver&apos;s ledger (debit) and the selected cash/bank account (credit).
            </DialogDescription>
          </DialogHeader>
          <div className="grid gap-3 sm:grid-cols-3">
            <div className="space-y-1">
              <Label className="text-xs">Date *</Label>
              <DateInput className="h-8" value={form.dateText} onChange={(t) => set({ dateText: t })} />
            </div>
            <div className="space-y-1">
              <Label className="text-xs">Driver *</Label>
              <MasterCombobox
                options={driverOptions}
                value={form.driverId}
                onChange={(v) => set({ driverId: v })}
                placeholder="Select driver..."
              />
            </div>
            <div className="space-y-1">
              <Label className="text-xs">Vehicle No</Label>
              <MasterCombobox
                options={vehicleOptions}
                value={form.vehicleId}
                onChange={(v) => set({ vehicleId: v })}
                placeholder="Select vehicle..."
              />
            </div>
            <div className="space-y-1">
              <Label className="text-xs">Trip Reference No (optional)</Label>
              <Input className="h-8" value={form.tripRef} onChange={(e) => set({ tripRef: e.target.value })} />
            </div>
            <div className="space-y-1">
              <Label className="text-xs">Advance Amount *</Label>
              <Input
                type="number"
                className="h-8 text-right"
                value={form.amount ? String(form.amount) : ""}
                onChange={(e) => set({ amount: Number(e.target.value) || 0 })}
              />
            </div>
            <div className="space-y-1">
              <Label className="text-xs">Payment Mode</Label>
              <Select value={form.paymentMode} onValueChange={(v) => set({ paymentMode: v as "CASH" | "BANK" | "CARD" })}>
                <SelectTrigger className="h-8"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="CASH">Cash</SelectItem>
                  <SelectItem value="BANK">Bank</SelectItem>
                  <SelectItem value="CARD">Card</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1">
              <Label className="text-xs">Cash / Bank Account</Label>
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
              <Label className="text-xs">Payment Voucher Reference</Label>
              <Input className="h-8" value={form.voucherRef} onChange={(e) => set({ voucherRef: e.target.value })} />
            </div>
            <div className="space-y-1">
              <Label className="text-xs">Remarks</Label>
              <Input className="h-8" value={form.remarks} onChange={(e) => set({ remarks: e.target.value })} />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setOpen(false)} disabled={busy}>Cancel</Button>
            <Button disabled={busy || !form.driverId || form.amount <= 0} onClick={submit}>
              {busy ? "Saving..." : "Save Advance"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
