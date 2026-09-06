"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import type { ColumnDef } from "@tanstack/react-table";
import { ArrowDownCircle, ArrowUpCircle, Plus } from "lucide-react";
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
  deleteDriverSettlement,
  saveDriverSettlement,
  settleDriverRunningBalance,
  updateDriverSettlement,
} from "@/app/(app)/vehicle/driver-settlements/actions";

export interface DriverSettlementRow {
  id: string;
  date: string;
  driverId: string;
  driver: string;
  vehicle: string;
  tripRef: string;
  previousBalance: number;
  amount: number;
  runningBalance: number;
  status: string;
  isManual: boolean;
  settledDate: string | null;
  voucherNo: string;
  remarks: string;
}

function textToIso(text: string): string {
  const d = parseDdMmYyyy(text);
  if (!d) return "";
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${d.getFullYear()}-${mm}-${dd}`;
}

const signed = (n: number) =>
  n === 0 ? "0" : `${n > 0 ? "+" : "−"}${formatMoney(Math.abs(n))}`;

export function DriverSettlementClient({
  rows,
  driverOptions,
  vehicleOptions,
  bankOptions,
  canDelete,
  hideTitle = false,
}: {
  rows: DriverSettlementRow[];
  driverOptions: MasterOption[];
  vehicleOptions: MasterOption[];
  bankOptions: MasterOption[];
  canDelete: boolean;
  /** set when rendered inside the grouped Driver Management page */
  hideTitle?: boolean;
}) {
  const router = useRouter();
  const { toast } = useToast();
  const [busy, setBusy] = React.useState(false);

  const [newOpen, setNewOpen] = React.useState(false);
  const [form, setForm] = React.useState({
    id: null as string | null,
    dateText: formatDate(new Date()),
    driverId: null as string | null,
    vehicleId: null as string | null,
    tripRef: "",
    amount: 0,
    remarks: "",
  });

  // PENDING = latest open row per driver; ADJUSTED = earlier open rows already
  // carried into that running balance. Both are still editable/deletable.
  const isOpen = (s: string) => s === "PENDING" || s === "ADJUSTED";

  // Pay/Receive appears ONLY on each driver's latest pending entry, and it
  // settles the driver's ENTIRE running balance (rows arrive newest-first).
  const latestPendingByDriver = React.useMemo(() => {
    const m = new Map<string, string>(); // driverId -> row id
    for (const r of rows) {
      if (r.status === "PENDING" && !m.has(r.driverId)) m.set(r.driverId, r.id);
    }
    return m;
  }, [rows]);

  const [settleOf, setSettleOf] = React.useState<DriverSettlementRow | null>(null);
  const [settle, setSettle] = React.useState({
    dateText: formatDate(new Date()),
    paymentMode: "CASH" as "CASH" | "BANK" | "CARD",
    bankPartyId: null as string | null,
    remarks: "",
  });

  const columns: ColumnDef<DriverSettlementRow>[] = [
    { accessorKey: "date", header: "Date", cell: ({ row }) => formatDate(row.original.date) },
    { accessorKey: "tripRef", header: "Trip Ref" },
    { accessorKey: "vehicle", header: "Vehicle" },
    { accessorKey: "driver", header: "Driver" },
    {
      accessorKey: "previousBalance",
      header: "Prev Balance",
      cell: ({ row }) => signed(row.original.previousBalance),
      meta: { numeric: true } satisfies DataTableColumnMeta<DriverSettlementRow>,
    },
    {
      accessorKey: "amount",
      header: "Trip Balance (+/-)",
      cell: ({ row }) => (
        <span className={row.original.amount >= 0 ? "text-emerald-600" : "text-destructive"}>
          {signed(row.original.amount)}
        </span>
      ),
      meta: { numeric: true } satisfies DataTableColumnMeta<DriverSettlementRow>,
    },
    {
      accessorKey: "runningBalance",
      header: "Running Balance",
      cell: ({ row }) => signed(row.original.runningBalance),
      meta: { numeric: true } satisfies DataTableColumnMeta<DriverSettlementRow>,
    },
    {
      accessorKey: "status",
      header: "Status",
      cell: ({ row }) =>
        row.original.status === "PENDING" ? (
          <Badge variant="outline">PENDING</Badge>
        ) : row.original.status === "ADJUSTED" ? (
          <Badge variant="secondary">ADJUSTED</Badge>
        ) : (
          <Badge>SETTLED</Badge>
        ),
    },
    { accessorKey: "voucherNo", header: "Voucher No" },
    { accessorKey: "remarks", header: "Remarks" },
    {
      id: "actions",
      header: "",
      cell: ({ row }) => (
        <div className="flex gap-0.5" onClick={(e) => e.stopPropagation()}>
          {row.original.status === "PENDING" &&
            latestPendingByDriver.get(row.original.driverId) === row.original.id &&
            row.original.runningBalance !== 0 && (
              <Button
                variant="ghost"
                size="sm"
                className={`h-6 px-2 text-xs ${row.original.runningBalance > 0 ? "" : "text-destructive"}`}
                title="Settles the driver's full running balance — older entries are locked"
                onClick={() => {
                  setSettle({
                    dateText: formatDate(new Date()),
                    paymentMode: "CASH",
                    bankPartyId: null,
                    remarks: "",
                  });
                  setSettleOf(row.original);
                }}
              >
                {row.original.runningBalance > 0 ? (
                  <>
                    <ArrowUpCircle className="h-3.5 w-3.5" /> Pay Driver
                  </>
                ) : (
                  <>
                    <ArrowDownCircle className="h-3.5 w-3.5" /> Receive
                  </>
                )}
              </Button>
            )}
          {isOpen(row.original.status) && row.original.isManual && (
            <Button
              variant="ghost"
              size="sm"
              className="h-6 px-2 text-xs"
              title="Edit manual entry (trip-generated rows are edited via their trip sheet)"
              onClick={() => {
                setForm({
                  id: row.original.id,
                  dateText: formatDate(row.original.date),
                  driverId: row.original.driverId,
                  vehicleId: null,
                  tripRef: row.original.tripRef,
                  amount: row.original.amount,
                  remarks: row.original.remarks,
                });
                setNewOpen(true);
              }}
            >
              Edit
            </Button>
          )}
          {canDelete && isOpen(row.original.status) && (
            <Button
              variant="ghost"
              size="sm"
              className="h-6 px-2 text-xs text-destructive"
              onClick={async () => {
                if (!confirm("Delete this settlement row?")) return;
                const res = await deleteDriverSettlement(row.original.id);
                if (res.ok) {
                  toast({ title: "Deleted" });
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
  ];

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        {hideTitle ? (
          <div />
        ) : (
          <h1 className="text-xl font-semibold">Driver +/- Settlement Register</h1>
        )}
        <div className="flex flex-wrap gap-2">
          <ExportButton
            rows={rows}
            fileName="driver-settlement-register"
            sheetName="Driver Settlements"
            columns={[
              { header: "Date", accessor: (r) => formatDate(r.date) },
              { header: "Trip Ref", key: "tripRef" },
              { header: "Vehicle", key: "vehicle" },
              { header: "Driver", key: "driver" },
              { header: "Previous Balance", key: "previousBalance", numeric: true },
              { header: "Trip Balance", key: "amount", numeric: true },
              { header: "Running Balance", key: "runningBalance", numeric: true },
              { header: "Status", key: "status" },
              { header: "Voucher No", key: "voucherNo" },
              { header: "Remarks", key: "remarks" },
            ]}
          />
          <Button
            size="sm"
            onClick={() => {
              setForm({
                id: null,
                dateText: formatDate(new Date()),
                driverId: null,
                vehicleId: null,
                tripRef: "",
                amount: 0,
                remarks: "",
              });
              setNewOpen(true);
            }}
          >
            <Plus className="h-4 w-4" /> Manual Entry
          </Button>
        </div>
      </div>
      <p className="text-sm text-muted-foreground">
        Trip sheets post their driver balance here automatically. Positive (+) = company pays the
        driver (Pay Driver → auto Payment Voucher); negative (−) = driver pays the company
        (Receive → auto Receipt Voucher). Settled amounts never carry to the next trip.
      </p>
      <FilterBar
        filters={[
          { type: "combobox", key: "driver", label: "Driver", options: driverOptions },
          {
            type: "select",
            key: "status",
            label: "Status",
            options: [
              { value: "PENDING", label: "Pending" },
              { value: "ADJUSTED", label: "Adjusted" },
              { value: "SETTLED", label: "Settled" },
            ],
          },
          { type: "daterange", key: "date", label: "Date" },
        ]}
      />
      <DataTable columns={columns} data={rows} emptyMessage="No settlement entries yet." />

      {/* manual entry */}
      <Dialog open={newOpen} onOpenChange={setNewOpen}>
        <DialogContent className="sm:max-w-xl">
          <DialogHeader>
            <DialogTitle>Manual Driver +/- Entry</DialogTitle>
            <DialogDescription>
              Positive amount = payable to driver; negative = receivable from driver.
            </DialogDescription>
          </DialogHeader>
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1">
              <Label className="text-xs">Date *</Label>
              <DateInput
                className="h-8"
                value={form.dateText}
                onChange={(t) => setForm((f) => ({ ...f, dateText: t }))}
              />
            </div>
            <div className="space-y-1">
              <Label className="text-xs">Driver *</Label>
              <MasterCombobox
                options={driverOptions}
                value={form.driverId}
                onChange={(v) => setForm((f) => ({ ...f, driverId: v }))}
                placeholder="Select driver..."
              />
            </div>
            <div className="space-y-1">
              <Label className="text-xs">Vehicle No</Label>
              <MasterCombobox
                options={vehicleOptions}
                value={form.vehicleId}
                onChange={(v) => setForm((f) => ({ ...f, vehicleId: v }))}
                placeholder="Select vehicle..."
              />
            </div>
            <div className="space-y-1">
              <Label className="text-xs">Trip Reference No</Label>
              <Input
                className="h-8"
                value={form.tripRef}
                onChange={(e) => setForm((f) => ({ ...f, tripRef: e.target.value }))}
              />
            </div>
            <div className="space-y-1">
              <Label className="text-xs">Amount (+/-) *</Label>
              <Input
                type="number"
                className="h-8 text-right"
                value={form.amount ? String(form.amount) : ""}
                onChange={(e) => setForm((f) => ({ ...f, amount: Number(e.target.value) || 0 }))}
              />
            </div>
            <div className="space-y-1">
              <Label className="text-xs">Remarks</Label>
              <Input
                className="h-8"
                value={form.remarks}
                onChange={(e) => setForm((f) => ({ ...f, remarks: e.target.value }))}
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setNewOpen(false)} disabled={busy}>Cancel</Button>
            <Button
              disabled={busy || !form.driverId || form.amount === 0}
              onClick={async () => {
                setBusy(true);
                try {
                  const res = form.id
                    ? await updateDriverSettlement({
                        id: form.id,
                        date: textToIso(form.dateText),
                        amount: form.amount,
                        tripRef: form.tripRef,
                        remarks: form.remarks,
                      })
                    : await saveDriverSettlement({
                        date: textToIso(form.dateText),
                        driverId: form.driverId ?? "",
                        vehicleId: form.vehicleId,
                        tripRef: form.tripRef,
                        amount: form.amount,
                        remarks: form.remarks,
                      });
                  if (res.ok) {
                    toast({ title: form.id ? "Settlement entry updated" : "Settlement entry saved" });
                    setNewOpen(false);
                    router.refresh();
                  } else toast({ variant: "destructive", title: "Save failed", description: res.error });
                } finally {
                  setBusy(false);
                }
              }}
            >
              {busy ? "Saving..." : "Save Entry"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* settle (pay / receive) */}
      <Dialog open={!!settleOf} onOpenChange={(o) => !o && setSettleOf(null)}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>
              {settleOf && settleOf.runningBalance > 0
                ? `Pay ${formatMoney(Math.abs(settleOf.runningBalance))} to ${settleOf.driver}`
                : `Receive ${formatMoney(Math.abs(settleOf?.runningBalance ?? 0))} from ${settleOf?.driver}`}
            </DialogTitle>
            <DialogDescription>
              Settles the driver&apos;s ENTIRE outstanding running balance (all pending entries) in
              one {settleOf && settleOf.runningBalance > 0 ? "Payment" : "Receipt"} Voucher — the
              driver ledger and cash/bank book update instantly.
            </DialogDescription>
          </DialogHeader>
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1">
              <Label className="text-xs">Date *</Label>
              <DateInput
                className="h-8"
                value={settle.dateText}
                onChange={(t) => setSettle((f) => ({ ...f, dateText: t }))}
              />
            </div>
            <div className="space-y-1">
              <Label className="text-xs">Mode</Label>
              <Select
                value={settle.paymentMode}
                onValueChange={(v) =>
                  setSettle((f) => ({ ...f, paymentMode: v as "CASH" | "BANK" | "CARD", bankPartyId: null }))
                }
              >
                <SelectTrigger className="h-8"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="CASH">Cash</SelectItem>
                  <SelectItem value="BANK">Bank</SelectItem>
                  <SelectItem value="CARD">Card</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1">
              <Label className="text-xs">Cash / Bank Account *</Label>
              <MasterCombobox
                options={bankOptions.filter((b) =>
                  b.meta === settle.paymentMode
                )}
                value={settle.bankPartyId}
                onChange={(v) => setSettle((f) => ({ ...f, bankPartyId: v }))}
                placeholder="Select account..."
              />
            </div>
            <div className="space-y-1">
              <Label className="text-xs">Remarks</Label>
              <Input
                className="h-8"
                value={settle.remarks}
                onChange={(e) => setSettle((f) => ({ ...f, remarks: e.target.value }))}
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setSettleOf(null)} disabled={busy}>Cancel</Button>
            <Button
              disabled={busy || !settle.bankPartyId || !settleOf}
              onClick={async () => {
                setBusy(true);
                try {
                  const res = await settleDriverRunningBalance({
                    driverId: settleOf!.driverId,
                    date: textToIso(settle.dateText),
                    paymentMode: settle.paymentMode,
                    bankPartyId: settle.bankPartyId ?? "",
                    remarks: settle.remarks,
                  });
                  if (res.ok) {
                    toast({
                      title: `Settled — voucher ${res.voucherNo} created`,
                      description: "Driver ledger and cash/bank book updated.",
                    });
                    setSettleOf(null);
                    router.refresh();
                  } else toast({ variant: "destructive", title: "Failed", description: res.error });
                } finally {
                  setBusy(false);
                }
              }}
            >
              {busy ? "Processing..." : settleOf && settleOf.amount > 0 ? "Pay & Create Voucher" : "Receive & Create Voucher"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
