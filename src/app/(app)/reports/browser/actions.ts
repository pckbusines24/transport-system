"use server";

import { requireSession } from "@/lib/session";
import { withTenant, type Tx } from "@/lib/db";
import { authorize } from "@/lib/authz";
import { round2 } from "@/lib/calc/tds";
import { toNum } from "@/lib/utils";
import { invoiceSettlement, payableSettlement } from "@/lib/settlement";
import { COMMON_HEADS } from "@/lib/account-heads";

/**
 * Month Browser — one endless, month-tabbed window over every register.
 * The client asks for a source + month + filters + cursor; the server returns
 * one page of rows in a generic {columns, cells} shape so a single UI renders
 * every register. Running-balance sources (books / ledgers) thread the balance
 * through `runningStart`/`runningEnd` so scrolling stays O(page).
 */

export type BrowseSrc =
  | "LR"
  | "CHALAN_MARKET"
  | "CHALAN_OWNREL"
  | "POD"
  | "BROKER"
  | "BILLING"
  | "OUT_RECV"
  | "OUT_PAY"
  | "VOUCHER"
  | "BOOK_BANK"
  | "BOOK_CASH"
  | "BOOK_CARD"
  | "LEDGER"
  | "COMMON"
  | "TDS_PAY"
  | "TDS_RECV";

export interface BrowseInput {
  src: BrowseSrc;
  /** "ALL" or "yyyy-mm" */
  month: string;
  q?: string | null;
  partyId?: string | null;
  vehicleId?: string | null;
  /** COMMON: head name filter */
  head?: string | null;
  /** LR: OBD number filter */
  obd?: string | null;
  cursor?: number;
  /** running balance carried across pages (books / ledger) */
  runningStart?: number | null;
  /** browse another financial year without switching the session FY */
  fyId?: string | null;
}

export interface BrowseRow {
  id: string;
  href?: string | null;
  cells: (string | number | null)[];
}

export interface BrowseResult {
  columns: { label: string; numeric?: boolean }[];
  rows: BrowseRow[];
  nextCursor: number | null;
  totals: { label: string; value: number }[];
  runningEnd?: number | null;
}

const PAGE = 100;

function monthRange(month: string): { gte: Date; lt: Date } | null {
  if (!/^\d{4}-\d{2}$/.test(month)) return null;
  const gte = new Date(`${month}-01T00:00:00`);
  const lt = new Date(gte);
  lt.setMonth(lt.getMonth() + 1);
  return { gte, lt };
}

function dateFilter(field: string, month: string): Record<string, unknown> {
  const r = monthRange(month);
  return r ? { [field]: { gte: r.gte, lt: r.lt } } : {};
}

const fmtDate = (d: Date) =>
  `${String(d.getDate()).padStart(2, "0")}/${String(d.getMonth() + 1).padStart(2, "0")}/${d.getFullYear()}`;

async function nameMaps(tx: Tx, opts: { partyIds?: string[]; vehicleIds?: string[]; cityIds?: string[]; headIds?: string[] }) {
  const uniq = (a?: (string | null | undefined)[]) => Array.from(new Set((a ?? []).filter(Boolean))) as string[];
  const [parties, vehicles, cities, heads] = await Promise.all([
    uniq(opts.partyIds).length
      ? tx.party.findMany({ where: { id: { in: uniq(opts.partyIds) } }, select: { id: true, name: true } })
      : [],
    uniq(opts.vehicleIds).length
      ? tx.vehicle.findMany({ where: { id: { in: uniq(opts.vehicleIds) } }, select: { id: true, number: true } })
      : [],
    uniq(opts.cityIds).length
      ? tx.city.findMany({ where: { id: { in: uniq(opts.cityIds) } }, select: { id: true, name: true } })
      : [],
    uniq(opts.headIds).length
      ? tx.accountHead.findMany({ where: { id: { in: uniq(opts.headIds) } }, select: { id: true, name: true } })
      : [],
  ]);
  return {
    party: new Map(parties.map((p) => [p.id, p.name])),
    vehicle: new Map(vehicles.map((v) => [v.id, v.number])),
    city: new Map(cities.map((c) => [c.id, c.name])),
    head: new Map(heads.map((h) => [h.id, h.name])),
  };
}

