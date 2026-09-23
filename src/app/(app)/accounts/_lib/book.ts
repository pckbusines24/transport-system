import type { LedgerGroup, Prisma } from "@prisma/client";
import { withTenant } from "@/lib/db";
import { formatDate, toNum } from "@/lib/utils";
import type { Session } from "@/lib/session";
import type { ReportRow } from "@/components/accounts/simple-report";

export interface BookParams {
  session: Session & { firmId: string; fyId: string };
  /** restrict to parties of these ledger groups (cash book / bank book) */
  groups?: LedgerGroup[];
  /** explicit party (ledger summary) */
  partyId?: string;
  /** explicit income/expense account head (ledger summary) */
  headId?: string;
  /**
   * reference-wise tracking: show EVERY entry whose Reference No matches,
   * across all ledgers (original bill, receipts, payments, adjustments...)
   */
  refNo?: string;
  dateFrom?: string;
  dateTo?: string;
  /** exact source-document type (CHALAN, VOUCHER, VEH_EXP_ALLOC, ...) */
  refType?: string;
  /** narration contains, case-insensitive */
  narration?: string;
  /** show only one side of the book */
  side?: "DEBIT" | "CREDIT";
  /** entries stamped with this vehicle */
  vehicleId?: string;
  /** amount range (applies to the entry amount, either side) */
  amtFrom?: number;
  amtTo?: number;
  /** counter-account ("Account" column) exact name */
  counter?: string;
  /** voucher number contains, case-insensitive */
  voucherNo?: string;
}

/**
 * Ledger entries as book rows (debit / credit / running balance).
 * A single selected party seeds the running total with its opening balance;
 * with a date filter, entries before the range are folded into the opening.
 * Income/Expense account heads are ledgers too — select one via headId.
 * Voucher / office-transaction rows are enriched with the voucher number and
 * payment details (bank/cash account, instrument no) without opening them.
 */
