"use server";

import { z } from "zod";
import { requireSession, type Session } from "@/lib/session";
import { withTenant, type Tx } from "@/lib/db";
import { authorize } from "@/lib/authz";
import { audit } from "@/lib/audit";
import { assertDateInFy } from "@/lib/fy-guard";
import { computeInvoice, parseBulkLrNumbers, roundInvoiceNet } from "@/lib/calc/invoice";
import { ensureAccountHead, postLedger, reverseLedger } from "@/lib/ledger";
import { consumeAdvances, partyAdvanceBalance, restoreAdvanceUses } from "@/lib/party-advance";
import { gstSplit, stateCodeFromGstin } from "@/lib/calc/gst";
import { round2 } from "@/lib/calc/tds";
import { toNum } from "@/lib/utils";
import type { InvoiceKind } from "@prisma/client";

// ---------------------------------------------------------------- types

export interface BillingPendingLr {
  id: string;
  lrNo: string;
  lrDate: string;
  source: string;
  dest: string;
  vehicle: string;
  qty: number;
  actualWt: number;
  chargeWt: number;
  amount: number; // freight + charges
  poNumber: string;
  gateEntryNo: string;
  obdNo: string;
  consignee: string;
  material: string;
  rate: number;
  invoiceNo: string;
  unloadDate: string | null;
}

export interface BillingDefaults {
  defaultBankPartyId: string | null;
  defaultTdsPct: number;
  firmStateCode: string | null;
  firmGstPct: number;
}

// ---------------------------------------------------------------- lookups

export async function getBillingDefaults(): Promise<BillingDefaults> {
  const session = requireSession();
  const firm = await withTenant(session.tenantId, (tx) =>
    tx.firm.findUnique({ where: { id: session.firmId } })
  );
  return {
    defaultBankPartyId: firm?.defaultBankPartyId ?? null,
    defaultTdsPct: firm ? toNum(String(firm.defaultTdsPct)) : 1,
    firmStateCode: stateCodeFromGstin(firm?.gstin),
    firmGstPct: firm
      ? toNum(String(firm.cgstPct)) + toNum(String(firm.sgstPct)) || toNum(String(firm.igstPct))
      : 0,
  };
}

export interface PartyBillingDetails {
  name: string;
  address: string;
  gstin: string;
  pan: string;
  stateName: string;
  stateCode: string;
  vendorCode: string;
}

/** Full Bill-To details for the invoice preview / print header. */
export async function getPartyBillingDetails(partyId: string): Promise<PartyBillingDetails | null> {
  const session = requireSession();
  return withTenant(session.tenantId, async (tx) => {
    const party = await tx.party.findUnique({ where: { id: partyId } });
    if (!party) return null;
    const state = party.stateId
      ? await tx.state.findUnique({ where: { id: party.stateId } })
      : null;
    return {
      name: party.name,
      address: [party.address1, party.address2].filter(Boolean).join(", "),
      gstin: party.gstin ?? "",
      pan: party.pan ?? "",
      stateName: state?.name ?? "",
      stateCode: state?.gstCode ?? stateCodeFromGstin(party.gstin) ?? "",
      vendorCode: party.vendorCode ?? "",
    };
  });
}

/** Open advance balance of a party (auto-created by receipt vouchers). */
export async function getPartyAdvanceBalance(partyId: string): Promise<number> {
  const session = requireSession();
  return withTenant(session.tenantId, (tx) =>
    partyAdvanceBalance(tx, session.firmId, partyId, "RECEIVED", session.fyId)
  );
}

export async function getPartyStateCode(partyId: string): Promise<string | null> {
  const session = requireSession();
  const party = await withTenant(session.tenantId, (tx) =>
    tx.party.findUnique({ where: { id: partyId } })
  );
  return stateCodeFromGstin(party?.gstin);
}

async function decorateLrs(
  tx: Tx,
  lrs: {
    id: string;
    lrNo: string;
    lrDate: Date;
    sourceCityId: string;
    destCityId: string;
    consigneeId: string;
    vehicleId: string | null;
    vehicleText: string | null;
    total: unknown;
    poNumber: string | null;
    gateEntryNo: string | null;
    obdNo: string | null;
    invoiceNo: string | null;
    items: { qty: unknown; actualWt: unknown; chargeWt: unknown; productName: string; rate: unknown }[];
  }[]
): Promise<BillingPendingLr[]> {
  const cityIds = Array.from(new Set(lrs.flatMap((l) => [l.sourceCityId, l.destCityId])));
  const vehicleIds = Array.from(new Set(lrs.map((l) => l.vehicleId).filter(Boolean))) as string[];
  const consigneeIds = Array.from(new Set(lrs.map((l) => l.consigneeId)));
  const lrIds = lrs.map((l) => l.id);
  const [cities, vehicles, consignees, pods] = [
    await tx.city.findMany({ where: { id: { in: cityIds } } }),
    await tx.vehicle.findMany({ where: { id: { in: vehicleIds } } }),
    await tx.party.findMany({ where: { id: { in: consigneeIds } } }),
    await tx.pod.findMany({ where: { lrId: { in: lrIds } } }),
  ];
  const cmap = new Map(cities.map((c) => [c.id, c.name]));
  const vmap = new Map(vehicles.map((v) => [v.id, v.number]));
  const pmap = new Map(consignees.map((p) => [p.id, p.name]));
  const podByLr = new Map(pods.map((p) => [p.lrId, p]));
  return lrs.map((lr) => {
    const actualWt = lr.items.reduce((s, i) => s + toNum(String(i.actualWt)), 0);
    const pod = podByLr.get(lr.id);
    return {
      id: lr.id,
      lrNo: lr.lrNo,
      lrDate: lr.lrDate.toISOString(),
      source: cmap.get(lr.sourceCityId) ?? "",
      dest: cmap.get(lr.destCityId) ?? "",
      vehicle: (lr.vehicleId && vmap.get(lr.vehicleId)) || lr.vehicleText || "",
      qty: lr.items.reduce((s, i) => s + toNum(String(i.qty)), 0),
      actualWt,
      chargeWt: lr.items.reduce((s, i) => s + toNum(String(i.chargeWt)), 0),
      amount: toNum(String(lr.total)),
      // PO / gate entry come from the POD entry, falling back to the LR fields
      poNumber: pod?.poNumber || lr.poNumber || "",
      gateEntryNo: pod?.gateEntryNo || lr.gateEntryNo || "",
      obdNo: lr.obdNo ?? "",
      consignee: pmap.get(lr.consigneeId) ?? "",
      material: lr.items.map((i) => i.productName).filter(Boolean).join(", "),
      rate: lr.items.length ? Math.max(...lr.items.map((i) => toNum(String(i.rate)))) : 0,
      invoiceNo: lr.invoiceNo ?? "",
      unloadDate: pod?.unloadDate ? pod.unloadDate.toISOString() : null,
    };
  });
}

