import { Prisma } from "@prisma/client";
import { withTenant } from "@/lib/db";
import type { Session } from "@/lib/session";
import { toNum } from "@/lib/utils";
import { round2 } from "@/lib/calc/tds";

/**
 * Vehicle Expense Adjustment Report — READ-ONLY, BROKER vehicles only
 * (Vehicle Master → Ownership = Broker). Owner Name is the vehicle master's
 * owner party, blank when the master has none — never a slip-side name.
 *
 *   DEDUCTED: expense-head advances taken from the owner / broker
 *             - on a chalan (ChalanAdvance: diesel, tyre, toll, other…)
 *               CANCELLED chalans are KEPT — the original entry stays in the
 *               report, flagged "Cancelled"; nothing is reversed or moved
 *             - on the OWNER side of a broker slip (advances JSON, side "V")
 *   BOOKED:   actual vehicle expense against the vehicle
 *             - Vehicle Expense Book lines (head-split honoured)
 *             - PARTY side of a broker slip: expense the party gave for the
 *               broker's vehicle (advances JSON, side "P", expense head)
 *
 * Bank / cash advances and ADVANCE_ADJ rows are money, not expense, and are
 * excluded on both sides. Adjustment = Deducted − Booked. Nothing is posted.
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
  kind: "DEDUCTED" | "BOOKED";
  source: "Chalan" | "Broker Slip – Owner Side" | "Vehicle Expense" | "Broker Slip – Party Paid";
  date: string;
  docNo: string;
  docDate: string;
  vehicleId: string;
  vehicleNo: string;
  headId: string;
  head: string;
  particular: string;
  amount: number;
  /** "Cancelled" for a cancelled chalan — amount is retained */
  status: string;
}

export interface AdjVehicleRow {
  vehicleId: string;
  vehicleNo: string;
  owner: string;
  deducted: number;
  booked: number;
  diff: number;
  entries: AdjEntry[];
}

