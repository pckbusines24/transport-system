"use client";

import * as React from "react";
import type { ColumnDef } from "@tanstack/react-table";
import { formatMoney } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import { InfoHint } from "@/components/ui/info-hint";
import { SimpleMaster, type FieldDef, type FormState } from "@/components/masters/simple-master";
import type { MasterOption } from "@/components/data/master-combobox";
import type { ActionResult } from "../_lib/util";
import { deleteTdsSection, saveTdsSection } from "./actions";

type ModuleRef = "CHALAN" | "BROKER_SLIP" | "HIRE";

export interface SectionRow {
  id: string;
  code: string;
  oldCode: string | null;
  name: string;
  annualLimit: number;
  singleBillLimit: number;
  rateIndividual: number;
  rateCompany: number;
  basis: "FULL" | "EXCESS";
  headIds: string[];
  moduleRefs: ModuleRef[];
}

const MODULES: { value: ModuleRef; label: string }[] = [
  { value: "CHALAN", label: "Challan (Owner)" },
  { value: "BROKER_SLIP", label: "Broker Slip (Owner)" },
  { value: "HIRE", label: "Hire Slip" },
];

const BASIS_OPTIONS: MasterOption[] = [
  { value: "EXCESS", label: "Only the amount ABOVE the annual limit (194Q style)" },
  { value: "FULL", label: "The FULL year's amount once crossed (194C style)" },
];

interface HeadOpt {
  id: string;
  name: string;
}

/**
 * TDS Master on the shared master component — same table, filters, export
 * and edit/delete flow as every other master. The two "one owner only"
 * rules (an expense head or a freight module belongs to a single section)
 * are shown as disabled options tagged with the section that owns them; the
 * server enforces the same rule on save.
 */