function pendingWhere(session: { firmId: string; fyId: string }, kind: InvoiceKind, partyId: string) {
  return {
    // FY continuity: an unbilled LR from an earlier year stays offered until
    // it lands on a bill — pending work is never cut off by the year change
    firmId: session.firmId,
    deletedAt: null,
    lrType:
      kind === "PART_TRUCK"
        ? ("TBB" as const)
        : { notIn: ["CANCELLED", "PAPER_CHANGE"] as ("CANCELLED" | "PAPER_CHANGE")[] },
    status: "DELIVERED" as const, // workflow: bill only after POD confirms delivery
    invoiceLrs: { none: {} },
    OR: [{ billToId: partyId }, { billToId: null, consignorId: partyId }],
  };
}

/** LRs of a party pending billing (not billed, no invoice link, not cancelled). */
export async function getPendingLrsForParty(
  partyId: string,
  kind: InvoiceKind
): Promise<BillingPendingLr[]> {
  const session = requireSession();
  return withTenant(session.tenantId, async (tx) => {
    const lrs = await tx.lr.findMany({
      where: pendingWhere(session, kind, partyId),
      include: { items: true },
      orderBy: { lrDate: "asc" },
    });
    return decorateLrs(tx, lrs);
  });
}

/**
 * Fresh billing rows for specific LRs by id, regardless of pending status —
 * used to refresh LRs already selected on a bill after an in-place LR edit.
 */
export async function getBillingLrsByIds(ids: string[]): Promise<BillingPendingLr[]> {
  const session = requireSession();
  if (ids.length === 0) return [];
  return withTenant(session.tenantId, async (tx) => {
    const lrs = await tx.lr.findMany({
      where: { id: { in: ids }, firmId: session.firmId, deletedAt: null },
      include: { items: true },
      orderBy: { lrDate: "asc" },
    });
    return decorateLrs(tx, lrs);
  });
}

export interface BulkLrError {
  lrNo: string;
  reason: string;
  alreadyBilled?: boolean;
}

/** Resolve a bulk-pasted list of LR numbers against a party's pending LRs. */
export async function resolveBulkLrs(
  partyId: string,
  text: string,
  kind: InvoiceKind
): Promise<{ added: BillingPendingLr[]; errors: BulkLrError[] }> {
  const session = requireSession();
  const numbers = parseBulkLrNumbers(text);
  return withTenant(session.tenantId, async (tx) => {
    const added: BillingPendingLr[] = [];
    const errors: BulkLrError[] = [];
    for (const lrNo of numbers) {
      // LR numbers restart each FY, so one number may exist in several years —
      // prefer the copy that is still unbilled, newest first
      const candidates = await tx.lr.findMany({
        where: { firmId: session.firmId, lrNo, deletedAt: null },
        include: { items: true, invoiceLrs: true },
        orderBy: { lrDate: "desc" },
      });
      const lr =
        candidates.find((c) => c.invoiceLrs.length === 0 && c.status !== "BILLED") ??
        candidates[0];
      if (!lr) {
        errors.push({ lrNo, reason: `LR ${lrNo} not found.` });
        continue;
      }
      if (lr.invoiceLrs.length > 0 || lr.status === "BILLED") {
        errors.push({
          lrNo,
          alreadyBilled: true,
          reason: `Invoice for LR ${lrNo} has already been created.`,
        });
        continue;
      }
      const billedParty = lr.billToId ?? lr.consignorId;
      if (billedParty !== partyId) {
        errors.push({ lrNo, reason: `LR ${lrNo} belongs to a different party.` });
        continue;
      }
      if (lr.lrType === "CANCELLED" || lr.lrType === "PAPER_CHANGE") {
        errors.push({ lrNo, reason: `LR ${lrNo} is ${lr.lrType === "CANCELLED" ? "cancelled" : "a paper-change LR"} — not billable.` });
        continue;
      }
      if (lr.status !== "DELIVERED") {
        errors.push({
          lrNo,
          reason: `LR ${lrNo} is not delivered yet (status ${lr.status}). Complete chalan + POD first.`,
        });
        continue;
      }
      if (kind === "PART_TRUCK" && lr.lrType !== "TBB") {
        errors.push({ lrNo, reason: `LR ${lrNo} is not a TBB (to-be-billed) LR.` });
        continue;
      }
      const [row] = await decorateLrs(tx, [lr]);
      added.push(row);
    }
    return { added, errors };
  });
}

// ---------------------------------------------------------------- save

const chargeSchema = z.object({
  chargeType: z.string().min(1),
  description: z.string().optional(),
  amount: z.number(),
  relatedLrs: z.string().optional(),
  remarks: z.string().optional(),
});

const lineSchema = z.object({
  productName: z.string().min(1),
  description: z.string().optional(),
  uom: z.string().optional(),
  hsnCode: z.string().optional(),
  qty: z.number(),
  rate: z.number(),
  discountPct: z.number().default(0),
  gstPct: z.number().default(0),
  // Manual bill consignment columns (kind = MANUAL)
  cnNo: z.string().optional(),
  lineDate: z.string().nullable().optional(), // ISO yyyy-mm-dd
  loadingStation: z.string().optional(),
  deliveryStation: z.string().optional(),
  invoiceNo: z.string().optional(),
  vehicleNo: z.string().optional(),
  deliveryDate: z.string().nullable().optional(),
  wt: z.number().default(0),
  gtWt: z.number().default(0),
});

/** Manual bill row: freight = GT WT × Rate; a weightless row bills Qty × Rate. */
function manualLineTotal(l: { qty: number; rate: number; gtWt?: number }): number {
  return round2((l.gtWt ?? 0) > 0 ? (l.gtWt ?? 0) * l.rate : l.qty * l.rate);
}