export interface AdjResult {
  vehicles: AdjVehicleRow[];
  total: { deducted: number; booked: number; diff: number };
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

type SlipAdv = {
  side?: "P" | "V";
  type?: string;
  headKind?: string | null;
  headId?: string | null;
  supplierName?: string | null;
  amount?: number;
  date?: string | null;
  remarks?: string | null;
  dieselQty?: number | null;
  dieselRate?: number | null;
};

export async function getAdjustmentReport(
  session: Session & { firmId: string; fyId: string },
  f: AdjFilters
): Promise<AdjResult> {
  return withTenant(session.tenantId, async (tx) => {
    const firmId = session.firmId;
    const range = dayRange(f.dateFrom, f.dateTo);

    const [heads, vehicles, parties] = await Promise.all([
      tx.accountHead.findMany({ select: { id: true, name: true, kind: true } }),
      // ONLY broker-owned vehicles from the Vehicle Master
      tx.vehicle.findMany({
        where: {
          ownershipType: "BROKER",
          ...(f.vehicleId ? { id: f.vehicleId } : {}),
          ...(f.brokerId ? { ownerId: f.brokerId } : {}),
        },
        select: { id: true, number: true, ownerId: true },
        orderBy: { number: "asc" },
      }),
      tx.party.findMany({ select: { id: true, name: true } }),
    ]);
    const headName = new Map(heads.map((h) => [h.id, h.name]));
    const partyName = new Map(parties.map((p) => [p.id, p.name]));
    const vehicleById = new Map(vehicles.map((v) => [v.id, v]));
    const vehicleIds = vehicles.map((v) => v.id);
    if (!vehicleIds.length) return { vehicles: [], total: { deducted: 0, booked: 0, diff: 0 } };

    // advance type → head, for legacy advances saved without a head
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
    const isMoney = (type: string, headKind?: string | null) =>
      type === "BANK" || type === "CASH" || type === "ADVANCE_ADJ" || headKind === "BANK" || headKind === "CASH" || headKind === "INCOME";
    const qtyText = (q?: unknown, r?: unknown) =>
      q && toNum(q) > 0 ? ` ${toNum(q)} L${r && toNum(r) > 0 ? ` @ ${toNum(r)}` : ""}` : "";

    const entries: AdjEntry[] = [];

    // ---------- DEDUCTED: chalan advances (cancelled chalans RETAINED, flagged)
    const chalans = await tx.chalan.findMany({
      where: {
        firmId,
        deletedAt: null,
        vehicleId: { in: vehicleIds },
        advances: { some: { type: { notIn: ["BANK", "CASH", "ADVANCE_ADJ"] } } },
      },
      select: {
        id: true,
        chalanNo: true,
        chalanDate: true,
        vehicleId: true,
        cancelledAt: true,
        advances: {
          where: { type: { notIn: ["BANK", "CASH", "ADVANCE_ADJ"] } },
          select: { id: true, type: true, headId: true, amount: true, date: true, supplierName: true, remarks: true, dieselQty: true, dieselRate: true },
        },
      },
    });
    for (const c of chalans) {
      const v = vehicleById.get(c.vehicleId);
      if (!v) continue;
      for (const a of c.advances) {
        const amt = toNum(a.amount);
        if (amt <= 0) continue;
        const d = a.date ?? c.chalanDate;
        if (!inRange(d, range)) continue;
        const h = resolveHead(a.headId, a.type);
        if (f.headId && h.id !== f.headId) continue;
        entries.push({
          id: `CA:${a.id}`,
          kind: "DEDUCTED",
          source: "Chalan",
          date: d.toISOString(),
          docNo: c.chalanNo,
          docDate: c.chalanDate.toISOString(),
          vehicleId: v.id,
          vehicleNo: v.number,
          headId: h.id,
          head: h.name,
          particular: [`${a.type.replace(/_/g, " ")} advance${qtyText(a.dieselQty, a.dieselRate)}`, a.supplierName, a.remarks].filter(Boolean).join(" — "),
          amount: amt,
          status: c.cancelledAt ? "Cancelled" : "Active",
        });
      }
    }

    // ---------- broker slips: owner side = DEDUCTED, party side = BOOKED (party paid)
    const slips = await tx.brokerSlip.findMany({
      where: { firmId, deletedAt: null, vehicleId: { in: vehicleIds }, advances: { not: Prisma.DbNull } },
      select: { id: true, slipNo: true, slipDate: true, vehicleId: true, advances: true },
    });
    for (const s of slips) {
      const v = s.vehicleId ? vehicleById.get(s.vehicleId) : null;
      if (!v) continue;
      const advs: SlipAdv[] = Array.isArray(s.advances) ? (s.advances as SlipAdv[]) : [];
      advs.forEach((a, i) => {
        const type = a.type ?? "OTHER";
        if (isMoney(type, a.headKind)) return;
        if (a.side !== "V" && a.side !== "P") return;
        const amt = round2(toNum(a.amount ?? 0));
        if (amt <= 0) return;
        const d = a.date ? new Date(`${a.date}T00:00:00+05:30`) : s.slipDate;
        if (!inRange(d, range)) return;
        const h = resolveHead(a.headId, type);
        if (f.headId && h.id !== f.headId) return;
        const owner = a.side === "V";
        entries.push({
          id: `SA:${s.id}:${i}`,
          kind: owner ? "DEDUCTED" : "BOOKED",
          source: owner ? "Broker Slip – Owner Side" : "Broker Slip – Party Paid",
          date: d.toISOString(),
          docNo: s.slipNo,
          docDate: s.slipDate.toISOString(),
          vehicleId: v.id,
          vehicleNo: v.number,
          headId: h.id,
          head: h.name,
          particular: [`${type.replace(/_/g, " ")}${owner ? " advance" : " given by party"}${qtyText(a.dieselQty, a.dieselRate)}`, a.supplierName, a.remarks]
            .filter(Boolean)
            .join(" — "),
          amount: amt,
          status: "Active",
        });
      });
    }

    // ---------- BOOKED: vehicle expense book (allocated lines, head-split honoured)
    const items = await tx.vehicleExpenseItem.findMany({
      where: {
        vehicleId: { in: vehicleIds },
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
            voucherNo: true, date: true, headId: true, partyId: true, itemName: true, refNo: true, remarks: true,
            lines: { select: { headId: true, amount: true, remarks: true } },
          },
        },
      },
    });
    for (const it of items) {
      const v = vehicleById.get(it.vehicleId);
      if (!v) continue;
      const itemAmt = toNum(it.amount);
      if (itemAmt <= 0) continue;
      const vo = it.voucher;
      const lines = vo.lines.filter((l) => toNum(l.amount) > 0);
      const lineTotal = lines.reduce((s, l) => s + toNum(l.amount), 0);
      const parts =
        lines.length && lineTotal > 0
          ? lines.map((l) => ({ headId: l.headId, amount: round2((itemAmt * toNum(l.amount)) / lineTotal), note: l.remarks ?? "" }))
          : [{ headId: vo.headId, amount: itemAmt, note: "" }];
      for (const p of parts) {
        if (f.headId && p.headId !== f.headId) continue;
        entries.push({
          id: `VE:${it.id}:${p.headId}`,
          kind: "BOOKED",
          source: "Vehicle Expense",
          date: it.allocDate.toISOString(),
          docNo: `${vo.voucherNo}${vo.refNo ? ` / ${vo.refNo}` : ""}`,
          docDate: vo.date.toISOString(),
          vehicleId: v.id,
          vehicleNo: v.number,
          headId: p.headId,
          head: headName.get(p.headId) ?? "",
          particular: [vo.itemName, p.note || vo.remarks, it.remarks, vo.partyId ? partyName.get(vo.partyId) : null, it.qty ? `qty ${toNum(it.qty)}` : null]
            .filter(Boolean)
            .join(" — "),
          amount: p.amount,
          status: "Active",
        });
      }
    }

    // ---------- vehicle-wise rows (every broker vehicle with activity)
    const byVehicle = new Map<string, AdjEntry[]>();
    for (const e of entries) byVehicle.set(e.vehicleId, [...(byVehicle.get(e.vehicleId) ?? []), e]);
    const rows: AdjVehicleRow[] = vehicles
      .filter((v) => byVehicle.has(v.id))
      .map((v) => {
        const es = (byVehicle.get(v.id) ?? []).sort((a, b) => a.date.localeCompare(b.date));
        const deducted = round2(es.filter((e) => e.kind === "DEDUCTED").reduce((s, e) => s + e.amount, 0));
        const booked = round2(es.filter((e) => e.kind === "BOOKED").reduce((s, e) => s + e.amount, 0));
        return {
          vehicleId: v.id,
          vehicleNo: v.number,
          owner: v.ownerId ? partyName.get(v.ownerId) ?? "" : "",
          deducted,
          booked,
          diff: round2(deducted - booked),
          entries: es,
        };
      });
    const deducted = round2(rows.reduce((s, r) => s + r.deducted, 0));
    const booked = round2(rows.reduce((s, r) => s + r.booked, 0));
    return { vehicles: rows, total: { deducted, booked, diff: round2(deducted - booked) } };
  });
}
