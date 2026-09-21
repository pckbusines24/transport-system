import type { Prisma } from "@prisma/client";
import { withTenant } from "@/lib/db";
import type { Session } from "@/lib/session";
import { roundWt, toNum } from "@/lib/utils";
import { round2 } from "@/lib/calc/tds";
import { BILL_REF_TYPES, invoiceSettlement, payableSettlement } from "@/lib/settlement";

/**
 * Dashboard → Status: one search, the whole chain —
 *   LR → Chalan → owner/broker settlement → POD / received wt / shortage →
 *   Bill (only the LRs actually billed) → receipts → pending.
 *
 * READ-ONLY. Everything here is a projection of existing records: chalans,
 * their advances, voucher allocations, PODs and invoices. Nothing is posted.
 *
 * Linking rule: any hit (an LR, a bill, a vehicle, a broker) resolves to the
 * CHALANS it belongs to, and every chalan then carries ALL of its LRs — so
 * searching LR-15 shows LR-14/16/17 riding the same chalan without another
 * search. LRs that are not on any chalan yet are listed on their own.
 */

export interface StatusFilters {
  lrNo?: string;
  chalanNo?: string;
  billNo?: string;
  vehicleId?: string;
  brokerId?: string;
  dateFrom?: string; // yyyy-mm-dd
  dateTo?: string;
}

export interface StatusReceipt {
  date: string | null;
  voucherNo: string;
  amount: number; // money received / paid
  tds: number;
  deduction: number; // shortage
  other: number;
  roundOff: number;
  account: string; // bank / cash ledger
  remarks: string;
}

export interface StatusBill {
  id: string;
  invoiceNo: string;
  invoiceDate: string;
  kind: string;
  party: string;
  /** LRs actually on the bill — never the whole chalan */
  lrNos: string[];
  chalanNos: string[];
  netTotal: number;
  advance: number;
  received: number;
  outstanding: number;
  status: string;
  receipts: StatusReceipt[];
}

export interface StatusPod {
  status: "RECEIVED" | "PENDING";
  unloadDate: string | null;
  actualWt: number;
  recWt: number | null;
  shortageWt: number;
  podDate: string | null;
  ackNo: string;
  remarks: string;
}

export interface StatusLr {
  id: string;
  lrNo: string;
  lrDate: string;
  status: string;
  from: string;
  to: string;
  consignor: string;
  consignee: string;
  billTo: string;
  qty: number;
  actualWt: number;
  chargeWt: number;
  rate: number;
  rateBasis: string;
  /** LR booking freight (before charges) and the billed total */
  freight: number;
  grandTotal: number;
  shortageAmt: number;
  pod: StatusPod;
  billNos: string[];
  billIds: string[];
}

export interface StatusAdvance {
  date: string | null;
  type: string;
  amount: number;
  account: string;
  voucherNo: string;
  remarks: string;
}

export interface StatusAdjustment {
  head: string;
  amount: number;
  sign: 1 | -1;
  date: string | null;
  reference: string;
}

export interface StatusChalan {
  id: string;
  chalanNo: string;
  chalanDate: string;
  isFinal: boolean;
  cancelled: boolean;
  broker: string;
  vehicleNo: string;
  from: string;
  to: string;
  qty: number;
  actualWt: number;
  chargeWt: number;
  rateBasis: string;
  bookingRate: number;
  chargeRate: number;
  bookingFreight: number;
  chFreight: number;
  margin: number;
  settlement: {
    freight: number;
    addition: number;
    deduction: number;
    totalChalanAmt: number;
    commission: number;
    tds: number;
    mamool: number;
    courier: number;
    grandTotal: number;
    advanceTotal: number;
    /** grandTotal − advances, before balance settlement */
    balance: number;
    paid: number;
    shortage: number;
    roundOff: number;
    outstanding: number;
    status: string;
    balanceDate: string | null;
  };
  adjustments: StatusAdjustment[];
  advances: StatusAdvance[];
  payments: StatusReceipt[];
  lrs: StatusLr[];
  bills: StatusBill[];
  timeline: { stage: string; date: string | null; status: string; done: boolean }[];
}

export interface StatusResult {
  chalans: StatusChalan[];
  /** LRs matched by the search that are not on any chalan */
  looseLrs: StatusLr[];
  bills: StatusBill[];
  truncated: boolean;
}

const MAX_CHALANS = 150;

const iso = (d: Date | null | undefined) => (d ? d.toISOString() : null);

