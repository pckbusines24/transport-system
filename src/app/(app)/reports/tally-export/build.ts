import type { Tx } from "@/lib/db";
import { toNum } from "@/lib/utils";
import { round2 } from "@/lib/calc/tds";
import {
  CARD_LEDGER_GROUP,
  tallyDate,
  voucherHash,
  voucherTypeForMoneyLedger,
  type TallyLedgerMaster,
  type TallyVoucher,
} from "@/lib/tally";
import { makeTallyLookup, type TallyLookup } from "@/lib/tally-map";

/**
 * Software documents → Tally vouchers, in the user's exact entry style.
 * Shared rules (see the Tally spec memory):
 *  - GST-unregistered firm: no GST anywhere.
 *  - OWNERSHIP: an OWN vehicle's chalan never exports; an OWN vehicle's
 *    broker slip exports its PARTY side only.
 *  - Chalan/slip earnings are COMPONENT-WISE; billing sales is ONE total.
 *  - TDS journals alone; Commission+Mamool together; everything bill-by-bill.
 *  - Settlements split: bank Receipt alone, Shortage alone, Round-off alone.
 *  - ADVANCE_ADJ rows post nothing (the advance voucher already did).
 */

export type TallyModule = "CHALAN" | "BILLING" | "SLIP" | "VOUCHERS" | "EXPENSES" | "OFFICE";

export interface ExportDoc {
  id: string;
  refNo: string;
  dateIso: string;
  party: string;
  detail: string;
  amount: number;
  vouchers: TallyVoucher[];
}

interface Session {
  firmId: string;
  fyId: string;
}

interface Range {
  dateFrom: Date | null;
  dateTo: Date | null;
}

interface Ctx {
  look: TallyLookup;
  partyById: Map<
    string,
    {
      id: string;
      name: string;
      tallyName: string | null;
      tdsMode: string | null;
      ledgerGroup: string;
      pan: string | null;
      mobile: string | null;
      address1: string | null;
      address2: string | null;
    }
  >;
  headById: Map<string, string>;
  vehicleById: Map<string, { id: string; number: string; ownershipType: string }>;
}

async function loadCtx(tx: Tx, session: Session): Promise<Ctx> {
  const [parties, heads, mapRows, vehicles] = await Promise.all([
    tx.party.findMany({
      select: {
        id: true,
        name: true,
        tallyName: true,
        tdsMode: true,
        ledgerGroup: true,
        pan: true,
        mobile: true,
        address1: true,
        address2: true,
      },
    }),
    tx.accountHead.findMany({ select: { id: true, name: true } }),
    tx.tallyLedgerMap.findMany({ where: { firmId: session.firmId } }),
    tx.vehicle.findMany({ select: { id: true, number: true, ownershipType: true } }),
  ]);
  return {
    look: makeTallyLookup(mapRows),
    partyById: new Map(parties.map((p) => [p.id, { ...p, tdsMode: p.tdsMode as string | null }])),
    headById: new Map(heads.map((h) => [h.id, h.name])),
    vehicleById: new Map(vehicles.map((v) => [v.id, v])),
  };
}

function partyLedger(ctx: Ctx, partyId: string | null | undefined, fallback = "SUSPENSE"): string {
  const p = partyId ? ctx.partyById.get(partyId) : null;
  return p ? p.tallyName?.trim() || p.name : fallback;
}

function moneyLedger(ctx: Ctx, partyId: string | null | undefined, fallback: string): string {
  const p = partyId ? ctx.partyById.get(partyId) : null;
  return p ? ctx.look("BANKCASH", p.id, p.tallyName?.trim() || p.name) : fallback;
}

/**
 * A CARD ledger is a liability (the credit-card account), not money.
 *
 * Tally's Payment / Receipt vouchers exist to move BANK or CASH. An expense put
 * on a credit card moves neither — it swaps one liability for an expense:
 *
 *   Vehicle Repair Expense A/c  Dr.  10,000
 *        To HDFC Credit Card A/c          10,000
 *
 * which is a JOURNAL. The card is settled later, when its bill is actually paid
 * from the bank, and THAT is the Payment voucher (Card Dr / Bank Cr) — booked
 * as its own payment voucher, so the cost never reaches Tally twice.
 *
 *   Cash / Bank / UPI -> Payment or Receipt
 *   Card              -> Journal
 */
function isCardLedger(ctx: Ctx, partyId: string | null | undefined): boolean {
  return !!partyId && ctx.partyById.get(partyId)?.ledgerGroup === CARD_LEDGER_GROUP;
}

/**
 * The voucher type for a money-settled document: the cash-style type normally,
 * a Journal when the "money" ledger is really a card. The LINES are identical
 * either way — only the voucher type changes.
 */
function moneyVoucherType(
  ctx: Ctx,
  partyId: string | null | undefined,
  cashType: "Payment" | "Receipt"
): TallyVoucher["type"] {
  return voucherTypeForMoneyLedger(
    partyId ? ctx.partyById.get(partyId)?.ledgerGroup : null,
    cashType
  );
}

function headLedger(ctx: Ctx, headId: string | null | undefined, fallback = "OTHER EXPENSE"): string {
  return headId
    ? ctx.look("HEAD", headId, (ctx.headById.get(headId) ?? fallback).toUpperCase())
    : fallback;
}

function masterOf(ctx: Ctx, partyId: string, parent: string): TallyLedgerMaster | null {
  const p = ctx.partyById.get(partyId);
  if (!p) return null;
  return {
    name: p.tallyName?.trim() || p.name,
    parent,
    address: [p.address1, p.address2].filter(Boolean).join(", ") || undefined,
    pan: p.pan ?? undefined,
    mobile: p.mobile ?? undefined,
  };
}

const drLine = (ledger: string, amount: number, bill?: { name: string; type: "New Ref" | "Agst Ref" }): TallyVoucher["lines"][number] => ({
  ledger,
  amount: round2(amount),
  side: "DR",
  ...(bill ? { bills: [{ name: bill.name, type: bill.type, amount: round2(amount) }] } : {}),
});
const crLine = (ledger: string, amount: number, bill?: { name: string; type: "New Ref" | "Agst Ref" }): TallyVoucher["lines"][number] => ({
  ledger,
  amount: round2(amount),
  side: "CR",
  ...(bill ? { bills: [{ name: bill.name, type: bill.type, amount: round2(amount) }] } : {}),
});

/**
 * Merge lines that resolve to the SAME Tally ledger (e.g. the user maps
 * Commission and Mamool to one combined ledger) — one line, summed amount.
 */
function mergeSameLedger(list: [string, number][]): [string, number][] {
  const out = new Map<string, number>();
  for (const [ledger, amount] of list) {
    if (amount <= 0) continue;
    out.set(ledger, round2((out.get(ledger) ?? 0) + amount));
  }
  return Array.from(out.entries());
}