export function TdsSectionsClient({
  sections,
  heads,
  canDelete,
}: {
  sections: SectionRow[];
  heads: HeadOpt[];
  canDelete: boolean;
}) {
  const headName = React.useMemo(() => new Map(heads.map((h) => [h.id, h.name])), [heads]);

  const columns: ColumnDef<SectionRow, unknown>[] = [
    {
      accessorKey: "code",
      header: "Section",
      cell: ({ row }) => (
        <span className="whitespace-nowrap font-medium">
          {row.original.code}
          {row.original.oldCode && (
            <span className="ml-1 text-muted-foreground">(old: {row.original.oldCode})</span>
          )}
        </span>
      ),
    },
    { accessorKey: "name", header: "Name" },
    {
      accessorKey: "annualLimit",
      header: "Annual Limit",
      cell: ({ row }) => <span className="tabular-nums">{formatMoney(row.original.annualLimit)}</span>,
      meta: { numeric: true },
    },
    {
      accessorKey: "singleBillLimit",
      header: "Single Bill",
      cell: ({ row }) => (
        <span className="tabular-nums">
          {row.original.singleBillLimit > 0 ? formatMoney(row.original.singleBillLimit) : "—"}
        </span>
      ),
      meta: { numeric: true },
    },
    {
      accessorKey: "rateIndividual",
      header: "Ind/HUF %",
      cell: ({ row }) => <span className="tabular-nums">{row.original.rateIndividual}%</span>,
      meta: { numeric: true },
    },
    {
      accessorKey: "rateCompany",
      header: "Company %",
      cell: ({ row }) => <span className="tabular-nums">{row.original.rateCompany}%</span>,
      meta: { numeric: true },
    },
    {
      accessorKey: "basis",
      header: "TDS On",
      cell: ({ row }) => (
        <Badge variant={row.original.basis === "EXCESS" ? "secondary" : "outline"}>
          {row.original.basis === "EXCESS" ? "Above limit only" : "Full amount"}
        </Badge>
      ),
    },
    {
      id: "connected",
      header: "Connected Heads",
      cell: ({ row }) => {
        const s = row.original;
        if (s.headIds.length === 0 && s.moduleRefs.length === 0)
          return <span className="text-muted-foreground">none</span>;
        return (
          <span className="flex flex-wrap gap-1">
            {s.moduleRefs.map((m) => (
              <Badge key={m} variant="secondary">
                {MODULES.find((x) => x.value === m)?.label ?? m}
              </Badge>
            ))}
            {s.headIds.map((h) => (
              <Badge key={h} variant="outline">
                {headName.get(h) ?? "?"}
              </Badge>
            ))}
          </span>
        );
      },
    },
  ];

  // a head / module already owned by ANOTHER section is offered disabled,
  // tagged with that section's code — the same rule the server enforces
  const ownerOf = (editingId: string | null, pick: (s: SectionRow) => string[]) => {
    const m = new Map<string, string>();
    for (const s of sections) if (s.id !== editingId) for (const k of pick(s)) m.set(k, s.code);
    return m;
  };

  const fields: FieldDef[] = [
    { name: "code", label: "Section Code *", type: "text", uppercase: true, placeholder: "194C" },
    { name: "oldCode", label: "Old Code (hint)", type: "text", uppercase: true, placeholder: "e.g. 194C before renumbering" },
    { name: "name", label: "Name *", type: "text", span2: true },
    { name: "annualLimit", label: "Annual Limit (₹)", type: "number" },
    { name: "singleBillLimit", label: "Single Bill Limit (₹, 0 = none)", type: "number" },
    { name: "rateIndividual", label: "Individual / HUF % (PAN 4th letter P/H)", type: "number" },
    { name: "rateCompany", label: "Company / Firm %", type: "number" },
    { name: "basis", label: "TDS Applies On", type: "select", options: BASIS_OPTIONS, span2: true },
    {
      name: "moduleRefs",
      label: "Freight Modules (labels chalan / slip TDS in the TDS Payable report only)",
      type: "multicombobox",
      span2: true,
      placeholder: "Select modules...",
      optionsFor: ({ editingId }) => {
        const taken = ownerOf(editingId, (s) => s.moduleRefs);
        return MODULES.map((m) => {
          const other = taken.get(m.value);
          return { value: m.value, label: m.label, disabled: !!other, meta: other ? `in ${other}` : undefined };
        });
      },
    },
    {
      name: "headIds",
      label: "Connected Expense Heads (a head belongs to one section only)",
      type: "multicombobox",
      span2: true,
      placeholder: "Search heads...",
      optionsFor: ({ editingId }) => {
        const taken = ownerOf(editingId, (s) => s.headIds);
        return heads.map((h) => {
          const other = taken.get(h.id);
          return { value: h.id, label: h.name, disabled: !!other, meta: other ? `in ${other}` : undefined };
        });
      },
    },
  ];

  const toResult = (r: { ok: true } | { ok: false; error: string }, id: string): ActionResult =>
    r.ok ? { ok: true, id } : r;

  return (
    <SimpleMaster
      title="TDS Section"
      heading="TDS Master"
      titleExtra={
        <InfoHint>
          Each section carries its threshold limits, rates (by PAN 4th letter: Individual/HUF vs
          Company/Firm) and the expense heads connected to it. A head can belong to only one
          section. Old section codes stay visible as hints while the new Income Tax Act numbering
          is adopted.
        </InfoHint>
      }
      newLabel="Add Section"
      rows={sections}
      columns={columns}
      exportColumns={[
        { header: "Section", key: "code" },
        { header: "Old Code", key: "oldCode" },
        { header: "Name", key: "name" },
        { header: "Annual Limit", key: "annualLimit", numeric: true },
        { header: "Single Bill Limit", key: "singleBillLimit", numeric: true },
        { header: "Ind/HUF %", key: "rateIndividual", numeric: true },
        { header: "Company %", key: "rateCompany", numeric: true },
        { header: "TDS On", accessor: (r) => (r.basis === "EXCESS" ? "Above limit only" : "Full amount") },
        {
          header: "Freight Modules",
          accessor: (r) => r.moduleRefs.map((m) => MODULES.find((x) => x.value === m)?.label ?? m).join(", "),
        },
        {
          header: "Connected Heads",
          accessor: (r) => r.headIds.map((h) => headName.get(h) ?? "?").join(", "),
        },
      ]}
      exportName="tds-sections"
      filters={[{ type: "text", key: "q", label: "Search section or name..." }]}
      fields={fields}
      defaults={{
        code: "",
        oldCode: "",
        name: "",
        annualLimit: 0,
        singleBillLimit: 0,
        rateIndividual: 0,
        rateCompany: 0,
        basis: "FULL",
        headIds: [],
        moduleRefs: [],
      }}
      toForm={(r) => ({
        code: r.code,
        oldCode: r.oldCode ?? "",
        name: r.name,
        annualLimit: r.annualLimit,
        singleBillLimit: r.singleBillLimit,
        rateIndividual: r.rateIndividual,
        rateCompany: r.rateCompany,
        basis: r.basis,
        headIds: [...r.headIds],
        moduleRefs: [...r.moduleRefs],
      })}
      getId={(r) => r.id}
      transform={(f: FormState) => ({
        ...f,
        oldCode: (f.oldCode as string) || null,
        annualLimit: Number(f.annualLimit) || 0,
        singleBillLimit: Number(f.singleBillLimit) || 0,
        rateIndividual: Number(f.rateIndividual) || 0,
        rateCompany: Number(f.rateCompany) || 0,
      })}
      save={async (input) => {
        const d = input as Parameters<typeof saveTdsSection>[0];
        return toResult(await saveTdsSection(d), d.id ?? "");
      }}
      remove={async (id) => toResult(await deleteTdsSection(id), id)}
      canDelete={canDelete}
      refKind="tdsSection"
      dialogClassName="max-h-[92vh] overflow-y-auto sm:max-w-2xl"
    />
  );
}
