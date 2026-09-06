"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { formatDate } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
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
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Textarea } from "@/components/ui/textarea";
import { useToast } from "@/components/ui/use-toast";
import { DateInput } from "@/components/data/date-input";
import { MasterCombobox, type MasterOption } from "@/components/data/master-combobox";
import { VehicleCreateDialog as VehicleInlineDialog } from "@/components/masters/inline-dialogs";
import {
  findLrForPod,
  getVehiclePendingPodLrs,
  savePodBatch,
  type PodPendingLr,
} from "@/app/(app)/pod/actions";

const SOURCE_TYPES = [
  { value: "BOOKING", label: "Booking" },
  { value: "OUTWARD_CROSSING", label: "Outward Crossing" },
  { value: "CROSSING_CHALLAN", label: "Crossing Challan" },
  { value: "GATE_PASS", label: "Gate Pass" },
  { value: "BROKER_SLIP", label: "Broker Slip" },
] as const;

const MAX_SIZE = 10 * 1024 * 1024;

interface LineState {
  unloadDateText: string;
  unloadDate: string | null;
  ackNo: string;
  recWt: string;
  poNumber: string;
  gateEntryNo: string;
  remarks: string;
  filePath: string | null;
  fileSize: number;
  fileName: string;
  uploading: boolean;
}

const emptyLine = (): LineState => ({
  unloadDateText: "",
  unloadDate: null,
  ackNo: "",
  recWt: "",
  poNumber: "",
  gateEntryNo: "",
  remarks: "",
  filePath: null,
  fileSize: 0,
  fileName: "",
  uploading: false,
});

interface PodFormProps {
  defaultDocNo: string;
  vehicleOptions: MasterOption[];
  initialVehicleId?: string | null;
}