/**
 * Voucher-era settlements: the money/shortage/round-off figures live on the
 * auto-created settlement voucher's allocation (chalan/slip own columns stay
 * 0). This pulls them back per document so the CHALAN/SLIP modules keep
 * exporting the split style — and buildVoucherDocs skips these vouchers, so
 * nothing lands in Tally twice.
 */
async function settlementFromVouchers(
  tx: Tx,
  firmId: string,
  marker: string
): Promise<Map<string, { paid: number; shortage: number; roundOff: number; bankPartyId: string | null; date: Date | null; remarks: string | null }>> {
  const allocs = await tx.voucherAllocation.findMany({
    where: { remarks: marker, voucher: { deletedAt: null, firmId } },
    include: {
      voucher: { select: { voucherDate: true, bankPartyId: true, remarks: true } },
    },
  });
  const out = new Map<string, { paid: number; shortage: number; roundOff: number; bankPartyId: string | null; date: Date | null; remarks: string | null }>();
  for (const a of allocs) {
    const cur = out.get(a.refId) ?? { paid: 0, shortage: 0, roundOff: 0, bankPartyId: null, date: null, remarks: null };
    cur.paid = round2(cur.paid + toNum(a.amount));
    cur.shortage = round2(cur.shortage + toNum(a.deduction));
    cur.roundOff = round2(cur.roundOff + toNum(a.roundOff));
    if (!cur.date || a.voucher.voucherDate > cur.date) {
      cur.date = a.voucher.voucherDate;
      cur.bankPartyId = a.voucher.bankPartyId ?? cur.bankPartyId;
      cur.remarks = a.voucher.remarks ?? cur.remarks;
    }
    out.set(a.refId, cur);
  }
  return out;
}

/**
 * Split settlement: bank Receipt alone, Shortage journal alone, Round-off alone.
 * A balance settled on a CARD is a Journal, not a Receipt/Payment — see
 * `isCardLedger`.
 */
function settlementVouchers(opts: {
  keyBase: string;
  counterLedger: string;
  refNo: string;
  date: string;
  narrationBase: string;
  /** DR = counter debited (paying them / their deduction), CR = counter credited */
  counterSide: "DR" | "CR";
  paid: number;
  payLedger: string;
  /** the pay ledger is a card, so the money leg is a Journal */
  payIsCard?: boolean;
  shortage: number;
  shortageLedger: string;
  roundOff: number;
  roundOffLedger: string;
}): TallyVoucher[] {
  const out: TallyVoucher[] = [];
  const counter = (amount: number): TallyVoucher["lines"][number] =>
    opts.counterSide === "DR"
      ? drLine(opts.counterLedger, amount, { name: opts.refNo, type: "Agst Ref" })
      : crLine(opts.counterLedger, amount, { name: opts.refNo, type: "Agst Ref" });
  const opposite = (ledger: string, amount: number) =>
    opts.counterSide === "DR" ? crLine(ledger, amount) : drLine(ledger, amount);

  if (opts.paid > 0.009) {
    out.push({
      key: `${opts.keyBase}:BAL`,
      type: opts.payIsCard ? "Journal" : "Receipt",
      date: opts.date,
      narration: `Balance ${opts.counterSide === "DR" ? "payment" : "received"} — ${opts.narrationBase}`,
      lines: [counter(opts.paid), opposite(opts.payLedger, opts.paid)],
    });
  }
  if (opts.shortage > 0.009) {
    out.push({
      key: `${opts.keyBase}:BALSHORT`,
      type: "Journal",
      date: opts.date,
      narration: `Shortage on balance — ${opts.narrationBase}`,
      lines: [counter(opts.shortage), opposite(opts.shortageLedger, opts.shortage)],
    });
  }
  if (Math.abs(opts.roundOff) > 0.009) {
    const amt = round2(Math.abs(opts.roundOff));
    const knockedOff = opts.roundOff > 0;
    out.push({
      key: `${opts.keyBase}:BALRO`,
      type: "Journal",
      date: opts.date,
      narration: `Round off on balance — ${opts.narrationBase}`,
      lines: knockedOff
        ? [counter(amt), opposite(opts.roundOffLedger, amt)]
        : [
            opts.counterSide === "DR"
              ? crLine(opts.counterLedger, amt, { name: opts.refNo, type: "Agst Ref" })
              : drLine(opts.counterLedger, amt, { name: opts.refNo, type: "Agst Ref" }),
            opts.counterSide === "DR" ? drLine(opts.roundOffLedger, amt) : crLine(opts.roundOffLedger, amt),
          ],
    });
  }
  return out;
}

// ---------------------------------------------------------------- CHALAN

