"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { formatDate, parseDdMmYyyy } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import { InfoHint } from "@/components/ui/info-hint";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { useToast } from "@/components/ui/use-toast";
import { DateInput } from "@/components/data/date-input";
import { extendEway, setEwayChecked } from "./actions";

export interface EwayTab {
  date: string; // yyyy-mm-dd
  isPast: boolean;
  isToday: boolean;
}

export interface EwayRow {
  lrId: string;
  lrNo: string;
  lrDate: string;
  vehicle: string;
  ewayNo: string;
  expiry: string; // yyyy-mm-dd (current)
  prevExpiries: string[]; // calendar dates it USED to expire on
  checked: boolean;
  checkedBy: string | null;
  checkedAt: string | null;
}

const fmt = (iso: string) => {
  const [y, m, d] = iso.split("-");
  return `${d}-${m}-${y}`;
};

function textToIso(text: string): string {
  const d = parseDdMmYyyy(text);
  if (!d) return "";
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

export function EwayClient({
  tabs,
  rows,
  todayCal,
}: {
  tabs: EwayTab[];
  rows: EwayRow[];
  todayCal: string;
}) {
  const router = useRouter();
  const { toast } = useToast();
  const [active, setActive] = React.useState(todayCal);
  const [busy, setBusy] = React.useState<string | null>(null);
  const [editFor, setEditFor] = React.useState<EwayRow | null>(null);
  const [newDateText, setNewDateText] = React.useState("");

  const activeTab = tabs.find((t) => t.date === active) ?? tabs[2];

  // a screen left open past midnight keeps yesterday's tabs — refetch when the
  // IST calendar day moves past the server-rendered one
  React.useEffect(() => {
    const check = () => {
      const ist = new Date(Date.now() + 5.5 * 3600 * 1000).toISOString().slice(0, 10);
      if (ist !== todayCal) router.refresh();
    };
    const id = window.setInterval(check, 60_000);
    return () => window.clearInterval(id);
  }, [todayCal, router]);

  // server re-render moved "today": follow it unless the user picked a tab
  const lastToday = React.useRef(todayCal);
  React.useEffect(() => {
    if (lastToday.current !== todayCal) {
      if (active === lastToday.current) setActive(todayCal);
      lastToday.current = todayCal;
    }
  }, [todayCal, active]);

  // current-expiry matches, plus (on past tabs) extended-away records
  const list = rows
    .filter((r) => r.expiry === active || (activeTab.isPast && r.prevExpiries.includes(active)))
    .map((r) => ({
      ...r,
      movedAway: r.expiry !== active,
      expired: r.expiry === active && active < todayCal,
    }));

  const countFor = (t: EwayTab) =>
    rows.filter((r) => r.expiry === t.date || (t.isPast && r.prevExpiries.includes(t.date))).length;

  const toggleCheck = async (r: EwayRow) => {
    setBusy(r.lrId);
    try {
      const res = await setEwayChecked(r.lrId, !r.checked);
      if (res.ok) {
        toast({ title: r.checked ? `LR ${r.lrNo} unmarked` : `LR ${r.lrNo} marked Checked` });
        router.refresh();
      } else toast({ variant: "destructive", title: res.error });
    } finally {
      setBusy(null);
    }
  };

  const submitExtend = async () => {
    if (!editFor) return;
    const iso = textToIso(newDateText);
    if (!iso) {
      toast({ variant: "destructive", title: "Valid date required (DD-MM-YYYY)" });
      return;
    }
    setBusy(editFor.lrId);
    try {
      const res = await extendEway(editFor.lrId, iso, editFor.ewayNo);
      if (res.ok) {
        toast({
          title: `LR ${editFor.lrNo}: e-way extended to ${fmt(iso)}`,
          description: "Record moved to the new date; check mark reset for re-verification.",
        });
        setEditFor(null);
        router.refresh();
      } else toast({ variant: "destructive", title: res.error });
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="space-y-3 p-4">
      <div>
        <h1 className="page-title flex items-center gap-2">
          E-Way Bill Monitoring
          <InfoHint>
            Expiring e-way bills, date-wise. Check = verified (visible to every user); Edit =
            extend the expiry — the record moves to its new date automatically.
          </InfoHint>
        </h1>
      </div>

      {/* date tabs */}
      <div className="flex flex-wrap gap-1">
        {tabs.map((t) => (
          <Button
            key={t.date}
            size="sm"
            variant={active === t.date ? "default" : "outline"}
            className="h-8 px-3"
            onClick={() => setActive(t.date)}
          >
            {fmt(t.date)}
            {t.isToday ? " (Today)" : ""}
            <Badge variant={active === t.date ? "secondary" : "outline"} className="ml-1.5 px-1.5">
              {countFor(t)}
            </Badge>
          </Button>
        ))}
      </div>

      {/* full list — no pagination, vertical scroll */}
      <div className="overflow-x-auto rounded-md border">
        <table className="w-full text-sm">
          <thead className="sticky top-0 bg-muted/80 backdrop-blur">
            <tr>
              {["S.No.", "LR No.", "Vehicle No.", "LR Date", "E-Way Bill No.", "Expiry Date", "Check Status", "Edit"].map((h) => (
                <th key={h} className="whitespace-nowrap px-2 py-1.5 text-left text-xs font-medium text-muted-foreground">
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {list.length === 0 ? (
              <tr>
                <td colSpan={8} className="h-20 text-center text-muted-foreground">
                  No e-way bills expiring on {fmt(active)}.
                </td>
              </tr>
            ) : (
              list.map((r, i) => (
                <tr key={r.lrId} className="border-t hover:bg-muted/40">
                  <td className="px-2 py-1.5 tabular-nums">{i + 1}</td>
                  <td className="px-2 py-1.5 font-medium">{r.lrNo}</td>
                  <td className="px-2 py-1.5">{r.vehicle}</td>
                  <td className="whitespace-nowrap px-2 py-1.5">{formatDate(r.lrDate)}</td>
                  <td className="px-2 py-1.5 tabular-nums">{r.ewayNo}</td>
                  <td className="whitespace-nowrap px-2 py-1.5">
                    {r.movedAway ? (
                      <Badge variant="secondary">Extended Till : {fmt(r.expiry)}</Badge>
                    ) : r.expired ? (
                      <Badge variant="destructive">Expired ({fmt(r.expiry)})</Badge>
                    ) : (
                      <span className="font-medium tabular-nums">{fmt(r.expiry)}</span>
                    )}
                  </td>
                  <td className="whitespace-nowrap px-2 py-1.5">
                    {r.checked ? (
                      <span className="flex items-center gap-1.5">
                        <Badge>✓ Checked</Badge>
                        <span className="text-[11px] text-muted-foreground">
                          {r.checkedBy}
                          {r.checkedAt ? ` · ${formatDate(r.checkedAt)}` : ""}
                        </span>
                        <Button
                          variant="ghost"
                          size="sm"
                          className="h-6 px-1.5 text-[11px]"
                          disabled={busy === r.lrId}
                          onClick={() => void toggleCheck(r)}
                        >
                          Undo
                        </Button>
                      </span>
                    ) : (
                      <Button
                        variant="outline"
                        size="sm"
                        className="h-7 px-2 text-xs"
                        disabled={busy === r.lrId}
                        onClick={() => void toggleCheck(r)}
                      >
                        Check
                      </Button>
                    )}
                  </td>
                  <td className="px-2 py-1.5">
                    {/* moved-away rows stay editable too — a typo'd extension
                        must be correctable from the tab it left behind */}
                    <Button
                      variant="secondary"
                      size="sm"
                      className="h-7 px-2 text-xs"
                      onClick={() => {
                        setEditFor(r);
                        setNewDateText("");
                      }}
                    >
                      Edit
                    </Button>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      {/* extend dialog */}
      <Dialog open={!!editFor} onOpenChange={(o) => !o && setEditFor(null)}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>Extend E-Way Bill — LR {editFor?.lrNo}</DialogTitle>
            <DialogDescription>
              Current expiry: <b>{editFor ? fmt(editFor.expiry) : ""}</b>. After saving, the
              record moves to the new date&apos;s tab and its check mark resets.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-1">
            <Label className="text-xs">New Expiry Date *</Label>
            <DateInput className="h-9" value={newDateText} onChange={setNewDateText} />
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setEditFor(null)} disabled={busy !== null}>
              Cancel
            </Button>
            <Button onClick={submitExtend} disabled={busy !== null || !newDateText}>
              {busy ? "Saving..." : "Update Expiry"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
