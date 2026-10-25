"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { formatDate, formatMoney } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { useToast } from "@/components/ui/use-toast";
import {
  confirmTallyBatch,
  getTallyBatchXml,
  runTallyExport,
  runTallyMasters,
} from "@/app/(app)/reports/tally-export/actions";
import type { DocSyncStatus } from "@/lib/tally-sync";

type RowStatus = DocSyncStatus | "AWAITING";

export interface TallyExportRow {
  docId: string;
  refNo: string;
  dateIso: string;
  party: string;
  detail: string;
  amount: number;
  voucherCount: number;
  /** never exported */
  fresh: number;
  /** exported earlier but the document changed since */
  changed: number;
  /** exported and unchanged */
  done: number;
  /** vouchers that must leave Tally (amount now zero, document removed) */
  obsolete: number;
  status: RowStatus;
  /** why the document cannot export as it stands (old copies in Tally) */
  blocked: string | null;
}

/** A downloaded file not yet confirmed as imported into Tally. */
export interface TallyPendingFile {
  id: string;
  fileName: string;
  createdIso: string;
  vouchers: number;
  deletes: number;
}

/** List order: work still to do first, fully exported last. */
const STATUS_RANK: Record<RowStatus, number> = {
  LEGACY: 0,
  REMOVE: 1,
  NEW: 2,
  PARTIAL: 3,
  CHANGED: 4,
  AWAITING: 5,
  EXPORTED: 6,
};

const TODO: RowStatus[] = ["NEW", "PARTIAL", "CHANGED", "REMOVE", "LEGACY"];

/** Status filter radios; "All" keeps the full list in STATUS_RANK order. */
type StatusFilter = "ALL" | "NEW" | "PARTIAL" | "PENDING" | "EXPORTED" | "AWAITING";
const STATUS_FILTERS: { value: StatusFilter; label: string; match: (s: RowStatus) => boolean }[] = [
  { value: "ALL", label: "All", match: () => true },
  { value: "NEW", label: "New", match: (s) => s === "NEW" },
  {
    value: "PARTIAL",
    label: "Partial / Changed",
    match: (s) => s === "PARTIAL" || s === "CHANGED" || s === "REMOVE" || s === "LEGACY",
  },
  { value: "PENDING", label: "New + Partial", match: (s) => TODO.includes(s) },
  { value: "AWAITING", label: "Awaiting import", match: (s) => s === "AWAITING" },
  { value: "EXPORTED", label: "Exported", match: (s) => s === "EXPORTED" },
];

function download(fileName: string, xml: string) {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([xml], { type: "application/xml" }));
  a.download = fileName;
  a.click();
  URL.revokeObjectURL(a.href);
}

function StatusBadge({ s }: { s: RowStatus }) {
  if (s === "NEW") return <Badge variant="outline">NEW</Badge>;
  if (s === "CHANGED") return <Badge variant="destructive">CHANGED</Badge>;
  if (s === "PARTIAL") return <Badge variant="secondary">PARTIAL</Badge>;
  if (s === "REMOVE") return <Badge variant="destructive">REMOVE FROM TALLY</Badge>;
  if (s === "LEGACY") return <Badge variant="destructive">DELETE OLD COPY</Badge>;
  if (s === "AWAITING")
    return (
      <Badge className="bg-amber-100 text-amber-800 hover:bg-amber-100 dark:bg-amber-950 dark:text-amber-300">
        AWAITING IMPORT
      </Badge>
    );
  return (
    <Badge className="bg-emerald-100 text-emerald-700 hover:bg-emerald-100 dark:bg-emerald-950 dark:text-emerald-400">
      EXPORTED
    </Badge>
  );
}

