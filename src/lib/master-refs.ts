import { Prisma } from "@prisma/client";
import type { Tx } from "./db";

/**
 * Where is a master record used?
 *
 * Transaction tables point at masters through plain id columns (no foreign
 * keys), so the database never stops a delete: an LR whose city is removed
 * simply goes blank. Every master delete must therefore ask this registry
 * first and refuse while anything still points at the record.
 *
 * Adding a master or a new referencing column = one entry here. A unit test
 * checks every model/column named below actually exists in the Prisma
 * schema, so a typo cannot silently turn a check into "no references".
 */

export type MasterKind =
  | "city"
  | "state"
  | "product"
  | "productGroup"
  | "unit"
  | "accountHead"
  | "documentType"
  | "tdsSection"
  | "party"
  | "vehicle";

export const MASTER_LABEL: Record<MasterKind, string> = {
  city: "city",
  state: "state",
  product: "product",
  productGroup: "product group",
  unit: "unit",
  accountHead: "account head",
  documentType: "document type",
  tdsSection: "TDS section",
  party: "party",
  vehicle: "vehicle",
};

/** The master being checked: id always, name where a table stores the name. */
export interface MasterKey {
  id: string;
  name?: string;
}

interface RefRule {
  /** Prisma model name, e.g. "Lr" */
  model: Prisma.ModelName;
  /** id columns on that model that may hold the master's id */
  columns: string[];
  /** human label, plural, e.g. "LRs" */
  label: string;
  /** column that names the document for the "used by" list */
  numberCol?: string;
  /** model carries deletedAt — only live rows count */
  soft?: boolean;
  /** extra filter (e.g. line items → their parent must be live) */
  extraWhere?: Record<string, unknown>;
  /** match by master NAME instead of id (units are stored by name) */
  byName?: boolean;
}

const SOFT = true;

const CITY_RULES: RefRule[] = [
  { model: "Lr", columns: ["sourceCityId", "destCityId"], label: "LRs", numberCol: "lrNo", soft: SOFT },
  { model: "Chalan", columns: ["sourceCityId", "destCityId"], label: "chalans", numberCol: "chalanNo", soft: SOFT },
  { model: "LoadingChalan", columns: ["sourceCityId", "destCityId"], label: "loading chalans", numberCol: "chalanNo", soft: SOFT },
  { model: "Crossing", columns: ["sourceCityId"], label: "crossings", numberCol: "chalanNo", soft: SOFT },
  { model: "OutwardCrossing", columns: ["sourceCityId", "destCityId"], label: "outward crossings", numberCol: "ocNo", soft: SOFT },
  { model: "HireSlip", columns: ["sourceCityId", "destCityId"], label: "hire slips", numberCol: "slipNo", soft: SOFT },
  { model: "SettlementSummary", columns: ["sourceCityId", "destCityId"], label: "settlement summaries", numberCol: "summaryNo", soft: SOFT },
  { model: "BrokerSlip", columns: ["loadStationId", "destCityId"], label: "broker slips", numberCol: "slipNo", soft: SOFT },
  { model: "Trip", columns: ["goingSourceCityId", "goingDestCityId", "returnSourceCityId", "returnDestCityId"], label: "trip sheets", numberCol: "tripNo", soft: SOFT },
  { model: "RateMaster", columns: ["sourceCityId", "destCityId"], label: "rates" },
  { model: "Party", columns: ["cityId"], label: "parties", numberCol: "name" },
  { model: "Firm", columns: ["cityId"], label: "firms", numberCol: "name" },
];

const STATE_RULES: RefRule[] = [
  { model: "City", columns: ["stateId"], label: "cities", numberCol: "name" },
  { model: "Party", columns: ["stateId"], label: "parties", numberCol: "name" },
  { model: "Firm", columns: ["stateId"], label: "firms", numberCol: "name" },
];

const PRODUCT_RULES: RefRule[] = [
  { model: "LrItem", columns: ["productId"], label: "LR items", extraWhere: { lr: { deletedAt: null } } },
  { model: "BrokerSlip", columns: ["productId"], label: "broker slips", numberCol: "slipNo", soft: SOFT },
  { model: "RateMaster", columns: ["productId"], label: "rates" },
  { model: "TyreInstallation", columns: ["productId"], label: "tyre installations" },
  { model: "OpeningStock", columns: ["productId"], label: "opening stock rows" },
];

const PRODUCT_GROUP_RULES: RefRule[] = [
  { model: "Product", columns: ["groupId"], label: "products", numberCol: "name" },
  { model: "TyreInstallation", columns: ["productGroupId"], label: "tyre installations" },
  { model: "OpeningStock", columns: ["productGroupId"], label: "opening stock rows" },
];

