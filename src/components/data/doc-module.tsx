"use client";

/**
 * Serializable wrapper around SimpleMaster for firm/FY document modules
 * (loading chalan, delivery, hire slip, ...). Server pages pass plain-data
 * column/field specs plus server actions; no per-module client file needed.
 */

import * as React from "react";
import type { MasterKind } from "@/lib/master-refs";
import type { ColumnDef } from "@tanstack/react-table";
import { Badge } from "@/components/ui/badge";
import type { MasterOption } from "@/components/data/master-combobox";
import type { FilterDef } from "@/components/data/filter-bar";
import type { ExportColumn } from "@/components/data/export-button";
import {
  SimpleMaster,
  type ActionResult,
  type FieldDef,
  type FormState,
} from "@/components/masters/simple-master";
import { formatMoney, toNum } from "@/lib/utils";
import type { DataTableColumnMeta } from "@/components/data/data-table";

export type DocRow = Record<string, unknown> & { id: string };

export interface DocColumnSpec {
  key: string;
  header: string;
  kind?: "text" | "money" | "badge";
  /** money columns show a totals footer by default */
  total?: boolean;
}

export interface DocFieldSpec {
  name: string;
  label: string;
  type: "text" | "number" | "textarea" | "switch" | "select" | "combobox" | "date" | "radio";
  options?: MasterOption[];
  span2?: boolean;
  uppercase?: boolean;
  /** show only when another field has one of these values */
  showWhen?: { field: string; values: string[] };
}

export function DocModule({
  title,
  newLabel,
  rows,
  columns,
  fields,
  defaults,
  filters,
  exportName,
  save,
  remove,
  canDelete,
  refKind,
  numericFields,
  totals,
}: {
  title: string;
  newLabel?: string;
  rows: DocRow[];
  columns: DocColumnSpec[];
  fields: DocFieldSpec[];
  defaults: FormState;
  filters?: FilterDef[];
  exportName: string;
  save: (input: unknown) => Promise<ActionResult>;
  remove?: (id: string) => Promise<ActionResult>;
  canDelete: boolean;
  /** reference-registry kind for the delete pre-check dialog */
  refKind?: MasterKind;
  /** form fields coerced to numbers before save */
  numericFields?: string[];
  /**
   * Footer totals by column key over the FULL filtered set (rows may be one
   * page of a paginated register). Falls back to summing the visible rows.
   */
  totals?: Record<string, number>;
}) {
  const columnDefs = React.useMemo<ColumnDef<DocRow, unknown>[]>(
    () =>
      columns.map((c) => ({
        id: c.key,
        accessorKey: c.key,
        header: c.header,
        meta: {
          numeric: c.kind === "money",
          total:
            c.kind === "money" && c.total !== false
              ? totals && c.key in totals
                ? formatMoney(totals[c.key])
                : (all: DocRow[]) => formatMoney(all.reduce((s, r) => s + toNum(r[c.key]), 0))
              : undefined,
        } satisfies DataTableColumnMeta<DocRow>,
        cell: ({ row }) => {
          const v = row.original[c.key];
          if (v === null || v === undefined || v === "") return "";
          if (c.kind === "money") return formatMoney(toNum(v));
          if (c.kind === "badge") return <Badge variant="secondary">{String(v)}</Badge>;
          return String(v);
        },
      })),
    [columns, totals]
  );

  const exportColumns = React.useMemo<ExportColumn<DocRow>[]>(
    () =>
      columns.map((c) => ({
        header: c.header,
        numeric: c.kind === "money",
        accessor: (r: DocRow) => {
          const v = r[c.key];
          if (c.kind === "money") return toNum(v);
          return v == null ? "" : String(v);
        },
      })),
    [columns]
  );

  const fieldDefs = React.useMemo<FieldDef[]>(
    () =>
      fields.map((f) => ({
        name: f.name,
        label: f.label,
        type: f.type,
        options: f.options,
        span2: f.span2,
        uppercase: f.uppercase,
        visibleIf: f.showWhen
          ? (form: FormState) => f.showWhen!.values.includes(String(form[f.showWhen!.field]))
          : undefined,
      })),
    [fields]
  );

  return (
    <SimpleMaster
      title={title}
      newLabel={newLabel ?? `New ${title}`}
      rows={rows}
      columns={columnDefs}
      exportColumns={exportColumns}
      exportName={exportName}
      filters={filters}
      fields={fieldDefs}
      defaults={defaults}
      toForm={(r) => ({ ...r })}
      getId={(r) => r.id}
      save={save}
      remove={remove}
      canDelete={canDelete}
      refKind={refKind}
      transform={(f) => {
        const out: FormState = { ...f };
        for (const k of numericFields ?? []) out[k] = Number(out[k]) || 0;
        return out;
      }}
      dialogClassName="max-h-[90vh] overflow-y-auto sm:max-w-3xl"
    />
  );
}
