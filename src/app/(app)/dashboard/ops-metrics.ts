import { requireSession } from "@/lib/session";
import { withTenant } from "@/lib/db";
import { syncDocumentStatusesThrottled } from "@/lib/document-status";
import { nextDueDate } from "@/lib/loan";

/**
 * Operational card metrics as DB aggregates. The old dashboard loaded every
 * LR, vehicle document, loan (with all EMI rows) and route row into Node and
 * counted in JS — linear in table size on every view. Counts and group-bys
 * keep the transferred data proportional to the number of *buckets* instead.
 */
export interface OpsMetrics {
  expiredCount: number;
  todayCount: number;
  upcomingCount: number;
  docTypeCounts: { name: string; count: number }[];
  docProblem: number;
  docExpired: number;
  emiActive: number;
  emiDue: number;
  laneAlive: number;
  laneCooling: number;
  laneSleeping: number;
  /** spare parts whose warranty expires within 30 days, not yet reviewed */
  warrantyDue: number;
  /** spare parts whose warranty has expired */
  warrantyExpired: number;
}

const H12 = 12 * 3600 * 1000;
const DAY = 24 * 3600 * 1000;

export async function getOpsMetrics(todayCal: string): Promise<OpsMetrics> {
  const session = requireSession();
  // calDate(d) = UTC date of (d + 12h), so bucket c === X  ⇔  d ∈ [X−12h, X+12h)
  const t = new Date(`${todayCal}T00:00:00Z`).getTime();
  const ewayWhere = {
    // expiry-date driven, not FY-scoped: a 30/31 March e-way must still
    // alert in April (FY continuity)
    firmId: session.firmId,
    deletedAt: null,
    ewayBillNo: { not: null },
  };

  return withTenant(session.tenantId, async (tx) => {
    // DONE → PENDING flip so a document entering its window shows as pending
    // everywhere — throttled: windows only move at day granularity
    await syncDocumentStatusesThrottled(tx, session.tenantId);

    const [expiredCount, todayCount, upcomingCount, docTypes, loans, lrLanes, slipRows, chalanRows, brokerVehicles] =
      await Promise.all([
        // c ∈ {today−2, today−1}
        tx.lr.count({
          where: { ...ewayWhere, ewayExpiry: { gte: new Date(t - 2 * DAY - H12), lt: new Date(t - H12) } },
        }),
        // c === today
        tx.lr.count({
          where: { ...ewayWhere, ewayExpiry: { gte: new Date(t - H12), lt: new Date(t + H12) } },
        }),
        // c ∈ {today+1, today+2}
        tx.lr.count({
          where: { ...ewayWhere, ewayExpiry: { gte: new Date(t + H12), lt: new Date(t + 2 * DAY + H12) } },
        }),
        tx.documentType.findMany({
          where: { showReminder: true },
          select: { id: true, name: true, reminderDays: true },
        }),
        // loans are lifetime — an old-year loan's EMI stays due (FY continuity).
        // Universe matches the /emi-due page exactly: ACTIVE + outstanding +
        // an EMI amount or a schedule — never the emiApplicable flag alone.
        tx.loan.findMany({
          where: { firmId: session.firmId, deletedAt: null, status: "ACTIVE" },
          select: { id: true, amount: true, emiAmount: true, emiStartDate: true, emiFrequency: true },
        }),
        // route heartbeat continues across FYs — a lane's history does not
        // reset on 1 April. Same universe as /routes: LR + slip party trips,
        // slip vehicle side and market-chalan trips.
        tx.lr.groupBy({
          by: ["sourceCityId", "destCityId"],
          where: {
            firmId: session.firmId,
            deletedAt: null,
            lrType: { notIn: ["CANCELLED", "PAPER_CHANGE"] },
          },
          _count: { _all: true },
          _max: { lrDate: true },
        }),
        tx.brokerSlip.findMany({
          where: { firmId: session.firmId, deletedAt: null },
          select: { loadStationId: true, destCityId: true, slipDate: true, vChalanAmt: true },
        }),
        tx.chalan.findMany({
          where: { firmId: session.firmId, deletedAt: null, cancelledAt: null, freight: { gt: 0 } },
          select: {
            chalanDate: true,
            vehicleId: true,
            lrs: { select: { lr: { select: { sourceCityId: true, destCityId: true } } }, take: 1 },
          },
        }),
        tx.vehicle.findMany({
          where: { ownershipType: "BROKER" },
          select: { id: true },
        }),
      ]);

    const now = new Date();

    // documents: each type has its own reminder window — fetch only documents
    // inside the WIDEST window (nothing outside it can match any type)
    const daysByType = new Map(docTypes.map((d) => [d.id, d.reminderDays ?? 30]));
    const maxDays = docTypes.length ? Math.max(...Array.from(daysByType.values())) : 0;
    const maxWindowEnd = new Date(now);
    maxWindowEnd.setDate(maxWindowEnd.getDate() + maxDays);

    const [docs, emiSums] = await Promise.all([
      docTypes.length
        ? tx.vehicleDocument.findMany({
            where: {
              expiryDate: { not: null, lte: maxWindowEnd },
              docTypeId: { in: docTypes.map((d) => d.id) },
            },
            select: { status: true, expiryDate: true, docTypeId: true },
          })
        : Promise.resolve([]),
      loans.length
        ? tx.loanEmi.groupBy({
            by: ["loanId"],
            where: { loanId: { in: loans.map((l) => l.id) }, deletedAt: null },
            _sum: { principal: true },
            _count: { _all: true },
          })
        : Promise.resolve([]),
    ]);

    const nameByType = new Map(docTypes.map((d) => [d.id, d.name]));
    const typeCounts = new Map<string, number>();
    let docProblem = 0;
    let docExpired = 0;
    for (const d of docs) {
      if (!d.expiryDate) continue;
      const windowEnd = new Date(now);
      windowEnd.setDate(windowEnd.getDate() + (daysByType.get(d.docTypeId) ?? 30));
      if (d.expiryDate > windowEnd) continue;
      const name = nameByType.get(d.docTypeId) ?? "?";
      typeCounts.set(name, (typeCounts.get(name) ?? 0) + 1);
      if (d.status === "PROBLEM") docProblem++;
      // expiry already passed — the loudest state of all
      if (d.expiryDate < now) docExpired++;
    }
    const docTypeCounts = Array.from(typeCounts.entries())
      .map(([name, count]) => ({ name, count }))
      .sort((a, b) => b.count - a.count);

    // EMI due: active EMI loans; due/overdue = next scheduled date has arrived
    const emiByLoan = new Map(emiSums.map((e) => [e.loanId, e]));
    let emiActive = 0;
    let emiDue = 0;
    for (const l of loans) {
      const agg = emiByLoan.get(l.id);
      const repaid = Number(agg?._sum.principal ?? 0);
      if (Number(l.amount) - repaid <= 0.009) continue;
      const due = nextDueDate(l.emiStartDate, l.emiFrequency, agg?._count._all ?? 0);
      // same gate as /emi-due: an EMI amount or a schedule must exist
      if (!(Number(l.emiAmount) > 0 || due)) continue;
      emiActive++;
      if (due && due <= now) emiDue++;
    }

    // route heartbeat: EXACTLY the /routes rules — party trips (LRs + slip
    // party side) and vehicle trips (slip owner side + market chalans) count
    // separately; a lane is OCCASIONAL (skipped) unless max(party, vehicle)
    // >= 3; sleeping > 20 days, cooling 8-20
    const lanes = new Map<string, { party: number; vehicle: number; last: Date }>();
    const laneOf = (a: string | null, b: string | null) => (a && b ? `${a}|${b}` : null);
    const bump = (
      key: string | null,
      side: "party" | "vehicle",
      count: number,
      last: Date | null
    ) => {
      if (!key || !last || count <= 0) return;
      const cur = lanes.get(key) ?? { party: 0, vehicle: 0, last };
      cur[side] += count;
      if (last > cur.last) cur.last = last;
      lanes.set(key, cur);
    };
    for (const r of lrLanes)
      bump(laneOf(r.sourceCityId, r.destCityId), "party", r._count._all, r._max.lrDate);
    for (const s of slipRows) {
      const key = laneOf(s.loadStationId, s.destCityId);
      bump(key, "party", 1, s.slipDate);
      if (Number(s.vChalanAmt) > 0) bump(key, "vehicle", 1, s.slipDate);
    }
    const marketVehicle = new Set(brokerVehicles.map((v) => v.id));
    for (const c of chalanRows) {
      if (!marketVehicle.has(c.vehicleId)) continue;
      const first = c.lrs[0]?.lr;
      bump(first ? laneOf(first.sourceCityId, first.destCityId) : null, "vehicle", 1, c.chalanDate);
    }
    let laneAlive = 0;
    let laneCooling = 0;
    let laneSleeping = 0;
    for (const v of Array.from(lanes.values())) {
      if (Math.max(v.party, v.vehicle) < 3) continue;
      const days = Math.floor((now.getTime() - v.last.getTime()) / 86400000);
      if (days <= 7) laneAlive++;
      else if (days <= 20) laneCooling++;
      else laneSleeping++;
    }

    // spare-part warranty alerts (operational module — no accounting link):
    // due = expiring within the next 30 days and not marked reviewed
    const [warrantyDue, warrantyExpired] = await Promise.all([
      tx.sparePart.count({
        where: {
          firmId: session.firmId,
          deletedAt: null,
          warrantyApplicable: true,
          warrantyReviewedAt: null,
          warrantyExpiryDate: { gte: new Date(t - H12), lt: new Date(t + 30 * DAY + H12) },
        },
      }),
      tx.sparePart.count({
        where: {
          firmId: session.firmId,
          deletedAt: null,
          warrantyApplicable: true,
          warrantyExpiryDate: { lt: new Date(t - H12) },
        },
      }),
    ]);

    return {
      expiredCount, todayCount, upcomingCount, docTypeCounts, docProblem, docExpired,
      emiActive, emiDue, laneAlive, laneCooling, laneSleeping, warrantyDue, warrantyExpired,
    };
  });
}