export async function ledgerBookRows(params: BookParams): Promise<{
  rows: ReportRow[];
  parties: {
    id: string;
    name: string;
    alias: string | null;
    transportName: string | null;
    ledgerGroup: LedgerGroup;
  }[];
  heads: { id: string; name: string; kind: string }[];
  vehicles: { id: string; number: string }[];
  /** distinct source-document types — scoped to the selected ledger when one is chosen */
  refTypes: string[];
  /** distinct reference numbers OF THE SELECTED LEDGER ONLY (empty otherwise) */
  refNos: string[];
  /** distinct counter-account names in the (unfiltered-by-counter) result */
  counters: string[];
}> {
  const { session } = params;
  return withTenant(session.tenantId, async (tx) => {
    // Bank & Cash live in their own books (cash-book / bank-book) — keep them out
    // of the party ledger unless a book explicitly asks for those groups.
    const partyWhere: Prisma.PartyWhereInput = params.groups
      ? { ledgerGroup: { in: params.groups } }
      : { ledgerGroup: { notIn: ["BANK", "CASH", "CARD"] } };
    const [parties, allParties, heads, vehicles, refTypeGroups] = await Promise.all([
      tx.party.findMany({
        where: { ...partyWhere, isActive: true },
        orderBy: { name: "asc" },
        select: {
          id: true,
          name: true,
          alias: true,
          transportName: true,
          ledgerGroup: true,
          openingBalance: true,
          openingSide: true,
        },
      }),
      // full name map (incl. bank/cash) for account display + payment details;
      // ledgerGroup decides the counter-account priority (money accounts first)
      tx.party.findMany({ select: { id: true, name: true, ledgerGroup: true } }),
      tx.accountHead.findMany({
        orderBy: { name: "asc" },
        select: { id: true, name: true, kind: true },
      }),
      tx.vehicle.findMany({ orderBy: { number: "asc" }, select: { id: true, number: true } }),
      // filter options belong to the SELECTED ledger only — a Ref Type or Ref
      // No of some other party must never appear in the dropdowns
      tx.ledgerEntry.groupBy({
        by: ["refType"],
        // firm-wide: a ref type used only in an earlier year stays offered
        where: {
          firmId: session.firmId,
          ...(params.headId
            ? { accountHeadId: params.headId }
            : params.partyId
              ? { partyId: params.partyId }
              : {}),
        },
      }),
    ]);
    const ledgerOnly = params.headId
      ? { accountHeadId: params.headId }
      : params.partyId
        ? { partyId: params.partyId }
        : null;
    // no take-limit: a distinct list of one ledger's reference numbers is
    // small, and a silent cap hid valid references beyond the first 1000
    // firm-wide (no FY): the dropdown must offer old-year references too,
    // since a reference search spans every year
    const refNoRows = ledgerOnly
      ? await tx.ledgerEntry.findMany({
          where: { firmId: session.firmId, ...ledgerOnly },
          select: { refNo: true },
          distinct: ["refNo"],
          orderBy: { refNo: "asc" },
        })
      : [];
    // vehicle filter options: ONLY vehicles that appear in the selected
    // ledger's entries — never another ledger's vehicles
    const vehicleGroups = ledgerOnly
      ? await tx.ledgerEntry.groupBy({
          by: ["vehicleId"],
          where: {
            firmId: session.firmId,
            fyId: session.fyId,
            ...ledgerOnly,
            vehicleId: { not: null },
          },
        })
      : null;
    const scopedVehicleIds = vehicleGroups
      ? new Set(vehicleGroups.map((g) => g.vehicleId))
      : null;
    const partyIds = params.partyId ? [params.partyId] : parties.map((p) => p.id);

    // FY continuity: earlier years feed this year's opening balance, and a
    // cross-ledger reference search must show a document's WHOLE lifecycle
    // (last year's bill + this year's receipt together)
    const currentFy = await tx.financialYear.findUnique({
      where: { id: session.fyId },
      select: { startDate: true, endDate: true },
    });
    const priorFyIds = currentFy
      ? (
          await tx.financialYear.findMany({
            where: { firmId: session.firmId, startDate: { lt: currentFy.startDate } },
            select: { id: true },
          })
        ).map((f) => f.id)
      : [];

    // With a ledger selected, EVERY filter (reference included) applies inside
    // that ledger only. A reference search with no ledger selected keeps its
    // cross-ledger meaning: the complete lifecycle of one document.
    const ledgerScope: Prisma.LedgerEntryWhereInput | null = params.headId
      ? { accountHeadId: params.headId }
      : params.partyId || params.groups
        ? { partyId: { in: partyIds } }
        : null;
    // EXACT reference match: "80001" must never match 180001 / 800012.
    // A voucher settling several documents stores them comma-joined
    // ("SBRL/001, SBRL/002"), so the row belongs to the lifecycle of each —
    // the SQL `contains` is only a coarse pre-filter; the precise
    // comma-token equality check runs on the fetched rows below.
    const refQuery = params.refNo?.trim().toLowerCase();
    const refNoWhere = params.refNo
      ? { refNo: { contains: params.refNo.trim(), mode: "insensitive" as const } }
      : {};
    const matchesRef = (refNo: string) =>
      !refQuery ||
      refNo
        .split(",")
        .map((t) => t.trim().toLowerCase())
        .includes(refQuery);
    // ANY reference search spans every FY — inside a selected ledger or
    // across all of them, the lifecycle of one document must never be cut at
    // the year boundary (last year's bill + this year's receipt together)
    const crossFyRef = !!refQuery;
    // date filter beats FY: an explicit range lists entries from EVERY year
    // it covers (1/4/26–31/5/27 shows both years continuously); without dates
    // the book stays scoped to the session FY + carried opening
    const dateDriven = !!(params.dateFrom || params.dateTo);
    const where: Prisma.LedgerEntryWhereInput = {
      firmId: session.firmId,
      ...(crossFyRef || dateDriven ? {} : { fyId: session.fyId }),
      ...(ledgerScope
        ? { ...ledgerScope, ...refNoWhere }
        : params.refNo
          ? refNoWhere
          : // full ledger: keep unlinked entries, drop bank/cash-party entries
            { OR: [{ partyId: { in: partyIds } }, { partyId: null }] }),
    };
    if (params.dateFrom || params.dateTo) {
      where.date = {
        ...(params.dateFrom ? { gte: new Date(params.dateFrom + "T00:00:00") } : {}),
        ...(params.dateTo ? { lte: new Date(params.dateTo + "T23:59:59") } : {}),
      };
    }
    if (params.refType) where.refType = params.refType;
    if (params.narration)
      where.narration = { contains: params.narration.trim(), mode: "insensitive" };
    if (params.side) where.side = params.side;
    if (params.vehicleId) where.vehicleId = params.vehicleId;
    if (params.amtFrom != null || params.amtTo != null) {
      where.amount = {
        ...(params.amtFrom != null ? { gte: params.amtFrom } : {}),
        ...(params.amtTo != null ? { lte: params.amtTo } : {}),
      };
    }
    // every matching entry is fetched: a cap here silently dropped the NEWEST
    // rows of a busy ledger and reported a wrong closing balance. The `id`
    // tie-breaker keeps same-timestamp rows (createMany legs) in a stable
    // order across page loads.
    const fetched = await tx.ledgerEntry.findMany({
      where,
      orderBy: [{ date: "asc" }, { createdAt: "asc" }, { id: "asc" }],
    });
    const entries = refQuery ? fetched.filter((e) => matchesRef(e.refNo)) : fetched;
    const nameById = new Map(allParties.map((p) => [p.id, p.name]));
    const headNameById = new Map(heads.map((h) => [h.id, h.name]));
    const vehicleNoById = new Map(vehicles.map((v) => [v.id, v.number]));

    // ---- counter-account (Tally-style "Account" column): the OTHER legs of
    // the same posting say where this entry came from — bank on a payment,
    // the expense head on an allocation transfer, the party on a chalan
    const legName = (l: {
      partyId: string | null;
      accountHeadId: string | null;
      vehicleId: string | null;
    }): string =>
      (l.partyId && nameById.get(l.partyId)) ||
      (l.accountHeadId && headNameById.get(l.accountHeadId)) ||
      (l.vehicleId && `Vehicle ${vehicleNoById.get(l.vehicleId) ?? ""}`) ||
      "";
    const refIdsByType = new Map<string, string[]>();
    for (const e of entries) {
      refIdsByType.set(e.refType, [...(refIdsByType.get(e.refType) ?? []), e.refId]);
    }
    const siblings = entries.length
      ? await tx.ledgerEntry.findMany({
          where: {
            // firm-wide (no FY filter): the other legs of a posting may sit in
            // another year on a cross-FY reference search
            firmId: session.firmId,
            OR: Array.from(refIdsByType.entries()).map(([refType, ids]) => ({
              refType,
              refId: { in: Array.from(new Set(ids)) },
            })),
          },
          select: {
            id: true,
            refType: true,
            refId: true,
            side: true,
            amount: true,
            partyId: true,
            accountHeadId: true,
            vehicleId: true,
          },
        })
      : [];
    const siblingsByRef = new Map<string, typeof siblings>();
    for (const s of siblings) {
      const key = `${s.refType}:${s.refId}`;
      siblingsByRef.set(key, [...(siblingsByRef.get(key) ?? []), s]);
    }
    // ONE name per row, Tally-style: prefer the opposite leg with the SAME
    // amount (that is the entry's real counterpart), then money accounts
    // (bank/cash/card), then income/expense heads, then parties. Details live
    // in the narration and the drill-down — the column stays readable.
    const partyGroupById = new Map(allParties.map((p) => [p.id, p.ledgerGroup]));
    const legRank = (l: { partyId: string | null; accountHeadId: string | null }): number => {
      if (l.partyId) {
        const g = partyGroupById.get(l.partyId);
        return g === "BANK" || g === "CASH" || g === "CARD" ? 0 : 2;
      }
      if (l.accountHeadId) return 1;
      return 3;
    };
    const counterAccount = (e: (typeof entries)[number]): string => {
      const legs = siblingsByRef.get(`${e.refType}:${e.refId}`) ?? [];
      const own = legName(e);
      const opposite = legs.filter((l) => l.id !== e.id && l.side !== e.side);
      const pool = (opposite.length ? opposite : legs.filter((l) => l.id !== e.id)).filter(
        (l) => legName(l) && legName(l) !== own
      );
      if (!pool.length) return "";
      const amt = Number(e.amount);
      const matched = pool.filter((l) => Math.abs(Number(l.amount) - amt) < 0.01);
      const pick = (matched.length ? matched : pool).sort((a, b) => legRank(a) - legRank(b))[0];
      return legName(pick);
    };

    // ---- drill-down: open the source document behind an entry (hrefs are
    // relative to "/", matching SimpleReport's linkBase convention)
    const drillLink = (refType: string, refId: string, voucherNo: string): string => {
      if (refType.startsWith("CHALAN") || refType === "FREIGHT_CHALLAN")
        return `chalan?id=${refId}`;
      if (refType.startsWith("BROKER_SLIP") || refType === "BROKER_ENTRY")
        return `broker/slip?id=${refId}`;
      if (refType === "INVOICE" || refType === "BILLING" || refType === "GST_BILLING")
        return `print/invoice/${refId}`;
      if (refType === "LOAN") return `print/loan/${refId}`;
      if (refType === "TRIP_UREA") return `print/trip-summary/${refId}`;
      if (refType === "VOUCHER" && voucherNo)
        return `accounts/vouchers/register?q=${encodeURIComponent(voucherNo)}`;
      return "";
    };

    // enrich voucher / office rows: voucher number + payment details
    const voucherIds = Array.from(
      new Set(entries.filter((e) => e.refType === "VOUCHER").map((e) => e.refId))
    );
    const officeIds = Array.from(
      new Set(entries.filter((e) => e.refType === "OFFICE_TXN").map((e) => e.refId))
    );
    const [vouchers, officeTxns] = await Promise.all([
      voucherIds.length
        ? tx.voucher.findMany({
            where: { id: { in: voucherIds } },
            select: {
              id: true,
              voucherNo: true,
              type: true,
              bankPartyId: true,
              chequeNo: true,
              chequeDate: true,
            },
          })
        : Promise.resolve([]),
      officeIds.length
        ? tx.officeTransaction.findMany({
            where: { id: { in: officeIds } },
            select: { id: true, voucherNo: true, paymentMode: true, bankPartyId: true },
          })
        : Promise.resolve([]),
    ]);
    const voucherById = new Map(vouchers.map((v) => [v.id, v]));
    const officeById = new Map(officeTxns.map((o) => [o.id, o]));

    // Advance adjustments are settlement history, not transactions: the voucher
    // below already moved the money. Hang the history off the voucher row so the
    // ledger shows where the advance went without a second debit/credit.
    const advances = voucherIds.length
      ? await tx.partyAdvance.findMany({
          where: { voucherId: { in: voucherIds }, deletedAt: null },
          include: { uses: { orderBy: { date: "asc" } } },
        })
      : [];
    const advByVoucher = new Map(advances.map((a) => [a.voucherId ?? "", a]));

    // ---- ADV ADJUSTMENT rows: an advance-settled reference has NO ledger
    // entry of its own (the advance voucher moved the money earlier), so a
    // Ref No search would show the bill as never settled. These zero-value
    // informational rows fill that hole — no debit, no credit, no effect on
    // the running balance; they only say "this reference was settled from
    // that advance". Shown on a selected party ledger and on cross-ledger
    // reference searches; a bank/cash book or head ledger has no advances.
    const wantAdjRows =
      !params.groups && !params.headId && !params.side && (!!params.partyId || !!refQuery);
    const adjUses =
      wantAdjRows && (!params.refType || params.refType === "ADV ADJUSTMENT")
        ? await tx.partyAdvanceUse.findMany({
            where: {
              advance: {
                // FY continuity: an advance given last year can settle this
                // year's documents, so the advance itself is not FY-filtered —
                // the USE date decides which book the row appears in
                firmId: session.firmId,
                deletedAt: null,
                ...(params.partyId ? { partyId: params.partyId } : {}),
              },
              ...(params.refNo
                ? { refNo: { contains: params.refNo.trim(), mode: "insensitive" } }
                : {}),
              date: {
                // default window = the current FY (BOTH edges — a later-year
                // use must not forward-leak into this book); an explicit date
                // filter or a cross-FY reference search widens it
                ...(params.dateFrom
                  ? { gte: new Date(params.dateFrom + "T00:00:00") }
                  : crossFyRef || !currentFy
                    ? {}
                    : { gte: currentFy.startDate }),
                ...(params.dateTo
                  ? { lte: new Date(params.dateTo + "T23:59:59") }
                  : crossFyRef || !currentFy
                    ? {}
                    : { lte: currentFy.endDate }),
              },
            },
            include: { advance: true },
            orderBy: { date: "asc" },
          })
        : [];

    // a running balance over a content-filtered subset would mislead — track
    // it only when the rows are the ledger's complete story
    const contentFiltered = !!(
      params.refNo ||
      params.refType ||
      params.narration ||
      params.side ||
      params.vehicleId ||
      params.amtFrom != null ||
      params.amtTo != null
    );
    const trackRunning = !contentFiltered && (!!params.partyId || !!params.headId);
    let running = 0;
    if (params.partyId) {
      const p = parties.find((x) => x.id === params.partyId);
      if (p) {
        const opening = toNum(String(p.openingBalance));
        running = p.openingSide === "DEBIT" ? opening : -opening;
      }
      // FY continuity: earlier years' net folds into this year's opening —
      // computed live, so a late entry posted in an old FY corrects every
      // later year's opening automatically. Account HEADS deliberately do
      // not carry (income/expense start each year at zero, like Tally).
      // Skipped under a date filter: the date-driven listing below already
      // spans every year, and the pre-range fold covers what came before.
      if (trackRunning && priorFyIds.length && !dateDriven) {
        const carried = await tx.ledgerEntry.groupBy({
          by: ["side"],
          where: {
            firmId: session.firmId,
            fyId: { in: priorFyIds },
            partyId: params.partyId,
          },
          _sum: { amount: true },
        });
        for (const c of carried) {
          const sum = toNum(String(c._sum.amount ?? 0));
          running += c.side === "DEBIT" ? sum : -sum;
        }
      }
    }
    // entries before the date filter belong in the opening balance — across
    // EVERY year, matching the date-driven listing (no FY wall)
    if (trackRunning && params.dateFrom) {
      const prior = await tx.ledgerEntry.groupBy({
        by: ["side"],
        where: {
          firmId: session.firmId,
          ...(params.headId ? { accountHeadId: params.headId } : { partyId: params.partyId }),
          date: { lt: new Date(params.dateFrom + "T00:00:00") },
        },
        _sum: { amount: true },
      });
      for (const p of prior) {
        const sum = toNum(String(p._sum.amount ?? 0));
        running += p.side === "DEBIT" ? sum : -sum;
      }
    }

    const fmtBal = (v: number) =>
      `${Math.abs(Math.round(v * 100) / 100).toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ${v >= 0 ? "Dr" : "Cr"}`;
    // FY continuity, made visible: the selected ledger opens with an explicit
    // "Opening Balance b/f" row — master opening + every earlier year's net
    // (+ pre-date entries under a date filter) — so the carried balance shows
    // even before the new year has a single entry of its own
    // skipped in dateTo-only mode: the listing then runs from the very
    // beginning, so a row claiming "carried from earlier years" would lie
    const openingRow: ReportRow | null =
      trackRunning && (params.dateFrom || (params.partyId && !dateDriven))
        ? {
            date: (params.dateFrom
              ? new Date(params.dateFrom + "T00:00:00")
              : currentFy?.startDate ?? new Date()
            ).toISOString(),
            party:
              (params.partyId &&
                parties.find((p) => p.id === params.partyId)?.name) ||
              (params.headId && headNameById.get(params.headId)) ||
              "",
            account: "",
            refType: "OPENING",
            refNo: "",
            link: "",
            voucherNo: "",
            payment: "",
            vehicle: "",
            narration: "Opening balance b/f (earlier years + opening entry)",
            adjustments: "",
            debit: null,
            credit: null,
            balance: fmtBal(running),
          }
        : null;

    const rows: ReportRow[] = entries.map((e) => {
      const amt = toNum(String(e.amount));
      const debit = e.side === "DEBIT" ? amt : 0;
      const credit = e.side === "CREDIT" ? amt : 0;
      if (trackRunning) running += debit - credit;

      let voucherNo = "";
      let payment = "";
      let adjustments = "";
      if (e.refType === "VOUCHER") {
        const v = voucherById.get(e.refId);
        const adv = advByVoucher.get(e.refId);
        // only the advance-holder's own leg carries the history — the bank leg
        // of the same voucher would otherwise repeat it
        if (adv && e.partyId === adv.partyId) {
          const amount = toNum(String(adv.amount));
          const consumed = toNum(String(adv.consumedAmount));
          adjustments = JSON.stringify({
            voucherNo: adv.voucherNo ?? "",
            amount,
            consumed,
            remaining: Math.round((amount - consumed) * 100) / 100,
            uses: adv.uses.map((u) => ({
              refNo: u.refNo,
              amount: toNum(String(u.amount)),
              date: u.date.toISOString(),
            })),
          });
        }
        if (v) {
          voucherNo = v.voucherNo;
          payment = [
            v.bankPartyId && nameById.get(v.bankPartyId),
            v.chequeNo && `No. ${v.chequeNo}`,
            v.chequeDate && formatDate(v.chequeDate.toISOString()),
          ]
            .filter(Boolean)
            .join(" | ");
        }
      } else if (e.refType === "OFFICE_TXN") {
        const o = officeById.get(e.refId);
        if (o) {
          voucherNo = o.voucherNo;
          payment = [
            o.bankPartyId && nameById.get(o.bankPartyId),
            o.paymentMode ?? "CREDIT",
          ]
            .filter(Boolean)
            .join(" | ");
        }
      }

      return {
        date: e.date.toISOString(),
        party:
          (e.partyId && nameById.get(e.partyId)) ||
          (e.accountHeadId && headNameById.get(e.accountHeadId)) ||
          "",
        account: counterAccount(e),
        refType: e.refType,
        refNo: e.refNo,
        link: drillLink(e.refType, e.refId, voucherNo),
        voucherNo,
        payment,
        vehicle: (e.vehicleId && vehicleNoById.get(e.vehicleId)) || "",
        narration: e.narration ?? "",
        adjustments,
        debit,
        credit,
        balance: trackRunning
          ? `${Math.abs(Math.round(running * 100) / 100).toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ${running >= 0 ? "Dr" : "Cr"}`
          : "",
      };
    });
    // zero-value ADV ADJUSTMENT rows, merged into date order. Balance stays
    // blank on them — the money was already counted on the advance entry.
    const adjRows: ReportRow[] = adjUses
      .filter((u) => matchesRef(u.refNo))
      .filter(
        (u) =>
          !params.narration ||
          `adjusted from advance ${u.advance.voucherNo ?? ""}`
            .toLowerCase()
            .includes(params.narration.trim().toLowerCase())
      )
      .filter((u) => {
        const amt = toNum(String(u.amount));
        if (params.amtFrom != null && amt < params.amtFrom) return false;
        if (params.amtTo != null && amt > params.amtTo) return false;
        return true;
      })
      .map((u) => ({
        date: u.date.toISOString(),
        party: (u.advance.partyId && nameById.get(u.advance.partyId)) || "",
        account: `Advance ${u.advance.voucherNo ?? "—"}`,
        refType: "ADV ADJUSTMENT",
        refNo: u.refNo,
        link: "",
        voucherNo: u.advance.voucherNo ?? "",
        payment: "",
        vehicle: "",
        narration: `₹${toNum(String(u.amount)).toLocaleString("en-IN")} settled from advance ${u.advance.voucherNo ?? "—"} — no ledger movement, money moved with the advance`,
        adjustments: "",
        debit: null,
        credit: null,
        balance: "",
      }));
    const bodyRows = adjRows.length
      ? [...rows, ...adjRows].sort((a, b) => String(a.date).localeCompare(String(b.date)))
      : rows;
    // counter-account / voucher-number filters apply to entry rows only; the
    // opening row stays. Running balances are the ledger's true figures at
    // each entry, so a filtered list still reads correctly.
    const counters = Array.from(new Set(bodyRows.map((r) => String(r.account ?? "")).filter(Boolean))).sort();
    const vq = params.voucherNo?.trim().toLowerCase();
    const filteredBody =
      params.counter || vq
        ? bodyRows.filter(
            (r) =>
              (!params.counter || r.account === params.counter) &&
              (!vq || String(r.voucherNo ?? "").toLowerCase().includes(vq))
          )
        : bodyRows;
    // the opening row stays pinned first, whatever the dates say
    const mergedRows = openingRow ? [openingRow, ...filteredBody] : filteredBody;

    // a row settling several documents carries them comma-joined — the
    // dropdown offers each individual reference, exact-match ready
    const refNoTokens = Array.from(
      new Set(
        refNoRows.flatMap((r) => (r.refNo ?? "").split(",").map((t) => t.trim()).filter(Boolean))
      )
    ).sort();
    return {
      rows: mergedRows,
      parties,
      heads,
      vehicles: scopedVehicleIds ? vehicles.filter((v) => scopedVehicleIds.has(v.id)) : vehicles,
      refTypes: refTypeGroups.map((g) => g.refType).sort(),
      refNos: refNoTokens,
      counters,
    };
  });
}

export const BOOK_COLUMNS = [
  { key: "date", header: "Date", kind: "date" as const },
  // which vehicle generated the entry — blank for non-vehicle transactions
  { key: "vehicle", header: "Vehicle No" },
  { key: "party", header: "Ledger" },
  // the counter-ledger(s) of the same posting — where the entry came from
  { key: "account", header: "Account" },
  { key: "refType", header: "Ref Type" },
  // clicking the reference opens the source document (chalan, slip, invoice,
  // loan, voucher register...) when a route exists for it
  { key: "refNo", header: "Reference No", linkBase: "/", linkParamKey: "link" },
  { key: "voucherNo", header: "Voucher No" },
  { key: "payment", header: "Bank / Instrument" },
  { key: "narration", header: "Narration" },
  { key: "adjustments", header: "Adjustments", kind: "adjustments" as const },
  { key: "debit", header: "Debit", kind: "money" as const },
  { key: "credit", header: "Credit", kind: "money" as const },
  { key: "balance", header: "Balance" },
];