export async function buildChalanDocs(
  tx: Tx,
  session: Session,
  r: Range
): Promise<{ docs: ExportDoc[]; masters: TallyLedgerMaster[] }> {
  const ctx = await loadCtx(tx, session);
  const range =
    r.dateFrom || r.dateTo
      ? { ...(r.dateFrom ? { gte: r.dateFrom } : {}), ...(r.dateTo ? { lte: r.dateTo } : {}) }
      : null;
  const chalans = await tx.chalan.findMany({
    // date filter beats FY (FY continuity): a period matches ANY activity —
    // an old-year chalan whose balance was paid in this period must export
    // its settlement vouchers here, not vanish behind the year boundary
    where: {
      firmId: session.firmId,
      ...(range ? {} : { fyId: session.fyId }),
      deletedAt: null,
      cancelledAt: null,
      isFinal: true,
      ...(range
        ? {
            OR: [
              { chalanDate: range },
              { balPaymentDate: range },
              { advances: { some: { date: range } } },
            ],
          }
        : {}),
    },
    include: { advances: true },
    orderBy: [{ chalanDate: "asc" }, { chalanNo: "asc" }],
  });
  // voucher-era balance settlements, keyed by chalan id
  const chalanBalVouchers = await settlementFromVouchers(tx, session.firmId, "CHALAN_BAL_SETTLEMENT");

  const docs: ExportDoc[] = [];
  const masterIds = new Set<string>();
  const C = (key: string, fb: string) => ctx.look("CHALAN", key, fb);

  for (const c of chalans) {
    const vehicle = ctx.vehicleById.get(c.vehicleId);
    if (!vehicle || vehicle.ownershipType === "OWNER") continue; // own vehicle: never
    const broker = ctx.partyById.get(c.brokerId);
    if (!broker) continue;
    const brokerLedger = broker.tallyName?.trim() || broker.name;
    masterIds.add(broker.id);

    const vouchers: TallyVoucher[] = [];
    const chDate = tallyDate(c.chalanDate);
    const refNo = c.chalanNo;
    const tag = `chalan ${c.chalanNo} — ${vehicle.number}`;

    const isDecl = broker.tdsMode === "DECLARATION";
    const components: [string, number][] = [
      [
        isDecl ? C("freight_decl", "TRANSPORTING EXP (DECLARATION)") : C("freight_tds", "TRANSPORTING EXP (TDS)"),
        toNum(c.freight),
      ],
      [C("detention", "DETENTION CHARGES"), toNum(c.detention)],
      [C("odc", "ODC CHARGES"), toNum(c.odcAmt)],
      [C("fine_slip", "FINE SLIP CHARGES"), toNum(c.fineSlip)],
      [C("other", "OTHER CHALAN CHARGES"), toNum(c.otherAmt)],
    ];
    const earnTotal = round2(components.reduce((s, [, a]) => s + a, 0));
    if (earnTotal > 0) {
      vouchers.push({
        key: `CHALAN:${c.id}:MAIN`,
        type: "Purchase",
        date: chDate,
        reference: refNo,
        narration: `Chalan ${c.chalanNo} — ${vehicle.number}${c.remarks ? ` — ${c.remarks}` : ""}`,
        lines: [
          ...components.filter(([, a]) => a > 0).map(([l, a]) => drLine(l, a)),
          crLine(brokerLedger, earnTotal, { name: refNo, type: "New Ref" }),
        ],
      });
    }

    const dedJournal = (suffix: string, total: number, credits: [string, number][], what: string) => {
      if (total <= 0.009) return;
      vouchers.push({
        key: `CHALAN:${c.id}:${suffix}`,
        type: "Journal",
        date: chDate,
        narration: `${what} — ${tag}`,
        lines: [
          drLine(brokerLedger, total, { name: refNo, type: "Agst Ref" }),
          ...mergeSameLedger(credits).map(([l, a]) => crLine(l, a)),
        ],
      });
    };
    const tds = toNum(c.tdsAmt);
    dedJournal("TDS", tds, [[C("tds", "TDS ON TRANSPORT 194C"), tds]], "TDS");
    const comm = toNum(c.commissionAmt);
    const mamool = toNum(c.mamool);
    dedJournal(
      "COMM",
      round2(comm + mamool),
      [
        [C("commission", "COMMISSION INCOME"), comm],
        [C("mamool", "MAMOOL INCOME"), mamool],
      ],
      "Commission / Mamool"
    );
    const courier = toNum(c.courierCharge);
    dedJournal("COURIER", courier, [[C("courier", "COURIER CHARGES"), courier]], "Courier");
    const ld = toNum(c.ldCharge);
    dedJournal("LD", ld, [[C("ld", "LD CHARGE RECOVERED"), ld]], "LD charge");
    const shortage = toNum(c.shortageAmt);
    dedJournal("SHORT", shortage, [[C("shortage", "SHORTAGE RECOVERY"), shortage]], "Shortage");

    for (const a of c.advances) {
      const amt = toNum(a.amount);
      if (amt <= 0 || a.type === "ADVANCE_ADJ") continue;
      const aDate = a.date ? tallyDate(a.date) : chDate;
      const dieselBits =
        a.dieselQty && toNum(a.dieselQty) > 0
          ? ` ${toNum(a.dieselQty)} L${a.dieselRate ? ` @ ${toNum(a.dieselRate)}` : ""}`
          : "";
      const narration = `${a.type.replace(/_/g, " ")} advance${dieselBits}${a.supplierName ? ` — ${a.supplierName}` : ""} — ${tag}${a.remarks ? ` — ${a.remarks}` : ""}`;
      const brokerDr = drLine(brokerLedger, amt, { name: refNo, type: "Agst Ref" });
      if (a.type === "BANK") {
        const ledger = a.bankPartyId
          ? moneyLedger(ctx, a.bankPartyId, a.bankName?.trim() || "BANK")
          : a.bankName?.trim() || "BANK";
        vouchers.push({
          key: `CHALAN:${c.id}:ADV:${a.id}`,
          type: "Receipt",
          date: aDate,
          narration,
          lines: [brokerDr, crLine(ledger, amt)],
        });
      } else if (a.type === "CASH") {
        vouchers.push({
          key: `CHALAN:${c.id}:ADV:${a.id}`,
          type: "Receipt",
          date: aDate,
          narration,
          lines: [brokerDr, crLine(C("cash", "CASH"), amt)],
        });
      } else {
        const ledger = a.headId
          ? headLedger(ctx, a.headId)
          : `${a.type.charAt(0)}${a.type.slice(1).toLowerCase().replace(/_/g, " ")} Advance (Chalan)`.toUpperCase();
        vouchers.push({
          key: `CHALAN:${c.id}:ADV:${a.id}`,
          type: "Journal",
          date: aDate,
          narration,
          lines: [brokerDr, crLine(ledger, amt)],
        });
      }
    }

    if (c.paymentStatus === "PAID") {
      // legacy chalan-side figures + the settlement voucher's (voucher-era
      // columns are zero on the chalan) — one combined split export
      const vs = chalanBalVouchers.get(c.id);
      vouchers.push(
        ...settlementVouchers({
          keyBase: `CHALAN:${c.id}`,
          counterLedger: brokerLedger,
          refNo,
          date: c.balPaymentDate
            ? tallyDate(c.balPaymentDate)
            : vs?.date
              ? tallyDate(vs.date)
              : chDate,
          narrationBase: `${tag}${c.balRemarks ? ` — ${c.balRemarks}` : ""}`,
          counterSide: "DR",
          paid: round2(toNum(c.balPaidAmount) + (vs?.paid ?? 0)),
          payLedger: c.balPaymentHeadId
            ? moneyLedger(ctx, c.balPaymentHeadId, C("cash", "CASH"))
            : vs?.bankPartyId
              ? moneyLedger(ctx, vs.bankPartyId, C("cash", "CASH"))
              : C("cash", "CASH"),
          payIsCard: isCardLedger(ctx, c.balPaymentHeadId ?? vs?.bankPartyId),
          shortage: round2(toNum(c.balShortage) + (vs?.shortage ?? 0)),
          shortageLedger: C("shortage", "SHORTAGE RECOVERY"),
          roundOff: round2(toNum(c.balRoundOff) + (vs?.roundOff ?? 0)),
          roundOffLedger: C("round_off", "ROUND OFF"),
        })
      );
    }

    if (!vouchers.length) continue;
    docs.push({
      id: c.id,
      refNo: c.chalanNo,
      dateIso: c.chalanDate.toISOString(),
      party: broker.name,
      detail: `${vehicle.number} · ${vehicle.ownershipType === "BROKER" ? "Broker" : "Relative"}`,
      amount: toNum(c.grandTotal),
      vouchers,
    });
  }
  const masters = Array.from(masterIds)
    .map((id) => masterOf(ctx, id, "Sundry Creditors"))
    .filter(Boolean) as TallyLedgerMaster[];
  return { docs, masters };
}

// ---------------------------------------------------------------- BILLING

