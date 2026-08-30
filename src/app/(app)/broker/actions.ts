"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { Prisma } from "@prisma/client";
import { requireSession } from "@/lib/session";
import { withTenant } from "@/lib/db";
import { authorize } from "@/lib/authz";
import { audit } from "@/lib/audit";
import { assertDateInFy } from "@/lib/fy-guard";
import { tripLockError } from "@/lib/trip-lock";
import { nextDocNumber, syncSequenceTo } from "@/lib/sequences";
import { ensureAccountHead, postLedger, reverseLedger } from "@/lib/ledger";
import { toNum } from "@/lib/utils";
import { round2 } from "@/lib/calc/tds";
import { payableSettlement, settledByRef } from "@/lib/settlement";
import {
  applyManualAdvanceUses,
  listOpenAdvances,
  restoreAdvanceUses,
  type OpenAdvance,
} from "@/lib/party-advance";
import { raiseShortage, recoverShortage, releaseShortage } from "@/lib/shortage";
import {
  ADVANCE_TYPES,
  advanceAmount,
  computeBrokerSide,
  computeTripKm,
  sideAdvanceTotal,
  type BrokerAdvance,
} from "@/components/broker/broker-calc";

const rateBasisSchema = z.enum(["QTY", "ACTUAL_WT", "CHARGE_WT", "FIXED"]);

const advanceSchema = z.object({
  side: z.enum(["P", "V"]),
  type: z.enum(ADVANCE_TYPES),
  headKind: z.enum(["INCOME", "EXPENSE", "BANK", "CASH"]).nullish(),
  headId: z.string().nullish(),
  supplierName: z.string().nullish(),
  bankName: z.string().nullish(),
  dieselQty: z.number().min(0).nullish(),
  dieselRate: z.number().min(0).nullish(),
  amount: z.number().min(0).default(0),
  date: z.string().nullish(), // ISO yyyy-mm-dd
  remarks: z.string().nullish(),
  advanceId: z.string().nullish(),
  advanceVoucherNo: z.string().nullish(),
});

/** Ledger refType for the relative-owner expense transfer. */
const EXP_TRANSFER_REF = "BROKER_SLIP_EXP_TRANSFER";
/**
 * PartyAdvanceUse refTypes — one per side, so adjusting on the broker side
 * never clobbers what the owner side consumed. The broker side may only use
 * advances RECEIVED from him; the owner side only advances PAID to him.
 */
const ADV_USE_P = "BROKER_SLIP_ADV_ADJ_P";
const ADV_USE_V = "BROKER_SLIP_ADV_ADJ_V";

/**
 * Open advance vouchers for one side of a broker slip. Same engine the
 * Voucher Entry and chalan screens use, so a balance consumed anywhere is
 * immediately gone everywhere.
 */
export async function getBrokerSlipAdvances(
  partyId: string,
  side: "P" | "V",
  slipId?: string | null
): Promise<OpenAdvance[]> {
  const session = requireSession();
  if (!partyId) return [];
  return withTenant(session.tenantId, (tx) =>
    listOpenAdvances(tx, {
      firmId: session.firmId,
      fyId: session.fyId,
      partyId,
      kinds: side === "P" ? ["RECEIVED"] : ["PAID"],
      includeRefType: side === "P" ? ADV_USE_P : ADV_USE_V,
      includeRefId: slipId ?? undefined,
    })
  );
}

const sideSchema = {
  rate: z.number().min(0).default(0),
  freight: z.number().min(0).default(0), // manual freight (editable)
  detention: z.number().min(0).default(0),
  odcAmt: z.number().min(0).default(0),
  fineAmt: z.number().min(0).default(0),
  ldCharge: z.number().min(0).default(0),
  shortageAmt: z.number().min(0).default(0),
  tdsPct: z.number().min(0).default(0),
  tdsAmt: z.number().min(0).default(0),
  commPct: z.number().min(0).default(0),
  commAmt: z.number().min(0).default(0),
  mamool: z.number().min(0).default(0),
  paymentCharge: z.number().min(0).default(0),
  remarks: z.string().nullish(),
};

const brokerSlipSchema = z.object({
  id: z.string().nullish(),
  slipNo: z.string().trim().min(1, "Slip number is required"),
  slipDate: z.string().min(1, "Slip date is required"), // ISO yyyy-mm-dd
  vehicleId: z.string().nullish(),
  transporterId: z.string().nullish(),
  loadStationId: z.string().nullish(),
  destCityId: z.string().nullish(),
  consignorId: z.string().nullish(),
  consigneeId: z.string().nullish(),
  lrNo: z.string().nullish(),
  lrDate: z.string().nullish(),
  ewbNo: z.string().nullish(),
  ewbDate: z.string().nullish(),
  productId: z.string().nullish(),
  productName: z.string().nullish(),
  qty: z.number().min(0).default(0),
  actualWt: z.number().min(0).default(0),
  chargeWt: z.number().min(0).default(0),
  unit: z.string().default("MT"),
  rateBasis: rateBasisSchema.default("CHARGE_WT"), // legacy shared basis
  pRateBasis: rateBasisSchema.default("CHARGE_WT"),
  vRateBasis: rateBasisSchema.default("CHARGE_WT"),

  // party side
  partyId: z.string().nullish(),
  p: z.object(sideSchema),

  // owner side
  ownerId: z.string().nullish(),
  ownerName: z.string().nullish(),
  v: z.object(sideSchema),

  advances: z.array(advanceSchema).default([]),

  // trip km
  startKm: z.number().min(0).nullish(),
  unloadDate: z.string().nullish(),
  unloadKm: z.number().min(0).nullish(),
  unloadRemarks: z.string().nullish(),
});

