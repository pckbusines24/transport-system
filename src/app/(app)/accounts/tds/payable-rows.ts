import type { Tx } from "@/lib/db";
import { toNum } from "@/lib/utils";
import { round2 } from "@/lib/calc/tds";

/** So a nil deduction reads as a deliberate outcome, not a missing row. */
export const tdsStatus = (amt: number) => (amt > 0.009 ? "DEDUCTED" : "NOT DEDUCTED");

/**
 * One PAYABLE TDS transaction row. `baseAmt` is the amount the TDS was
 * actually computed on — the FREIGHT / lorry hire, never the document total.
 * Detention, ODC, fine slip, other, LD charge and shortage are settlement
 * adjustments and are excluded by `@/lib/calc/tds-base`, so `invoiceAmount`
 * (the gross the party was paid on) and `baseAmt` legitimately differ.
 * Rows with no recorded base (journal adjustments, header-only voucher TDS)
 * carry 0 so no figure is ever invented.
 */
export type TdsPayableRow = {
  date: string; // ISO
  module: string;
  section: string;
  /** stable party link — display/grouping uses the name, but any per-party
   *  filtering must use this id (names can collide or be renamed) */
  partyId: string | null;
  party: string;
  pan: string;
  refNo: string;
  vehicleNo: string;
  invoiceAmount: number | null;
  baseAmt: number;
  tdsPct: number;
  tdsAmt: number;
  net: number | null;
  status: string;
  remarks: string;
};

/**
 * TDS PAYABLE rows — TDS OUR company deducts while MAKING payments.
 * Sources: Chalan (owner payment side), Broker Slip (owner payment side),
 * Hire Slip (Less: TDS at entry), PAYMENT vouchers, and JOURNAL vouchers
 * that touch the TDS Payable ledger.
 * Receipt vouchers and everything receivable-side NEVER appear here.
 *
 * This is THE row source for the TDS Payable Register and the quarterly
 * report alike — both must call it rather than re-deriving, so they can
 * never disagree.
 *
 * Journal rows are derived live from the LEDGER entries posted against the
 * common "TDS Payable" head — the same entries an edit re-posts and a delete
 * removes — so the register and the ledger can never disagree and no
 * duplicate tracking is needed. A credit raises the liability (TDS deducted
 * via journal); a debit reduces it and shows as a negative amount.
 */