export function TallyExportClient({
  rows,
  module,
  dateFrom,
  dateTo,
  pendingFiles,
}: {
  rows: TallyExportRow[];
  module: string;
  dateFrom: string | null;
  dateTo: string | null;
  pendingFiles: TallyPendingFile[];
}) {
  const router = useRouter();
  const { toast } = useToast();
  const [busy, setBusy] = React.useState(false);
  const [includeExported, setIncludeExported] = React.useState(false);
  // grouped by status; the builders' date order is kept inside each group
  const sortedRows = React.useMemo(
    () => [...rows].sort((a, b) => STATUS_RANK[a.status] - STATUS_RANK[b.status]),
    [rows]
  );
  const [statusFilter, setStatusFilter] = React.useState<StatusFilter>("ALL");
  const visibleRows = React.useMemo(() => {
    const f = STATUS_FILTERS.find((x) => x.value === statusFilter) ?? STATUS_FILTERS[0];
    return sortedRows.filter((r) => f.match(r.status));
  }, [sortedRows, statusFilter]);
  // default selection: everything that has something to send (old copies
  // wait until the user confirms they deleted them in Tally)
  const [selected, setSelected] = React.useState<Set<string>>(
    () =>
      new Set(
        rows.filter((r) => r.status !== "LEGACY" && r.status !== "AWAITING" && TODO.includes(r.status)).map((r) => r.docId)
      )
  );
  // LEGACY rows the user ticked "old copies deleted in Tally"
  const [legacyDone, setLegacyDone] = React.useState<Set<string>>(new Set());

  const toggle = (id: string, on: boolean) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (on) next.add(id);
      else next.delete(id);
      return next;
    });

  // only what the filter shows goes out — a hidden ticked row never exports;
  // a file awaiting import keeps its documents out of the next file
  const visibleSelected = visibleRows
    .filter((r) => selected.has(r.docId) && r.status !== "AWAITING")
    .map((r) => r.docId);

  const doExport = async () => {
    if (!visibleSelected.length) {
      toast({ variant: "destructive", title: "Nothing selected" });
      return;
    }
    setBusy(true);
    try {
      const res = await runTallyExport({
        module,
        dateFrom,
        dateTo,
        docIds: visibleSelected,
        includeExported,
        legacyConfirmed: Array.from(legacyDone).filter((id) => visibleSelected.includes(id)),
      });
      if (!res.ok) {
        toast({ variant: "destructive", title: res.error });
        return;
      }
      if (res.xml) download(res.fileName, res.xml);
      const notes = [
        res.deleted > 0 ? `${res.deleted} to delete in Tally.` : "",
        res.skipped > 0 ? `${res.skipped} unchanged — skipped.` : "",
        res.legacyChanged > 0
          ? `${res.legacyChanged} edited chalan advance(s) were first exported before update tracking — delete the old copy in Tally by hand.`
          : "",
        res.xml ? "Import it in Tally, then press Imported OK below." : "",
      ].filter(Boolean);
      if (res.blocked.length) {
        toast({
          variant: "destructive",
          title: res.xml
            ? `${res.exported} vouchers in the file — ${res.blocked.length} document(s) held back`
            : `${res.blocked.length} document(s) held back`,
          description: res.blocked.join(" "),
        });
      } else {
        toast({
          title: res.xml ? `${res.exported} vouchers in the file` : "Records updated",
          description: notes.join(" ") || undefined,
        });
      }
      router.refresh();
    } finally {
      setBusy(false);
    }
  };

  const doMasters = async () => {
    setBusy(true);
    try {
      const res = await runTallyMasters({ module, dateFrom, dateTo });
      if (res.ok) {
        download(res.fileName, res.xml);
        toast({ title: `${res.count} party masters exported` });
      } else {
        toast({ variant: "destructive", title: res.error });
      }
    } finally {
      setBusy(false);
    }
  };

  const confirmFile = async (batchId: string, outcome: "IMPORTED" | "FAILED") => {
    setBusy(true);
    try {
      const res = await confirmTallyBatch({ batchId, outcome });
      if (res.ok) {
        toast({
          title:
            outcome === "IMPORTED"
              ? "Marked as imported — these entries now count as exported"
              : "Marked as failed — the entries will go across again in the next file",
        });
        router.refresh();
      } else {
        toast({ variant: "destructive", title: res.error });
      }
    } finally {
      setBusy(false);
    }
  };

  const redownload = async (batchId: string) => {
    const res = await getTallyBatchXml({ batchId });
    if (res.ok) download(res.fileName, res.xml);
    else toast({ variant: "destructive", title: res.error });
  };

  return (
    <div className="space-y-4">
      {pendingFiles.length > 0 && (
        <div className="space-y-2 rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm dark:border-amber-800 dark:bg-amber-950/40">
          <div className="font-medium">Files awaiting import into Tally</div>
          <p className="text-muted-foreground">
            After importing a file in Tally, tell us how it went. Only &quot;Imported OK&quot; marks its entries as
            exported; &quot;Import failed&quot; sends them again in the next file.
          </p>
          {pendingFiles.map((f) => (
            <div key={f.id} className="flex flex-wrap items-center gap-2 rounded-md bg-card px-2 py-1.5">
              <span className="min-w-0 flex-1 truncate">
                <b>{f.fileName}</b> · {formatDate(f.createdIso)} ·{" "}
                <span className="tabular-nums">{f.vouchers}</span> vouchers
                {f.deletes ? (
                  <>
                    , <span className="tabular-nums">{f.deletes}</span> to delete
                  </>
                ) : null}
              </span>
              <Button size="sm" variant="ghost" onClick={() => void redownload(f.id)} disabled={busy}>
                Download again
              </Button>
              <Button size="sm" onClick={() => void confirmFile(f.id, "IMPORTED")} disabled={busy}>
                Imported OK
              </Button>
              <Button size="sm" variant="outline" onClick={() => void confirmFile(f.id, "FAILED")} disabled={busy}>
                Import failed
              </Button>
            </div>
          ))}
        </div>
      )}

      <div className="flex flex-wrap items-center gap-3">
        <Button onClick={() => void doExport()} disabled={busy}>
          {busy ? "Working..." : "⬇ Download Tally XML"}
        </Button>
        <label className="flex cursor-pointer items-center gap-2 text-sm">
          <Checkbox checked={includeExported} onCheckedChange={(c) => setIncludeExported(c === true)} />
          Include already exported (full re-export)
        </label>
        <Button variant="outline" onClick={() => void doMasters()} disabled={busy}>
          Download Party Masters XML
        </Button>
      </div>

      <div role="radiogroup" aria-label="Status" className="flex flex-wrap items-center gap-x-5 gap-y-2">
        {STATUS_FILTERS.map((f) => {
          const count = sortedRows.filter((r) => f.match(r.status)).length;
          return (
            <label key={f.value} className="flex cursor-pointer items-center gap-1.5 text-sm">
              <input
                type="radio"
                name="tally-status"
                checked={statusFilter === f.value}
                onChange={() => setStatusFilter(f.value)}
                className="h-4 w-4 accent-primary"
              />
              {f.label}
              <span className="text-xs tabular-nums text-muted-foreground">({count})</span>
            </label>
          );
        })}
      </div>

      <div className="overflow-x-auto rounded-lg border">
        <table className="w-full border-collapse text-sm">
          <thead>
            <tr className="border-b bg-muted/50 text-left text-xs uppercase tracking-wide text-muted-foreground">
              <th className="px-3 py-2">
                {/* ticks / clears only the rows the status filter shows */}
                <Checkbox
                  checked={visibleRows.length > 0 && visibleSelected.length === visibleRows.length}
                  onCheckedChange={(c) =>
                    setSelected((prev) => {
                      const next = new Set(prev);
                      for (const r of visibleRows) {
                        if (r.status === "AWAITING") continue;
                        if (c === true) next.add(r.docId);
                        else next.delete(r.docId);
                      }
                      return next;
                    })
                  }
                />
              </th>
              <th className="px-3 py-2">Ref No</th>
              <th className="px-3 py-2">Date</th>
              <th className="px-3 py-2">Party</th>
              <th className="px-3 py-2">Detail</th>
              <th className="px-3 py-2 text-right">Amount</th>
              <th className="px-3 py-2 text-right">Vouchers</th>
              <th className="px-3 py-2">Status</th>
            </tr>
          </thead>
          <tbody>
            {visibleRows.map((r) => (
              <tr key={r.docId} className="border-b align-top hover:bg-muted/40">
                <td className="px-3 py-2">
                  <Checkbox
                    checked={selected.has(r.docId) && r.status !== "AWAITING"}
                    disabled={r.status === "AWAITING"}
                    onCheckedChange={(c) => toggle(r.docId, c === true)}
                  />
                </td>
                <td className="px-3 py-2 font-medium">{r.refNo}</td>
                <td className="px-3 py-2">{formatDate(r.dateIso)}</td>
                <td className="px-3 py-2">{r.party || "—"}</td>
                <td className="px-3 py-2 text-muted-foreground">
                  {r.detail}
                  {r.blocked && (
                    <div className="mt-1 max-w-md space-y-1 text-xs text-destructive">
                      <div>{r.blocked}</div>
                      <label className="flex cursor-pointer items-center gap-1.5 text-foreground">
                        <Checkbox
                          checked={legacyDone.has(r.docId)}
                          onCheckedChange={(c) => {
                            setLegacyDone((prev) => {
                              const next = new Set(prev);
                              if (c === true) next.add(r.docId);
                              else next.delete(r.docId);
                              return next;
                            });
                            if (c === true) toggle(r.docId, true);
                          }}
                        />
                        Old copies deleted in Tally
                      </label>
                    </div>
                  )}
                </td>
                <td className="px-3 py-2 text-right tabular-nums">{r.amount ? formatMoney(r.amount) : "—"}</td>
                <td className="px-3 py-2 text-right tabular-nums">
                  {r.voucherCount}
                  <span className="ml-1 text-xs text-muted-foreground">
                    ({r.fresh} new{r.changed ? `, ${r.changed} changed` : ""}
                    {r.obsolete ? `, ${r.obsolete} to delete` : ""})
                  </span>
                </td>
                <td className="px-3 py-2">
                  <StatusBadge s={r.status} />
                </td>
              </tr>
            ))}
            {visibleRows.length === 0 && (
              <tr>
                <td colSpan={8} className="px-3 py-6 text-center text-muted-foreground">
                  {rows.length === 0 ? "Nothing found for this module in this period." : "No entries with this status."}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

    </div>
  );
}