export type SaveBrokerSlipResult = { ok: true; id: string } | { ok: false; error: string };

function toDate(s: string): Date {
  return new Date(s.includes("T") ? s : `${s}T00:00:00`);
}

export async function saveBrokerSlip(input: unknown): Promise<SaveBrokerSlipResult> {
  const session = requireSession();
  const parsed = brokerSlipSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid input" };
  }
  const data = parsed.data;
  await authorize(session, "broker", data.id ? "edit" : "create");

  // never trust client totals — recompute everything server-side
  const advances: BrokerAdvance[] = data.advances.map((a) => ({
    ...a,
    amount: advanceAmount(a as BrokerAdvance),
  }));
  const pAdvance = sideAdvanceTotal(advances, "P");
  const vAdvance = sideAdvanceTotal(advances, "V");

  const base = {
    qty: data.qty,
    actualWt: data.actualWt,
    chargeWt: data.chargeWt,
  };
  const pTotals = computeBrokerSide({
    ...base,
    rateBasis: data.pRateBasis,
    rate: data.p.rate,
    manualFreight: data.p.freight,
    detention: data.p.detention,
    odcAmt: data.p.odcAmt,
    fineAmt: data.p.fineAmt,
    ldCharge: data.p.ldCharge,
    shortageAmt: data.p.shortageAmt,
    tdsPct: data.p.tdsPct,
    tdsAmtManual: data.p.tdsAmt,
    commPct: data.p.commPct,
    commAmtManual: data.p.commAmt,
    mamool: data.p.mamool,
    paymentCharge: data.p.paymentCharge,
    advance: pAdvance,
  });
  const vTotals = computeBrokerSide({
    ...base,
    rateBasis: data.vRateBasis,
    rate: data.v.rate,
    manualFreight: data.v.freight,
    detention: data.v.detention,
    odcAmt: data.v.odcAmt,
    fineAmt: data.v.fineAmt,
    ldCharge: data.v.ldCharge,
    shortageAmt: data.v.shortageAmt,
    tdsPct: data.v.tdsPct,
    tdsAmtManual: data.v.tdsAmt,
    commPct: data.v.commPct,
    commAmtManual: data.v.commAmt,
    mamool: data.v.mamool,
    paymentCharge: data.v.paymentCharge,
    advance: vAdvance,
  });

  const slipDate = toDate(data.slipDate);
  const unloadDate = data.unloadDate ? toDate(data.unloadDate) : null;
  const km = computeTripKm({
    startKm: data.startKm ?? null,
    unloadKm: data.unloadKm ?? null,
    slipDate,
    unloadDate,
  });

  const slipData = {
    slipNo: data.slipNo,
    slipDate,
    vehicleId: data.vehicleId || null,
    transporterId: data.transporterId || null,
    loadStationId: data.loadStationId || null,
    destCityId: data.destCityId || null,
    consignorId: data.consignorId || null,
    consigneeId: data.consigneeId || null,
    lrNo: data.lrNo || null,
    lrDate: data.lrDate ? toDate(data.lrDate) : null,
    ewbNo: data.ewbNo || null,
    ewbDate: data.ewbDate ? toDate(data.ewbDate) : null,
    productId: data.productId || null,
    productName: data.productName || null,
    qty: data.qty,
    actualWt: data.actualWt,
    chargeWt: data.chargeWt,
    unit: data.unit || "MT",
    rateBasis: data.rateBasis,
    pRateBasis: data.pRateBasis,
    vRateBasis: data.vRateBasis,

    // the receivable side IS the broker selected in the slip header —
    // no separate party selection (falls back to any legacy partyId)
    partyId: data.transporterId || data.partyId || null,
    pRate: data.p.rate,
    pFreight: pTotals.freight,
    pDetention: data.p.detention,
    pOdcAmt: data.p.odcAmt,
    pFineSlip: data.p.fineAmt,
    pLdCharge: data.p.ldCharge,
    pShortageAmt: data.p.shortageAmt,
    pTdsPct: data.p.tdsPct,
    pTdsAmt: pTotals.tdsAmt,
    pCommPct: data.p.commPct,
    pCommAmt: pTotals.commAmt,
    pMamool: data.p.mamool,
    pPaymentCharge: data.p.paymentCharge,
    pChalanAmt: pTotals.chalanAmt,
    pNetAmt: pTotals.netAmt,
    pAdvance,
    pBalance: pTotals.balance,
    pRemarks: data.p.remarks || null,

    ownerId: data.ownerId || null,
    ownerName: data.ownerName || null,
    vRate: data.v.rate,
    vFreight: vTotals.freight,
    vDetention: data.v.detention,
    vOdcAmt: data.v.odcAmt,
    vFineAmt: data.v.fineAmt,
    vLdCharge: data.v.ldCharge,
    vShortageAmt: data.v.shortageAmt,
    vTdsPct: data.v.tdsPct,
    vTdsAmt: vTotals.tdsAmt,
    vCommPct: data.v.commPct,
    vCommAmt: vTotals.commAmt,
    vMamool: data.v.mamool,
    vPaymentAmt: data.v.paymentCharge,
    vChalanAmt: vTotals.chalanAmt,
    vNetAmt: vTotals.netAmt,
    vAdvance,
    vBalance: vTotals.balance,
    vRemarks: data.v.remarks || null,

    advances: advances as unknown as Prisma.InputJsonValue,

    startKm: data.startKm ?? null,
    unloadDate,
    unloadKm: data.unloadKm ?? null,
    runningKm: km.runningKm,
    tripDays: km.tripDays,
    unloadRemarks: data.unloadRemarks || null,
  };

  try {
    const id = await withTenant(session.tenantId, async (tx) => {
      // the slip being edited — ANY year's slip opens from here (FY
      // continuity); the guard below keeps its date inside the slip's OWN year
      const editBefore = data.id
        ? await tx.brokerSlip.findFirst({
            where: { id: data.id, firmId: session.firmId },
          })
        : null;
      if (data.id && !editBefore) throw new Error("Broker slip not found");
      if (editBefore?.deletedAt) throw new Error("Broker slip has been deleted");
      // an edit stays in the slip's own financial year — date guard, ledger
      // legs and shortage entries all keep that year's stamp
      const docFyId = editBefore?.fyId ?? session.fyId;
      const docSession = { ...session, fyId: docFyId };
      // wrong-FY guard: the date must belong to the document's own FY
      await assertDateInFy(tx, { fyId: docFyId }, slipDate, "broker slip entry");
      let savedId: string;
      if (data.id && editBefore) {
        const before = editBefore;
        // a financially settled side's money story is frozen: with a balance
        // settlement or voucher allocation against it, changing the figures
        // would strand the recorded settlement against amounts that no longer
        // exist (mirrors the chalan guard)
        const voucherSettled =
          (
            await settledByRef(tx, {
              firmId: session.firmId,
              fyId: session.fyId,
              refTypes: ["BROKER_ENTRY"],
              refIds: [data.id],
            })
          ).get(data.id) ?? 0;
        const pFrozen = before.pPaymentStatus === "RECEIVED";
        const vFrozen = before.vPaymentStatus === "PAID" || voucherSettled > 0.009;
        if (
          (pFrozen && round2(pTotals.balance) !== round2(toNum(before.pBalance))) ||
          (vFrozen && round2(vTotals.balance) !== round2(toNum(before.vBalance)))
        ) {
          throw new Error(
            "This slip already has payments/settlements recorded against it — its amounts cannot be changed. Reverse the payment (or delete the settling voucher) first."
          );
        }
        const updated = await tx.brokerSlip.update({ where: { id: data.id }, data: slipData });
        savedId = updated.id;
        await audit(tx, session, {
          entity: "BrokerSlip",
          entityId: savedId,
          action: "UPDATE",
          before,
          after: updated,
        });
      } else {
        const created = await tx.brokerSlip.create({
          data: {
            tenantId: session.tenantId,
            firmId: session.firmId,
            fyId: session.fyId,
            createdById: session.userId,
            ...slipData,
          },
        });
        savedId = created.id;
        await audit(tx, session, {
          entity: "BrokerSlip",
          entityId: savedId,
          action: "CREATE",
          after: created,
        });
      }

      await syncSequenceTo(tx, {
        tenantId: session.tenantId,
        firmId: session.firmId,
        fyId: session.fyId,
        docType: "BROKER_SLIP",
        savedNumber: data.slipNo,
      });

      // manual advance-voucher adjustments, per side. Restored before being
      // re-applied so an edit never double-counts against a voucher's balance,
      // and direction-checked so the broker side can only consume advances
      // received and the owner side only advances paid.
      let stampedVoucherNos = false;
      for (const [side, refType, partyId] of [
        ["P", ADV_USE_P, slipData.partyId],
        ["V", ADV_USE_V, slipData.ownerId],
      ] as const) {
        const lines = advances
          .filter((a) => a.type === "ADVANCE_ADJ" && a.side === side && a.amount > 0)
          .map((a) => ({ advanceId: a.advanceId ?? "", amount: a.amount }));
        if (lines.some((l) => !l.advanceId)) {
          throw new Error("Select an advance voucher for every adjustment row.");
        }
        if (!lines.length) {
          await restoreAdvanceUses(tx, refType, savedId);
          continue;
        }
        if (!partyId) {
          throw new Error(
            `Select the ${side === "P" ? "broker" : "owner"} before adjusting an advance on that side.`
          );
        }
        const applied = await applyManualAdvanceUses(tx, {
          tenantId: session.tenantId,
          firmId: session.firmId,
          // stamped into the slip's own year — old-slip edits stay put
          fyId: docFyId,
          partyId,
          kinds: side === "P" ? ["RECEIVED"] : ["PAID"],
          refType,
          refId: savedId,
          refNo: data.slipNo,
          date: slipDate,
          lines,
        });
        // stamp the voucher number back for display / print
        const noOf = new Map(applied.map((x) => [x.advanceId, x.voucherNo]));
        for (const a of advances) {
          if (a.type === "ADVANCE_ADJ" && a.side === side && a.advanceId) {
            a.advanceVoucherNo = noOf.get(a.advanceId) ?? a.advanceVoucherNo ?? null;
            stampedVoucherNos = true;
          }
        }
      }
      // the row was written before the voucher numbers were resolved
      if (stampedVoucherNos) {
        await tx.brokerSlip.update({
          where: { id: savedId },
          data: { advances: advances as unknown as Prisma.InputJsonValue },
        });
      }

      // ledger: accrue both sides of the slip and post its advances —
      // re-posted on every save so edits stay in sync
      await reverseLedger(tx, "BROKER_SLIP", savedId);
      await reverseLedger(tx, "BROKER_SLIP_ADVANCE", savedId);
      const entries: Parameters<typeof postLedger>[2] = [];
      const accrualCommon = {
        date: slipDate,
        refType: "BROKER_SLIP",
        refId: savedId,
        refNo: data.slipNo,
      };
      const tag = `broker slip ${data.slipNo}`;

      // Post every component on its own line, exactly like the chalan module,
      // so the ledger shows how the receivable / payable was arrived at rather
      // than one opaque net figure. Each side nets to its own `netAmt`, which
      // is what computeBrokerSide returns.
      //
      // Broker side is a RECEIVABLE: earnings debit the broker against an
      // income head, deductions credit him back against an expense head.
      // Owner side is the mirror — a PAYABLE.
      const line = async (
        partyId: string,
        label: string,
        amount: number,
        headName: string,
        headKind: "INCOME" | "EXPENSE",
        partySide: "DEBIT" | "CREDIT"
      ) => {
        if (amount <= 0) return;
        const headId = await ensureAccountHead(tx, session, headName, headKind);
        entries.push(
          { ...accrualCommon, partyId, side: partySide, amount, narration: `${label} — ${tag}` },
          {
            ...accrualCommon,
            accountHeadId: headId,
            side: partySide === "DEBIT" ? "CREDIT" : "DEBIT",
            amount,
            narration: `${label} — ${tag}`,
          }
        );
      };

      if (slipData.partyId) {
        const pid = slipData.partyId;
        await line(pid, "Freight", pTotals.freight, "Freight Income", "INCOME", "DEBIT");
        await line(pid, "Detention", data.p.detention, "Detention Income", "INCOME", "DEBIT");
        await line(pid, "ODC", data.p.odcAmt, "ODC Income", "INCOME", "DEBIT");
        await line(pid, "Fine slip", data.p.fineAmt, "Fine Slip Income", "INCOME", "DEBIT");
        await line(pid, "LD charge", data.p.ldCharge, "LD Charge Allowed", "EXPENSE", "CREDIT");
        // shortage posts only the party leg; the register posts the matching
        // entry on the one common Shortage ledger
        if (data.p.shortageAmt > 0) {
          entries.push({
            ...accrualCommon,
            partyId: pid,
            side: "CREDIT",
            amount: data.p.shortageAmt,
            narration: `Shortage — ${tag}`,
          });
        }
        await line(pid, "TDS", pTotals.tdsAmt, "TDS Receivable", "EXPENSE", "CREDIT");
        await line(pid, "Commission", pTotals.commAmt, "Commission Allowed", "EXPENSE", "CREDIT");
        await line(pid, "Mamool", data.p.mamool, "Mamool Allowed", "EXPENSE", "CREDIT");
        await line(pid, "Payment charge", data.p.paymentCharge, "Payment Charges", "EXPENSE", "CREDIT");
      }

      if (slipData.ownerId) {
        const oid = slipData.ownerId;
        await line(oid, "Lorry hire", vTotals.freight, "Lorry Hire Expense", "EXPENSE", "CREDIT");
        await line(oid, "Detention", data.v.detention, "Detention Charges", "EXPENSE", "CREDIT");
        await line(oid, "ODC", data.v.odcAmt, "ODC Charges", "EXPENSE", "CREDIT");
        await line(oid, "Fine slip", data.v.fineAmt, "Fine Slip Charges", "EXPENSE", "CREDIT");
        await line(oid, "LD charge", data.v.ldCharge, "LD Charge Recovered", "INCOME", "DEBIT");
        if (data.v.shortageAmt > 0) {
          entries.push({
            ...accrualCommon,
            partyId: oid,
            side: "DEBIT",
            amount: data.v.shortageAmt,
            narration: `Shortage deducted — ${tag}`,
          });
        }
        await line(oid, "TDS", vTotals.tdsAmt, "TDS Payable", "INCOME", "DEBIT");
        await line(oid, "Commission", vTotals.commAmt, "Commission Income", "INCOME", "DEBIT");
        await line(oid, "Mamool", data.v.mamool, "Mamool Recovered", "INCOME", "DEBIT");
        await line(oid, "Payment charge", data.v.paymentCharge, "Payment Charges Recovered", "INCOME", "DEBIT");
      }
      // Expense-head settlement on the BROKER side is the purchase itself:
      // "Diesel Expense Dr / Broker Cr". The broker supplied diesel worth the
      // amount instead of paying it, so his receivable drops by exactly that.
      // If the vehicle belongs to a RELATIVE the expense was consumed by that
      // relative's vehicle, so it is transferred on to him afterwards
      // ("Relative Owner Dr / Diesel Expense Cr"), leaving the expense head at
      // zero and the owner's payable reduced. A company vehicle keeps the
      // expense — nothing further to do.
      const isRelativeVehicle = slipData.vehicleId
        ? (await tx.vehicle.findUnique({ where: { id: slipData.vehicleId } }))?.ownershipType ===
          "RELATIVE"
        : false;
      const transferEntries: Parameters<typeof postLedger>[2] = [];

      for (const a of advances) {
        // an adjustment consumes an existing advance voucher — a reference
        // link, not a transaction, so it posts nothing (see applyAdvanceUses)
        if (a.type === "ADVANCE_ADJ") continue;
        if (a.amount <= 0 || !a.headId) continue;
        const counterPartyId = a.side === "P" ? slipData.partyId : slipData.ownerId;
        if (!counterPartyId) continue;
        const headLeg =
          a.headKind === "BANK" || a.headKind === "CASH"
            ? { partyId: a.headId }
            : { accountHeadId: a.headId };
        const advCommon = {
          date: a.date ? toDate(a.date) : slipDate,
          refType: "BROKER_SLIP_ADVANCE",
          refId: savedId,
          refNo: data.slipNo,
          narration: `${a.type.replace(/_/g, " ")} advance (${a.side === "P" ? "received" : "paid"}) — broker slip ${data.slipNo}${a.remarks ? " — " + a.remarks : ""}`,
        };
        // side P: advance received from the party (money in — debit head);
        // side V: advance paid to the owner (money out — credit head)
        entries.push(
          {
            ...advCommon,
            ...headLeg,
            side: a.side === "P" ? "DEBIT" : "CREDIT",
            amount: a.amount,
          },
          {
            ...advCommon,
            partyId: counterPartyId,
            side: a.side === "P" ? "CREDIT" : "DEBIT",
            amount: a.amount,
          }
        );

        // relative vehicle: pass a broker-side expense head on to the owner.
        // Owner-side heads already debit the owner directly, so transferring
        // those too would charge him twice.
        if (
          a.side === "P" &&
          a.headKind === "EXPENSE" &&
          isRelativeVehicle &&
          slipData.ownerId
        ) {
          const tCommon = {
            date: a.date ? toDate(a.date) : slipDate,
            refType: EXP_TRANSFER_REF,
            refId: savedId,
            refNo: data.slipNo,
            narration: `${a.bankName || a.type.replace(/_/g, " ")} transferred to relative owner — ${tag}`,
          };
          transferEntries.push(
            { ...tCommon, partyId: slipData.ownerId, side: "DEBIT", amount: a.amount },
            { ...tCommon, accountHeadId: a.headId, side: "CREDIT", amount: a.amount }
          );
        }
      }
      // docSession: an old slip's re-posted legs stay stamped in ITS year
      await postLedger(tx, docSession, [...entries, ...transferEntries]);

      // Shortage register. The broker side reduces what the broker owes us, so
      // the company bears that loss — it is a shortage CHARGED. The owner side
      // reduces what we owe him, so it is RECOVERED from the owner.
      await releaseShortage(tx, "BROKER_SLIP", savedId);
      if (slipData.partyId && data.p.shortageAmt > 0) {
        await raiseShortage(tx, docSession, {
          date: slipDate,
          module: "BROKER_SLIP",
          refId: savedId,
          refNo: data.slipNo,
          partyKind: "BROKER",
          partyId: slipData.partyId,
          amount: data.p.shortageAmt,
          remarks: `Broker side of slip ${data.slipNo}`,
        });
      }
      if (slipData.ownerId && data.v.shortageAmt > 0) {
        await recoverShortage(tx, docSession, {
          date: slipDate,
          module: "BROKER_SLIP",
          refId: savedId,
          refNo: data.slipNo,
          source: "OWNER",
          partyId: slipData.ownerId,
          partyKind: "OWNER",
          amount: data.v.shortageAmt,
          remarks: `Deducted on owner side of slip ${data.slipNo}`,
        });
      }

      return savedId;
    });

    revalidatePath("/broker/register");
    return { ok: true, id };
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
      return { ok: false, error: "Slip number already exists" };
    }
    return { ok: false, error: err instanceof Error ? err.message : "Failed to save broker slip" };
  }
}

