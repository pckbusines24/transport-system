"use server";

import { requireSession } from "@/lib/session";
import { withTenant, type Tx } from "@/lib/db";
import { toNum } from "@/lib/utils";
import { round2 } from "@/lib/calc/tds";
import { invoiceSettlement, payableSettlement, refPositions } from "@/lib/settlement";

/**
 * Receivables & Payables with party-wise ageing. Same settlement math as the
 * Outstanding browser, bucketed by document age: 0-30 / 31-60 / 61-90 / 90+.
 */

export type OutSide = "RECV" | "PAY";

export interface AgeingDoc {
  refNo: string;
  date: string; // ISO
  type: string;
  amount: number;
  settled: number;
  outstanding: number;
  days: number;
}

export interface AgeingRow {
  partyId: string | null;
  party: string;
  mobile: string | null;
  b0: number; // 0-30 days
  b31: number; // 31-60
  b61: number; // 61-90
  b90: number; // 90+
  total: number;
  oldestDays: number;
  docs: AgeingDoc[];
}

export interface OutstandingData {
  rows: AgeingRow[];
  totals: { b0: number; b31: number; b61: number; b90: number; total: number; parties: number };
}

const dayMs = 24 * 3600 * 1000;

type RawDoc = {
  partyId: string | null;
  partyName: string | null; // fallback label when there is no party link (hire slips)
  refNo: string;
  date: Date;
  type: string;
  amount: number;
  settled: number;
  outstanding: number;
};