function dayRange(from?: string, to?: string): Prisma.DateTimeFilter | null {
  const f = from && /^\d{4}-\d{2}-\d{2}$/.test(from) ? new Date(`${from}T00:00:00+05:30`) : null;
  const t = to && /^\d{4}-\d{2}-\d{2}$/.test(to) ? new Date(`${to}T23:59:59.999+05:30`) : null;
  if (!f && !t) return null;
  return { ...(f ? { gte: f } : {}), ...(t ? { lte: t } : {}) };
}

export function hasAnyFilter(f: StatusFilters): boolean {
  return !!(f.lrNo || f.chalanNo || f.billNo || f.vehicleId || f.brokerId || f.dateFrom || f.dateTo);
}

const lrSelect = {
  id: true,
  lrNo: true,
  lrDate: true,
  status: true,
  sourceCityId: true,
  destCityId: true,
  consignorId: true,
  consigneeId: true,
  billToId: true,
  freight: true,
  grandTotal: true,
  items: {
    select: {
      qty: true,
      actualWt: true,
      chargeWt: true,
      rate: true,
      rateBasis: true,
      shortageAmt: true,
    },
  },
  pods: {
    select: {
      unloadDate: true,
      actualWt: true,
      recWt: true,
      shortageWt: true,
      docDate: true,
      createdAt: true,
      ackNo: true,
      remarks: true,
      status: true,
    },
  },
  invoiceLrs: { select: { invoiceId: true, invoice: { select: { invoiceNo: true, deletedAt: true } } } },
} satisfies Prisma.LrSelect;

type LrRow = Prisma.LrGetPayload<{ select: typeof lrSelect }>;

