"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import type { ColumnDef } from "@tanstack/react-table";
import { Plus, Printer } from "lucide-react";
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
import {
  finalizeDriverFnf,
  getFnfPreview,
  type FnfPreview,
} from "@/app/(app)/vehicle/driver-fnf/actions";

export interface FnfRow {
  id: string;
  settlementNo: string;
  date: string;
  driver: string;
  lastWorkingDate: string | null;
  grossSalary: number;
  shortageAdjust: number;
  advanceAdjust: number;
  negativeAdjust: number;
  otherRecoveries: number;
  otherPayments: number;
  finalPayable: number;
  paymentMode: string;
  remarks: string;
}

function textToIso(text: string): string {
  const d = parseDdMmYyyy(text);
  if (!d) return "";
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${d.getFullYear()}-${mm}-${dd}`;
}

const r2 = (n: number) => Math.round(n * 100) / 100;

const emptyForm = {
  driverId: null as string | null,
  dateText: formatDate(new Date()),
  lastWorkingDateText: formatDate(new Date()),
  shortageAdjust: 0,
  advanceAdjust: 0,
  negativeAdjust: 0,
  otherRecoveries: 0,
  otherPayments: 0,
  paymentMode: "CASH" as "CASH" | "BANK" | "CARD",
  bankPartyId: null as string | null,
  refNo: "",
  remarks: "",
};

export function DriverFnfClient({
  rows,
  driverOptions,
  bankOptions,
  hideTitle = false,
}: {
  rows: FnfRow[];
  driverOptions: MasterOption[];
  bankOptions: MasterOption[];
  /** set when rendered inside the grouped Driver Management page */
  hideTitle?: boolean;
}) {
  const router = useRouter();
  const { toast } = useToast();
  const [busy, setBusy] = React.useState(false);
  const [open, setOpen] = React.useState(false);
  const [form, setForm] = React.useState(emptyForm);
  const set = (p: Partial<typeof emptyForm>) => setForm((f) => ({ ...f, ...p }));
  const [preview, setPreview] = React.useState<FnfPreview | null>(null);

  // fetch live figures when the driver changes; default full adjustments
  React.useEffect(() => {
    if (!open || !form.driverId) {
      setPreview(null);
      return;
    }
    getFnfPreview(form.driverId)
      .then((p) => {
        setPreview(p);
        if (p) {
          set({
            shortageAdjust: p.shortagePending,
            advanceAdjust: p.advancePending,
            negativeAdjust: p.plusMinusBalance < 0 ? Math.abs(p.plusMinusBalance) : 0,
          });
        }
      })
      .catch(() => setPreview(null));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, form.driverId]);

  const negativeAvailable = preview && preview.plusMinusBalance < 0 ? Math.abs(preview.plusMinusBalance) : 0;
  const finalPayable = preview
    ? r2(
        preview.runningSalary -
          form.shortageAdjust -
          form.advanceAdjust -
          form.negativeAdjust -
          form.otherRecoveries +
          form.otherPayments
      )
    : 0;

  const columns: ColumnDef<FnfRow>[] = React.useMemo(() => [
    { accessorKey: "settlementNo", header: "Settlement No" },
    { accessorKey: "date", header: "Date", cell: ({ row }) => formatDate(row.original.date) },
    { accessorKey: "driver", header: "Driver" },
    {
      accessorKey: "lastWorkingDate",
      header: "Last Working Date",
      cell: ({ row }) =>
        row.original.lastWorkingDate ? formatDate(row.original.lastWorkingDate) : "",
    },
    {
      accessorKey: "grossSalary",
      header: "Gross Salary",
      cell: ({ row }) => formatMoney(row.original.grossSalary),
      meta: { numeric: true } satisfies DataTableColumnMeta<FnfRow>,
    },
    {
      id: "deductions",
      header: "Adjustments",
      cell: ({ row }) =>
        formatMoney(
          row.original.shortageAdjust +
            row.original.advanceAdjust +
            row.original.negativeAdjust +
            row.original.otherRecoveries
        ),
      meta: { numeric: true } satisfies DataTableColumnMeta<FnfRow>,
    },
    {
      accessorKey: "finalPayable",
      header: "Final Amount",
      cell: ({ row }) => (
        <b className={row.original.finalPayable >= 0 ? "text-emerald-600" : "text-destructive"}>
          {formatMoney(row.original.finalPayable)}
        </b>
      ),
      meta: { numeric: true } satisfies DataTableColumnMeta<FnfRow>,
    },
    { accessorKey: "paymentMode", header: "Mode" },
    {
      id: "status",
      header: "Status",
      cell: () => <Badge>FINAL — LOCKED</Badge>,
    },
    {
      id: "actions",
      header: "",
      cell: ({ row }) => (
        <Button
          variant="ghost"
          size="sm"
          className="h-6 px-2 text-xs"
          onClick={(e) => {
            e.stopPropagation();
            window.open(`/print/driver-fnf/${row.original.id}`, "_blank");
          }}
        >
          <Printer className="h-3.5 w-3.5" /> Print / PDF
        </Button>
      ),
    },
  ], []);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        {hideTitle ? (
          <div />
        ) : (
          <h1 className="text-xl font-semibold">Driver Final Settlement (F&amp;F)</h1>
        )}
        <div className="flex flex-wrap gap-2">
          <ExportButton
            rows={rows}
            fileName="driver-final-settlements"
            sheetName="Driver F&F"
            columns={[
              { header: "Settlement No", key: "settlementNo" },
              { header: "Date", accessor: (r) => formatDate(r.date) },
              { header: "Driver", key: "driver" },
              { header: "Last Working Date", accessor: (r) => (r.lastWorkingDate ? formatDate(r.lastWorkingDate) : "") },
              { header: "Gross Salary", key: "grossSalary", numeric: true },
              { header: "Shortage Adjusted", key: "shortageAdjust", numeric: true },
              { header: "Advance Adjusted", key: "advanceAdjust", numeric: true },
              { header: "Negative Balance Adjusted", key: "negativeAdjust", numeric: true },
              { header: "Other Recoveries", key: "otherRecoveries", numeric: true },
              { header: "Other Payments", key: "otherPayments", numeric: true },
              { header: "Final Amount", key: "finalPayable", numeric: true },
              { header: "Payment Mode", key: "paymentMode" },
              { header: "Remarks", key: "remarks" },
            ]}
          />
          <Button size="sm" onClick={() => { setForm(emptyForm); setOpen(true); }}>
            <Plus className="h-4 w-4" /> New Settlement
          </Button>
        </div>
      </div>
      <p className="text-sm text-muted-foreground">
        One locked settlement per driver: settles running salary, shortages, pending advances and
        the negative +/- balance in a single document. Partial adjustments leave the remainder
        outstanding; the driver is marked Inactive on finalize.
      </p>
      <DataTable columns={columns} data={rows} emptyMessage="No final settlements yet." />

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-h-[95vh] overflow-y-auto sm:max-w-3xl">
          <DialogHeader>
            <DialogTitle>New Driver Final Settlement — number auto-generates</DialogTitle>
            <DialogDescription>
              Figures fetch automatically. Adjust fully or partially — nothing is forced.
            </DialogDescription>
          </DialogHeader>

          <div className="grid gap-3 sm:grid-cols-3">
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
              <Label className="text-xs">Settlement Date *</Label>
              <DateInput className="h-8" value={form.dateText} onChange={(t) => set({ dateText: t })} />
            </div>
            <div className="space-y-1">
              <Label className="text-xs">Last Working Date</Label>
              <DateInput
                className="h-8"
                value={form.lastWorkingDateText}
                onChange={(t) => set({ lastWorkingDateText: t })}
              />
            </div>
          </div>

          {preview?.alreadySettled && (
            <div className="rounded-md border border-destructive p-2 text-sm text-destructive">
              This driver already has final settlement {preview.alreadySettled} — a second
              settlement is not allowed.
            </div>
          )}

          {preview && !preview.alreadySettled && (
            <>
              <div className="grid grid-cols-2 gap-2 text-sm sm:grid-cols-4">
                {(
                  [
                    ["Running Salary", preview.runningSalary],
                    ["Shortage Pending", preview.shortagePending],
                    ["Advance Pending", preview.advancePending],
                    ["+/- Balance", preview.plusMinusBalance],
                  ] as [string, number][]
                ).map(([l, v]) => (
                  <div key={l} className="rounded-md border p-2">
                    <div className="text-[11px] text-muted-foreground">{l}</div>
                    <div className={`font-semibold tabular-nums ${l === "+/- Balance" && v < 0 ? "text-destructive" : ""}`}>
                      {formatMoney(v)}
                    </div>
                  </div>
                ))}
              </div>

              <div className="grid gap-3 sm:grid-cols-3">
                {(
                  [
                    ["shortageAdjust", `Adjust Shortage (max ${formatMoney(preview.shortagePending)})`, preview.shortagePending],
                    ["advanceAdjust", `Adjust Advances (max ${formatMoney(preview.advancePending)})`, preview.advancePending],
                    ["negativeAdjust", `Adjust Negative Balance (max ${formatMoney(negativeAvailable)})`, negativeAvailable],
                    ["otherRecoveries", "Other Recoveries / Deductions", Infinity],
                    ["otherPayments", "Incentives / Bonuses (+)", Infinity],
                  ] as [keyof typeof emptyForm, string, number][]
                ).map(([key, label, max]) => (
                  <div key={key} className="space-y-1">
                    <Label className="text-xs">{label}</Label>
                    <Input
                      type="number"
                      className="h-8 text-right"
                      value={form[key] ? String(form[key]) : ""}
                      placeholder="0"
                      onChange={(e) =>
                        set({
                          [key]: Math.max(0, Math.min(Number(e.target.value) || 0, max === Infinity ? 1e12 : max)),
                        } as Partial<typeof emptyForm>)
                      }
                    />
                  </div>
                ))}
                <div className="space-y-1">
                  <Label className="text-xs">Payment Mode</Label>
                  <Select
                    value={form.paymentMode}
                    onValueChange={(v) => set({ paymentMode: v as "CASH" | "BANK" | "CARD", bankPartyId: null })}
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
                      b.meta === form.paymentMode
                    )}
                    value={form.bankPartyId}
                    onChange={(v) => set({ bankPartyId: v })}
                    placeholder="Select account..."
                  />
                </div>
                <div className="space-y-1">
                  <Label className="text-xs">Reference No</Label>
                  <Input className="h-8" value={form.refNo} onChange={(e) => set({ refNo: e.target.value })} />
                </div>
                <div className="space-y-1 sm:col-span-3">
                  <Label className="text-xs">Remarks</Label>
                  <Input className="h-8" value={form.remarks} onChange={(e) => set({ remarks: e.target.value })} />
                </div>
              </div>

              {/* settlement summary */}
              <div className="rounded-md border p-2 text-sm">
                <div className="mb-1 font-semibold">Settlement Summary</div>
                {(
                  [
                    ["Gross Salary", preview.runningSalary],
                    ["Less: Shortage Deduction", -form.shortageAdjust],
                    ["Less: Driver Advance Adjustment", -form.advanceAdjust],
                    ["Less: Negative Balance Adjustment", -form.negativeAdjust],
                    ["Less: Other Recoveries", -form.otherRecoveries],
                    ["Add: Other Payments / Incentives", form.otherPayments],
                  ] as [string, number][]
                ).map(([l, v]) => (
                  <div key={l} className="flex justify-between text-xs">
                    <span>{l}</span>
                    <span className="tabular-nums">{formatMoney(v)}</span>
                  </div>
                ))}
                <div
                  className={`mt-1 flex justify-between border-t pt-1 font-bold ${finalPayable >= 0 ? "text-emerald-600" : "text-destructive"}`}
                >
                  <span>
                    Final {finalPayable >= 0 ? "Payable to Driver" : "Receivable from Driver"}
                  </span>
                  <span className="tabular-nums">{formatMoney(Math.abs(finalPayable))}</span>
                </div>
              </div>
            </>
          )}

          <DialogFooter>
            <Button variant="outline" onClick={() => setOpen(false)} disabled={busy}>Cancel</Button>
            <Button
              disabled={busy || !form.driverId || !form.bankPartyId || !preview || !!preview.alreadySettled}
              onClick={async () => {
                if (
                  !confirm(
                    `Finalize settlement? The driver will be marked Inactive and the document locked.`
                  )
                )
                  return;
                setBusy(true);
                try {
                  const res = await finalizeDriverFnf({
                    driverId: form.driverId ?? "",
                    date: textToIso(form.dateText),
                    lastWorkingDate: form.lastWorkingDateText
                      ? textToIso(form.lastWorkingDateText)
                      : null,
                    shortageAdjust: form.shortageAdjust,
                    advanceAdjust: form.advanceAdjust,
                    negativeAdjust: form.negativeAdjust,
                    otherRecoveries: form.otherRecoveries,
                    otherPayments: form.otherPayments,
                    paymentMode: form.paymentMode,
                    bankPartyId: form.bankPartyId ?? "",
                    refNo: form.refNo,
                    remarks: form.remarks,
                  });
                  if (res.ok) {
                    toast({
                      title: `Settlement ${res.settlementNo} finalized`,
                      description: `Final ${res.finalPayable >= 0 ? "paid" : "received"}: ${formatMoney(Math.abs(res.finalPayable))}. Driver marked Inactive.`,
                    });
                    setOpen(false);
                    router.refresh();
                  } else toast({ variant: "destructive", title: "Failed", description: res.error });
                } finally {
                  setBusy(false);
                }
              }}
            >
              {busy ? "Finalizing..." : "Finalize Settlement"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
