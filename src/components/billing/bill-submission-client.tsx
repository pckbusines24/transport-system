"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import type { ColumnDef } from "@tanstack/react-table";
import { Plus, Trash2 } from "lucide-react";
import { formatDate, formatMoney, parseDdMmYyyy } from "@/lib/utils";
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
  Table,
  TableBody,
  TableCell,
  TableFooter,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { useToast } from "@/components/ui/use-toast";
import { DataTable, type DataTableColumnMeta } from "@/components/data/data-table";
import { DateInput } from "@/components/data/date-input";
import { ExportButton } from "@/components/data/export-button";
import { FilterBar } from "@/components/data/filter-bar";
import { MasterCombobox, type MasterOption } from "@/components/data/master-combobox";
import {
  findInvoiceForSubmission,
  getInvoiceSubmissionHistory,
  getInvoicesForSubmission,
  getSubmissionDetails,
  saveInvoiceSubmission,
  saveSubmissionAck,
  setSubmissionFile,
  type InvoiceHistoryStep,
  type SubmissionDetails,
  type SubmissionInvoiceRow,
} from "@/app/(app)/billing/submission/actions";

export interface SubmissionRegisterRow {
  id: string;
  submissionNo: string;
  submissionDate: string;
  customer: string;
  totalBills: number;
  totalAmount: number;
  receivedBy: string;
  receivedDate: string | null;
  hasDocs: boolean;
  remarks: string;
  returnedCount: number;
}