export function PodForm({ defaultDocNo, vehicleOptions: initialVehicles, initialVehicleId }: PodFormProps) {
  const router = useRouter();
  const { toast } = useToast();

  const [docNo, setDocNo] = React.useState(defaultDocNo);
  const [docDateText, setDocDateText] = React.useState(formatDate(new Date()));
  const [docDate, setDocDate] = React.useState<Date | null>(new Date());
  const [sourceType, setSourceType] = React.useState<string>("BOOKING");
  const [vehicleOptions, setVehicleOptions] = React.useState(initialVehicles);
  const [vehicleId, setVehicleId] = React.useState<string | null>(initialVehicleId ?? null);
  const [refNo, setRefNo] = React.useState("");


  const [pendingLrs, setPendingLrs] = React.useState<PodPendingLr[]>([]);
  const [loadingLrs, setLoadingLrs] = React.useState(false);
  const [selected, setSelected] = React.useState<Record<string, boolean>>({});
  const [lines, setLines] = React.useState<Record<string, LineState>>({});

  const [manualLrNo, setManualLrNo] = React.useState("");
  const [warnDialog, setWarnDialog] = React.useState<string | null>(null);
  const [saving, setSaving] = React.useState(false);

  React.useEffect(() => {
    if (initialVehicleId) void loadVehicleLrs(initialVehicleId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialVehicleId]);

  const loadVehicleLrs = React.useCallback(async (vid: string) => {
    setLoadingLrs(true);
    try {
      const lrs = await getVehiclePendingPodLrs(vid);
      setPendingLrs(lrs);
      setSelected({});
    } finally {
      setLoadingLrs(false);
    }
  }, []);

  const handleVehicleChange = (v: string | null) => {
    setVehicleId(v);
    if (v) void loadVehicleLrs(v);
    else setPendingLrs([]);
  };

  const addManualLr = async () => {
    const no = manualLrNo.trim();
    if (!no) return;
    const res = await findLrForPod(no);
    if (!res.ok) {
      if (res.alreadyPoded) setWarnDialog(res.error);
      else toast({ variant: "destructive", title: "LR not added", description: res.error });
      return;
    }
    setPendingLrs((prev) =>
      prev.some((l) => l.id === res.lr.id) ? prev : [...prev, res.lr]
    );
    setSelected((prev) => ({ ...prev, [res.lr.id]: true }));
    setManualLrNo("");
  };

  const toggle = (id: string, on: boolean) => {
    setSelected((prev) => ({ ...prev, [id]: on }));
    if (on) setLines((prev) => (prev[id] ? prev : { ...prev, [id]: emptyLine() }));
  };

  const setLine = (id: string, patch: Partial<LineState>) =>
    setLines((prev) => ({ ...prev, [id]: { ...(prev[id] ?? emptyLine()), ...patch } }));

  const handleFile = async (lrId: string, file: File | null) => {
    if (!file) return;
    if (file.size > MAX_SIZE) {
      toast({
        variant: "destructive",
        title: "File too large",
        description: `POD file must be at most 10 MB. This file is ${(file.size / (1024 * 1024)).toFixed(2)} MB.`,
      });
      return;
    }
    setLine(lrId, { uploading: true });
    try {
      const fd = new FormData();
      fd.append("file", file);
      const res = await fetch("/api/uploads/pod", { method: "POST", body: fd });
      const json = await res.json();
      if (!res.ok || !json.ok) throw new Error(json.error ?? "Upload failed");
      setLine(lrId, {
        filePath: json.path,
        fileSize: json.size,
        fileName: file.name,
        uploading: false,
      });
    } catch (err) {
      setLine(lrId, { uploading: false });
      toast({
        variant: "destructive",
        title: "Upload failed",
        description: err instanceof Error ? err.message : "Unknown error",
      });
    }
  };

  const selectedLrs = pendingLrs.filter((l) => selected[l.id]);

  const handleSave = async () => {
    if (!docNo.trim()) {
      toast({ variant: "destructive", title: "Document number is required" });
      return;
    }
    if (!docDate) {
      toast({ variant: "destructive", title: "Document date is required" });
      return;
    }
    if (selectedLrs.length === 0) {
      toast({ variant: "destructive", title: "Select at least one LR" });
      return;
    }
    // attachment is optional — PODs can be completed without a document
    setSaving(true);
    try {
      const res = await savePodBatch({
        docNo: docNo.trim(),
        docDate: docDate.toISOString(),
        sourceType,
        vehicleId,
        refNo: refNo || undefined,
        lines: selectedLrs.map((lr) => {
          const line = lines[lr.id];
          return {
            lrId: lr.id,
            unloadDate: line.unloadDate,
            ackNo: line.ackNo || undefined,
            recWt: line.recWt === "" ? null : parseFloat(line.recWt),
            poNumber: line.poNumber || undefined,
            gateEntryNo: line.gateEntryNo || undefined,
            remarks: line.remarks || undefined,
            filePath: line.filePath || undefined,
            fileSize: line.filePath ? line.fileSize : undefined,
          };
        }),
      });
      if (!res.ok) {
        if (res.error.includes("already been uploaded")) setWarnDialog(res.error);
        else toast({ variant: "destructive", title: "Save failed", description: res.error });
        return;
      }
      toast({ title: "POD saved", description: `${res.ids.length} LR(s) confirmed.` });
      router.push("/pod/register");
      router.refresh();
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <CardTitle>POD Confirmation</CardTitle>
        </CardHeader>
        <CardContent className="grid grid-cols-2 gap-4 md:grid-cols-4">
          <div className="space-y-1.5">
            <Label>Doc No</Label>
            <Input value={docNo} onChange={(e) => setDocNo(e.target.value)} />
          </div>
          <div className="space-y-1.5">
            <Label>Doc Date</Label>
            <DateInput
              value={docDateText}
              onChange={(text, d) => {
                setDocDateText(text);
                setDocDate(d);
              }}
            />
          </div>
          <div className="space-y-1.5">
            <Label>Source Type</Label>
            <Select value={sourceType} onValueChange={setSourceType}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {SOURCE_TYPES.map((s) => (
                  <SelectItem key={s.value} value={s.value}>
                    {s.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label>Ref No</Label>
            <Input
              value={refNo}
              onChange={(e) => setRefNo(e.target.value)}
              placeholder="Gate pass / chalan no"
            />
          </div>
          <div className="space-y-1.5 md:col-span-2">
            <Label>Vehicle *</Label>
            <MasterCombobox
              options={vehicleOptions}
              value={vehicleId}
              onChange={handleVehicleChange}
              placeholder="Enter vehicle number to load its pending-balance LRs..."
              renderCreateDialog={(closeAndSelect) => (
                <VehicleInlineDialog
                  open
                  onOpenChange={(o) => {
                    // Cancel must close the dialog and keep the current pick
                    if (!o) closeAndSelect(vehicleId ?? "");
                  }}
                  onCreated={(o) => {
                    setVehicleOptions((prev) => [...prev, o]);
                    closeAndSelect(o.value);
                  }}
                />
              )}
            />
          </div>
          <div className="space-y-1.5 md:col-span-2">
            <Label>Add LR manually</Label>
            <div className="flex flex-wrap gap-2">
              <Input
                value={manualLrNo}
                onChange={(e) => setManualLrNo(e.target.value)}
                placeholder="Enter LR number"
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    void addManualLr();
                  }
                }}
              />
              <Button type="button" variant="secondary" onClick={() => void addManualLr()}>
                Add
              </Button>
            </div>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>
            LRs pending POD {loadingLrs && <span className="text-sm font-normal">loading...</span>}
          </CardTitle>
        </CardHeader>
        <CardContent className="overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-8"></TableHead>
                <TableHead>LR No</TableHead>
                <TableHead>Date</TableHead>
                <TableHead>Source</TableHead>
                <TableHead>Dest</TableHead>
                <TableHead>Billed Party</TableHead>
                <TableHead>Cargo Type</TableHead>
                <TableHead className="text-right">Qty</TableHead>
                <TableHead className="text-right">Actual Wt</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {pendingLrs.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={9} className="h-16 text-center text-muted-foreground">
                    Select a vehicle or add an LR manually.
                  </TableCell>
                </TableRow>
              ) : (
                pendingLrs.map((lr) => (
                  <TableRow key={lr.id}>
                    <TableCell>
                      <Checkbox
                        checked={!!selected[lr.id]}
                        onCheckedChange={(v) => toggle(lr.id, v === true)}
                      />
                    </TableCell>
                    <TableCell>{lr.lrNo}</TableCell>
                    <TableCell>{formatDate(lr.lrDate)}</TableCell>
                    <TableCell>{lr.source}</TableCell>
                    <TableCell>{lr.dest}</TableCell>
                    <TableCell>{lr.billedParty}</TableCell>
                    <TableCell>
                      <Badge variant={lr.cargoType === "ODC" ? "destructive" : "secondary"}>
                        {lr.cargoType === "ODC" ? "ODC" : "Normal"}
                      </Badge>
                    </TableCell>
                    <TableCell className="text-right tabular-nums">{lr.qty}</TableCell>
                    <TableCell className="text-right tabular-nums">{lr.actualWt}</TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      {selectedLrs.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle>POD details ({selectedLrs.length} LR selected)</CardTitle>
          </CardHeader>
          <CardContent className="space-y-6">
            {selectedLrs.map((lr) => {
              const line = lines[lr.id] ?? emptyLine();
              const recWt = line.recWt === "" ? null : parseFloat(line.recWt);
              const shortage =
                recWt === null || isNaN(recWt)
                  ? null
                  : Math.round((lr.actualWt - recWt) * 1000) / 1000;
              return (
                <div key={lr.id} className="rounded-md border p-4">
                  <div className="mb-3 flex items-center justify-between">
                    <div className="font-medium">
                      LR {lr.lrNo} — {lr.source} → {lr.dest}
                    </div>
                    <div className="text-sm text-muted-foreground">
                      Actual Wt: {lr.actualWt}
                    </div>
                  </div>
                  <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
                    <div className="space-y-1.5">
                      <Label>Unload Date</Label>
                      <DateInput
                        value={line.unloadDateText}
                        onChange={(text, d) =>
                          setLine(lr.id, {
                            unloadDateText: text,
                            unloadDate: d ? d.toISOString() : null,
                          })
                        }
                      />
                    </div>
                    <div className="space-y-1.5">
                      <Label>Ack No</Label>
                      <Input
                        value={line.ackNo}
                        onChange={(e) => setLine(lr.id, { ackNo: e.target.value })}
                      />
                    </div>
                    <div className="space-y-1.5">
                      <Label>Rec Wt</Label>
                      <Input
                        type="number"
                        value={line.recWt}
                        onChange={(e) => setLine(lr.id, { recWt: e.target.value })}
                      />
                    </div>
                    <div className="space-y-1.5">
                      <Label>Shortage Wt</Label>
                      <Input value={shortage === null ? "" : String(shortage)} readOnly disabled />
                    </div>
                    <div className="space-y-1.5">
                      <Label>PO Number</Label>
                      <Input
                        value={line.poNumber}
                        onChange={(e) => setLine(lr.id, { poNumber: e.target.value })}
                      />
                    </div>
                    <div className="space-y-1.5">
                      <Label>Gate Entry Number</Label>
                      <Input
                        value={line.gateEntryNo}
                        onChange={(e) => setLine(lr.id, { gateEntryNo: e.target.value })}
                      />
                    </div>
                    <div className="space-y-1.5 col-span-2">
                      <Label>Remarks</Label>
                      <Textarea
                        rows={1}
                        value={line.remarks}
                        onChange={(e) => setLine(lr.id, { remarks: e.target.value })}
                      />
                    </div>
                    <div className="space-y-1.5 col-span-2 md:col-span-4">
                      <Label>POD File (pdf / jpg / png, max 10 MB — optional)</Label>
                      <div className="flex items-center gap-3">
                        <Input
                          type="file"
                          accept=".pdf,.jpg,.jpeg,.png,application/pdf,image/jpeg,image/png"
                          onChange={(e) => void handleFile(lr.id, e.target.files?.[0] ?? null)}
                        />
                        {line.uploading && (
                          <span className="text-sm text-muted-foreground">Uploading...</span>
                        )}
                        {line.filePath && !line.uploading && (
                          <span className="text-sm text-green-600">
                            {line.fileName} ({(line.fileSize / (1024 * 1024)).toFixed(2)} MB)
                          </span>
                        )}
                      </div>
                    </div>
                  </div>
                </div>
              );
            })}
          </CardContent>
        </Card>
      )}

      <div className="flex flex-wrap justify-end gap-2">
        <Button onClick={() => void handleSave()} disabled={saving || selectedLrs.length === 0}>
          {saving ? "Saving..." : "Save POD"}
        </Button>
      </div>

      <Dialog open={!!warnDialog} onOpenChange={(o) => !o && setWarnDialog(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>POD already exists</DialogTitle>
            <DialogDescription>{warnDialog}</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button onClick={() => setWarnDialog(null)}>OK</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