export async function buildBillingDocs(
  tx: Tx,
  session: Session,
  r: Range
): Promise<{ docs: ExportDoc[]; masters: TallyLedgerMaster[] }> {
  const ctx = await loadCtx(tx, session);
  const invoices = await tx.invoice.findMany({
    // date filter beats FY (FY continuity)
    where: {
      firmId: session.firmId,
      ...(r.dateFrom || r.dateTo ? {} : { fyId: session.fyId }),
      deletedAt: null,
      kind: { not: "GST" }, // unregistered firm — GST-kind bills out of scope
      ...(r.dateFrom || r.dateTo
        ? {
            invoiceDate: {
              ...(r.dateFrom ? { gte: r.dateFrom } : {}),
              ...(r.dateTo ? { lte: r.dateTo } : {}),
            },
          }
        : {}),
    },
    orderBy: [{ invoiceDate: "asc" }, { invoiceNo: "asc" }],
  });

  const B = (key: string, fb: string) => ctx.look("BILLING", key, fb);
  const docs: ExportDoc[] = [];
  const masterIds = new Set<string>();

  for (const inv of invoices) {
    const total = toNum(inv.netTotal);
    if (total <= 0) continue;
    const party = ctx.partyById.get(inv.partyId);
    if (!party) continue;
    masterIds.add(party.id);
    const ledger = party.tallyName?.trim() || party.name;
    docs.push({
      id: inv.id,
      refNo: inv.invoiceNo,
      dateIso: inv.invoiceDate.toISOString(),
      party: party.name,
      detail: inv.kind.replace(/_/g, " "),
      amount: total,
      vouchers: [
        {
          key: `BILL:${inv.id}:MAIN`,
          type: "Sales",
          date: tallyDate(inv.invoiceDate),
          reference: inv.invoiceNo,
          // pura bill amount EK saath — the user's billing rule; breakup
          // (freight/detention/charges) stays in the narration only
          narration: `Invoice ${inv.invoiceNo} (${inv.kind.replace(/_/g, " ")})${inv.vehicleText ? ` — ${inv.vehicleText}` : ""}${inv.remarks ? ` — ${inv.remarks}` : ""}`,
          lines: [
            drLine(ledger, total, { name: inv.invoiceNo, type: "New Ref" }),
            crLine(B("sales", "FREIGHT RECEIPTS"), total),
          ],
        },
      ],
    });
  }
  const masters = Array.from(masterIds)
    .map((id) => masterOf(ctx, id, "Sundry Debtors"))
    .filter(Boolean) as TallyLedgerMaster[];
  return { docs, masters };
}

// ---------------------------------------------------------------- VOUCHERS (receipts & payments)

export async function buildVoucherDocs(
  tx: Tx,
  session: Session,
  r: Range
): Promise<{ docs: ExportDoc[]; masters: TallyLedgerMaster[] }> {
  const ctx = await loadCtx(tx, session);
  const vouchers = await tx.voucher.findMany({
    // date filter beats FY (FY continuity)
    where: {
      firmId: session.firmId,
      ...(r.dateFrom || r.dateTo ? {} : { fyId: session.fyId }),
      deletedAt: null,
      type: { in: ["RECEIPT", "PAYMENT"] },
      ...(r.dateFrom || r.dateTo
        ? {
            voucherDate: {
              ...(r.dateFrom ? { gte: r.dateFrom } : {}),
              ...(r.dateTo ? { lte: r.dateTo } : {}),
            },
          }
        : {}),
    },
    include: { allocations: true },
    orderBy: [{ voucherDate: "asc" }, { voucherNo: "asc" }],
  });

  const V = (key: string, fb: string) => ctx.look("VOUCHER", key, fb);
  const docs: ExportDoc[] = [];
  const masterIds = new Set<string>();

  for (const v of vouchers) {
    // auto-created settlement vouchers are exported by the CHALAN / SLIP
    // builders in the split style — exporting them here too would land the
    // same money in Tally twice
    if (
      v.allocations.some(
        (a) =>
          a.remarks === "BROKER_SLIP_P_SETTLEMENT" ||
          a.remarks === "BROKER_SLIP_V_SETTLEMENT" ||
          a.remarks === "CHALAN_BAL_SETTLEMENT"
      )
    )
      continue;
    const isReceipt = v.type === "RECEIPT";
    const amount = toNum(v.amount);
    const tds = toNum(v.tdsAmt);
    const deduction = toNum(v.deduction);
    const headerOther = toNum(v.otherAmt);
    const net = toNum(v.netAmount);
    const allocRoundOff = round2(v.allocations.reduce((s, a) => s + toNum(a.roundOff), 0));
    const rowOther = round2(v.allocations.reduce((s, a) => s + toNum(a.otherAmt), 0));
    const shortage = round2(Math.max(0, deduction - rowOther));
    if (net <= 0.009 && tds <= 0.009 && deduction <= 0.009 && Math.abs(allocRoundOff) <= 0.009)
      continue;
    // cash must move through a mapped bank/cash account — but a pure
    // shortage / round-off settlement has NO cash leg and exports as a
    // Journal instead of being dropped
    if (!v.bankPartyId && net > 0.009) continue;

    const counterLedger = v.partyId
      ? partyLedger(ctx, v.partyId)
      : headLedger(ctx, v.accountHeadId, "SUSPENSE");
    if (v.partyId) {
      const p = ctx.partyById.get(v.partyId);
      if (p) masterIds.add(p.id);
    }
    const bankLedgerName = v.bankPartyId ? moneyLedger(ctx, v.bankPartyId, "BANK") : "";

    // bill refs: each allocation's fully-settled portion against its document
    const counterTotal = round2(amount + allocRoundOff);
    const bills = v.allocations
      .map((a) => ({
        name: a.refNo,
        type: "Agst Ref" as const,
        amount: round2(
          toNum(a.amount) + toNum(a.tdsAmt) + toNum(a.deduction) + toNum(a.otherAmt) + toNum(a.roundOff)
        ),
      }))
      .filter((b) => Math.abs(b.amount) > 0.009);
    const billsTotal = round2(bills.reduce((s, b) => s + b.amount, 0));
    if (Math.abs(billsTotal - counterTotal) > 0.009) {
      // remainder is on-account — its own Advance ref keeps Tally balanced
      bills.push({
        name: v.voucherNo,
        type: "Advance" as unknown as "Agst Ref",
        amount: round2(counterTotal - billsTotal),
      });
    }

    const nar = `${isReceipt ? "Receipt" : "Payment"} voucher ${v.voucherNo}${v.remarks ? ` — ${v.remarks}` : ""}`;
    const moneySide = (ledger: string, amt: number) =>
      isReceipt ? drLine(ledger, amt) : crLine(ledger, amt);
    const counterSideLine: TallyVoucher["lines"][number] = {
      ledger: counterLedger,
      amount: counterTotal,
      side: isReceipt ? "CR" : "DR",
      bills: bills.map((b) => ({ ...b })),
    };

    const lines: TallyVoucher["lines"] = [counterSideLine];
    if (net > 0.009 && bankLedgerName) lines.push(moneySide(bankLedgerName, net));
    if (tds > 0.009)
      lines.push(
        moneySide(isReceipt ? V("tds_recv", "TDS RECEIVABLE 194C") : V("tds_pay", "TDS ON TRANSPORT 194C"), tds)
      );
    if (shortage > 0.009) lines.push(moneySide(V("shortage", "SHORTAGE"), shortage));
    if (rowOther > 0.009) lines.push(moneySide(V("other_ded", "OTHER CHARGES"), rowOther));
    // header otherAmt is an ADDED charge — it sits on the counter side
    if (headerOther > 0.009)
      lines.push(
        isReceipt ? crLine(V("other_ded", "OTHER CHARGES"), headerOther) : drLine(V("other_ded", "OTHER CHARGES"), headerOther)
      );
    if (allocRoundOff > 0.009) lines.push(moneySide(V("round_off", "ROUND OFF"), allocRoundOff));
    else if (allocRoundOff < -0.009)
      lines.push(
        isReceipt ? crLine(V("round_off", "ROUND OFF"), Math.abs(allocRoundOff)) : drLine(V("round_off", "ROUND OFF"), Math.abs(allocRoundOff))
      );

    docs.push({
      id: v.id,
      refNo: v.voucherNo,
      dateIso: v.voucherDate.toISOString(),
      party: v.partyId ? ctx.partyById.get(v.partyId)?.name ?? "" : ctx.headById.get(v.accountHeadId ?? "") ?? "",
      detail: `${v.type}${v.allocations.length ? ` · ${v.allocations.map((a) => a.refNo).join(", ")}` : ""}`,
      amount,
      vouchers: [
        {
          key: `VOUCHER:${v.id}`,
          // no cash leg (pure shortage / round-off settlement) → Journal, and
          // a card-settled voucher is a Journal for the same reason: nothing
          // left the bank
          type:
            net > 0.009
              ? moneyVoucherType(ctx, v.bankPartyId, isReceipt ? "Receipt" : "Payment")
              : "Journal",
          date: tallyDate(v.voucherDate),
          narration: nar,
          lines,
        },
      ],
    });
  }
  const masters = Array.from(masterIds)
    .map((id) => {
      const p = ctx.partyById.get(id)!;
      return masterOf(ctx, id, p.ledgerGroup === "CONSIGNEE_CONSIGNOR" ? "Sundry Debtors" : "Sundry Creditors");
    })
    .filter(Boolean) as TallyLedgerMaster[];
  return { docs, masters };
}

