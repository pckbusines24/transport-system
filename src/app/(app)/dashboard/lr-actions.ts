"use server";

import { requireSession } from "@/lib/session";
import { withTenant, type Tx } from "@/lib/db";
import { toNum } from "@/lib/utils";
import { round2 } from "@/lib/calc/tds";

/**
 * LR Summary drill-down: each dashboard card opens /dashboard/lr-detail with a
 * view; the grid always reflects the applied filters (summary included).
 *
 * POD received  = a POD entry exists for the LR (POD module)
 * On chalan     = the LR sits on an ACTIVE (non-cancelled) chalan
 * Billed        = the LR is on a live invoice
 */

import { LR_VIEW_META, type LrView } from "./lr-views";

export interface LrSummaryCard {
  view: LrView;
  count: number;
  amount: number | null; // null = amount not applicable on the card
}

export interface LrDetailFilters {
  from?: string;
  to?: string;
  partyId?: string;
  consignorId?: string;
  consigneeId?: string;
  vehicleId?: string;
  obd?: string;
  lrNo?: string;
  sourceCityId?: string;
  destCityId?: string;
}

export interface LrDetailRow {
  id: string;
  lrNo: string;
  lrDate: string;
  party: string;
  consignor: string;
  consignee: string;
  from: string;
  to: string;
  vehicle: string;
  obdNo: string;
  freight: number;
  chalanNo: string;
  billNo: string;
  podStatus: "RECEIVED" | "PENDING";
  billStatus: "BILLED" | "PENDING";
  status: string;
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const GRID_LIMIT = 500;

/** Pending-work views span every FY; the rest stay scoped to the session FY. */
const CROSS_FY_VIEWS: ReadonlySet<LrView> = new Set([
  "NO_CHALAN",
  "PENDING",
  "RECEIVED_UNBILLED",
  "UNBILLED",
] as LrView[]);

type Sets = { pod: Set<string>; chalan: Set<string>; billed: Set<string> };

const inView = (view: LrView, id: string, s: Sets): boolean => {
  switch (view) {
    case "TOTAL":
      return true;
    case "RECEIVED":
      return s.pod.has(id);
    case "PENDING":
      return !s.pod.has(id);
    case "NO_CHALAN":
      return !s.chalan.has(id);
    case "BILLED":
      return s.billed.has(id);
    case "RECEIVED_UNBILLED":
      return s.pod.has(id) && !s.billed.has(id);
    case "UNBILLED":
      return !s.billed.has(id);
  }
};

// firm-wide, never FY-scoped: a POD/chalan/bill made THIS year for an old
// LR must still mark that LR as done (FY continuity)
async function loadSets(tx: Tx, scope: { firmId: string }): Promise<Sets> {
  const [pods, chalanLrs, invoiceLrs] = await Promise.all([
    tx.pod.findMany({ where: { ...scope, lrId: { not: null } }, select: { lrId: true } }),
    tx.chalanLr.findMany({
      where: { chalan: { ...scope, deletedAt: null, cancelledAt: null } },
      select: { lrId: true },
    }),
    tx.invoiceLr.findMany({
      where: { invoice: { ...scope, deletedAt: null } },
      select: { lrId: true },
    }),
  ]);
  return {
    pod: new Set(pods.map((p) => p.lrId as string)),
    chalan: new Set(chalanLrs.map((c) => c.lrId)),
    billed: new Set(invoiceLrs.map((i) => i.lrId)),
  };
}

/** Counts + amounts for the seven dashboard cards. */
export async function getLrSummary(): Promise<
  { ok: true; cards: LrSummaryCard[] } | { ok: false; error: string }
> {
  const session = requireSession();
  try {
    const firmScope = { firmId: session.firmId };
    const cards = await withTenant(session.tenantId, async (tx) => {
      // FY continuity: "this year" cards (Total / Received / Billed) count the
      // session FY's LRs; PENDING cards (chalan-pending, POD-pending,
      // received-but-unbilled) count EVERY year's LRs — pending work never
      // disappears at the year change, it stays counted until done
      const lrWhere = {
        ...firmScope,
        deletedAt: null,
        lrType: { notIn: ["CANCELLED", "PAPER_CHANGE"] as ("CANCELLED" | "PAPER_CHANGE")[] },
      };
      // pending pools span earlier years but never LATER ones — a next-FY LR
      // must not appear in this year's summary (no forward leak)
      const fy = await tx.financialYear.findUnique({ where: { id: session.fyId } });
      const [lrsFy, lrsAll, sets] = await Promise.all([
        tx.lr.findMany({
          where: { ...lrWhere, fyId: session.fyId },
          select: { id: true, freight: true },
        }),
        tx.lr.findMany({
          where: { ...lrWhere, ...(fy ? { lrDate: { lte: fy.endDate } } : {}) },
          select: { id: true, freight: true },
        }),
        loadSets(tx, firmScope),
      ]);
      // card order fixed by the dashboard spec; UNBILLED has no card any more
      // (its detail view still answers if opened directly)
      const views: LrView[] = [
        "TOTAL",
        "NO_CHALAN",
        "PENDING",
        "RECEIVED",
        "BILLED",
        "RECEIVED_UNBILLED",
      ];
      return views.map((view) => {
        const pool = CROSS_FY_VIEWS.has(view) ? lrsAll : lrsFy;
        let count = 0;
        let amount = 0;
        for (const l of pool) {
          if (!inView(view, l.id, sets)) continue;
          count++;
          amount += toNum(String(l.freight));
        }
        // the chalan-pending card is a count card; amount is not applicable
        return { view, count, amount: view === "NO_CHALAN" ? null : round2(amount) };
      });
    });
    return { ok: true, cards };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "Failed to load LR summary" };
  }
}

