"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import type { ColumnDef } from "@tanstack/react-table";
import { Plus, Trash2 } from "lucide-react";
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
import { useToast } from "@/components/ui/use-toast";
import { DataTable } from "@/components/data/data-table";
import { DateInput } from "@/components/data/date-input";
import { ExportButton } from "@/components/data/export-button";
import { FilterBar } from "@/components/data/filter-bar";
import {
  deleteCourierDispatch,
  saveCourierDispatch,
} from "@/app/(app)/broker/courier/actions";

export interface CourierDispatchItemRow {
  vehicleNo: string;
  documentDetails: string;
  remarks: string;
}

export interface CourierDispatchRow {
  id: string;
  dispatchNo: string;
  dispatchDate: string;
  courierCompany: string;
  trackingNo: string;
  partyName: string;
  remarks: string;
  attachmentPath: string | null;
  attachmentName: string;
  items: CourierDispatchItemRow[];
}

function textToIso(text: string): string {
  const d = parseDdMmYyyy(text);
  if (!d) return "";
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${d.getFullYear()}-${mm}-${dd}`;
}

const emptyItem: CourierDispatchItemRow = { vehicleNo: "", documentDetails: "", remarks: "" };

const emptyForm = {
  id: null as string | null,
  dateText: formatDate(new Date()),
  courierCompany: "",
  trackingNo: "",
  partyName: "",
  remarks: "",
  attachmentPath: null as string | null,
  attachmentName: "",
  items: [{ ...emptyItem }] as CourierDispatchItemRow[],
};

export function CourierDispatchClient({
  rows,
  canDelete,
}: {
  rows: CourierDispatchRow[];
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
  const setItem = (idx: number, patch: Partial<CourierDispatchItemRow>) =>
    setForm((f) => ({
      ...f,
      items: f.items.map((it, i) => (i === idx ? { ...it, ...patch } : it)),
    }));

  const openNew = () => {
    setForm({ ...emptyForm, items: [{ ...emptyItem }] });
    setOpen(true);
  };
  const openEdit = React.useCallback((row: CourierDispatchRow) => {
    setForm({
      id: row.id,
      dateText: formatDate(row.dispatchDate),
      courierCompany: row.courierCompany,
      trackingNo: row.trackingNo,
      partyName: row.partyName,
      remarks: row.remarks,
      attachmentPath: row.attachmentPath,
      attachmentName: row.attachmentName,
      items: row.items.length ? row.items.map((it) => ({ ...it })) : [{ ...emptyItem }],
    });
    setOpen(true);
  }, []);

  const uploadSlip = async (file: File | null) => {
    if (!file) return;
    setUploading(true);
    try {
      const fd = new FormData();
      fd.append("file", file);
      const res = await fetch("/api/uploads/docreg", { method: "POST", body: fd });
      const json = await res.json();
      if (!res.ok || !json.ok) throw new Error(json.error ?? "Upload failed");
      set({ attachmentPath: json.path, attachmentName: file.name });
      toast({ title: "Courier slip ready — will be saved with the dispatch" });
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

  const validItems = form.items.filter((it) => it.vehicleNo.trim() && it.documentDetails.trim());

  const submit = async () => {
    setBusy(true);
    try {
      const res = await saveCourierDispatch({
        id: form.id,
        dispatchDate: textToIso(form.dateText),
        courierCompany: form.courierCompany,
        trackingNo: form.trackingNo,
        partyName: form.partyName,
        remarks: form.remarks,
        attachmentPath: form.attachmentPath,
        attachmentName: form.attachmentName,
        items: validItems,
      });
      if (res.ok) {
        toast({ title: `${res.dispatchNo} saved` });
        setOpen(false);
        router.refresh();
      } else toast({ variant: "destructive", title: "Save failed", description: res.error });
    } finally {
      setBusy(false);
    }
  };

  const remove = React.useCallback(async (row: CourierDispatchRow) => {
    if (!confirm(`Delete courier dispatch ${row.dispatchNo}?`)) return;
    const res = await deleteCourierDispatch(row.id);
    if (res.ok) {
      toast({ title: `${row.dispatchNo} deleted` });
      router.refresh();
    } else toast({ variant: "destructive", title: "Delete failed", description: res.error });
  }, [router, toast]);

  const columns: ColumnDef<CourierDispatchRow>[] = React.useMemo(() => [
    { accessorKey: "dispatchNo", header: "Dispatch No" },
    {
      accessorKey: "dispatchDate",
      header: "Date",
      cell: ({ row }) => formatDate(row.original.dispatchDate),
    },
    { accessorKey: "courierCompany", header: "Courier Company" },
    { accessorKey: "trackingNo", header: "Tracking / AWB" },
    { accessorKey: "partyName", header: "Party" },
    {
      id: "vehicles",
      header: "Vehicles / Documents",
      cell: ({ row }) => (
        <div className="flex max-w-md flex-wrap gap-1">
          {row.original.items.map((it, i) => (
            <Badge key={i} variant="outline" className="font-normal">
              {it.vehicleNo} — {it.documentDetails}
            </Badge>
          ))}
        </div>
      ),
    },
    { accessorKey: "remarks", header: "Remarks" },
    {
      id: "attachment",
      header: "Slip",
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
        <h1 className="text-xl font-semibold">Courier Dispatch</h1>
        <div className="flex flex-wrap gap-2">
          <ExportButton
            rows={rows.flatMap((r) =>
              r.items.length
                ? r.items.map((it) => ({ ...r, ...it }))
                : [{ ...r, vehicleNo: "", documentDetails: "" }]
            )}
            fileName="courier-dispatch-register"
            sheetName="Courier Dispatch"
            columns={[
              { header: "Dispatch No", key: "dispatchNo" },
              { header: "Date", accessor: (r) => formatDate(String(r.dispatchDate)) },
              { header: "Courier Company", key: "courierCompany" },
              { header: "Tracking / AWB", key: "trackingNo" },
              { header: "Party", key: "partyName" },
              { header: "Vehicle No", key: "vehicleNo" },
              { header: "Document Details", key: "documentDetails" },
              { header: "Dispatch Remarks", key: "remarks" },
            ]}
          />
          <Button size="sm" onClick={openNew}>
            <Plus className="h-4 w-4" /> New Dispatch
          </Button>
        </div>
      </div>
      <p className="text-sm text-muted-foreground">
        Fully manual register — nothing links to party / vehicle masters or the ledger. One
        dispatch can hold any number of vehicles; search by vehicle number finds every dispatch
        containing it.
      </p>
      <FilterBar
        filters={[
          { type: "text", key: "q", label: "Dispatch / Company / AWB / Party..." },
          { type: "text", key: "vehicle", label: "Vehicle Number..." },
          { type: "daterange", key: "date", label: "Dispatch Date" },
        ]}
      />
      <DataTable
        columns={columns}
        data={rows}
        emptyMessage="No courier dispatches yet."
        onRowClick={(row) => openEdit(row)}
      />

      <input
        ref={fileRef}
        type="file"
        accept=".pdf,.jpg,.jpeg,.png,application/pdf,image/jpeg,image/png"
        className="hidden"
        onChange={(e) => void uploadSlip(e.target.files?.[0] ?? null)}
      />

      {/* entry dialog */}
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-h-[92vh] overflow-y-auto sm:max-w-3xl">
          <DialogHeader>
            <DialogTitle>
              {form.id ? "Edit" : "New"} Courier Dispatch
              {form.id ? "" : " — dispatch number auto-generates on save"}
            </DialogTitle>
            <DialogDescription>
              All fields are manual entry. Add one row per vehicle — a single courier can carry
              documents for any number of vehicles.
            </DialogDescription>
          </DialogHeader>
          <div className="grid gap-3 sm:grid-cols-3">
            <div className="space-y-1">
              <Label className="text-xs">Dispatch Date *</Label>
              <DateInput
                className="h-8"
                value={form.dateText}
                onChange={(t) => set({ dateText: t })}
              />
            </div>
            <div className="space-y-1">
              <Label className="text-xs">Courier Company *</Label>
              <Input
                className="h-8"
                placeholder="e.g. DTDC / Blue Dart"
                value={form.courierCompany}
                onChange={(e) => set({ courierCompany: e.target.value })}
              />
            </div>
            <div className="space-y-1">
              <Label className="text-xs">Tracking / AWB No</Label>
              <Input
                className="h-8"
                value={form.trackingNo}
                onChange={(e) => set({ trackingNo: e.target.value })}
              />
            </div>
            <div className="space-y-1 sm:col-span-2">
              <Label className="text-xs">Party Name *</Label>
              <Input
                className="h-8"
                placeholder="Manual entry — no master lookup"
                value={form.partyName}
                onChange={(e) => set({ partyName: e.target.value })}
              />
            </div>
            <div className="space-y-1">
              <Label className="text-xs">Remarks</Label>
              <Input
                className="h-8"
                value={form.remarks}
                onChange={(e) => set({ remarks: e.target.value })}
              />
            </div>
          </div>

          {/* vehicle / document grid */}
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <Label className="text-xs font-medium">
                Vehicle &amp; Document Details ({validItems.length} row
                {validItems.length === 1 ? "" : "s"})
              </Label>
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="h-7"
                onClick={() => set({ items: [...form.items, { ...emptyItem }] })}
              >
                <Plus className="h-3 w-3" /> Add Vehicle
              </Button>
            </div>
            <div className="space-y-1">
              <div className="grid grid-cols-[1fr_1fr_1fr_2rem] gap-1 text-[11px] font-medium text-muted-foreground">
                <span>Vehicle Number *</span>
                <span>Document Details *</span>
                <span>Remarks</span>
                <span />
              </div>
              {form.items.map((it, i) => (
                <div key={i} className="grid grid-cols-[1fr_1fr_1fr_2rem] gap-1">
                  <Input
                    className="h-8 uppercase"
                    placeholder="MH12AB1234"
                    value={it.vehicleNo}
                    onChange={(e) => setItem(i, { vehicleNo: e.target.value })}
                  />
                  <Input
                    className="h-8"
                    placeholder="Receiving Copy / POD / Bill..."
                    value={it.documentDetails}
                    onChange={(e) => setItem(i, { documentDetails: e.target.value })}
                  />
                  <Input
                    className="h-8"
                    value={it.remarks}
                    onChange={(e) => setItem(i, { remarks: e.target.value })}
                  />
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="h-8 w-8 p-0 text-destructive"
                    disabled={form.items.length === 1}
                    onClick={() =>
                      set({ items: form.items.filter((_, idx) => idx !== i) })
                    }
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </Button>
                </div>
              ))}
            </div>
          </div>

          <div className="space-y-1">
            <Label className="text-xs">Courier Slip / Receipt (PDF / JPG / PNG)</Label>
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

          <DialogFooter>
            <Button variant="outline" onClick={() => setOpen(false)} disabled={busy}>
              Cancel
            </Button>
            <Button
              onClick={submit}
              disabled={
                busy ||
                !form.courierCompany.trim() ||
                !form.partyName.trim() ||
                validItems.length === 0
              }
            >
              {busy ? "Saving..." : form.id ? "Update Dispatch" : "Save Dispatch"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