const invoiceSchema = z.object({
  id: z.string().optional(),
  kind: z.enum(["PART_TRUCK", "FULL_TRUCK", "MANUAL", "GST"]),
  invoiceNo: z.string().trim().min(1, "Invoice number is required (manual entry)"),
  invoiceDate: z.string().min(1),
  dueDate: z.string().nullable().optional(),
  partyId: z.string().min(1, "Party is required"),
  consignorId: z.string().optional(), // GST invoice: partyId = consignee, consignorId extra
  bankPartyId: z.string().nullable().optional(),
  setBankDefault: z.boolean().optional(),
  tdsPct: z.number().default(0),
  remarks: z.string().optional(),
  subject: z.string().optional(),
  gstApplicable: z.boolean().default(false),
  gstPct: z.number().default(0),
  lrIds: z.array(z.string()).default([]),
  charges: z.array(chargeSchema).default([]),
  lines: z.array(lineSchema).default([]),
  advance: z.number().default(0),
  vehicleText: z.string().optional(),
  // GST extras
  placeOfSupply: z.string().optional(),
  supplyDate: z.string().nullable().optional(),
  transportMode: z.string().optional(),
  reverseCharge: z.boolean().default(false),
  sacCode: z.string().optional(),
  tcsPct: z.number().default(0),
  freightExtra: z.number().default(0),
  othersExtra: z.number().default(0),
  narration: z.string().optional(),
});

export type SaveInvoiceInput = z.infer<typeof invoiceSchema>;

/** GST state code from the state master (fallback when a GSTIN is missing). */
async function stateGstCode(tx: Tx, stateId: string | null | undefined): Promise<string | null> {
  if (!stateId) return null;
  const state = await tx.state.findUnique({ where: { id: stateId } });
  return state?.gstCode ?? null;
}

/**
 * Reverse and re-post the ledger legs of one invoice: debit the customer for
 * netTotal, credit GST Output / TCS Payable / each additional charge head /
 * Freight Income. Shared by saveInvoice and resyncInvoicesForLr so the two
 * postings can never drift. `invoice.fyId` is the invoice's OWN financial
 * year — re-posting must not re-stamp entries into the session's FY.
 */
async function postInvoiceLedger(
  tx: Tx,
  session: Session & { firmId: string; fyId: string },
  invoice: {
    id: string;
    firmId: string;
    fyId: string;
    invoiceNo: string;
    invoiceDate: Date;
    kind: InvoiceKind;
    partyId: string;
  },
  charges: { chargeType: string; description?: string | null; amount: number }[],
  totals: {
    netTotal: number;
    cgstAmt: number;
    sgstAmt: number;
    igstAmt: number;
    roundOff: number;
  },
  tcsAmt: number
): Promise<void> {
  await reverseLedger(tx, "INVOICE", invoice.id);
  if (totals.netTotal <= 0) return;
  const common = {
    date: invoice.invoiceDate,
    refType: "INVOICE",
    refId: invoice.id,
    refNo: invoice.invoiceNo,
    firmId: invoice.firmId,
    fyId: invoice.fyId,
  };
  // the customer owes the FULL bill value, GST included — netTotal, the
  // same figure invoiceSettlement and the Outstanding register work on.
  // (For a GST-kind bill netTotal === grandTotal; for PT/FT/MANUAL with
  // GST it is grandTotal + tax — posting grandTotal left the GST off the
  // party ledger entirely, a phantom credit once the customer paid.)
  const entries: Parameters<typeof postLedger>[2] = [
    {
      ...common,
      partyId: invoice.partyId,
      side: "DEBIT",
      amount: totals.netTotal,
      narration: `Invoice ${invoice.invoiceNo} (${invoice.kind.replace(/_/g, " ")})`,
    },
  ];
  // GST is a statutory liability, not income — it gets its own ledger,
  // exactly like TDS Payable, whatever the bill kind
  const gstTotal = round2(totals.cgstAmt + totals.sgstAmt + totals.igstAmt);
  if (gstTotal > 0.009) {
    const gstHeadId = await ensureAccountHead(tx, session, "GST Output", "INCOME");
    entries.push({
      ...common,
      accountHeadId: gstHeadId,
      side: "CREDIT",
      amount: gstTotal,
      narration: `GST on invoice ${invoice.invoiceNo}`,
    });
  }
  // TCS is the same kind of statutory liability — collected for the
  // government, never freight income
  if (tcsAmt > 0.009) {
    const tcsHeadId = await ensureAccountHead(tx, session, "TCS Payable", "INCOME");
    entries.push({
      ...common,
      accountHeadId: tcsHeadId,
      side: "CREDIT",
      amount: tcsAmt,
      narration: `TCS on invoice ${invoice.invoiceNo}`,
    });
  }
  // Every additional charge credits ITS OWN ledger head — loading,
  // documentation, detention and the rest are separate income lines, not
  // one clubbed "Freight Income" figure. A charge named after a common
  // head (Detention, ODC, ...) lands in that shared ledger.
  const billedCharges = charges.filter((c) => round2(c.amount) > 0);
  // a bill whose charges alone exceed its pre-tax value (heavy credit
  // lines) cannot be split without unbalancing it — one freight credit.
  // netTotal is the ROUNDED payable; back the round-off out to get the true
  // pre-tax value (the round-off gets its own leg below)
  const roundOff = round2(totals.roundOff);
  const preTax = round2(totals.netTotal - gstTotal - tcsAmt - roundOff);
  const splittable = round2(billedCharges.reduce((s, c) => s + c.amount, 0)) < preTax - 0.009;
  let chargesTotal = 0;
  for (const c of splittable ? billedCharges : []) {
    const amount = round2(c.amount);
    chargesTotal = round2(chargesTotal + amount);
    const headId = await ensureAccountHead(tx, session, c.chargeType, "INCOME");
    entries.push({
      ...common,
      accountHeadId: headId,
      side: "CREDIT",
      amount,
      narration: `${c.chargeType}${c.description ? ` (${c.description})` : ""} — invoice ${invoice.invoiceNo}`,
    });
  }
  // freight income is the pre-tax remainder — GST/TCS already have their legs
  const freight = round2(preTax - chargesTotal);
  if (freight > 0) {
    const incomeHeadId = await ensureAccountHead(tx, session, "Freight Income", "INCOME");
    entries.push({
      ...common,
      accountHeadId: incomeHeadId,
      side: "CREDIT",
      amount: freight,
      narration: `Freight income — invoice ${invoice.invoiceNo}`,
    });
  }
  // the rounding paise get their own leg so the voucher balances to the
  // rounded party debit: rounded UP → extra income, rounded DOWN → a debit
  if (Math.abs(roundOff) > 0.004) {
    const roHeadId = await ensureAccountHead(tx, session, "Round Off", "INCOME");
    entries.push({
      ...common,
      accountHeadId: roHeadId,
      side: roundOff > 0 ? "CREDIT" : "DEBIT",
      amount: Math.abs(roundOff),
      narration: `Round off — invoice ${invoice.invoiceNo}`,
    });
  }
  await postLedger(tx, session, entries);
}

