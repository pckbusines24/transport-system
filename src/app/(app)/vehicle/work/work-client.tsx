"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { Pencil, Plus, Trash2 } from "lucide-react";
import { formatDate, parseDdMmYyyy } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { InfoHint } from "@/components/ui/info-hint";
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
import { Textarea } from "@/components/ui/textarea";
import { useToast } from "@/components/ui/use-toast";
import { DateInput } from "@/components/data/date-input";
import { MasterCombobox, type MasterOption } from "@/components/data/master-combobox";
import { VehicleCombobox } from "@/components/fleet/fields";
import { deleteVehicleWork, saveVehicleWork } from "./actions";

/**
 * Extra Work Information — tracking only, no accounting. Status is derived:
 * Complete Date filled => Completed, blank => Pending. No manual status field.
 */

export interface WorkRow {
  id: string;
  workDate: string;
  vehicleId: string;
  vehicle: string;
  description: string;
  supplier: string;
  completeDate: string | null;
  remarks: string;
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
  vehicleId: null as string | null,
  description: "",
  supplier: "",
  completeText: "",
  remarks: "",
};

export function WorkEntryClient({
  rows,
  vehicles,
  canDelete,
}: {
  rows: WorkRow[];
  vehicles: MasterOption[];
  canDelete: boolean;
}) {
  const router = useRouter();
  const { toast } = useToast();
  const [busy, setBusy] = React.useState(false);
  const [open, setOpen] = React.useState(false);
  const [form, setForm] = React.useState(emptyForm);

  // register filters
  const [vehicleFilter, setVehicleFilter] = React.useState<string | null>(null);
  const [status, setStatus] = React.useState<"ALL" | "PENDING" | "COMPLETED">("ALL");
  const [q, setQ] = React.useState("");

  const filtered = rows.filter((r) => {
    if (vehicleFilter && r.vehicleId !== vehicleFilter) return false;
    const done = !!r.completeDate;
    if (status === "PENDING" && done) return false;
    if (status === "COMPLETED" && !done) return false;
    if (q) {
      const needle = q.toLowerCase();
      if (
        !r.description.toLowerCase().includes(needle) &&
        !r.supplier.toLowerCase().includes(needle) &&
        !r.vehicle.toLowerCase().includes(needle)
      )
        return false;
    }
    return true;
  });
  const pendingCount = rows.filter((r) => !r.completeDate).length;

  const openNew = () => {
    setForm(emptyForm);
    setOpen(true);
  };
  const openEdit = (r: WorkRow) => {
    setForm({
      id: r.id,
      dateText: formatDate(r.workDate),
      vehicleId: r.vehicleId,
      description: r.description,
      supplier: r.supplier,
      completeText: r.completeDate ? formatDate(r.completeDate) : "",
      remarks: r.remarks,
    });
    setOpen(true);
  };

  const submit = async () => {
    setBusy(true);
    try {
      const res = await saveVehicleWork({
        id: form.id,
        workDate: textToIso(form.dateText),
        vehicleId: form.vehicleId ?? "",
        description: form.description,
        supplier: form.supplier,
        completeDate: form.completeText ? textToIso(form.completeText) : null,
        remarks: form.remarks,
      });
      if (res.ok) {
        toast({
          title: form.id ? "Work entry updated" : "Work entry saved",
          description: form.completeText ? "Status: Completed" : "Status: Pending",
        });
        setOpen(false);
        router.refresh();
      } else toast({ variant: "destructive", title: res.error });
    } finally {
      setBusy(false);
    }
  };

  const remove = async (r: WorkRow) => {
    if (!window.confirm(`Delete this work entry for ${r.vehicle}?`)) return;
    const res = await deleteVehicleWork(r.id);
    if (res.ok) {
      toast({ title: "Work entry deleted" });
      router.refresh();
    } else toast({ variant: "destructive", title: res.error });
  };

  return (
    <div className="space-y-4 p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h1 className="page-title flex items-center gap-2">
            Extra Work Information
            <InfoHint>
              Vehicle work tracking only — nothing here touches accounts or ledgers.
            </InfoHint>
          </h1>
          {pendingCount > 0 && (
            <p className="text-sm text-muted-foreground">{pendingCount} pending.</p>
          )}
        </div>
        <Button onClick={openNew}>
          <Plus className="h-4 w-4" /> New Work Entry
        </Button>
      </div>

      {/* filters */}
      <div className="flex flex-wrap items-center gap-2">
        <div className="w-44">
          <MasterCombobox options={vehicles} value={vehicleFilter} onChange={setVehicleFilter} placeholder="Vehicle..." />
        </div>
        {(["ALL", "PENDING", "COMPLETED"] as const).map((s) => (
          <Button
            key={s}
            size="sm"
            variant={status === s ? "default" : "outline"}
            className="h-8 text-xs"
            onClick={() => setStatus(s)}
          >
            {s === "ALL" ? "All" : s === "PENDING" ? "Pending" : "Completed"}
          </Button>
        ))}
        <div className="w-56">
          <Input className="h-8" placeholder="Search work / supplier / vehicle..." value={q} onChange={(e) => setQ(e.target.value)} />
        </div>
      </div>

      {/* register */}
      <div className="overflow-x-auto rounded-md border">
        <table className="w-full text-sm">
          <thead className="bg-muted/80">
            <tr>
              {["Work Date", "Vehicle", "Work Description", "Supplier", "Complete Date", "Status", "Remarks", ""].map((h) => (
                <th key={h} className="whitespace-nowrap px-2 py-1.5 text-left text-xs font-medium text-muted-foreground">
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {filtered.length === 0 ? (
              <tr>
                <td colSpan={8} className="h-20 text-center text-muted-foreground">
                  No work entries yet — use New Work Entry.
                </td>
              </tr>
            ) : (
              filtered.map((r) => (
                <tr key={r.id} className="border-t align-top hover:bg-muted/40">
                  <td className="whitespace-nowrap px-2 py-1.5">{formatDate(r.workDate)}</td>
                  <td className="whitespace-nowrap px-2 py-1.5 font-medium">{r.vehicle}</td>
                  <td className="min-w-[16rem] max-w-[28rem] whitespace-pre-wrap px-2 py-1.5">{r.description}</td>
                  <td className="whitespace-nowrap px-2 py-1.5">{r.supplier || "—"}</td>
                  <td className="whitespace-nowrap px-2 py-1.5">
                    {r.completeDate ? formatDate(r.completeDate) : "—"}
                  </td>
                  <td className="whitespace-nowrap px-2 py-1.5">
                    {r.completeDate ? <Badge>Completed</Badge> : <Badge variant="destructive">Pending</Badge>}
                  </td>
                  <td className="min-w-[10rem] max-w-[20rem] whitespace-pre-wrap px-2 py-1.5 text-muted-foreground">
                    {r.remarks || ""}
                  </td>
                  <td className="whitespace-nowrap px-2 py-1.5">
                    <div className="flex gap-1">
                      <Button variant="ghost" size="icon" className="h-7 w-7" title="Edit" onClick={() => openEdit(r)}>
                        <Pencil className="h-3.5 w-3.5" />
                      </Button>
                      {canDelete && (
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-7 w-7 text-destructive"
                          title="Delete"
                          onClick={() => void remove(r)}
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </Button>
                      )}
                    </div>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      {/* entry dialog */}
      <Dialog open={open} onOpenChange={(o) => !o && setOpen(false)}>
        <DialogContent className="max-h-[92vh] overflow-y-auto sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>{form.id ? "Edit Work Entry" : "New Work Entry"}</DialogTitle>
            <DialogDescription>
              Enter a Complete Date and the status becomes Completed automatically — leave it
              blank while the work is pending.
            </DialogDescription>
          </DialogHeader>
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1">
              <Label className="text-xs">Work Date *</Label>
              <DateInput className="h-9" value={form.dateText} onChange={(t) => setForm((f) => ({ ...f, dateText: t }))} />
            </div>
            <div className="space-y-1">
              <Label className="text-xs">Vehicle Number *</Label>
              <VehicleCombobox
                options={vehicles}
                value={form.vehicleId}
                onChange={(v) => setForm((f) => ({ ...f, vehicleId: v }))}
                placeholder="Select vehicle..."
              />
            </div>
            <div className="space-y-1 sm:col-span-2">
              <Label className="text-xs">Detailed Description of the Work *</Label>
              <Textarea
                rows={4}
                placeholder="e.g. Engine overhaul and oil leakage repair; front tyres replacement..."
                value={form.description}
                onChange={(e) => setForm((f) => ({ ...f, description: e.target.value }))}
              />
            </div>
            <div className="space-y-1">
              <Label className="text-xs">Supplier (workshop / mechanic)</Label>
              <Input
                className="h-9"
                placeholder="e.g. Sharma Garage"
                value={form.supplier}
                onChange={(e) => setForm((f) => ({ ...f, supplier: e.target.value }))}
              />
            </div>
            <div className="space-y-1">
              <Label className="text-xs">Complete Date (fills status automatically)</Label>
              <DateInput className="h-9" value={form.completeText} onChange={(t) => setForm((f) => ({ ...f, completeText: t }))} />
            </div>
            <div className="space-y-1 sm:col-span-2">
              <Label className="text-xs">Remarks / Notes</Label>
              <Textarea
                rows={3}
                placeholder="Completion remarks, parts replaced, follow-up notes..."
                value={form.remarks}
                onChange={(e) => setForm((f) => ({ ...f, remarks: e.target.value }))}
              />
            </div>
            <div className="sm:col-span-2 text-sm">
              Status:{" "}
              {form.completeText ? <Badge>Completed</Badge> : <Badge variant="destructive">Pending</Badge>}
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setOpen(false)} disabled={busy}>
              Cancel
            </Button>
            <Button onClick={submit} disabled={busy || !form.vehicleId || !form.description.trim() || !form.dateText}>
              {busy ? "Saving..." : form.id ? "Update Work Entry" : "Save Work Entry"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
