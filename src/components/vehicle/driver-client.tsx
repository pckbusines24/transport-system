"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import type { ColumnDef } from "@tanstack/react-table";
import { ArrowLeftRight, Eye, LogOut, Plus, Trash2 } from "lucide-react";
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
import { useToast } from "@/components/ui/use-toast";
import { DataTable, type DataTableColumnMeta } from "@/components/data/data-table";
import { DateInput } from "@/components/data/date-input";
import { ExportButton } from "@/components/data/export-button";
import { FileUploadField } from "@/components/data/file-upload-field";
import { FilterBar } from "@/components/data/filter-bar";
import { MasterCombobox, type MasterOption } from "@/components/data/master-combobox";
import { PartyCombobox } from "@/components/fleet/fields";
import {
  deleteDriver,
  exitDriver,
  reactivateDriver,
  saveDriver,
  transferDriver,
} from "@/app/(app)/vehicle/drivers/actions";

interface DocSlot {
  path: string | null;
  name: string | null;
}

export interface DriverRow {
  id: string;
  driverCode: string;
  name: string;
  /** derived from the assigned vehicle's ownership: COMPANY | RELATIVE | BROKER | "" */
  driverType: string;
  /** lifetime totals for the expense summary (drill down via the other tabs) */
  advancePaid: number;
  outstandingAdvance: number;
  settlementPaid: number;
  totalExpense: number;
  /** linked DRIVER-group ledger */
  partyId: string | null;
  partyName: string;
  mobile: string;
  emergencyContact: string;
  address: string;
  joinDate: string | null;
  exitDate: string | null;
  exitReason: string;
  status: string;
  remarks: string;
  currentVehicle: string;
  licence: DocSlot;
  aadhaar: DocSlot;
  pan: DocSlot;
  photo: DocSlot;
  medical: DocSlot;
  police: DocSlot;
  otherDocs: { title: string; path: string; name: string }[];
  assignments: {
    vehicle: string;
    fromDate: string;
    toDate: string | null;
    reason: string;
    remarks: string;
  }[];
}