function textToIso(text: string): string {
  const d = parseDdMmYyyy(text);
  if (!d) return "";
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${d.getFullYear()}-${mm}-${dd}`;
}

export function BillSubmissionClient({
  rows,
  partyOptions,
}: {
  rows: SubmissionRegisterRow[];
  partyOptions: MasterOption[];
}) {
  const router = useRouter();
  const { toast } = useToast();

  // ------- entry state -------
  const [submissionDateText, setSubmissionDateText] = React.useState(formatDate(new Date()));
  const [partyId, setPartyId] = React.useState<string | null>(null);
  const [fromText, setFromText] = React.useState("");
  const [toText, setToText] = React.useState("");
  const [remarks, setRemarks] = React.useState("");
  const [fetched, setFetched] = React.useState<SubmissionInvoiceRow[]>([]);
  const [selected, setSelected] = React.useState<Set<string>>(new Set());
  const [fetching, setFetching] = React.useState(false);
  const [manualNo, setManualNo] = React.useState("");
  const [saving, setSaving] = React.useState(false);

  const fetchInvoices = async () => {
    if (!partyId) {
      toast({ variant: "destructive", title: "Select a customer first" });
      return;
    }
    setFetching(true);
    try {
      const list = await getInvoicesForSubmission(
        partyId,
        textToIso(fromText) || null,
        textToIso(toText) || null
      );
      // keep manually-added invoices already in the grid
      setFetched((prev) => {
        const manual = prev.filter((p) => !list.some((l) => l.id === p.id) && selected.has(p.id));
        return [...list, ...manual];
      });
      if (list.length === 0) toast({ title: "No invoices found for this customer / period" });
    } finally {
      setFetching(false);
    }
  };

  const addManual = async () => {
    const q = manualNo.trim();
    if (!q) return;
    const res = await findInvoiceForSubmission(q);
    if (!res.ok) {
      toast({ variant: "destructive", title: res.error });
      return;
    }
    const exact =
      res.rows.find((r) => r.invoiceNo.toLowerCase() === q.toLowerCase()) ?? res.rows[0];
    if (fetched.some((f) => f.id === exact.id)) {
      toast({
        variant: "destructive",
        title: `Invoice ${exact.invoiceNo} is already in the list`,
        description: "Duplicate invoice selection is not allowed.",
      });
      return;
    }
    setFetched((prev) => [...prev, exact]);
    setSelected((prev) => new Set(prev).add(exact.id));
    setManualNo("");
  };

  const toggle = (id: string, on: boolean) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (on) next.add(id);
      else next.delete(id);
      return next;
    });

  const selectedRows = fetched.filter((f) => selected.has(f.id));
  const totalAmount = selectedRows.reduce((s, r) => s + r.amount, 0);

  const save = async () => {
    const iso = textToIso(submissionDateText);
    if (!iso) {
      toast({ variant: "destructive", title: "Valid submission date is required" });
      return;
    }
    if (!partyId) {
      toast({ variant: "destructive", title: "Customer is required" });
      return;
    }
    if (selectedRows.length === 0) {
      toast({ variant: "destructive", title: "Select at least one invoice" });
      return;
    }
    setSaving(true);
    try {
      const res = await saveInvoiceSubmission({
        submissionDate: iso,
        partyId,
        remarks,
        invoiceIds: selectedRows.map((r) => r.id),
      });
      if (res.ok) {
        toast({
          title: `Bill Submission ${res.submissionNo} created`,
          description: `${selectedRows.length} invoice(s) — the covering letter is opening for print.`,
        });
        window.open(`/print/submission/${res.id}`, "_blank");
        setFetched([]);
        setSelected(new Set());
        setRemarks("");
        router.refresh();
      } else {
        toast({ variant: "destructive", title: "Save failed", description: res.error });
      }
    } finally {
      setSaving(false);
    }
  };

  // ------- details dialog -------
  const [details, setDetails] = React.useState<SubmissionDetails | null>(null);
  const openDetails = React.useCallback(async (id: string) => {
    const res = await getSubmissionDetails(id);
    if (res.ok) setDetails(res.data);
    else toast({ variant: "destructive", title: res.error });
  }, [toast]);

  // ack form inside details
  const [ackBusy, setAckBusy] = React.useState(false);
  const [ack, setAck] = React.useState({
    receivedBy: "",
    designation: "",
    receiverMobile: "",
    receivedDateText: "",
    receivedTime: "",
    ackRemarks: "",
  });
  React.useEffect(() => {
    if (details) {
      setAck({
        receivedBy: details.receivedBy,
        designation: details.designation,
        receiverMobile: details.receiverMobile,
        receivedDateText: details.receivedDate ? formatDate(details.receivedDate) : "",
        receivedTime: details.receivedTime,
        ackRemarks: details.ackRemarks,
      });
    }
  }, [details]);

  const saveAck = async () => {
    if (!details) return;
    const iso = textToIso(ack.receivedDateText);
    if (!ack.receivedBy.trim() || !iso) {
      toast({ variant: "destructive", title: "Received By and Receiving Date are required" });
      return;
    }
    setAckBusy(true);
    try {
      const res = await saveSubmissionAck({
        id: details.id,
        receivedBy: ack.receivedBy,
        designation: ack.designation,
        receiverMobile: ack.receiverMobile,
        receivedDate: iso,
        receivedTime: ack.receivedTime,
        ackRemarks: ack.ackRemarks,
      });
      if (res.ok) {
        toast({ title: "Acknowledgement saved" });
        await openDetails(details.id);
        router.refresh();
      } else {
        toast({ variant: "destructive", title: "Save failed", description: res.error });
      }
    } finally {
      setAckBusy(false);
    }
  };

  // uploads
  const fileRef = React.useRef<HTMLInputElement>(null);
  const uploadKindRef = React.useRef<"signed" | "ack" | "support">("signed");
  const [uploading, setUploading] = React.useState(false);
  const startUpload = (kind: "signed" | "ack" | "support") => {
    uploadKindRef.current = kind;
    fileRef.current?.click();
  };
  const handleFile = async (file: File | null) => {
    if (!file || !details) return;
    setUploading(true);
    try {
      const fd = new FormData();
      fd.append("file", file);
      const res = await fetch("/api/uploads/docreg", { method: "POST", body: fd });
      const json = await res.json();
      if (!res.ok || !json.ok) throw new Error(json.error ?? "Upload failed");
      const saved = await setSubmissionFile(details.id, uploadKindRef.current, json.path);
      if (!saved.ok) throw new Error(saved.error);
      toast({ title: "Document attached" });
      await openDetails(details.id);
      router.refresh();
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

  // invoice history
  const [history, setHistory] = React.useState<{ invoiceNo: string; steps: InvoiceHistoryStep[] } | null>(null);
  const openHistory = async (invoiceId: string) => {
    const res = await getInvoiceSubmissionHistory(invoiceId);
    if (res.ok) setHistory({ invoiceNo: res.invoiceNo, steps: res.steps });
    else toast({ variant: "destructive", title: res.error });
  };

  // ------- register columns -------
  const columns: ColumnDef<SubmissionRegisterRow>[] = React.useMemo(() => [
    {
      accessorKey: "submissionNo",
      header: "Submission No",
      cell: ({ row }) => (
        <button
          type="button"
          className="text-primary underline"
          onClick={(e) => {
            e.stopPropagation();
            void openDetails(row.original.id);
          }}
        >
          {row.original.submissionNo}
        </button>
      ),
    },
    {
      accessorKey: "submissionDate",
      header: "Date",
      cell: ({ row }) => formatDate(row.original.submissionDate),
    },
    { accessorKey: "customer", header: "Customer" },
    {
      accessorKey: "totalBills",
      header: "Bills",
      meta: {
        numeric: true,
        total: (rs) => rs.reduce((s, r) => s + r.totalBills, 0),
      } satisfies DataTableColumnMeta<SubmissionRegisterRow>,
    },
    {
      accessorKey: "totalAmount",
      header: "Total Amount",
      cell: ({ row }) => formatMoney(row.original.totalAmount),
      meta: {
        numeric: true,
        total: (rs) => formatMoney(rs.reduce((s, r) => s + r.totalAmount, 0)),
      } satisfies DataTableColumnMeta<SubmissionRegisterRow>,
    },
    {
      id: "receivedStatus",
      header: "Received Status",
      cell: ({ row }) =>
        row.original.receivedBy ? (
          <Badge>Received</Badge>
        ) : (
          <Badge variant="destructive">Pending</Badge>
        ),
    },
    { accessorKey: "receivedBy", header: "Received By" },
    {
      accessorKey: "receivedDate",
      header: "Receiving Date",
      cell: ({ row }) =>
        row.original.receivedDate ? formatDate(row.original.receivedDate) : "",
    },
    {
      accessorKey: "hasDocs",
      header: "Documents",
      cell: ({ row }) =>
        row.original.hasDocs ? (
          <Badge variant="secondary">Uploaded</Badge>
        ) : (
          <Badge variant="outline">None</Badge>
        ),
    },
    {
      accessorKey: "returnedCount",
      header: "Returned",
      cell: ({ row }) =>
        row.original.returnedCount > 0 ? (
          <Badge variant="destructive">{row.original.returnedCount}</Badge>
        ) : (
          ""
        ),
    },
    { accessorKey: "remarks", header: "Remarks" },
  ], [openDetails]);

  return (
    <div className="space-y-4">
      {/* ------- entry ------- */}
      <Card>
        <CardHeader className="p-4 pb-2">
          <CardTitle className="text-sm">
            New Bill Submission — number is auto-generated on save
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-3 p-4 pt-1">
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
            <div className="space-y-1">
              <Label className="text-xs">Submission Date *</Label>
              <DateInput className="h-9" value={submissionDateText} onChange={setSubmissionDateText} />
            </div>
            <div className="space-y-1">
              <Label className="text-xs">Customer *</Label>
              <MasterCombobox
                options={partyOptions}
                value={partyId}
                onChange={(v) => {
                  setPartyId(v);
                  setFetched([]);
                  setSelected(new Set());
                }}
                placeholder="Select customer..."
              />
            </div>
            <div className="space-y-1">
              <Label className="text-xs">From Date</Label>
              <DateInput className="h-9" value={fromText} onChange={setFromText} />
            </div>
            <div className="space-y-1">
              <Label className="text-xs">To Date</Label>
              <DateInput className="h-9" value={toText} onChange={setToText} />
            </div>
            <div className="flex items-end">
              <Button type="button" onClick={fetchInvoices} disabled={fetching || !partyId}>
                {fetching ? "Fetching..." : "Fetch Invoices"}
              </Button>
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <Input
              className="h-9 max-w-[14rem]"
              placeholder="Add Invoice by Invoice No..."
              value={manualNo}
              onChange={(e) => setManualNo(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  void addManual();
                }
              }}
            />
            <Button type="button" variant="outline" onClick={() => void addManual()} disabled={!manualNo.trim()}>
              <Plus className="h-4 w-4" /> Add Invoice
            </Button>
            <span className="text-xs text-muted-foreground">
              for edited / older invoices outside the date range
            </span>
          </div>

          {fetched.length > 0 && (
            <div className="max-h-80 overflow-auto rounded-md border">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="w-8">
                      <Checkbox
                        checked={fetched.length > 0 && selected.size === fetched.length}
                        onCheckedChange={(c) =>
                          setSelected(c === true ? new Set(fetched.map((f) => f.id)) : new Set())
                        }
                      />
                    </TableHead>
                    <TableHead>S. No.</TableHead>
                    <TableHead>Invoice Date</TableHead>
                    <TableHead>Invoice No</TableHead>
                    <TableHead className="text-right">Invoice Amount</TableHead>
                    <TableHead>Earlier Submission</TableHead>
                    <TableHead className="w-8" />
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {fetched.map((inv, i) => (
                    <TableRow
                      key={inv.id}
                      className="cursor-pointer"
                      onClick={() => toggle(inv.id, !selected.has(inv.id))}
                    >
                      <TableCell onClick={(e) => e.stopPropagation()}>
                        <Checkbox
                          checked={selected.has(inv.id)}
                          onCheckedChange={(c) => toggle(inv.id, c === true)}
                        />
                      </TableCell>
                      <TableCell>{i + 1}</TableCell>
                      <TableCell>{formatDate(inv.invoiceDate)}</TableCell>
                      <TableCell>{inv.invoiceNo}</TableCell>
                      <TableCell className="text-right tabular-nums">
                        {formatMoney(inv.amount)}
                      </TableCell>
                      <TableCell>
                        {inv.lastSubmissionNo ? (
                          <Badge variant="secondary" title="Selecting it marks the earlier copy as Returned automatically">
                            {inv.lastSubmissionNo} — will auto-mark Returned
                          </Badge>
                        ) : (
                          ""
                        )}
                      </TableCell>
                      <TableCell onClick={(e) => e.stopPropagation()}>
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon"
                          className="h-6 w-6 text-destructive"
                          onClick={() => {
                            setFetched((prev) => prev.filter((f) => f.id !== inv.id));
                            toggle(inv.id, false);
                          }}
                        >
                          <Trash2 className="h-3 w-3" />
                        </Button>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
                {selectedRows.length > 0 && (
                  <TableFooter>
                    <TableRow>
                      <TableCell colSpan={4}>
                        Selected: {selectedRows.length} bill{selectedRows.length === 1 ? "" : "s"}
                      </TableCell>
                      <TableCell className="text-right tabular-nums">
                        {formatMoney(totalAmount)}
                      </TableCell>
                      <TableCell colSpan={2} />
                    </TableRow>
                  </TableFooter>
                )}
              </Table>
            </div>
          )}

          <div className="flex items-end gap-2">
            <div className="flex-1 space-y-1">
              <Label className="text-xs">Remarks (optional)</Label>
              <Input className="h-9" value={remarks} onChange={(e) => setRemarks(e.target.value)} />
            </div>
            <Button type="button" onClick={save} disabled={saving || selectedRows.length === 0}>
              {saving ? "Saving..." : `Save Submission (${selectedRows.length})`}
            </Button>
          </div>
        </CardContent>
      </Card>

      {/* ------- register ------- */}
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-semibold">Bill Submission Register</h2>
        <ExportButton
          rows={rows}
          fileName="bill-submission-register"
          sheetName="Bill Submissions"
          columns={[
            { header: "Submission No", key: "submissionNo" },
            { header: "Date", accessor: (r) => formatDate(r.submissionDate) },
            { header: "Customer", key: "customer" },
            { header: "Total Bills", key: "totalBills", numeric: true },
            { header: "Total Amount", key: "totalAmount", numeric: true },
            { header: "Received Status", accessor: (r) => (r.receivedBy ? "RECEIVED" : "PENDING") },
            { header: "Received By", key: "receivedBy" },
            { header: "Receiving Date", accessor: (r) => (r.receivedDate ? formatDate(r.receivedDate) : "") },
            { header: "Documents", accessor: (r) => (r.hasDocs ? "UPLOADED" : "NONE") },
            { header: "Returned Invoices", key: "returnedCount", numeric: true },
            { header: "Remarks", key: "remarks" },
          ]}
        />
      </div>
      <FilterBar
        filters={[
          { type: "text", key: "q", label: "Submission No..." },
          { type: "daterange", key: "date", label: "Date" },
          { type: "combobox", key: "party", label: "Customer", options: partyOptions },
          {
            type: "select",
            key: "received",
            label: "Status",
            options: [
              { value: "received", label: "Received" },
              { value: "pending", label: "Pending" },
            ],
          },
        ]}
      />
      <DataTable
        columns={columns}
        data={rows}
        emptyMessage="No bill submissions yet."
        onRowClick={(row) => void openDetails(row.id)}
      />

      {/* hidden upload input */}
      <input
        ref={fileRef}
        type="file"
        accept=".pdf,.jpg,.jpeg,.png,application/pdf,image/jpeg,image/png"
        className="hidden"
        onChange={(e) => void handleFile(e.target.files?.[0] ?? null)}
      />

      {/* ------- details dialog ------- */}
      <Dialog open={!!details} onOpenChange={(o) => !o && setDetails(null)}>
        <DialogContent className="max-h-[92vh] overflow-y-auto sm:max-w-3xl">
          <DialogHeader>
            <DialogTitle>
              {details?.submissionNo} — {details?.partyName}
            </DialogTitle>
            <DialogDescription>
              Submitted {details ? formatDate(details.submissionDate) : ""}
              {details?.remarks ? ` — ${details.remarks}` : ""}
            </DialogDescription>
          </DialogHeader>
          {details && (
            <div className="space-y-3 text-sm">
              {/* invoices */}
              <div className="rounded-md border">
                <Table>
                  <TableHeader>
                    <TableRow>
                      {["S. No.", "Invoice Date", "Invoice No", "Amount", "Status", "Resubmitted In", "History"].map(
                        (h) => (
                          <TableHead key={h} className="text-xs">
                            {h}
                          </TableHead>
                        )
                      )}
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {details.items.map((it, i) => (
                      <TableRow key={it.invoiceId}>
                        <TableCell>{i + 1}</TableCell>
                        <TableCell>{formatDate(it.invoiceDate)}</TableCell>
                        <TableCell>{it.invoiceNo}</TableCell>
                        <TableCell className="text-right tabular-nums">
                          {formatMoney(it.amount)}
                        </TableCell>
                        <TableCell>
                          {it.status === "RETURNED" ? (
                            <Badge variant="destructive">Returned</Badge>
                          ) : (
                            <Badge>Submitted</Badge>
                          )}
                        </TableCell>
                        <TableCell>
                          {it.resubmittedInNo
                            ? `${it.resubmittedInNo}${it.resubmissionDate ? ` (${formatDate(it.resubmissionDate)})` : ""}`
                            : "-"}
                        </TableCell>
                        <TableCell>
                          <Button
                            type="button"
                            variant="ghost"
                            size="sm"
                            className="h-6 px-2 text-xs"
                            onClick={() => void openHistory(it.invoiceId)}
                          >
                            History
                          </Button>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                  <TableFooter>
                    <TableRow>
                      <TableCell colSpan={3}>Total Bills: {details.items.length}</TableCell>
                      <TableCell className="text-right tabular-nums">
                        {formatMoney(details.items.reduce((s, it) => s + it.amount, 0))}
                      </TableCell>
                      <TableCell colSpan={3} />
                    </TableRow>
                  </TableFooter>
                </Table>
              </div>

              {/* acknowledgement */}
              <div className="rounded-md border p-3">
                <div className="mb-2 text-xs font-semibold uppercase text-muted-foreground">
                  Submission Acknowledgement
                </div>
                <div className="grid gap-2 sm:grid-cols-3">
                  <div className="space-y-1">
                    <Label className="text-xs">Received By *</Label>
                    <Input
                      className="h-8"
                      value={ack.receivedBy}
                      onChange={(e) => setAck((a) => ({ ...a, receivedBy: e.target.value }))}
                    />
                  </div>
                  <div className="space-y-1">
                    <Label className="text-xs">Designation</Label>
                    <Input
                      className="h-8"
                      value={ack.designation}
                      onChange={(e) => setAck((a) => ({ ...a, designation: e.target.value }))}
                    />
                  </div>
                  <div className="space-y-1">
                    <Label className="text-xs">Mobile (optional)</Label>
                    <Input
                      className="h-8"
                      value={ack.receiverMobile}
                      onChange={(e) => setAck((a) => ({ ...a, receiverMobile: e.target.value }))}
                    />
                  </div>
                  <div className="space-y-1">
                    <Label className="text-xs">Receiving Date *</Label>
                    <DateInput
                      className="h-8"
                      value={ack.receivedDateText}
                      onChange={(t) => setAck((a) => ({ ...a, receivedDateText: t }))}
                    />
                  </div>
                  <div className="space-y-1">
                    <Label className="text-xs">Receiving Time</Label>
                    <Input
                      className="h-8"
                      type="time"
                      value={ack.receivedTime}
                      onChange={(e) => setAck((a) => ({ ...a, receivedTime: e.target.value }))}
                    />
                  </div>
                  <div className="space-y-1">
                    <Label className="text-xs">Remarks</Label>
                    <Input
                      className="h-8"
                      value={ack.ackRemarks}
                      onChange={(e) => setAck((a) => ({ ...a, ackRemarks: e.target.value }))}
                    />
                  </div>
                </div>
                <div className="mt-2 flex justify-end">
                  <Button type="button" size="sm" onClick={saveAck} disabled={ackBusy}>
                    {ackBusy ? "Saving..." : details.receivedBy ? "Update Acknowledgement" : "Save Acknowledgement"}
                  </Button>
                </div>
              </div>

              {/* attachments */}
              <div className="rounded-md border p-3">
                <div className="mb-2 text-xs font-semibold uppercase text-muted-foreground">
                  Attachments (PDF / JPG / PNG — stay permanently attached)
                </div>
                <div className="grid gap-2 sm:grid-cols-3">
                  {(
                    [
                      ["signed", "Signed Covering Letter", details.signedLetterPath],
                      ["ack", "Acknowledgement Copy", details.ackCopyPath],
                      ["support", "POD / Supporting Docs", details.supportingPath],
                    ] as const
                  ).map(([kind, label, path]) => (
                    <div key={kind} className="rounded border p-2">
                      <div className="text-xs font-medium">{label}</div>
                      <div className="mt-1 flex items-center gap-2">
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          className="h-6 px-2 text-xs"
                          disabled={uploading}
                          onClick={() => startUpload(kind)}
                        >
                          {path ? "Replace" : "Upload"}
                        </Button>
                        {path && (
                          <>
                            <a
                              href={`/api/uploads/${path}`}
                              target="_blank"
                              rel="noreferrer"
                              className="text-xs text-primary underline"
                            >
                              View
                            </a>
                            <a
                              href={`/api/uploads/${path}`}
                              download
                              className="text-xs text-primary underline"
                            >
                              Download
                            </a>
                          </>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          )}
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => details && window.open(`/print/submission/${details.id}`, "_blank")}
            >
              Print Covering Letter
            </Button>
            <Button variant="outline" onClick={() => setDetails(null)}>
              Close
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ------- invoice history dialog ------- */}
      <Dialog open={!!history} onOpenChange={(o) => !o && setHistory(null)}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Invoice History — {history?.invoiceNo}</DialogTitle>
            <DialogDescription>Complete submission lifecycle of this invoice.</DialogDescription>
          </DialogHeader>
          <div className="space-y-0.5">
            {history?.steps.map((s, i) => (
              <div key={i} className="flex items-start gap-2 text-sm">
                <span className="mt-1 h-2 w-2 shrink-0 rounded-full bg-primary" />
                <div>
                  <span className="font-medium">{s.label}</span>
                  <span className="text-muted-foreground">
                    {" "}
                    — {s.detail}
                    {s.date ? ` (${formatDate(s.date)})` : ""}
                  </span>
                </div>
              </div>
            ))}
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