export async function fetchBrowse(input: BrowseInput): Promise<BrowseResult> {
  const session = requireSession();
  await authorize(session, "reports", "view");
  const cursor = input.cursor ?? 0;
  const q = input.q?.trim() || null;

  return withTenant(session.tenantId, async (tx): Promise<BrowseResult> => {
    // FY continuity: the browser can read ANY of the firm's financial years —
    // the in-report FY dropdown sends the chosen fyId (validated here);
    // default stays the session FY
    const chosenFy =
      input.fyId && input.fyId !== session.fyId
        ? await tx.financialYear.findFirst({
            where: { id: input.fyId, firmId: session.firmId },
            select: { id: true },
          })
        : null;
    const fyId = chosenFy?.id ?? session.fyId;
    const scope = { firmId: session.firmId, fyId };

    // ---------------------------------------------------------------- LR
    if (input.src === "LR") {
      const obd = input.obd?.trim() || null;
      const where = {
        ...scope,
        deletedAt: null,
        // cancelled / paper-change LRs are not operational — the LR register
        // excludes them, so the browser's list and totals must too
        lrType: { notIn: ["CANCELLED" as const, "PAPER_CHANGE" as const] },
        ...dateFilter("lrDate", input.month),
        ...(q ? { lrNo: { contains: q, mode: "insensitive" as const } } : {}),
        ...(obd ? { obdNo: { contains: obd, mode: "insensitive" as const } } : {}),
        ...(input.partyId
          ? { OR: [{ consignorId: input.partyId }, { consigneeId: input.partyId }, { billToId: input.partyId }] }
          : {}),
        ...(input.vehicleId ? { vehicleId: input.vehicleId } : {}),
      };
      const [rows, count, sums, wtSums] = await Promise.all([
        tx.lr.findMany({
          where,
          include: { items: { select: { chargeWt: true, actualWt: true, rate: true } } },
          orderBy: [{ lrDate: "desc" }, { lrNo: "desc" }],
          skip: cursor,
          take: PAGE,
        }),
        tx.lr.count({ where }),
        tx.lr.aggregate({ where, _sum: { grandTotal: true } }),
        // weights live on the LR items — totals follow the SAME filter
        tx.lrItem.aggregate({ where: { lr: where }, _sum: { actualWt: true, chargeWt: true } }),
      ]);
      const maps = await nameMaps(tx, {
        partyIds: rows.flatMap((r) => [r.consignorId, r.consigneeId]),
        vehicleIds: rows.map((r) => r.vehicleId ?? ""),
        cityIds: rows.flatMap((r) => [r.sourceCityId, r.destCityId]),
      });
      return {
        columns: [
          { label: "LR No" },
          { label: "Date" },
          { label: "From" },
          { label: "To" },
          { label: "Consignor" },
          { label: "Consignee" },
          { label: "OBD No" },
          { label: "Vehicle No" },
          { label: "Actual Wt", numeric: true },
          { label: "Charge Wt", numeric: true },
          { label: "Rate", numeric: true },
          { label: "Freight", numeric: true },
        ],
        rows: rows.map((r) => ({
          id: r.id,
          href: `/lr?id=${r.id}`,
          cells: [
            r.lrNo,
            fmtDate(r.lrDate),
            maps.city.get(r.sourceCityId) ?? "",
            maps.city.get(r.destCityId) ?? "",
            maps.party.get(r.consignorId) ?? "",
            maps.party.get(r.consigneeId) ?? "",
            r.obdNo ?? "",
            r.vehicleId ? maps.vehicle.get(r.vehicleId) ?? "" : r.vehicleText ?? "",
            round2(r.items.reduce((s, it) => s + toNum(it.actualWt), 0)),
            round2(r.items.reduce((s, it) => s + toNum(it.chargeWt), 0)),
            r.items.length ? Math.max(...r.items.map((it) => toNum(it.rate))) : null,
            toNum(r.grandTotal),
          ],
        })),
        nextCursor: cursor + rows.length < count ? cursor + rows.length : null,
        totals: [
          { label: "LRs", value: count },
          { label: "Actual Wt", value: toNum(wtSums._sum?.actualWt ?? 0) },
          { label: "Charge Wt", value: toNum(wtSums._sum?.chargeWt ?? 0) },
          { label: "Freight Total", value: toNum(sums._sum?.grandTotal ?? 0) },
        ],
      };
    }

    // ---------------------------------------------------------------- CHALAN
    if (input.src === "CHALAN_MARKET" || input.src === "CHALAN_OWNREL") {
      const allowed = input.src === "CHALAN_MARKET" ? ["BROKER"] : ["OWNER", "RELATIVE"];
      const vehicles = await tx.vehicle.findMany({ where: { ownershipType: { in: allowed } }, select: { id: true, number: true } });
      const vehicleIds = vehicles.map((v) => v.id);
      const where = {
        ...scope,
        deletedAt: null,
        // cancelled chalans live in the Cancel Register — the browser's list
        // AND its totals (count / freight / advance) count active ones only
        cancelledAt: null,
        ...dateFilter("chalanDate", input.month),
        ...(q ? { chalanNo: { contains: q, mode: "insensitive" as const } } : {}),
        ...(input.partyId ? { brokerId: input.partyId } : {}),
        // intersect the picked vehicle with the ownership class: a vehicle
        // outside the class yields zero rows, never the whole class
        vehicleId: input.vehicleId
          ? { in: vehicleIds.includes(input.vehicleId) ? [input.vehicleId] : [] }
          : { in: vehicleIds },
      };
      const [rows, count, sums] = await Promise.all([
        tx.chalan.findMany({ where, orderBy: [{ chalanDate: "desc" }, { id: "desc" }], skip: cursor, take: PAGE }),
        tx.chalan.count({ where }),
        tx.chalan.aggregate({ where, _sum: { freight: true, advanceTotal: true } }),
      ]);
      const payable = await payableSettlement(tx, {
        ...scope,
        refType: "FREIGHT_CHALLAN",
        docs: rows.map((c) => ({
          id: c.id,
          balance: toNum(c.balance),
          ownPaid: toNum(c.balPaidAmount),
          ownShortage: toNum(c.balShortage),
          ownRoundOff: toNum(c.balRoundOff),
          ownAdvanceAdjusted: toNum(c.balAdvanceAdjusted),
        })),
      });
      const maps = await nameMaps(tx, { partyIds: rows.map((r) => r.brokerId) });
      const vname = new Map(vehicles.map((v) => [v.id, v.number]));
      return {
        columns: [
          { label: "Chalan No" },
          { label: "Date" },
          { label: input.src === "CHALAN_MARKET" ? "Broker" : "Owner" },
          { label: "Vehicle" },
          { label: "Freight", numeric: true },
          { label: "Advance", numeric: true },
          { label: "Balance", numeric: true },
          { label: "Status" },
        ],
        rows: rows.map((c) => {
          const out = payable.get(c.id)?.outstanding ?? toNum(c.balance);
          return {
            id: c.id,
            href: `/chalan?id=${c.id}`,
            cells: [
              c.chalanNo,
              fmtDate(c.chalanDate),
              maps.party.get(c.brokerId) ?? "",
              vname.get(c.vehicleId) ?? "",
              toNum(c.freight),
              toNum(c.advanceTotal),
              round2(out),
              c.cancelledAt ? "CANCELLED" : out <= 0.009 ? "PAID" : c.paymentStatus,
            ],
          };
        }),
        nextCursor: cursor + rows.length < count ? cursor + rows.length : null,
        totals: [
          { label: "Chalans", value: count },
          { label: "Freight", value: toNum(sums._sum.freight ?? 0) },
          { label: "Advance", value: toNum(sums._sum.advanceTotal ?? 0) },
        ],
      };
    }

    // ---------------------------------------------------------------- POD
    if (input.src === "POD") {
      const where = {
        ...scope,
        ...dateFilter("docDate", input.month),
        ...(q
          ? { OR: [{ docNo: { contains: q, mode: "insensitive" as const } }, { lr: { lrNo: { contains: q, mode: "insensitive" as const } } }] }
          : {}),
        ...(input.vehicleId ? { vehicleId: input.vehicleId } : {}),
      };
      const [rows, count, sums] = await Promise.all([
        tx.pod.findMany({ where, include: { lr: { select: { lrNo: true } } }, orderBy: [{ docDate: "desc" }, { id: "desc" }], skip: cursor, take: PAGE }),
        tx.pod.count({ where }),
        tx.pod.aggregate({ where, _sum: { shortageWt: true } }),
      ]);
      const maps = await nameMaps(tx, { vehicleIds: rows.map((r) => r.vehicleId ?? "") });
      return {
        columns: [
          { label: "Doc No" },
          { label: "Date" },
          { label: "LR No" },
          { label: "Vehicle" },
          { label: "Actual Wt", numeric: true },
          { label: "Received Wt", numeric: true },
          { label: "Shortage Wt", numeric: true },
          { label: "Status" },
        ],
        rows: rows.map((p) => ({
          id: p.id,
          cells: [
            p.docNo,
            fmtDate(p.docDate),
            p.lr?.lrNo ?? p.refNo ?? "",
            p.vehicleId ? maps.vehicle.get(p.vehicleId) ?? "" : "",
            p.actualWt !== null ? toNum(p.actualWt) : null,
            p.recWt !== null ? toNum(p.recWt) : null,
            p.shortageWt !== null ? toNum(p.shortageWt) : null,
            p.status,
          ],
        })),
        nextCursor: cursor + rows.length < count ? cursor + rows.length : null,
        totals: [
          { label: "PODs", value: count },
          { label: "Shortage Wt", value: toNum(sums._sum.shortageWt ?? 0) },
        ],
      };
    }

    // ---------------------------------------------------------------- BROKER
    if (input.src === "BROKER") {
      const where = {
        ...scope,
        deletedAt: null,
        ...dateFilter("slipDate", input.month),
        ...(q ? { slipNo: { contains: q, mode: "insensitive" as const } } : {}),
        ...(input.partyId ? { OR: [{ partyId: input.partyId }, { ownerId: input.partyId }] } : {}),
        ...(input.vehicleId ? { vehicleId: input.vehicleId } : {}),
      };
      const [rows, count, sums] = await Promise.all([
        tx.brokerSlip.findMany({ where, orderBy: [{ slipDate: "desc" }, { id: "desc" }], skip: cursor, take: PAGE }),
        tx.brokerSlip.count({ where }),
        tx.brokerSlip.aggregate({ where, _sum: { pChalanAmt: true, pBalance: true, vChalanAmt: true, vBalance: true } }),
      ]);
      const maps = await nameMaps(tx, {
        partyIds: rows.flatMap((r) => [r.partyId ?? "", r.ownerId ?? ""]),
        vehicleIds: rows.map((r) => r.vehicleId ?? ""),
      });
      return {
        columns: [
          { label: "Slip No" },
          { label: "Date" },
          { label: "Party" },
          { label: "Owner / Broker" },
          { label: "Vehicle" },
          { label: "Party Amt", numeric: true },
          { label: "Party Bal", numeric: true },
          { label: "Owner Amt", numeric: true },
          { label: "Owner Bal", numeric: true },
        ],
        rows: rows.map((s) => ({
          id: s.id,
          href: `/broker/slip?id=${s.id}`,
          cells: [
            s.slipNo,
            fmtDate(s.slipDate),
            s.partyId ? maps.party.get(s.partyId) ?? "" : "",
            s.ownerId ? maps.party.get(s.ownerId) ?? "" : s.ownerName ?? "",
            s.vehicleId ? maps.vehicle.get(s.vehicleId) ?? "" : "",
            toNum(s.pChalanAmt),
            toNum(s.pBalance),
            toNum(s.vChalanAmt),
            toNum(s.vBalance),
          ],
        })),
        nextCursor: cursor + rows.length < count ? cursor + rows.length : null,
        totals: [
          { label: "Slips", value: count },
          { label: "Party Amt", value: toNum(sums._sum.pChalanAmt ?? 0) },
          { label: "Owner Amt", value: toNum(sums._sum.vChalanAmt ?? 0) },
        ],
      };
    }

    // ---------------------------------------------------------------- BILLING
    if (input.src === "BILLING") {
      const where = {
        ...scope,
        deletedAt: null,
        ...dateFilter("invoiceDate", input.month),
        ...(q ? { invoiceNo: { contains: q, mode: "insensitive" as const } } : {}),
        ...(input.partyId ? { partyId: input.partyId } : {}),
      };
      const [rows, count, sums] = await Promise.all([
        tx.invoice.findMany({ where, orderBy: [{ invoiceDate: "desc" }, { id: "desc" }], skip: cursor, take: PAGE }),
        tx.invoice.count({ where }),
        tx.invoice.aggregate({ where, _sum: { grandTotal: true } }),
      ]);
      const settle = await invoiceSettlement(tx, { ...scope, invoices: rows });
      const maps = await nameMaps(tx, { partyIds: rows.map((r) => r.partyId) });
      return {
        columns: [
          { label: "Invoice No" },
          { label: "Date" },
          { label: "Type" },
          { label: "Party" },
          { label: "Grand Total", numeric: true },
          { label: "Received", numeric: true },
          { label: "Outstanding", numeric: true },
          { label: "Status" },
        ],
        rows: rows.map((i) => {
          const s = settle.get(i.id);
          return {
            id: i.id,
            cells: [
              i.invoiceNo,
              fmtDate(i.invoiceDate),
              i.kind,
              maps.party.get(i.partyId) ?? "",
              toNum(i.grandTotal),
              s?.received ?? 0,
              s?.outstanding ?? toNum(i.balance),
              s?.status ?? "UNPAID",
            ],
          };
        }),
        nextCursor: cursor + rows.length < count ? cursor + rows.length : null,
        totals: [
          { label: "Bills", value: count },
          { label: "Grand Total", value: toNum(sums._sum.grandTotal ?? 0) },
        ],
      };
    }

    // ------------------------------------------------------- OUTSTANDING
    if (input.src === "OUT_RECV" || input.src === "OUT_PAY") {
      // bounded computed sets (only this FY's documents), filtered to pending —
      // paged in memory after the settlement math
      type Pending = {
        id: string;
        type: string;
        refNo: string;
        date: Date;
        partyId: string | null;
        /** display + party-filter fallback for docs without a party link (hire slips) */
        partyName?: string | null;
        amount: number;
        settled: number;
        outstanding: number;
        href: string | null;
      };
      const pend: Pending[] = [];
      // filters are pushed into the queries so a scroll page never recomputes
      // the whole FY's settlement math for documents it will filter out anyway
      const outRange = monthRange(input.month);
      const dateIn = (field: string) =>
        outRange ? { [field]: { gte: outRange.gte, lt: outRange.lt } } : {};
      const refNoLike = (field: string) =>
        q ? { [field]: { contains: q, mode: "insensitive" as const } } : {};
      const filterPartyName = input.partyId
        ? (await tx.party.findUnique({ where: { id: input.partyId }, select: { name: true } }))?.name ?? null
        : null;
      if (input.src === "OUT_RECV") {
        const invoices = await tx.invoice.findMany({
          where: {
            ...scope,
            deletedAt: null,
            ...dateIn("invoiceDate"),
            ...refNoLike("invoiceNo"),
            ...(input.partyId ? { partyId: input.partyId } : {}),
          },
          // these tables are wide; the settlement math and the row labels
          // below need only these columns
          select: {
            id: true,
            kind: true,
            invoiceNo: true,
            invoiceDate: true,
            partyId: true,
            netTotal: true,
            advance: true,
          },
        });
        const settle = await invoiceSettlement(tx, { ...scope, invoices });
        for (const i of invoices) {
          const s = settle.get(i.id);
          if (!s || s.outstanding <= 0.009) continue;
          pend.push({
            id: i.id,
            type: `BILL (${i.kind})`,
            refNo: i.invoiceNo,
            date: i.invoiceDate,
            partyId: i.partyId,
            amount: s.net,
            settled: s.received,
            outstanding: s.outstanding,
            href: null,
          });
        }
      } else {
        const [chalans, slips, hires] = await Promise.all([
          tx.chalan.findMany({
            where: {
              ...scope,
              deletedAt: null,
              cancelledAt: null,
              // no isFinal filter — the Outstanding register and the dashboard
              // count draft chalans too; all three views must agree
              ...dateIn("chalanDate"),
              ...refNoLike("chalanNo"),
              ...(input.partyId ? { brokerId: input.partyId } : {}),
            },
            select: {
              id: true,
              chalanNo: true,
              chalanDate: true,
              brokerId: true,
              vehicleId: true,
              grandTotal: true,
              advanceTotal: true,
              balPaidAmount: true,
              balShortage: true,
              balRoundOff: true,
              balAdvanceAdjusted: true,
            },
          }),
          tx.brokerSlip.findMany({
            where: {
              ...scope,
              deletedAt: null,
              ...dateIn("slipDate"),
              ...refNoLike("slipNo"),
              ...(input.partyId ? { ownerId: input.partyId } : {}),
            },
            select: {
              id: true,
              slipNo: true,
              slipDate: true,
              ownerId: true,
              vehicleId: true,
              vNetAmt: true,
              vAdvance: true,
              vPaidAmount: true,
              vShortage: true,
              vRoundOff: true,
            },
          }),
          // a hire slip has no party link — with a party filter it is matched
          // below by the typed owner/broker name instead of dropped silently
          tx.hireSlip.findMany({
            where: { ...scope, deletedAt: null, ...dateIn("slipDate"), ...refNoLike("slipNo") },
            select: {
              id: true,
              slipNo: true,
              slipDate: true,
              ownerName: true,
              brokerName: true,
              totalHire: true,
              advance: true,
            },
          }),
        ]);
        // only market vehicles are payable through the chalan
        const brokers = new Set(
          (await tx.vehicle.findMany({ where: { ownershipType: "BROKER" }, select: { id: true } })).map((v) => v.id)
        );
        const chalanPos = await payableSettlement(tx, {
          ...scope,
          refType: "FREIGHT_CHALLAN",
          docs: chalans
            .filter((c) => brokers.has(c.vehicleId))
            .map((c) => ({
              id: c.id,
              // live: grandTotal − advances, never the stored balance column
              balance: round2(toNum(c.grandTotal) - toNum(c.advanceTotal)),
              ownPaid: toNum(c.balPaidAmount),
              ownShortage: toNum(c.balShortage),
              ownRoundOff: toNum(c.balRoundOff),
              ownAdvanceAdjusted: toNum(c.balAdvanceAdjusted),
            })),
        });
        for (const c of chalans) {
          const p = chalanPos.get(c.id);
          if (!p || p.outstanding <= 0.009) continue;
          pend.push({
            id: c.id,
            type: "CHALAN",
            refNo: c.chalanNo,
            date: c.chalanDate,
            partyId: c.brokerId,
            amount: p.balance,
            settled: p.settled,
            outstanding: p.outstanding,
            href: `/chalan?id=${c.id}`,
          });
        }
        // owner side is payable only on MARKET (broker) vehicles — the same
        // rule the payables register and the dashboard apply; a relative
        // vehicle's slip settles through the owner's ledger, never here
        const marketSlips = slips.filter((s) => s.vehicleId && brokers.has(s.vehicleId));
        const slipPos = await payableSettlement(tx, {
          ...scope,
          refType: "BROKER_ENTRY",
          docs: marketSlips.map((s) => ({
            id: s.id,
            // live: owner net − owner advance, never the stored vBalance
            balance: round2(toNum(s.vNetAmt) - toNum(s.vAdvance)),
            ownPaid: toNum(s.vPaidAmount),
            ownShortage: toNum(s.vShortage),
            ownRoundOff: toNum(s.vRoundOff),
          })),
        });
        for (const s of marketSlips) {
          const p = slipPos.get(s.id);
          if (!p || p.outstanding <= 0.009) continue;
          pend.push({
            id: s.id,
            type: "BROKER SLIP",
            refNo: s.slipNo,
            date: s.slipDate,
            partyId: s.ownerId,
            amount: p.balance,
            settled: p.settled,
            outstanding: p.outstanding,
            href: `/broker/slip?id=${s.id}`,
          });
        }
        const nameMatches = (h: { ownerName: string | null; brokerName: string | null }) =>
          !filterPartyName ||
          [h.ownerName, h.brokerName].some(
            (n) => n && n.trim().toLowerCase() === filterPartyName.trim().toLowerCase()
          );
        const myHires = hires.filter(nameMatches);
        const hirePos = await payableSettlement(tx, {
          ...scope,
          refType: "LORRY_HIRE",
          docs: myHires.map((h) => ({
            id: h.id,
            // live: total hire − advance, never the stored balance column
            balance: round2(toNum(h.totalHire) - toNum(h.advance)),
            ownPaid: 0,
            ownShortage: 0,
            ownRoundOff: 0,
          })),
        });
        for (const h of myHires) {
          const p = hirePos.get(h.id);
          if (!p || p.outstanding <= 0.009) continue;
          pend.push({
            id: h.id,
            type: "HIRE SLIP",
            refNo: h.slipNo,
            date: h.slipDate,
            partyId: null,
            partyName: h.ownerName || h.brokerName || null,
            amount: p.balance,
            settled: p.settled,
            outstanding: p.outstanding,
            href: null,
          });
        }
      }
      // queries already filtered; hire slips matched by name carry partyName
      let list = pend.filter((p) =>
        input.partyId ? p.partyId === input.partyId || p.partyName != null : true
      );
      list = list.sort((a, b) => b.date.getTime() - a.date.getTime());
      const page = list.slice(cursor, cursor + PAGE);
      const maps = await nameMaps(tx, { partyIds: page.map((p) => p.partyId ?? "") });
      return {
        columns: [
          { label: "Type" },
          { label: "Ref No" },
          { label: "Date" },
          { label: "Party" },
          { label: "Amount", numeric: true },
          { label: "Settled", numeric: true },
          { label: "Outstanding", numeric: true },
        ],
        rows: page.map((p) => ({
          id: p.id,
          href: p.href,
          cells: [
            p.type,
            p.refNo,
            fmtDate(p.date),
            p.partyId ? maps.party.get(p.partyId) ?? "" : p.partyName ?? "",
            round2(p.amount),
            round2(p.settled),
            round2(p.outstanding),
          ],
        })),
        nextCursor: cursor + page.length < list.length ? cursor + page.length : null,
        totals: [
          { label: "Documents", value: list.length },
          { label: "Outstanding", value: round2(list.reduce((s, p) => s + p.outstanding, 0)) },
        ],
      };
    }

    // ---------------------------------------------------------------- VOUCHER
    if (input.src === "VOUCHER") {
      // q and party BOTH use OR shapes — they must live under AND, or the
      // second OR key silently overwrites the first and the search is ignored
      const where = {
        ...scope,
        deletedAt: null,
        ...dateFilter("voucherDate", input.month),
        AND: [
          ...(q
            ? [{ OR: [{ voucherNo: { contains: q, mode: "insensitive" as const } }, { remarks: { contains: q, mode: "insensitive" as const } }] }]
            : []),
          ...(input.partyId
            ? [{ OR: [{ partyId: input.partyId }, { bankPartyId: input.partyId }] }]
            : []),
        ],
        ...(input.vehicleId ? { vehicleId: input.vehicleId } : {}),
      };
      const [rows, count, sums] = await Promise.all([
        tx.voucher.findMany({ where, orderBy: [{ voucherDate: "desc" }, { id: "desc" }], skip: cursor, take: PAGE }),
        tx.voucher.count({ where }),
        tx.voucher.aggregate({ where, _sum: { amount: true, netAmount: true } }),
      ]);
      const maps = await nameMaps(tx, {
        partyIds: rows.flatMap((r) => [r.partyId ?? "", r.bankPartyId ?? ""]),
        headIds: rows.flatMap((r) => [r.accountHeadId ?? "", r.creditHeadId ?? ""]),
      });
      return {
        columns: [
          { label: "Voucher No" },
          { label: "Date" },
          { label: "Type" },
          { label: "Party / Debit" },
          { label: "Bank-Cash / Credit" },
          { label: "Gross", numeric: true },
          { label: "Net", numeric: true },
        ],
        rows: rows.map((v) => ({
          id: v.id,
          cells: [
            v.voucherNo,
            fmtDate(v.voucherDate),
            v.type,
            (v.partyId ? maps.party.get(v.partyId) : v.accountHeadId ? maps.head.get(v.accountHeadId) : "") ?? "",
            (v.bankPartyId ? maps.party.get(v.bankPartyId) : v.creditHeadId ? maps.head.get(v.creditHeadId) : "") ?? "",
            toNum(v.amount),
            toNum(v.netAmount),
          ],
        })),
        nextCursor: cursor + rows.length < count ? cursor + rows.length : null,
        totals: [
          { label: "Vouchers", value: count },
          { label: "Gross", value: toNum(sums._sum.amount ?? 0) },
          { label: "Net", value: toNum(sums._sum.netAmount ?? 0) },
        ],
      };
    }

    // -------------------------------------------- LEDGER-ENTRY SOURCES
    // Books (bank/cash/card), party ledger, common heads, TDS heads all read
    // LedgerEntry; they differ only in the scope of accounts.
    {
      let entryWhere: Record<string, unknown> = { ...scope };
      let withBalance = false;
      let opening = 0;
      let showAccount = false;
      const accountName = new Map<string, string>();

      if (input.src === "BOOK_BANK" || input.src === "BOOK_CASH" || input.src === "BOOK_CARD") {
        const group = input.src === "BOOK_BANK" ? "BANK" : input.src === "BOOK_CASH" ? "CASH" : "CARD";
        const accounts = await tx.party.findMany({ where: { ledgerGroup: group }, select: { id: true, name: true, openingBalance: true, openingSide: true } });
        accounts.forEach((a) => accountName.set(a.id, a.name));
        const ids = accounts.map((a) => a.id);
        if (input.partyId && ids.includes(input.partyId)) {
          entryWhere.partyId = input.partyId;
          withBalance = true;
          const acc = accounts.find((a) => a.id === input.partyId)!;
          opening = acc.openingSide === "DEBIT" ? toNum(acc.openingBalance) : -toNum(acc.openingBalance);
        } else {
          entryWhere.partyId = { in: ids };
          showAccount = true;
        }
      } else if (input.src === "LEDGER") {
        if (!input.partyId) {
          return {
            columns: [
              { label: "Date" },
              { label: "Ref Type" },
              { label: "Reference No" },
              { label: "Narration" },
              { label: "Debit", numeric: true },
              { label: "Credit", numeric: true },
              { label: "Balance", numeric: true },
            ],
            rows: [],
            nextCursor: null,
            totals: [],
          };
        }
        entryWhere.partyId = input.partyId;
        withBalance = true;
        const p = await tx.party.findFirst({ where: { id: input.partyId } });
        opening = p ? (p.openingSide === "DEBIT" ? toNum(p.openingBalance) : -toNum(p.openingBalance)) : 0;
      } else if (input.src === "COMMON") {
        const names = COMMON_HEADS.filter((h) => h.name !== "TDS Payable" && h.name !== "TDS Receivable").map((h) => h.name);
        const heads = await tx.accountHead.findMany({
          where: { name: { in: input.head && names.includes(input.head) ? [input.head] : names } },
          select: { id: true, name: true },
        });
        heads.forEach((h) => accountName.set(h.id, h.name));
        entryWhere.accountHeadId = { in: heads.map((h) => h.id) };
        showAccount = true;
      } else if (input.src === "TDS_PAY" || input.src === "TDS_RECV") {
        const heads = await tx.accountHead.findMany({
          where: { name: input.src === "TDS_PAY" ? "TDS Payable" : "TDS Receivable" },
          select: { id: true, name: true },
        });
        entryWhere.accountHeadId = { in: heads.map((h) => h.id) };
      } else {
        throw new Error(`Unknown source ${input.src}`);
      }

      const range = monthRange(input.month);
      if (range) entryWhere = { ...entryWhere, date: { gte: range.gte, lt: range.lt } };
      if (q) {
        entryWhere = {
          ...entryWhere,
          OR: [
            { refNo: { contains: q, mode: "insensitive" as const } },
            { narration: { contains: q, mode: "insensitive" as const } },
          ],
        };
        // a running balance over a SEARCH-filtered subset is meaningless (and
        // the opening would be filtered too) — the column hides while searching
        withBalance = false;
      }

      const [rows, count, sums] = await Promise.all([
        tx.ledgerEntry.findMany({ where: entryWhere, orderBy: [{ date: "asc" }, { createdAt: "asc" }, { id: "asc" }], skip: cursor, take: PAGE }),
        tx.ledgerEntry.count({ where: entryWhere }),
        tx.ledgerEntry.aggregate({ where: entryWhere, _sum: { amount: true } }),
      ]);
      const [drSum, crSum] = await Promise.all([
        tx.ledgerEntry.aggregate({ where: { ...entryWhere, side: "DEBIT" }, _sum: { amount: true } }),
        tx.ledgerEntry.aggregate({ where: { ...entryWhere, side: "CREDIT" }, _sum: { amount: true } }),
      ]);

      // opening for the first page of a running-balance ledger: the balance
      // BEFORE the month (entries earlier in the FY plus the master opening)
      let running = 0;
      if (withBalance) {
        if (cursor > 0 && input.runningStart !== null && input.runningStart !== undefined) {
          running = input.runningStart;
        } else {
          running = opening;
          // FY continuity: earlier years' net folds into the opening of the
          // BROWSED year (single-account books and the party ledger only —
          // the partyId scope is a plain string exactly in those cases)
          const partyScope = (entryWhere as { partyId?: unknown }).partyId;
          if (typeof partyScope === "string") {
            const fyRow = await tx.financialYear.findUnique({
              where: { id: fyId },
              select: { startDate: true },
            });
            const priorFyIds = fyRow
              ? (
                  await tx.financialYear.findMany({
                    where: { firmId: session.firmId, startDate: { lt: fyRow.startDate } },
                    select: { id: true },
                  })
                ).map((f) => f.id)
              : [];
            if (priorFyIds.length) {
              const priorWhere = {
                firmId: session.firmId,
                fyId: { in: priorFyIds },
                partyId: partyScope,
              };
              const [dPrior, cPrior] = await Promise.all([
                tx.ledgerEntry.aggregate({ where: { ...priorWhere, side: "DEBIT" }, _sum: { amount: true } }),
                tx.ledgerEntry.aggregate({ where: { ...priorWhere, side: "CREDIT" }, _sum: { amount: true } }),
              ]);
              running = round2(
                running + toNum(dPrior._sum.amount ?? 0) - toNum(cPrior._sum.amount ?? 0)
              );
            }
          }
          if (range) {
            const beforeWhere = { ...entryWhere, date: { lt: range.gte } };
            const [dBefore, cBefore] = await Promise.all([
              tx.ledgerEntry.aggregate({ where: { ...beforeWhere, side: "DEBIT" }, _sum: { amount: true } }),
              tx.ledgerEntry.aggregate({ where: { ...beforeWhere, side: "CREDIT" }, _sum: { amount: true } }),
            ]);
            running = round2(running + toNum(dBefore._sum.amount ?? 0) - toNum(cBefore._sum.amount ?? 0));
          }
        }
      }

      void sums;
      const columns = [
        { label: "Date" },
        ...(showAccount ? [{ label: input.src === "COMMON" ? "Ledger Head" : "Account" }] : []),
        { label: "Ref Type" },
        { label: "Reference No" },
        { label: "Narration" },
        { label: "Debit", numeric: true },
        { label: "Credit", numeric: true },
        ...(withBalance ? [{ label: "Balance", numeric: true }] : []),
      ];
      const outRows: BrowseRow[] = rows.map((e) => {
        const amt = toNum(e.amount);
        const debit = e.side === "DEBIT" ? amt : 0;
        const credit = e.side === "CREDIT" ? amt : 0;
        if (withBalance) running = round2(running + debit - credit);
        return {
          id: e.id,
          cells: [
            fmtDate(e.date),
            ...(showAccount ? [accountName.get(e.partyId ?? e.accountHeadId ?? "") ?? ""] : []),
            e.refType.replace(/_/g, " "),
            e.refNo,
            e.narration ?? "",
            debit || null,
            credit || null,
            ...(withBalance ? [running] : []),
          ],
        };
      });
      return {
        columns,
        rows: outRows,
        nextCursor: cursor + rows.length < count ? cursor + rows.length : null,
        totals: [
          { label: "Entries", value: count },
          { label: "Debit", value: toNum(drSum._sum.amount ?? 0) },
          { label: "Credit", value: toNum(crSum._sum.amount ?? 0) },
        ],
        runningEnd: withBalance ? running : null,
      };
    }
  });
}
