import { Prisma } from "@prisma/client";
import { withTenant } from "@/lib/db";
import type { Session } from "@/lib/session";
import { toNum } from "@/lib/utils";
import { round2 } from "@/lib/calc/tds";

/**
 * Vehicle Expense Adjustment Report — READ-ONLY comparison of
 *
 *   DEDUCTED: expense-head advances deducted from a broker / owner on a chalan
 *             (ChalanAdvance with an expense head — diesel, tyre, repair, ...)
 *             or on the OWNER side of a broker slip (advances JSON, side "V",
 *             headKind EXPENSE)
 *   BOOKED:   the same heads booked in the Vehicle Expense Book
 *             (VehicleExpenseItem lines, head-split honoured)
 *
 * Difference = Deducted − Booked. Bank / cash advances and ADVANCE_ADJ rows
 * are money, not expense heads, so they are outside this report. Nothing is
 * posted or changed here.
 */

export interface AdjFilters {
  vehicleId?: string;
  brokerId?: string;
  headId?: string;
  dateFrom?: string; // yyyy-mm-dd
  dateTo?: string;
}

export interface AdjEntry {
  id: string;
  source: "CHALAN" | "BROKER_SLIP" | "EXPENSE";
  date: string;
  docNo: string;
  docDate: string;
  vehicleId: string;
  vehicleNo: string;
  brokerId: string;
  broker: string;
  headId: string;
  head: string;
  particular: string;
  amount: number;
  reference: string;
}

export interface AdjCell {
  deducted: number;
  booked: number;
  diff: number;
}

export interface AdjHeadRow extends AdjCell {
  headId: string;
  head: string;
  deductedEntries: AdjEntry[];
  bookedEntries: AdjEntry[];
}

export interface AdjVehicleNode extends AdjCell {
  vehicleId: string;
  vehicleNo: string;
  heads: AdjHeadRow[];
}

export interface AdjBrokerNode extends AdjCell {
  brokerId: string;
  broker: string;
  vehicles: AdjVehicleNode[];
}

export interface AdjResult {
  heads: AdjHeadRow[];
  brokers: AdjBrokerNode[];
  total: AdjCell;
}

const KEYWORDS: [string, string][] = [
  ["DIESEL", "diesel"],
  ["TOLL", "toll"],
  ["TYRE", "tyre"],
  ["SPARE_PARTS", "spare"],
  ["REPAIR", "repair"],
];

function dayRange(from?: string, to?: string): Prisma.DateTimeFilter | null {
  const f = from && /^\d{4}-\d{2}-\d{2}$/.test(from) ? new Date(`${from}T00:00:00+05:30`) : null;
  const t = to && /^\d{4}-\d{2}-\d{2}$/.test(to) ? new Date(`${to}T23:59:59.999+05:30`) : null;
  if (!f && !t) return null;
  return { ...(f ? { gte: f } : {}), ...(t ? { lte: t } : {}) };
}

function inRange(d: Date, r: Prisma.DateTimeFilter | null): boolean {
  if (!r) return true;
  if (r.gte instanceof Date && d < r.gte) return false;
  if (r.lte instanceof Date && d > r.lte) return false;
  return true;
}

