"use client";

/**
 * Master record field definitions — ONE definition per master, shared by the
 * master screen (SimpleMaster) and the inline "+ Create" dialogs opened from
 * comboboxes on transaction forms (inline-dialogs.tsx).
 *
 * Any field added here shows up in both places, so the quick-create dialog
 * can never drift from the master form again.
 */

import type * as React from "react";
import type { MasterOption } from "@/components/data/master-combobox";
import type { CreateDialogProps, FieldDef, FormState } from "@/components/masters/simple-master";

export type CreateDialog = (props: CreateDialogProps) => React.ReactNode;

// ---------- Party / Ledger ----------

// INCOME / OFFICE / EXPENSE / RELATIVE removed from the party master per requirements
// (relatives are just an ownership *type* on vehicles, backed by Owner/Broker parties);
// BANK / CASH live in the dedicated Bank & Cash Heads master.
// Existing records with removed groups still render via groupLabel.
export const PARTY_GROUPS = [
  "CONSIGNEE_CONSIGNOR",
  "DRIVER",
  "OWNER_BROKER",
  "STAFF",
  "SUPPLIERS",
] as const;

export const partyGroupLabel = (g: string) =>
  g.split("_").map((w) => w.charAt(0) + w.slice(1).toLowerCase()).join(" / ");

export function partyFields(o: {
  stateOptions: MasterOption[];
  cityOptions: MasterOption[];
  cityCreate?: CreateDialog;
}): FieldDef[] {
  return [
    { name: "name", label: "Name *", type: "text", uppercase: true },
    {
      name: "ledgerGroup",
      label: "Ledger Group *",
      type: "select",
      options: PARTY_GROUPS.map((g) => ({ value: g, label: partyGroupLabel(g) })),
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
    { name: "stateId", label: "State", type: "combobox", options: o.stateOptions },
    {
      name: "cityId",
      label: "City",
      type: "combobox",
      options: o.cityOptions,
      createDialog: o.cityCreate,
      createLabel: "+ Create city",
    },
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
  ];
}

// openingSide has NO default — the user chooses Dr/Cr; the server
// rejects an opening amount saved without a chosen side
export const partyDefaults: FormState = {
  name: "",
  ledgerGroup: "CONSIGNEE_CONSIGNOR",
  openingBalance: 0,
  tdsMode: "TDS_APPLICABLE",
  isActive: true,
};

export const partyTransform = (f: FormState) => ({
  ...f,
  openingBalance: Number(f.openingBalance) || 0,
});

export const partyDialogClassName = "max-h-[90vh] overflow-y-auto sm:max-w-2xl";

// ---------- Vehicle ----------

export function vehicleFields(o: {
  ownerOptions: MasterOption[];
  ownerCreate?: CreateDialog;
}): FieldDef[] {
  return [
    { name: "number", label: "Vehicle Number *", type: "text", uppercase: true },
    {
      name: "ownershipType",
      label: "Ownership *",
      type: "radio",
      options: [
        { value: "OWNER", label: "Owner" },
        { value: "BROKER", label: "Broker" },
        { value: "RELATIVE", label: "Relative" },
      ],
    },
    // unified list — same combobox for Owner / Broker / Relative
    {
      name: "ownerId",
      label: "Name * (optional for Broker)",
      type: "combobox",
      options: o.ownerOptions,
      createDialog: o.ownerCreate,
      createLabel: "+ Create party",
      span2: true,
    },
    { name: "vehicleType", label: "Vehicle Type", type: "text" },
    { name: "chassisNo", label: "Chassis No", type: "text", uppercase: true },
    { name: "engineNo", label: "Engine No", type: "text", uppercase: true },
    { name: "permitNo", label: "Permit No", type: "text" },
    { name: "insuranceNo", label: "Insurance No", type: "text" },
  ];
}

export const vehicleDefaults: FormState = {
  number: "",
  ownershipType: "OWNER",
  ownerId: null,
  vehicleType: "",
  chassisNo: "",
  engineNo: "",
  permitNo: "",
  insuranceNo: "",
};

// ---------- City ----------

export function cityFields(o: { stateOptions: MasterOption[] }): FieldDef[] {
  return [
    { name: "name", label: "City Name *", type: "text", uppercase: true },
    { name: "stateId", label: "State *", type: "combobox", options: o.stateOptions },
    { name: "district", label: "District", type: "text" },
    { name: "pincode", label: "Pincode", type: "text" },
    { name: "stdCode", label: "STD Code", type: "text" },
  ];
}

export const cityDefaults: FormState = {
  name: "",
  stateId: null,
  district: "",
  pincode: "",
  stdCode: "",
};

// ---------- Product ----------

export function productFields(o: {
  groupOptions: MasterOption[];
  /** unit options keyed by NAME — Product.unit stores the unit name */
  unitOptions: MasterOption[];
  groupCreate?: CreateDialog;
  unitCreate?: CreateDialog;
}): FieldDef[] {
  return [
    {
      name: "groupId",
      label: "Product Group *",
      type: "combobox",
      options: o.groupOptions,
      createDialog: o.groupCreate,
      createLabel: "+ Create product group",
    },
    { name: "name", label: "Name *", type: "text", uppercase: true },
    {
      name: "unit",
      label: "Unit *",
      type: "combobox",
      options: o.unitOptions,
      createDialog: o.unitCreate,
      createLabel: "+ Create unit",
    },
    { name: "hsnCode", label: "HSN Code", type: "text" },
    {
      name: "productType",
      label: "Product Type",
      type: "radio",
      options: [
        { value: "NORMAL", label: "Normal" },
        { value: "ODC", label: "ODC (Over-Dimensional Cargo)" },
      ],
    },
    { name: "gstPct", label: "GST %", type: "number" },
    { name: "type", label: "Type", type: "text" },
    { name: "className", label: "Class", type: "text" },
    { name: "division", label: "Division", type: "text" },
  ];
}

export const productDefaults: FormState = {
  groupId: null,
  name: "",
  unit: null,
  hsnCode: "",
  productType: "NORMAL",
  gstPct: "0",
  type: "",
  className: "",
  division: "",
};

// ---------- Product Group ----------

export const productGroupFields: FieldDef[] = [
  { name: "name", label: "Name *", type: "text" },
];

export const productGroupDefaults: FormState = { name: "" };

// ---------- Unit ----------

export const unitFields: FieldDef[] = [
  { name: "name", label: "Name *", type: "text", uppercase: true },
  { name: "value", label: "Value", type: "number" },
];

export const unitDefaults: FormState = { name: "", value: "1" };
