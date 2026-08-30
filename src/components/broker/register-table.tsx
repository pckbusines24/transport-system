"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import type { ColumnDef } from "@tanstack/react-table";
import { Trash2 } from "lucide-react";
import { formatDate, formatMoney } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useToast } from "@/components/ui/use-toast";
import { DataTable, type DataTableColumnMeta } from "@/components/data/data-table";
import { ExportButton } from "@/components/data/export-button";
import {
  deleteBrokerSlip,
  setBrokerSlipPodAttached,
  setBrokerSlipPodFile,
} from "@/app/(app)/broker/actions";
import { brokerBalanceStatus } from "@/lib/broker-status";

export interface BrokerRegisterRow {
  id: string;
  slipNo: string;
  slipDate: string;
  vehicle: string;
  transporter: string;
  owner: string;
  loadStation: string;
  destination: string;
  qty: number;
  actualWt: number;
  pFreight: number;
  pBalance: number;
  vFreight: number;
  vNetAmt: number;
  vAdvance: number;
  vBalance: number;
  pAdvance: number;
  pNetAmt: number;
  /** informational only — POD handed over / shared */
  podAttached: boolean;
  podFilePath: string | null;
  podFileName: string | null;
  podUploadDate: string | null;
  pPaymentStatus: string; // PENDING | RECEIVED
  pPaidAmount: number;
  pRoundOff: number;
  pShortage: number;
  pPaymentDate: string | null;
  vPaymentStatus: string; // PENDING | PAID
  vPaidAmount: number;
  vRoundOff: number;
  vShortage: number;
  vPaymentDate: string | null;
  unloadDate: string | null;
  createdAt: string;
  createdBy: string;
}

function StatusLine({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between gap-4 py-0.5">
      <span className="text-muted-foreground">{label}</span>
      <span className="text-right font-medium tabular-nums">{value}</span>
    </div>
  );
}

/** Balance still open once cash, shortage and round-off are accounted for. */
const openBalance = (balance: number, paid: number, shortage: number, roundOff: number) =>
  Math.max(0, Math.round((balance - paid - shortage - roundOff) * 100) / 100);

const statusOf = (r: BrokerRegisterRow, side: "P" | "V") =>
  brokerBalanceStatus({
    side,
    paymentStatus: side === "P" ? r.pPaymentStatus : r.vPaymentStatus,
    paidAmount: side === "P" ? r.pPaidAmount : r.vPaidAmount,
    roundOff: side === "P" ? r.pRoundOff : r.vRoundOff,
    shortage: side === "P" ? r.pShortage : r.vShortage,
    balance: side === "P" ? r.pBalance : r.vBalance,
  });

const money = (
  key: keyof Pick<
    BrokerRegisterRow,
    "pFreight" | "pAdvance" | "pBalance" | "vFreight" | "vAdvance" | "vBalance"
  >,
  header: string
): ColumnDef<BrokerRegisterRow> => ({
  accessorKey: key,
  header,
  cell: ({ row }) => formatMoney(row.original[key]),
  meta: {
    numeric: true,
    total: (rows) => formatMoney(rows.reduce((s, r) => s + r[key], 0)),
  } satisfies DataTableColumnMeta<BrokerRegisterRow>,
});

