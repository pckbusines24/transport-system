"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { ChevronDown, ChevronRight, Trash2 } from "lucide-react";
import { formatDate, formatMoney } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { IsoDateInput } from "@/components/data/date-input";
import { Label } from "@/components/ui/label";
import { useToast } from "@/components/ui/use-toast";
import { InfoHint } from "@/components/ui/info-hint";
import { ExportButton } from "@/components/data/export-button";
import {
  deleteTdsDeduction,
  recordTdsDeduction,
  type TdsMonitorData,
  type TdsMonitorRow,
} from "../tds-actions";

export function TdsMonitorClient({ data, error }: { data: TdsMonitorData; error: string | null }) {
  const router = useRouter();
  const { toast } = useToast();
  const [q, setQ] = React.useState("");
  const [onlyCrossed, setOnlyCrossed] = React.useState(false);
  const [open, setOpen] = React.useState<Set<string>>(new Set());
  const [deductFor, setDeductFor] = React.useState<TdsMonitorRow | null>(null);
  const [dForm, setDForm] = React.useState({ date: "", amount: "", remarks: "" });
  const [saving, setSaving] = React.useState(false);

  const rows = data.rows.filter((r) => {
    if (q && !r.party.toLowerCase().includes(q.toLowerCase())) return false;
    if (onlyCrossed && !r.crossed) return false;
    return true;
  });

  const toggle = (key: string) =>
    setOpen((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

  const openDeduct = (r: TdsMonitorRow) => {
    setDForm({
      date: new Date(Date.now() + 5.5 * 3600 * 1000).toISOString().slice(0, 10),
      amount: r.toDeduct > 0 ? String(r.toDeduct) : "",
      remarks: "",
    });
    setDeductFor(r);
  };

  const saveDeduction = async () => {
    if (!deductFor?.partyId) return;
    setSaving(true);
    const res = await recordTdsDeduction({
      partyId: deductFor.partyId,
      sectionId: deductFor.sectionId,
      date: dForm.date,
      amount: Number(dForm.amount),
      remarks: dForm.remarks || null,
    });
    setSaving(false);
    if (res.ok) {
      toast({ title: "TDS deduction recorded" });
      setDeductFor(null);
      router.refresh();
    } else {
      toast({ variant: "destructive", title: res.error });
    }
  };

  const removeDeduction = async (id: string) => {
    if (!window.confirm("Delete this deduction record?")) return;
    const res = await deleteTdsDeduction(id);
    if (res.ok) {
      toast({ title: "Record deleted" });
      router.refresh();
    } else {
      toast({ variant: "destructive", title: res.error });
    }
  };

  const cell = "border px-2 py-1 text-xs";
  const num = `${cell} text-right tabular-nums`;

  return (
    <div className="space-y-3 p-4">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <h1 className="page-title flex items-center gap-2">
          TDS Threshold Monitor
          <InfoHint>
            Supplier-wise FY totals per TDS section, from Vehicle Expenses, Office Expenses and
            AdBlue purchases (heads connected in the TDS Master). Each supplier&apos;s limit runs
            separately per section; once crossed, the monitor shows cumulative TDS due minus what
            you have already recorded as deducted — deduct only the difference. Chalan / broker
            slip / hire TDS is not tracked here.
          </InfoHint>
        </h1>
        <div className="flex items-center gap-2">
          <Button asChild size="sm" variant="outline" className="h-8">
            <a href="/masters/tds-sections">TDS Master</a>
          </Button>
          <ExportButton
            rows={rows}
            fileName="tds-threshold-monitor"
            sheetName="TDS Monitor"
            columns={[
              { header: "Party", key: "party", width: 30 },
              { header: "PAN", accessor: (r) => r.pan ?? "" },
              { header: "Section", accessor: (r) => r.sectionCode + (r.sectionOldCode ? ` (old: ${r.sectionOldCode})` : "") },
              { header: "FY Total", key: "total", numeric: true },
              { header: "Annual Limit", key: "annualLimit", numeric: true },
              { header: "Status", accessor: (r) => (r.crossed ? "CROSSED" : r.nearLimit ? "NEAR LIMIT" : "OK") },
              { header: "Suggested %", accessor: (r) => r.suggestedRate ?? "" },
              { header: "TDS Due", key: "tdsDue", numeric: true },
              { header: "Deducted", key: "deducted", numeric: true },
              { header: "To Deduct", key: "toDeduct", numeric: true },
            ]}
            summary={[
              { label: "Crossed", value: data.crossedCount },
              { label: "To Deduct Total", value: data.toDeductTotal },
            ]}
          />
        </div>
      </div>

      {error && <p className="text-sm text-destructive">{error}</p>}

      <div className="grid gap-2 sm:grid-cols-3">
        <div className="rounded-md border p-3">
          <div className="text-[11px] font-medium uppercase text-muted-foreground">Limit Crossed</div>
          <div className="text-lg font-bold tabular-nums text-red-600">{data.crossedCount} suppliers</div>
        </div>
        <div className="rounded-md border p-3">
          <div className="text-[11px] font-medium uppercase text-muted-foreground">Near Limit (90%+)</div>
          <div className="text-lg font-bold tabular-nums text-amber-600">{data.nearCount} suppliers</div>
        </div>
        <div className="rounded-md border p-3">
          <div className="text-[11px] font-medium uppercase text-muted-foreground">TDS Still To Deduct</div>
          <div className="text-lg font-bold tabular-nums text-primary">{formatMoney(data.toDeductTotal)}</div>
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-2 rounded-md border p-2">
        <Input
          className="h-8 w-[200px] text-xs"
          placeholder="Search supplier..."
          value={q}
          onChange={(e) => setQ(e.target.value)}
        />
        <label className="flex items-center gap-1.5 text-xs font-medium">
          <input
            type="checkbox"
            checked={onlyCrossed}
            onChange={(e) => setOnlyCrossed(e.target.checked)}
          />
          Crossed only
        </label>
        <span className="ml-auto text-xs text-muted-foreground">{rows.length} rows</span>
      </div>

      <div className="overflow-x-auto rounded-md border">
        <table className="w-full border-collapse text-xs">
          <thead className="bg-muted/60">
            <tr>
              {["Supplier", "PAN", "Section", "FY Total", "Limit", "Status", "Sug. %", "TDS Due", "Deducted", "To Deduct", ""].map(
                (h) => (
                  <th key={h} className={`${cell} whitespace-nowrap text-left font-semibold`}>
                    {h}
                  </th>
                )
              )}
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => {
              const key = `${r.partyId ?? "none"}|${r.sectionId}`;
              const expanded = open.has(key);
              return (
                <React.Fragment key={key}>
                  <tr
                    className="cursor-pointer odd:bg-muted/20 hover:bg-muted/40"
                    onClick={() => toggle(key)}
                  >
                    <td className={`${cell} font-medium`}>
                      <span className="flex items-center gap-1">
                        {expanded ? (
                          <ChevronDown className="h-3 w-3 shrink-0" />
                        ) : (
                          <ChevronRight className="h-3 w-3 shrink-0" />
                        )}
                        {r.party}
                      </span>
                    </td>
                    <td className={`${cell} whitespace-nowrap`}>
                      {r.pan ?? <Badge variant="destructive">No PAN</Badge>}
                    </td>
                    <td className={`${cell} whitespace-nowrap`}>
                      {r.sectionCode}
                      {r.sectionOldCode && (
                        <span className="text-muted-foreground"> (old: {r.sectionOldCode})</span>
                      )}
                    </td>
                    <td className={`${num} font-medium`}>{formatMoney(r.total)}</td>
                    <td className={num}>{formatMoney(r.annualLimit)}</td>
                    <td className={cell}>
                      {r.crossed ? (
                        <Badge variant="destructive">
                          CROSSED{r.singleBillHit && !((r.annualLimit > 0) && r.total > r.annualLimit) ? " (single bill)" : ""}
                        </Badge>
                      ) : r.nearLimit ? (
                        <Badge variant="secondary">{formatMoney(r.remaining)} left</Badge>
                      ) : (
                        <span className="text-muted-foreground">{formatMoney(r.remaining)} left</span>
                      )}
                    </td>
                    <td className={num}>{r.suggestedRate !== null ? `${r.suggestedRate}%` : "—"}</td>
                    <td className={num}>{r.crossed ? formatMoney(r.tdsDue) : "—"}</td>
                    <td className={num}>{r.deducted > 0 ? formatMoney(r.deducted) : "—"}</td>
                    <td className={`${num} ${r.toDeduct > 0.009 ? "font-bold text-red-600" : ""}`}>
                      {r.crossed ? formatMoney(r.toDeduct) : "—"}
                    </td>
                    <td className={`${cell} whitespace-nowrap`} onClick={(e) => e.stopPropagation()}>
                      {r.partyId && r.crossed && (
                        <Button
                          size="sm"
                          variant="outline"
                          className="h-7 px-2 text-xs"
                          onClick={() => openDeduct(r)}
                        >
                          Record TDS
                        </Button>
                      )}
                    </td>
                  </tr>
                  {expanded && (
                    <tr>
                      <td colSpan={11} className="border bg-muted/10 px-4 py-2">
                        <div className="grid gap-3 lg:grid-cols-2">
                          <div>
                            <div className="mb-1 text-[10px] font-bold uppercase text-muted-foreground">
                              Bills ({r.docs.length})
                            </div>
                            <div className="max-h-48 overflow-y-auto">
                              {r.docs.map((d, i) => (
                                <div key={i} className="flex items-center justify-between border-t py-0.5 text-xs first:border-0">
                                  <span>
                                    {formatDate(d.date)} · <b>{d.refNo}</b> · {d.head}
                                    <span className="text-muted-foreground"> ({d.source})</span>
                                  </span>
                                  <span className="tabular-nums">{formatMoney(d.amount)}</span>
                                </div>
                              ))}
                            </div>
                          </div>
                          <div>
                            <div className="mb-1 text-[10px] font-bold uppercase text-muted-foreground">
                              TDS Deduction Records ({r.deductions.length})
                            </div>
                            {r.deductions.length === 0 && (
                              <p className="text-xs text-muted-foreground">Nothing recorded yet.</p>
                            )}
                            {r.deductions.map((d) => (
                              <div key={d.id} className="flex items-center justify-between border-t py-0.5 text-xs first:border-0">
                                <span>
                                  {formatDate(d.date)}
                                  {d.remarks && <span className="text-muted-foreground"> — {d.remarks}</span>}
                                </span>
                                <span className="flex items-center gap-1">
                                  <span className="tabular-nums">{formatMoney(d.amount)}</span>
                                  <Button
                                    variant="ghost"
                                    size="sm"
                                    className="h-5 px-1 text-destructive"
                                    onClick={() => removeDeduction(d.id)}
                                  >
                                    <Trash2 className="h-3 w-3" />
                                  </Button>
                                </span>
                              </div>
                            ))}
                          </div>
                        </div>
                      </td>
                    </tr>
                  )}
                </React.Fragment>
              );
            })}
            {rows.length === 0 && (
              <tr>
                <td colSpan={11} className={`${cell} py-6 text-center text-muted-foreground`}>
                  Nothing to track — connect expense heads to sections in the TDS Master first.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      <Dialog open={!!deductFor} onOpenChange={(o) => !o && setDeductFor(null)}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>
              Record TDS — {deductFor?.party} ({deductFor?.sectionCode})
            </DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            <p className="text-xs text-muted-foreground">
              TDS due {formatMoney(deductFor?.tdsDue ?? 0)} − already recorded{" "}
              {formatMoney(deductFor?.deducted ?? 0)} ={" "}
              <b>{formatMoney(deductFor?.toDeduct ?? 0)}</b> to deduct now.
            </p>
            <div className="space-y-1">
              <Label className="text-xs">Date</Label>
              <IsoDateInput
                className="h-8 text-xs"
                value={dForm.date}
                onChange={(iso) => setDForm({ ...dForm, date: iso ?? "" })}
              />
            </div>
            <div className="space-y-1">
              <Label className="text-xs">Amount (₹)</Label>
              <Input
                type="number"
                className="h-8 text-xs"
                value={dForm.amount}
                onChange={(e) => setDForm({ ...dForm, amount: e.target.value })}
              />
            </div>
            <div className="space-y-1">
              <Label className="text-xs">Remarks (optional)</Label>
              <Input
                className="h-8 text-xs"
                value={dForm.remarks}
                onChange={(e) => setDForm({ ...dForm, remarks: e.target.value })}
                placeholder="e.g. adjusted in payment voucher PV-102"
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDeductFor(null)}>
              Cancel
            </Button>
            <Button onClick={saveDeduction} disabled={saving || !Number(dForm.amount)}>
              {saving ? "Saving..." : "Save Record"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
