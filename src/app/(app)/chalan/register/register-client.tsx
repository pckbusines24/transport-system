"use client";

import * as React from "react";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import type { ColumnDef } from "@tanstack/react-table";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { useToast } from "@/components/ui/use-toast";
import { DataTable } from "@/components/data/data-table";
import { FilterBar } from "@/components/data/filter-bar";
import { ExportButton } from "@/components/data/export-button";
import { formatDate, formatMoney } from "@/lib/utils";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { cancelChalan, deleteChalan, getChalanStatus, restoreChalan, type ChalanStatusData } from "../actions";
import { Input } from "@/components/ui/input";

export interface ChalanRegisterRow {
  id: string;
  chalanNo: string;
  chalanDate: string;
  broker: string;
  vehicle: string;
  lrCount: number;
  freight: number;
  tdsAmt: number;
  commissionAmt: number;
  advanceTotal: number;
  balance: number;
  mamool: number;
  courierCharge: number;
  isFinal: boolean;
  podDone: number;
  /** shortage weight from the LRs' PODs (before balance payment) */
  shortageWt: number;
  /** shortage amount deducted at balance payment (after) */
  shortage: number;
  /** round-off applied at balance payment */
  roundOff: number;
  paymentStatus: string;
  balPaidAmount: number;
  /** live bill settlement across this chalan's LRs: NOT BILLED | UNPAID | PARTLY PAID | PAID */
  billStatus: string;
  /** accident / rejection cancel — record kept, accrual reversed */
  cancelled: boolean;
  cancelReason: string;
}

const sum = (rows: ChalanRegisterRow[], k: keyof ChalanRegisterRow) =>
  formatMoney(rows.reduce((s, r) => s + (r[k] as number), 0));