export async function deleteBrokerSlip(
  id: string
): Promise<{ ok: true } | { ok: false; error: string }> {
  const session = requireSession();
  if (session.role !== "ADMIN" && session.role !== "OWNER") {
    return { ok: false, error: "Only Admin/Owner may delete broker slips" };
  }
  await authorize(session, "broker", "delete");
  try {
    await withTenant(session.tenantId, async (tx) => {
      const before = await tx.brokerSlip.findFirst({
        where: { id, firmId: session.firmId },
      });
      if (!before) throw new Error("Broker slip not found");
      // chain lock: a slip inside a trip sheet's accounts goes only after the
      // trip releases it
      const tripGuard = await tripLockError(tx, "BROKER_SLIP", id, "broker slip");
      if (tripGuard) throw new Error(tripGuard);
      // a slip settled through a Payment Voucher must NEVER be deleted: the
      // voucher's debit and allocation would survive against a document that
      // no longer exists (mirrors the chalan delete guard)
      const voucherSettled =
        (
          await settledByRef(tx, {
            firmId: session.firmId,
            fyId: session.fyId,
            refTypes: ["BROKER_ENTRY"],
            refIds: [id],
          })
        ).get(id) ?? 0;
      if (voucherSettled > 0.009) {
        throw new Error(
          "This broker slip has already been settled through a voucher and cannot be deleted. Delete/reverse that voucher first."
        );
      }
      // party-side settlements are mirrored as Receipt vouchers (allocation
      // refType OTHERS) — those must go first too, or their legs would orphan
      const anyAlloc = await tx.voucherAllocation.findFirst({
        where: { refId: id, voucher: { deletedAt: null, firmId: session.firmId } },
      });
      if (anyAlloc) {
        throw new Error(
          "A settlement voucher references this slip — delete that voucher from the Voucher Register first."
        );
      }
      await tx.brokerSlip.update({ where: { id }, data: { deletedAt: new Date() } });
      await reverseLedger(tx, "BROKER_SLIP", id);
      await reverseLedger(tx, "BROKER_SLIP_ADVANCE", id);
      await reverseLedger(tx, "BROKER_SLIP_RECEIVED", id);
      await reverseLedger(tx, "BROKER_SLIP_PAID", id);
      await reverseLedger(tx, EXP_TRANSFER_REF, id);
      // release every advance voucher this slip had consumed, both sides
      await restoreAdvanceUses(tx, ADV_USE_P, id);
      await restoreAdvanceUses(tx, ADV_USE_V, id);
      await releaseShortage(tx, "BROKER_SLIP", id);
      await releaseShortage(tx, "BROKER_SLIP", `${id}:P`);
      await releaseShortage(tx, "BROKER_SLIP", `${id}:V`);
      await audit(tx, session, { entity: "BrokerSlip", entityId: id, action: "DELETE", before });
    });
    revalidatePath("/broker/register");
    return { ok: true };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : "Failed to delete broker slip",
    };
  }
}

