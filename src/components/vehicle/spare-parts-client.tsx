"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import type { ColumnDef } from "@tanstack/react-table";
import { ArrowRightLeft, History, Plus, ShieldCheck, Trash2, Wrench } from "lucide-react";
import { formatDate, formatMoney, parseDdMmYyyy } from "@/lib/utils";
import {
  CLAIM_STATUS_LABEL,
  EVENT_LABEL,
  PART_STATUS_LABEL,
  WARRANTY_CLASS,
  WARRANTY_DOT,
  WARRANTY_LABEL,
  type WarrantyStatus,
} from "@/lib/spare-parts";
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
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useToast } from "@/components/ui/use-toast";
import { DataTable } from "@/components/data/data-table";
import { DateInput } from "@/components/data/date-input";
import { ExportButton } from "@/components/data/export-button";
import { MasterCombobox, type MasterOption } from "@/components/data/master-combobox";
import {
  addWarrantyClaim,
  deleteSparePart,
  installSparePart,
  markWarrantyReviewed,
  removeSparePart,
  saveSparePart,
} from "@/app/(app)/vehicle/spare-parts/actions";
import type { SparePartRow } from "./spare-parts-types";

function textToIso(text: string): string {
  const d = parseDdMmYyyy(text);
  if (!d) return "";
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${d.getFullYear()}-${mm}-${dd}`;
}

const km = (n: number | null) => (n === null ? "" : `${n.toLocaleString("en-IN")} KM`);

export function WarrantyBadge({ status, daysLeft }: { status: WarrantyStatus; daysLeft: number | null }) {
  return (
    <span
      className={`inline-flex items-center gap-1 whitespace-nowrap rounded-full px-2 py-0.5 text-xs font-medium ${WARRANTY_CLASS[status]}`}
      title={WARRANTY_LABEL[status]}
    >
      {WARRANTY_DOT[status]} {WARRANTY_LABEL[status]}
      {daysLeft !== null && status !== "NONE" && (
        <span className="opacity-80">
          {daysLeft < 0 ? `(${Math.abs(daysLeft)}d ago)` : `(${daysLeft}d)`}
        </span>
      )}
    </span>
  );
}

function Field({ label, children, span2 }: { label: string; children: React.ReactNode; span2?: boolean }) {
  return (
    <div className={span2 ? "space-y-1.5 sm:col-span-2" : "space-y-1.5"}>
      <Label className="text-xs">{label}</Label>
      {children}
    </div>
  );
}

const emptyPart = {
  name: "",
  partNumber: "",
  serialNo: "",
  brand: "",
  model: "",
  supplierName: "",
  purchaseDateText: formatDate(new Date()),
  invoiceNo: "",
  purchaseRate: "",
  warrantyApplicable: true,
  warrantyMonths: "12",
  warrantyStartText: formatDate(new Date()),
  remarks: "",
};
type PartForm = typeof emptyPart;

/** Full history of one serial number: Purchase → Installation → Vehicle → KM → Warranty → Replacement → Removal */
export function SparePartHistory({ part }: { part: SparePartRow }) {
  return (
    <div className="space-y-3 text-sm">
      <div className="grid gap-x-4 gap-y-1 rounded-md border p-3 text-xs sm:grid-cols-2">
        <div><b>Unique Serial No:</b> {part.serialNo}</div>
        <div><b>Part:</b> {part.name}{part.partNumber ? ` (${part.partNumber})` : ""}</div>
        <div><b>Brand / Model:</b> {[part.brand, part.model].filter(Boolean).join(" / ") || "—"}</div>
        <div><b>Supplier / Workshop:</b> {part.supplierName || "—"}</div>
        <div><b>Purchase Date:</b> {part.purchaseDate ? formatDate(part.purchaseDate) : "—"}{part.invoiceNo ? ` · Bill ${part.invoiceNo}` : ""}</div>
        <div><b>Purchase Rate (info):</b> {part.purchaseRate === null ? "—" : formatMoney(part.purchaseRate)}</div>
        <div><b>Status:</b> {PART_STATUS_LABEL[part.status] ?? part.status}{part.currentVehicle ? ` in ${part.currentVehicle}` : ""}</div>
        <div><b>Installed:</b> {part.installedOn ? `${formatDate(part.installedOn)} at ${km(part.installKm)}` : "—"}</div>
        <div className="sm:col-span-2 flex items-center gap-2">
          <b>Warranty:</b>
          {part.warrantyApplicable ? (
            <>
              <WarrantyBadge status={part.warranty} daysLeft={part.daysLeft} />
              <span className="text-muted-foreground">
                {part.warrantyStart ? formatDate(part.warrantyStart) : ""}
                {part.warrantyMonths ? ` + ${part.warrantyMonths} months` : ""}
                {part.warrantyExpiry ? ` → expires ${formatDate(part.warrantyExpiry)}` : ""}
              </span>
            </>
          ) : (
            <span className="text-muted-foreground">not applicable</span>
          )}
        </div>
      </div>
      <div className="overflow-x-auto rounded-md border">
        <table className="w-full border-collapse text-xs">
          <thead className="bg-muted/60">
            <tr>
              {["Date", "Event", "Vehicle", "KM Reading", "Workshop / Supplier", "Related Part", "Details"].map((h) => (
                <th key={h} className="border-b px-2 py-1 text-left font-semibold">{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {part.events.map((e) => (
              <tr key={e.id} className="border-b last:border-0">
                <td className="whitespace-nowrap px-2 py-1">{formatDate(e.date)}</td>
                <td className="whitespace-nowrap px-2 py-1 font-medium">
                  {EVENT_LABEL[e.type] ?? e.type}
                  {e.claimStatus && (
                    <Badge variant="outline" className="ml-1 text-[10px]">
                      {CLAIM_STATUS_LABEL[e.claimStatus] ?? e.claimStatus}
                    </Badge>
                  )}
                </td>
                <td className="px-2 py-1">{e.vehicle || "—"}</td>
                <td className="whitespace-nowrap px-2 py-1 tabular-nums">{km(e.km) || "—"}</td>
                <td className="px-2 py-1">{e.workshop || "—"}</td>
                <td className="px-2 py-1">{e.relatedSerial ?? "—"}</td>
                <td className="px-2 py-1">{e.remarks || "—"}</td>
              </tr>
            ))}
            {part.events.length === 0 && (
              <tr><td colSpan={7} className="px-2 py-3 text-center text-muted-foreground">No history yet.</td></tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

export function SparePartsClient({
  parts,
  vehicleOptions,
  canDelete,
  mode,
  initialQuery,
  initialStatus,
  initialWarranty,
  openPartId,
}: {
  parts: SparePartRow[];
  vehicleOptions: MasterOption[];
  canDelete: boolean;
  mode: "parts" | "warranty";
  initialQuery: string;
  initialStatus: string;
  initialWarranty: string;
  openPartId: string | null;
}) {
  const router = useRouter();
  const { toast } = useToast();

  // ---- filters (client-side: the set is small and every tab shares it) ----
  const [q, setQ] = React.useState(initialQuery);
  const [status, setStatus] = React.useState(initialStatus);
  const [warranty, setWarranty] = React.useState(initialWarranty);
  const [vehicleId, setVehicleId] = React.useState<string | null>(null);

  const rows = React.useMemo(() => {
    const needle = q.trim().toLowerCase();
    return parts.filter((p) => {
      if (needle) {
        const hay = `${p.serialNo} ${p.partNumber} ${p.name} ${p.brand} ${p.supplierName} ${p.currentVehicle}`.toLowerCase();
        if (!hay.includes(needle)) return false;
      }
      if (status && p.status !== status) return false;
      if (warranty && p.warranty !== warranty) return false;
      if (vehicleId && p.currentVehicleId !== vehicleId) return false;
      return true;
    });
  }, [parts, q, status, warranty, vehicleId]);

  // ---- dialogs ----
  const [editing, setEditing] = React.useState<{ id: string | null; form: PartForm } | null>(null);
  const [historyFor, setHistoryFor] = React.useState<SparePartRow | null>(
    () => parts.find((p) => p.id === openPartId) ?? null
  );
  const [installFor, setInstallFor] = React.useState<SparePartRow | null>(null);
  const [removeFor, setRemoveFor] = React.useState<SparePartRow | null>(null);
  const [claimFor, setClaimFor] = React.useState<SparePartRow | null>(null);
  const [busy, setBusy] = React.useState(false);

  const done = (title: string) => {
    toast({ title });
    router.refresh();
  };
  const failed = (error: string) => toast({ variant: "destructive", title: "Failed", description: error });

  const openNew = () => setEditing({ id: null, form: { ...emptyPart } });
  const openEdit = (p: SparePartRow) =>
    setEditing({
      id: p.id,
      form: {
        name: p.name,
        partNumber: p.partNumber,
        serialNo: p.serialNo,
        brand: p.brand,
        model: p.model,
        supplierName: p.supplierName,
        purchaseDateText: p.purchaseDate ? formatDate(p.purchaseDate) : "",
        invoiceNo: p.invoiceNo,
        purchaseRate: p.purchaseRate === null ? "" : String(p.purchaseRate),
        warrantyApplicable: p.warrantyApplicable,
        warrantyMonths: p.warrantyMonths === null ? "" : String(p.warrantyMonths),
        warrantyStartText: p.warrantyStart ? formatDate(p.warrantyStart) : "",
        remarks: p.remarks,
      },
    });

  const savePart = async () => {
    if (!editing) return;
    const f = editing.form;
    setBusy(true);
    try {
      const res = await saveSparePart({
        id: editing.id ?? undefined,
        name: f.name,
        partNumber: f.partNumber || null,
        serialNo: f.serialNo,
        brand: f.brand || null,
        model: f.model || null,
        supplierName: f.supplierName || null,
        purchaseDate: textToIso(f.purchaseDateText) || null,
        invoiceNo: f.invoiceNo || null,
        purchaseRate: f.purchaseRate === "" ? null : Number(f.purchaseRate),
        warrantyApplicable: f.warrantyApplicable,
        warrantyMonths: f.warrantyMonths === "" ? null : Number(f.warrantyMonths),
        warrantyStartDate: textToIso(f.warrantyStartText) || null,
        remarks: f.remarks || null,
      });
      if (res.ok) {
        setEditing(null);
        done(editing.id ? "Spare part updated" : "Spare part added");
      } else failed(res.error);
    } finally {
      setBusy(false);
    }
  };

  const removePart = async (p: SparePartRow) => {
    if (!window.confirm(`Delete spare part ${p.serialNo}? Its history will be hidden with it.`)) return;
    const res = await deleteSparePart(p.id);
    if (res.ok) done("Spare part deleted");
    else failed(res.error);
  };

  const reviewed = async (p: SparePartRow) => {
    const res = await markWarrantyReviewed(p.id);
    if (res.ok) done("Marked as reviewed");
    else failed(res.error);
  };

  // preview of the auto-computed expiry while typing
  const expiryPreview = React.useMemo(() => {
    if (!editing?.form.warrantyApplicable) return "";
    const start = parseDdMmYyyy(editing.form.warrantyStartText);
    const months = Number(editing.form.warrantyMonths);
    if (!start || !months) return "";
    const e = new Date(start);
    e.setMonth(e.getMonth() + months);
    return formatDate(e);
  }, [editing]);

  const columns: ColumnDef<SparePartRow>[] = React.useMemo(
    () => [
      {
        accessorKey: "serialNo",
        header: "Serial No",
        cell: ({ row }) => (
          <button
            type="button"
            className="font-medium text-primary underline-offset-2 hover:underline"
            onClick={(e) => {
              e.stopPropagation();
              setHistoryFor(row.original);
            }}
          >
            {row.original.serialNo}
          </button>
        ),
      },
      { accessorKey: "name", header: "Spare Part" },
      { accessorKey: "partNumber", header: "Part No" },
      { accessorKey: "brand", header: "Brand" },
      {
        accessorKey: "status",
        header: "Status",
        cell: ({ row }) => (
          <Badge
            variant={
              row.original.status === "INSTALLED"
                ? "default"
                : row.original.status === "AVAILABLE"
                  ? "secondary"
                  : "outline"
            }
          >
            {PART_STATUS_LABEL[row.original.status] ?? row.original.status}
          </Badge>
        ),
      },
      { accessorKey: "currentVehicle", header: "Vehicle", cell: ({ row }) => row.original.currentVehicle || "—" },
      {
        accessorKey: "installedOn",
        header: "Installed On",
        cell: ({ row }) =>
          row.original.installedOn
            ? `${formatDate(row.original.installedOn)} · ${km(row.original.installKm)}`
            : "—",
      },
      {
        accessorKey: "warrantyExpiry",
        header: "Warranty",
        cell: ({ row }) => (
          <div className="flex flex-col gap-0.5">
            <WarrantyBadge status={row.original.warranty} daysLeft={row.original.daysLeft} />
            {row.original.warrantyExpiry && (
              <span className="text-[11px] text-muted-foreground">
                till {formatDate(row.original.warrantyExpiry)}
              </span>
            )}
          </div>
        ),
      },
      { accessorKey: "supplierName", header: "Supplier / Workshop" },
      {
        id: "actions",
        header: "",
        cell: ({ row }) => {
          const p = row.original;
          return (
            <div className="flex items-center gap-1" onClick={(e) => e.stopPropagation()}>
              <Button variant="ghost" size="sm" className="h-7 px-2 text-xs" onClick={() => setHistoryFor(p)} title="Complete history">
                <History className="h-3.5 w-3.5" /> History
              </Button>
              {p.status !== "INSTALLED" && p.status !== "REMOVED" && (
                <Button variant="outline" size="sm" className="h-7 px-2 text-xs" onClick={() => setInstallFor(p)}>
                  <Wrench className="h-3.5 w-3.5" /> Install
                </Button>
              )}
              {p.status === "INSTALLED" && (
                <Button variant="outline" size="sm" className="h-7 px-2 text-xs" onClick={() => setRemoveFor(p)}>
                  <ArrowRightLeft className="h-3.5 w-3.5" /> Remove / Replace
                </Button>
              )}
              {p.warrantyApplicable && (
                <Button variant="outline" size="sm" className="h-7 px-2 text-xs" onClick={() => setClaimFor(p)}>
                  <ShieldCheck className="h-3.5 w-3.5" /> Claim
                </Button>
              )}
              {p.warranty === "EXPIRING_30" && !p.warrantyReviewedAt && (
                <Button variant="secondary" size="sm" className="h-7 px-2 text-xs" onClick={() => void reviewed(p)}>
                  Mark reviewed
                </Button>
              )}
              {canDelete && p.status !== "INSTALLED" && (
                <Button variant="ghost" size="icon" className="h-7 w-7 text-destructive" title="Delete" onClick={() => void removePart(p)}>
                  <Trash2 className="h-3.5 w-3.5" />
                </Button>
              )}
            </div>
          );
        },
      },
    ],
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [canDelete]
  );

  const availableParts = parts.filter((p) => p.status === "AVAILABLE");

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <Input
          className="h-8 w-[260px] text-xs"
          placeholder="Search serial no / part no / name / vehicle..."
          value={q}
          onChange={(e) => setQ(e.target.value)}
        />
        {mode === "parts" && (
          <Select value={status || "ALL"} onValueChange={(v) => setStatus(v === "ALL" ? "" : v)}>
            <SelectTrigger className="h-8 w-40 text-xs"><SelectValue placeholder="Status" /></SelectTrigger>
            <SelectContent>
              <SelectItem value="ALL">All statuses</SelectItem>
              <SelectItem value="AVAILABLE">Available</SelectItem>
              <SelectItem value="INSTALLED">Installed</SelectItem>
              <SelectItem value="REMOVED">Removed</SelectItem>
            </SelectContent>
          </Select>
        )}
        <Select value={warranty || "ALL"} onValueChange={(v) => setWarranty(v === "ALL" ? "" : v)}>
          <SelectTrigger className="h-8 w-52 text-xs"><SelectValue placeholder="Warranty" /></SelectTrigger>
          <SelectContent>
            <SelectItem value="ALL">All warranty statuses</SelectItem>
            <SelectItem value="ACTIVE">🟢 Active</SelectItem>
            <SelectItem value="EXPIRING_SOON">🟡 Expiring Soon (31–60 days)</SelectItem>
            <SelectItem value="EXPIRING_30">🟠 Expiring Within 30 Days</SelectItem>
            <SelectItem value="EXPIRED">🔴 Expired</SelectItem>
            {mode === "parts" && <SelectItem value="NONE">⚪ No Warranty</SelectItem>}
          </SelectContent>
        </Select>
        <div className="w-44">
          <MasterCombobox options={vehicleOptions} value={vehicleId} onChange={setVehicleId} placeholder="Vehicle..." className="h-8" />
        </div>
        {(q || status || warranty || vehicleId) && (
          <Button variant="ghost" size="sm" className="h-8" onClick={() => { setQ(""); setStatus(""); setWarranty(""); setVehicleId(null); }}>
            Clear
          </Button>
        )}
        <span className="ml-auto flex items-center gap-2">
          <ExportButton
            rows={rows}
            fileName={mode === "warranty" ? "warranty-status" : "spare-parts"}
            sheetName={mode === "warranty" ? "Warranty" : "Spare Parts"}
            columns={[
              { header: "Serial No", key: "serialNo" },
              { header: "Spare Part", key: "name" },
              { header: "Part No", key: "partNumber" },
              { header: "Brand", key: "brand" },
              { header: "Model", key: "model" },
              { header: "Supplier / Workshop", key: "supplierName" },
              { header: "Purchase Date", accessor: (r) => (r.purchaseDate ? formatDate(r.purchaseDate) : "") },
              { header: "Invoice No", key: "invoiceNo" },
              { header: "Purchase Rate (info)", key: "purchaseRate", numeric: true },
              { header: "Status", accessor: (r) => PART_STATUS_LABEL[r.status] ?? r.status },
              { header: "Vehicle", key: "currentVehicle" },
              { header: "Installed On", accessor: (r) => (r.installedOn ? formatDate(r.installedOn) : "") },
              { header: "Install KM", key: "installKm", numeric: true },
              { header: "Warranty Start", accessor: (r) => (r.warrantyStart ? formatDate(r.warrantyStart) : "") },
              { header: "Warranty Months", key: "warrantyMonths", numeric: true },
              { header: "Warranty Expiry", accessor: (r) => (r.warrantyExpiry ? formatDate(r.warrantyExpiry) : "") },
              { header: "Warranty Status", accessor: (r) => WARRANTY_LABEL[r.warranty] },
              { header: "Days Left", key: "daysLeft", numeric: true },
              { header: "Remarks", key: "remarks" },
            ]}
          />
          {mode === "parts" && (
            <Button size="sm" onClick={openNew}>
              <Plus className="h-4 w-4" /> New Spare Part
            </Button>
          )}
        </span>
      </div>

      <DataTable
        columns={columns}
        data={rows}
        onRowClick={mode === "parts" ? openEdit : setHistoryFor}
        emptyMessage="No spare parts match."
      />
      <p className="text-xs text-muted-foreground">
        Information & tracking only — nothing here creates a voucher, expense, purchase or stock entry, and
        nothing is sent to Tally.
      </p>

      {/* ---- new / edit part ---- */}
      <Dialog open={!!editing} onOpenChange={(o) => !o && setEditing(null)}>
        <DialogContent className="max-h-[92vh] overflow-y-auto sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>{editing?.id ? "Edit Spare Part" : "New Spare Part"}</DialogTitle>
            <DialogDescription>
              Purchase rate is for information only — it is never posted to accounts.
            </DialogDescription>
          </DialogHeader>
          {editing && (
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="Spare Part Name *">
                <Input value={editing.form.name} onChange={(e) => setEditing({ ...editing, form: { ...editing.form, name: e.target.value.toUpperCase() } })} autoFocus />
              </Field>
              <Field label="Part Number">
                <Input value={editing.form.partNumber} onChange={(e) => setEditing({ ...editing, form: { ...editing.form, partNumber: e.target.value.toUpperCase() } })} />
              </Field>
              <Field label="Unique Serial Number / ID *">
                <Input value={editing.form.serialNo} onChange={(e) => setEditing({ ...editing, form: { ...editing.form, serialNo: e.target.value.toUpperCase() } })} placeholder="e.g. ALT-45821" />
              </Field>
              <Field label="Brand">
                <Input value={editing.form.brand} onChange={(e) => setEditing({ ...editing, form: { ...editing.form, brand: e.target.value } })} />
              </Field>
              <Field label="Model / Specification">
                <Input value={editing.form.model} onChange={(e) => setEditing({ ...editing, form: { ...editing.form, model: e.target.value } })} />
              </Field>
              <Field label="Supplier / Workshop">
                <Input value={editing.form.supplierName} onChange={(e) => setEditing({ ...editing, form: { ...editing.form, supplierName: e.target.value } })} />
              </Field>
              <Field label="Purchase Date">
                <DateInput value={editing.form.purchaseDateText} onChange={(t) => setEditing({ ...editing, form: { ...editing.form, purchaseDateText: t } })} />
              </Field>
              <Field label="Invoice / Bill Number">
                <Input value={editing.form.invoiceNo} onChange={(e) => setEditing({ ...editing, form: { ...editing.form, invoiceNo: e.target.value } })} />
              </Field>
              <Field label="Purchase Rate (information only)">
                <Input type="number" inputMode="decimal" className="text-right" value={editing.form.purchaseRate} onChange={(e) => setEditing({ ...editing, form: { ...editing.form, purchaseRate: e.target.value } })} />
              </Field>
              <div className="space-y-1.5">
                <Label className="text-xs">Warranty Applicable</Label>
                <div className="flex h-10 items-center gap-2">
                  <Switch checked={editing.form.warrantyApplicable} onCheckedChange={(v) => setEditing({ ...editing, form: { ...editing.form, warrantyApplicable: v } })} />
                  <span className="text-sm">{editing.form.warrantyApplicable ? "Yes" : "No"}</span>
                </div>
              </div>
              {editing.form.warrantyApplicable && (
                <>
                  <Field label="Warranty Period (months) *">
                    <Input type="number" inputMode="numeric" className="text-right" value={editing.form.warrantyMonths} onChange={(e) => setEditing({ ...editing, form: { ...editing.form, warrantyMonths: e.target.value } })} />
                  </Field>
                  <Field label="Warranty Start Date *">
                    <DateInput value={editing.form.warrantyStartText} onChange={(t) => setEditing({ ...editing, form: { ...editing.form, warrantyStartText: t } })} />
                  </Field>
                  <Field label="Warranty Expiry (auto)" span2>
                    <div className="flex h-10 items-center rounded-md border bg-muted/50 px-3 text-sm">
                      {expiryPreview || <span className="text-muted-foreground">start date + period</span>}
                    </div>
                  </Field>
                </>
              )}
              <Field label="Remarks" span2>
                <Textarea rows={2} value={editing.form.remarks} onChange={(e) => setEditing({ ...editing, form: { ...editing.form, remarks: e.target.value } })} />
              </Field>
            </div>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => setEditing(null)} disabled={busy}>Cancel</Button>
            <Button onClick={() => void savePart()} disabled={busy}>{busy ? "Saving..." : "Save"}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ---- history ---- */}
      <Dialog open={!!historyFor} onOpenChange={(o) => !o && setHistoryFor(null)}>
        <DialogContent className="max-h-[92vh] overflow-y-auto sm:max-w-3xl">
          <DialogHeader>
            <DialogTitle>{historyFor?.serialNo} — {historyFor?.name}</DialogTitle>
            <DialogDescription>Complete history of this unique part number.</DialogDescription>
          </DialogHeader>
          {historyFor && <SparePartHistory part={historyFor} />}
        </DialogContent>
      </Dialog>

      {installFor && (
        <InstallDialog
          part={installFor}
          vehicleOptions={vehicleOptions}
          onClose={() => setInstallFor(null)}
          onDone={() => { setInstallFor(null); done(`${installFor.serialNo} installed`); }}
          onError={failed}
        />
      )}
      {removeFor && (
        <RemoveDialog
          part={removeFor}
          availableParts={availableParts}
          onClose={() => setRemoveFor(null)}
          onDone={() => { setRemoveFor(null); done(`${removeFor.serialNo} removed`); }}
          onError={failed}
        />
      )}
      {claimFor && (
        <ClaimDialog
          part={claimFor}
          availableParts={availableParts}
          onClose={() => setClaimFor(null)}
          onDone={() => { setClaimFor(null); done("Warranty claim recorded"); }}
          onError={failed}
        />
      )}
    </div>
  );
}

// ---------------------------------------------------------------- dialogs

function InstallDialog({
  part, vehicleOptions, onClose, onDone, onError,
}: { part: SparePartRow; vehicleOptions: MasterOption[]; onClose: () => void; onDone: () => void; onError: (e: string) => void }) {
  const [vehicleId, setVehicleId] = React.useState<string | null>(null);
  const [dateText, setDateText] = React.useState(formatDate(new Date()));
  const [kmText, setKmText] = React.useState("");
  const [workshop, setWorkshop] = React.useState(part.supplierName);
  const [remarks, setRemarks] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const submit = async () => {
    if (!vehicleId) return onError("Select the vehicle");
    setBusy(true);
    try {
      const res = await installSparePart({ partId: part.id, vehicleId, date: textToIso(dateText), km: Number(kmText) || 0, workshop, remarks });
      if (res.ok) onDone(); else onError(res.error);
    } finally { setBusy(false); }
  };
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Install {part.serialNo}</DialogTitle>
          <DialogDescription>{part.name}{part.partNumber ? ` · ${part.partNumber}` : ""}</DialogDescription>
        </DialogHeader>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Vehicle *" span2>
            <MasterCombobox options={vehicleOptions} value={vehicleId} onChange={setVehicleId} placeholder="Select vehicle..." />
          </Field>
          <Field label="Installation Date *"><DateInput value={dateText} onChange={setDateText} /></Field>
          <Field label="Vehicle KM Reading *"><Input type="number" inputMode="numeric" className="text-right" value={kmText} onChange={(e) => setKmText(e.target.value)} /></Field>
          <Field label="Workshop / Mechanic"><Input value={workshop} onChange={(e) => setWorkshop(e.target.value)} /></Field>
          <Field label="Installation Remarks"><Input value={remarks} onChange={(e) => setRemarks(e.target.value)} /></Field>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={busy}>Cancel</Button>
          <Button onClick={() => void submit()} disabled={busy}>{busy ? "Saving..." : "Install"}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function RemoveDialog({
  part, availableParts, onClose, onDone, onError,
}: { part: SparePartRow; availableParts: SparePartRow[]; onClose: () => void; onDone: () => void; onError: (e: string) => void }) {
  const [dateText, setDateText] = React.useState(formatDate(new Date()));
  const [kmText, setKmText] = React.useState("");
  const [workshop, setWorkshop] = React.useState("");
  const [remarks, setRemarks] = React.useState("");
  const [disposition, setDisposition] = React.useState<"SCRAP" | "STOCK">("SCRAP");
  const [replacementId, setReplacementId] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);
  const options: MasterOption[] = availableParts
    .filter((p) => p.id !== part.id)
    .map((p) => ({ value: p.id, label: p.serialNo, meta: `${p.name}${p.partNumber ? " · " + p.partNumber : ""}` }));
  const submit = async () => {
    setBusy(true);
    try {
      const res = await removeSparePart({ partId: part.id, date: textToIso(dateText), km: kmText === "" ? null : Number(kmText), workshop, remarks, disposition, replacementPartId: replacementId });
      if (res.ok) onDone(); else onError(res.error);
    } finally { setBusy(false); }
  };
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Remove {part.serialNo} from {part.currentVehicle}</DialogTitle>
          <DialogDescription>Optionally fit a replacement part in the same vehicle on the same date.</DialogDescription>
        </DialogHeader>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Removal Date *"><DateInput value={dateText} onChange={setDateText} /></Field>
          <Field label="Vehicle KM at Removal"><Input type="number" inputMode="numeric" className="text-right" value={kmText} onChange={(e) => setKmText(e.target.value)} /></Field>
          <Field label="Workshop / Mechanic"><Input value={workshop} onChange={(e) => setWorkshop(e.target.value)} /></Field>
          <Field label="After removal">
            <Select value={disposition} onValueChange={(v) => setDisposition(v as "SCRAP" | "STOCK")}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="SCRAP">Part is finished (removed)</SelectItem>
                <SelectItem value="STOCK">Back to available stock</SelectItem>
              </SelectContent>
            </Select>
          </Field>
          <Field label="Replacement part (optional)" span2>
            <MasterCombobox options={options} value={replacementId} onChange={setReplacementId} placeholder="Select an available part by serial no..." />
          </Field>
          <Field label="Remarks" span2><Input value={remarks} onChange={(e) => setRemarks(e.target.value)} /></Field>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={busy}>Cancel</Button>
          <Button onClick={() => void submit()} disabled={busy}>{busy ? "Saving..." : replacementId ? "Remove & Replace" : "Remove"}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function ClaimDialog({
  part, availableParts, onClose, onDone, onError,
}: { part: SparePartRow; availableParts: SparePartRow[]; onClose: () => void; onDone: () => void; onError: (e: string) => void }) {
  const [dateText, setDateText] = React.useState(formatDate(new Date()));
  const [claimStatus, setClaimStatus] = React.useState<"OPEN" | "APPROVED" | "REJECTED" | "REPLACED">("OPEN");
  const [replacementId, setReplacementId] = React.useState<string | null>(null);
  const [kmText, setKmText] = React.useState("");
  const [remarks, setRemarks] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const options: MasterOption[] = availableParts
    .filter((p) => p.id !== part.id)
    .map((p) => ({ value: p.id, label: p.serialNo, meta: `${p.name}${p.partNumber ? " · " + p.partNumber : ""}` }));
  const submit = async () => {
    setBusy(true);
    try {
      const res = await addWarrantyClaim({ partId: part.id, date: textToIso(dateText), claimStatus, remarks, replacementPartId: claimStatus === "REPLACED" ? replacementId : null, km: kmText === "" ? null : Number(kmText) });
      if (res.ok) onDone(); else onError(res.error);
    } finally { setBusy(false); }
  };
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Warranty Claim — {part.serialNo}</DialogTitle>
          <DialogDescription>
            <WarrantyBadge status={part.warranty} daysLeft={part.daysLeft} />
            {part.warrantyExpiry ? ` Expires ${formatDate(part.warrantyExpiry)}.` : ""} Claims are tracked here only — no accounting entry.
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Claim Date *"><DateInput value={dateText} onChange={setDateText} /></Field>
          <Field label="Claim Status">
            <Select value={claimStatus} onValueChange={(v) => setClaimStatus(v as typeof claimStatus)}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="OPEN">Open</SelectItem>
                <SelectItem value="APPROVED">Approved</SelectItem>
                <SelectItem value="REJECTED">Rejected</SelectItem>
                <SelectItem value="REPLACED">Replaced under warranty</SelectItem>
              </SelectContent>
            </Select>
          </Field>
          {claimStatus === "REPLACED" && (
            <Field label="Replacement part supplied (available stock)" span2>
              <MasterCombobox options={options} value={replacementId} onChange={setReplacementId} placeholder="Select by serial no..." />
            </Field>
          )}
          <Field label="Vehicle KM (if installed)"><Input type="number" inputMode="numeric" className="text-right" value={kmText} onChange={(e) => setKmText(e.target.value)} /></Field>
          <Field label="Remarks" span2><Textarea rows={2} value={remarks} onChange={(e) => setRemarks(e.target.value)} /></Field>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={busy}>Cancel</Button>
          <Button onClick={() => void submit()} disabled={busy}>{busy ? "Saving..." : "Record Claim"}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