const UNIT_RULES: RefRule[] = [
  { model: "Product", columns: ["unit"], label: "products", numberCol: "name", byName: true },
];

const ACCOUNT_HEAD_RULES: RefRule[] = [
  { model: "Voucher", columns: ["accountHeadId"], label: "vouchers", numberCol: "voucherNo", soft: SOFT },
  { model: "VoucherAdjustment", columns: ["accountHeadId"], label: "voucher adjustments" },
  { model: "LedgerEntry", columns: ["accountHeadId"], label: "ledger entries", numberCol: "refNo" },
  { model: "OfficeTransaction", columns: ["headId"], label: "office transactions", numberCol: "voucherNo", soft: SOFT },
  { model: "OfficeTxnLine", columns: ["headId"], label: "office transaction lines", extraWhere: { txn: { deletedAt: null } } },
  { model: "ChalanAdvance", columns: ["headId"], label: "chalan advances", extraWhere: { chalan: { deletedAt: null } } },
  { model: "StaffAdvance", columns: ["headId"], label: "staff advances", numberCol: "advanceNo", soft: SOFT },
  { model: "StaffLoan", columns: ["headId"], label: "staff loans", numberCol: "loanNo", soft: SOFT },
  { model: "VehicleExpenseVoucher", columns: ["headId"], label: "vehicle expense vouchers", numberCol: "voucherNo", soft: SOFT },
  { model: "VehicleExpenseLine", columns: ["headId"], label: "vehicle expense lines", extraWhere: { voucher: { deletedAt: null } } },
];

const DOCUMENT_TYPE_RULES: RefRule[] = [
  { model: "VehicleDocument", columns: ["docTypeId"], label: "vehicle documents", numberCol: "docNo" },
];

const TDS_SECTION_RULES: RefRule[] = [
  { model: "TdsDeduction", columns: ["sectionId"], label: "TDS deductions", soft: SOFT },
];

const PARTY_RULES: RefRule[] = [
  { model: "Lr", columns: ["consignorId", "consigneeId", "billToId"], label: "LRs", numberCol: "lrNo", soft: SOFT },
  { model: "Chalan", columns: ["brokerId", "balPaymentHeadId"], label: "chalans", numberCol: "chalanNo", soft: SOFT },
  { model: "LoadingChalan", columns: ["brokerId"], label: "loading chalans", numberCol: "chalanNo", soft: SOFT },
  { model: "Crossing", columns: ["consigneeId", "transporterId"], label: "crossings", numberCol: "chalanNo", soft: SOFT },
  { model: "OutwardCrossing", columns: ["transporterId"], label: "outward crossings", numberCol: "ocNo", soft: SOFT },
  { model: "BrokerSlip", columns: ["partyId", "ownerId", "transporterId", "consignorId", "consigneeId", "pPaymentHeadId", "vPaymentHeadId"], label: "broker slips", numberCol: "slipNo", soft: SOFT },
  { model: "Invoice", columns: ["partyId", "bankPartyId"], label: "invoices", numberCol: "invoiceNo", soft: SOFT },
  { model: "Delivery", columns: ["partyId"], label: "deliveries", numberCol: "delNo", soft: SOFT },
  { model: "Voucher", columns: ["partyId", "bankPartyId", "creditHeadId"], label: "vouchers", numberCol: "voucherNo", soft: SOFT },
  { model: "LedgerEntry", columns: ["partyId"], label: "ledger entries", numberCol: "refNo" },
  { model: "PartyAdvance", columns: ["partyId"], label: "party advances", numberCol: "voucherNo", soft: SOFT },
  { model: "OfficeTransaction", columns: ["partyId", "bankPartyId"], label: "office transactions", numberCol: "voucherNo", soft: SOFT },
  { model: "Trip", columns: ["goingPartyId", "returnPartyId"], label: "trip sheets", numberCol: "tripNo", soft: SOFT },
  { model: "Vehicle", columns: ["ownerId"], label: "vehicles (as owner)", numberCol: "number" },
  { model: "Driver", columns: ["partyId"], label: "drivers", numberCol: "name", soft: SOFT },
  { model: "RateMaster", columns: ["partyId"], label: "rates" },
  { model: "Loan", columns: ["partyId"], label: "loans", numberCol: "loanNo", soft: SOFT },
  { model: "FinanceTxn", columns: ["partyId", "bankPartyId"], label: "finance transactions", numberCol: "voucherNo", soft: SOFT },
  { model: "StaffProfile", columns: ["partyId"], label: "staff profiles" },
  { model: "StaffSalary", columns: ["partyId", "paymentHeadId"], label: "staff salaries", numberCol: "voucherNo", soft: SOFT },
  { model: "StaffAdvance", columns: ["partyId"], label: "staff advances", numberCol: "advanceNo", soft: SOFT },
  { model: "StaffLoan", columns: ["partyId"], label: "staff loans", numberCol: "loanNo", soft: SOFT },
  { model: "DriverSalary", columns: ["paymentHeadId"], label: "driver salaries", soft: SOFT },
  { model: "DriverAdvance", columns: ["bankPartyId"], label: "driver advances", soft: SOFT },
  { model: "DriverFnf", columns: ["bankPartyId"], label: "driver final settlements" },
  { model: "VehicleWithdrawal", columns: ["partyId", "payPartyId"], label: "owner withdrawals / deposits", soft: SOFT },
  { model: "VehicleExpenseVoucher", columns: ["partyId", "bankPartyId"], label: "vehicle expense vouchers", numberCol: "voucherNo", soft: SOFT },
  { model: "AdblueTxn", columns: ["supplierId", "bankPartyId"], label: "AdBlue purchases", numberCol: "billNo", soft: SOFT },
  { model: "JobEntry", columns: ["supplierId"], label: "job entries", numberCol: "invoiceNo", soft: SOFT },
  { model: "Purchase", columns: ["buyerId", "agentId", "transportId"], label: "purchases", numberCol: "invoiceNo", soft: SOFT },
  { model: "ChalanAdvance", columns: ["bankPartyId"], label: "chalan advances", extraWhere: { chalan: { deletedAt: null } } },
  { model: "LoanEmi", columns: ["bankPartyId"], label: "loan EMIs", extraWhere: { loan: { deletedAt: null } } },
  { model: "TdsDeduction", columns: ["partyId"], label: "TDS deductions", soft: SOFT },
  { model: "ShortageEntry", columns: ["partyId"], label: "shortage entries" },
  { model: "ShortageRecovery", columns: ["partyId"], label: "shortage recoveries" },
  { model: "BillSubmission", columns: ["partyId"], label: "bill submissions" },
  { model: "InvoiceSubmission", columns: ["partyId"], label: "invoice submissions" },
  { model: "Firm", columns: ["defaultBankPartyId"], label: "firms (default bank)", numberCol: "name" },
];