export async function getAdjustmentReport(
  session: Session & { firmId: string; fyId: string },
  f: AdjFilters
): Promise<AdjResult> {
  return withTenant(session.tenantId, async (tx) => {
    const firmId = session.firmId;
    const range = dayRange(f.dateFrom, f.dateTo);

    const [heads, vehicles, parties] = await Promise.all([
      tx.accountHead.findMany({ select: { id: true, name: true, kind: true } }),
      tx.vehicle.findMany({ select: { id: true, number: true, ownerId: true } }),
      tx.party.findMany({ select: { id: true, name: true } }),
    ]);
    const headName = new Map(heads.map((h) => [h.id, h.name]));
    const vehicleNo = new Map(vehicles.map((v) => [v.id, v.number]));
    const vehicleOwner = new Map(vehicles.map((v) => [v.id, v.ownerId]));
    const partyName = new Map(parties.map((p) => [p.id, p.name]));
    // advance type → head, for legacy chalan advances saved without a head
    const headByKeyword = new Map<string, { id: string; name: string }>();
    for (const [type, kw] of KEYWORDS) {
      const h = heads.find((x) => x.kind === "EXPENSE" && x.name.toLowerCase().includes(kw));
      if (h) headByKeyword.set(type, h);
    }
    const resolveHead = (headId: string | null | undefined, type: string): { id: string; name: string } => {
      if (headId && headName.has(headId)) return { id: headId, name: headName.get(headId)! };
      const kw = headByKeyword.get(type);
      if (kw) return kw;
      return { id: `TYPE:${type}`, name: `${type.charAt(0)}${type.slice(1).toLowerCase().replace(/_/g, " ")} (no head)` };
    };

    const entries: AdjEntry[] = [];

    // ---------- DEDUCTED: chalan expense-head advances
    const chalans = await tx.chalan.findMany({
      where: {
        firmId,
        deletedAt: null,
        cancelledAt: null,
        ...(f.vehicleId ? { vehicleId: f.vehicleId } : {}),
        ...(f.brokerId ? { brokerId: f.brokerId } : {}),
        advances: { some: { type: { notIn: ["BANK", "CASH", "ADVANCE_ADJ"] } } },
      },
      select: {
        id: true,
        chalanNo: true,
        chalanDate: true,
        vehicleId: true,
        brokerId: true,
        advances: {
          where: { type: { notIn: ["BANK", "CASH", "ADVANCE_ADJ"] } },
          select: { id: true, type: true, headId: true, amount: true, date: true, supplierName: true, remarks: true, dieselQty: true, dieselRate: true },
        },
      },
    });
    for (const c of chalans) {
      for (const a of c.advances) {
        const amt = toNum(a.amount);
        if (amt <= 0) continue;
        const d = a.date ?? c.chalanDate;
        if (!inRange(d, range)) continue;
        const h = resolveHead(a.headId, a.type);
        if (f.headId && h.id !== f.headId) continue;
        const qty = a.dieselQty && toNum(a.dieselQty) > 0 ? ` ${toNum(a.dieselQty)} L${a.dieselRate ? ` @ ${toNum(a.dieselRate)}` : ""}` : "";
        entries.push({
          id: `CA:${a.id}`,
          source: "CHALAN",
          date: d.toISOString(),
          docNo: c.chalanNo,
          docDate: c.chalanDate.toISOString(),
          vehicleId: c.vehicleId,
          vehicleNo: vehicleNo.get(c.vehicleId) ?? "",
          brokerId: c.brokerId,
          broker: partyName.get(c.brokerId) ?? "",
          headId: h.id,
          head: h.name,
          particular: [`${a.type.replace(/_/g, " ")} advance${qty}`, a.supplierName, a.remarks].filter(Boolean).join(" — "),
          amount: amt,
          reference: `Chalan ${c.chalanNo}`,
        });
      }
    }

    // ---------- DEDUCTED: broker slip owner-side expense-head advances
    const slips = await tx.brokerSlip.findMany({
      where: {
        firmId,
        deletedAt: null,
        advances: { not: Prisma.DbNull },
        ...(f.vehicleId ? { vehicleId: f.vehicleId } : {}),
        ...(f.brokerId ? { transporterId: f.brokerId } : {}),
      },
      select: { id: true, slipNo: true, slipDate: true, vehicleId: true, transporterId: true, advances: true },
    });
    type SlipAdv = {
      side?: "P" | "V"; type?: string; headKind?: string | null; headId?: string | null;
      supplierName?: string | null; amount?: number; date?: string | null; remarks?: string | null;
      dieselQty?: number | null; dieselRate?: number | null;
    };
    for (const s of slips) {
      const advs: SlipAdv[] = Array.isArray(s.advances) ? (s.advances as SlipAdv[]) : [];
      advs.forEach((a, i) => {
        if (a.side !== "V") return;
        const type = a.type ?? "OTHER";
        if (type === "BANK" || type === "CASH" || type === "ADVANCE_ADJ") return;
        if (a.headKind === "BANK" || a.headKind === "CASH" || a.headKind === "INCOME") return;
        const amt = round2(toNum(a.amount ?? 0));
        if (amt <= 0) return;
        const d = a.date ? new Date(`${a.date}T00:00:00+05:30`) : s.slipDate;
        if (!inRange(d, range)) return;
        const h = resolveHead(a.headId, type);
        if (f.headId && h.id !== f.headId) return;
        const brokerId = s.transporterId ?? (s.vehicleId ? vehicleOwner.get(s.vehicleId) ?? "" : "");
        const qty = a.dieselQty && toNum(a.dieselQty) > 0 ? ` ${toNum(a.dieselQty)} L${a.dieselRate ? ` @ ${toNum(a.dieselRate)}` : ""}` : "";
        entries.push({
          id: `SA:${s.id}:${i}`,
          source: "BROKER_SLIP",
          date: d.toISOString(),
          docNo: s.slipNo,
          docDate: s.slipDate.toISOString(),
          vehicleId: s.vehicleId ?? "",
          vehicleNo: s.vehicleId ? vehicleNo.get(s.vehicleId) ?? "" : "",
          brokerId: brokerId ?? "",
          broker: brokerId ? partyName.get(brokerId) ?? "" : "",
          headId: h.id,
          head: h.name,
          particular: [`${type.replace(/_/g, " ")} advance${qty}`, a.supplierName, a.remarks].filter(Boolean).join(" — "),
          amount: amt,
          reference: `Broker Slip ${s.slipNo}`,
        });
      });
    }

    // ---------- BOOKED: vehicle expense book (allocated lines, head-split honoured)
    const items = await tx.vehicleExpenseItem.findMany({
      where: {
        ...(f.vehicleId ? { vehicleId: f.vehicleId } : {}),
        ...(range ? { allocDate: range } : {}),
        voucher: { firmId, deletedAt: null, txnType: "EXPENSE" },
      },
      select: {
        id: true,
        vehicleId: true,
        amount: true,
        allocDate: true,
        remarks: true,
        qty: true,
        voucher: {
          select: {
            id: true, voucherNo: true, date: true, headId: true, partyId: true, itemName: true, refNo: true, remarks: true, amount: true,
            lines: { select: { headId: true, amount: true, remarks: true } },
          },
        },
      },
    });
    for (const it of items) {
      const brokerId = vehicleOwner.get(it.vehicleId) ?? "";
      if (f.brokerId && brokerId !== f.brokerId) continue;
      const itemAmt = toNum(it.amount);
      if (itemAmt <= 0) continue;
      const v = it.voucher;
      // head-split: share this vehicle's allocation across the bill's head lines
      const lines = v.lines.filter((l) => toNum(l.amount) > 0);
      const lineTotal = lines.reduce((s, l) => s + toNum(l.amount), 0);
      const parts: { headId: string; amount: number; note: string }[] =
        lines.length && lineTotal > 0
          ? lines.map((l) => ({ headId: l.headId, amount: round2((itemAmt * toNum(l.amount)) / lineTotal), note: l.remarks ?? "" }))
          : [{ headId: v.headId, amount: itemAmt, note: "" }];
      for (const p of parts) {
        if (f.headId && p.headId !== f.headId) continue;
        entries.push({
          id: `VE:${it.id}:${p.headId}`,
          source: "EXPENSE",
          date: it.allocDate.toISOString(),
          docNo: v.voucherNo,
          docDate: v.date.toISOString(),
          vehicleId: it.vehicleId,
          vehicleNo: vehicleNo.get(it.vehicleId) ?? "",
          brokerId,
          broker: brokerId ? partyName.get(brokerId) ?? "" : "",
          headId: p.headId,
          head: headName.get(p.headId) ?? "",
          particular: [v.itemName, p.note || v.remarks, it.remarks, v.partyId ? partyName.get(v.partyId) : null, it.qty ? `qty ${toNum(it.qty)}` : null]
            .filter(Boolean)
            .join(" — "),
          amount: p.amount,
          reference: `${v.voucherNo}${v.refNo ? ` / ${v.refNo}` : ""}`,
        });
      }
    }

    // ---------- aggregate
    const cell = (list: AdjEntry[]): AdjCell => {
      const deducted = round2(list.filter((e) => e.source !== "EXPENSE").reduce((s, e) => s + e.amount, 0));
      const booked = round2(list.filter((e) => e.source === "EXPENSE").reduce((s, e) => s + e.amount, 0));
      return { deducted, booked, diff: round2(deducted - booked) };
    };
    const byDate = (a: AdjEntry, b: AdjEntry) => a.date.localeCompare(b.date);
    const headRows = (list: AdjEntry[]): AdjHeadRow[] => {
      const m = new Map<string, AdjEntry[]>();
      for (const e of list) m.set(e.headId, [...(m.get(e.headId) ?? []), e]);
      return Array.from(m.entries())
        .map(([headId, es]) => ({
          headId,
          head: es[0].head,
          ...cell(es),
          deductedEntries: es.filter((e) => e.source !== "EXPENSE").sort(byDate),
          bookedEntries: es.filter((e) => e.source === "EXPENSE").sort(byDate),
        }))
        .sort((a, b) => a.head.localeCompare(b.head));
    };

    const brokerMap = new Map<string, AdjEntry[]>();
    for (const e of entries) brokerMap.set(e.brokerId, [...(brokerMap.get(e.brokerId) ?? []), e]);
    const brokers: AdjBrokerNode[] = Array.from(brokerMap.entries())
      .map(([brokerId, es]) => {
        const vm = new Map<string, AdjEntry[]>();
        for (const e of es) vm.set(e.vehicleId, [...(vm.get(e.vehicleId) ?? []), e]);
        const vehiclesOut: AdjVehicleNode[] = Array.from(vm.entries())
          .map(([vehicleId, ves]) => ({
            vehicleId,
            vehicleNo: ves[0].vehicleNo || "(no vehicle)",
            ...cell(ves),
            heads: headRows(ves),
          }))
          .sort((a, b) => a.vehicleNo.localeCompare(b.vehicleNo));
        return { brokerId, broker: es[0].broker || "(no broker / owner)", ...cell(es), vehicles: vehiclesOut };
      })
      .sort((a, b) => a.broker.localeCompare(b.broker));

    return { heads: headRows(entries), brokers, total: cell(entries) };
  });
}