export async function getStatusData(
  session: Session & { firmId: string; fyId: string },
  f: StatusFilters
): Promise<StatusResult> {
  const empty: StatusResult = {
    chalans: [],
    looseLrs: [],
    bills: [],
    truncated: false,
  };
  if (!hasAnyFilter(f)) return empty;

  return withTenant(session.tenantId, async (tx) => {
    const firmId = session.firmId;
    const range = dayRange(f.dateFrom, f.dateTo);

    // ---------- 1. resolve the search to chalan ids (+ directly matched LRs)
    const chalanIdSets: Set<string>[] = [];
    let directLrIds: string[] = [];

    if (f.lrNo) {
      const lrs = await tx.lr.findMany({
        where: { firmId, deletedAt: null, lrNo: { equals: f.lrNo.trim(), mode: "insensitive" } },
        select: { id: true, chalanLrs: { select: { chalanId: true } } },
      });
      directLrIds = lrs.map((l) => l.id);
      chalanIdSets.push(new Set(lrs.flatMap((l) => l.chalanLrs.map((c) => c.chalanId))));
    }
    if (f.billNo) {
      const invs = await tx.invoice.findMany({
        where: { firmId, deletedAt: null, invoiceNo: { equals: f.billNo.trim(), mode: "insensitive" } },
        select: { lrs: { select: { lrId: true, lr: { select: { chalanLrs: { select: { chalanId: true } } } } } } },
      });
      const ids = new Set<string>();
      for (const inv of invs)
        for (const il of inv.lrs) {
          if (!il.lr.chalanLrs.length) directLrIds.push(il.lrId);
          for (const c of il.lr.chalanLrs) ids.add(c.chalanId);
        }
      chalanIdSets.push(ids);
    }
    if (f.chalanNo) {
      const rows = await tx.chalan.findMany({
        where: { firmId, deletedAt: null, chalanNo: { equals: f.chalanNo.trim(), mode: "insensitive" } },
        select: { id: true },
      });
      chalanIdSets.push(new Set(rows.map((r) => r.id)));
    }

    // an explicit document number narrows to ITS chalans; vehicle / broker /
    // dates then filter within that set (or define the set when none given)
    let idFilter: string[] | null = null;
    if (chalanIdSets.length) {
      const union = new Set<string>();
      for (const s of chalanIdSets) s.forEach((id) => union.add(id));
      idFilter = Array.from(union);
      if (!idFilter.length && !directLrIds.length) return empty;
    }

    const where: Prisma.ChalanWhereInput = {
      firmId,
      deletedAt: null,
      ...(idFilter ? { id: { in: idFilter } } : {}),
      ...(f.vehicleId ? { vehicleId: f.vehicleId } : {}),
      ...(f.brokerId ? { brokerId: f.brokerId } : {}),
      ...(range ? { chalanDate: range } : {}),
    };

    const chalanRows = await tx.chalan.findMany({
      where,
      orderBy: [{ chalanDate: "desc" }, { chalanNo: "desc" }],
      take: MAX_CHALANS + 1,
      include: {
        advances: { orderBy: { date: "asc" } },
        lrs: { select: { lr: { select: lrSelect } } },
      },
    });
    const truncated = chalanRows.length > MAX_CHALANS;
    const chalans = chalanRows.slice(0, MAX_CHALANS);

    // LRs matched directly but not riding any of the chalans above
    const onChalan = new Set(chalans.flatMap((c) => c.lrs.map((l) => l.lr.id)));
    const looseIds = Array.from(new Set(directLrIds)).filter((id) => !onChalan.has(id));
    const looseRows = looseIds.length
      ? await tx.lr.findMany({ where: { id: { in: looseIds }, deletedAt: null }, select: lrSelect })
      : [];

    // ---------- 2. lookups
    const partyIds = new Set<string>();
    const cityIds = new Set<string>();
    const vehicleIds = new Set<string>();
    const allLrs: LrRow[] = [...chalans.flatMap((c) => c.lrs.map((l) => l.lr)), ...looseRows];
    for (const c of chalans) {
      partyIds.add(c.brokerId);
      vehicleIds.add(c.vehicleId);
      if (c.sourceCityId) cityIds.add(c.sourceCityId);
      if (c.destCityId) cityIds.add(c.destCityId);
      if (c.balPaymentHeadId) partyIds.add(c.balPaymentHeadId);
      for (const a of c.advances) if (a.bankPartyId) partyIds.add(a.bankPartyId);
    }
    for (const l of allLrs) {
      for (const id of [l.consignorId, l.consigneeId, l.billToId]) if (id) partyIds.add(id);
      for (const id of [l.sourceCityId, l.destCityId]) if (id) cityIds.add(id);
    }

    // bills: every live invoice any of these LRs is on
    const invoiceIds = Array.from(
      new Set(allLrs.flatMap((l) => l.invoiceLrs.filter((x) => !x.invoice.deletedAt).map((x) => x.invoiceId)))
    );
    const invoices = invoiceIds.length
      ? await tx.invoice.findMany({
          where: { id: { in: invoiceIds }, deletedAt: null },
          select: {
            id: true,
            invoiceNo: true,
            invoiceDate: true,
            kind: true,
            partyId: true,
            netTotal: true,
            advance: true,
            lrs: {
              select: {
                lr: {
                  select: {
                    lrNo: true,
                    chalanLrs: { select: { chalan: { select: { chalanNo: true, deletedAt: true } } } },
                  },
                },
              },
            },
          },
          orderBy: { invoiceDate: "asc" },
        })
      : [];
    for (const inv of invoices) partyIds.add(inv.partyId);

    const [billAllocs, chalanAllocs, invSettle, payable] = await Promise.all([
      invoiceIds.length
        ? tx.voucherAllocation.findMany({
            where: { refType: { in: BILL_REF_TYPES }, refId: { in: invoiceIds }, voucher: { deletedAt: null, firmId } },
            select: {
              refId: true, amount: true, tdsAmt: true, deduction: true, otherAmt: true, roundOff: true, remarks: true,
              voucher: { select: { voucherNo: true, voucherDate: true, bankPartyId: true, entryType: true, remarks: true } },
            },
          })
        : Promise.resolve([]),
      chalans.length
        ? tx.voucherAllocation.findMany({
            where: {
              refType: "FREIGHT_CHALLAN",
              refId: { in: chalans.map((c) => c.id) },
              voucher: { deletedAt: null, firmId },
            },
            select: {
              refId: true, amount: true, tdsAmt: true, deduction: true, otherAmt: true, roundOff: true, remarks: true,
              voucher: { select: { voucherNo: true, voucherDate: true, bankPartyId: true, entryType: true, remarks: true } },
            },
          })
        : Promise.resolve([]),
      invoiceSettlement(tx, { firmId, invoices }),
      payableSettlement(tx, {
        firmId,
        refType: "FREIGHT_CHALLAN",
        docs: chalans.map((c) => ({
          id: c.id,
          balance: round2(toNum(c.grandTotal) - toNum(c.advanceTotal)),
          ownPaid: toNum(c.balPaidAmount),
          ownShortage: toNum(c.balShortage),
          ownRoundOff: toNum(c.balRoundOff),
          ownAdvanceAdjusted: toNum(c.balAdvanceAdjusted),
        })),
      }),
    ]);
    for (const a of [...billAllocs, ...chalanAllocs]) if (a.voucher.bankPartyId) partyIds.add(a.voucher.bankPartyId);

    const [parties, cities, vehicles] = await Promise.all([
      tx.party.findMany({ where: { id: { in: Array.from(partyIds) } }, select: { id: true, name: true } }),
      tx.city.findMany({ where: { id: { in: Array.from(cityIds) } }, select: { id: true, name: true } }),
      tx.vehicle.findMany({ where: { id: { in: Array.from(vehicleIds) } }, select: { id: true, number: true } }),
    ]);
    const party = new Map(parties.map((p) => [p.id, p.name]));
    const city = new Map(cities.map((c) => [c.id, c.name]));
    const vehicle = new Map(vehicles.map((v) => [v.id, v.number]));
    const P = (id: string | null | undefined) => (id ? party.get(id) ?? "" : "");
    const CT = (id: string | null | undefined) => (id ? city.get(id) ?? "" : "");

    // ---------- 3. shape
    const toReceipt = (a: (typeof billAllocs)[number]): StatusReceipt => ({
      date: iso(a.voucher.voucherDate),
      voucherNo: a.voucher.voucherNo,
      amount: toNum(a.amount),
      tds: toNum(a.tdsAmt),
      deduction: toNum(a.deduction),
      other: toNum(a.otherAmt),
      roundOff: toNum(a.roundOff),
      account: P(a.voucher.bankPartyId) || a.voucher.entryType,
      remarks: a.remarks ?? a.voucher.remarks ?? "",
    });

    const billById = new Map<string, StatusBill>();
    for (const inv of invoices) {
      const s = invSettle.get(inv.id);
      billById.set(inv.id, {
        id: inv.id,
        invoiceNo: inv.invoiceNo,
        invoiceDate: inv.invoiceDate.toISOString(),
        kind: inv.kind.replace(/_/g, " "),
        party: P(inv.partyId),
        lrNos: inv.lrs.map((x) => x.lr.lrNo),
        chalanNos: Array.from(
          new Set(inv.lrs.flatMap((x) => x.lr.chalanLrs.filter((c) => !c.chalan.deletedAt).map((c) => c.chalan.chalanNo)))
        ),
        netTotal: toNum(inv.netTotal),
        advance: toNum(inv.advance),
        received: s?.received ?? toNum(inv.advance),
        outstanding: s?.outstanding ?? round2(toNum(inv.netTotal) - toNum(inv.advance)),
        status: s?.status ?? "UNPAID",
        receipts: billAllocs
          .filter((a) => a.refId === inv.id)
          .map(toReceipt)
          .sort((a, b) => (a.date ?? "").localeCompare(b.date ?? "")),
      });
    }

    const shapeLr = (l: LrRow): StatusLr => {
      const sum = (pick: (i: LrRow["items"][number]) => unknown) => l.items.reduce((s, i) => s + toNum(pick(i)), 0);
      const pod = l.pods[0] ?? null;
      const actualWt = roundWt(sum((i) => i.actualWt));
      const first = l.items[0];
      const liveBills = l.invoiceLrs.filter((x) => !x.invoice.deletedAt);
      return {
        id: l.id,
        lrNo: l.lrNo,
        lrDate: l.lrDate.toISOString(),
        status: l.status,
        from: CT(l.sourceCityId),
        to: CT(l.destCityId),
        consignor: P(l.consignorId),
        consignee: P(l.consigneeId),
        billTo: P(l.billToId),
        qty: sum((i) => i.qty),
        actualWt,
        chargeWt: roundWt(sum((i) => i.chargeWt)),
        rate: first ? toNum(first.rate) : 0,
        rateBasis: first?.rateBasis ?? "",
        freight: toNum(l.freight),
        grandTotal: toNum(l.grandTotal),
        shortageAmt: round2(sum((i) => i.shortageAmt)),
        pod: pod
          ? {
              status: "RECEIVED",
              unloadDate: iso(pod.unloadDate),
              actualWt: toNum(pod.actualWt) || actualWt,
              recWt: pod.recWt === null ? null : toNum(pod.recWt),
              shortageWt: roundWt(toNum(pod.shortageWt)),
              podDate: iso(pod.docDate ?? pod.createdAt),
              ackNo: pod.ackNo ?? "",
              remarks: pod.remarks ?? "",
            }
          : { status: "PENDING", unloadDate: null, actualWt, recWt: null, shortageWt: 0, podDate: null, ackNo: "", remarks: "" },
        billNos: liveBills.map((x) => x.invoice.invoiceNo),
        billIds: liveBills.map((x) => x.invoiceId),
      };
    };

    const out: StatusChalan[] = chalans.map((c) => {
      const lrs = c.lrs.map((l) => shapeLr(l.lr)).sort((a, b) => a.lrNo.localeCompare(b.lrNo, undefined, { numeric: true }));
      const pos = payable.get(c.id);
      const addition = round2(toNum(c.detention) + toNum(c.odcAmt) + toNum(c.fineSlip) + toNum(c.otherAmt));
      const deduction = round2(toNum(c.ldCharge) + toNum(c.shortageAmt));
      const balance = round2(toNum(c.grandTotal) - toNum(c.advanceTotal));
      const payments: StatusReceipt[] = chalanAllocs.filter((a) => a.refId === c.id).map(toReceipt);
      if (toNum(c.balPaidAmount) > 0 || toNum(c.balShortage) > 0 || toNum(c.balRoundOff) > 0) {
        payments.push({
          date: iso(c.balPaymentDate),
          voucherNo: "Chalan balance",
          amount: toNum(c.balPaidAmount),
          tds: 0,
          deduction: toNum(c.balShortage),
          other: 0,
          roundOff: toNum(c.balRoundOff),
          account: P(c.balPaymentHeadId) || c.balPaymentMode || "",
          remarks: c.balRemarks ?? "",
        });
      }
      payments.sort((a, b) => (a.date ?? "").localeCompare(b.date ?? ""));
      const chDate = c.chalanDate.toISOString();
      const adj = (head: string, amount: number, sign: 1 | -1, reference = ""): StatusAdjustment | null =>
        amount > 0.009 ? { head, amount, sign, date: chDate, reference } : null;
      const adjustments = [
        adj("Detention", toNum(c.detention), 1),
        adj("ODC Amount", toNum(c.odcAmt), 1),
        adj("Fine Slip", toNum(c.fineSlip), 1),
        adj("Other Amount", toNum(c.otherAmt), 1, c.otherRemarks ?? ""),
        adj("LD Charge", toNum(c.ldCharge), -1),
        adj("Shortage", toNum(c.shortageAmt), -1),
        adj("Commission", toNum(c.commissionAmt), -1, c.commissionPct ? `${toNum(c.commissionPct)}%` : ""),
        adj("TDS", toNum(c.tdsAmt), -1, c.tdsPct ? `${toNum(c.tdsPct)}%` : ""),
        adj("Mamool", toNum(c.mamool), -1),
        adj("Courier", toNum(c.courierCharge), -1),
      ].filter((x): x is StatusAdjustment => !!x);
      for (const p of payments) {
        if (p.deduction > 0.009) adjustments.push({ head: "Shortage (at payment)", amount: p.deduction, sign: -1, date: p.date, reference: p.voucherNo });
        if (p.tds > 0.009) adjustments.push({ head: "TDS (at payment)", amount: p.tds, sign: -1, date: p.date, reference: p.voucherNo });
        if (p.other > 0.009) adjustments.push({ head: "Other (at payment)", amount: p.other, sign: -1, date: p.date, reference: p.voucherNo });
      }

      const bills = Array.from(new Set(lrs.flatMap((l) => l.billIds)))
        .map((id) => billById.get(id))
        .filter((b): b is StatusBill => !!b);
      const billed = lrs.filter((l) => l.billIds.length).length;
      const podDone = lrs.filter((l) => l.pod.status === "RECEIVED");
      const wtDone = podDone.filter((l) => l.pod.recWt !== null);
      const shortLrs = lrs.filter((l) => l.pod.shortageWt > 0);
      const billAdvance = round2(bills.reduce((s, b) => s + b.advance, 0));
      const billReceived = round2(bills.reduce((s, b) => s + b.received - b.advance, 0));
      const billPending = round2(bills.reduce((s, b) => s + b.outstanding, 0));
      const last = (ds: (string | null)[]) => ds.filter((d): d is string => !!d).sort().at(-1) ?? null;
      const lastReceipt = last(bills.flatMap((b) => b.receipts.map((r) => r.date)));
      const chargeWt = roundWt(toNum(c.chargeWt));
      const bookingFreight = toNum(c.bookingFreight) || round2(lrs.reduce((s, l) => s + l.freight, 0));
      const bookingRate = lrs[0]?.rate ?? (chargeWt > 0 ? round2(bookingFreight / chargeWt) : 0);

      const timeline: StatusChalan["timeline"] = [
        { stage: "LR Created", date: last(lrs.map((l) => l.lrDate)), status: `${lrs.length} LR`, done: lrs.length > 0 },
        { stage: "Chalan Created", date: chDate, status: c.isFinal ? "Final" : "Draft", done: true },
        { stage: "Vehicle Dispatched", date: chDate, status: c.cancelledAt ? "Cancelled" : vehicle.get(c.vehicleId) ?? "", done: !c.cancelledAt },
        { stage: "POD", date: last(podDone.map((l) => l.pod.podDate)), status: `${podDone.length}/${lrs.length} received`, done: lrs.length > 0 && podDone.length === lrs.length },
        { stage: "WT Updated", date: last(wtDone.map((l) => l.pod.unloadDate ?? l.pod.podDate)), status: `${wtDone.length}/${lrs.length}`, done: lrs.length > 0 && wtDone.length === lrs.length },
        { stage: "Shortage", date: last(shortLrs.map((l) => l.pod.podDate)), status: shortLrs.length ? `${roundWt(shortLrs.reduce((s, l) => s + l.pod.shortageWt, 0))} MT on ${shortLrs.length} LR` : "None", done: podDone.length === lrs.length && lrs.length > 0 },
        { stage: "Bill", date: last(bills.map((b) => b.invoiceDate)), status: lrs.length ? `${billed}/${lrs.length} LR billed` : "—", done: lrs.length > 0 && billed === lrs.length },
        { stage: "Advance Received", date: last(bills.map((b) => (b.advance > 0 ? b.invoiceDate : null))), status: billAdvance > 0 ? String(billAdvance) : "None", done: billAdvance > 0 },
        { stage: "Payment Received", date: lastReceipt, status: billReceived > 0 ? String(billReceived) : "None", done: bills.length > 0 && billPending <= 0.009 },
        { stage: "Balance Pending", date: null, status: bills.length ? String(billPending) : "Not billed", done: bills.length > 0 && billPending <= 0.009 },
      ];

      return {
        id: c.id,
        chalanNo: c.chalanNo,
        chalanDate: chDate,
        isFinal: c.isFinal,
        cancelled: !!c.cancelledAt,
        broker: P(c.brokerId),
        vehicleNo: vehicle.get(c.vehicleId) ?? "",
        from: CT(c.sourceCityId) || lrs[0]?.from || "",
        to: CT(c.destCityId) || lrs[0]?.to || "",
        qty: lrs.reduce((s, l) => s + l.qty, 0),
        actualWt: roundWt(toNum(c.actualWt)),
        chargeWt,
        rateBasis: c.rateBasis,
        bookingRate,
        chargeRate: toNum(c.rate),
        bookingFreight,
        chFreight: toNum(c.freight),
        margin: round2(bookingFreight - toNum(c.freight)),
        settlement: {
          freight: toNum(c.freight),
          addition,
          deduction,
          totalChalanAmt: toNum(c.totalChalanAmt),
          commission: toNum(c.commissionAmt),
          tds: toNum(c.tdsAmt),
          mamool: toNum(c.mamool),
          courier: toNum(c.courierCharge),
          grandTotal: toNum(c.grandTotal),
          advanceTotal: toNum(c.advanceTotal),
          balance,
          paid: pos ? round2(toNum(c.balPaidAmount) + pos.voucherPaid) : toNum(c.balPaidAmount),
          shortage: pos ? round2(toNum(c.balShortage) + pos.voucherShortage) : toNum(c.balShortage),
          roundOff: pos ? round2(toNum(c.balRoundOff) + pos.voucherRoundOff) : toNum(c.balRoundOff),
          outstanding: pos?.outstanding ?? balance,
          status: pos?.status ?? (c.paymentStatus === "PAID" ? "PAID" : "UNPAID"),
          balanceDate: last(payments.map((p) => p.date)),
        },
        adjustments,
        advances: c.advances.map((a) => ({
          date: iso(a.date),
          type: a.type.replace(/_/g, " "),
          amount: toNum(a.amount),
          account: P(a.bankPartyId) || a.bankName || a.supplierName || "",
          voucherNo: a.advanceVoucherNo ?? "",
          remarks: a.remarks ?? "",
        })),
        payments,
        lrs,
        bills,
        timeline,
      };
    });

    const looseLrs = looseRows.map(shapeLr);
    const billsAll = Array.from(billById.values());

    return { chalans: out, looseLrs, bills: billsAll, truncated };
  });
}
