"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { formatDate, formatMoney } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { useToast } from "@/components/ui/use-toast";
import { runTallyExport, runTallyMasters } from "@/app/(app)/reports/tally-export/actions";

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
}

type DocStatus = "NEW" | "PARTIAL" | "CHANGED" | "EXPORTED";

function statusOf(r: TallyExportRow): DocStatus {
  if (r.fresh === r.voucherCount) return "NEW";
  if (r.changed > 0) return "CHANGED";
  if (r.fresh > 0) return "PARTIAL";
  return "EXPORTED";
}

/** List order: still to send first, fully exported last. */
const STATUS_RANK: Record<DocStatus, number> = { NEW: 0, PARTIAL: 1, CHANGED: 2, EXPORTED: 3 };

/** Status filter radios; "All" keeps the full list in STATUS_RANK order. */
type StatusFilter = "ALL" | "NEW" | "PARTIAL" | "PENDING" | "EXPORTED";
const STATUS_FILTERS: { value: StatusFilter; label: string; match: (s: DocStatus) => boolean }[] = [
  { value: "ALL", label: "All", match: () => true },
  { value: "NEW", label: "New", match: (s) => s === "NEW" },
  { value: "PARTIAL", label: "Partial / Changed", match: (s) => s === "PARTIAL" || s === "CHANGED" },
  { value: "PENDING", label: "New + Partial", match: (s) => s !== "EXPORTED" },
  { value: "EXPORTED", label: "Exported", match: (s) => s === "EXPORTED" },
];

function download(fileName: string, xml: string) {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([xml], { type: "application/xml" }));
  a.download = fileName;
  a.click();
  URL.revokeObjectURL(a.href);
}

export function TallyExportClient({
  rows,
  module,
  dateFrom,
  dateTo,
}: {
  rows: TallyExportRow[];
  module: string;
  dateFrom: string | null;
  dateTo: string | null;
}) {
  const router = useRouter();
  const { toast } = useToast();
  const [busy, setBusy] = React.useState(false);
  const [includeExported, setIncludeExported] = React.useState(false);
  // grouped by status; the builders' date order is kept inside each group
  const sortedRows = React.useMemo(
    () => [...rows].sort((a, b) => STATUS_RANK[statusOf(a)] - STATUS_RANK[statusOf(b)]),
    [rows]
  );
  const [statusFilter, setStatusFilter] = React.useState<StatusFilter>("ALL");
  const visibleRows = React.useMemo(() => {
    const f = STATUS_FILTERS.find((x) => x.value === statusFilter) ?? STATUS_FILTERS[0];
    return sortedRows.filter((r) => f.match(statusOf(r)));
  }, [sortedRows, statusFilter]);
  // default selection: everything that has something new/changed to send
  const [selected, setSelected] = React.useState<Set<string>>(
    () => new Set(rows.filter((r) => r.fresh + r.changed > 0).map((r) => r.docId))
  );

  const toggle = (id: string, on: boolean) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (on) next.add(id);
      else next.delete(id);
      return next;
    });

  // only what the filter shows goes out — a hidden ticked row never exports
  const visibleSelected = visibleRows.filter((r) => selected.has(r.docId)).map((r) => r.docId);

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
      });
      if (res.ok) {
        download(res.fileName, res.xml);
        toast({
          title: `${res.exported} vouchers exported`,
          description:
            [
              res.skipped > 0 ? `${res.skipped} were already exported — skipped.` : "",
              res.legacyChanged > 0
                ? `${res.legacyChanged} edited chalan advance(s) were first exported before update tracking — delete the old copy in Tally by hand.`
                : "",
            ]
              .filter(Boolean)
              .join(" ") || undefined,
        });
        router.refresh();
      } else {
        toast({ variant: "destructive", title: res.error });
      }
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

  const status = (r: TallyExportRow) => {
    const s = statusOf(r);
    if (s === "NEW") return <Badge variant="outline">NEW</Badge>;
    if (s === "CHANGED") return <Badge variant="destructive">CHANGED</Badge>;
    if (s === "PARTIAL") return <Badge variant="secondary">PARTIAL</Badge>;
    return (
      <Badge className="bg-emerald-100 text-emerald-700 hover:bg-emerald-100 dark:bg-emerald-950 dark:text-emerald-400">
        EXPORTED
      </Badge>
    );
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <Button onClick={() => void doExport()} disabled={busy}>
          {busy ? "Working..." : "⬇ Download Tally XML"}
        </Button>
        <label className="flex cursor-pointer items-center gap-2 text-sm">
          <Checkbox
            checked={includeExported}
            onCheckedChange={(c) => setIncludeExported(c === true)}
          />
          Include already exported (full re-export)
        </label>
        <Button variant="outline" onClick={() => void doMasters()} disabled={busy}>
          Download Party Masters XML
        </Button>
      </div>

      <div role="radiogroup" aria-label="Status" className="flex flex-wrap items-center gap-x-5 gap-y-2">
        {STATUS_FILTERS.map((f) => {
          const count = sortedRows.filter((r) => f.match(statusOf(r))).length;
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
              <tr key={r.docId} className="border-b hover:bg-muted/40">
                <td className="px-3 py-2">
                  <Checkbox
                    checked={selected.has(r.docId)}
                    onCheckedChange={(c) => toggle(r.docId, c === true)}
                  />
                </td>
                <td className="px-3 py-2 font-medium">{r.refNo}</td>
                <td className="px-3 py-2">{formatDate(r.dateIso)}</td>
                <td className="px-3 py-2">{r.party || "—"}</td>
                <td className="px-3 py-2 text-muted-foreground">{r.detail}</td>
                <td className="px-3 py-2 text-right tabular-nums">{formatMoney(r.amount)}</td>
                <td className="px-3 py-2 text-right tabular-nums">
                  {r.voucherCount}
                  <span className="ml-1 text-xs text-muted-foreground">
                    ({r.fresh} new{r.changed ? `, ${r.changed} changed` : ""})
                  </span>
                </td>
                <td className="px-3 py-2">{status(r)}</td>
              </tr>
            ))}
            {visibleRows.length === 0 && (
              <tr>
                <td colSpan={8} className="px-3 py-6 text-center text-muted-foreground">
                  {rows.length === 0
                    ? "Nothing found for this module in this period."
                    : "No entries with this status."}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