// ---------------------------------------------------------------- BROKER SLIP

interface SlipAdvance {
  side?: "P" | "V";
  type?: string;
  headKind?: string | null;
  headId?: string | null;
  supplierName?: string | null;
  bankName?: string | null;
  dieselQty?: number | null;
  dieselRate?: number | null;
  amount?: number;
  date?: string | null;
  remarks?: string | null;
}

export async function buildSlipDocs(
  tx: Tx,
  session: Session,
  r: Range
): Promise<{ docs: ExportDoc[]; masters: TallyLedgerMaster[] }> {
  const ctx = await loadCtx(tx, session);
  const range =
    r.dateFrom || r.dateTo
      ? { ...(r.dateFrom ? { gte: r.dateFrom } : {}), ...(r.dateTo ? { lte: r.dateTo } : {}) }
      : null;
  const slips = await tx.brokerSlip.findMany({
    // date filter beats FY (FY continuity): an old-year slip settled in this
    // period must export its settlement entries here
    where: {
      firmId: session.firmId,
      ...(range ? {} : { fyId: session.fyId }),
      deletedAt: null,
      ...(range
        ? { OR: [{ slipDate: range }, { pPaymentDate: range }, { vPaymentDate: range }] }
        : {}),
    },
    orderBy: [{ slipDate: "asc" }, { slipNo: "asc" }],
  });
  // voucher-era owner-side settlements, keyed by slip id
  const slipVVouchers = await settlementFromVouchers(tx, session.firmId, "BROKER_SLIP_V_SETTLEMENT");

  const P = (key: string, fb: string) => ctx.look("SLIP_P", key, fb);
  const C = (key: string, fb: string) => ctx.look("CHALAN", key, fb);
  const docs: ExportDoc[] = [];
  const masterIds = new Map<string, string>(); // partyId -> parent group

  for (const s of slips) {
    const vehicle = s.vehicleId ? ctx.vehicleById.get(s.vehicleId) : null;
    const ownVehicle = vehicle?.ownershipType === "OWNER";
    const vouchers: TallyVoucher[] = [];
    const sDate = tallyDate(s.slipDate);
    const refNo = s.slipNo;
    const tag = `broker slip ${s.slipNo}${vehicle ? ` — ${vehicle.number}` : ""}`;
    const advances: SlipAdvance[] = Array.isArray(s.advances) ? (s.advances as SlipAdvance[]) : [];

    // ---------- PARTY SIDE (receivable) — always exports when present
    if (s.partyId) {
      const party = ctx.partyById.get(s.partyId);
      if (party) {
        const pLedger = party.tallyName?.trim() || party.name;
        masterIds.set(party.id, "Sundry Debtors");
        const pComponents: [string, number][] = [
          [P("freight_income", "FREIGHT RECEIPTS"), toNum(s.pFreight)],
          [P("detention_income", "DETENTION INCOME"), toNum(s.pDetention)],
          [P("odc_income", "ODC INCOME"), toNum(s.pOdcAmt)],
          [P("fine_income", "FINE SLIP INCOME"), toNum(s.pFineSlip)],
        ];
        const pTotal = round2(pComponents.reduce((sum, [, a]) => sum + a, 0));
        if (pTotal > 0) {
          vouchers.push({
            key: `SLIP:${s.id}:PMAIN`,
            type: "Sales",
            date: sDate,
            reference: refNo,
            narration: `Broker slip ${s.slipNo}${vehicle ? ` — ${vehicle.number}` : ""}${s.pRemarks ? ` — ${s.pRemarks}` : ""}`,
            lines: [
              drLine(pLedger, pTotal, { name: refNo, type: "New Ref" }),
              ...pComponents.filter(([, a]) => a > 0).map(([l, a]) => crLine(l, a)),
            ],
          });
        }
        const pDed = (suffix: string, total: number, debits: [string, number][], what: string) => {
          if (total <= 0.009) return;
          vouchers.push({
            key: `SLIP:${s.id}:${suffix}`,
            type: "Journal",
            date: sDate,
            narration: `${what} — ${tag}`,
            lines: [
              ...mergeSameLedger(debits).map(([l, a]) => drLine(l, a)),
              crLine(pLedger, total, { name: refNo, type: "Agst Ref" }),
            ],
          });
        };
        const pTds = toNum(s.pTdsAmt);
        pDed("PTDS", pTds, [[P("tds_recv", "TDS RECEIVABLE 194C"), pTds]], "TDS");
        const pComm = toNum(s.pCommAmt);
        const pMamool = toNum(s.pMamool);
        pDed(
          "PCOMM",
          round2(pComm + pMamool),
          [
            [P("comm_allowed", "COMMISSION ALLOWED"), pComm],
            [P("mamool_allowed", "MAMOOL ALLOWED"), pMamool],
          ],
          "Commission / Mamool"
        );
        const pLd = toNum(s.pLdCharge);
        pDed("PLD", pLd, [[P("ld_allowed", "LD CHARGE ALLOWED"), pLd]], "LD charge");
        const pPc = toNum(s.pPaymentCharge);
        pDed("PPC", pPc, [[P("payment_charge", "PAYMENT CHARGES"), pPc]], "Payment charge");
        const pShort = toNum(s.pShortageAmt);
        pDed("PSHORT", pShort, [[P("shortage", "SHORTAGE"), pShort]], "Shortage");

        // advances received from the party
        advances.forEach((a, i) => {
          if (a.side !== "P") return;
          const amt = round2(toNum(a.amount ?? 0));
          if (amt <= 0 || a.type === "ADVANCE_ADJ") return;
          const aDate = a.date ? tallyDate(new Date(`${a.date}T00:00:00`)) : sDate;
          const nar = `${(a.type ?? "").replace(/_/g, " ")} advance received${a.remarks ? ` — ${a.remarks}` : ""} — ${tag}`;
          const partyCr = crLine(pLedger, amt, { name: refNo, type: "Agst Ref" });
          if (a.headKind === "BANK" || a.headKind === "CASH") {
            vouchers.push({
              key: `SLIP:${s.id}:PADV:${i}`,
              type: "Receipt",
              date: aDate,
              narration: nar,
              lines: [moneyLedgerLine(ctx, a, C), partyCr],
            });
          } else {
            vouchers.push({
              key: `SLIP:${s.id}:PADV:${i}`,
              type: "Journal",
              date: aDate,
              narration: nar,
              lines: [drLine(headLedger(ctx, a.headId ?? null), amt), partyCr],
            });
          }
          function moneyLedgerLine(cx: Ctx, adv: SlipAdvance, look: typeof C): TallyVoucher["lines"][number] {
            const ledger =
              adv.headKind === "CASH"
                ? look("cash", "CASH")
                : adv.headId
                  ? moneyLedger(cx, adv.headId, adv.bankName?.trim() || "BANK")
                  : adv.bankName?.trim() || "BANK";
            return drLine(ledger, amt);
          }
        });

        if (s.pPaymentStatus === "RECEIVED") {
          vouchers.push(
            ...settlementVouchers({
              keyBase: `SLIP:${s.id}:P`,
              counterLedger: pLedger,
              refNo,
              date: s.pPaymentDate ? tallyDate(s.pPaymentDate) : sDate,
              narrationBase: `${tag}${s.pPaymentRemarks ? ` — ${s.pPaymentRemarks}` : ""}`,
              counterSide: "CR", // party credited — money came IN
              paid: toNum(s.pPaidAmount),
              payLedger: s.pPaymentHeadId
                ? moneyLedger(ctx, s.pPaymentHeadId, C("cash", "CASH"))
                : C("cash", "CASH"),
              payIsCard: isCardLedger(ctx, s.pPaymentHeadId),
              shortage: toNum(s.pShortage),
              shortageLedger: P("shortage", "SHORTAGE"),
              roundOff: toNum(s.pRoundOff),
              roundOffLedger: C("round_off", "ROUND OFF"),
            })
          );
        }
      }
    }

    // ---------- OWNER SIDE (payable) — skipped for OWN vehicles
    if (s.ownerId && !ownVehicle) {
      const owner = ctx.partyById.get(s.ownerId);
      if (owner) {
        const oLedger = owner.tallyName?.trim() || owner.name;
        masterIds.set(owner.id, "Sundry Creditors");
        const isDecl = owner.tdsMode === "DECLARATION";
        const vComponents: [string, number][] = [
          [
            isDecl ? C("freight_decl", "TRANSPORTING EXP (DECLARATION)") : C("freight_tds", "TRANSPORTING EXP (TDS)"),
            toNum(s.vFreight),
          ],
          [C("detention", "DETENTION CHARGES"), toNum(s.vDetention)],
          [C("odc", "ODC CHARGES"), toNum(s.vOdcAmt)],
          [C("fine_slip", "FINE SLIP CHARGES"), toNum(s.vFineAmt)],
        ];
        const vTotal = round2(vComponents.reduce((sum, [, a]) => sum + a, 0));
        if (vTotal > 0) {
          vouchers.push({
            key: `SLIP:${s.id}:VMAIN`,
            type: "Purchase",
            date: sDate,
            reference: refNo,
            narration: `Broker slip ${s.slipNo} (owner side)${vehicle ? ` — ${vehicle.number}` : ""}${s.vRemarks ? ` — ${s.vRemarks}` : ""}`,
            lines: [
              ...vComponents.filter(([, a]) => a > 0).map(([l, a]) => drLine(l, a)),
              crLine(oLedger, vTotal, { name: refNo, type: "New Ref" }),
            ],
          });
        }
        const vDed = (suffix: string, total: number, credits: [string, number][], what: string) => {
          if (total <= 0.009) return;
          vouchers.push({
            key: `SLIP:${s.id}:${suffix}`,
            type: "Journal",
            date: sDate,
            narration: `${what} — ${tag} (owner side)`,
            lines: [
              drLine(oLedger, total, { name: refNo, type: "Agst Ref" }),
              ...mergeSameLedger(credits).map(([l, a]) => crLine(l, a)),
            ],
          });
        };
        const vTds = toNum(s.vTdsAmt);
        vDed("VTDS", vTds, [[C("tds", "TDS ON TRANSPORT 194C"), vTds]], "TDS");
        const vComm = toNum(s.vCommAmt);
        const vMamool = toNum(s.vMamool);
        vDed(
          "VCOMM",
          round2(vComm + vMamool),
          [
            [C("commission", "COMMISSION INCOME"), vComm],
            [C("mamool", "MAMOOL INCOME"), vMamool],
          ],
          "Commission / Mamool"
        );
        const vLd = toNum(s.vLdCharge);
        vDed("VLD", vLd, [[C("ld", "LD CHARGE RECOVERED"), vLd]], "LD charge");
        const vPc = toNum(s.vPaymentAmt);
        vDed("VPC", vPc, [[C("payment_charge", "PAYMENT CHARGES RECOVERED"), vPc]], "Payment charge");
        const vShort = toNum(s.vShortageAmt);
        vDed("VSHORT", vShort, [[C("shortage", "SHORTAGE RECOVERY"), vShort]], "Shortage");

        advances.forEach((a, i) => {
          if (a.side !== "V") return;
          const amt = round2(toNum(a.amount ?? 0));
          if (amt <= 0 || a.type === "ADVANCE_ADJ") return;
          const aDate = a.date ? tallyDate(new Date(`${a.date}T00:00:00`)) : sDate;
          const dieselBits =
            a.dieselQty && toNum(a.dieselQty) > 0
              ? ` ${toNum(a.dieselQty)} L${a.dieselRate ? ` @ ${toNum(a.dieselRate)}` : ""}`
              : "";
          const nar = `${(a.type ?? "").replace(/_/g, " ")} advance paid${dieselBits}${a.supplierName ? ` — ${a.supplierName}` : ""} — ${tag}${a.remarks ? ` — ${a.remarks}` : ""}`;
          const ownerDr = drLine(oLedger, amt, { name: refNo, type: "Agst Ref" });
          if (a.headKind === "BANK" || a.headKind === "CASH") {
            const ledger =
              a.headKind === "CASH"
                ? C("cash", "CASH")
                : a.headId
                  ? moneyLedger(ctx, a.headId, a.bankName?.trim() || "BANK")
                  : a.bankName?.trim() || "BANK";
            vouchers.push({
              key: `SLIP:${s.id}:VADV:${i}`,
              type: "Receipt",
              date: aDate,
              narration: nar,
              lines: [ownerDr, crLine(ledger, amt)],
            });
          } else {
            vouchers.push({
              key: `SLIP:${s.id}:VADV:${i}`,
              type: "Journal",
              date: aDate,
              narration: nar,
              lines: [ownerDr, crLine(headLedger(ctx, a.headId ?? null), amt)],
            });
          }
        });

        if (s.vPaymentStatus === "PAID") {
          // legacy slip-side figures + the settlement voucher's (voucher-era
          // v-columns are zero) — one combined split export
          const vv = slipVVouchers.get(s.id);
          vouchers.push(
            ...settlementVouchers({
              keyBase: `SLIP:${s.id}:V`,
              counterLedger: oLedger,
              refNo,
              date: s.vPaymentDate
                ? tallyDate(s.vPaymentDate)
                : vv?.date
                  ? tallyDate(vv.date)
                  : sDate,
              narrationBase: `${tag} (owner side)${s.vPaymentRemarks ? ` — ${s.vPaymentRemarks}` : ""}`,
              counterSide: "DR", // owner debited — money went OUT
              paid: round2(toNum(s.vPaidAmount) + (vv?.paid ?? 0)),
              payLedger: s.vPaymentHeadId
                ? moneyLedger(ctx, s.vPaymentHeadId, C("cash", "CASH"))
                : vv?.bankPartyId
                  ? moneyLedger(ctx, vv.bankPartyId, C("cash", "CASH"))
                  : C("cash", "CASH"),
              payIsCard: isCardLedger(ctx, s.vPaymentHeadId ?? vv?.bankPartyId),
              shortage: round2(toNum(s.vShortage) + (vv?.shortage ?? 0)),
              shortageLedger: C("shortage", "SHORTAGE RECOVERY"),
              roundOff: round2(toNum(s.vRoundOff) + (vv?.roundOff ?? 0)),
              roundOffLedger: C("round_off", "ROUND OFF"),
            })
          );
        }
      }
    }

    if (!vouchers.length) continue;
    docs.push({
      id: s.id,
      refNo: s.slipNo,
      dateIso: s.slipDate.toISOString(),
      party: s.partyId ? ctx.partyById.get(s.partyId)?.name ?? "" : "",
      detail: `${vehicle ? `${vehicle.number} · ` : ""}${ownVehicle ? "Own vehicle (party side only)" : "both sides"}`,
      amount: toNum(s.pNetAmt) || toNum(s.vNetAmt),
      vouchers,
    });
  }

  const masters = Array.from(masterIds.entries())
    .map(([id, parent]) => masterOf(ctx, id, parent))
    .filter(Boolean) as TallyLedgerMaster[];
  return { docs, masters };
}