const VEHICLE_RULES: RefRule[] = [
  { model: "Lr", columns: ["vehicleId"], label: "LRs", numberCol: "lrNo", soft: SOFT },
  { model: "Chalan", columns: ["vehicleId"], label: "chalans", numberCol: "chalanNo", soft: SOFT },
  { model: "LoadingChalan", columns: ["vehicleId"], label: "loading chalans", numberCol: "chalanNo", soft: SOFT },
  { model: "Delivery", columns: ["vehicleId"], label: "deliveries", numberCol: "delNo", soft: SOFT },
  { model: "Crossing", columns: ["vehicleId"], label: "crossings", numberCol: "chalanNo", soft: SOFT },
  { model: "OutwardCrossing", columns: ["vehicleId"], label: "outward crossings", numberCol: "ocNo", soft: SOFT },
  { model: "HireSlip", columns: ["vehicleId"], label: "hire slips", numberCol: "slipNo", soft: SOFT },
  { model: "SettlementSummary", columns: ["vehicleId"], label: "settlement summaries", numberCol: "summaryNo", soft: SOFT },
  { model: "BrokerSlip", columns: ["vehicleId"], label: "broker slips", numberCol: "slipNo", soft: SOFT },
  { model: "Trip", columns: ["vehicleId"], label: "trip sheets", numberCol: "tripNo", soft: SOFT },
  { model: "Voucher", columns: ["vehicleId"], label: "vouchers", numberCol: "voucherNo", soft: SOFT },
  { model: "LedgerEntry", columns: ["vehicleId"], label: "ledger entries", numberCol: "refNo" },
  { model: "Pod", columns: ["vehicleId"], label: "PODs" },
  { model: "VehicleDocument", columns: ["vehicleId"], label: "vehicle documents", numberCol: "docNo" },
  { model: "VehicleWork", columns: ["vehicleId"], label: "vehicle work entries", soft: SOFT },
  { model: "VehicleExpense", columns: ["vehicleId"], label: "vehicle expenses" },
  { model: "VehicleExpenseItem", columns: ["vehicleId"], label: "vehicle expense items" },
  { model: "VehicleWithdrawal", columns: ["vehicleId"], label: "owner withdrawals / deposits", soft: SOFT },
  { model: "Loan", columns: ["vehicleId"], label: "loans", numberCol: "loanNo", soft: SOFT },
  { model: "JobInfo", columns: ["vehicleId"], label: "job cards" },
  { model: "JobEntry", columns: ["vehicleId"], label: "job entries", numberCol: "invoiceNo", soft: SOFT },
  { model: "Purchase", columns: ["vehicleId"], label: "purchases", numberCol: "invoiceNo", soft: SOFT },
  { model: "TyreInstallation", columns: ["vehicleId"], label: "tyre installations" },
  { model: "TyreCycle", columns: ["vehicleId"], label: "tyre cycles" },
  { model: "DriverAssignment", columns: ["vehicleId"], label: "driver assignments" },
  { model: "DriverAdvance", columns: ["vehicleId"], label: "driver advances", soft: SOFT },
  { model: "DriverSettlement", columns: ["vehicleId"], label: "driver settlements", soft: SOFT },
  { model: "AdblueTxn", columns: ["vehicleId"], label: "AdBlue purchases", numberCol: "billNo", soft: SOFT },
  { model: "VehicleTracking", columns: ["vehicleId"], label: "tracking entries" },
];