/** Filtered grid + totals for one card's detail page. */
export async function getLrDetail(input: {
  view: LrView;
  filters: LrDetailFilters;
}): Promise<
  | {
      ok: true;
      rows: LrDetailRow[];
      totalCount: number;
      totalAmount: number;
      filteredCount: number;
      filteredAmount: number;
      truncated: boolean;
    }
  | { ok: false; error: string }
> {
  const session = requireSession();
  const { view, filters: f } = input;
  if (!LR_VIEW_META[view]) return { ok: false, error: "Unknown view" };
  try {
    // same rule as the cards: pending views span every FY, the rest stay
    // scoped to the session FY
    const scope = CROSS_FY_VIEWS.has(view)
      ? { firmId: session.firmId }
      : { firmId: session.firmId, fyId: session.fyId };
    const dateWhere =
      f.from && DATE_RE.test(f.from) && f.to && DATE_RE.test(f.to)
        ? {
            lrDate: {
              gte: new Date(`${f.from}T00:00:00`),
              lt: new Date(new Date(`${f.to}T00:00:00`).getTime() + 24 * 3600 * 1000),
            },
          }
        : {};
    return await withTenant(session.tenantId, async (tx) => {
      const sets = await loadSets(tx, { firmId: session.firmId });
      // no forward leak on cross-FY pending views: bound to this FY's end
      const fy = CROSS_FY_VIEWS.has(view)
        ? await tx.financialYear.findUnique({ where: { id: session.fyId } })
        : null;
      const fyBound = fy ? { lrDate: { lte: fy.endDate } } : {};
      // totals of the VIEW (before user filters) for the header
      // header totals follow the SAME bound rule as the grid: a user date
      // range beats the FY-end bound on both, so counts always agree
      const allOfView = await tx.lr.findMany({
        where: {
          ...scope,
          ...(Object.keys(dateWhere).length ? dateWhere : fyBound),
          deletedAt: null,
          lrType: { notIn: ["CANCELLED", "PAPER_CHANGE"] },
        },
        select: { id: true, freight: true },
      });
      let totalCount = 0;
      let totalAmount = 0;
      for (const l of allOfView) {
        if (!inView(view, l.id, sets)) continue;
        totalCount++;
        totalAmount += toNum(String(l.freight));
      }

      const lrs = await tx.lr.findMany({
        where: {
          ...scope,
          ...(Object.keys(dateWhere).length ? {} : fyBound),
          deletedAt: null,
          lrType: { notIn: ["CANCELLED", "PAPER_CHANGE"] },
          ...dateWhere,
          ...(f.partyId ? { billToId: f.partyId } : {}),
          ...(f.consignorId ? { consignorId: f.consignorId } : {}),
          ...(f.consigneeId ? { consigneeId: f.consigneeId } : {}),
          ...(f.vehicleId ? { vehicleId: f.vehicleId } : {}),
          ...(f.obd ? { obdNo: { contains: f.obd, mode: "insensitive" } } : {}),
          ...(f.lrNo ? { lrNo: { contains: f.lrNo, mode: "insensitive" } } : {}),
          ...(f.sourceCityId ? { sourceCityId: f.sourceCityId } : {}),
          ...(f.destCityId ? { destCityId: f.destCityId } : {}),
        },
        orderBy: [{ lrDate: "desc" }, { id: "desc" }],
        select: {
          id: true,
          lrNo: true,
          lrDate: true,
          billToId: true,
          consignorId: true,
          consigneeId: true,
          sourceCityId: true,
          destCityId: true,
          vehicleId: true,
          vehicleText: true,
          obdNo: true,
          freight: true,
          status: true,
        },
      });
      const matched = lrs.filter((l) => inView(view, l.id, sets));
      const filteredCount = matched.length;
      const filteredAmount = round2(matched.reduce((s, l) => s + toNum(String(l.freight)), 0));
      const page = matched.slice(0, GRID_LIMIT);

      const pageIds = page.map((l) => l.id);
      const [chalanRefs, invoiceRefs, parties, cities, vehicles] = await Promise.all([
        tx.chalanLr.findMany({
          where: { lrId: { in: pageIds }, chalan: { deletedAt: null, cancelledAt: null } },
          select: { lrId: true, chalan: { select: { chalanNo: true } } },
        }),
        tx.invoiceLr.findMany({
          where: { lrId: { in: pageIds }, invoice: { deletedAt: null } },
          select: { lrId: true, invoice: { select: { invoiceNo: true } } },
        }),
        tx.party.findMany({ select: { id: true, name: true } }),
        tx.city.findMany({ select: { id: true, name: true } }),
        tx.vehicle.findMany({ select: { id: true, number: true } }),
      ]);
      const chalanNoOf = new Map(chalanRefs.map((c) => [c.lrId, c.chalan.chalanNo]));
      const billNoOf = new Map(invoiceRefs.map((i) => [i.lrId, i.invoice.invoiceNo]));
      const partyName = new Map(parties.map((p) => [p.id, p.name]));
      const cityName = new Map(cities.map((c) => [c.id, c.name]));
      const vehicleNo = new Map(vehicles.map((v) => [v.id, v.number]));

      const rows: LrDetailRow[] = page.map((l) => ({
        id: l.id,
        lrNo: l.lrNo,
        lrDate: l.lrDate.toISOString(),
        party: l.billToId ? partyName.get(l.billToId) ?? "" : "",
        consignor: partyName.get(l.consignorId) ?? "",
        consignee: partyName.get(l.consigneeId) ?? "",
        from: cityName.get(l.sourceCityId) ?? "",
        to: cityName.get(l.destCityId) ?? "",
        vehicle: l.vehicleId ? vehicleNo.get(l.vehicleId) ?? "" : l.vehicleText ?? "",
        obdNo: l.obdNo ?? "",
        freight: round2(toNum(String(l.freight))),
        chalanNo: chalanNoOf.get(l.id) ?? "",
        billNo: billNoOf.get(l.id) ?? "",
        podStatus: sets.pod.has(l.id) ? "RECEIVED" : "PENDING",
        billStatus: sets.billed.has(l.id) ? "BILLED" : "PENDING",
        status: l.status,
      }));

      return {
        ok: true as const,
        rows,
        totalCount,
        totalAmount: round2(totalAmount),
        filteredCount,
        filteredAmount,
        truncated: matched.length > GRID_LIMIT,
      };
    });
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "Failed to load detail" };
  }
}
