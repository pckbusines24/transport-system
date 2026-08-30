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
import { updatePod, deletePod } from "@/app/(app)/pod/actions";

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
}

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

  const openEdit = React.useCallback((r: PodRegisterRow) =>
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
    }), []);

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
      });
      if (res.ok) {
        toast({ title: `POD ${editing.docNo} updated` });
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
      <DataTable columns={columns} data={rows} emptyMessage="No PODs found." />

      {/* edit dialog */}
      <Dialog open={!!editing} onOpenChange={(o) => !o && setEditing(null)}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>Edit POD {editing?.docNo}</DialogTitle>
            <DialogDescription>
              The uploaded POD file is kept; only the details below change.
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
              <div className="space-y-1.5 sm:col-span-2">
                <Label className="text-xs">Remarks</Label>
                <Input
                  value={editing.remarks}
                  onChange={(e) => setEditing({ ...editing, remarks: e.target.value })}
                />
              </div>
            </div>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => setEditing(null)} disabled={busy}>
              Cancel
            </Button>
            <Button onClick={saveEdit} disabled={busy}>
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