async function collect(
  tx: Tx,
  scope: { firmId: string },
  side: OutSide,
  /** "as on" reporting: only settlements made on/before this date count —
      a bill paid AFTER the date shows PENDING, exactly as it stood then */
  asOf: Date | null
): Promise<RawDoc[]> {
  const out: RawDoc[] = [];
  // own-payment figures stored on documents count only if their payment date
  // falls inside the as-on window
  const ownBy = (paidDate: Date | null | undefined, value: number) =>
    !asOf || (paidDate && paidDate <= asOf) ? value : 0;
  // advance consumption as it stood on the date — uses carry their own dates
  const consumedAsOf = (a: { consumedAmount: unknown; uses?: { date: Date; amount: unknown }[] }) =>
    asOf && a.uses
      ? round2(a.uses.filter((u) => u.date <= asOf).reduce((s, u) => s + toNum(String(u.amount)), 0))
      : round2(toNum(String(a.consumedAmount)));
  if (side === "RECV") {
    const [invoices, slips, officeIncome, advances, settlements, drivers] = await Promise.all([
      tx.invoice.findMany({ where: { ...scope, deletedAt: null } }),
      // party/broker side of slips — what the party still owes after its own
      // balance-received figures
      tx.brokerSlip.findMany({ where: { ...scope, deletedAt: null, partyId: { not: null } } }),
      // income booked on credit — the Outstanding register carries these, so
      // the tile must too or the two totals disagree
      tx.officeTransaction.findMany({
        where: {
          ...scope,
          deletedAt: null,
          txnType: "INCOME",
          paymentMode: null,
          partyId: { not: null },
        },
      }),
      // advances we PAID that nothing consumed yet — the party owes them back
      // (chalan-cancel advances included, labelled apart)
      tx.partyAdvance.findMany({
        where: { ...scope, deletedAt: null, kind: "PAID" },
        include: { uses: { select: { date: true, amount: true } } },
      }),
      // a negative settlement = the driver owes the company. As-on mode also
      // fetches rows settled LATER — on the date they were still open.
      tx.driverSettlement.findMany({
        where: {
          ...scope,
          deletedAt: null,
          amount: { lt: 0 },
          ...(asOf ? {} : { status: "PENDING" }),
        },
      }),
      tx.driver.findMany({ select: { id: true, partyId: true, name: true } }),
    ]);
    const settle = await invoiceSettlement(tx, { ...scope, invoices, asOf });
    for (const i of invoices) {
      const s = settle.get(i.id);
      if (!s || s.outstanding <= 0.009) continue;
      out.push({
        partyId: i.partyId,
        partyName: null,
        refNo: i.invoiceNo,
        date: i.invoiceDate,
        type: `BILL (${i.kind})`,
        amount: s.net,
        settled: s.received,
        outstanding: s.outstanding,
      });
    }
    for (const s of slips) {
      // recomputed live — the stored pBalance column can go stale, and the
      // settlement contract forbids trusting a stored balance
      const balance = round2(toNum(String(s.pNetAmt)) - toNum(String(s.pAdvance)));
      const own = ownBy(
        s.pPaymentDate,
        round2(
          toNum(String(s.pPaidAmount)) + toNum(String(s.pShortage)) + toNum(String(s.pRoundOff))
        )
      );
      const outstanding = round2(balance - own);
      if (outstanding <= 0.009) continue;
      out.push({
        partyId: s.partyId,
        partyName: null,
        refNo: s.slipNo,
        date: s.slipDate,
        type: "BROKER SLIP (PARTY)",
        amount: balance,
        settled: own,
        outstanding,
      });
    }
    // credit income entries settle through OFFICE_INCOME voucher allocations
    const incomePos = await refPositions(tx, {
      ...scope,
      refType: "OFFICE_INCOME",
      asOf,
      docs: officeIncome.map((t) => ({ id: t.id, original: toNum(String(t.amount)) })),
    });
    for (const t of officeIncome) {
      const p = incomePos.get(t.id);
      if (!p || p.outstanding <= 0.009) continue;
      out.push({
        partyId: t.partyId,
        partyName: null,
        refNo: t.refNo || t.voucherNo,
        date: t.date,
        type: "OFFICE INCOME",
        amount: p.original,
        settled: p.settled,
        outstanding: p.outstanding,
      });
    }
    for (const a of advances) {
      const consumed = consumedAsOf(a);
      const available = round2(toNum(String(a.amount)) - consumed);
      if (available <= 0.009) continue;
      out.push({
        partyId: a.partyId,
        partyName: null,
        refNo: a.voucherNo ?? "ADV",
        date: a.date,
        type: a.source === "CHALAN_CANCEL" ? "CANCEL ADVANCE" : "ADVANCE (PAID)",
        amount: round2(toNum(String(a.amount))),
        settled: consumed,
        outstanding: available,
      });
    }
    const driverById = new Map(drivers.map((d) => [d.id, d]));
    const settPos = await refPositions(tx, {
      ...scope,
      refType: "DRIVER_SETTLEMENT",
      asOf,
      docs: settlements.map((s) => ({ id: s.id, original: Math.abs(toNum(String(s.amount))) })),
    });
    for (const s of settlements) {
      // settled on/before the date → it was closed by then, skip
      if (asOf && s.status === "SETTLED" && s.settledDate && s.settledDate <= asOf) continue;
      const p = settPos.get(s.id);
      if (!p || p.outstanding <= 0.009) continue;
      const drv = driverById.get(s.driverId);
      out.push({
        partyId: drv?.partyId ?? null,
        partyName: drv?.name ?? null,
        refNo: s.tripRef || s.voucherNo || "SETTLEMENT",
        date: s.date,
        type: "DRIVER SETTLEMENT",
        amount: p.original,
        settled: p.settled,
        outstanding: p.outstanding,
      });
    }
    return out;
  }
  const [chalans, slips, hires, brokerVehicles, officeBills, vehicleBills, adblueBills, salaries, driverPay, drivers] =
    await Promise.all([
      // draft chalans owe their hire too — the Outstanding register carries
      // them, so hiding them here made the tile and the register disagree
      tx.chalan.findMany({ where: { ...scope, deletedAt: null, cancelledAt: null } }),
      tx.brokerSlip.findMany({ where: { ...scope, deletedAt: null } }),
      tx.hireSlip.findMany({ where: { ...scope, deletedAt: null } }),
      tx.vehicle.findMany({ where: { ownershipType: "BROKER" }, select: { id: true } }),
      // supplier bills booked on credit (no payment mode at entry)
      tx.officeTransaction.findMany({
        where: { ...scope, deletedAt: null, txnType: "EXPENSE", paymentMode: null, partyId: { not: null } },
      }),
      tx.vehicleExpenseVoucher.findMany({
        where: { ...scope, deletedAt: null, txnType: "EXPENSE", paymentMode: null, partyId: { not: null } },
      }),
      tx.adblueTxn.findMany({
        where: {
          ...scope,
          deletedAt: null,
          type: "REFILL",
          billNo: { not: null },
          paymentMode: null,
          supplierId: { not: null },
          amount: { gt: 0 },
        },
      }),
      tx.staffSalary.findMany({ where: { ...scope, deletedAt: null } }),
      // a positive settlement = the company owes the driver; as-on mode also
      // fetches rows settled LATER (still open on that date)
      tx.driverSettlement.findMany({
        where: {
          ...scope,
          deletedAt: null,
          amount: { gt: 0 },
          ...(asOf ? {} : { status: "PENDING" }),
        },
      }),
      tx.driver.findMany({ select: { id: true, partyId: true, name: true } }),
    ]);
  const market = new Set(brokerVehicles.map((v) => v.id));
  const marketChalans = chalans.filter((c) => market.has(c.vehicleId));
  const driverById = new Map(drivers.map((d) => [d.id, d]));
  const chalanPos = await payableSettlement(tx, {
    ...scope,
    refType: "FREIGHT_CHALLAN",
    asOf,
    docs: marketChalans.map((c) => ({
      id: c.id,
      // live: grandTotal − advances, never the stored balance column
      balance: round2(toNum(String(c.grandTotal)) - toNum(String(c.advanceTotal))),
      ownPaid: ownBy(c.balPaymentDate, toNum(String(c.balPaidAmount))),
      ownShortage: ownBy(c.balPaymentDate, toNum(String(c.balShortage))),
      ownRoundOff: ownBy(c.balPaymentDate, toNum(String(c.balRoundOff))),
      ownAdvanceAdjusted: ownBy(c.balPaymentDate, toNum(String(c.balAdvanceAdjusted))),
    })),
  });
  for (const c of marketChalans) {
    const p = chalanPos.get(c.id);
    if (!p || p.outstanding <= 0.009) continue;
    out.push({
      partyId: c.brokerId,
      partyName: null,
      refNo: c.chalanNo,
      date: c.chalanDate,
      type: "CHALAN",
      amount: p.balance,
      settled: p.settled,
      outstanding: p.outstanding,
    });
  }
  // owner side is payable only on MARKET (broker) vehicles — own/relative
  // vehicle slips are the fleet's own trips
  const marketSlips = slips.filter((s) => s.vehicleId && market.has(s.vehicleId));
  const slipPos = await payableSettlement(tx, {
    ...scope,
    refType: "BROKER_ENTRY",
    asOf,
    docs: marketSlips.map((s) => ({
      id: s.id,
      // live: owner net − owner advance, never the stored vBalance column
      balance: round2(toNum(String(s.vNetAmt)) - toNum(String(s.vAdvance))),
      ownPaid: ownBy(s.vPaymentDate, toNum(String(s.vPaidAmount))),
      ownShortage: ownBy(s.vPaymentDate, toNum(String(s.vShortage))),
      ownRoundOff: ownBy(s.vPaymentDate, toNum(String(s.vRoundOff))),
    })),
  });
  for (const s of marketSlips) {
    const p = slipPos.get(s.id);
    if (!p || p.outstanding <= 0.009) continue;
    out.push({
      partyId: s.ownerId,
      partyName: s.ownerName ?? null,
      refNo: s.slipNo,
      date: s.slipDate,
      type: "BROKER SLIP",
      amount: p.balance,
      settled: p.settled,
      outstanding: p.outstanding,
    });
  }
  const hirePos = await payableSettlement(tx, {
    ...scope,
    refType: "LORRY_HIRE",
    asOf,
    docs: hires.map((h) => ({
      id: h.id,
      // live: total hire − advance, never the stored balance column
      balance: round2(toNum(String(h.totalHire)) - toNum(String(h.advance))),
      ownPaid: 0,
      ownShortage: 0,
      ownRoundOff: 0,
    })),
  });
  for (const h of hires) {
    const p = hirePos.get(h.id);
    if (!p || p.outstanding <= 0.009) continue;
    out.push({
      partyId: null,
      partyName: h.ownerName || h.brokerName || "(hire slip)",
      refNo: h.slipNo,
      date: h.slipDate,
      type: "HIRE SLIP",
      amount: p.balance,
      settled: p.settled,
      outstanding: p.outstanding,
    });
  }

  // supplier bills on credit — office, vehicle and adblue purchases
  const pushRef = async (
    refType: "OFFICE_EXPENSE" | "VEHICLE_EXPENSE" | "ADBLUE_PURCHASE",
    type: string,
    docs: { id: string; partyId: string | null; refNo: string; date: Date; amount: number }[]
  ) => {
    const pos = await refPositions(tx, {
      ...scope,
      refType,
      asOf,
      docs: docs.map((d) => ({ id: d.id, original: d.amount })),
    });
    for (const d of docs) {
      const p = pos.get(d.id);
      if (!p || p.outstanding <= 0.009) continue;
      out.push({
        partyId: d.partyId,
        partyName: null,
        refNo: d.refNo,
        date: d.date,
        type,
        amount: p.original,
        settled: p.settled,
        outstanding: p.outstanding,
      });
    }
  };
  await pushRef(
    "OFFICE_EXPENSE",
    "OFFICE BILL",
    officeBills.map((t) => ({
      id: t.id,
      partyId: t.partyId,
      refNo: t.voucherNo,
      date: t.date,
      amount: toNum(String(t.amount)),
    }))
  );
  await pushRef(
    "VEHICLE_EXPENSE",
    "VEHICLE BILL",
    vehicleBills.map((v) => ({
      id: v.id,
      partyId: v.partyId,
      refNo: v.voucherNo,
      date: v.date,
      amount: toNum(String(v.amount)),
    }))
  );
  await pushRef(
    "ADBLUE_PURCHASE",
    "ADBLUE BILL",
    adblueBills.map((a) => ({
      id: a.id,
      partyId: a.supplierId,
      refNo: a.billNo ?? a.refNo ?? "ADBLUE",
      date: a.billDate ?? a.date,
      amount: toNum(String(a.amount)),
    }))
  );

  // staff salaries: net payable until marked paid / voucher-settled
  const monthEndOf = (month: string): Date => {
    const [y, m] = month.split("-").map(Number);
    return new Date(y, m, 0);
  };
  const salPos = await refPositions(tx, {
    ...scope,
    refType: "STAFF_PAYROLL",
    asOf,
    docs: salaries.map((s) => ({
      id: s.id,
      original: toNum(String(s.netSalary)),
      // the recorded amount, not the status flag — after an edit the two can
      // differ, and the flag would hide a genuinely open remainder
      ownSettled: ownBy(s.paymentDate, toNum(String(s.paidAmount))),
    })),
  });
  const staffParties = new Map(salaries.map((s) => [s.id, s.partyId]));
  for (const s of salaries) {
    const p = salPos.get(s.id);
    if (!p || p.outstanding <= 0.009) continue;
    out.push({
      partyId: staffParties.get(s.id) ?? null,
      partyName: null,
      refNo: `SAL-${s.month}`,
      date: monthEndOf(s.month),
      type: "STAFF SALARY",
      amount: p.original,
      settled: p.settled,
      outstanding: p.outstanding,
    });
  }

  // pending driver settlements the company owes
  const drvPos = await refPositions(tx, {
    ...scope,
    refType: "DRIVER_SETTLEMENT",
    asOf,
    docs: driverPay.map((s) => ({ id: s.id, original: toNum(String(s.amount)) })),
  });
  for (const s of driverPay) {
    if (asOf && s.status === "SETTLED" && s.settledDate && s.settledDate <= asOf) continue;
    const p = drvPos.get(s.id);
    if (!p || p.outstanding <= 0.009) continue;
    const drv = driverById.get(s.driverId);
    out.push({
      partyId: drv?.partyId ?? null,
      partyName: drv?.name ?? null,
      refNo: s.tripRef || s.voucherNo || "SETTLEMENT",
      date: s.date,
      type: "DRIVER SETTLEMENT",
      amount: p.original,
      settled: p.settled,
      outstanding: p.outstanding,
    });
  }

  // advances RECEIVED that nothing consumed — we owe them back to the party
  const advRecv = await tx.partyAdvance.findMany({
    where: { ...scope, deletedAt: null, kind: "RECEIVED" },
    include: { uses: { select: { date: true, amount: true } } },
  });
  for (const a of advRecv) {
    const consumed = consumedAsOf(a);
    const available = round2(toNum(String(a.amount)) - consumed);
    if (available <= 0.009) continue;
    out.push({
      partyId: a.partyId,
      partyName: null,
      refNo: a.voucherNo ?? "ADV",
      date: a.date,
      type: "ADVANCE (RECEIVED)",
      amount: round2(toNum(String(a.amount))),
      settled: consumed,
      outstanding: available,
    });
  }
  return out;
}