export async function buildTdsPayableRows(
  tx: Tx,
  session: { firmId: string; fyId: string },
  dateWhere?: { gte?: Date; lte?: Date }
): Promise<{
  rows: TdsPayableRow[];
  parties: { id: string; name: string; pan: string | null }[];
  sectionCodes: string[];
}> {
  // date filter beats FY (FY continuity): an old-year date range pulls that
  // year's TDS rows without switching FY
  const scope = {
    firmId: session.firmId,
    ...(dateWhere ? {} : { fyId: session.fyId }),
    deletedAt: null,
  };
  // TDS applies only to hired vehicles. A company-owned vehicle is our own
  // asset — there is no payee to deduct from, so it never belongs here.
  // RELATIVE vehicles stay IN deliberately, even though the payables register
  // hides their freight: the government must still be told about TDS deducted
  // on a relative's chalan — only the PAYMENT of that freight settles through
  // the relative owner's ledger instead of the payables register.
  const allVehicles = await tx.vehicle.findMany({
    select: { id: true, number: true, ownershipType: true },
  });
  const vehicleNoById = new Map(allVehicles.map((v) => [v.id, v.number]));
  const vehNo = (id: string | null | undefined) => (id ? vehicleNoById.get(id) ?? "" : "");
  const ownVehicleIds = allVehicles
    .filter((v) => v.ownershipType === "OWNER")
    .map((v) => v.id);
  const notOwnVehicle = ownVehicleIds.length
    ? { vehicleId: { notIn: ownVehicleIds } }
    : {};

  const [payVouchers, chalans, slips, hireSlips, parties] = await Promise.all([
    // PAYMENT vouchers only — receipts must never appear in TDS Payable
    tx.voucher.findMany({
      where: {
        ...scope,
        type: "PAYMENT",
        ...(dateWhere ? { voucherDate: dateWhere } : {}),
        // a voucher against a company-owned vehicle is out too; one with no
        // vehicle at all cannot be ruled out, so it stays
        ...(ownVehicleIds.length
          ? { OR: [{ vehicleId: null }, { vehicleId: { notIn: ownVehicleIds } }] }
          : {}),
        AND: [
          { OR: [{ tdsAmt: { gt: 0 } }, { allocations: { some: { tdsAmt: { gt: 0 } } } }] },
        ],
      },
      include: { allocations: true },
    }),
    // Every TDS-ELIGIBLE chalan and broker slip, deducted or not. Filtering
    // on tdsAmt > 0 hid the zero-TDS ones, so there was no way to tell a
    // deliberate nil deduction from one that had simply been missed.
    tx.chalan.findMany({
      // cancelled chalans owe nothing, so no TDS arises on them
      where: { ...scope, cancelledAt: null, ...notOwnVehicle, ...(dateWhere ? { chalanDate: dateWhere } : {}) },
    }),
    tx.brokerSlip.findMany({
      where: {
        ...scope,
        ...notOwnVehicle,
        ...(dateWhere ? { slipDate: dateWhere } : {}),
        // only slips that actually have an owner side to deduct against
        OR: [{ ownerId: { not: null } }, { vNetAmt: { gt: 0 } }],
      },
    }),
    // hire slips record their TDS at entry ("Less: TDS") — that deduction is
    // as statutory as a chalan's and must reach the register / Form 26Q
    tx.hireSlip.findMany({
      where: {
        ...scope,
        ...(dateWhere ? { slipDate: dateWhere } : {}),
        // vehicleId is optional here; a missing vehicle cannot be ruled out
        ...(ownVehicleIds.length
          ? { OR: [{ vehicleId: null }, { vehicleId: { notIn: ownVehicleIds } }] }
          : {}),
      },
    }),
    tx.party.findMany({ select: { id: true, name: true, pan: true } }),
  ]);
  const partyById = new Map(parties.map((p) => [p.id, p]));

  // section labels come ONLY from the TDS Master's freight-module ticks —
  // chalan, broker slip and hire references. Everything else stays blank
  // (no head-based guessing).
  const tdsSections = await tx.tdsSection.findMany({ where: { deletedAt: null } });
  const moduleSection = new Map<string, string>();
  for (const s of tdsSections) for (const m of s.moduleRefs) moduleSection.set(m, s.code);
  const allocSection = (a: { refType: string }): string => {
    if (a.refType === "FREIGHT_CHALLAN") return moduleSection.get("CHALAN") ?? "";
    if (a.refType === "BROKER_ENTRY") return moduleSection.get("BROKER_SLIP") ?? "";
    if (a.refType === "LORRY_HIRE") return moduleSection.get("HIRE") ?? "";
    return "";
  };

  // journal vouchers that touched the TDS Payable ledger head
  const tdsHeads = await tx.accountHead.findMany({
    where: { name: "TDS Payable" },
    select: { id: true },
  });
  const tdsLedger = tdsHeads.length
    ? await tx.ledgerEntry.findMany({
        where: {
          firmId: session.firmId,
          ...(dateWhere ? { date: dateWhere } : { fyId: session.fyId }),
          refType: "VOUCHER",
          accountHeadId: { in: tdsHeads.map((h) => h.id) },
        },
      })
    : [];
  const journals = tdsLedger.length
    ? await tx.voucher.findMany({
        where: {
          id: { in: Array.from(new Set(tdsLedger.map((e) => e.refId))) },
          type: "JOURNAL",
          deletedAt: null,
        },
      })
    : [];
  const journalById = new Map(journals.map((v) => [v.id, v]));

  // TDS taken at PAYMENT time against a document (voucher allocation), keyed
  // by the document id — a chalan/slip whose own tdsAmt is 0 but whose TDS was
  // deducted on the payment voucher is DEDUCTED, not a missed deduction
  const voucherTdsByRef = new Map<string, number>();
  for (const v of payVouchers)
    for (const a of v.allocations) {
      const tds = toNum(String(a.tdsAmt));
      if (tds > 0.009)
        voucherTdsByRef.set(a.refId, round2((voucherTdsByRef.get(a.refId) ?? 0) + tds));
    }

  const out: TdsPayableRow[] = [];
  for (const e of tdsLedger) {
    const v = journalById.get(e.refId);
    if (!v) continue; // payment/receipt vouchers already have their own rows
    const p =
      (v.partyId && partyById.get(v.partyId)) ||
      (v.bankPartyId && partyById.get(v.bankPartyId)) ||
      undefined;
    // credit = liability raised (deducted); debit = paid off / reversed
    const signedAmt = e.side === "CREDIT" ? toNum(String(e.amount)) : -toNum(String(e.amount));
    out.push({
      date: e.date.toISOString(),
      module: "JOURNAL VOUCHER",
      section: "",
      partyId: p?.id ?? null,
      party: p?.name ?? "",
      pan: p?.pan ?? "",
      refNo: v.voucherNo,
      vehicleNo: vehNo(v.vehicleId),
      invoiceAmount: toNum(String(v.amount)),
      // a journal adjusts the TDS ledger directly; no base was recorded, and
      // inventing one from the journal value would overstate the base totals
      baseAmt: 0,
      tdsPct: 0,
      tdsAmt: signedAmt,
      net: toNum(String(v.netAmount)),
      status: tdsStatus(Math.abs(signedAmt)),
      remarks: e.narration ?? v.remarks ?? "",
    });
  }
  for (const v of payVouchers) {
    const p = v.partyId ? partyById.get(v.partyId) : undefined;
    const allocTds = v.allocations.filter((a) => toNum(String(a.tdsAmt)) > 0);
    if (allocTds.length) {
      for (const a of allocTds) {
        const pct = toNum(String(a.tdsPct));
        const tds = toNum(String(a.tdsAmt));
        const billAmt = toNum(String(a.billAmt));
        out.push({
          date: v.voucherDate.toISOString(),
          module: "PAYMENT VOUCHER",
          section: allocSection(a),
          partyId: p?.id ?? null,
          party: p?.name ?? "",
          pan: p?.pan ?? "",
          // for a chalan / slip the two are the same number; only a voucher
          // settling a bill has a distinct reference, so name both there
          refNo: a.refNo && a.refNo !== v.voucherNo ? `${a.refNo} (${v.voucherNo})` : v.voucherNo,
          vehicleNo: vehNo(v.vehicleId),
          // voucher rows carry only the TDS figure — bill/net stay blank
          invoiceAmount: null,
          // the bill amount recorded on the allocation is what the entry
          // screen computed the TDS from; when it was not captured, the
          // recorded pct recovers it rather than guessing from the invoice
          baseAmt: billAmt > 0.009 ? billAmt : pct > 0 ? round2((tds * 100) / pct) : 0,
          tdsPct: pct,
          tdsAmt: tds,
          net: null,
          status: tdsStatus(tds),
          remarks: a.remarks ?? v.remarks ?? "",
        });
      }
    } else if (toNum(String(v.tdsAmt)) > 0) {
      out.push({
        date: v.voucherDate.toISOString(),
        module: "PAYMENT VOUCHER",
        section: "",
        partyId: p?.id ?? null,
        party: p?.name ?? "",
        pan: p?.pan ?? "",
        refNo: v.voucherNo,
        vehicleNo: vehNo(v.vehicleId),
        invoiceAmount: null,
        // header-only TDS records no rate and no bill — base stays unknown
        baseAmt: 0,
        tdsPct: 0,
        tdsAmt: toNum(String(v.tdsAmt)),
        net: null,
        status: tdsStatus(toNum(String(v.tdsAmt))),
        remarks: v.remarks ?? "",
      });
    }
  }
  // when a document's own TDS is 0 but the deduction happened on its payment
  // voucher, the document row is DEDUCTED (the voucher row carries the amount)
  // — before this, the register's "without TDS" count sent an auditor chasing
  // deductions that had in fact been taken at payment
  const docStatus = (ownTds: number, refId: string) => {
    const atPayment = voucherTdsByRef.get(refId) ?? 0;
    return tdsStatus(round2(ownTds + atPayment));
  };
  const docRemarks = (own: string | null | undefined, ownTds: number, refId: string) => {
    const atPayment = ownTds <= 0.009 && (voucherTdsByRef.get(refId) ?? 0) > 0.009;
    if (!atPayment) return own ?? "";
    return own ? `${own} · TDS deducted at payment voucher` : "TDS deducted at payment voucher";
  };
  for (const c of chalans) {
    const p = partyById.get(c.brokerId);
    const ownTds = toNum(String(c.tdsAmt));
    out.push({
      date: c.chalanDate.toISOString(),
      module: "CHALLAN (OWNER)",
      section: moduleSection.get("CHALAN") ?? "",
      partyId: c.brokerId,
      party: p?.name ?? "",
      pan: p?.pan ?? "",
      refNo: c.chalanNo,
      vehicleNo: vehNo(c.vehicleId),
      invoiceAmount: toNum(String(c.totalChalanAmt)),
      // TDS base is the FREIGHT alone — the adjustments folded into
      // totalChalanAmt (detention, ODC, fine, other, LD, shortage) are never
      // taxed, so the register must not show them as the base either
      baseAmt: toNum(String(c.freight)),
      tdsPct: toNum(String(c.tdsPct)),
      tdsAmt: ownTds,
      net: toNum(String(c.grandTotal)),
      status: docStatus(ownTds, c.id),
      remarks: docRemarks(c.remarks, ownTds, c.id),
    });
  }
  for (const s of slips) {
    const p = s.ownerId ? partyById.get(s.ownerId) : undefined;
    const ownTds = toNum(String(s.vTdsAmt));
    out.push({
      date: s.slipDate.toISOString(),
      module: "BROKER SLIP (OWNER)",
      section: moduleSection.get("BROKER_SLIP") ?? "",
      partyId: s.ownerId ?? null,
      party: p?.name ?? s.ownerName ?? "",
      pan: p?.pan ?? "",
      refNo: s.slipNo,
      vehicleNo: vehNo(s.vehicleId),
      invoiceAmount: toNum(String(s.vChalanAmt)),
      // owner-side freight only; vChalanAmt carries the adjustments
      baseAmt: toNum(String(s.vFreight)),
      tdsPct: toNum(String(s.vTdsPct)),
      tdsAmt: ownTds,
      net: toNum(String(s.vNetAmt)),
      status: docStatus(ownTds, s.id),
      remarks: docRemarks(s.vRemarks, ownTds, s.id),
    });
  }
  for (const h of hireSlips) {
    const gross = round2(
      toNum(String(h.lorryHire)) +
        toNum(String(h.loadingH)) +
        toNum(String(h.craneCharge)) +
        toNum(String(h.unloadingH)) +
        toNum(String(h.overHeightCharge)) +
        toNum(String(h.others))
    );
    const ownTds = toNum(String(h.lessTds));
    out.push({
      date: h.slipDate.toISOString(),
      module: "HIRE SLIP",
      section: moduleSection.get("HIRE") ?? "",
      // the hire slip stores the owner as free text, not a party link
      partyId: null,
      party: h.ownerName ?? "",
      pan: h.ownerPan ?? "",
      refNo: h.slipNo,
      vehicleNo: vehNo(h.vehicleId),
      invoiceAmount: gross,
      // "Less: TDS" is deducted from the slip's gross hire (hire + charges)
      baseAmt: gross,
      tdsPct: gross > 0 && ownTds > 0.009 ? round2((ownTds * 100) / gross) : 0,
      tdsAmt: ownTds,
      net: toNum(String(h.totalHire)),
      status: docStatus(ownTds, h.id),
      remarks: docRemarks(h.narration, ownTds, h.id),
    });
  }
  return {
    rows: out.sort((a, b) => a.date.localeCompare(b.date)),
    parties,
    sectionCodes: tdsSections.map((s) => s.code).sort(),
  };
}