// ---------------------------------------------------------------- VEHICLE EXPENSES

export async function buildExpenseDocs(
  tx: Tx,
  session: Session,
  r: Range
): Promise<{ docs: ExportDoc[]; masters: TallyLedgerMaster[] }> {
  const ctx = await loadCtx(tx, session);
  const vouchers = await tx.vehicleExpenseVoucher.findMany({
    where: {
      firmId: session.firmId,
      // date filter beats FY (FY continuity)
      ...(r.dateFrom || r.dateTo ? {} : { fyId: session.fyId }),
      deletedAt: null,
      ...(r.dateFrom || r.dateTo
        ? {
            date: {
              ...(r.dateFrom ? { gte: r.dateFrom } : {}),
              ...(r.dateTo ? { lte: r.dateTo } : {}),
            },
          }
        : {}),
    },
    include: { items: { select: { vehicleId: true } } },
    orderBy: [{ date: "asc" }, { voucherNo: "asc" }],
  });

  const docs: ExportDoc[] = [];
  const masterIds = new Set<string>();

  for (const v of vouchers) {
    const amount = toNum(v.amount);
    if (amount <= 0) continue;
    const isExpense = v.txnType !== "INCOME";
    const head = headLedger(ctx, v.headId);
    // allocated vehicles ride the narration, so the Tally entry says which
    // trucks took the cost (max 4 numbers, then a +count)
    const vehicleNos = Array.from(
      new Set(
        v.items
          .map((it) => ctx.vehicleById.get(it.vehicleId)?.number)
          .filter((n): n is string => !!n)
      )
    );
    const vehicleBits =
      vehicleNos.length === 0
        ? ""
        : ` — ${vehicleNos.slice(0, 4).join(", ")}${vehicleNos.length > 4 ? ` +${vehicleNos.length - 4}` : ""}`;
    const nar = `${v.voucherNo}${v.itemName ? ` — ${v.itemName}` : ""}${v.qty ? ` (${toNum(v.qty)})` : ""}${vehicleBits}${v.remarks ? ` — ${v.remarks}` : ""}`;
    const paid = !!v.paymentMode && !!v.bankPartyId;

    let voucher: TallyVoucher;
    if (paid) {
      const money = moneyLedger(ctx, v.bankPartyId, "CASH");
      const date = tallyDate(v.paymentDate ?? v.date);
      // card-settled = Journal (Expense Dr / Card Cr); the lines are unchanged
      voucher = isExpense
        ? {
            key: `VEX:${v.id}`,
            type: moneyVoucherType(ctx, v.bankPartyId, "Payment"),
            date,
            narration: nar,
            lines: [drLine(head, amount), crLine(money, amount)],
          }
        : {
            key: `VEX:${v.id}`,
            type: moneyVoucherType(ctx, v.bankPartyId, "Receipt"),
            date,
            narration: nar,
            lines: [drLine(money, amount), crLine(head, amount)],
          };
    } else if (v.partyId) {
      // on credit — supplier's ledger carries it until the payment voucher
      const supplier = partyLedger(ctx, v.partyId);
      masterIds.add(v.partyId);
      voucher = isExpense
        ? {
            key: `VEX:${v.id}`,
            type: "Journal",
            date: tallyDate(v.date),
            narration: nar,
            lines: [
              drLine(head, amount),
              crLine(supplier, amount, { name: v.voucherNo, type: "New Ref" }),
            ],
          }
        : {
            key: `VEX:${v.id}`,
            type: "Journal",
            date: tallyDate(v.date),
            narration: nar,
            lines: [
              drLine(supplier, amount, { name: v.voucherNo, type: "New Ref" }),
              crLine(head, amount),
            ],
          };
    } else {
      continue; // neither paid nor a supplier — nothing to post
    }

    docs.push({
      id: v.id,
      refNo: v.voucherNo,
      dateIso: v.date.toISOString(),
      party: v.partyId ? ctx.partyById.get(v.partyId)?.name ?? "" : (v.paymentMode ?? ""),
      detail: `${isExpense ? "Expense" : "Income"} · ${ctx.headById.get(v.headId) ?? ""}`,
      amount,
      vouchers: [voucher],
    });
  }
  const masters = Array.from(masterIds)
    .map((id) => masterOf(ctx, id, "Sundry Creditors"))
    .filter(Boolean) as TallyLedgerMaster[];
  return { docs, masters };
}

