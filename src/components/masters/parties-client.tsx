"use client";

import type { ColumnDef } from "@tanstack/react-table";
import { Badge } from "@/components/ui/badge";
import type { MasterOption } from "@/components/data/master-combobox";
import { SimpleMaster, type FormState } from "@/components/masters/simple-master";
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

// INCOME / OFFICE / EXPENSE / RELATIVE removed from the party master per requirements
// (relatives are just an ownership *type* on vehicles, backed by Owner/Broker parties);
// BANK / CASH live in the dedicated Bank & Cash Heads master.
// Existing records with removed groups still render via groupLabel.
const GROUPS = [
  "CONSIGNEE_CONSIGNOR",
  "DRIVER",
  "OWNER_BROKER",
  "STAFF",
  "SUPPLIERS",
];

const groupLabel = (g: string) =>
  g.split("_").map((w) => w.charAt(0) + w.slice(1).toLowerCase()).join(" / ");

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
      fields={[
        { name: "name", label: "Name *", type: "text", uppercase: true },
        {
          name: "ledgerGroup",
          label: "Ledger Group *",
          type: "select",
          options: GROUPS.map((g) => ({ value: g, label: groupLabel(g) })),
        },
        // for owners/brokers the trade name belongs right under the name
        {
          name: "transportName",
          label: "Transport Name (owners / brokers)",
          type: "text",
          uppercase: true,
          visibleIf: (f: FormState) => f.ledgerGroup === "OWNER_BROKER",
          span2: true,
        },
        { name: "alias", label: "Alias / Short Name", type: "text" },
        {
          name: "tallyName",
          label: "Tally Name",
          type: "text",
          uppercase: true,
          placeholder: "fill only when the name differs in Tally",
        },
        { name: "address1", label: "Address 1", type: "text", span2: true },
        { name: "address2", label: "Address 2", type: "text", span2: true },
        { name: "stateId", label: "State", type: "combobox", options: stateOptions },
        { name: "cityId", label: "City", type: "combobox", options: cityOptions },
        { name: "gstin", label: "GSTIN", type: "text", uppercase: true },
        { name: "pan", label: "PAN", type: "text", uppercase: true },
        // vendor code pairs with mobile so no column is left blank
        { name: "vendorCode", label: "Vendor Code", type: "text" },
        { name: "mobile", label: "Mobile", type: "text" },
        { name: "phone", label: "Phone", type: "text" },
        { name: "email", label: "Email", type: "text" },
        { name: "ownerName", label: "Owner / Contact Person", type: "text", span2: true },
        { name: "openingBalance", label: "Opening Balance", type: "number" },
        {
          name: "openingSide",
          label: "Opening Side",
          type: "radio",
          options: [
            { value: "DEBIT", label: "Debit" },
            { value: "CREDIT", label: "Credit" },
          ],
        },
        {
          name: "tdsMode",
          label: "TDS Handling (owners/brokers)",
          type: "radio",
          options: [
            { value: "TDS_APPLICABLE", label: "TDS Applicable" },
            { value: "DECLARATION", label: "Declaration (No TDS)" },
          ],
          visibleIf: (f: FormState) => f.ledgerGroup === "OWNER_BROKER",
          span2: true,
        },
        { name: "bankName", label: "Bank Name", type: "text" },
        { name: "bankAccount", label: "Bank A/c No", type: "text" },
        { name: "bankIfsc", label: "IFSC", type: "text", uppercase: true },
        { name: "isActive", label: "Active", type: "switch" },
      ]}
      // openingSide has NO default — the user chooses Dr/Cr; the server
      // rejects an opening amount saved without a chosen side
      defaults={{
        name: "",
        ledgerGroup: "CONSIGNEE_CONSIGNOR",
        openingBalance: 0,
        tdsMode: "TDS_APPLICABLE",
        isActive: true,
      }}
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
      transform={(f) => ({ ...f, openingBalance: Number(f.openingBalance) || 0 })}
      dialogClassName="max-h-[90vh] overflow-y-auto sm:max-w-2xl"
    />
  );
}