/**
 * Re-derive totals and re-post the ledger of every live PART/FULL_TRUCK
 * invoice holding this LR. Invoice totals are snapshots of their LRs, so an
 * in-place LR edit (bill-preview flow) must flow through to the bill or the
 * two desync. GST-kind bills are out of scope: their lines don't come from
 * LRs. Runs inside the caller's transaction (called from saveLr).
 */
export async function resyncInvoicesForLr(
  tx: Tx,
  session: Session & { firmId: string; fyId: string },
  lrId: string
): Promise<void> {
  const links = await tx.invoiceLr.findMany({
    where: {
      lrId,
      invoice: { deletedAt: null, kind: { in: ["PART_TRUCK", "FULL_TRUCK"] } },
    },
    select: { invoiceId: true },
  });
  for (const { invoiceId } of links) {
    const inv = await tx.invoice.findUniqueOrThrow({
      where: { id: invoiceId },
      include: { lrs: { include: { lr: { include: { items: true } } } }, charges: true },
    });
    const [firm, party] = await Promise.all([
      tx.firm.findUnique({ where: { id: inv.firmId } }),
      tx.party.findUnique({ where: { id: inv.partyId } }),
    ]);
    const supplierStateCode =
      stateCodeFromGstin(firm?.gstin) ?? (await stateGstCode(tx, firm?.stateId));
    const recipientStateCode =
      stateCodeFromGstin(party?.gstin) ?? (await stateGstCode(tx, party?.stateId));
    // GST config from the stored pct columns — an RCM bill stored 0%, and its
    // resync must stay GST-free
    const gstPct =
      toNum(String(inv.cgstPct)) + toNum(String(inv.sgstPct)) || toNum(String(inv.igstPct));
    const totals = computeInvoice({
      lrAmounts: inv.lrs.map((il) => toNum(String(il.lr.total))),
      extraCharges: inv.charges.map((c) => toNum(String(c.amount))),
      gstApplicable: inv.gstApplicable && gstPct > 0,
      gstPct,
      supplierStateCode,
      recipientStateCode,
      tdsPct: toNum(String(inv.tdsPct)),
      advance: toNum(String(inv.advance)),
    });
    const totalWt = inv.lrs.reduce(
      (s, il) => s + il.lr.items.reduce((a, i) => a + toNum(String(i.chargeWt)), 0),
      0
    );
    await tx.invoice.update({
      where: { id: inv.id },
      data: {
        cgstPct: totals.cgstAmt > 0 ? gstPct / 2 : 0,
        cgstAmt: totals.cgstAmt,
        sgstPct: totals.sgstAmt > 0 ? gstPct / 2 : 0,
        sgstAmt: totals.sgstAmt,
        igstPct: totals.igstAmt > 0 ? gstPct : 0,
        igstAmt: totals.igstAmt,
        tdsAmt: totals.tdsAmt,
        total: totals.total,
        grandTotal: totals.grandTotal,
        roundOff: totals.roundOff,
        netTotal: totals.netTotal,
        balance: totals.balance,
        totalWt: round2(totalWt),
      },
    });
    await postInvoiceLedger(
      tx,
      session,
      {
        id: inv.id,
        firmId: inv.firmId,
        fyId: inv.fyId,
        invoiceNo: inv.invoiceNo,
        invoiceDate: inv.invoiceDate,
        kind: inv.kind,
        partyId: inv.partyId,
      },
      inv.charges.map((c) => ({
        chargeType: c.chargeType,
        description: c.description,
        amount: toNum(String(c.amount)),
      })),
      totals,
      0 // TCS exists only on GST-kind bills, which are never resynced here
    );
  }
}

