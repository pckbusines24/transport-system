"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import type { ColumnDef } from "@tanstack/react-table";
import { Pencil, Trash2 } from "lucide-react";
import { formatDate, parseDdMmYyyy, toNum } from "@/lib/utils";
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
import { DateInput } from "@/components/data/date-input";
import { DataTable, type DataTableColumnMeta } from "@/components/data/data-table";
import { ExportButton } from "@/components/data/export-button";
import { updatePod, deletePod, getPodGroupLrNos } from "@/app/(app)/pod/actions";

export interface PodRegisterRow {
  id: string;
  docNo: string;
  docDate: string;
  lrNo: string;
  vehicle: string;
  ackNo: string;
  unloadDate: string | null;
  poNumber: string;
  gateEntryNo: string;
  recWt: number | null;
  shortageWt: number | null;
  filePath: string | null;
  status: string;
  /** true when the LR's chalan balance payment is finalized */
  balancePaid: boolean;
  sourceType: string;
  remarks: string;
}

function num(v: number | null): string {
  return v === null ? "" : v.toLocaleString("en-IN", { maximumFractionDigits: 3 });
}

function isoToText(iso: string | null): string {
  return iso ? formatDate(new Date(iso)) : "";
}

function textToIso(text: string): string | null {
  const d = parseDdMmYyyy(text);
  if (!d) return null;
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${d.getFullYear()}-${mm}-${dd}`;
}

interface EditState {
  id: string;
  docNo: string;
  docDateText: string;
  unloadDateText: string;
  ackNo: string;
  recWt: string;
  poNumber: string;
  gateEntryNo: string;
  remarks: string;
  /** the file already on the POD */
  filePath: string | null;
  /** a file uploaded in this dialog — saved with the edit */
  newFile: { path: string; size: number; name: string } | null;
  uploading: boolean;
  /** LRs sharing this POD's Unload Date / Remark (same chalan + consignee) */
  groupLrNos: string[];
}

/** same limit as POD Confirmation and the server */
const MAX_SIZE = 10 * 1024 * 1024;

export function PodRegisterTable({
  rows,
  canDelete = false,
}: {
  rows: PodRegisterRow[];
  canDelete?: boolean;
}) {
  const router = useRouter();
  const { toast } = useToast();
  const [editing, setEditing] = React.useState<EditState | null>(null);
  const [toDelete, setToDelete] = React.useState<PodRegisterRow | null>(null);
  const [busy, setBusy] = React.useState(false);

  const openEdit = React.useCallback((r: PodRegisterRow) => {
    // the group note loads in the background; the dialog opens at once
    void getPodGroupLrNos(r.id).then((lrNos) =>
      setEditing((e) => (e && e.id === r.id ? { ...e, groupLrNos: lrNos } : e))
    );
    setEditing({
      id: r.id,
      docNo: r.docNo,
      docDateText: isoToText(r.docDate),
      unloadDateText: isoToText(r.unloadDate),
      ackNo: r.ackNo,
      recWt: r.recWt == null ? "" : String(r.recWt),
      poNumber: r.poNumber,
      gateEntryNo: r.gateEntryNo,
      remarks: r.remarks,
      filePath: r.filePath,
      newFile: null,
      uploading: false,
      groupLrNos: [],
    });
  }, []);

  // upload straight away (like POD Confirmation); the POD row changes on Save
  const handleFile = async (file: File | null) => {
    if (!file) return;
    if (file.size > MAX_SIZE) {
      toast({
        variant: "destructive",
        title: "File too large",
        description: `POD file must be at most 10 MB. This file is ${(file.size / (1024 * 1024)).toFixed(2)} MB.`,
      });
      return;
    }
    setEditing((e) => (e ? { ...e, uploading: true } : e));
    try {
      const fd = new FormData();
      fd.append("file", file);
      const res = await fetch("/api/uploads/pod", { method: "POST", body: fd });
      const json = await res.json();
      if (!res.ok || !json.ok) throw new Error(json.error ?? "Upload failed");
      setEditing((e) =>
        e ? { ...e, uploading: false, newFile: { path: json.path, size: json.size, name: file.name } } : e
      );
    } catch (err) {
      setEditing((e) => (e ? { ...e, uploading: false } : e));
      toast({
        variant: "destructive",
        title: "Upload failed",
        description: err instanceof Error ? err.message : "Unknown error",
      });
    }
  };

  const saveEdit = async () => {
    if (!editing) return;
    const docDateIso = textToIso(editing.docDateText);
    if (!docDateIso) {
      toast({ variant: "destructive", title: "Valid document date is required" });
      return;
    }
    setBusy(true);
    try {
      const res = await updatePod({
        id: editing.id,
        docDate: docDateIso,
        unloadDate: textToIso(editing.unloadDateText),
        ackNo: editing.ackNo,
        recWt: editing.recWt === "" ? null : toNum(editing.recWt),
        poNumber: editing.poNumber,
        gateEntryNo: editing.gateEntryNo,
        remarks: editing.remarks,
        ...(editing.newFile ? { filePath: editing.newFile.path, fileSize: editing.newFile.size } : {}),
      });
      if (res.ok) {
        toast({
          title: `POD ${editing.docNo} updated`,
          description: res.syncedLrNos.length
            ? `Unload Date / Remarks also updated on LR ${res.syncedLrNos.join(", ")}.`
            : undefined,
        });
        setEditing(null);
        router.refresh();
      } else {
        toast({ variant: "destructive", title: "Update failed", description: res.error });
      }
    } finally {
      setBusy(false);
    }
  };

  const confirmDelete = async () => {
    if (!toDelete) return;
    setBusy(true);
    try {
      const res = await deletePod(toDelete.id);
      if (res.ok) {
        toast({
          title: `POD ${toDelete.docNo} deleted`,
          description: `LR ${toDelete.lrNo} is back to ON CHALAN — a new POD can be uploaded.`,
        });
        setToDelete(null);
        router.refresh();
      } else {
        toast({ variant: "destructive", title: "Delete failed", description: res.error });
      }
    } finally {
      setBusy(false);
    }
  };

  const columns: ColumnDef<PodRegisterRow>[] = React.useMemo(() => [
    { accessorKey: "docNo", header: "Doc No" },
    {
      accessorKey: "docDate",
      header: "Date",
      cell: ({ row }) => formatDate(row.original.docDate),
    },
    { accessorKey: "lrNo", header: "LR No" },
    { accessorKey: "vehicle", header: "Vehicle" },
    { accessorKey: "ackNo", header: "Ack No" },
    {
      accessorKey: "unloadDate",
      header: "Unload Date",
      cell: ({ row }) => formatDate(row.original.unloadDate),
    },
    { accessorKey: "poNumber", header: "PO No" },
    { accessorKey: "gateEntryNo", header: "Gate Entry" },
    {
      accessorKey: "recWt",
      header: "Rec Wt",
      cell: ({ row }) => num(row.original.recWt),
      meta: {
        numeric: true,
        total: (rs) => num(rs.reduce((s, r) => s + (r.recWt ?? 0), 0)),
      } satisfies DataTableColumnMeta<PodRegisterRow>,
    },
    {
      accessorKey: "shortageWt",
      header: "Shortage",
      cell: ({ row }) => num(row.original.shortageWt),
      meta: {
        numeric: true,
        total: (rs) => num(rs.reduce((s, r) => s + (r.shortageWt ?? 0), 0)),
      } satisfies DataTableColumnMeta<PodRegisterRow>,
    },
    {
      id: "file",
      header: "File",
      cell: ({ row }) =>
        row.original.filePath ? (
          <a
            href={`/api/uploads/${row.original.filePath}`}
            target="_blank"
            rel="noreferrer"
            className="text-primary underline"
            onClick={(e) => e.stopPropagation()}
          >
            View
          </a>
        ) : null,
    },
    {
      accessorKey: "status",
      header: "Status",
      cell: ({ row }) => (
        <Badge variant={row.original.status === "COMPLETED" ? "default" : "secondary"}>
          {row.original.status}
        </Badge>
      ),
    },
    {
      accessorKey: "balancePaid",
      header: "Balance Payment",
      cell: ({ row }) =>
        row.original.balancePaid ? (
          <Badge>Paid</Badge>
        ) : (
          <Badge variant="destructive">Pending</Badge>
        ),
    },
    {
      id: "actions",
      header: "",
      enableSorting: false,
      cell: ({ row }) => (
        <div className="flex items-center gap-1" onClick={(e) => e.stopPropagation()}>
          <Button
            variant="ghost"
            size="icon"
            className="h-7 w-7"
            title="Edit POD"
            onClick={() => openEdit(row.original)}
          >
            <Pencil className="h-3.5 w-3.5" />
          </Button>
          {canDelete && (
            <Button
              variant="ghost"
              size="icon"
              className="h-7 w-7 text-destructive"
              title="Delete POD"
              onClick={() => setToDelete(row.original)}
            >
              <Trash2 className="h-3.5 w-3.5" />
            </Button>
          )}
        </div>
      ),
    },
  ], [canDelete, openEdit]);

  return (
    <div className="space-y-2">
      <div className="flex justify-end">
        <ExportButton
          rows={rows}
          fileName="pod-register"
          sheetName="POD Register"
          columns={[
            { header: "Doc No", key: "docNo" },
            { header: "Date", accessor: (r) => formatDate(r.docDate) },
            { header: "LR No", key: "lrNo" },
            { header: "Vehicle", key: "vehicle" },
            { header: "Ack No", key: "ackNo" },
            { header: "Unload Date", accessor: (r) => formatDate(r.unloadDate) },
            { header: "PO No", key: "poNumber" },
            { header: "Gate Entry", key: "gateEntryNo" },
            { header: "Rec Wt", accessor: (r) => r.recWt ?? "", numeric: true },
            { header: "Shortage", accessor: (r) => r.shortageWt ?? "", numeric: true },
            { header: "Status", key: "status" },
            { header: "Remarks", key: "remarks" },
          ]}
        />
      </div>
      <DataTable fillViewport showCount={false} columns={columns} data={rows} emptyMessage="No PODs found." />

      {/* edit dialog */}
      <Dialog open={!!editing} onOpenChange={(o) => !o && setEditing(null)}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>Edit POD {editing?.docNo}</DialogTitle>
            <DialogDescription>
              Change the details below, or upload the POD file if it was missed.
            </DialogDescription>
          </DialogHeader>
          {editing && (
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="space-y-1.5">
                <Label className="text-xs">Document Date *</Label>
                <DateInput
                  value={editing.docDateText}
                  onChange={(t) => setEditing({ ...editing, docDateText: t })}
                />
              </div>
              <div className="space-y-1.5">
                <Label className="text-xs">Unload Date</Label>
                <DateInput
                  value={editing.unloadDateText}
                  onChange={(t) => setEditing({ ...editing, unloadDateText: t })}
                />
              </div>
              <div className="space-y-1.5">
                <Label className="text-xs">Ack No</Label>
                <Input
                  value={editing.ackNo}
                  onChange={(e) => setEditing({ ...editing, ackNo: e.target.value })}
                />
              </div>
              <div className="space-y-1.5">
                <Label className="text-xs">Received Wt</Label>
                <Input
                  type="number"
                  inputMode="decimal"
                  className="text-right"
                  value={editing.recWt}
                  onChange={(e) => setEditing({ ...editing, recWt: e.target.value })}
                />
              </div>
              <div className="space-y-1.5">
                <Label className="text-xs">PO Number</Label>
                <Input
                  value={editing.poNumber}
                  onChange={(e) => setEditing({ ...editing, poNumber: e.target.value })}
                />
              </div>
              <div className="space-y-1.5">
                <Label className="text-xs">Gate Entry No</Label>
                <Input
                  value={editing.gateEntryNo}
                  onChange={(e) => setEditing({ ...editing, gateEntryNo: e.target.value })}
                />
              </div>
              {editing.groupLrNos.length > 0 && (
                <div className="rounded-md border border-amber-500/60 bg-amber-50 px-2 py-1 text-xs dark:bg-amber-950/30 sm:col-span-2">
                  Same chalan &amp; consignee as LR {editing.groupLrNos.join(", ")} — Unload Date and Remarks
                  will also update there.
                </div>
              )}
              <div className="space-y-1.5 sm:col-span-2">
                <Label className="text-xs">Remarks</Label>
                <Input
                  value={editing.remarks}
                  onChange={(e) => setEditing({ ...editing, remarks: e.target.value })}
                />
              </div>
              <div className="space-y-1.5 sm:col-span-2">
                <Label className="text-xs">
                  {editing.filePath ? "Replace POD File" : "Upload POD File"} (pdf / jpg / png, max 10 MB)
                </Label>
                {editing.filePath && !editing.newFile && (
                  <div className="text-xs">
                    Current file:{" "}
                    <a
                      href={`/api/uploads/${editing.filePath}`}
                      target="_blank"
                      rel="noreferrer"
                      className="text-primary underline"
                    >
                      View
                    </a>
                  </div>
                )}
                <Input
                  type="file"
                  accept=".pdf,.jpg,.jpeg,.png,application/pdf,image/jpeg,image/png"
                  disabled={editing.uploading || busy}
                  onChange={(e) => void handleFile(e.target.files?.[0] ?? null)}
                />
                {editing.uploading && <div className="text-xs text-muted-foreground">Uploading...</div>}
                {editing.newFile && !editing.uploading && (
                  <div className="text-xs text-green-600">
                    {editing.newFile.name} ({(editing.newFile.size / (1024 * 1024)).toFixed(2)} MB) — saved with
                    the changes
                  </div>
                )}
              </div>
            </div>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => setEditing(null)} disabled={busy}>
              Cancel
            </Button>
            <Button onClick={saveEdit} disabled={busy || !!editing?.uploading}>
              {busy ? "Saving..." : "Save Changes"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* delete dialog */}
      <Dialog open={!!toDelete} onOpenChange={(o) => !o && setToDelete(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete POD {toDelete?.docNo}?</DialogTitle>
            <DialogDescription>
              LR {toDelete?.lrNo} will return to ON CHALAN status so a fresh POD can be uploaded.
              Billed LRs cannot have their POD deleted.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setToDelete(null)} disabled={busy}>
              Cancel
            </Button>
            <Button variant="destructive" onClick={confirmDelete} disabled={busy}>
              {busy ? "Deleting..." : "Delete"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