export function BrokerRegisterTable({
  data,
  canDelete,
}: {
  data: BrokerRegisterRow[];
  canDelete: boolean;
}) {
  const router = useRouter();
  // ret = this register view's filters — the slip page returns here with
  // them intact after save / settle
  const searchParams = useSearchParams();
  const ret = encodeURIComponent(searchParams.toString());
  const { toast } = useToast();
  const [toDelete, setToDelete] = React.useState<BrokerRegisterRow | null>(null);
  const [deleting, setDeleting] = React.useState(false);

  // slip status timeline dialog
  const [statusRow, setStatusRow] = React.useState<BrokerRegisterRow | null>(null);
  // POD upload
  const fileInputRef = React.useRef<HTMLInputElement>(null);
  const uploadRowRef = React.useRef<BrokerRegisterRow | null>(null);
  const [uploading, setUploading] = React.useState(false);

  const startPodUpload = React.useCallback((row: BrokerRegisterRow) => {
    uploadRowRef.current = row;
    fileInputRef.current?.click();
  }, []);

  const handlePodFile = async (file: File | null) => {
    const row = uploadRowRef.current;
    if (!file || !row) return;
    setUploading(true);
    try {
      const fd = new FormData();
      fd.append("file", file);
      const res = await fetch("/api/uploads/pod", { method: "POST", body: fd });
      const json = await res.json();
      if (!res.ok || !json.ok) throw new Error(json.error ?? "Upload failed");
      const saved = await setBrokerSlipPodFile(row.id, json.path, file.name);
      if (!saved.ok) throw new Error(saved.error);
      toast({ title: `POD uploaded for slip ${row.slipNo}` });
      router.refresh();
    } catch (err) {
      toast({
        variant: "destructive",
        title: "POD upload failed",
        description: err instanceof Error ? err.message : undefined,
      });
    } finally {
      setUploading(false);
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  };

  const togglePod = React.useCallback(async (row: BrokerRegisterRow, attached: boolean) => {
    const res = await setBrokerSlipPodAttached(row.id, attached);
    if (res.ok) {
      toast({
        title: attached
          ? `POD marked attached for slip ${row.slipNo}`
          : `POD attached flag cleared for slip ${row.slipNo}`,
        description: "Record-keeping only — no effect on payments or billing.",
      });
      router.refresh();
    } else {
      toast({ variant: "destructive", title: "Update failed", description: res.error });
    }
  }, [router, toast]);

  const confirmDelete = async () => {
    if (!toDelete) return;
    setDeleting(true);
    try {
      const res = await deleteBrokerSlip(toDelete.id);
      if (res.ok) {
        toast({ title: `Broker slip ${toDelete.slipNo} deleted` });
        setToDelete(null);
        router.refresh();
      } else {
        toast({ variant: "destructive", title: "Delete failed", description: res.error });
      }
    } finally {
      setDeleting(false);
    }
  };

  const columns: ColumnDef<BrokerRegisterRow>[] = React.useMemo(() => [
    { accessorKey: "slipNo", header: "Slip No" },
    {
      accessorKey: "slipDate",
      header: "Slip Date",
      cell: ({ row }) => formatDate(row.original.slipDate),
    },
    { accessorKey: "vehicle", header: "Vehicle No" },
    { accessorKey: "transporter", header: "Transporter / Broker" },
    { accessorKey: "owner", header: "Owner" },
    { accessorKey: "loadStation", header: "From" },
    { accessorKey: "destination", header: "To" },
    {
      accessorKey: "qty",
      header: "Qty",
      cell: ({ row }) => row.original.qty.toLocaleString("en-IN", { maximumFractionDigits: 3 }),
      meta: {
        numeric: true,
        total: (rows) =>
          rows.reduce((s, r) => s + r.qty, 0).toLocaleString("en-IN", { maximumFractionDigits: 3 }),
      } satisfies DataTableColumnMeta<BrokerRegisterRow>,
    },
    money("pFreight", "Broker Freight"),
    money("pAdvance", "Broker Advance"),
    money("pBalance", "Broker Balance"),
    {
      accessorKey: "pPaymentStatus",
      header: "Broker Balance Status",
      cell: ({ row }) => (
        <div className="flex items-center gap-1" onClick={(e) => e.stopPropagation()}>
          {row.original.pPaymentStatus === "RECEIVED" ? (
            <Badge>
              {statusOf(row.original, "P")} {formatMoney(row.original.pPaidAmount)}
            </Badge>
          ) : (
            <>
              <Badge variant="destructive">Pending</Badge>
              {/* settled inside the slip now, next to the figures it settles,
                  so it can be reviewed and corrected rather than write-once */}
              <Button asChild variant="secondary" size="sm" className="h-6 px-2 text-xs">
                <Link
                  href={`/broker/slip?id=${row.original.id}&ret=${ret}#balance-receivable`}
                  onClick={(e: React.MouseEvent) => e.stopPropagation()}
                >
                  Receive
                </Link>
              </Button>
            </>
          )}
        </div>
      ),
    },
    money("vFreight", "Owner Freight"),
    money("vAdvance", "Owner Advance"),
    money("vBalance", "Owner Balance"),
    {
      accessorKey: "vPaymentStatus",
      header: "Owner Balance Status",
      cell: ({ row }) => (
        <div className="flex items-center gap-1" onClick={(e) => e.stopPropagation()}>
          {row.original.vPaymentStatus === "PAID" ? (
            <Badge>
              {statusOf(row.original, "V")} {formatMoney(row.original.vPaidAmount)}
            </Badge>
          ) : (
            <>
              <Badge variant="destructive">Pending</Badge>
              <Button asChild variant="secondary" size="sm" className="h-6 px-2 text-xs">
                <Link
                  href={`/broker/slip?id=${row.original.id}&ret=${ret}#balance-payable`}
                  onClick={(e: React.MouseEvent) => e.stopPropagation()}
                >
                  Pay
                </Link>
              </Button>
            </>
          )}
        </div>
      ),
    },
    {
      id: "pod",
      header: "POD",
      cell: ({ row }) => {
        const r = row.original;
        return (
          <div className="flex items-center gap-1" onClick={(e) => e.stopPropagation()}>
            <Button
              variant="outline"
              size="sm"
              className="h-6 px-2 text-xs"
              disabled={uploading}
              title="Upload POD (pdf / jpg / png)"
              onClick={() => startPodUpload(r)}
            >
              {r.podFilePath ? "Re-upload" : "Upload"}
            </Button>
            {r.podFilePath && (
              <>
                <a
                  href={`/api/uploads/${r.podFilePath}`}
                  target="_blank"
                  rel="noreferrer"
                  className="text-xs text-primary underline"
                  title="View / open the POD PDF in a new tab"
                >
                  View
                </a>
                <a
                  href={`/api/uploads/${r.podFilePath}`}
                  download={r.podFileName ?? "pod"}
                  className="text-xs text-primary underline"
                  title="Download the POD PDF"
                >
                  Download
                </a>
              </>
            )}
          </div>
        );
      },
    },
    {
      accessorKey: "podAttached",
      header: "POD Attached",
      cell: ({ row }) => (
        <div
          className="flex items-center gap-1.5"
          onClick={(e) => e.stopPropagation()}
          title="Record-keeping only — POD handed over / shared. No effect on payments."
        >
          <Switch
            checked={row.original.podAttached}
            onCheckedChange={(c) => void togglePod(row.original, c)}
          />
          <span className="text-xs text-muted-foreground">
            {row.original.podAttached ? "Yes" : "No"}
          </span>
        </div>
      ),
    },
    {
      id: "print",
      header: "Print",
      cell: ({ row }) => (
        <a
          href={`/print/broker-slip/${row.original.id}`}
          target="_blank"
          rel="noreferrer"
          className="text-xs text-primary underline"
          onClick={(e) => e.stopPropagation()}
          title="Two-page print: broker (receivable) + owner (payable)"
        >
          Print
        </a>
      ),
    },
    {
      id: "slipStatus",
      header: "Slip Status",
      cell: ({ row }) => (
        <Button
          variant="outline"
          size="sm"
          className="h-6 px-2 text-xs"
          onClick={(e) => {
            e.stopPropagation();
            setStatusRow(row.original);
          }}
        >
          Status
        </Button>
      ),
    },
    ...(canDelete
      ? [
          {
            id: "actions",
            header: "",
            cell: ({ row }) => (
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className="h-7 w-7 text-destructive"
                onClick={(e) => {
                  e.stopPropagation();
                  setToDelete(row.original);
                }}
              >
                <Trash2 className="h-4 w-4" />
              </Button>
            ),
          } satisfies ColumnDef<BrokerRegisterRow>,
        ]
      : []),
  ], [canDelete, ret, startPodUpload, togglePod, uploading]);

  return (
    <div className="space-y-2">
      <div className="flex justify-end">
        <ExportButton
          rows={data}
          fileName="broker-register"
          sheetName="Broker Register"
          columns={[
            { header: "Slip No", key: "slipNo" },
            { header: "Slip Date", accessor: (r) => formatDate(r.slipDate) },
            { header: "Vehicle No", key: "vehicle" },
            { header: "Transporter / Broker", key: "transporter" },
            { header: "Owner", key: "owner" },
            { header: "From", key: "loadStation" },
            { header: "To", key: "destination" },
            { header: "Qty", key: "qty", numeric: true },
            { header: "Broker Freight", key: "pFreight", numeric: true },
            { header: "Broker Advance", key: "pAdvance", numeric: true },
            { header: "Broker Balance", key: "pBalance", numeric: true },
            { header: "Broker Balance Status", accessor: (r) => statusOf(r, "P") },
            { header: "Owner Freight", key: "vFreight", numeric: true },
            { header: "Owner Advance", key: "vAdvance", numeric: true },
            { header: "Owner Balance", key: "vBalance", numeric: true },
            { header: "Owner Balance Status", accessor: (r) => statusOf(r, "V") },
            { header: "POD Uploaded", accessor: (r) => (r.podFilePath ? "YES" : "NO") },
            { header: "POD Attached", accessor: (r) => (r.podAttached ? "YES" : "NO") },
          ]}
        />
      </div>
      <DataTable
        columns={columns}
        data={data}
        emptyMessage="No broker slips found."
        onRowClick={(row) => router.push(`/broker/slip?id=${row.id}&ret=${ret}`)}
      />

      {/* hidden input for register-side POD uploads */}
      <input
        ref={fileInputRef}
        type="file"
        accept=".pdf,.jpg,.jpeg,.png,application/pdf,image/jpeg,image/png"
        className="hidden"
        onChange={(e) => void handlePodFile(e.target.files?.[0] ?? null)}
      />

      {/* slip status — complete lifecycle in one view */}
      <Dialog open={!!statusRow} onOpenChange={(o) => !o && setStatusRow(null)}>
        <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>Slip Status — {statusRow?.slipNo}</DialogTitle>
            <DialogDescription>
              Complete lifecycle and current position of this broker slip.
            </DialogDescription>
          </DialogHeader>
          {statusRow && (
            <div className="grid gap-3 text-sm sm:grid-cols-2">
              <div className="rounded-md border p-3">
                <div className="mb-1 text-xs font-semibold uppercase text-muted-foreground">
                  Slip Information
                </div>
                <StatusLine label="Slip Created" value={formatDate(statusRow.createdAt)} />
                <StatusLine label="Slip Date" value={formatDate(statusRow.slipDate)} />
                <StatusLine label="Created By" value={statusRow.createdBy || "—"} />
                <StatusLine label="Vehicle" value={statusRow.vehicle || "—"} />
                <StatusLine
                  label="Route"
                  value={`${statusRow.loadStation || "?"} → ${statusRow.destination || "?"}`}
                />
              </div>
              <div className="rounded-md border p-3">
                <div className="mb-1 text-xs font-semibold uppercase text-muted-foreground">
                  Delivery Information
                </div>
                <StatusLine
                  label="POD Uploaded"
                  value={
                    statusRow.podFilePath
                      ? `Yes${statusRow.podUploadDate ? ` — ${formatDate(statusRow.podUploadDate)}` : ""}`
                      : "No"
                  }
                />
                <StatusLine
                  label="POD Handed Over"
                  value={statusRow.podAttached ? "Yes" : "No"}
                />
                <StatusLine
                  label="Unload Date"
                  value={statusRow.unloadDate ? formatDate(statusRow.unloadDate) : "—"}
                />
                <StatusLine
                  label="Delivery Status"
                  value={statusRow.unloadDate || statusRow.podFilePath ? "Delivered" : "In Transit"}
                />
              </div>
              <div className="rounded-md border p-3">
                <div className="mb-1 text-xs font-semibold uppercase text-muted-foreground">
                  Broker Side (Receivable)
                </div>
                <StatusLine label="Broker" value={statusRow.transporter || "—"} />
                <StatusLine label="Broker Freight" value={formatMoney(statusRow.pFreight)} />
                <StatusLine label="Advance Given" value={formatMoney(statusRow.pAdvance)} />
                <StatusLine label="Balance Amount" value={formatMoney(statusRow.pBalance)} />
                {/* what was knocked off the balance, so the received figure
                    reconciles instead of just looking short */}
                {statusRow.pShortage > 0 && (
                  <StatusLine label="Less: Shortage" value={formatMoney(statusRow.pShortage)} />
                )}
                {Math.abs(statusRow.pRoundOff) > 0.009 && (
                  <StatusLine
                    label={statusRow.pRoundOff > 0 ? "Less: Round Off" : "Add: Round Off"}
                    value={formatMoney(Math.abs(statusRow.pRoundOff))}
                  />
                )}
                <StatusLine
                  label="Payment Received"
                  value={
                    statusRow.pPaymentStatus === "RECEIVED"
                      ? `${formatMoney(statusRow.pPaidAmount)}${statusRow.pPaymentDate ? ` on ${formatDate(statusRow.pPaymentDate)}` : ""}`
                      : "—"
                  }
                />
                <StatusLine label="Balance Status" value={statusOf(statusRow, "P")} />
              </div>
              <div className="rounded-md border p-3">
                <div className="mb-1 text-xs font-semibold uppercase text-muted-foreground">
                  Owner Side (Payable)
                </div>
                <StatusLine label="Owner" value={statusRow.owner || "—"} />
                <StatusLine label="Owner Freight" value={formatMoney(statusRow.vFreight)} />
                <StatusLine label="Advance Paid" value={formatMoney(statusRow.vAdvance)} />
                <StatusLine label="Balance Amount" value={formatMoney(statusRow.vBalance)} />
                {statusRow.vShortage > 0 && (
                  <StatusLine label="Less: Shortage" value={formatMoney(statusRow.vShortage)} />
                )}
                {Math.abs(statusRow.vRoundOff) > 0.009 && (
                  <StatusLine
                    label={statusRow.vRoundOff > 0 ? "Less: Round Off" : "Add: Round Off"}
                    value={formatMoney(Math.abs(statusRow.vRoundOff))}
                  />
                )}
                <StatusLine
                  label="Payment Made"
                  value={
                    statusRow.vPaymentStatus === "PAID"
                      ? `${formatMoney(statusRow.vPaidAmount)}${statusRow.vPaymentDate ? ` on ${formatDate(statusRow.vPaymentDate)}` : ""}`
                      : "—"
                  }
                />
                <StatusLine label="Payment Status" value={statusOf(statusRow, "V")} />
              </div>
              <div className="rounded-md border p-3 sm:col-span-2">
                <div className="mb-1 text-xs font-semibold uppercase text-muted-foreground">
                  Financial Status
                </div>
                <div className="grid gap-x-8 sm:grid-cols-2">
                  <StatusLine
                    label="Total Broker Receivable"
                    value={formatMoney(statusRow.pNetAmt)}
                  />
                  <StatusLine label="Total Owner Payable" value={formatMoney(statusRow.vNetAmt)} />
                  {/* outstanding is the balance less everything that settled
                      it — cash, shortage and round-off. Showing the full
                      balance until the status flips read as unpaid even after
                      a part payment. */}
                  <StatusLine
                    label="Outstanding (Receivable)"
                    value={formatMoney(
                      openBalance(
                        statusRow.pBalance,
                        statusRow.pPaidAmount,
                        statusRow.pShortage,
                        statusRow.pRoundOff
                      )
                    )}
                  />
                  <StatusLine
                    label="Outstanding (Payable)"
                    value={formatMoney(
                      openBalance(
                        statusRow.vBalance,
                        statusRow.vPaidAmount,
                        statusRow.vShortage,
                        statusRow.vRoundOff
                      )
                    )}
                  />
                  <StatusLine
                    label="Settlement Status"
                    value={
                      statusRow.pPaymentStatus === "RECEIVED" && statusRow.vPaymentStatus === "PAID"
                        ? "Fully Settled"
                        : statusRow.pPaymentStatus === "RECEIVED" ||
                            statusRow.vPaymentStatus === "PAID"
                          ? "Partially Settled"
                          : "Unsettled"
                    }
                  />
                  <StatusLine
                    label="Margin (Broker − Owner)"
                    value={formatMoney(statusRow.pNetAmt - statusRow.vNetAmt)}
                  />
                </div>
              </div>
            </div>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => setStatusRow(null)}>
              Close
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>


      <Dialog open={!!toDelete} onOpenChange={(o) => !o && setToDelete(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete broker slip {toDelete?.slipNo}?</DialogTitle>
            <DialogDescription>
              The slip will be soft-deleted and removed from registers. This cannot be undone here.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setToDelete(null)} disabled={deleting}>
              Cancel
            </Button>
            <Button variant="destructive" onClick={confirmDelete} disabled={deleting}>
              {deleting ? "Deleting..." : "Delete"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
