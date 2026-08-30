"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import type { ColumnDef } from "@tanstack/react-table";
import { ArrowLeftRight, Eye, Plus, Trash2 } from "lucide-react";
import { formatDate, parseDdMmYyyy } from "@/lib/utils";
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
  createTyre,
  deleteTyre,
  removeTyre,
  transferTyre,
  updateTyre,
} from "@/app/(app)/vehicle/tyres/actions";

export interface TyreCycleRow {
  vehicle: string;
  position: string;
  instDate: string;
  instKm: number;
  removalDate: string | null;
  removalKm: number | null;
  removalReason: string;
  remarks: string;
  runKm: number;
  runDays: number;
}

export interface TyreRow {
  id: string;
  tyreNo: string;
  tyreName: string;
  status: string; // RUNNING | REMOVED
  currentVehicle: string;
  currentPosition: string;
  firstInstDate: string;
  vehicleCount: number;
  totalKm: number;
  totalDays: number;
  kmRange: string;
  cycles: TyreCycleRow[];
}

function textToIso(text: string): string {
  const d = parseDdMmYyyy(text);
  if (!d) return "";
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${d.getFullYear()}-${mm}-${dd}`;
}

const km = (n: number) => n.toLocaleString("en-IN");

const emptyNew = {
  entryDateText: formatDate(new Date()),
  vehicleId: null as string | null,
  tyreName: "",
  tyreNo: "",
  position: "HORSE" as "HORSE" | "TRAILER",
  instDateText: formatDate(new Date()),
  instKm: 0,
  remarks: "",
};

export function TyreClient({
  rows,
  vehicleOptions,
  tyreNames,
  canEdit,
  canDelete = false,
}: {
  rows: TyreRow[];
  vehicleOptions: MasterOption[];
  tyreNames: string[];
  canEdit: boolean;
  canDelete?: boolean;
}) {
  const router = useRouter();
  const { toast } = useToast();
  const [busy, setBusy] = React.useState(false);

  const [newOpen, setNewOpen] = React.useState(false);
  const [form, setForm] = React.useState(emptyNew);
  const set = (p: Partial<typeof emptyNew>) => setForm((f) => ({ ...f, ...p }));

  const [transferOf, setTransferOf] = React.useState<TyreRow | null>(null);
  const [transfer, setTransfer] = React.useState({
    changeDateText: formatDate(new Date()),
    oldKm: 0,
    newVehicleId: null as string | null,
    newInstKm: 0,
    position: "HORSE" as "HORSE" | "TRAILER",
    remarks: "",
  });

  const [removalOf, setRemovalOf] = React.useState<TyreRow | null>(null);
  const [removal, setRemoval] = React.useState({
    removalDateText: formatDate(new Date()),
    removalKm: 0,
    reason: "",
    remarks: "",
  });

  const [viewOf, setViewOf] = React.useState<TyreRow | null>(null);

  const [editOf, setEditOf] = React.useState<TyreRow | null>(null);
  const [edit, setEdit] = React.useState({
    tyreName: "",
    tyreNo: "",
    position: "HORSE" as "HORSE" | "TRAILER",
    instDateText: "",
    instKm: 0,
  });

  const run = async (fn: () => Promise<{ ok: boolean; error?: string }>, done: () => void) => {
    setBusy(true);
    try {
      const res = await fn();
      if (res.ok) {
        done();
        router.refresh();
      } else {
        toast({ variant: "destructive", title: "Failed", description: res.error });
      }
    } finally {
      setBusy(false);
    }
  };

  const columns: ColumnDef<TyreRow>[] = React.useMemo(() => [
    { accessorKey: "tyreNo", header: "Tyre No" },
    { accessorKey: "tyreName", header: "Tyre Name" },
    {
      accessorKey: "currentVehicle",
      header: "Current Vehicle",
      cell: ({ row }) =>
        row.original.currentVehicle || <span className="text-muted-foreground">—</span>,
    },
    {
      accessorKey: "currentPosition",
      header: "Position",
      cell: ({ row }) =>
        row.original.currentPosition ? (
          <Badge variant="secondary">{row.original.currentPosition}</Badge>
        ) : null,
    },
    {
      accessorKey: "firstInstDate",
      header: "First Installed",
      cell: ({ row }) =>
        row.original.firstInstDate ? formatDate(row.original.firstInstDate) : "",
    },
    {
      accessorKey: "vehicleCount",
      header: "Vehicles",
      meta: { numeric: true } satisfies DataTableColumnMeta<TyreRow>,
    },
    {
      accessorKey: "totalKm",
      header: "Total Run KM",
      cell: ({ row }) => km(row.original.totalKm),
      meta: { numeric: true } satisfies DataTableColumnMeta<TyreRow>,
    },
    {
      accessorKey: "totalDays",
      header: "Total Days",
      meta: { numeric: true } satisfies DataTableColumnMeta<TyreRow>,
    },
    { accessorKey: "kmRange", header: "KM Range" },
    {
      accessorKey: "status",
      header: "Status",
      cell: ({ row }) =>
        row.original.status === "RUNNING" ? (
          <Badge>RUNNING</Badge>
        ) : (
          <Badge variant="destructive">REMOVED</Badge>
        ),
    },
    {
      id: "actions",
      header: "",
      cell: ({ row }) => (
        <div className="flex gap-0.5" onClick={(e) => e.stopPropagation()}>
          <Button
            variant="ghost"
            size="sm"
            className="h-6 px-2 text-xs"
            title="Complete tyre history"
            onClick={() => setViewOf(row.original)}
          >
            <Eye className="h-3.5 w-3.5" /> View
          </Button>
          {canEdit && (
            <Button
              variant="ghost"
              size="sm"
              className="h-6 px-2 text-xs"
              title="Edit tyre details"
              onClick={() => {
                const open = row.original.cycles.find((c) => !c.removalDate);
                setEdit({
                  tyreName: row.original.tyreName,
                  tyreNo: row.original.tyreNo,
                  position: (open?.position ?? "HORSE") as "HORSE" | "TRAILER",
                  instDateText: open ? formatDate(open.instDate) : "",
                  instKm: open?.instKm ?? 0,
                });
                setEditOf(row.original);
              }}
            >
              Edit
            </Button>
          )}
          {canDelete && (
            <Button
              variant="ghost"
              size="sm"
              className="h-6 px-2 text-xs text-destructive"
              title="Delete tyre (Admin/Owner only)"
              onClick={async () => {
                if (
                  !confirm(
                    `Delete tyre ${row.original.tyreNo} and its complete history? This cannot be undone.`
                  )
                )
                  return;
                const res = await deleteTyre(row.original.id);
                if (res.ok) {
                  toast({ title: `Tyre ${row.original.tyreNo} deleted` });
                  router.refresh();
                } else toast({ variant: "destructive", title: "Delete failed", description: res.error });
              }}
            >
              Delete
            </Button>
          )}
          {canEdit && row.original.status === "RUNNING" && (
            <>
              <Button
                variant="ghost"
                size="sm"
                className="h-6 px-2 text-xs"
                title="Transfer to another vehicle"
                onClick={() => {
                  setTransfer({
                    changeDateText: formatDate(new Date()),
                    oldKm: 0,
                    newVehicleId: null,
                    newInstKm: 0,
                    position: (row.original.currentPosition || "HORSE") as "HORSE" | "TRAILER",
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
                title="Final removal"
                onClick={() => {
                  setRemoval({
                    removalDateText: formatDate(new Date()),
                    removalKm: 0,
                    reason: "",
                    remarks: "",
                  });
                  setRemovalOf(row.original);
                }}
              >
                <Trash2 className="h-3.5 w-3.5" /> Remove
              </Button>
            </>
          )}
        </div>
      ),
    },
  ], [canDelete, canEdit, router, toast]);

  const openCycle = (t: TyreRow | null) => t?.cycles.find((c) => !c.removalDate);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h1 className="text-xl font-semibold">Tyre Management</h1>
        <div className="flex flex-wrap gap-2">
          <ExportButton
            rows={rows}
            fileName="tyre-register"
            sheetName="Tyre Register"
            columns={[
              { header: "Tyre No", key: "tyreNo" },
              { header: "Tyre Name", key: "tyreName" },
              { header: "Current Vehicle", key: "currentVehicle" },
              { header: "Position", key: "currentPosition" },
              { header: "First Installed", accessor: (r) => (r.firstInstDate ? formatDate(r.firstInstDate) : "") },
              { header: "Vehicles Used", key: "vehicleCount", numeric: true },
              { header: "Total Run KM", key: "totalKm", numeric: true },
              { header: "Total Days", key: "totalDays", numeric: true },
              { header: "KM Range", key: "kmRange" },
              { header: "Status", key: "status" },
            ]}
          />
          {canEdit && (
            <Button size="sm" onClick={() => { setForm(emptyNew); setNewOpen(true); }}>
              <Plus className="h-4 w-4" /> New Tyre
            </Button>
          )}
        </div>
      </div>
      <p className="text-sm text-muted-foreground">
        Each tyre number is a permanent identity — transfers and removals stay linked to it, and
        total life (KM + days) accumulates across every vehicle. History is never deleted.
      </p>
      <FilterBar
        filters={[
          { type: "text", key: "q", label: "Tyre Number..." },
          { type: "combobox", key: "vehicle", label: "Vehicle", options: vehicleOptions },
          {
            type: "combobox",
            key: "name",
            label: "Tyre Name",
            options: tyreNames.map((n) => ({ value: n, label: n })),
          },
          {
            type: "select",
            key: "position",
            label: "Position",
            options: [
              { value: "HORSE", label: "Horse" },
              { value: "TRAILER", label: "Trailer" },
            ],
          },
          { type: "daterange", key: "date", label: "Installed Between" },
          {
            type: "select",
            key: "status",
            label: "Status",
            options: [
              { value: "RUNNING", label: "Running" },
              { value: "REMOVED", label: "Removed" },
            ],
          },
        ]}
      />
      <DataTable
        columns={columns}
        data={rows}
        emptyMessage="No tyres yet — add the first installation."
        onRowClick={(row) => setViewOf(row)}
      />

      {/* ---------------- new tyre ---------------- */}
      <Dialog open={newOpen} onOpenChange={setNewOpen}>
        <DialogContent className="max-h-[95vh] overflow-y-auto sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>New Tyre Installation</DialogTitle>
            <DialogDescription>
              The tyre number becomes the tyre&apos;s permanent identity — it must be unique. Tyre
              name is free text (existing names suggested); it does not touch any master.
            </DialogDescription>
          </DialogHeader>
          <div className="grid gap-3 sm:grid-cols-3">
            <div className="space-y-1">
              <Label className="text-xs">Entry Date *</Label>
              <DateInput className="h-8" value={form.entryDateText} onChange={(t) => set({ entryDateText: t })} />
            </div>
            <div className="space-y-1">
              <Label className="text-xs">Vehicle No *</Label>
              <MasterCombobox
                options={vehicleOptions}
                value={form.vehicleId}
                onChange={(v) => set({ vehicleId: v })}
                placeholder="Select vehicle..."
              />
            </div>
            <div className="space-y-1">
              <Label className="text-xs">Position *</Label>
              <Select value={form.position} onValueChange={(v) => set({ position: v as "HORSE" | "TRAILER" })}>
                <SelectTrigger className="h-8"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="HORSE">Horse</SelectItem>
                  <SelectItem value="TRAILER">Trailer</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1">
              <Label className="text-xs">Tyre Name *</Label>
              <Input
                className="h-8"
                list="tyre-name-options"
                placeholder="e.g. MRF Steel Muscle 10.00R20"
                value={form.tyreName}
                onChange={(e) => set({ tyreName: e.target.value })}
              />
              <datalist id="tyre-name-options">
                {tyreNames.map((n) => (
                  <option key={n} value={n} />
                ))}
              </datalist>
            </div>
            <div className="space-y-1">
              <Label className="text-xs">Tyre Number * (unique)</Label>
              <Input
                className="h-8 uppercase"
                placeholder="e.g. TY-00123"
                value={form.tyreNo}
                onChange={(e) => set({ tyreNo: e.target.value })}
              />
            </div>
            <div className="space-y-1">
              <Label className="text-xs">Installation Date *</Label>
              <DateInput className="h-8" value={form.instDateText} onChange={(t) => set({ instDateText: t })} />
            </div>
            <div className="space-y-1">
              <Label className="text-xs">Installation KM *</Label>
              <Input
                type="number"
                className="h-8 text-right"
                value={form.instKm ? String(form.instKm) : ""}
                onChange={(e) => set({ instKm: Number(e.target.value) || 0 })}
              />
            </div>
            <div className="space-y-1 sm:col-span-2">
              <Label className="text-xs">Remarks</Label>
              <Input className="h-8" value={form.remarks} onChange={(e) => set({ remarks: e.target.value })} />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setNewOpen(false)} disabled={busy}>Cancel</Button>
            <Button
              disabled={busy || !form.vehicleId || !form.tyreName.trim() || !form.tyreNo.trim()}
              onClick={() =>
                run(
                  () =>
                    createTyre({
                      entryDate: textToIso(form.entryDateText),
                      vehicleId: form.vehicleId ?? "",
                      tyreName: form.tyreName,
                      tyreNo: form.tyreNo,
                      position: form.position,
                      instDate: textToIso(form.instDateText),
                      instKm: form.instKm,
                      remarks: form.remarks,
                    }),
                  () => {
                    toast({ title: `Tyre ${form.tyreNo.toUpperCase()} installed` });
                    setNewOpen(false);
                  }
                )
              }
            >
              {busy ? "Saving..." : "Save Tyre"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ---------------- transfer ---------------- */}
      <Dialog open={!!transferOf} onOpenChange={(o) => !o && setTransferOf(null)}>
        <DialogContent className="sm:max-w-xl">
          <DialogHeader>
            <DialogTitle>Transfer Tyre {transferOf?.tyreNo}</DialogTitle>
            <DialogDescription>
              Currently on {transferOf?.currentVehicle} (installed at{" "}
              {km(openCycle(transferOf)?.instKm ?? 0)} KM). The current cycle closes at the old
              vehicle KM and a new cycle starts on the new vehicle — same tyre number.
            </DialogDescription>
          </DialogHeader>
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1">
              <Label className="text-xs">Change Date *</Label>
              <DateInput
                className="h-8"
                value={transfer.changeDateText}
                onChange={(t) => setTransfer((f) => ({ ...f, changeDateText: t }))}
              />
            </div>
            <div className="space-y-1">
              <Label className="text-xs">Old Vehicle KM * ({transferOf?.currentVehicle})</Label>
              <Input
                type="number"
                className="h-8 text-right"
                value={transfer.oldKm ? String(transfer.oldKm) : ""}
                onChange={(e) => setTransfer((f) => ({ ...f, oldKm: Number(e.target.value) || 0 }))}
              />
            </div>
            <div className="space-y-1">
              <Label className="text-xs">New Vehicle No *</Label>
              <MasterCombobox
                options={vehicleOptions}
                value={transfer.newVehicleId}
                onChange={(v) => setTransfer((f) => ({ ...f, newVehicleId: v }))}
                placeholder="Select vehicle..."
              />
            </div>
            <div className="space-y-1">
              <Label className="text-xs">New Vehicle Installation KM *</Label>
              <Input
                type="number"
                className="h-8 text-right"
                value={transfer.newInstKm ? String(transfer.newInstKm) : ""}
                onChange={(e) =>
                  setTransfer((f) => ({ ...f, newInstKm: Number(e.target.value) || 0 }))
                }
              />
            </div>
            <div className="space-y-1">
              <Label className="text-xs">Position *</Label>
              <Select
                value={transfer.position}
                onValueChange={(v) => setTransfer((f) => ({ ...f, position: v as "HORSE" | "TRAILER" }))}
              >
                <SelectTrigger className="h-8"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="HORSE">Horse</SelectItem>
                  <SelectItem value="TRAILER">Trailer</SelectItem>
                </SelectContent>
              </Select>
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
            <Button variant="outline" onClick={() => setTransferOf(null)} disabled={busy}>Cancel</Button>
            <Button
              disabled={busy || !transfer.newVehicleId || transfer.oldKm <= 0}
              onClick={() =>
                run(
                  () =>
                    transferTyre({
                      tyreId: transferOf!.id,
                      changeDate: textToIso(transfer.changeDateText),
                      oldKm: transfer.oldKm,
                      newVehicleId: transfer.newVehicleId ?? "",
                      newInstKm: transfer.newInstKm,
                      position: transfer.position,
                      remarks: transfer.remarks,
                    }),
                  () => {
                    toast({ title: `Tyre ${transferOf?.tyreNo} transferred` });
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

      {/* ---------------- removal ---------------- */}
      <Dialog open={!!removalOf} onOpenChange={(o) => !o && setRemovalOf(null)}>
        <DialogContent className="sm:max-w-xl">
          <DialogHeader>
            <DialogTitle>Remove Tyre {removalOf?.tyreNo}</DialogTitle>
            <DialogDescription>
              Final removal from {removalOf?.currentVehicle}. The full history stays saved — the
              tyre is only marked REMOVED.
            </DialogDescription>
          </DialogHeader>
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1">
              <Label className="text-xs">Removal Date *</Label>
              <DateInput
                className="h-8"
                value={removal.removalDateText}
                onChange={(t) => setRemoval((f) => ({ ...f, removalDateText: t }))}
              />
            </div>
            <div className="space-y-1">
              <Label className="text-xs">Removal KM *</Label>
              <Input
                type="number"
                className="h-8 text-right"
                value={removal.removalKm ? String(removal.removalKm) : ""}
                onChange={(e) =>
                  setRemoval((f) => ({ ...f, removalKm: Number(e.target.value) || 0 }))
                }
              />
            </div>
            <div className="space-y-1">
              <Label className="text-xs">Removal Reason (optional)</Label>
              <Input
                className="h-8"
                placeholder="Worn out / burst / retreading..."
                value={removal.reason}
                onChange={(e) => setRemoval((f) => ({ ...f, reason: e.target.value }))}
              />
            </div>
            <div className="space-y-1">
              <Label className="text-xs">Remarks (optional)</Label>
              <Input
                className="h-8"
                value={removal.remarks}
                onChange={(e) => setRemoval((f) => ({ ...f, remarks: e.target.value }))}
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setRemovalOf(null)} disabled={busy}>Cancel</Button>
            <Button
              variant="destructive"
              disabled={busy || removal.removalKm <= 0}
              onClick={() =>
                run(
                  () =>
                    removeTyre({
                      tyreId: removalOf!.id,
                      removalDate: textToIso(removal.removalDateText),
                      removalKm: removal.removalKm,
                      reason: removal.reason,
                      remarks: removal.remarks,
                    }),
                  () => {
                    toast({ title: `Tyre ${removalOf?.tyreNo} removed` });
                    setRemovalOf(null);
                  }
                )
              }
            >
              {busy ? "Saving..." : "Remove Tyre"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ---------------- edit tyre ---------------- */}
      <Dialog open={!!editOf} onOpenChange={(o) => !o && setEditOf(null)}>
        <DialogContent className="sm:max-w-xl">
          <DialogHeader>
            <DialogTitle>Edit Tyre {editOf?.tyreNo}</DialogTitle>
            <DialogDescription>
              Tyre number stays unique. Movement history is not affected — only the identity and
              (for running tyres) the current installation details change.
            </DialogDescription>
          </DialogHeader>
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1">
              <Label className="text-xs">Tyre Name *</Label>
              <Input
                className="h-8"
                list="tyre-name-options"
                value={edit.tyreName}
                onChange={(e) => setEdit((f) => ({ ...f, tyreName: e.target.value }))}
              />
            </div>
            <div className="space-y-1">
              <Label className="text-xs">Tyre Number * (unique)</Label>
              <Input
                className="h-8 uppercase"
                value={edit.tyreNo}
                onChange={(e) => setEdit((f) => ({ ...f, tyreNo: e.target.value }))}
              />
            </div>
            {editOf?.status === "RUNNING" && (
              <>
                <div className="space-y-1">
                  <Label className="text-xs">Position (current cycle)</Label>
                  <Select
                    value={edit.position}
                    onValueChange={(v) => setEdit((f) => ({ ...f, position: v as "HORSE" | "TRAILER" }))}
                  >
                    <SelectTrigger className="h-8"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="HORSE">Horse</SelectItem>
                      <SelectItem value="TRAILER">Trailer</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-1">
                  <Label className="text-xs">Installation Date (current cycle)</Label>
                  <DateInput
                    className="h-8"
                    value={edit.instDateText}
                    onChange={(t) => setEdit((f) => ({ ...f, instDateText: t }))}
                  />
                </div>
                <div className="space-y-1">
                  <Label className="text-xs">Installation KM (current cycle)</Label>
                  <Input
                    type="number"
                    className="h-8 text-right"
                    value={edit.instKm ? String(edit.instKm) : ""}
                    onChange={(e) => setEdit((f) => ({ ...f, instKm: Number(e.target.value) || 0 }))}
                  />
                </div>
              </>
            )}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setEditOf(null)} disabled={busy}>Cancel</Button>
            <Button
              disabled={busy || !edit.tyreName.trim() || !edit.tyreNo.trim()}
              onClick={() =>
                run(
                  () =>
                    updateTyre({
                      tyreId: editOf!.id,
                      tyreName: edit.tyreName,
                      tyreNo: edit.tyreNo,
                      position: edit.position,
                      instDate: edit.instDateText ? textToIso(edit.instDateText) : null,
                      instKm: edit.instKm || null,
                    }),
                  () => {
                    toast({ title: "Tyre updated" });
                    setEditOf(null);
                  }
                )
              }
            >
              {busy ? "Saving..." : "Save Changes"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ---------------- history view ---------------- */}
      <Dialog open={!!viewOf} onOpenChange={(o) => !o && setViewOf(null)}>
        <DialogContent className="max-h-[95vh] overflow-y-auto sm:max-w-4xl">
          <DialogHeader>
            <DialogTitle>
              Tyre {viewOf?.tyreNo} — {viewOf?.tyreName}
            </DialogTitle>
            <DialogDescription>
              Complete life history across {viewOf?.vehicleCount} vehicle
              {viewOf?.vehicleCount === 1 ? "" : "s"} · Status:{" "}
              {viewOf?.status === "RUNNING" ? `RUNNING on ${viewOf?.currentVehicle}` : "REMOVED"}
            </DialogDescription>
          </DialogHeader>

          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
            {[
              ["Total Running KM", km(viewOf?.totalKm ?? 0)],
              ["Total Running Days", String(viewOf?.totalDays ?? 0)],
              ["KM Range", viewOf?.kmRange ?? ""],
              ["Current Position", viewOf?.currentPosition || "—"],
            ].map(([label, v]) => (
              <div key={label} className="rounded-md border p-2">
                <div className="text-[11px] text-muted-foreground">{label}</div>
                <div className="text-sm font-semibold">{v}</div>
              </div>
            ))}
          </div>

          <div className="overflow-x-auto">
            <table className="w-full border-collapse text-xs">
              <thead>
                <tr>
                  {[
                    "#",
                    "Vehicle",
                    "Position",
                    "Installed",
                    "Inst. KM",
                    "Removed / Changed",
                    "Removal KM",
                    "Run KM",
                    "Run Days",
                    "Reason",
                    "Remarks",
                  ].map((h) => (
                    <th key={h} className="border px-1.5 py-1 text-left font-semibold">
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {viewOf?.cycles.map((c, i) => (
                  <tr key={i} className={!c.removalDate ? "bg-muted/40" : undefined}>
                    <td className="border px-1.5 py-1">{i + 1}</td>
                    <td className="border px-1.5 py-1">{c.vehicle}</td>
                    <td className="border px-1.5 py-1">{c.position}</td>
                    <td className="border px-1.5 py-1">{formatDate(c.instDate)}</td>
                    <td className="border px-1.5 py-1 text-right">{km(c.instKm)}</td>
                    <td className="border px-1.5 py-1">
                      {c.removalDate ? formatDate(c.removalDate) : "Running"}
                    </td>
                    <td className="border px-1.5 py-1 text-right">
                      {c.removalKm != null ? km(c.removalKm) : ""}
                    </td>
                    <td className="border px-1.5 py-1 text-right font-medium">
                      {c.removalKm != null ? km(c.runKm) : "—"}
                    </td>
                    <td className="border px-1.5 py-1 text-right">{c.runDays}</td>
                    <td className="border px-1.5 py-1">{c.removalReason}</td>
                    <td className="border px-1.5 py-1">{c.remarks}</td>
                  </tr>
                ))}
                <tr className="font-semibold">
                  <td colSpan={7} className="border px-1.5 py-1 text-right">
                    Total Tyre Life
                  </td>
                  <td className="border px-1.5 py-1 text-right">{km(viewOf?.totalKm ?? 0)}</td>
                  <td className="border px-1.5 py-1 text-right">{viewOf?.totalDays ?? 0}</td>
                  <td colSpan={2} className="border px-1.5 py-1" />
                </tr>
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