export async function getOutstandingAgeing(input: {
  side: OutSide;
  /** view another FY's AS-ON position — everything as it stood on 31 March */
  fyId?: string | null;
  /** custom "as on" date (yyyy-mm-dd) — beats the FY choice */
  asOf?: string | null;
}): Promise<{ ok: true; data: OutstandingData; fys: { id: string; label: string }[] } | { ok: false; error: string }> {
  const session = requireSession();
  try {
    // "As on" reporting: with an FY or a custom date picked, the WHOLE
    // position rewinds to that date — documents up to it, settlements up to
    // it, ageing buckets measured FROM it. A bill paid after the date shows
    // PENDING, exactly as it stood then. No selection → live as of today
    // (docs still bounded to the session FY's end — no forward leak).
    const scope = { firmId: session.firmId };
    const data = await withTenant(session.tenantId, async (tx) => {
      const fys = await tx.financialYear.findMany({
        where: { firmId: session.firmId },
        orderBy: { startDate: "desc" },
        select: { id: true, label: true, endDate: true },
      });
      // unknown fyId falls back to the SESSION year, never silently the newest
      const viewFy =
        fys.find((f) => f.id === (input.fyId || session.fyId)) ??
        fys.find((f) => f.id === session.fyId) ??
        fys[0];
      // validated here too — the action is callable directly, and a malformed
      // string would otherwise become Invalid Date and silently empty the report
      const asOfStr =
        input.asOf && /^\d{4}-\d{2}-\d{2}$/.test(input.asOf) ? input.asOf : null;
      // FY pick = the WHOLE of 31 March: seeded FYs stamp endDate at
      // midnight, which would drop that day's intraday settlements
      const fyEndFull = viewFy ? new Date(viewFy.endDate) : null;
      fyEndFull?.setHours(23, 59, 59, 999);
      const asOfDate = asOfStr
        ? new Date(asOfStr + "T23:59:59")
        : input.fyId && fyEndFull
          ? fyEndFull
          : null;
      const [collected, parties] = await Promise.all([
        collect(tx, scope, input.side, asOfDate),
        tx.party.findMany({ select: { id: true, name: true, mobile: true } }),
      ]);
      const bound = asOfDate ?? viewFy?.endDate ?? null;
      const docs = bound ? collected.filter((d) => d.date <= bound) : collected;
      const partyById = new Map(parties.map((p) => [p.id, p]));
      // ageing buckets measure from the AS-ON date, not today — the report
      // reads exactly as if it had been printed that day
      const now = (asOfDate ?? new Date()).getTime();

      const byParty = new Map<string, AgeingRow>();
      for (const d of docs) {
        const key = d.partyId ?? `name:${(d.partyName ?? "").toLowerCase()}`;
        const p = d.partyId ? partyById.get(d.partyId) : null;
        let row = byParty.get(key);
        if (!row) {
          row = {
            partyId: d.partyId,
            party: p?.name ?? d.partyName ?? "(unknown)",
            mobile: p?.mobile ?? null,
            b0: 0,
            b31: 0,
            b61: 0,
            b90: 0,
            total: 0,
            oldestDays: 0,
            docs: [],
          };
          byParty.set(key, row);
        }
        const days = Math.max(0, Math.floor((now - d.date.getTime()) / dayMs));
        if (days <= 30) row.b0 += d.outstanding;
        else if (days <= 60) row.b31 += d.outstanding;
        else if (days <= 90) row.b61 += d.outstanding;
        else row.b90 += d.outstanding;
        row.total += d.outstanding;
        row.oldestDays = Math.max(row.oldestDays, days);
        row.docs.push({
          refNo: d.refNo,
          date: d.date.toISOString(),
          type: d.type,
          amount: round2(d.amount),
          settled: round2(d.settled),
          outstanding: round2(d.outstanding),
          days,
        });
      }
      const rows = Array.from(byParty.values())
        .map((r) => ({
          ...r,
          b0: round2(r.b0),
          b31: round2(r.b31),
          b61: round2(r.b61),
          b90: round2(r.b90),
          total: round2(r.total),
          docs: r.docs.sort((a, b) => b.days - a.days),
        }))
        .sort((a, b) => b.total - a.total);
      const totals = {
        b0: round2(rows.reduce((s, r) => s + r.b0, 0)),
        b31: round2(rows.reduce((s, r) => s + r.b31, 0)),
        b61: round2(rows.reduce((s, r) => s + r.b61, 0)),
        b90: round2(rows.reduce((s, r) => s + r.b90, 0)),
        total: round2(rows.reduce((s, r) => s + r.total, 0)),
        parties: rows.length,
      };
      return { rows, totals, fys: fys.map((f) => ({ id: f.id, label: f.label })) };
    });
    const { fys, ...rest } = data;
    return { ok: true, data: rest, fys };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "Failed to load outstanding" };
  }
}
