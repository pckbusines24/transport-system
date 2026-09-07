"use client";

import * as React from "react";
import { Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useToast } from "@/components/ui/use-toast";
import { getMasterReferences } from "@/app/(app)/masters/_lib/ref-actions";
import type { MasterKind, MasterRefReport } from "@/lib/master-refs";

/**
 * The one delete confirmation for masters AND documents.
 *
 * Before offering a Delete button it asks the server where the record is
 * still used and shows the dependents (type, count, example numbers). A
 * hard-delete record is blocked while anything points at it; a
 * "deactivate" record shows the list for information and still allows the
 * action; an unused record gets a plain explicit confirm.
 */
export type DeleteCheckState = null | "loading" | MasterRefReport;

export function useDeletePrecheck(kind: MasterKind | undefined) {
  const { toast } = useToast();
  const [state, setState] = React.useState<DeleteCheckState>(null);
  const start = React.useCallback(
    async (id: string) => {
      if (!kind) {
        // leaf record nothing points at — straight to the explicit confirm
        setState({ total: 0, groups: [] });
        return;
      }
      setState("loading");
      try {
        setState(await getMasterReferences(kind, id));
      } catch (e) {
        setState(null);
        toast({
          variant: "destructive",
          title: "Could not check references",
          description: e instanceof Error ? e.message : "Try again",
        });
      }
    },
    [kind, toast]
  );
  const close = React.useCallback(() => setState(null), []);
  return { state, start, close };
}

export function DeletePrecheckDialog({
  state,
  subject,
  mode = "delete",
  deleting,
  onCancel,
  onConfirm,
  extraNote,
}: {
  state: DeleteCheckState;
  /** what is being deleted, lower case, e.g. "city" or "invoice INV-0012" */
  subject: string;
  mode?: "delete" | "deactivate";
  deleting: boolean;
  onCancel: () => void;
  onConfirm: () => void;
  /** consequence shown on the plain confirm, e.g. "Its LRs become pending again." */
  extraNote?: string;
}) {
  const deactivate = mode === "deactivate";
  const verb = deactivate ? "Deactivate" : "Delete";
  const report = state && state !== "loading" ? state : null;
  const inUse = !!report && report.total > 0;
  const blocked = inUse && !deactivate;
  const busyLabel = deactivate ? "Deactivating…" : "Deleting…";

  return (
    <Dialog open={state !== null} onOpenChange={(o) => !o && !deleting && onCancel()}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>
            {state === "loading"
              ? `Checking where this ${subject} is used…`
              : blocked
                ? `Cannot delete — this ${subject} is in use`
                : inUse
                  ? `This ${subject} is in use`
                  : `${verb} this ${subject}?`}
          </DialogTitle>
          <DialogDescription>
            {state === "loading"
              ? "Looking through LRs, chalans, slips, vouchers and other entries."
              : blocked
                ? "Deleting it now would leave the entries below pointing at nothing. Delete or re-point those entries first, then delete this record."
                : inUse
                  ? "It stays on every entry below for history. Deactivating only hides it from new entries."
                  : `Nothing else refers to it. ${extraNote ?? ""} This cannot be undone.`}
          </DialogDescription>
        </DialogHeader>
        {inUse && (
          <div className="max-h-72 overflow-y-auto rounded-md border">
            <table className="w-full text-sm">
              <thead className="bg-muted/50 text-xs uppercase text-muted-foreground">
                <tr>
                  <th className="px-3 py-1.5 text-left font-medium">Used in</th>
                  <th className="px-3 py-1.5 text-right font-medium">Entries</th>
                  <th className="px-3 py-1.5 text-left font-medium">Examples</th>
                </tr>
              </thead>
              <tbody>
                {report!.groups.map((g) => (
                  <tr key={g.label} className="border-t">
                    <td className="px-3 py-1.5 capitalize">{g.label}</td>
                    <td className="px-3 py-1.5 text-right tabular-nums">{g.count}</td>
                    <td className="px-3 py-1.5 text-muted-foreground">
                      {g.samples.join(", ")}
                      {g.count > g.samples.length && g.samples.length > 0 ? ", …" : ""}
                    </td>
                  </tr>
                ))}
                <tr className="border-t font-semibold">
                  <td className="px-3 py-1.5">Total</td>
                  <td className="px-3 py-1.5 text-right tabular-nums">{report!.total}</td>
                  <td />
                </tr>
              </tbody>
            </table>
          </div>
        )}
        <DialogFooter className="gap-2">
          <Button variant="outline" onClick={onCancel} disabled={deleting}>
            {blocked ? "Close" : "Cancel"}
          </Button>
          {report && !blocked && (
            <Button variant="destructive" onClick={onConfirm} disabled={deleting}>
              <Trash2 className="h-4 w-4" />
              {deleting ? busyLabel : inUse ? `${verb} anyway` : verb}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