// ------------------------------------------------------------- POD attached flag

/**
 * Informational only: marks that the POD has been handed over / shared.
 * Not linked to unload date, POD workflow, billing or payments.
 */
export async function setBrokerSlipPodAttached(
  id: string,
  attached: boolean
): Promise<{ ok: true } | { ok: false; error: string }> {
  const session = requireSession();
  await authorize(session, "broker", "edit");
  try {
    await withTenant(session.tenantId, async (tx) => {
      const before = await tx.brokerSlip.findFirst({ where: { id, deletedAt: null } });
      if (!before) throw new Error("Broker slip not found");
      await tx.brokerSlip.update({ where: { id }, data: { podAttached: attached } });
      await audit(tx, session, {
        entity: "BrokerSlip",
        entityId: id,
        action: "UPDATE",
        before,
        after: { podAttached: attached },
      });
    });
    revalidatePath("/broker/register");
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "Update failed" };
  }
}

// ------------------------------------------------------------- balance received / paid

const brokerBalancePaymentSchema = z.object({
  slipId: z.string().min(1),
  /** P = broker/party side (balance RECEIVED), V = owner side (balance PAID) */
  side: z.enum(["P", "V"]),
  roundOff: z.number().default(0),
  shortage: z.number().min(0).default(0),
  paymentDate: z.string().min(1, "Payment date is required"),
  paymentHeadId: z.string().min(1, "Payment head (bank/cash) is required"),
  paymentMode: z.enum(["CASH", "BANK", "CARD", "UPI", "CHEQUE", "NEFT_RTGS"]).default("BANK"),
  remarks: z.string().optional().nullable(),
});