export async function saveInvoice(
  input: unknown
): Promise<{ ok: true; id: string } | { ok: false; error: string; alreadyBilledLr?: string }> {
  const session = requireSession();
  const parsed = invoiceSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid input" };
  }
  const data = parsed.data;
  await authorize(session, "billing", data.id ? "edit" : "create");

  if ((data.kind === "PART_TRUCK" || data.kind === "FULL_TRUCK") && data.lrIds.length === 0) {
    return { ok: false, error: "Select at least one LR." };
  }
  if ((data.kind === "MANUAL" || data.kind === "GST") && data.lines.length === 0) {
    return { ok: false, error: "Add at least one line." };
  }

  try {
    return await withTenant(session.tenantId, async (tx) => {
      const before = data.id
        ? await tx.invoice.findFirst({
            where: { id: data.id, firmId: session.firmId, deletedAt: null },
            include: { lrs: true },
          })
        : null;
      if (data.id && !before) return { ok: false as const, error: "Invoice not found." };

      // unique invoice number per firm+fy+kind — an edit stays in the
      // invoice's own FY, so the clash check must look there too
      const dup = await tx.invoice.findFirst({
        where: {
          firmId: session.firmId,
          fyId: before?.fyId ?? session.fyId,
          kind: data.kind,
          invoiceNo: data.invoiceNo,
          deletedAt: null,
          ...(data.id ? { id: { not: data.id } } : {}),
        },
      });
      if (dup) {
        return {
          ok: false as const,
          error: `Invoice number ${data.invoiceNo} already exists for this firm / financial year.`,
        };
      }
      const previousLrIds = before?.lrs.map((l) => l.lrId) ?? [];

      // validate LRs & duplicate billing (hard block)
      const lrs = data.lrIds.length
        ? await tx.lr.findMany({
            // no FY filter: carried LRs from an earlier year may land on this bill
            where: { id: { in: data.lrIds }, firmId: session.firmId, deletedAt: null },
            include: { items: true, invoiceLrs: true },
          })
        : [];
      if (lrs.length !== data.lrIds.length) {
        return { ok: false as const, error: "One or more selected LRs were not found." };
      }
      const nonOperational = lrs.find(
        (lr) => lr.lrType === "CANCELLED" || lr.lrType === "PAPER_CHANGE"
      );
      if (nonOperational) {
        return {
          ok: false as const,
          error: `LR ${nonOperational.lrNo} is ${nonOperational.lrType === "CANCELLED" ? "cancelled" : "a paper-change LR"} and cannot be billed.`,
        };
      }
      for (const lr of lrs) {
        const other = lr.invoiceLrs.find((il) => il.invoiceId !== data.id);
        if (other || (lr.status === "BILLED" && !previousLrIds.includes(lr.id))) {
          return {
            ok: false as const,
            alreadyBilledLr: lr.lrNo,
            error: `Invoice for LR ${lr.lrNo} has already been created.`,
          };
        }
        if ((lr.billToId ?? lr.consignorId) !== data.partyId) {
          return { ok: false as const, error: `LR ${lr.lrNo} belongs to a different party.` };
        }
        // an LR already on THIS invoice stays billable however its status reads
        if (lr.status !== "DELIVERED" && !previousLrIds.includes(lr.id)) {
          return {
            ok: false as const,
            error: `LR ${lr.lrNo} is not delivered yet (status ${lr.status}). Complete chalan + POD first.`,
          };
        }
        if (data.kind === "PART_TRUCK" && lr.lrType !== "TBB") {
          return { ok: false as const, error: `LR ${lr.lrNo} is not a TBB (to-be-billed) LR.` };
        }
      }

      // state codes for GST split — GSTIN prefix, else the state master, so the
      // saved bill agrees with the client preview for no-GSTIN parties
      const firm = await tx.firm.findUnique({ where: { id: session.firmId } });
      const party = await tx.party.findUnique({ where: { id: data.partyId } });
      if (!party) return { ok: false as const, error: "Party not found." };
      const supplierStateCode =
        stateCodeFromGstin(firm?.gstin) ?? (await stateGstCode(tx, firm?.stateId));
      const recipientStateCode =
        stateCodeFromGstin(party.gstin) ?? (await stateGstCode(tx, party.stateId));

      // ---- recompute (never trust client) ----
      let totals: {
        total: number;
        grandTotal: number;
        cgstAmt: number;
        sgstAmt: number;
        igstAmt: number;
        tdsAmt: number;
        roundOff: number;
        netTotal: number;
        balance: number;
      };
      let tcsAmt = 0;
      let computedLines: (z.infer<typeof lineSchema> & {
        total: number;
        taxableValue: number;
        cgstAmt: number;
        sgstAmt: number;
        igstAmt: number;
        amount: number;
      })[] = [];

      if (data.kind === "GST") {
        computedLines = data.lines.map((l) => {
          const total = round2(l.qty * l.rate);
          const taxableValue = round2(total * (1 - l.discountPct / 100));
          const gst = gstSplit({
            taxableValue,
            gstPct: l.gstPct,
            supplierStateCode,
            recipientStateCode,
          });
          return {
            ...l,
            total,
            taxableValue,
            cgstAmt: gst.cgst,
            sgstAmt: gst.sgst,
            igstAmt: gst.igst,
            amount: round2(taxableValue + gst.cgst + gst.sgst + gst.igst),
          };
        });
        const totTaxable = round2(computedLines.reduce((s, l) => s + l.taxableValue, 0));
        const cgstAmt = round2(computedLines.reduce((s, l) => s + l.cgstAmt, 0));
        const sgstAmt = round2(computedLines.reduce((s, l) => s + l.sgstAmt, 0));
        const igstAmt = round2(computedLines.reduce((s, l) => s + l.igstAmt, 0));
        const preTcs = round2(
          totTaxable + cgstAmt + sgstAmt + igstAmt + data.freightExtra + data.othersExtra
        );
        tcsAmt = round2((preTcs * data.tcsPct) / 100);
        const grandTotal = round2(preTcs + tcsAmt);
        const { netTotal, roundOff } = roundInvoiceNet(grandTotal);
        totals = {
          total: round2(computedLines.reduce((s, l) => s + l.total, 0)),
          grandTotal,
          cgstAmt,
          sgstAmt,
          igstAmt,
          tdsAmt: 0,
          roundOff,
          netTotal,
          balance: round2(netTotal - data.advance),
        };
      } else {
        const baseAmounts =
          data.kind === "MANUAL"
            ? data.lines.map(manualLineTotal)
            : lrs.map((lr) => toNum(String(lr.total)));
        // RCM basis (Full Truck, GST-unregistered): tax liability shifts to the
        // recipient, so no GST is added on the bill itself
        const rcmActive = data.kind === "FULL_TRUCK" && data.reverseCharge;
        totals = computeInvoice({
          lrAmounts: baseAmounts,
          extraCharges: data.charges.map((c) => c.amount),
          gstApplicable: data.gstApplicable && !rcmActive,
          gstPct: data.gstPct,
          supplierStateCode,
          recipientStateCode,
          tdsPct: data.tdsPct,
          advance: data.advance,
        });
        if (data.kind === "MANUAL") {
          computedLines = data.lines.map((l) => {
            const total = manualLineTotal(l);
            return {
              ...l,
              total,
              taxableValue: total,
              cgstAmt: 0,
              sgstAmt: 0,
              igstAmt: 0,
              amount: total,
            };
          });
        }
      }

      const totalWt = lrs.reduce(
        (s, lr) => s + lr.items.reduce((a, i) => a + toNum(String(i.chargeWt)), 0),
        0
      );

      // wrong-FY guard: a FRESH bill's date must belong to the session FY; an
      // edit keeps its original year, so its date must stay inside THAT year
      await assertDateInFy(
        tx,
        { fyId: before?.fyId ?? session.fyId },
        new Date(data.invoiceDate),
        "bill entry"
      );

      // bill after delivery, never before: the bill's date must not precede
      // the latest delivery (POD) among its LRs — blocks back-dating a bill
      // into an earlier year when the goods actually arrived in a later one
      if (data.lrIds.length) {
        const pods = await tx.pod.findMany({
          where: { lrId: { in: data.lrIds } },
          select: { unloadDate: true, docDate: true },
        });
        const deliveredAt = pods.reduce<Date | null>((max, p) => {
          const d = p.unloadDate ?? p.docDate;
          return !max || d > max ? d : max;
        }, null);
        const istDay = (d: Date) => {
          const t = new Date(d.getTime() + 5.5 * 3600 * 1000);
          return t.getUTCFullYear() * 10000 + (t.getUTCMonth() + 1) * 100 + t.getUTCDate();
        };
        if (deliveredAt && istDay(new Date(data.invoiceDate)) < istDay(deliveredAt)) {
          const dd = `${String(deliveredAt.getUTCDate()).padStart(2, "0")}/${String(deliveredAt.getUTCMonth() + 1).padStart(2, "0")}/${deliveredAt.getUTCFullYear()}`;
          return {
            ok: false,
            error: `Delivery was on ${dd} — the bill date cannot be earlier than that. Switch to the delivery's FY to make the bill.`,
          };
        }
      }
      const invoiceData = {
        tenantId: session.tenantId,
        firmId: session.firmId,
        // an edit keeps the invoice in its original financial year — only a
        // fresh bill is stamped into the session's FY
        fyId: before?.fyId ?? session.fyId,
        kind: data.kind,
        invoiceNo: data.invoiceNo,
        invoiceDate: new Date(data.invoiceDate),
        dueDate: data.dueDate ? new Date(data.dueDate) : null,
        partyId: data.partyId,
        lrTypeFilter: data.kind === "PART_TRUCK" ? ("TBB" as const) : null,
        remarks: data.remarks || null,
        subject: data.subject || null,
        bankPartyId: data.bankPartyId || null,
        gstApplicable: data.kind === "GST" ? true : data.gstApplicable,
        cgstPct: totals.cgstAmt > 0 ? data.gstPct / 2 : 0,
        cgstAmt: totals.cgstAmt,
        sgstPct: totals.sgstAmt > 0 ? data.gstPct / 2 : 0,
        sgstAmt: totals.sgstAmt,
        igstPct: totals.igstAmt > 0 ? data.gstPct : 0,
        igstAmt: totals.igstAmt,
        tdsPct: data.tdsPct,
        tdsAmt: totals.tdsAmt,
        total: totals.total,
        grandTotal: totals.grandTotal,
        roundOff: totals.roundOff,
        netTotal: totals.netTotal,
        advance: data.advance,
        balance: totals.balance,
        totalWt: round2(totalWt),
        placeOfSupply: data.placeOfSupply || null,
        supplyDate: data.supplyDate ? new Date(data.supplyDate) : null,
        transportMode: data.transportMode || null,
        reverseCharge: data.reverseCharge,
        sacCode: data.sacCode || null,
        tcsPct: data.tcsPct,
        tcsAmt,
        freightExtra: data.freightExtra,
        othersExtra: data.othersExtra,
        narration: data.narration || null,
        vehicleText: data.vehicleText || null,
      };

      let invoiceId: string;
      if (data.id) {
        const updated = await tx.invoice.update({
          where: { id: data.id },
          data: invoiceData,
        });
        invoiceId = updated.id;
        await tx.invoiceLr.deleteMany({ where: { invoiceId } });
        await tx.invoiceCharge.deleteMany({ where: { invoiceId } });
        await tx.invoiceLine.deleteMany({ where: { invoiceId } });
        // revert LRs removed from the invoice
        const removed = previousLrIds.filter((id) => !data.lrIds.includes(id));
        for (const lrId of removed) {
          const hasPod = await tx.pod.findFirst({ where: { lrId } });
          await tx.lr.update({
            where: { id: lrId },
            data: { status: hasPod ? "DELIVERED" : "PENDING" },
          });
        }
        await audit(tx, session, {
          entity: "Invoice",
          entityId: invoiceId,
          action: "UPDATE",
          before,
          after: updated,
        });
      } else {
        const created = await tx.invoice.create({
          data: { ...invoiceData, createdById: session.userId },
        });
        invoiceId = created.id;
        await audit(tx, session, {
          entity: "Invoice",
          entityId: invoiceId,
          action: "CREATE",
          after: created,
        });
      }

      if (data.lrIds.length) {
        await tx.invoiceLr.createMany({
          data: data.lrIds.map((lrId) => ({ tenantId: session.tenantId, invoiceId, lrId })),
        });
        // atomic claim: only still-DELIVERED rows flip to BILLED — a racing
        // invoice that claimed one first leaves the count short and this whole
        // save rolls back instead of double-billing the LR
        const newIds = data.lrIds.filter((id) => !previousLrIds.includes(id));
        if (newIds.length) {
          const claimed = await tx.lr.updateMany({
            where: { id: { in: newIds }, status: "DELIVERED" },
            data: { status: "BILLED" },
          });
          if (claimed.count !== newIds.length) {
            throw new Error(
              "One or more selected LRs were just billed on another invoice — refresh and retry."
            );
          }
        }
      }
      if (data.charges.length) {
        await tx.invoiceCharge.createMany({
          data: data.charges.map((c) => ({
            tenantId: session.tenantId,
            invoiceId,
            chargeType: c.chargeType,
            description: c.description || null,
            amount: c.amount,
            relatedLrs: c.relatedLrs || null,
            remarks: c.remarks || null,
          })),
        });
      }
      if (computedLines.length) {
        await tx.invoiceLine.createMany({
          data: computedLines.map((l) => ({
            tenantId: session.tenantId,
            invoiceId,
            productName: l.productName,
            description: l.description || null,
            uom: l.uom || null,
            hsnCode: l.hsnCode || null,
            qty: l.qty,
            rate: l.rate,
            total: l.total,
            discountPct: l.discountPct,
            taxableValue: l.taxableValue,
            gstPct: l.gstPct,
            cgstAmt: l.cgstAmt,
            sgstAmt: l.sgstAmt,
            igstAmt: l.igstAmt,
            amount: l.amount,
            cnNo: l.cnNo || null,
            lineDate: l.lineDate ? new Date(l.lineDate) : null,
            loadingStation: l.loadingStation || null,
            deliveryStation: l.deliveryStation || null,
            invoiceNo: l.invoiceNo || null,
            vehicleNo: l.vehicleNo || null,
            deliveryDate: l.deliveryDate ? new Date(l.deliveryDate) : null,
            wt: l.wt ?? 0,
            gtWt: l.gtWt ?? 0,
          })),
        });
      }

      // party advance auto-consume: the invoice's Advance amount draws down
      // the party's open advance balance FIFO (restore-then-reconsume on edit)
      await restoreAdvanceUses(tx, "INVOICE", invoiceId);
      if (data.advance > 0) {
        // never trust the client's advance figure: restored uses are already
        // back in the balance, so this is exactly what the bill may claim
        const available = await partyAdvanceBalance(
          tx,
          session.firmId,
          data.partyId,
          "RECEIVED",
          session.fyId
        );
        if (data.advance > available + 0.009) {
          throw new Error(
            `Advance ${data.advance} exceeds the party's open advance balance ${available}.`
          );
        }
        await consumeAdvances(tx, {
          tenantId: session.tenantId,
          firmId: session.firmId,
          fyId: session.fyId,
          partyId: data.partyId,
          amount: data.advance,
          refType: "INVOICE",
          refId: invoiceId,
          refNo: data.invoiceNo,
          // as-on reports date this adjustment by the BILL's date, so an
          // edit/re-save never rewrites history to the save wall-clock
          date: new Date(data.invoiceDate),
        });
      }

      // ledger: debit the customer (receivable), credit freight income —
      // re-posted on every save so edits stay in sync
      await postInvoiceLedger(
        tx,
        session,
        {
          id: invoiceId,
          firmId: session.firmId,
          fyId: before?.fyId ?? session.fyId,
          invoiceNo: data.invoiceNo,
          invoiceDate: new Date(data.invoiceDate),
          kind: data.kind,
          partyId: data.partyId,
        },
        data.charges,
        totals,
        tcsAmt
      );

      if (data.setBankDefault && data.bankPartyId) {
        await tx.firm.update({
          where: { id: session.firmId },
          data: { defaultBankPartyId: data.bankPartyId },
        });
      }

      return { ok: true as const, id: invoiceId };
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Save failed";
    if (msg.includes("Unique constraint")) {
      return {
        ok: false,
        error: `Invoice number ${data.invoiceNo} already exists for this firm / financial year.`,
      };
    }
    return { ok: false, error: msg };
  }
}

// ---------------------------------------------------------------- delete

export async function deleteInvoice(
  id: string
): Promise<{ ok: true } | { ok: false; error: string }> {
  const session = requireSession();
  try {
    await authorize(session, "billing", "delete");
  } catch {
    return { ok: false, error: "Only ADMIN/OWNER may delete invoices." };
  }
  return withTenant(session.tenantId, async (tx) => {
    const invoice = await tx.invoice.findFirst({
      where: { id, firmId: session.firmId, deletedAt: null },
      include: { lrs: true },
    });
    if (!invoice) return { ok: false as const, error: "Invoice not found." };
    for (const il of invoice.lrs) {
      const hasPod = await tx.pod.findFirst({ where: { lrId: il.lrId } });
      await tx.lr.update({
        where: { id: il.lrId },
        data: { status: hasPod ? "DELIVERED" : "PENDING" },
      });
    }
    await tx.invoiceLr.deleteMany({ where: { invoiceId: id } });
    await restoreAdvanceUses(tx, "INVOICE", id);
    await reverseLedger(tx, "INVOICE", id);
    await tx.invoice.update({ where: { id }, data: { deletedAt: new Date() } });
    await audit(tx, session, {
      entity: "Invoice",
      entityId: id,
      action: "DELETE",
      before: invoice,
    });
    return { ok: true as const };
  });
}

// ---------------------------------------------------------------- edit load

export interface InvoiceEditPayload {
  id: string;
  kind: InvoiceKind;
  invoiceNo: string;
  invoiceDate: string;
  dueDate: string | null;
  partyId: string;
  bankPartyId: string | null;
  tdsPct: number;
  remarks: string;
  subject: string;
  gstApplicable: boolean;
  gstPct: number;
  advance: number;
  vehicleText: string;
  placeOfSupply: string;
  supplyDate: string | null;
  transportMode: string;
  reverseCharge: boolean;
  sacCode: string;
  tcsPct: number;
  freightExtra: number;
  othersExtra: number;
  narration: string;
  lrs: BillingPendingLr[];
  charges: {
    chargeType: string;
    description: string;
    amount: number;
    relatedLrs: string;
    remarks: string;
  }[];
  lines: {
    productName: string;
    description: string;
    uom: string;
    hsnCode: string;
    qty: number;
    rate: number;
    discountPct: number;
    gstPct: number;
    cnNo: string;
    lineDate: string | null;
    loadingStation: string;
    deliveryStation: string;
    invoiceNo: string;
    vehicleNo: string;
    deliveryDate: string | null;
    wt: number;
    gtWt: number;
  }[];
}

export async function getInvoiceForEdit(id: string): Promise<InvoiceEditPayload | null> {
  const session = requireSession();
  return withTenant(session.tenantId, async (tx) => {
    const inv = await tx.invoice.findFirst({
      where: { id, firmId: session.firmId, deletedAt: null },
      include: { lrs: { include: { lr: { include: { items: true } } } }, charges: true, lines: true },
    });
    if (!inv) return null;
    let gstPct =
      toNum(String(inv.cgstPct)) + toNum(String(inv.sgstPct)) || toNum(String(inv.igstPct));
    if (!gstPct) {
      // an RCM bill stored 0% — fall back to the firm's GST config so turning
      // RCM off later doesn't silently compute 0% GST
      const firm = await tx.firm.findUnique({ where: { id: inv.firmId } });
      gstPct = firm
        ? toNum(String(firm.cgstPct)) + toNum(String(firm.sgstPct)) || toNum(String(firm.igstPct))
        : 0;
    }
    return {
      id: inv.id,
      kind: inv.kind,
      invoiceNo: inv.invoiceNo,
      invoiceDate: inv.invoiceDate.toISOString(),
      dueDate: inv.dueDate ? inv.dueDate.toISOString() : null,
      partyId: inv.partyId,
      bankPartyId: inv.bankPartyId,
      tdsPct: toNum(String(inv.tdsPct)),
      remarks: inv.remarks ?? "",
      subject: inv.subject ?? "",
      gstApplicable: inv.gstApplicable,
      gstPct,
      advance: toNum(String(inv.advance)),
      vehicleText: inv.vehicleText ?? "",
      placeOfSupply: inv.placeOfSupply ?? "",
      supplyDate: inv.supplyDate ? inv.supplyDate.toISOString() : null,
      transportMode: inv.transportMode ?? "",
      reverseCharge: inv.reverseCharge,
      sacCode: inv.sacCode ?? "",
      tcsPct: toNum(String(inv.tcsPct)),
      freightExtra: toNum(String(inv.freightExtra)),
      othersExtra: toNum(String(inv.othersExtra)),
      narration: inv.narration ?? "",
      lrs: await decorateLrs(
        tx,
        inv.lrs.map((il) => il.lr)
      ),
      charges: inv.charges.map((c) => ({
        chargeType: c.chargeType,
        description: c.description ?? "",
        amount: toNum(String(c.amount)),
        relatedLrs: c.relatedLrs ?? "",
        remarks: c.remarks ?? "",
      })),
      lines: inv.lines.map((l) => ({
        productName: l.productName,
        description: l.description ?? "",
        uom: l.uom ?? "",
        hsnCode: l.hsnCode ?? "",
        qty: toNum(String(l.qty)),
        rate: toNum(String(l.rate)),
        discountPct: toNum(String(l.discountPct)),
        gstPct: toNum(String(l.gstPct)),
        cnNo: l.cnNo ?? "",
        lineDate: l.lineDate ? l.lineDate.toISOString() : null,
        loadingStation: l.loadingStation ?? "",
        deliveryStation: l.deliveryStation ?? "",
        invoiceNo: l.invoiceNo ?? "",
        vehicleNo: l.vehicleNo ?? "",
        deliveryDate: l.deliveryDate ? l.deliveryDate.toISOString() : null,
        wt: toNum(String(l.wt)),
        gtWt: toNum(String(l.gtWt)),
      })),
    };
  });
}

// ------------------------------------------------------- rate change register

export interface RateChangeLrRow {
  id: string;
  lrNo: string;
  date: string; // ISO
  refNo: string;
  obdNo: string;
  invoiceNo: string;
  vehicle: string;
  source: string;
  dest: string;
  party: string;
  erpRate: number;
}

/** Read-only LR lookup for the Rate Change Register (no data is modified). */
export async function getLrForRateChange(
  lrNo: string
): Promise<{ ok: true; row: RateChangeLrRow } | { ok: false; error: string }> {
  const session = requireSession();
  return withTenant(session.tenantId, async (tx) => {
    const lr = await tx.lr.findFirst({
      where: {
        firmId: session.firmId,
        fyId: session.fyId,
        lrNo: lrNo.trim(),
        deletedAt: null,
      },
      include: { items: true },
    });
    if (!lr) return { ok: false as const, error: `LR ${lrNo} not found in the current financial year.` };
    const [cities, billParty, consignor, vehicle] = await Promise.all([
      tx.city.findMany({ where: { id: { in: [lr.sourceCityId, lr.destCityId] } } }),
      lr.billToId ? tx.party.findUnique({ where: { id: lr.billToId } }) : Promise.resolve(null),
      tx.party.findUnique({ where: { id: lr.consignorId } }),
      lr.vehicleId ? tx.vehicle.findUnique({ where: { id: lr.vehicleId } }) : Promise.resolve(null),
    ]);
    const cityName = (id: string) => cities.find((c) => c.id === id)?.name ?? "";
    return {
      ok: true as const,
      row: {
        id: lr.id,
        lrNo: lr.lrNo,
        date: lr.lrDate.toISOString(),
        refNo: lr.refNo ?? "",
        obdNo: lr.obdNo ?? "",
        invoiceNo: lr.invoiceNo ?? "",
        vehicle: vehicle?.number || lr.vehicleText || "",
        source: cityName(lr.sourceCityId),
        dest: cityName(lr.destCityId),
        party: billParty?.name ?? consignor?.name ?? "",
        erpRate: lr.items.length ? Math.max(...lr.items.map((i) => toNum(String(i.rate)))) : 0,
      },
    };
  });
}

// ---------------------------------------------------- trip closure intimation

export interface TripClosureLrRow {
  id: string;
  lrNo: string;
  consignor: string;
  vehicle: string;
  lrDate: string; // ISO
  deliveryDate: string | null; // POD unload date, ISO
  consignee: string;
  city: string; // destination
  obdNo: string;
}

/** Read-only LR + POD lookup for the Trip Closure Intimation report. */
export async function getLrForTripClosure(
  lrNo: string
): Promise<{ ok: true; row: TripClosureLrRow } | { ok: false; error: string }> {
  const session = requireSession();
  return withTenant(session.tenantId, async (tx) => {
    const lr = await tx.lr.findFirst({
      where: {
        firmId: session.firmId,
        fyId: session.fyId,
        lrNo: lrNo.trim(),
        deletedAt: null,
      },
      include: { pods: true },
    });
    if (!lr) return { ok: false as const, error: `LR ${lrNo} not found in the current financial year.` };
    const [destCity, consignor, consignee, vehicle] = await Promise.all([
      tx.city.findUnique({ where: { id: lr.destCityId } }),
      tx.party.findUnique({ where: { id: lr.consignorId } }),
      tx.party.findUnique({ where: { id: lr.consigneeId } }),
      lr.vehicleId ? tx.vehicle.findUnique({ where: { id: lr.vehicleId } }) : Promise.resolve(null),
    ]);
    return {
      ok: true as const,
      row: {
        id: lr.id,
        lrNo: lr.lrNo,
        consignor: consignor?.name ?? "",
        vehicle: vehicle?.number || lr.vehicleText || "",
        lrDate: lr.lrDate.toISOString(),
        deliveryDate: lr.pods[0]?.unloadDate ? lr.pods[0].unloadDate.toISOString() : null,
        consignee: consignee?.name ?? "",
        city: destCity?.name ?? "",
        obdNo: lr.obdNo ?? "",
      },
    };
  });
}