// ---------------------------------------------------------------- OFFICE

export async function buildOfficeDocs(
  tx: Tx,
  session: Session,
  r: Range
): Promise<{ docs: ExportDoc[]; masters: TallyLedgerMaster[] }> {
  const ctx = await loadCtx(tx, session);
  const txns = await tx.officeTransaction.findMany({
    where: {
      firmId: session.firmId,
      // date filter beats FY (FY continuity)
      ...(r.dateFrom || r.dateTo ? {} : { fyId: session.fyId }),
      deletedAt: null,
      ...(r.dateFrom || r.dateTo
        ? {
            date: {
              ...(r.dateFrom ? { gte: r.dateFrom } : {}),
              ...(r.dateTo ? { lte: r.dateTo } : {}),
            },
          }
        : {}),
    },
    include: { lines: true },
    orderBy: [{ date: "asc" }, { voucherNo: "asc" }],
  });

  const docs: ExportDoc[] = [];
  const masterIds = new Set<string>();

  for (const t of txns) {
    const amount = toNum(t.amount);
    if (amount <= 0) continue;
    const isExpense = t.txnType !== "INCOME";
    // multi-head txns split line-wise; single-head uses the header head
    const headLines: [string, number][] = t.lines.length
      ? t.lines.map((l): [string, number] => [headLedger(ctx, l.headId), toNum(l.amount)])
      : [[headLedger(ctx, t.headId), amount]];
    const nar = `${t.voucherNo}${t.refNo ? ` — ${t.refNo}` : ""}${t.remarks ? ` — ${t.remarks}` : ""}`;
    const paid = !!t.paymentMode && !!t.bankPartyId;

    let voucher: TallyVoucher;
    if (paid) {
      const money = moneyLedger(ctx, t.bankPartyId, "CASH");
      voucher = {
        key: `OFC:${t.id}`,
        type: moneyVoucherType(ctx, t.bankPartyId, isExpense ? "Payment" : "Receipt"),
        date: tallyDate(t.date),
        narration: nar,
        lines: isExpense
          ? [...headLines.filter(([, a]) => a > 0).map(([l, a]) => drLine(l, a)), crLine(money, amount)]
          : [drLine(money, amount), ...headLines.filter(([, a]) => a > 0).map(([l, a]) => crLine(l, a))],
      };
    } else if (t.partyId) {
      const supplier = partyLedger(ctx, t.partyId);
      masterIds.add(t.partyId);
      voucher = {
        key: `OFC:${t.id}`,
        type: "Journal",
        date: tallyDate(t.date),
        narration: nar,
        lines: isExpense
          ? [
              ...headLines.filter(([, a]) => a > 0).map(([l, a]) => drLine(l, a)),
              crLine(supplier, amount, { name: t.voucherNo, type: "New Ref" }),
            ]
          : [
              drLine(supplier, amount, { name: t.voucherNo, type: "New Ref" }),
              ...headLines.filter(([, a]) => a > 0).map(([l, a]) => crLine(l, a)),
            ],
      };
    } else {
      continue;
    }

    docs.push({
      id: t.id,
      refNo: t.voucherNo,
      dateIso: t.date.toISOString(),
      party: t.partyId ? ctx.partyById.get(t.partyId)?.name ?? "" : (t.paymentMode ?? ""),
      detail: `${isExpense ? "Expense" : "Income"} · ${ctx.headById.get(t.headId) ?? ""}`,
      amount,
      vouchers: [voucher],
    });
  }
  const masters = Array.from(masterIds)
    .map((id) => masterOf(ctx, id, "Sundry Creditors"))
    .filter(Boolean) as TallyLedgerMaster[];
  return { docs, masters };
}