/**
 * Settle a broker slip balance — mirrors the chalan balance payment (same
 * ledger behaviour), but with NO dependency on POD status / POD attached:
 * - side P: balance received from the broker/party — money IN
 *   (debit the bank/cash head, credit the party)
 * - side V: balance paid to the owner — money OUT
 *   (credit the bank/cash head, debit the owner party)
 */
export async function saveBrokerBalancePayment(
  input: unknown
): Promise<{ ok: true; paidAmount: number } | { ok: false; error: string }> {
  const session = requireSession();
  await authorize(session, "broker", "edit");
  const parsed = brokerBalancePaymentSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid input" };
  }
  const data = parsed.data;
  try {
    return await withTenant(session.tenantId, async (tx) => {
      const slip = await tx.brokerSlip.findFirst({
        where: { id: data.slipId, firmId: session.firmId, deletedAt: null },
      });
      if (!slip) return { ok: false as const, error: "Broker slip not found." };

      const gross = toNum(String(data.side === "P" ? slip.pBalance : slip.vBalance));
      // the owner side shares one outstanding with the Payment Voucher, so a
      // slip already part-paid there must not be settled twice here
      let balance = gross;
      if (data.side === "V") {
        const pos = await payableSettlement(tx, {
          firmId: session.firmId,
          fyId: session.fyId,
          refType: "BROKER_ENTRY",
          docs: [{ id: slip.id, balance: gross, ownPaid: 0, ownShortage: 0, ownRoundOff: 0 }],
        });
        balance = Math.round((gross - (pos.get(slip.id)?.voucherSettled ?? 0)) * 100) / 100;
      }
      const paidAmount = Math.round((balance - data.roundOff - data.shortage) * 100) / 100;
      if (paidAmount < 0) {
        return {
          ok: false as const,
          error:
            balance < gross
              ? `Round-off + shortage exceed the ${balance} still open (the rest was settled by a payment voucher).`
              : "Round-off + shortage exceed the balance.",
        };
      }
      const paymentDate = new Date(`${data.paymentDate}T00:00:00`);
      // the settlement voucher is stamped into the SESSION FY — a back-dated
      // payment date would land it in the wrong year's registers and exports
      await assertDateInFy(tx, session, paymentDate, "balance settlement");
      const refType = data.side === "P" ? "BROKER_SLIP_RECEIVED" : "BROKER_SLIP_PAID";
      const counterPartyId = data.side === "P" ? slip.partyId : slip.ownerId;
      // money legs need BOTH sides — without a counterparty the bank leg
      // would post alone and the books go off by the paid amount
      if (!counterPartyId) {
        return {
          ok: false as const,
          error:
            data.side === "P"
              ? "No party/transporter is set on the slip — add the party to the slip first, then settle."
              : "No owner is set on the slip — add the owner to the slip first, then settle.",
        };
      }

      // RE-SETTLEMENT of the party side replaces the earlier mirror voucher:
      // reverse and retire it first, or every "Update Balance Receipt" would
      // stack another full-value receipt (double bank + party entries)
      if (data.side === "P") {
        const oldAllocs = await tx.voucherAllocation.findMany({
          where: {
            refId: slip.id,
            remarks: "BROKER_SLIP_P_SETTLEMENT",
            voucher: { deletedAt: null, firmId: session.firmId },
          },
          select: { voucherId: true },
        });
        for (const oldId of Array.from(new Set(oldAllocs.map((a) => a.voucherId)))) {
          await reverseLedger(tx, "VOUCHER", oldId);
          await releaseShortage(tx, "BROKER_SLIP", `${slip.id}:P:${oldId}`);
          await tx.voucher.update({ where: { id: oldId }, data: { deletedAt: new Date() } });
        }
      }

      // The settlement is a REAL voucher (Receipt on the party side, Payment
      // on the owner side) so it shows in the Voucher Register and can be
      // deleted from there — deleting reopens this side of the slip.
      // Owner side: the voucher allocation (BROKER_ENTRY) IS the settlement,
      // so the slip's own v-money fields stay 0 (payableSettlement would
      // double-count otherwise). Party side: the slip's p-fields remain the
      // record; the voucher mirrors it (allocation refType OTHERS + marker,
      // counted by no settlement query).
      let voucherId: string | null = null;
      if (paidAmount > 0.009 || data.shortage > 0.009 || Math.abs(data.roundOff) > 0.009) {
        const voucherNo = await nextDocNumber(tx, {
          tenantId: session.tenantId,
          firmId: session.firmId,
          fyId: session.fyId,
          docType: data.side === "P" ? "VOUCHER_RECEIPT" : "VOUCHER_PAYMENT",
        });
        const entryType =
          data.paymentMode === "CASH" ? "CASH" : data.paymentMode === "CARD" ? "CARD" : "BANK";
        const voucher = await tx.voucher.create({
          data: {
            tenantId: session.tenantId,
            firmId: session.firmId,
            fyId: session.fyId,
            createdById: session.userId,
            voucherNo,
            voucherDate: paymentDate,
            type: data.side === "P" ? "RECEIPT" : "PAYMENT",
            entryType,
            moduleLink: "BROKER_ENTRY",
            partyId: counterPartyId,
            bankPartyId: data.paymentHeadId,
            // module semantics: amount = GROSS (cash + shortage), netAmount =
            // cash moved — the register Net column and Tally read these
            amount: Math.round((paidAmount + data.shortage) * 100) / 100,
            deduction: data.shortage,
            netAmount: paidAmount,
            remarks: `Balance ${data.side === "P" ? "received" : "paid"} — broker slip ${slip.slipNo}${data.remarks ? " — " + data.remarks : ""}`,
            allocations: {
              create: [
                {
                  tenantId: session.tenantId,
                  refType: data.side === "P" ? "OTHERS" : "BROKER_ENTRY",
                  refId: slip.id,
                  refNo: slip.slipNo,
                  billAmt: gross,
                  amount: paidAmount,
                  deduction: data.shortage,
                  roundOff: data.roundOff,
                  // markers: settlement vouchers are delete-and-redo, never
                  // edited from the register
                  remarks:
                    data.side === "P" ? "BROKER_SLIP_P_SETTLEMENT" : "BROKER_SLIP_V_SETTLEMENT",
                },
              ],
            },
          },
        });
        voucherId = voucher.id;
      }

      const fields =
        data.side === "P"
          ? {
              pPaymentStatus: "RECEIVED",
              pRoundOff: data.roundOff,
              pShortage: data.shortage,
              pPaidAmount: paidAmount,
              pPaymentDate: paymentDate,
              pPaymentHeadId: data.paymentHeadId,
              pPaymentMode: data.paymentMode,
              pPaymentRemarks: data.remarks || null,
            }
          : {
              vPaymentStatus: "PAID",
              vRoundOff: 0,
              vShortage: 0,
              vPaidAmount: 0,
              vPaymentDate: paymentDate,
              vPaymentHeadId: data.paymentHeadId,
              vPaymentMode: data.paymentMode,
              vPaymentRemarks: data.remarks || null,
            };
      const after = await tx.brokerSlip.update({ where: { id: slip.id }, data: fields });

      await reverseLedger(tx, refType, slip.id);
      // legs hang off the voucher, so deleting it from the register reverses
      // exactly this settlement
      const common = {
        date: paymentDate,
        refType: voucherId ? "VOUCHER" : refType,
        refId: voucherId ?? slip.id,
        refNo: slip.slipNo,
      };
      if (paidAmount > 0) {
        await postLedger(tx, session, [
          {
            ...common,
            partyId: data.paymentHeadId,
            // money in on receive (debit head), money out on pay (credit head)
            side: data.side === "P" ? ("DEBIT" as const) : ("CREDIT" as const),
            amount: paidAmount,
            narration:
              data.side === "P"
                ? `Balance received against broker slip ${slip.slipNo} (${data.paymentMode})`
                : `Balance paid against broker slip ${slip.slipNo} (${data.paymentMode})`,
          },
          ...(counterPartyId
            ? [
                {
                  ...common,
                  partyId: counterPartyId,
                  side: data.side === "P" ? ("CREDIT" as const) : ("DEBIT" as const),
                  amount: paidAmount,
                  narration: `Broker slip ${slip.slipNo} balance ${
                    data.side === "P" ? "received" : "paid"
                  }${data.remarks ? " — " + data.remarks : ""}`,
                },
              ]
            : []),
        ]);
      }

      // Shortage and round-off deducted at settlement previously posted
      // NOTHING, so the counterparty stayed on the books for money that never
      // moved and the slip could never close. Both post now — shortage through
      // the register, round-off to its own head.
      // LEGACY-era artifacts only — voucher-era shortage rows are keyed per
      // voucher (`:P/V:<voucherId>`) so re-settlement or an unrelated
      // voucher's delete can never destroy a live voucher's recovery
      await releaseShortage(tx, "BROKER_SLIP", `${slip.id}:${data.side}`);
      const settleRef = voucherId
        ? `${slip.id}:${data.side}:${voucherId}`
        : `${slip.id}:${data.side}`;
      const extras: Parameters<typeof postLedger>[2] = [];
      if (counterPartyId && Math.abs(data.roundOff) > 0.009) {
        // a negative round-off means a little extra moved, so the legs flip
        // (mirrors the chalan balance payment)
        const signed = data.roundOff;
        const amount = Math.abs(signed);
        const roundHeadId = await ensureAccountHead(tx, session, "Round Off", "INCOME");
        const baseSide = data.side === "P" ? "CREDIT" : "DEBIT";
        const partySide =
          signed > 0 ? baseSide : baseSide === "CREDIT" ? "DEBIT" : "CREDIT";
        extras.push(
          {
            ...common,
            partyId: counterPartyId,
            side: partySide,
            amount,
            narration: `Round off ${signed > 0 ? "deducted" : "added"} at balance settlement — broker slip ${slip.slipNo}`,
          },
          {
            ...common,
            accountHeadId: roundHeadId,
            side: partySide === "CREDIT" ? "DEBIT" : "CREDIT",
            amount,
            narration: `Round off — broker slip ${slip.slipNo}`,
          }
        );
      }
      if (counterPartyId && data.shortage > 0.009) {
        extras.push({
          ...common,
          partyId: counterPartyId,
          side: data.side === "P" ? "CREDIT" : "DEBIT",
          amount: data.shortage,
          narration: `Shortage — broker slip ${slip.slipNo}`,
        });
      }
      if (extras.length) await postLedger(tx, session, extras);
      if (counterPartyId && data.shortage > 0.009) {
        // party side: the broker paid us less, so the company bears it.
        // owner side: we paid him less, so it is recovered from him.
        const common2 = {
          date: paymentDate,
          module: "BROKER_SLIP" as const,
          refId: settleRef,
          refNo: slip.slipNo,
          amount: data.shortage,
          remarks: `Deducted at balance settlement of slip ${slip.slipNo}`,
        };
        if (data.side === "P") {
          await raiseShortage(tx, session, {
            ...common2,
            partyKind: "BROKER",
            partyId: counterPartyId,
          });
        } else {
          await recoverShortage(tx, session, {
            ...common2,
            source: "OWNER",
            partyKind: "OWNER",
            partyId: counterPartyId,
          });
        }
      }

      await audit(tx, session, {
        entity: "BrokerSlip",
        entityId: slip.id,
        action: "UPDATE",
        before: slip,
        after,
      });
      revalidatePath("/broker/register");
      return { ok: true as const, paidAmount };
    });
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "Balance payment failed" };
  }
}

// ------------------------------------------------------------- POD file upload

/** Attach an uploaded POD file to a broker slip (file already stored via /api/uploads/pod). */
export async function setBrokerSlipPodFile(
  id: string,
  filePath: string,
  fileName: string
): Promise<{ ok: true } | { ok: false; error: string }> {
  const session = requireSession();
  await authorize(session, "broker", "edit");
  if (!filePath.startsWith(`${session.tenantId}/`)) {
    return { ok: false, error: "Invalid file path." };
  }
  try {
    await withTenant(session.tenantId, async (tx) => {
      const before = await tx.brokerSlip.findFirst({ where: { id, deletedAt: null } });
      if (!before) throw new Error("Broker slip not found");
      await tx.brokerSlip.update({
        where: { id },
        data: {
          podFilePath: filePath,
          podFileName: fileName,
          podUploadDate: new Date(),
          podAttached: true,
        },
      });
      await audit(tx, session, {
        entity: "BrokerSlip",
        entityId: id,
        action: "UPDATE",
        before,
        after: { podFilePath: filePath, podFileName: fileName },
      });
    });
    revalidatePath("/broker/register");
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "Upload failed" };
  }
}
