"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { Pencil, Trash2 } from "lucide-react";
import { formatDate, formatMoney } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
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
import { LrForm, type LrFormProps, type LrFormValues } from "@/components/lr/lr-form";
import { saveLrBatch } from "@/app/(app)/lr/actions";

type Payload = Record<string, unknown>;

interface BatchEntry {
  /** validated payload sent to saveLrBatch */
  payload: Payload;
  /** raw form-value snapshot, so the row can be loaded back into the form for editing */
  values: LrFormValues;
}

interface PayloadItem {
  actualWt?: number;
  chargeWt?: number;
}

/**
 * Multiple LR entry: the complete LR Entry form runs in batch mode — every
 * "Add Another LR" captures a full LR payload and keeps all values for the
 * next entry (vehicle + date stay the same; edit only what differs). Any
 * batched LR can be loaded back into the form with its Edit button and
 * updated in place. "Save All LRs" writes the whole batch in one database
 * transaction.
 */
export function MultiLrBatch(props: Omit<LrFormProps, "mode" | "isDummy">) {
  const router = useRouter();
  const { toast } = useToast();
  const [batch, setBatch] = React.useState<BatchEntry[]>([]);
  const [editIndex, setEditIndex] = React.useState<number | null>(null);
  const [saving, setSaving] = React.useState(false);
  const formApi = React.useRef<{ getValues: () => LrFormValues; reset: (v: LrFormValues) => void } | null>(null);
  // form values as they were before an edit began — restored once the edit ends
  const preEditValues = React.useRef<LrFormValues | null>(null);
  const formAnchor = React.useRef<HTMLDivElement>(null);

  const label = React.useCallback(
    (options: { value: string; label: string }[], v: unknown) =>
      options.find((o) => o.value === v)?.label ?? "",
    []
  );

  const onBatchAdd = (payload: Payload, values: LrFormValues) => {
    if (editIndex !== null) {
      setBatch((b) => b.map((e, i) => (i === editIndex ? { payload, values } : e)));
      endEdit();
      toast({
        title: `LR ${payload.lrNo} updated in the batch`,
        description: "The summary above now shows the edited details. Nothing is saved until Save All LRs.",
      });
    } else {
      setBatch((b) => [...b, { payload, values }]);
      toast({
        title: `LR ${payload.lrNo} added to the batch (not saved yet)`,
        description:
          "A new LR is ready with the previous details pre-filled — change only what differs, then Add LR again or Save All.",
      });
    }
    // bring the user back to the top so the batch + fresh form are visible
    window.scrollTo({ top: 0, behavior: "smooth" });
  };

  const startEdit = (i: number) => {
    if (!formApi.current) return;
    // remember the in-progress next-LR values only when entering edit mode
    if (editIndex === null) preEditValues.current = formApi.current.getValues();
    formApi.current.reset(structuredClone(batch[i].values));
    setEditIndex(i);
    formAnchor.current?.scrollIntoView({ behavior: "smooth", block: "start" });
  };

  const endEdit = (restore = true) => {
    if (restore && preEditValues.current && formApi.current) {
      formApi.current.reset(preEditValues.current);
    }
    preEditValues.current = null;
    setEditIndex(null);
  };

  const removeEntry = (i: number) => {
    if (editIndex === i) endEdit();
    else if (editIndex !== null && editIndex > i) setEditIndex(editIndex - 1);
    setBatch((b) => b.filter((_, idx) => idx !== i));
  };

  // nothing is in the database until "Save All LRs" — warn before losing the batch
  React.useEffect(() => {
    if (batch.length === 0) return;
    const warn = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = "";
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [batch.length]);

  const discardBatch = () => {
    if (!window.confirm(`Discard all ${batch.length} unsaved LR(s)? Nothing has been written to the database.`))
      return;
    endEdit(false);
    setBatch([]);
    toast({ title: "Batch discarded — no LRs were saved" });
  };

  const saveAll = async () => {
    if (batch.length === 0) {
      toast({
        variant: "destructive",
        title: "Batch is empty",
        description: 'Fill the form and click "Add Another LR" first.',
      });
      return;
    }
    if (editIndex !== null) {
      toast({
        variant: "destructive",
        title: "Finish the edit first",
        description: `LR ${String(batch[editIndex].payload.lrNo)} is open in the form — click "Update LR in Batch" or Cancel Edit.`,
      });
      return;
    }
    setSaving(true);
    try {
      const res = await saveLrBatch({ entries: batch.map((e) => e.payload) });
      if (res.ok) {
        toast({
          title: `${res.lrNos.length} LRs created in one transaction`,
          description: `LR Nos ${res.lrNos[0]} – ${res.lrNos[res.lrNos.length - 1]}`,
        });
        router.push("/lr/register");
      } else {
        toast({ variant: "destructive", title: "Save failed", description: res.error });
      }
    } finally {
      setSaving(false);
    }
  };

  const freightOf = (p: Payload) => Number(p.freight ?? 0);
  const actualWtOf = (p: Payload) =>
    ((p.items as PayloadItem[] | undefined) ?? []).reduce((s, it) => s + Number(it.actualWt ?? 0), 0);
  const chargeWtOf = (p: Payload) =>
    ((p.items as PayloadItem[] | undefined) ?? []).reduce((s, it) => s + Number(it.chargeWt ?? 0), 0);
  const fmtWt = (n: number) => n.toLocaleString("en-IN", { maximumFractionDigits: 3 });

  return (
    <div className="space-y-4">
      {/* batch tray */}
      <Card className="border-primary/40">
        <CardHeader className="p-4 pb-2">
          <CardTitle className="flex items-center justify-between text-sm">
            <span>
              LRs in this batch <Badge variant="secondary">{batch.length}</Badge>
              <span className="ml-2 font-normal text-muted-foreground">
                — each LR keeps its own vehicle &amp; date as shown below; numbers are sequential
              </span>
            </span>
            <span className="flex flex-wrap items-center gap-2">
              {editIndex !== null && (
                <Button variant="outline" onClick={() => endEdit()} disabled={saving}>
                  Cancel Edit
                </Button>
              )}
              {batch.length > 0 && (
                <Button variant="outline" onClick={discardBatch} disabled={saving}>
                  Discard Batch
                </Button>
              )}
              <Button onClick={saveAll} disabled={saving || batch.length === 0 || editIndex !== null}>
                {saving ? "Saving..." : `Save All LRs (${batch.length})`}
              </Button>
            </span>
          </CardTitle>
        </CardHeader>
        <CardContent className="p-4 pt-1">
          {batch.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              Fill the LR form below and click <b>Add LR</b> — each LR joins this list
              temporarily. Nothing is saved to the database until you click
              <b> Save All LRs</b>; closing the page discards the batch.
            </p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="text-xs">LR No</TableHead>
                  <TableHead className="text-xs">Date</TableHead>
                  <TableHead className="text-xs">Consignor</TableHead>
                  <TableHead className="text-xs">Consignee</TableHead>
                  <TableHead className="text-xs">Route</TableHead>
                  <TableHead className="text-xs">Invoice No</TableHead>
                  <TableHead className="text-right text-xs">Actual Wt</TableHead>
                  <TableHead className="text-right text-xs">Charge Wt</TableHead>
                  <TableHead className="text-right text-xs">Freight</TableHead>
                  <TableHead className="text-xs">Type</TableHead>
                  <TableHead className="w-16" />
                </TableRow>
              </TableHeader>
              <TableBody>
                {batch.map(({ payload: e }, i) => (
                  <TableRow key={i} className={editIndex === i ? "bg-accent/50" : undefined}>
                    <TableCell>{String(e.lrNo)}</TableCell>
                    <TableCell>{formatDate(String(e.lrDate))}</TableCell>
                    <TableCell>{label(props.partyOptions, e.consignorId)}</TableCell>
                    <TableCell>{label(props.partyOptions, e.consigneeId)}</TableCell>
                    <TableCell>
                      {label(props.cityOptions, e.sourceCityId)} →{" "}
                      {label(props.cityOptions, e.destCityId)}
                    </TableCell>
                    <TableCell>
                      {Array.isArray(e.invoices) && e.invoices.length
                        ? (e.invoices as { invoiceNo?: string | null }[])
                            .map((r) => r.invoiceNo)
                            .filter(Boolean)
                            .join(", ") || "-"
                        : "-"}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">{fmtWt(actualWtOf(e))}</TableCell>
                    <TableCell className="text-right tabular-nums">{fmtWt(chargeWtOf(e))}</TableCell>
                    <TableCell className="text-right tabular-nums">
                      {formatMoney(freightOf(e))}
                    </TableCell>
                    <TableCell>
                      <Badge variant="outline">{String(e.lrType).replace("_", " ")}</Badge>
                    </TableCell>
                    <TableCell>
                      <span className="flex items-center">
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon"
                          className="h-7 w-7"
                          title="Edit this LR before saving"
                          disabled={saving}
                          onClick={() => startEdit(i)}
                        >
                          <Pencil className="h-3.5 w-3.5" />
                        </Button>
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon"
                          className="h-7 w-7 text-destructive"
                          title="Remove from batch"
                          disabled={saving}
                          onClick={() => removeEntry(i)}
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </Button>
                      </span>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
              <TableFooter>
                <TableRow>
                  <TableCell colSpan={6}>Total ({batch.length} LRs)</TableCell>
                  <TableCell className="text-right tabular-nums">
                    {fmtWt(batch.reduce((s, e) => s + actualWtOf(e.payload), 0))}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {fmtWt(batch.reduce((s, e) => s + chargeWtOf(e.payload), 0))}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {formatMoney(batch.reduce((s, e) => s + freightOf(e.payload), 0))}
                  </TableCell>
                  <TableCell colSpan={2} />
                </TableRow>
              </TableFooter>
            </Table>
          )}
        </CardContent>
      </Card>

      {/* the complete LR form, in batch mode */}
      <div ref={formAnchor}>
        {editIndex !== null && (
          <p className="mb-2 text-sm font-medium text-primary">
            Editing LR {String(batch[editIndex]?.payload.lrNo ?? "")} from the batch — change any
            field and click &quot;Update LR in Batch&quot;.
          </p>
        )}
        <LrForm
          {...props}
          mode="create"
          isDummy={false}
          batchMode
          batchEditing={editIndex !== null}
          onBatchAdd={onBatchAdd}
          exposeFormApi={(api) => (formApi.current = api)}
        />
      </div>
    </div>
  );
}
