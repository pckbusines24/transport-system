"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import type { ColumnDef } from "@tanstack/react-table";
import { Badge } from "@/components/ui/badge";
import { useToast } from "@/components/ui/use-toast";
import { SimpleMaster } from "@/components/masters/simple-master";
import {
  saveAccountHead,
  deleteAccountHead,
  importAccountHeads,
  setPnlScope,
  type PnlScope,
} from "@/app/(app)/masters/account-heads/actions";

interface Row {
  id: string;
  name: string;
  kind: string;
  pnlScope: PnlScope;
  /** software-owned head — seeded automatically; only Admin / Owner may edit or delete */
  system: boolean;
}

const SCOPE_OPTIONS: { value: PnlScope; label: string }[] = [
  { value: "AUTO", label: "Auto (module-wise)" },
  { value: "COMPANY", label: "Company P&L" },
  { value: "VEHICLE", label: "Vehicle P&L" },
  { value: "EXCLUDE", label: "Exclude from both" },
];

/** inline instant-save dropdown — reporting placement only, never postings */
function ScopeCell({ row }: { row: Row }) {
  const router = useRouter();
  const { toast } = useToast();
  const [value, setValue] = React.useState<PnlScope>(row.pnlScope);
  const [busy, setBusy] = React.useState(false);
  const change = async (scope: PnlScope) => {
    const prev = value;
    setValue(scope);
    setBusy(true);
    const res = await setPnlScope(row.id, scope);
    setBusy(false);
    if (res.ok) {
      toast({
        title: `${row.name} → ${SCOPE_OPTIONS.find((s) => s.value === scope)?.label}`,
      });
      router.refresh();
    } else {
      setValue(prev);
      toast({ variant: "destructive", title: res.error });
    }
  };
  return (
    <select
      className={`h-8 w-44 rounded-md border border-input bg-background px-2 text-xs ${
        value !== "AUTO" ? "font-semibold" : ""
      }`}
      value={value}
      disabled={busy}
      title="Which operational P&L this head reports in. Auto (default) lets the posting module decide. Company / Vehicle moves ALL the head's entries to that P&L; Exclude drops it from both. Saves instantly."
      onClick={(e) => e.stopPropagation()}
      onChange={(e) => change(e.target.value as PnlScope)}
    >
      {SCOPE_OPTIONS.map((s) => (
        <option key={s.value} value={s.value}>
          {s.label}
        </option>
      ))}
    </select>
  );
}

const columns: ColumnDef<Row, unknown>[] = [
  { accessorKey: "name", header: "Name" },
  {
    accessorKey: "kind",
    header: "Kind",
    cell: ({ row }) => (
      <Badge variant={row.original.kind === "INCOME" ? "default" : "secondary"}>
        {row.original.kind}
      </Badge>
    ),
  },
  {
    accessorKey: "pnlScope",
    header: "P&L Scope",
    cell: ({ row }) => <ScopeCell row={row.original} />,
  },
  {
    accessorKey: "system",
    header: "Source",
    cell: ({ row }) =>
      row.original.system ? (
        <Badge variant="outline" title="Created and used by the software — only Admin / Owner may edit or delete it">
          SYSTEM
        </Badge>
      ) : (
        <Badge variant="secondary" title="Created by a user">
          USER
        </Badge>
      ),
  },
];

export function AccountHeadsClient({
  rows,
  canDelete,
  canManageSystem,
}: {
  rows: Row[];
  canDelete: boolean;
  /** Admin / Owner may edit or delete SYSTEM heads; everyone else sees them locked */
  canManageSystem: boolean;
}) {
  return (
    <SimpleMaster
      title="Account Head"
      rows={rows}
      columns={columns}
      exportColumns={[
        { header: "Name", key: "name" },
        { header: "Kind", key: "kind" },
        {
          header: "P&L Scope",
          accessor: (r) => SCOPE_OPTIONS.find((s) => s.value === r.pnlScope)?.label ?? r.pnlScope,
        },
      ]}
      exportName="account-heads"
      filters={[
        { type: "text", key: "q", label: "Search name..." },
        {
          type: "select",
          key: "kind",
          label: "Kind",
          options: [
            { value: "INCOME", label: "Income" },
            { value: "EXPENSE", label: "Expense" },
          ],
        },
      ]}
      fields={[
        { name: "name", label: "Name *", type: "text", uppercase: false },
        {
          name: "kind",
          label: "Kind *",
          type: "select",
          options: [
            { value: "INCOME", label: "Income" },
            { value: "EXPENSE", label: "Expense" },
          ],
        },
      ]}
      defaults={{ name: "", kind: "EXPENSE" }}
      toForm={(r) => ({ name: r.name, kind: r.kind })}
      getId={(r) => r.id}
      save={saveAccountHead}
      remove={deleteAccountHead}
      refKind="accountHead"
      importConfig={{
        action: importAccountHeads,
        templateHeaders: ["Name", "Kind"],
        templateExample: ["LOADING CHARGES", "INCOME"],
        templateName: "account-heads",
      }}
      canDelete={canDelete}
      rowLocked={(r) =>
        r.system && !canManageSystem
          ? `"${r.name}" is a system ledger head — the software posts to it automatically; only Admin / Owner may edit or delete it.`
          : null
      }
    />
  );
}