// ---------------------------------------------------------------- dispatcher

export async function buildModuleDocs(
  tx: Tx,
  session: Session,
  module: TallyModule,
  r: Range
): Promise<{ docs: ExportDoc[]; masters: TallyLedgerMaster[] }> {
  switch (module) {
    case "CHALAN":
      return buildChalanDocs(tx, session, r);
    case "BILLING":
      return buildBillingDocs(tx, session, r);
    case "SLIP":
      return buildSlipDocs(tx, session, r);
    case "VOUCHERS":
      return buildVoucherDocs(tx, session, r);
    case "EXPENSES":
      return buildExpenseDocs(tx, session, r);
    case "OFFICE":
      return buildOfficeDocs(tx, session, r);
  }
}

/** Status of one generated voucher against the export register. */
export type VoucherStatus = "NEW" | "EXPORTED" | "CHANGED";

export function voucherStatuses(
  docs: ExportDoc[],
  registry: Map<string, string> // key -> hash
): Map<string, VoucherStatus> {
  const out = new Map<string, VoucherStatus>();
  for (const d of docs) {
    for (const raw of d.vouchers) {
      // the export path injects the document number as VOUCHERNUMBER before
      // hashing — the status must hash the SAME shape or everything already
      // exported would read CHANGED forever
      const v = { ...raw, voucherNo: raw.voucherNo ?? d.refNo };
      const prev = registry.get(v.key);
      out.set(v.key, prev === undefined ? "NEW" : prev === voucherHash(v) ? "EXPORTED" : "CHANGED");
    }
  }
  return out;
}