function textToIso(text: string): string {
  const d = parseDdMmYyyy(text);
  if (!d) return "";
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${d.getFullYear()}-${mm}-${dd}`;
}

const emptySlot: DocSlot = { path: null, name: null };

const emptyForm = {
  id: null as string | null,
  name: "",
  partyId: null as string | null,
  mobile: "",
  emergencyContact: "",
  address: "",
  joinDateText: formatDate(new Date()),
  remarks: "",
  vehicleId: null as string | null,
  licence: emptySlot,
  aadhaar: emptySlot,
  pan: emptySlot,
  photo: emptySlot,
  medical: emptySlot,
  police: emptySlot,
  otherDocs: [] as { title: string; path: string; name: string }[],
};

const DOC_SLOTS: [keyof Pick<typeof emptyForm, "licence" | "aadhaar" | "pan" | "photo" | "medical" | "police">, string][] = [
  ["licence", "Driving Licence"],
  ["aadhaar", "Aadhaar Card"],
  ["pan", "PAN Card (optional)"],
  ["photo", "Passport Size Photo"],
  ["medical", "Medical Certificate (optional)"],
  ["police", "Police Verification (optional)"],
];

export function DriverClient({
  rows,
  vehicleOptions,
  driverLedgerOptions,
  canDelete = false,
}: {
  rows: DriverRow[];
  vehicleOptions: MasterOption[];
  /** every DRIVER-group ledger, so Driver Master and Ledger Master stay in step */
  driverLedgerOptions: MasterOption[];
  canDelete?: boolean;
}) {
  const router = useRouter();
  const { toast } = useToast();
  const [busy, setBusy] = React.useState(false);

  const [formOpen, setFormOpen] = React.useState(false);
  const [form, setForm] = React.useState(emptyForm);
  const set = (p: Partial<typeof emptyForm>) => setForm((f) => ({ ...f, ...p }));

  const [transferOf, setTransferOf] = React.useState<DriverRow | null>(null);
  const [transfer, setTransfer] = React.useState({
    changeDateText: formatDate(new Date()),
    newVehicleId: null as string | null,
    reason: "",
    remarks: "",
  });

  const [exitOf, setExitOf] = React.useState<DriverRow | null>(null);
  const [exit, setExit] = React.useState({
    exitDateText: formatDate(new Date()),
    exitReason: "",
    remarks: "",
  });

  const [viewOf, setViewOf] = React.useState<DriverRow | null>(null);

  const run = React.useCallback(async (fn: () => Promise<{ ok: boolean; error?: string }>, done: () => void) => {
    setBusy(true);
    try {
      const res = await fn();
      if (res.ok) {
        done();
        router.refresh();
      } else toast({ variant: "destructive", title: "Failed", description: res.error });
    } finally {
      setBusy(false);
    }
  }, [router, toast]);

  const openNew = () => {
    setForm(emptyForm);
    setFormOpen(true);
  };
  const openEdit = React.useCallback((r: DriverRow) => {
    setForm({
      id: r.id,
      name: r.name,
      partyId: r.partyId,
      mobile: r.mobile,
      emergencyContact: r.emergencyContact,
      address: r.address,
      joinDateText: r.joinDate ? formatDate(r.joinDate) : "",
      remarks: r.remarks,
      vehicleId: null,
      licence: r.licence,
      aadhaar: r.aadhaar,
      pan: r.pan,
      photo: r.photo,
      medical: r.medical,
      police: r.police,
      otherDocs: r.otherDocs,
    });
    setFormOpen(true);
  }, []);

  const docCount = React.useCallback((r: DriverRow) =>
    [r.licence, r.aadhaar, r.pan, r.photo, r.medical, r.police].filter((s) => s.path).length +
    r.otherDocs.length, []);

  const columns: ColumnDef<DriverRow>[] = React.useMemo(() => [
    { accessorKey: "driverCode", header: "Code" },
    { accessorKey: "name", header: "Driver Name" },
    {
      accessorKey: "partyName",
      header: "Ledger",
      cell: ({ row }) =>
        row.original.partyName || <span className="text-muted-foreground">—</span>,
    },
    { accessorKey: "mobile", header: "Mobile" },
    {
      accessorKey: "currentVehicle",
      header: "Current Vehicle",
      cell: ({ row }) =>
        row.original.currentVehicle || <span className="text-muted-foreground">—</span>,
    },
    {
      accessorKey: "driverType",
      header: "Type",
      cell: ({ row }) =>
        row.original.driverType ? (
          <Badge
            variant={
              row.original.driverType === "COMPANY"
                ? "default"
                : row.original.driverType === "RELATIVE"
                  ? "secondary"
                  : "outline"
            }
            title="Derived from the assigned vehicle's ownership"
          >
            {row.original.driverType}
          </Badge>
        ) : (
          <span className="text-muted-foreground">—</span>
        ),
    },
    {
      accessorKey: "advancePaid",
      header: "Advance Paid",
      cell: ({ row }) => (
        <a
          href={`/vehicle/driver-management?tab=advance&driver=${row.original.id}`}
          className="tabular-nums text-primary underline-offset-2 hover:underline"
          onClick={(e) => e.stopPropagation()}
          title="Open this driver's advances"
        >
          {formatMoney(row.original.advancePaid)}
        </a>
      ),
      meta: { numeric: true } satisfies DataTableColumnMeta<DriverRow>,
    },
    {
      accessorKey: "settlementPaid",
      header: "Settlement Paid",
      cell: ({ row }) => (
        <a
          href={`/vehicle/driver-management?tab=settlement&driver=${row.original.id}&status=SETTLED`}
          className="tabular-nums text-primary underline-offset-2 hover:underline"
          onClick={(e) => e.stopPropagation()}
          title="Open this driver's settled payments"
        >
          {formatMoney(row.original.settlementPaid)}
        </a>
      ),
      meta: { numeric: true } satisfies DataTableColumnMeta<DriverRow>,
    },
    {
      accessorKey: "totalExpense",
      header: "Total Driver Expense",
      cell: ({ row }) => (
        <span className="font-medium tabular-nums">{formatMoney(row.original.totalExpense)}</span>
      ),
      meta: { numeric: true } satisfies DataTableColumnMeta<DriverRow>,
    },
    {
      accessorKey: "outstandingAdvance",
      header: "Outstanding Adv",
      cell: ({ row }) =>
        row.original.outstandingAdvance > 0 ? (
          <a
            href={`/vehicle/driver-management?tab=advance&driver=${row.original.id}`}
            className="tabular-nums text-destructive underline-offset-2 hover:underline"
            onClick={(e) => e.stopPropagation()}
            title="Pending (unadjusted) advances"
          >
            {formatMoney(row.original.outstandingAdvance)}
          </a>
        ) : (
          <span className="text-muted-foreground">—</span>
        ),
      meta: { numeric: true } satisfies DataTableColumnMeta<DriverRow>,
    },
    {
      accessorKey: "joinDate",
      header: "Joined",
      cell: ({ row }) => (row.original.joinDate ? formatDate(row.original.joinDate) : ""),
    },
    {
      accessorKey: "exitDate",
      header: "Exited",
      cell: ({ row }) => (row.original.exitDate ? formatDate(row.original.exitDate) : ""),
    },
    {
      id: "docs",
      header: "Docs",
      cell: ({ row }) => <Badge variant="outline">{docCount(row.original)}</Badge>,
    },
    {
      accessorKey: "status",
      header: "Status",
      cell: ({ row }) =>
        row.original.status === "ACTIVE" ? (
          <Badge>ACTIVE</Badge>
        ) : (
          <Badge variant="destructive">INACTIVE</Badge>
        ),
    },
    {
      id: "actions",
      header: "",
      cell: ({ row }) => (
        <div className="flex gap-0.5" onClick={(e) => e.stopPropagation()}>
          <Button variant="ghost" size="sm" className="h-6 px-2 text-xs" onClick={() => setViewOf(row.original)}>
            <Eye className="h-3.5 w-3.5" /> View
          </Button>
          <Button variant="ghost" size="sm" className="h-6 px-2 text-xs" onClick={() => openEdit(row.original)}>
            Edit
          </Button>
          {row.original.status === "ACTIVE" ? (
            <>
              <Button
                variant="ghost"
                size="sm"
                className="h-6 px-2 text-xs"
                onClick={() => {
                  setTransfer({
                    changeDateText: formatDate(new Date()),
                    newVehicleId: null,
                    reason: "",
                    remarks: "",
                  });
                  setTransferOf(row.original);
                }}
              >
                <ArrowLeftRight className="h-3.5 w-3.5" /> Transfer
              </Button>
              <Button
                variant="ghost"
                size="sm"
                className="h-6 px-2 text-xs text-destructive"
                onClick={() => {
                  setExit({ exitDateText: formatDate(new Date()), exitReason: "", remarks: "" });
                  setExitOf(row.original);
                }}
              >
                <LogOut className="h-3.5 w-3.5" /> Exit
              </Button>
            </>
          ) : (
            <Button
              variant="ghost"
              size="sm"
              className="h-6 px-2 text-xs"
              onClick={() =>
                run(
                  () => reactivateDriver(row.original.id),
                  () => toast({ title: `${row.original.name} re-activated` })
                )
              }
            >
              Re-activate
            </Button>
          )}
          {canDelete && (
            <Button
              variant="ghost"
              size="sm"
              className="h-6 px-2 text-xs text-destructive"
              title="Delete driver (blocked if referenced by advances / salaries / trips)"
              onClick={async () => {
                if (!confirm(`Delete driver ${row.original.name} (${row.original.driverCode})?`))
                  return;
                const res = await deleteDriver(row.original.id);
                if (res.ok) {
                  toast({ title: `${row.original.name} deleted` });
                  router.refresh();
                } else toast({ variant: "destructive", title: "Cannot delete", description: res.error });
              }}
            >
              Delete
            </Button>
          )}
        </div>
      ),
    },
  ], [canDelete, docCount, openEdit, router, run, toast]);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h1 className="text-xl font-semibold">Driver Master</h1>
        <div className="flex flex-wrap gap-2">
          <ExportButton
            rows={rows}
            fileName="driver-master"
            sheetName="Drivers"
            columns={[
              { header: "Code", key: "driverCode" },
              { header: "Name", key: "name" },
              { header: "Mobile", key: "mobile" },
              { header: "Emergency Contact", key: "emergencyContact" },
              { header: "Address", key: "address" },
              { header: "Current Vehicle", key: "currentVehicle" },
              { header: "Joined", accessor: (r) => (r.joinDate ? formatDate(r.joinDate) : "") },
              { header: "Exited", accessor: (r) => (r.exitDate ? formatDate(r.exitDate) : "") },
              { header: "Exit Reason", key: "exitReason" },
              { header: "Status", key: "status" },
            ]}
          />
          <Button size="sm" onClick={openNew}>
            <Plus className="h-4 w-4" /> New Driver
          </Button>
        </div>
      </div>
      <p className="text-sm text-muted-foreground">
        Driver code auto-generates. Vehicle transfers keep the full assignment history; exits are
        recorded, never deleted. Each driver is linked to a DRIVER ledger for advances, settlement
        and salary accounting.
      </p>
      <FilterBar
        filters={[
          { type: "text", key: "q", label: "Name / Code / Mobile..." },
          { type: "combobox", key: "vehicle", label: "Vehicle", options: vehicleOptions },
          {
            type: "select",
            key: "status",
            label: "Status",
            options: [
              { value: "ACTIVE", label: "Active" },
              { value: "INACTIVE", label: "Inactive" },
            ],
          },
        ]}
      />
      <DataTable columns={columns} data={rows} emptyMessage="No drivers yet." onRowClick={(r) => setViewOf(r)} />

      {/* ------------- driver form ------------- */}
      <Dialog open={formOpen} onOpenChange={setFormOpen}>
        <DialogContent className="max-h-[95vh] overflow-y-auto sm:max-w-4xl">
          <DialogHeader>
            <DialogTitle>{form.id ? "Edit Driver" : "New Driver — code auto-generates"}</DialogTitle>
            <DialogDescription>
              Upload, preview, download or replace documents any time.
            </DialogDescription>
          </DialogHeader>
          <div className="grid gap-3 sm:grid-cols-3">
            <div className="space-y-1">
              <Label className="text-xs">Driver Name *</Label>
              <Input className="h-8" value={form.name} onChange={(e) => set({ name: e.target.value })} />
            </div>
            <div className="space-y-1">
              <Label className="text-xs">Mobile Number</Label>
              <Input className="h-8" value={form.mobile} onChange={(e) => set({ mobile: e.target.value })} />
            </div>
            <div className="space-y-1">
              <Label className="text-xs">Driver Ledger</Label>
              <PartyCombobox
                options={driverLedgerOptions}
                value={form.partyId}
                onChange={(v, opt) =>
                  // a blank driver name follows the ledger, so the two never
                  // drift apart on first entry
                  set({ partyId: v, name: form.name || opt?.label || "" })
                }
                ledgerGroup="DRIVER"
                placeholder="Auto-create from driver name..."
              />
              <p className="text-[11px] text-muted-foreground">
                Every Driver-group ledger appears here. Leave blank to create one automatically.
              </p>
            </div>
            <div className="space-y-1">
              <Label className="text-xs">Emergency Contact</Label>
              <Input
                className="h-8"
                value={form.emergencyContact}
                onChange={(e) => set({ emergencyContact: e.target.value })}
              />
            </div>
            <div className="space-y-1 sm:col-span-2">
              <Label className="text-xs">Address</Label>
              <Input className="h-8" value={form.address} onChange={(e) => set({ address: e.target.value })} />
            </div>
            <div className="space-y-1">
              <Label className="text-xs">Date of Joining</Label>
              <DateInput className="h-8" value={form.joinDateText} onChange={(t) => set({ joinDateText: t })} />
            </div>
            {!form.id && (
              <div className="space-y-1">
                <Label className="text-xs">Assign Vehicle (optional)</Label>
                <MasterCombobox
                  options={vehicleOptions}
                  value={form.vehicleId}
                  onChange={(v) => set({ vehicleId: v })}
                  placeholder="Select vehicle..."
                />
              </div>
            )}
            <div className="space-y-1 sm:col-span-2">
              <Label className="text-xs">Remarks</Label>
              <Input className="h-8" value={form.remarks} onChange={(e) => set({ remarks: e.target.value })} />
            </div>
          </div>

          <div className="grid gap-2 sm:grid-cols-2">
            {DOC_SLOTS.map(([key, label]) => (
              <FileUploadField
                key={key}
                label={label}
                endpoint="/api/uploads/docreg"
                filePath={form[key].path}
                fileName={form[key].name}
                onChange={(path, name) => set({ [key]: { path, name } } as Partial<typeof emptyForm>)}
              />
            ))}
          </div>

          {/* other documents — multiple */}
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <Label className="text-xs font-medium">Other Documents ({form.otherDocs.length})</Label>
              <OtherDocAdder
                onAdd={(doc) => set({ otherDocs: [...form.otherDocs, doc] })}
              />
            </div>
            {form.otherDocs.map((o, i) => (
              <div key={i} className="flex items-center gap-2 text-xs">
                <span className="font-medium">{o.title}</span>
                <a
                  href={`/api/uploads/${o.path}`}
                  target="_blank"
                  rel="noreferrer"
                  className="text-primary underline"
                >
                  {o.name}
                </a>
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-6 w-6 text-destructive"
                  onClick={() => set({ otherDocs: form.otherDocs.filter((_, idx) => idx !== i) })}
                >
                  <Trash2 className="h-3 w-3" />
                </Button>
              </div>
            ))}
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={() => setFormOpen(false)} disabled={busy}>
              Cancel
            </Button>
            <Button
              disabled={busy || !form.name.trim()}
              onClick={() =>
                run(
                  () =>
                    saveDriver({
                      id: form.id,
                      name: form.name,
                      partyId: form.partyId,
                      mobile: form.mobile,
                      emergencyContact: form.emergencyContact,
                      address: form.address,
                      joinDate: form.joinDateText ? textToIso(form.joinDateText) : null,
                      remarks: form.remarks,
                      vehicleId: form.vehicleId,
                      licence: form.licence,
                      aadhaar: form.aadhaar,
                      pan: form.pan,
                      photo: form.photo,
                      medical: form.medical,
                      police: form.police,
                      otherDocs: form.otherDocs,
                    }),
                  () => {
                    toast({ title: "Driver saved" });
                    setFormOpen(false);
                  }
                )
              }
            >
              {busy ? "Saving..." : "Save Driver"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ------------- transfer ------------- */}
      <Dialog open={!!transferOf} onOpenChange={(o) => !o && setTransferOf(null)}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>Transfer {transferOf?.name}</DialogTitle>
            <DialogDescription>
              Currently on {transferOf?.currentVehicle || "no vehicle"}. The old assignment is
              closed with the reason — history is never overwritten.
            </DialogDescription>
          </DialogHeader>
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1">
              <Label className="text-xs">Vehicle Change Date *</Label>
              <DateInput
                className="h-8"
                value={transfer.changeDateText}
                onChange={(t) => setTransfer((f) => ({ ...f, changeDateText: t }))}
              />
            </div>
            <div className="space-y-1">
              <Label className="text-xs">New Vehicle *</Label>
              <MasterCombobox
                options={vehicleOptions}
                value={transfer.newVehicleId}
                onChange={(v) => setTransfer((f) => ({ ...f, newVehicleId: v }))}
                placeholder="Select vehicle..."
              />
            </div>
            <div className="space-y-1">
              <Label className="text-xs">Reason for Change</Label>
              <Input
                className="h-8"
                value={transfer.reason}
                onChange={(e) => setTransfer((f) => ({ ...f, reason: e.target.value }))}
              />
            </div>
            <div className="space-y-1">
              <Label className="text-xs">Remarks</Label>
              <Input
                className="h-8"
                value={transfer.remarks}
                onChange={(e) => setTransfer((f) => ({ ...f, remarks: e.target.value }))}
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setTransferOf(null)} disabled={busy}>
              Cancel
            </Button>
            <Button
              disabled={busy || !transfer.newVehicleId}
              onClick={() =>
                run(
                  () =>
                    transferDriver({
                      driverId: transferOf!.id,
                      changeDate: textToIso(transfer.changeDateText),
                      newVehicleId: transfer.newVehicleId ?? "",
                      reason: transfer.reason,
                      remarks: transfer.remarks,
                    }),
                  () => {
                    toast({ title: `${transferOf?.name} transferred` });
                    setTransferOf(null);
                  }
                )
              }
            >
              {busy ? "Saving..." : "Transfer"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ------------- exit ------------- */}
      <Dialog open={!!exitOf} onOpenChange={(o) => !o && setExitOf(null)}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>Exit {exitOf?.name}</DialogTitle>
            <DialogDescription>
              The driver is marked INACTIVE and the open vehicle assignment is closed. All history
              stays saved.
            </DialogDescription>
          </DialogHeader>
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1">
              <Label className="text-xs">Date of Exit *</Label>
              <DateInput
                className="h-8"
                value={exit.exitDateText}
                onChange={(t) => setExit((f) => ({ ...f, exitDateText: t }))}
              />
            </div>
            <div className="space-y-1">
              <Label className="text-xs">Reason for Exit</Label>
              <Input
                className="h-8"
                value={exit.exitReason}
                onChange={(e) => setExit((f) => ({ ...f, exitReason: e.target.value }))}
              />
            </div>
            <div className="space-y-1 sm:col-span-2">
              <Label className="text-xs">Remarks</Label>
              <Input
                className="h-8"
                value={exit.remarks}
                onChange={(e) => setExit((f) => ({ ...f, remarks: e.target.value }))}
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setExitOf(null)} disabled={busy}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              disabled={busy}
              onClick={() =>
                run(
                  () =>
                    exitDriver({
                      driverId: exitOf!.id,
                      exitDate: textToIso(exit.exitDateText),
                      exitReason: exit.exitReason,
                      remarks: exit.remarks,
                    }),
                  () => {
                    toast({ title: `${exitOf?.name} exited` });
                    setExitOf(null);
                  }
                )
              }
            >
              {busy ? "Saving..." : "Record Exit"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ------------- view history ------------- */}
      <Dialog open={!!viewOf} onOpenChange={(o) => !o && setViewOf(null)}>
        <DialogContent className="max-h-[95vh] overflow-y-auto sm:max-w-3xl">
          <DialogHeader>
            <DialogTitle>
              {viewOf?.driverCode} — {viewOf?.name}
            </DialogTitle>
            <DialogDescription>
              {viewOf?.status === "ACTIVE"
                ? `Active${viewOf?.currentVehicle ? ` on ${viewOf.currentVehicle}` : ""}`
                : `Exited ${viewOf?.exitDate ? formatDate(viewOf.exitDate) : ""}${viewOf?.exitReason ? ` — ${viewOf.exitReason}` : ""}`}
            </DialogDescription>
          </DialogHeader>

          <div className="grid grid-cols-2 gap-2 text-xs sm:grid-cols-3">
            {[
              ["Mobile", viewOf?.mobile],
              ["Emergency", viewOf?.emergencyContact],
              ["Joined", viewOf?.joinDate ? formatDate(viewOf.joinDate) : ""],
              ["Address", viewOf?.address],
              ["Remarks", viewOf?.remarks],
            ]
              .filter(([, v]) => v)
              .map(([label, v]) => (
                <div key={label as string} className="rounded-md border p-2">
                  <div className="text-[11px] text-muted-foreground">{label}</div>
                  <div className="font-medium">{v}</div>
                </div>
              ))}
          </div>

          <div className="space-y-1">
            <Label className="text-xs font-medium">Documents</Label>
            <div className="flex flex-wrap gap-1.5 text-xs">
              {viewOf &&
                (
                  [
                    ["Licence", viewOf.licence],
                    ["Aadhaar", viewOf.aadhaar],
                    ["PAN", viewOf.pan],
                    ["Photo", viewOf.photo],
                    ["Medical", viewOf.medical],
                    ["Police Verification", viewOf.police],
                  ] as [string, DocSlot][]
                )
                  .filter(([, s]) => s.path)
                  .map(([label, s]) => (
                    <a
                      key={label}
                      href={`/api/uploads/${s.path}`}
                      target="_blank"
                      rel="noreferrer"
                      className="rounded-md border px-2 py-1 text-primary underline-offset-2 hover:underline"
                    >
                      {label}
                    </a>
                  ))}
              {viewOf?.otherDocs.map((o, i) => (
                <a
                  key={i}
                  href={`/api/uploads/${o.path}`}
                  target="_blank"
                  rel="noreferrer"
                  className="rounded-md border px-2 py-1 text-primary underline-offset-2 hover:underline"
                >
                  {o.title}
                </a>
              ))}
            </div>
          </div>

          <div className="space-y-1">
            <Label className="text-xs font-medium">Vehicle Assignment History</Label>
            <table className="w-full border-collapse text-xs">
              <thead>
                <tr>
                  {["#", "Vehicle", "From", "To", "Reason", "Remarks"].map((h) => (
                    <th key={h} className="border px-1.5 py-1 text-left font-semibold">
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {viewOf?.assignments.map((a, i) => (
                  <tr key={i} className={!a.toDate ? "bg-muted/40" : undefined}>
                    <td className="border px-1.5 py-1">{i + 1}</td>
                    <td className="border px-1.5 py-1">{a.vehicle}</td>
                    <td className="border px-1.5 py-1">{formatDate(a.fromDate)}</td>
                    <td className="border px-1.5 py-1">{a.toDate ? formatDate(a.toDate) : "Current"}</td>
                    <td className="border px-1.5 py-1">{a.reason}</td>
                    <td className="border px-1.5 py-1">{a.remarks}</td>
                  </tr>
                ))}
                {!viewOf?.assignments.length && (
                  <tr>
                    <td colSpan={6} className="border px-1.5 py-2 text-center text-muted-foreground">
                      No vehicle assignments yet.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={() => setViewOf(null)}>
              Close
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

/** small inline "add other document" control: title + upload */
function OtherDocAdder({
  onAdd,
}: {
  onAdd: (doc: { title: string; path: string; name: string }) => void;
}) {
  const { toast } = useToast();
  const [title, setTitle] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const ref = React.useRef<HTMLInputElement>(null);

  const upload = async (file: File) => {
    setBusy(true);
    try {
      const fd = new FormData();
      fd.append("file", file);
      const res = await fetch("/api/uploads/docreg", { method: "POST", body: fd });
      const json = await res.json();
      if (!res.ok || !json.ok) throw new Error(json.error ?? "Upload failed");
      onAdd({ title: title.trim() || file.name, path: json.path, name: file.name });
      setTitle("");
    } catch (e) {
      toast({
        variant: "destructive",
        title: "Upload failed",
        description: e instanceof Error ? e.message : undefined,
      });
    } finally {
      setBusy(false);
      if (ref.current) ref.current.value = "";
    }
  };

  return (
    <div className="flex flex-wrap items-center gap-2">
      <Input
        className="h-7 w-44 text-xs"
        placeholder="Document title..."
        value={title}
        onChange={(e) => setTitle(e.target.value)}
      />
      <input
        ref={ref}
        type="file"
        accept=".pdf,.jpg,.jpeg,.png"
        className="hidden"
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) void upload(f);
        }}
      />
      <Button type="button" variant="outline" size="sm" className="h-7" disabled={busy} onClick={() => ref.current?.click()}>
        <Plus className="h-3 w-3" /> {busy ? "Uploading..." : "Add Document"}
      </Button>
    </div>
  );
}
