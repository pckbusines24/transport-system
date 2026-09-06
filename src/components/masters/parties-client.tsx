"use client";

import type { ColumnDef } from "@tanstack/react-table";
import { Badge } from "@/components/ui/badge";
import type { MasterOption } from "@/components/data/master-combobox";
import { SimpleMaster } from "@/components/masters/simple-master";
import {
  PARTY_GROUPS as GROUPS,
  partyDefaults,
  partyDialogClassName,
  partyFields,
  partyGroupLabel as groupLabel,
  partyTransform,
} from "@/components/masters/field-defs";
import { CityCreateDialog } from "@/components/masters/inline-dialogs";
import { saveParty, deleteParty, importParties } from "@/app/(app)/masters/parties/actions";
import { formatMoney } from "@/lib/utils";

export interface PartyRow {
  id: string;
  name: string;
  ledgerGroup: string;
  alias: string | null;
  address1: string | null;
  address2: string | null;
  stateId: string | null;
  cityId: string | null;
  gstin: string | null;
  pan: string | null;
  mobile: string | null;
  phone: string | null;
  email: string | null;
  ownerName: string | null;
  transportName: string | null;
  /** Tally export: ledger name in Tally when it differs from the name here */
  tallyName: string | null;
  vendorCode: string | null;
  openingBalance: number;
  openingSide: string;
  tdsMode: string | null;
  bankName: string | null;
  bankAccount: string | null;
  bankIfsc: string | null;
  isActive: boolean;
}

const columns: ColumnDef<PartyRow, unknown>[] = [
  { accessorKey: "name", header: "Name" },
  {
    accessorKey: "ledgerGroup",
    header: "Group",
    cell: ({ row }) => <Badge variant="secondary">{groupLabel(row.original.ledgerGroup)}</Badge>,
  },
  {
    accessorKey: "transportName",
    header: "Transport Name",
    cell: ({ row }) => row.original.transportName ?? "—",
  },
  { accessorKey: "gstin", header: "GSTIN" },
  { accessorKey: "pan", header: "PAN" },
  { accessorKey: "mobile", header: "Mobile" },
  {
    accessorKey: "openingBalance",
    header: "Opening",
    cell: ({ row }) =>
      row.original.openingBalance
        ? `${formatMoney(row.original.openingBalance)} ${row.original.openingSide === "DEBIT" ? "Dr" : "Cr"}`
        : "",
    meta: { numeric: true },
  },
  {
    accessorKey: "isActive",
    header: "Status",
    cell: ({ row }) =>
      row.original.isActive ? (
        <Badge>Active</Badge>
      ) : (
        <Badge variant="outline">Inactive</Badge>
      ),
  },
];

export function PartiesClient({
  rows,
  stateOptions,
  cityOptions,
  canDelete,
}: {
  rows: PartyRow[];
  stateOptions: MasterOption[];
  cityOptions: MasterOption[];
  canDelete: boolean;
}) {
  return (
    <SimpleMaster
      title="Party / Ledger"
      newLabel="New Party"
      rows={rows}
      columns={columns}
      exportColumns={[
        { header: "Name", key: "name" },
        { header: "Group", accessor: (r) => groupLabel(r.ledgerGroup) },
        { header: "Alias", key: "alias" },
        { header: "Address", accessor: (r) => [r.address1, r.address2].filter(Boolean).join(", ") },
        { header: "GSTIN", key: "gstin" },
        { header: "PAN", key: "pan" },
        { header: "Mobile", key: "mobile" },
        { header: "Email", key: "email" },
        { header: "Opening", key: "openingBalance", numeric: true },
        { header: "Dr/Cr", key: "openingSide" },
        { header: "Active", accessor: (r) => (r.isActive ? "YES" : "NO") },
      ]}
      exportName="parties"
      filters={[
        { type: "text", key: "q", label: "Search name / transport / GSTIN / PAN..." },
        {
          type: "select",
          key: "group",
          label: "Ledger Group",
          options: GROUPS.map((g) => ({ value: g, label: groupLabel(g) })),
        },
        {
          type: "select",
          key: "status",
          label: "Status",
          options: [
            { value: "active", label: "Active" },
            { value: "inactive", label: "Inactive" },
          ],
        },
      ]}
      // same field list as the inline "+ Create party" dialog (field-defs.tsx)
      fields={partyFields({
        stateOptions,
        cityOptions,
        cityCreate: (p) => <CityCreateDialog {...p} />,
      })}
      defaults={partyDefaults}
      toForm={(r) => ({ ...r })}
      getId={(r) => r.id}
      save={saveParty}
      remove={deleteParty}
      importConfig={{
        action: importParties,
        templateHeaders: ["Name", "Group", "GSTIN", "PAN", "Mobile", "Email", "Address", "Transport Name", "Opening Balance", "Opening Side"],
        templateExample: ["DEMO TRANSPORT CO", "BROKER", "", "AAACD1234F", "9876543210", "", "Transport Nagar", "DEMO ROADWAYS", "0", "DEBIT"],
        templateName: "parties",
      }}
      canDelete={canDelete}
      transform={partyTransform}
      dialogClassName={partyDialogClassName}
    />
  );
}