export const MASTER_RULES: Record<MasterKind, RefRule[]> = {
  city: CITY_RULES,
  state: STATE_RULES,
  product: PRODUCT_RULES,
  productGroup: PRODUCT_GROUP_RULES,
  unit: UNIT_RULES,
  accountHead: ACCOUNT_HEAD_RULES,
  documentType: DOCUMENT_TYPE_RULES,
  tdsSection: TDS_SECTION_RULES,
  party: PARTY_RULES,
  vehicle: VEHICLE_RULES,
};

export interface MasterRefGroup {
  label: string;
  count: number;
  /** a few document numbers / names so the user can find them */
  samples: string[];
}

export interface MasterRefReport {
  total: number;
  groups: MasterRefGroup[];
}

const SAMPLE_LIMIT = 5;

/** Prisma delegate access by model name — the registry is validated by test. */
type Delegate = {
  count: (args: { where: Record<string, unknown> }) => Promise<number>;
  findMany: (args: {
    where: Record<string, unknown>;
    select: Record<string, boolean>;
    take: number;
  }) => Promise<Record<string, unknown>[]>;
};

export function delegateName(model: Prisma.ModelName): string {
  return model.charAt(0).toLowerCase() + model.slice(1);
}

function whereFor(rule: RefRule, key: MasterKey): Record<string, unknown> {
  const value = rule.byName ? key.name : key.id;
  const match =
    rule.columns.length === 1
      ? { [rule.columns[0]]: value }
      : { OR: rule.columns.map((c) => ({ [c]: value })) };
  return {
    ...match,
    ...(rule.soft ? { deletedAt: null } : {}),
    ...(rule.extraWhere ?? {}),
  };
}

/**
 * Count live references to a master, per referencing table, with a few
 * document numbers each. All tables are queried in parallel; only tables
 * with at least one hit are returned.
 */
export async function masterReferences(
  tx: Tx,
  kind: MasterKind,
  key: MasterKey
): Promise<MasterRefReport> {
  const rules = MASTER_RULES[kind].filter((r) => !r.byName || key.name);
  const client = tx as unknown as Record<string, Delegate>;
  const groups = await Promise.all(
    rules.map(async (rule): Promise<MasterRefGroup | null> => {
      const delegate = client[delegateName(rule.model)];
      const where = whereFor(rule, key);
      const count = await delegate.count({ where });
      if (!count) return null;
      let samples: string[] = [];
      if (rule.numberCol) {
        const rows = await delegate.findMany({
          where,
          select: { [rule.numberCol]: true },
          take: SAMPLE_LIMIT,
        });
        samples = rows.map((r) => String(r[rule.numberCol as string] ?? "")).filter(Boolean);
      }
      return { label: rule.label, count, samples };
    })
  );
  const present = groups.filter((g): g is MasterRefGroup => g !== null);
  present.sort((a, b) => b.count - a.count);
  return { total: present.reduce((s, g) => s + g.count, 0), groups: present };
}

/** One readable line: "14 LRs (1001, 1002, …), 3 chalans (C-7)". */
export function describeReferences(report: MasterRefReport): string {
  return report.groups
    .map((g) => {
      const more = g.count > g.samples.length ? ", …" : "";
      return g.samples.length ? `${g.count} ${g.label} (${g.samples.join(", ")}${more})` : `${g.count} ${g.label}`;
    })
    .join("; ");
}

/**
 * Refuse a master delete while anything still points at it. The message tells
 * the user exactly what to clear first.
 */
export async function assertNotReferenced(tx: Tx, kind: MasterKind, key: MasterKey): Promise<void> {
  const report = await masterReferences(tx, kind, key);
  if (report.total === 0) return;
  const label = MASTER_LABEL[kind];
  throw new Error(
    `This ${label} is still used by ${describeReferences(report)}. ` +
      `Delete or re-point those entries first, then delete the ${label}.`
  );
}