export function ChalanRegisterClient({
  rows,
  mode,
  view,
  brokers,
  vehicles,
  canDelete,
}: {
  rows: ChalanRegisterRow[];
  /** MARKET = payable workflow (default); OWNREL = own + relative, no payment actions */
  mode: "MARKET" | "OWNREL";
  /** ACTIVE = the normal register; CANCELLED = this tab's Cancel Register */
  view: "ACTIVE" | "CANCELLED";
  brokers: { value: string; label: string }[];
  vehicles: { value: string; label: string }[];
  canDelete: boolean;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const { toast } = useToast();
  const isMarket = mode === "MARKET";
  // switch tabs keeping every other filter intact
  const tabHref = (type: "MARKET" | "OWNREL") => {
    const p = new URLSearchParams(searchParams.toString());
    if (type === "OWNREL") p.set("type", "OWNREL");
    else p.delete("type");
    // a vehicle/ownership picked in one tab means nothing in the other
    p.delete("vehicle");
    p.delete("ownership");
    p.delete("payment");
    const qs = p.toString();
    return `${pathname}${qs ? `?${qs}` : ""}`;
  };
  // Active <-> Cancel Register of the SAME tab, keeping the other filters
  const viewHref = (v: "ACTIVE" | "CANCELLED") => {
    const p = new URLSearchParams(searchParams.toString());
    if (v === "CANCELLED") p.set("view", "CANCELLED");
    else p.delete("view");
    p.delete("payment");
    const qs = p.toString();
    return `${pathname}${qs ? `?${qs}` : ""}`;
  };
  const isCancelledView = view === "CANCELLED";
  // complete chalan lifecycle dialog
  const [status, setStatus] = React.useState<ChalanStatusData | null>(null);
  const [statusLoading, setStatusLoading] = React.useState(false);
  // accident / rejection cancel dialog
  const [toCancel, setToCancel] = React.useState<ChalanRegisterRow | null>(null);
  const [cancelReason, setCancelReason] = React.useState("");
  const [cancelling, setCancelling] = React.useState(false);

  const confirmCancel = async () => {
    if (!toCancel) return;
    setCancelling(true);
    try {
      const res = await cancelChalan(toCancel.id, cancelReason.trim());
      if (res.ok) {
        toast({
          title: `Chalan ${toCancel.chalanNo} cancelled`,
          description:
            res.advanceCreated > 0
              ? `${formatMoney(res.advanceCreated)} moved to the Chalan Cancel Advance Register — recover it or adjust it in the next chalan.`
              : "No advances were on it; the payable has been reversed.",
        });
        setToCancel(null);
        setCancelReason("");
        router.refresh();
      } else toast({ variant: "destructive", title: "Cancel failed", description: res.error });
    } finally {
      setCancelling(false);
    }
  };

  const openStatus = React.useCallback(async (id: string) => {
    setStatusLoading(true);
    try {
      const res = await getChalanStatus(id);
      if (res.ok) setStatus(res.data);
      else toast({ variant: "destructive", title: res.error });
    } finally {
      setStatusLoading(false);
    }
  }, [toast]);

  const columns: ColumnDef<ChalanRegisterRow>[] = React.useMemo(() => [
    { accessorKey: "chalanNo", header: "Chalan No" },
    {
      accessorKey: "chalanDate",
      header: "Date",
      cell: ({ row }) => formatDate(row.original.chalanDate),
    },
    { accessorKey: "broker", header: "Broker" },
    { accessorKey: "vehicle", header: "Vehicle" },
    {
      accessorKey: "lrCount",
      header: "Total LRs",
      meta: { numeric: true, total: (r: ChalanRegisterRow[]) => r.reduce((s, x) => s + x.lrCount, 0) },
    },
    {
      accessorKey: "freight",
      header: "Freight",
      cell: ({ row }) => formatMoney(row.original.freight),
      meta: { numeric: true, total: (r: ChalanRegisterRow[]) => sum(r, "freight") },
    },
    {
      accessorKey: "tdsAmt",
      header: "TDS",
      cell: ({ row }) => formatMoney(row.original.tdsAmt),
      meta: { numeric: true, total: (r: ChalanRegisterRow[]) => sum(r, "tdsAmt") },
    },
    {
      accessorKey: "commissionAmt",
      header: "Commission",
      cell: ({ row }) => formatMoney(row.original.commissionAmt),
      meta: { numeric: true, total: (r: ChalanRegisterRow[]) => sum(r, "commissionAmt") },
    },
    {
      accessorKey: "mamool",
      header: "Mamul",
      cell: ({ row }) => (row.original.mamool ? formatMoney(row.original.mamool) : ""),
      meta: { numeric: true, total: (r: ChalanRegisterRow[]) => sum(r, "mamool") },
    },
    {
      accessorKey: "courierCharge",
      header: "Courier",
      cell: ({ row }) => (row.original.courierCharge ? formatMoney(row.original.courierCharge) : ""),
      meta: { numeric: true, total: (r: ChalanRegisterRow[]) => sum(r, "courierCharge") },
    },
    {
      accessorKey: "advanceTotal",
      header: "Advance",
      cell: ({ row }) => formatMoney(row.original.advanceTotal),
      meta: { numeric: true, total: (r: ChalanRegisterRow[]) => sum(r, "advanceTotal") },
    },
    {
      accessorKey: "balance",
      header: "Balance",
      cell: ({ row }) => formatMoney(row.original.balance),
      meta: { numeric: true, total: (r: ChalanRegisterRow[]) => sum(r, "balance") },
    },
    {
      accessorKey: "isFinal",
      header: "Status",
      cell: ({ row }) =>
        row.original.cancelled ? (
          <Badge variant="destructive" title={row.original.cancelReason || undefined}>
            Cancelled
          </Badge>
        ) : row.original.isFinal ? (
          <Badge>Final</Badge>
        ) : (
          <Badge variant="secondary">Draft</Badge>
        ),
    },
    // the Cancel Register shows WHY each chalan was cancelled
    ...(isCancelledView
      ? [
          {
            accessorKey: "cancelReason",
            header: "Cancel Reason",
            cell: ({ row }) => (
              <span className="max-w-[220px] truncate text-xs" title={row.original.cancelReason}>
                {row.original.cancelReason || "—"}
              </span>
            ),
          } as ColumnDef<ChalanRegisterRow>,
        ]
      : []),
    {
      id: "podStatus",
      header: "POD Status",
      cell: ({ row }) => {
        const { podDone, lrCount, vehicle } = row.original;
        if (lrCount === 0) return <Badge variant="outline">—</Badge>;
        const complete = podDone === lrCount;
        return (
          <Link
            href={`/pod?vehicle=${encodeURIComponent(vehicle)}`}
            title="Open POD for this vehicle"
            onClick={(e) => e.stopPropagation()}
          >
            <Badge
              variant={complete ? "default" : "secondary"}
              className="cursor-pointer hover:opacity-80"
            >
              POD {podDone}/{lrCount}
            </Badge>
          </Link>
        );
      },
    },
    {
      accessorKey: "shortageWt",
      header: "Shortage Wt",
      cell: ({ row }) => (row.original.shortageWt ? row.original.shortageWt : ""),
      meta: {
        numeric: true,
        total: (r: ChalanRegisterRow[]) =>
          Math.round(r.reduce((s, x) => s + x.shortageWt, 0) * 1000) / 1000 || "",
      },
    },
    {
      accessorKey: "shortage",
      header: "Shortage Paid",
      cell: ({ row }) =>
        row.original.paymentStatus === "PAID" && row.original.shortage
          ? formatMoney(row.original.shortage)
          : "",
      meta: { numeric: true, total: (r: ChalanRegisterRow[]) => sum(r, "shortage") },
    },
    {
      accessorKey: "roundOff",
      header: "Round Off",
      cell: ({ row }) =>
        row.original.paymentStatus === "PAID" && row.original.roundOff
          ? formatMoney(row.original.roundOff)
          : "",
      meta: { numeric: true, total: (r: ChalanRegisterRow[]) => sum(r, "roundOff") },
    },
    // payment status is a MARKET concept — own/relative settlement lives in the ledger
    ...(isMarket
      ? [
          {
            accessorKey: "paymentStatus",
            header: "Balance Payment",
            cell: ({ row }) =>
              row.original.cancelled ? (
                <Badge variant="outline">—</Badge>
              ) : row.original.paymentStatus === "PAID" ? (
                <Badge>Paid {formatMoney(row.original.balPaidAmount)}</Badge>
              ) : (
                <Badge variant="destructive">Pending Balance</Badge>
              ),
          } as ColumnDef<ChalanRegisterRow>,
        ]
      : []),
    {
      accessorKey: "billStatus",
      header: "Bill Status",
      // derived live from voucher allocations, so it follows every receipt
      cell: ({ row }) => {
        const s = row.original.billStatus;
        if (s === "NOT BILLED") return <Badge variant="outline">Not Billed</Badge>;
        if (s === "PAID") return <Badge>Paid</Badge>;
        if (s === "PARTLY PAID") return <Badge variant="secondary">Partly Paid</Badge>;
        return <Badge variant="destructive">Unpaid</Badge>;
      },
    },
    {
      id: "actions",
      header: "",
      enableSorting: false,
      cell: ({ row }) => (
        <div className="flex gap-1" onClick={(e) => e.stopPropagation()}>
          <Button asChild variant="ghost" size="sm" className="h-7 px-2">
            {/* ret = this register view's filters — the chalan page returns
                here with them intact after save / balance pay */}
            <Link href={`/chalan?id=${row.original.id}&ret=${encodeURIComponent(searchParams.toString())}`}>Edit</Link>
          </Button>
          {isMarket &&
            row.original.isFinal &&
            !row.original.cancelled &&
            row.original.paymentStatus !== "PAID" &&
            row.original.lrCount > 0 &&
            row.original.podDone >= row.original.lrCount && (
              <Button asChild variant="secondary" size="sm" className="h-7 px-2">
                <Link href={`/chalan?id=${row.original.id}&ret=${encodeURIComponent(searchParams.toString())}#balance`}>Balance Pay</Link>
              </Button>
            )}
          <Button asChild variant="ghost" size="sm" className="h-7 px-2">
            <Link href={`/print/chalan/${row.original.id}`} target="_blank">
              Print
            </Link>
          </Button>
          <Button
            variant="outline"
            size="sm"
            className="h-7 px-2"
            disabled={statusLoading}
            title="Complete lifecycle: LRs, billing, payments"
            onClick={() => void openStatus(row.original.id)}
          >
            Status
          </Button>
          {canDelete && row.original.cancelled && (
            <Button
              variant="outline"
              size="sm"
              className="h-7 px-2"
              title="Undo the cancel: accrual re-posts, the cancel advance is removed (only while unadjusted). Re-attach LRs from Edit."
              onClick={async () => {
                if (!confirm(`Restore cancelled chalan ${row.original.chalanNo}? LRs must be re-attached from Edit.`)) return;
                const res = await restoreChalan(row.original.id);
                if (res.ok) {
                  toast({ title: `Chalan ${row.original.chalanNo} restored` });
                  router.refresh();
                } else toast({ variant: "destructive", title: "Restore failed", description: res.error });
              }}
            >
              Restore
            </Button>
          )}
          {canDelete && !row.original.cancelled && (
            <Button
              variant="outline"
              size="sm"
              className="h-7 px-2 text-destructive"
              title="Accident / rejection: keep the record, reverse the payable, advances become an open advance on the broker"
              onClick={() => setToCancel(row.original)}
            >
              Cancel
            </Button>
          )}
          {canDelete && (
            <Button
              variant="ghost"
              size="sm"
              className="h-7 px-2 text-destructive"
              onClick={async () => {
                if (!confirm(`Delete chalan ${row.original.chalanNo}?`)) return;
                const res = await deleteChalan(row.original.id);
                if (res.ok) {
                  toast({ title: "Chalan deleted" });
                  router.refresh();
                } else {
                  toast({ variant: "destructive", title: "Delete failed", description: res.error });
                }
              }}
            >
              Delete
            </Button>
          )}
        </div>
      ),
    },
  ], [isCancelledView, isMarket, searchParams, statusLoading, openStatus, canDelete, router, toast]);

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <h1 className="text-xl font-semibold">
            {isCancelledView ? "Cancel Chalan Register" : "Chalan Register"}
          </h1>
          {/* two registers, one screen: payment work vs ledger-side record */}
          <div className="flex rounded-md border p-0.5">
            <Button
              asChild
              size="sm"
              variant={isMarket ? "default" : "ghost"}
              className="h-7 px-3"
            >
              <Link href={tabHref("MARKET")}>Market / Broker</Link>
            </Button>
            <Button
              asChild
              size="sm"
              variant={!isMarket ? "default" : "ghost"}
              className="h-7 px-3"
            >
              <Link href={tabHref("OWNREL")}>Own / Relative</Link>
            </Button>
          </div>
          {/* the tab's own Cancel Register — cancelled chalans live only here */}
          <div className="flex rounded-md border p-0.5">
            <Button asChild size="sm" variant={!isCancelledView ? "default" : "ghost"} className="h-7 px-3">
              <Link href={viewHref("ACTIVE")}>Active</Link>
            </Button>
            <Button
              asChild
              size="sm"
              variant={isCancelledView ? "destructive" : "ghost"}
              className="h-7 px-3"
            >
              <Link href={viewHref("CANCELLED")}>Cancelled</Link>
            </Button>
          </div>
        </div>
        <div className="flex flex-wrap gap-2">
          <ExportButton
            rows={rows}
            fileName="chalan-register"
            columns={[
              // same 19-column sequence as the grid
              { header: "Chalan No", key: "chalanNo" },
              { header: "Date", accessor: (r) => formatDate(r.chalanDate) },
              { header: "Broker", key: "broker" },
              { header: "Vehicle", key: "vehicle" },
              { header: "Total LRs", key: "lrCount", numeric: true },
              { header: "Freight", key: "freight", numeric: true },
              { header: "TDS", key: "tdsAmt", numeric: true },
              { header: "Commission", key: "commissionAmt", numeric: true },
              { header: "Mamool", key: "mamool", numeric: true },
              { header: "Courier Charges", key: "courierCharge", numeric: true },
              { header: "Advance", key: "advanceTotal", numeric: true },
              { header: "Balance", key: "balance", numeric: true },
              { header: "Status", accessor: (r) => (r.isFinal ? "FINAL" : "DRAFT") },
              { header: "POD Status", accessor: (r) => (r.lrCount ? `${r.podDone}/${r.lrCount}` : "") },
              { header: "Shortage Weight", key: "shortageWt", numeric: true },
              { header: "Shortage Paid", key: "shortage", numeric: true },
              { header: "Round Off", key: "roundOff", numeric: true },
              { header: "Balance Payment", accessor: (r) => (r.paymentStatus === "PAID" ? "PAID" : "PENDING") },
              { header: "Bill Status", key: "billStatus" },
            ]}
          />
          <Button asChild size="sm" variant="outline">
            <Link href="/reports/tally-export">Tally Export</Link>
          </Button>
          <Button asChild size="sm">
            <Link href="/chalan">+ New Chalan</Link>
          </Button>
        </div>
      </div>
      <FilterBar
        filters={[
          { type: "text", key: "q", label: "Chalan No..." },
          { type: "daterange", key: "date", label: "Date" },
          { type: "combobox", key: "broker", label: "Owner / Broker / Relative", options: brokers },
          { type: "combobox", key: "vehicle", label: "Vehicle", options: vehicles },
          // the tab already fixes the ownership universe; on Own/Relative the
          // filter narrows between the two, on Market it is not needed
          ...(!isMarket
            ? [
                {
                  type: "select" as const,
                  key: "ownership",
                  label: "Ownership",
                  options: [
                    { value: "OWNER", label: "Own" },
                    { value: "RELATIVE", label: "Relative" },
                  ],
                },
              ]
            : []),
          {
            type: "select",
            key: "status",
            label: "Status",
            options: [
              { value: "final", label: "Final" },
              { value: "draft", label: "Draft" },
            ],
          },
          // balance payment is a market-vehicle workflow only
          ...(isMarket
            ? [
                {
                  type: "select" as const,
                  key: "payment",
                  label: "Balance Payment",
                  options: [
                    { value: "paid", label: "Paid" },
                    { value: "pending", label: "Pending" },
                  ],
                },
              ]
            : []),
          {
            type: "select",
            key: "shortage",
            label: "Shortage",
            options: [
              { value: "yes", label: "Yes" },
              { value: "no", label: "No" },
            ],
          },
        ]}
      />
      <DataTable
        columns={columns}
        data={rows}
        onRowClick={(row) =>
          router.push(`/chalan?id=${row.id}&ret=${encodeURIComponent(searchParams.toString())}`)
        }
      />

      {/* chalan status — complete tracking dashboard */}
      <Dialog open={!!status} onOpenChange={(o) => !o && setStatus(null)}>
        <DialogContent className="max-h-[92vh] overflow-y-auto sm:max-w-4xl">
          <DialogHeader>
            <DialogTitle>Chalan Status — {status?.chalanNo}</DialogTitle>
            <DialogDescription>
              Complete lifecycle from creation to payment: LRs, bills, and payment history.
            </DialogDescription>
          </DialogHeader>
          {status && (
            <div className="space-y-3 text-sm">
              {/* 1. chalan details */}
              <div className="rounded-md border p-3">
                <div className="mb-1 text-xs font-semibold uppercase text-muted-foreground">
                  Chalan Details
                </div>
                <div className="grid gap-x-8 gap-y-0.5 sm:grid-cols-2">
                  <Line label="Chalan No" value={status.chalanNo} />
                  <Line label="Chalan Date" value={formatDate(status.chalanDate)} />
                  <Line label="Vehicle No" value={status.vehicle} />
                  <Line label="Transporter" value={status.transporter || "—"} />
                  <Line label="Owner" value={status.owner || "—"} />
                  <Line label="Driver" value={status.driverName || "—"} />
                  <Line label="Origin" value={status.origin || "—"} />
                  <Line label="Destination" value={status.destination || "—"} />
                  <Line label="Created" value={formatDate(status.createdAt)} />
                  <Line label="Stage" value={status.isFinal ? "Final" : "Draft"} />
                </div>
              </div>

              {/* 2 + 3. LRs with billing status */}
              <div className="rounded-md border p-3">
                <div className="mb-1 text-xs font-semibold uppercase text-muted-foreground">
                  LR &amp; Billing Status
                </div>
                <div className="overflow-x-auto">
                  <table className="w-full text-xs">
                    <thead>
                      <tr className="border-b text-left text-muted-foreground">
                        {["LR No", "Date", "Consignor", "Consignee", "Qty", "Freight", "LR Status", "Bill No", "Bill Date", "Bill Amount", "Received", "Bill Balance", "Payment"].map(
                          (h) => (
                            <th key={h} className="px-1 py-0.5">
                              {h}
                            </th>
                          )
                        )}
                      </tr>
                    </thead>
                    <tbody>
                      {status.lrs.map((l) => (
                        <tr key={l.lrNo} className="border-b last:border-0">
                          <td className="px-1 py-0.5">{l.lrNo}</td>
                          <td className="px-1 py-0.5">{formatDate(l.lrDate)}</td>
                          <td className="px-1 py-0.5">{l.consignor}</td>
                          <td className="px-1 py-0.5">{l.consignee}</td>
                          <td className="px-1 py-0.5 text-right tabular-nums">{l.qty}</td>
                          <td className="px-1 py-0.5 text-right tabular-nums">
                            {formatMoney(l.freight)}
                          </td>
                          <td className="px-1 py-0.5">
                            <Badge variant="outline">{l.status.replace(/_/g, " ")}</Badge>
                          </td>
                          <td className="px-1 py-0.5">{l.invoiceNo || "—"}</td>
                          <td className="px-1 py-0.5">
                            {l.invoiceDate ? formatDate(l.invoiceDate) : ""}
                          </td>
                          <td className="px-1 py-0.5 text-right tabular-nums">
                            {l.billed ? formatMoney(l.invoiceAmount) : ""}
                          </td>
                          <td className="px-1 py-0.5 text-right tabular-nums">
                            {l.billed ? formatMoney(l.invoiceReceived) : ""}
                          </td>
                          <td className="px-1 py-0.5 text-right tabular-nums">
                            {l.billed ? formatMoney(l.invoiceBalance) : ""}
                          </td>
                          <td className="px-1 py-0.5">
                            <Badge
                              variant={
                                l.invoiceStatus === "Paid"
                                  ? "default"
                                  : l.invoiceStatus === "Not Billed"
                                    ? "outline"
                                    : l.invoiceStatus === "Partially Paid"
                                      ? "secondary"
                                      : "destructive"
                              }
                            >
                              {l.invoiceStatus}
                            </Badge>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>

              {/* 5. advance & balance */}
              <div className="grid gap-3 sm:grid-cols-2">
                <div className="rounded-md border p-3">
                  <div className="mb-1 text-xs font-semibold uppercase text-muted-foreground">
                    Advances Paid
                  </div>
                  {status.advances.length === 0 && (
                    <div className="text-xs text-muted-foreground">No advances.</div>
                  )}
                  {status.advances.map((a, i) => (
                    <div key={i} className="flex justify-between gap-2 py-0.5 text-xs">
                      <span>
                        {a.date ? `${formatDate(a.date)} — ` : ""}
                        {a.name}
                        {a.mode ? ` (${a.mode})` : ""}
                        {a.remarks ? ` — ${a.remarks}` : ""}
                      </span>
                      <span className="tabular-nums">{formatMoney(a.amount)}</span>
                    </div>
                  ))}
                  <div className="mt-1 flex justify-between border-t pt-1 font-medium">
                    <span>Total Advance</span>
                    <span className="tabular-nums">{formatMoney(status.advanceTotal)}</span>
                  </div>
                  {/* every advance voucher this chalan consumed, either in the
                      advance section or at balance payment */}
                  {status.advanceAdjustments.length > 0 && (
                    <div className="mt-3 border-t pt-2">
                      <div className="mb-1 text-xs font-semibold uppercase text-muted-foreground">
                        Advance Vouchers Adjusted
                      </div>
                      {status.advanceAdjustments.map((a, i) => (
                        <div key={i} className="flex justify-between gap-2 py-0.5 text-xs">
                          <span>
                            {a.voucherNo}
                            {a.voucherDate ? ` — ${formatDate(a.voucherDate)}` : ""} ({a.section})
                          </span>
                          <span className="tabular-nums">{formatMoney(a.amount)}</span>
                        </div>
                      ))}
                      <div className="mt-1 flex justify-between border-t pt-1 font-medium">
                        <span>Total Advance Adjusted</span>
                        <span className="tabular-nums">
                          {formatMoney(status.advanceAdjustedTotal)}
                        </span>
                      </div>
                    </div>
                  )}
                </div>
                <div className="rounded-md border p-3">
                  <div className="mb-1 text-xs font-semibold uppercase text-muted-foreground">
                    Balance &amp; Settlement
                  </div>
                  <Line label="Grand Total" value={formatMoney(status.grandTotal)} />
                  <Line label="Balance" value={formatMoney(status.balance)} />
                  <Line
                    label="Balance Paid"
                    value={
                      status.paymentStatus === "PAID"
                        ? `${formatMoney(status.balPaidAmount)}${status.balPaymentDate ? ` on ${formatDate(status.balPaymentDate)}` : ""}${status.balPaymentMode ? ` (${status.balPaymentMode.replace("_", "/")})` : ""}`
                        : "—"
                    }
                  />
                  {(status.balRoundOff > 0 || status.balShortage > 0) && (
                    <Line
                      label="Round Off / Shortage"
                      value={`${formatMoney(status.balRoundOff)} / ${formatMoney(status.balShortage)}`}
                    />
                  )}
                  {/* a Payment Voucher settles the same outstanding, so its
                      figures belong here too */}
                  {status.voucherSettled > 0 && (
                    <Line
                      label="Settled by Payment Voucher"
                      value={`${formatMoney(status.voucherSettled)}${
                        status.voucherTds ||
                        status.voucherShortage ||
                        status.voucherOther ||
                        status.voucherRoundOff
                          ? ` (TDS ${formatMoney(status.voucherTds)} · shortage ${formatMoney(status.voucherShortage)} · other ${formatMoney(status.voucherOther)} · round off ${formatMoney(status.voucherRoundOff)})`
                          : ""
                      }`}
                    />
                  )}
                  <Line label="Balance Pending" value={formatMoney(status.outstanding)} />
                  <Line
                    label="Final Settlement"
                    value={status.paymentStatus === "PAID" ? "Settled (PAID)" : "Pending"}
                  />
                  {status.balRemarks && <Line label="Remarks" value={status.balRemarks} />}
                </div>
              </div>

              {/* 6. payment history (ledger) */}
              <div className="rounded-md border p-3">
                <div className="mb-1 text-xs font-semibold uppercase text-muted-foreground">
                  Payment History
                </div>
                {status.payments.length === 0 && (
                  <div className="text-xs text-muted-foreground">
                    No ledger payments recorded yet.
                  </div>
                )}
                {status.payments.map((p, i) => (
                  <div key={i} className="flex justify-between gap-2 py-0.5 text-xs">
                    <span>
                      {formatDate(p.date)} — {p.account || "—"} ({p.side === "CREDIT" ? "Out" : "In"},{" "}
                      {p.refType === "CHALAN_ADVANCE" ? "Advance" : "Balance"})
                      {p.narration ? ` — ${p.narration}` : ""}
                    </span>
                    <span className="tabular-nums">{formatMoney(p.amount)}</span>
                  </div>
                ))}
              </div>
            </div>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => setStatus(null)}>
              Close
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* accident / rejection cancel */}
      <Dialog open={!!toCancel} onOpenChange={(o) => !o && setToCancel(null)}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Cancel Chalan {toCancel?.chalanNo}?</DialogTitle>
            <DialogDescription>
              The chalan stays on record as CANCELLED. The broker&apos;s payable is reversed,
              LRs return to pending for a replacement vehicle, and any advances already given
              (cash / bank / diesel) become an open advance on the broker — recover it by
              receipt or adjust it against his next chalan.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-1">
            <label className="text-xs font-medium">Reason (Accident / Goods Rejected / ...)</label>
            <Input
              className="h-9"
              placeholder="e.g. Accident near Dewas — material rejected"
              value={cancelReason}
              onChange={(e) => setCancelReason(e.target.value)}
            />
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setToCancel(null)} disabled={cancelling}>
              Back
            </Button>
            <Button variant="destructive" onClick={confirmCancel} disabled={cancelling}>
              {cancelling ? "Cancelling..." : "Cancel Chalan"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function Line({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between gap-4 py-0.5 text-xs">
      <span className="text-muted-foreground">{label}</span>
      <span className="text-right font-medium">{value}</span>
    </div>
  );
}
