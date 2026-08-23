"use server";

import { revalidatePath } from "next/cache";

import { z } from "zod";
import { requireSession } from "@/lib/session";
import { withTenant, Tx } from "@/lib/db";
import { authorize } from "@/lib/authz";
import { audit } from "@/lib/audit";
import { assertDateInFy } from "@/lib/fy-guard";
import { tripLockError } from "@/lib/trip-lock";
import { nextDocNumber, syncSequenceTo } from "@/lib/sequences";
import { ensureAccountHead, postLedger, reverseLedger } from "@/lib/ledger";
import { computeChalan } from "@/lib/calc/chalan";
import { toNum } from "@/lib/utils";
import {
  applyManualAdvanceUses,
  listOpenAdvances,
  restoreAdvanceUses,
  type OpenAdvance,
} from "@/lib/party-advance";
import { invoiceSettlement, payableSettlement, settledByRef } from "@/lib/settlement";
import { round2 } from "@/lib/calc/tds";
import { recoverShortage, releaseShortage, releaseShortageRecoveries } from "@/lib/shortage";

/** Money figure for error messages. */
const formatOpen = (n: number) => (Math.round(n * 100) / 100).toLocaleString("en-IN");
import type { PendingLrRow } from "@/components/fleet/lr-picker";

/** PartyAdvanceUse refTypes — one per chalan section, so a save in one section
 *  never clobbers what the other section consumed. */
const ADV_USE_ADVANCE = "CHALAN_ADVANCE_ADJ";
const ADV_USE_BALANCE = "CHALAN_BALANCE_ADJ";
/**
 * Legacy ledger refType. An advance adjustment is NOT a financial transaction —
 * the advance voucher already moved the money and already debited the broker,
 * so adjusting it against a chalan is pure reference mapping and must not post
 * anything. Earlier builds posted a pair here, which double-debited the broker;
 * the refType survives only so those rows get reversed away on save / delete.
 */
const ADV_ADJ_REF = "ADVANCE_ADJUSTMENT";

/**
 * Open advance vouchers of a chalan's broker for manual voucher-wise
 * adjustment. Only advances we PAID the broker qualify — a chalan settles
 * money owed to him, so an advance received from him is never adjustable here.
 * `section` decides which of this chalan's own uses are added back to the
 * available balance.
 */
export async function getBrokerAdvances(
  brokerId: string,
  chalanId?: string | null,
  section: "ADVANCE" | "BALANCE" = "ADVANCE"
): Promise<OpenAdvance[]> {
  const session = requireSession();
  if (!brokerId) return [];
  return withTenant(session.tenantId, (tx) =>
    listOpenAdvances(tx, {
      firmId: session.firmId,
      fyId: session.fyId,
      partyId: brokerId,
      kinds: ["PAID"],
      includeRefType: section === "ADVANCE" ? ADV_USE_ADVANCE : ADV_USE_BALANCE,
      includeRefId: chalanId ?? undefined,
    })
  );
}

/** Pending LRs of a vehicle (no chalan yet, not cancelled). */
export async function getPendingLrsForVehicle(
  vehicleId: string,
  excludeChalanId?: string
): Promise<PendingLrRow[]> {
  const session = requireSession();
  const lrs = await withTenant(session.tenantId, (tx) =>
    tx.lr.findMany({
      where: {
        // FY continuity: a March LR with no chalan yet must still be offered
        // in April — pending work carries until it is done, whatever the year
        firmId: session.firmId,
        vehicleId,
        status: "PENDING",
        lrType: { notIn: ["CANCELLED", "PAPER_CHANGE"] },
        deletedAt: null,
        chalanLrs: excludeChalanId
          ? { none: { chalanId: { not: excludeChalanId } } }
          : { none: {} },
      },
      include: {
        items: true,
        chalanLrs: true,
      },
      orderBy: { lrDate: "asc" },
    })
  );
  const [cities, parties] = await withTenant(session.tenantId, (tx) =>
    Promise.all([tx.city.findMany(), tx.party.findMany()])
  );
  const cityName = (id: string) => cities.find((c) => c.id === id)?.name ?? "";
  const partyName = (id: string) => parties.find((p) => p.id === id)?.name ?? "";
  return lrs.map((lr) => ({
    id: lr.id,
    lrNo: lr.lrNo,
    lrDate: lr.lrDate.toISOString(),
    source: cityName(lr.sourceCityId),
    destination: cityName(lr.destCityId),
    consignor: partyName(lr.consignorId),
    qty: lr.items.reduce((s, i) => s + toNum(i.qty), 0),
    actualWt: lr.items.reduce((s, i) => s + toNum(i.actualWt), 0),
    chargeWt: lr.items.reduce((s, i) => s + toNum(i.chargeWt), 0),
    freight: toNum(lr.freight),
    rate: lr.items.length ? Math.max(...lr.items.map((i) => toNum(i.rate))) : 0,
    rateBasis: (lr.items.find((i) => toNum(i.rate) > 0)?.rateBasis ?? "CHARGE_WT") as
      | "QTY"
      | "ACTUAL_WT"
      | "CHARGE_WT"
      | "FIXED",
    remarks: lr.remarks ?? "",
  }));
}

/** Broker PAN + TDS mode for auto TDS pct. */
export async function getBrokerTdsInfo(partyId: string) {
  const session = requireSession();
  const p = await withTenant(session.tenantId, (tx) =>
    tx.party.findUnique({ where: { id: partyId } })
  );
  return { pan: p?.pan ?? null, tdsMode: p?.tdsMode ?? null };
}

const advanceSchema = z.object({
  type: z.enum([
    "CASH",
    "BANK",
    "DIESEL",
    "TOLL",
    "TYRE",
    "SPARE_PARTS",
    "REPAIR",
    "OTHER",
    "ADVANCE_ADJ",
  ]),
  advanceId: z.string().optional().nullable(),
  advanceVoucherNo: z.string().optional().nullable(),
  supplierName: z.string().optional().nullable(),
  bankName: z.string().optional().nullable(),
  bankPartyId: z.string().optional().nullable(),
  headId: z.string().optional().nullable(),
  dieselQty: z.number().min(0).optional().nullable(),
  dieselRate: z.number().min(0).optional().nullable(),
  amount: z.number().min(0).default(0),
  date: z.string().optional().nullable(),
  remarks: z.string().optional().nullable(),
});

const chalanSchema = z.object({
  id: z.string().optional().nullable(),
  chalanNo: z.string().min(1),
  chalanDate: z.string(),
  brokerId: z.string().min(1),
  vehicleId: z.string().min(1),
  driverName: z.string().optional().nullable(),
  driverMobile: z.string().optional().nullable(),
  licenseNo: z.string().optional().nullable(),
  payableAt: z.string().optional().nullable(),
  transportName: z.string().optional().nullable(),
  ownerName: z.string().optional().nullable(),
  remarks: z.string().optional().nullable(),
  lrIds: z.array(z.string()).min(1, "Select at least one LR — a chalan cannot be saved without LRs"),
  freight: z.number().min(0).default(0), // vehicle freight (manual fallback)
  rate: z.number().min(0).default(0),
  rateBasis: z.enum(["QTY", "ACTUAL_WT", "CHARGE_WT", "FIXED"]).default("CHARGE_WT"),
  detention: z.number().min(0).default(0),
  odcAmt: z.number().min(0).default(0),
  fineSlip: z.number().min(0).default(0),
  ldCharge: z.number().min(0).default(0),
  shortageAmt: z.number().min(0).default(0),
  otherAmt: z.number().min(0).default(0),
  otherRemarks: z.string().optional().nullable(),
  commissionPct: z.number().min(0).default(0),
  commissionAmt: z.number().min(0).default(0),
  mamool: z.number().min(0).default(0),
  courierCharge: z.number().min(0).default(0),
  tdsPct: z.number().min(0).default(0),
  // trip km
  startKm: z.number().optional().nullable(),
  unloadDate: z.string().optional().nullable(),
  unloadKm: z.number().optional().nullable(),
  unloadRemarks: z.string().optional().nullable(),
});

async function recomputeAndStore(
  tx: Tx,
  session: ReturnType<typeof requireSession>,
  data: z.infer<typeof chalanSchema>,
  advances: number[]
) {
  // never trust client LR ids: every LR must be a live document of THIS
  // firm/FY — a stale, deleted or foreign id must fail loudly, not load
  const lrs = await tx.lr.findMany({
    where: {
      // no FY filter: an LR carried from an earlier year may join this chalan
      id: { in: data.lrIds },
      firmId: session.firmId,
      deletedAt: null,
    },
    include: { items: true },
  });
  if (lrs.length !== new Set(data.lrIds).size) {
    throw new Error(
      "One or more selected LRs no longer exist in this firm/financial year — refresh and reselect."
    );
  }
  const blocked = lrs.find((l) => l.lrType === "CANCELLED" || l.lrType === "PAPER_CHANGE");
  if (blocked) {
    throw new Error(
      `LR ${blocked.lrNo} is ${blocked.lrType === "CANCELLED" ? "cancelled" : "a paper-change LR"} and cannot be loaded on a chalan.`
    );
  }
  // qty must come from the same source the form uses (sum of LR item qtys) —
  // defaulting it to 0 wiped the freight of every "Per Qty" chalan on save
  const qty = lrs.reduce((s, l) => s + l.items.reduce((a, i) => a + toNum(i.qty), 0), 0);
  const actualWt = lrs.reduce((s, l) => s + l.items.reduce((a, i) => a + toNum(i.actualWt), 0), 0);
  const chargeWt = lrs.reduce((s, l) => s + l.items.reduce((a, i) => a + toNum(i.chargeWt), 0), 0);
  const bookingFreight = lrs.reduce((s, l) => s + toNum(l.freight), 0);

  const totals = computeChalan({
    rate: data.rate,
    rateBasis: data.rateBasis,
    qty,
    actualWt,
    chargeWt,
    manualFreight: data.rate > 0 ? 0 : data.freight,
    detention: data.detention,
    odcAmt: data.odcAmt,
    fineSlip: data.fineSlip,
    otherAmt: data.otherAmt,
    ldCharge: data.ldCharge,
    shortageAmt: data.shortageAmt,
    mamool: data.mamool,
    courierCharge: data.courierCharge,
    commissionPct: data.commissionPct,
    commissionAmt: data.commissionAmt,
    tdsPct: data.tdsPct,
    advances,
  });

  const startKm = data.startKm ?? null;
  const unloadKm = data.unloadKm ?? null;
  const unloadDate = data.unloadDate ? new Date(data.unloadDate) : null;
  const runningKm = startKm != null && unloadKm != null ? unloadKm - startKm : null;
  const tripDays =
    unloadDate != null
      ? Math.max(
          0,
          Math.round(
            (unloadDate.getTime() - new Date(data.chalanDate).getTime()) / 86400000
          )
        )
      : null;

  return {
    fields: {
      chalanNo: data.chalanNo,
      chalanDate: new Date(data.chalanDate),
      brokerId: data.brokerId,
      vehicleId: data.vehicleId,
      driverName: data.driverName ?? null,
      driverMobile: data.driverMobile ?? null,
      licenseNo: data.licenseNo ?? null,
      payableAt: data.payableAt ?? null,
      transportName: data.transportName || null,
      ownerName: data.ownerName || null,
      remarks: data.remarks ?? null,
      actualWt,
      chargeWt,
      freight: totals.freight,
      rate: data.rate,
      rateBasis: data.rateBasis,
      bookingFreight,
      detention: data.detention,
      odcAmt: data.odcAmt,
      fineSlip: data.fineSlip,
      ldCharge: data.ldCharge,
      shortageAmt: data.shortageAmt,
      mamool: data.mamool,
      courierCharge: data.courierCharge,
      commissionPct: data.commissionPct,
      commissionAmt: totals.commissionAmt,
      tdsPct: data.tdsPct,
      tdsAmt: totals.tdsAmt,
      otherAmt: data.otherAmt,
      otherRemarks: data.otherRemarks ?? null,
      totalChalanAmt: totals.totalChalanAmt,
      grandTotal: totals.grandTotal,
      advanceTotal: totals.advanceTotal,
      balance: totals.balance,
      startKm,
      unloadDate,
      unloadKm,
      runningKm,
      tripDays,
      unloadRemarks: data.unloadRemarks ?? null,
    },
  };
}

/** Step-1 save (draft) — creates or updates the chalan and its LR links. */
export async function saveChalan(input: unknown): Promise<{ ok: true; id: string } | { ok: false; error: string }> {
  const session = requireSession();
  const parsed = chalanSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid input" };
  const data = parsed.data;
  await authorize(session, "chalan", data.id ? "edit" : "create");

  try {
    return await withTenant(session.tenantId, async (tx) => {
      const existing = data.id
        ? await tx.chalan.findFirst({
            where: { id: data.id, firmId: session.firmId, deletedAt: null },
            include: {
              advances: true,
              lrs: { include: { lr: { include: { invoiceLrs: true, pods: true } } } },
            },
          })
        : null;
      if (data.id && !existing) return { ok: false as const, error: "Chalan not found" };
      // a cancelled chalan owes nothing — editing it would re-post the accrual
      // behind the CANCELLED stamp; Restore it first
      if (existing?.cancelledAt) {
        return { ok: false as const, error: "This chalan is cancelled — restore it before editing." };
      }

      // duplicate chalan numbers are not allowed within a firm + financial year
      // wrong-FY guard: a chalan's own date must belong to the session FY
      await assertDateInFy(tx, session, new Date(data.chalanDate), "chalan entry");
      const clash = await tx.chalan.findFirst({
        where: {
          // chalan numbers CONTINUE across financial years, so uniqueness is
          // firm-wide — last year's 498 blocks a new 498 this year
          firmId: session.firmId,
          chalanNo: data.chalanNo,
          deletedAt: null,
          ...(data.id ? { id: { not: data.id } } : {}),
        },
        select: { id: true },
      });
      if (clash) {
        return { ok: false as const, error: `Chalan No ${data.chalanNo} already exists — use a different number.` };
      }
      // the DB unique constraint counts soft-deleted chalans too — surface a
      // clear message instead of a raw constraint error at insert time
      const deletedHolder = await tx.chalan.findFirst({
        where: {
          firmId: session.firmId,
          chalanNo: data.chalanNo,
          deletedAt: { not: null },
          ...(data.id ? { id: { not: data.id } } : {}),
        },
        select: { id: true },
      });
      if (deletedHolder) {
        return {
          ok: false as const,
          error: `Chalan No ${data.chalanNo} belongs to a deleted chalan and cannot be reused — use a different number.`,
        };
      }

      // an LR can ride only ONE live chalan — a second link would accrue the
      // same hire twice
      if (data.lrIds.length) {
        const otherLinks = await tx.chalanLr.findMany({
          where: {
            lrId: { in: data.lrIds },
            ...(data.id ? { chalanId: { not: data.id } } : {}),
          },
          include: {
            chalan: { select: { chalanNo: true, deletedAt: true, cancelledAt: true } },
            lr: { select: { lrNo: true } },
          },
        });
        const live = otherLinks.find((l) => !l.chalan.deletedAt && !l.chalan.cancelledAt);
        if (live) {
          return {
            ok: false as const,
            error: `LR ${live.lr.lrNo} is already loaded on chalan ${live.chalan.chalanNo} — one LR rides one chalan.`,
          };
        }
      }

      const advances = existing?.advances.map((a) => toNum(a.amount)) ?? [];
      const { fields } = await recomputeAndStore(tx, session, data, advances);

      // a financially settled chalan's money story is frozen: with a balance
      // payment or voucher allocation against it, changing the totals would
      // strand the recorded settlement against figures that no longer exist
      if (existing) {
        const ownSettled = round2(
          toNum(existing.balPaidAmount) +
            toNum(existing.balShortage) +
            toNum(existing.balRoundOff) +
            toNum(existing.balAdvanceAdjusted)
        );
        const voucherSettled =
          (
            await settledByRef(tx, {
              firmId: session.firmId,
              fyId: session.fyId,
              refTypes: ["FREIGHT_CHALLAN"],
              refIds: [existing.id],
            })
          ).get(existing.id) ?? 0;
        if (
          round2(ownSettled + voucherSettled) > 0.009 &&
          (round2(fields.grandTotal) !== round2(toNum(existing.grandTotal)) ||
            data.brokerId !== existing.brokerId)
        ) {
          return {
            ok: false as const,
            error:
              "This chalan already has payments/settlements recorded against it — its amounts and broker cannot be changed. Reverse the payment (or delete the settling voucher) first.",
          };
        }
        // saved advances are posted against (and consumed from) the CURRENT
        // broker — switching brokers underneath them would leave his ledger
        // debited for advances that now belong to someone else
        if (data.brokerId !== existing.brokerId && existing.advances.length > 0) {
          return {
            ok: false as const,
            error:
              "This chalan has saved advances posted against its broker — the broker cannot be changed. Remove the advances first, then change the broker and re-enter them.",
          };
        }
      }

      // LRs removed by this edit must not stay ON_CHALAN forever — a billed
      // one cannot leave at all, the rest return to their correct status
      const removedLrs = existing
        ? existing.lrs.filter((l) => !data.lrIds.includes(l.lrId))
        : [];
      const removedBilled = removedLrs.find(
        (l) => l.lr.invoiceLrs.length > 0 || l.lr.status === "BILLED"
      );
      if (removedBilled) {
        return {
          ok: false as const,
          error: `LR ${removedBilled.lr.lrNo} is already billed — delete its bill before removing it from this chalan.`,
        };
      }

      let id: string;
      if (existing) {
        await tx.chalan.update({ where: { id: existing.id }, data: fields });
        await tx.chalanLr.deleteMany({ where: { chalanId: existing.id } });
        id = existing.id;
      } else {
        const created = await tx.chalan.create({
          data: {
            tenantId: session.tenantId,
            firmId: session.firmId,
            fyId: session.fyId,
            createdById: session.userId,
            ...fields,
          },
        });
        id = created.id;
      }
      if (data.lrIds.length) {
        await tx.chalanLr.createMany({
          data: data.lrIds.map((lrId) => ({ tenantId: session.tenantId, chalanId: id, lrId })),
        });
      }
      // removed LRs leave the chalan properly: back to PENDING (or DELIVERED
      // when a POD exists) instead of being stranded ON_CHALAN with no chalan
      for (const l of removedLrs) {
        if (l.lr.lrType === "CANCELLED" || l.lr.lrType === "PAPER_CHANGE") continue;
        await tx.lr.update({
          where: { id: l.lrId },
          data: { status: l.lr.pods.length ? "DELIVERED" : "PENDING" },
        });
      }
      // an already-final chalan keeps its LR set consistent — LRs added by
      // this edit go ON_CHALAN now (finalize only runs once)
      if (existing?.isFinal && data.lrIds.length) {
        await tx.lr.updateMany({
          where: { id: { in: data.lrIds } },
          data: { status: "ON_CHALAN" },
        });
      }
      // ledger accrual: hire expense vs broker/owner payable — the advances and
      // balance payment then debit the broker against this credit
      await reverseLedger(tx, "CHALAN", id);
      // Every component of the settlement posts on its own line so the ledger
      // shows exactly how the payable was arrived at, instead of one opaque
      // net figure. Earnings credit the broker against an expense head;
      // deductions debit him back against a recovery / income head. The two
      // sides net to grandTotal, which is what computeChalan produces.
      const common = {
        date: fields.chalanDate,
        refType: "CHALAN",
        refId: id,
        refNo: fields.chalanNo,
      };
      const entries: Parameters<typeof postLedger>[2] = [];
      const tag = `chalan ${fields.chalanNo}`;

      const earning = async (label: string, amount: number, headName: string) => {
        if (amount <= 0) return;
        const headId = await ensureAccountHead(tx, session, headName, "EXPENSE");
        entries.push(
          { ...common, accountHeadId: headId, side: "DEBIT", amount, narration: `${label} — ${tag}` },
          {
            ...common,
            partyId: fields.brokerId,
            side: "CREDIT",
            amount,
            narration: `${label} payable — ${tag}`,
          }
        );
      };
      const deduction = async (label: string, amount: number, headName: string) => {
        if (amount <= 0) return;
        const headId = await ensureAccountHead(tx, session, headName, "INCOME");
        entries.push(
          {
            ...common,
            partyId: fields.brokerId,
            side: "DEBIT",
            amount,
            narration: `${label} deducted — ${tag}`,
          },
          { ...common, accountHeadId: headId, side: "CREDIT", amount, narration: `${label} — ${tag}` }
        );
      };

      await earning("Lorry hire", fields.freight, "Lorry Hire Expense");
      await earning("Detention", fields.detention, "Detention Charges");
      await earning("ODC", fields.odcAmt, "ODC Charges");
      await earning("Fine slip", fields.fineSlip, "Fine Slip Charges");
      await earning("Other charges", fields.otherAmt, "Other Chalan Charges");

      await deduction("LD charge", fields.ldCharge, "LD Charge Recovered");
      // shortage is only the party leg here — the shortage register posts the
      // matching credit to the one common Shortage ledger and records the
      // recovery, so the settlement report can trace it
      if (fields.shortageAmt > 0) {
        entries.push({
          ...common,
          partyId: fields.brokerId,
          side: "DEBIT",
          amount: fields.shortageAmt,
          narration: `Shortage deducted — ${tag}`,
        });
      }
      await deduction("Commission", fields.commissionAmt, "Commission Income");
      await deduction("TDS", fields.tdsAmt, "TDS Payable");
      await deduction("Mamool", fields.mamool, "Mamool Recovered");
      await deduction("Courier", fields.courierCharge, "Courier Recovered");

      await postLedger(tx, session, entries);
      // recovered from the owner: his payable dropped by the shortage.
      // FULL teardown first (not just the recoveries): editing the shortage
      // down to zero must also remove the recovery's ledger credit and the
      // auto-raised entry, or a phantom open shortage survives the edit
      await releaseShortage(tx, "CHALAN", id);
      if (fields.shortageAmt > 0) {
        await recoverShortage(tx, session, {
          date: fields.chalanDate,
          module: "CHALAN",
          refId: id,
          refNo: fields.chalanNo,
          source: "OWNER",
          partyId: fields.brokerId,
          partyKind: "OWNER",
          amount: fields.shortageAmt,
          remarks: `Deducted from chalan ${fields.chalanNo}`,
        });
      }
      await audit(tx, session, {
        entity: "Chalan",
        entityId: id,
        action: existing ? "UPDATE" : "CREATE",
        before: existing ?? undefined,
        after: fields,
      });
      return { ok: true as const, id };
    });
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Save failed" };
  }
}

/** Replace advances for a chalan and recompute advance total / balance. */
export async function saveChalanAdvances(
  chalanId: string,
  input: unknown
): Promise<{ ok: true } | { ok: false; error: string }> {
  const session = requireSession();
  await authorize(session, "chalan", "edit");
  const parsed = z.array(advanceSchema).safeParse(input);
  if (!parsed.success) return { ok: false, error: "Invalid advances" };
  const rows = parsed.data;

  try {
    return await withTenant(session.tenantId, async (tx) => {
      const chalan = await tx.chalan.findFirst({
        where: { id: chalanId, firmId: session.firmId, deletedAt: null },
      });
      if (!chalan) return { ok: false as const, error: "Chalan not found" };
      if (chalan.cancelledAt) {
        return { ok: false as const, error: "This chalan is cancelled — advances cannot be edited." };
      }
      // once the balance is settled (own payment or voucher), changing the
      // advances would move the balance under a frozen settlement
      const newAdvTotal = round2(rows.reduce((s, r) => s + r.amount, 0));
      const ownBalSettled = round2(
        toNum(chalan.balPaidAmount) +
          toNum(chalan.balShortage) +
          toNum(chalan.balRoundOff) +
          toNum(chalan.balAdvanceAdjusted)
      );
      const voucherBalSettled =
        (
          await settledByRef(tx, {
            firmId: session.firmId,
            fyId: session.fyId,
            refTypes: ["FREIGHT_CHALLAN"],
            refIds: [chalanId],
          })
        ).get(chalanId) ?? 0;
      if (
        round2(ownBalSettled + voucherBalSettled) > 0.009 &&
        newAdvTotal !== round2(toNum(chalan.advanceTotal))
      ) {
        return {
          ok: false as const,
          error:
            "This chalan's balance is already settled — advances cannot be changed now. Reverse the balance payment / settling voucher first.",
        };
      }

      // manual advance-voucher adjustments: every ADVANCE_ADJ row must name the
      // voucher it consumes, and the consumption is re-applied (restore first)
      // so an edit never double-counts against the voucher's balance
      const adjRows = rows.filter((r) => r.type === "ADVANCE_ADJ");
      if (adjRows.some((r) => !r.advanceId)) {
        return { ok: false as const, error: "Select an advance voucher for every adjustment row." };
      }
      const applied = await applyManualAdvanceUses(tx, {
        tenantId: session.tenantId,
        firmId: chalan.firmId,
        fyId: chalan.fyId,
        partyId: chalan.brokerId,
        kinds: ["PAID"],
        refType: ADV_USE_ADVANCE,
        refId: chalanId,
        refNo: chalan.chalanNo,
        // as-on reports date this adjustment by the CHALAN's date, so an
        // edit/re-save never rewrites history to the save wall-clock
        date: chalan.chalanDate,
        lines: adjRows.map((r) => ({ advanceId: r.advanceId as string, amount: r.amount })),
      });
      const voucherNoOf = new Map(applied.map((a) => [a.advanceId, a.voucherNo]));

      await tx.chalanAdvance.deleteMany({ where: { chalanId } });
      if (rows.length) {
        await tx.chalanAdvance.createMany({
          data: rows.map((r) => ({
            tenantId: session.tenantId,
            chalanId,
            type: r.type,
            advanceId: r.type === "ADVANCE_ADJ" ? r.advanceId ?? null : null,
            advanceVoucherNo:
              r.type === "ADVANCE_ADJ"
                ? voucherNoOf.get(r.advanceId ?? "") ?? r.advanceVoucherNo ?? null
                : null,
            supplierName: r.supplierName ?? null,
            bankName: r.bankName ?? null,
            bankPartyId: r.type === "BANK" ? r.bankPartyId ?? null : null,
            headId: r.type === "BANK" || r.type === "ADVANCE_ADJ" ? null : r.headId ?? null,
            dieselQty: r.dieselQty ?? null,
            dieselRate: r.dieselRate ?? null,
            amount: r.amount,
            date: r.date ? new Date(r.date) : null,
            remarks: r.remarks ?? null,
          })),
        });
      }
      const advanceTotal = rows.reduce((s, r) => s + r.amount, 0);
      const balance = toNum(chalan.grandTotal) - advanceTotal;
      await tx.chalan.update({ where: { id: chalanId }, data: { advanceTotal, balance } });

      // every advance debits the broker (recovered against the hire payable);
      // the credit side depends on the advance type:
      //   BANK  -> the selected bank party (bank book)
      //   CASH  -> the firm's cash party (cash book)
      //   head  -> the Income/Expense head the user chose
      //
      // The head case is an expense incurred ON THE OWNER'S BEHALF: the firm
      // already booked "Diesel Expense Dr / Supplier Cr" when it bought the
      // diesel, so adjusting it against the owner posts "Owner Dr / Diesel
      // Expense Cr". The expense head nets to zero and only the supplier stays
      // payable until the supplier is actually paid. Crediting an auto-created
      // "<Type> Advance (Chalan)" head instead — as this used to — left the
      // real expense sitting open forever.
      await reverseLedger(tx, "CHALAN_ADVANCE", chalanId);
      const cashParty = await tx.party.findFirst({
        where: { ledgerGroup: "CASH", isActive: true },
        orderBy: { name: "asc" },
        select: { id: true },
      });
      const entries: Parameters<typeof postLedger>[2] = [];
      const headLabel = new Map<(typeof rows)[number], string>();
      for (const r of rows) {
        if (r.amount <= 0) continue;
        // an adjustment posts nothing: the advance voucher already debited the
        // broker, so linking it to this chalan is reference mapping only
        if (r.type === "ADVANCE_ADJ") continue;
        let creditLeg: { partyId?: string; accountHeadId?: string } | null = null;
        if (r.type === "BANK") {
          creditLeg = r.bankPartyId ? { partyId: r.bankPartyId } : null;
        } else if (r.type === "CASH" && cashParty) {
          creditLeg = { partyId: cashParty.id };
        } else if (r.headId) {
          const head = await tx.accountHead.findFirst({ where: { id: r.headId } });
          if (!head) {
            return { ok: false as const, error: "Selected income / expense head not found" };
          }
          headLabel.set(r, head.name);
          creditLeg = { accountHeadId: head.id };
        } else {
          // legacy rows with no head chosen keep the old per-type fallback
          const label = r.type.charAt(0) + r.type.slice(1).toLowerCase().replace(/_/g, " ");
          const headId = await ensureAccountHead(
            tx,
            session,
            `${label} Advance (Chalan)`,
            "EXPENSE"
          );
          creditLeg = { accountHeadId: headId };
        }
        if (!creditLeg) continue;
        const date = r.date ? new Date(r.date) : chalan.chalanDate;
        const what =
          r.type === "BANK"
            ? "Bank"
            : r.type === "CASH"
              ? "Cash"
              : headLabel.get(r) ?? r.type.replace(/_/g, " ");
        const common = {
          date,
          refType: "CHALAN_ADVANCE",
          refId: chalanId,
          refNo: chalan.chalanNo,
          narration: `${what} adjusted against chalan ${chalan.chalanNo}${r.remarks ? " — " + r.remarks : ""}`,
        };
        entries.push(
          { ...common, ...creditLeg, side: "CREDIT", amount: r.amount },
          { ...common, partyId: chalan.brokerId, side: "DEBIT", amount: r.amount }
        );
      }
      await postLedger(tx, session, entries);
      // adjustments are reference links, not transactions — nothing is posted;
      // only stale rows from the earlier (incorrect) design are cleared
      await reverseLedger(tx, ADV_ADJ_REF, chalan.id);
      await audit(tx, session, {
        entity: "ChalanAdvance",
        entityId: chalanId,
        action: "UPDATE",
        after: rows,
      });
      return { ok: true as const };
    });
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Save failed" };
  }
}

/** Final save: isFinal=true, LRs -> ON_CHALAN, sequence synced. */
export async function finalizeChalan(
  chalanId: string
): Promise<{ ok: true } | { ok: false; error: string }> {
  const session = requireSession();
  await authorize(session, "chalan", "edit");
  try {
    return await withTenant(session.tenantId, async (tx) => {
      const chalan = await tx.chalan.findFirst({
        where: { id: chalanId, firmId: session.firmId, deletedAt: null },
        include: { lrs: true },
      });
      if (!chalan) return { ok: false as const, error: "Chalan not found" };
      await tx.chalan.update({ where: { id: chalanId }, data: { isFinal: true } });
      await tx.lr.updateMany({
        where: { id: { in: chalan.lrs.map((l) => l.lrId) } },
        data: { status: "ON_CHALAN" },
      });
      await syncSequenceTo(tx, {
        tenantId: session.tenantId,
        firmId: session.firmId,
        fyId: session.fyId,
        docType: "CHALAN",
        savedNumber: chalan.chalanNo,
      });
      await audit(tx, session, {
        entity: "Chalan",
        entityId: chalanId,
        action: "UPDATE",
        after: { isFinal: true },
      });
      return { ok: true as const };
    });
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Finalize failed" };
  }
}

/** Soft delete (ADMIN/OWNER); releases linked LRs back to PENDING. */
export async function deleteChalan(
  chalanId: string
): Promise<{ ok: true } | { ok: false; error: string }> {
  const session = requireSession();
  await authorize(session, "chalan", "delete");
  try {
    return await withTenant(session.tenantId, async (tx) => {
      const chalan = await tx.chalan.findFirst({
        where: { id: chalanId, firmId: session.firmId, deletedAt: null },
        include: { lrs: { include: { lr: { include: { invoiceLrs: true } } } } },
      });
      if (!chalan) return { ok: false as const, error: "Chalan not found" };

      // a billed LR must not be silently detached — the bill must go first
      const billed = chalan.lrs.find(
        (l) => l.lr.invoiceLrs.length > 0 || l.lr.status === "BILLED"
      );
      if (billed) {
        return {
          ok: false as const,
          error: `LR ${billed.lr.lrNo} is already billed. Delete its bill before deleting this chalan.`,
        };
      }

      // chain lock: a chalan sitting inside a trip sheet's hishab must not
      // vanish underneath it — the trip releases it first
      const tripGuard = await tripLockError(tx, "CHALAN", chalanId, "chalan");
      if (tripGuard) return { ok: false as const, error: tripGuard };

      // a chalan settled through a Payment Voucher must NEVER be deleted: the
      // voucher's debit and allocation would survive against a document that
      // no longer exists, driving the broker's ledger permanently negative
      const voucherSettled =
        (
          await settledByRef(tx, {
            firmId: session.firmId,
            fyId: session.fyId,
            refTypes: ["FREIGHT_CHALLAN"],
            refIds: [chalanId],
          })
        ).get(chalanId) ?? 0;
      if (voucherSettled > 0.009) {
        return {
          ok: false as const,
          error:
            "This chalan has already been settled through a voucher and cannot be deleted. Delete/reverse that voucher first.",
        };
      }

      // a cancelled chalan whose CHALAN_CANCEL advance was already consumed
      // (adjusted against another chalan / recovered) is part of the money
      // trail now — deleting it would orphan that consumption
      const cancelAdv = await tx.partyAdvance.findFirst({
        where: { source: "CHALAN_CANCEL", sourceRefId: chalanId, deletedAt: null },
      });
      if (cancelAdv && Number(cancelAdv.consumedAmount) > 0.009) {
        return {
          ok: false as const,
          error:
            "The cancellation advance of this chalan is already adjusted/recovered — remove that adjustment first.",
        };
      }

      const lrIds = chalan.lrs.map((l) => l.lrId);

      // cascade: remove PODs raised for these LRs (POD exists only via this
      // chalan's delivery), the chalan-LR links, and the ledger postings
      await tx.pod.deleteMany({ where: { lrId: { in: lrIds } } });
      await tx.chalanLr.deleteMany({ where: { chalanId } });
      await reverseLedger(tx, "CHALAN", chalanId);
      await reverseLedger(tx, "CHALAN_ADVANCE", chalanId);
      await reverseLedger(tx, "CHALAN_BALANCE", chalanId);
      // release every advance voucher this chalan had consumed
      await reverseLedger(tx, ADV_ADJ_REF, chalanId);
      await restoreAdvanceUses(tx, ADV_USE_ADVANCE, chalanId);
      await restoreAdvanceUses(tx, ADV_USE_BALANCE, chalanId);
      // undo everything this chalan raised or recovered in the shortage register
      await releaseShortage(tx, "CHALAN", chalanId);
      await releaseShortage(tx, "CHALAN", `${chalanId}:BAL`);
      // an unconsumed cancellation advance dies with its chalan — otherwise a
      // phantom credit (backed by ledger legs this delete just reversed) would
      // stay adjustable against the broker's next chalan
      if (cancelAdv) {
        await tx.partyAdvance.update({
          where: { id: cancelAdv.id },
          data: { deletedAt: new Date() },
        });
      }
      await tx.chalan.update({ where: { id: chalanId }, data: { deletedAt: new Date() } });

      // every associated LR returns to PENDING so it can be re-loaded onto a
      // new chalan (cancelled / paper-change LRs keep their type)
      await tx.lr.updateMany({
        where: {
          id: { in: lrIds },
          lrType: { notIn: ["CANCELLED", "PAPER_CHANGE"] },
        },
        data: { status: "PENDING" },
      });
      await audit(tx, session, {
        entity: "Chalan",
        entityId: chalanId,
        action: "DELETE",
        before: chalan,
      });
      return { ok: true as const };
    });
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Delete failed" };
  }
}

/**
 * Cancel a chalan after an accident / goods rejection. Unlike delete, the
 * record survives with a CANCELLED stamp, and the money story stays true:
 *  - the accrual (hire payable, deductions) reverses — nothing is owed on it
 *  - the advance legs (bank / cash / diesel-supplier adjustments) are KEPT,
 *    because that value really left the firm
 *  - the broker's debit therefore stands, and it is materialised as an open
 *    PartyAdvance (source CHALAN_CANCEL): recover it by receipt voucher or
 *    adjust it against his next chalan
 *  - advance VOUCHERS adjusted into this chalan are released back to open
 *  - LRs return to PENDING for a replacement vehicle (cancel them separately
 *    if the goods are fully lost)
 */
export async function cancelChalan(
  chalanId: string,
  reason: string
): Promise<{ ok: true; advanceCreated: number } | { ok: false; error: string }> {
  const session = requireSession();
  await authorize(session, "chalan", "delete");
  try {
    return await withTenant(session.tenantId, async (tx) => {
      const chalan = await tx.chalan.findFirst({
        where: { id: chalanId, firmId: session.firmId, deletedAt: null },
        include: { lrs: { include: { lr: { include: { invoiceLrs: true } } } }, advances: true },
      });
      if (!chalan) return { ok: false as const, error: "Chalan not found" };
      if (chalan.cancelledAt) return { ok: false as const, error: "Chalan is already cancelled" };
      // chain lock: cancelling a trip-linked chalan would orphan the trip's hishab
      const tripGuard = await tripLockError(tx, "CHALAN", chalanId, "chalan");
      if (tripGuard) return { ok: false as const, error: tripGuard };

      const billed = chalan.lrs.find(
        (l) => l.lr.invoiceLrs.length > 0 || l.lr.status === "BILLED"
      );
      if (billed) {
        return {
          ok: false as const,
          error: `LR ${billed.lr.lrNo} is already billed. Delete its bill before cancelling this chalan.`,
        };
      }
      // ANY own balance settlement blocks a cancel — including one paid purely
      // by advance adjustment / shortage / round-off (balPaidAmount stays 0
      // in that case, but CHALAN_BALANCE legs and advance uses exist)
      if (
        chalan.paymentStatus === "PAID" ||
        toNum(chalan.balPaidAmount) > 0 ||
        toNum(chalan.balAdvanceAdjusted) > 0 ||
        toNum(chalan.balShortage) > 0 ||
        toNum(chalan.balRoundOff) > 0
      ) {
        return {
          ok: false as const,
          error:
            "Balance payment is already recorded on this chalan — reverse that payment (Balance Payment screen) first, then cancel. A settled chalan must never be deleted.",
        };
      }
      const settled = await payableSettlement(tx, {
        firmId: session.firmId,
        fyId: session.fyId,
        refType: "FREIGHT_CHALLAN",
        docs: [{ id: chalan.id, balance: toNum(chalan.balance), ownPaid: 0, ownShortage: 0, ownRoundOff: 0 }],
      });
      if ((settled.get(chalan.id)?.voucherSettled ?? 0) > 0.009) {
        return {
          ok: false as const,
          error: "A payment voucher already settles this chalan — delete that voucher first.",
        };
      }

      // accrual gone: the broker is no longer owed the hire
      await reverseLedger(tx, "CHALAN", chalanId);
      await reverseLedger(tx, ADV_ADJ_REF, chalanId);
      // release the advance VOUCHERS this chalan had consumed — they open
      // again, so their ChalanAdvance rows must go too (keeping them would
      // count the same money twice after a restore: voucher open AND the
      // chalan's advanceTotal still netting it off)
      await restoreAdvanceUses(tx, ADV_USE_ADVANCE, chalanId);
      const adjTotal = Math.round(
        chalan.advances
          .filter((a) => a.type === "ADVANCE_ADJ")
          .reduce((s, a) => s + toNum(a.amount), 0) * 100
      ) / 100;
      if (adjTotal > 0) {
        await tx.chalanAdvance.deleteMany({ where: { chalanId, type: "ADVANCE_ADJ" } });
      }
      await releaseShortage(tx, "CHALAN", chalanId);
      // NOTE: CHALAN_ADVANCE ledger entries are intentionally NOT reversed —
      // cash/bank left, diesel burned; the broker's debit is the receivable.

      // paid-out advances (cash / bank / diesel / on-behalf expenses) become
      // one open advance on the broker; ADVANCE_ADJ rows are excluded — those
      // vouchers were just released back above
      const advanceCreated =
        Math.round(
          chalan.advances
            .filter((a) => a.type !== "ADVANCE_ADJ")
            .reduce((s, a) => s + toNum(a.amount), 0) * 100
        ) / 100;
      if (advanceCreated > 0) {
        await tx.partyAdvance.create({
          data: {
            tenantId: session.tenantId,
            firmId: session.firmId,
            fyId: session.fyId,
            partyId: chalan.brokerId,
            kind: "PAID",
            date: new Date(),
            voucherNo: chalan.chalanNo,
            source: "CHALAN_CANCEL",
            sourceRefId: chalanId,
            amount: advanceCreated,
            remarks: `Chalan ${chalan.chalanNo} cancelled${reason ? ` — ${reason}` : ""}`,
          },
        });
      }

      const lrIds = chalan.lrs.map((l) => l.lrId);
      await tx.pod.deleteMany({ where: { lrId: { in: lrIds } } });
      await tx.chalanLr.deleteMany({ where: { chalanId } });
      await tx.lr.updateMany({
        where: { id: { in: lrIds }, lrType: { notIn: ["CANCELLED", "PAPER_CHANGE"] } },
        data: { status: "PENDING" },
      });

      await tx.chalan.update({
        where: { id: chalanId },
        data: {
          cancelledAt: new Date(),
          cancelReason: reason || null,
          balance: 0,
          paymentStatus: "CANCELLED",
          // released voucher-adjustments no longer reduce this chalan
          ...(adjTotal > 0
            ? { advanceTotal: Math.round((toNum(chalan.advanceTotal) - adjTotal) * 100) / 100 }
            : {}),
        },
      });
      await audit(tx, session, {
        entity: "Chalan",
        entityId: chalanId,
        action: "UPDATE",
        before: chalan,
        after: { cancelled: true, reason, advanceCreated },
      });
      revalidatePath("/chalan/register");
      return { ok: true as const, advanceCreated };
    });
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Cancel failed" };
  }
}

/**
 * Undo a mistaken cancel (Admin/Owner). Possible only while the cancel-created
 * advance is untouched. The accrual re-posts from the chalan's stored figures
 * and the cancel advance is removed. LR links were released at cancel time and
 * cannot be re-attached automatically — reload them from the chalan edit screen.
 */
export async function restoreChalan(
  chalanId: string
): Promise<{ ok: true } | { ok: false; error: string }> {
  const session = requireSession();
  await authorize(session, "chalan", "delete");
  try {
    return await withTenant(session.tenantId, async (tx) => {
      const chalan = await tx.chalan.findFirst({
        where: { id: chalanId, firmId: session.firmId, deletedAt: null },
      });
      if (!chalan) return { ok: false as const, error: "Chalan not found" };
      if (!chalan.cancelledAt) return { ok: false as const, error: "Chalan is not cancelled" };

      const adv = await tx.partyAdvance.findFirst({
        where: { source: "CHALAN_CANCEL", sourceRefId: chalanId, deletedAt: null },
      });
      if (adv && toNum(adv.consumedAmount) > 0.009) {
        return {
          ok: false as const,
          error: `The cancel advance is already adjusted (${formatOpen(toNum(adv.consumedAmount))}) — it cannot be restored.`,
        };
      }
      if (adv) {
        await tx.partyAdvance.update({ where: { id: adv.id }, data: { deletedAt: new Date() } });
      }

      // clean slate first: whatever CHALAN rows exist (none normally, but a
      // stray save could have left some) are reversed, and the shortage
      // recovery is released, so the re-post below can never double up
      await reverseLedger(tx, "CHALAN", chalanId);
      await releaseShortageRecoveries(tx, "CHALAN", chalanId);
      // re-post the accrual exactly as saveChalan does, from stored figures
      const common = {
        date: chalan.chalanDate,
        refType: "CHALAN",
        refId: chalanId,
        refNo: chalan.chalanNo,
      };
      const entries: Parameters<typeof postLedger>[2] = [];
      const tag = `chalan ${chalan.chalanNo}`;
      const earning = async (label: string, amount: number, headName: string) => {
        if (amount <= 0) return;
        const headId = await ensureAccountHead(tx, session, headName, "EXPENSE");
        entries.push(
          { ...common, accountHeadId: headId, side: "DEBIT", amount, narration: `${label} — ${tag}` },
          { ...common, partyId: chalan.brokerId, side: "CREDIT", amount, narration: `${label} payable — ${tag}` }
        );
      };
      const deduction = async (label: string, amount: number, headName: string) => {
        if (amount <= 0) return;
        const headId = await ensureAccountHead(tx, session, headName, "INCOME");
        entries.push(
          { ...common, partyId: chalan.brokerId, side: "DEBIT", amount, narration: `${label} deducted — ${tag}` },
          { ...common, accountHeadId: headId, side: "CREDIT", amount, narration: `${label} — ${tag}` }
        );
      };
      await earning("Lorry hire", toNum(chalan.freight), "Lorry Hire Expense");
      await earning("Detention", toNum(chalan.detention), "Detention Charges");
      await earning("ODC", toNum(chalan.odcAmt), "ODC Charges");
      await earning("Fine slip", toNum(chalan.fineSlip), "Fine Slip Charges");
      await earning("Other charges", toNum(chalan.otherAmt), "Other Chalan Charges");
      await deduction("LD charge", toNum(chalan.ldCharge), "LD Charge Recovered");
      if (toNum(chalan.shortageAmt) > 0) {
        entries.push({
          ...common,
          partyId: chalan.brokerId,
          side: "DEBIT",
          amount: toNum(chalan.shortageAmt),
          narration: `Shortage deducted — ${tag}`,
        });
      }
      await deduction("Commission", toNum(chalan.commissionAmt), "Commission Income");
      await deduction("TDS", toNum(chalan.tdsAmt), "TDS Payable");
      await deduction("Mamool", toNum(chalan.mamool), "Mamool Recovered");
      await deduction("Courier", toNum(chalan.courierCharge), "Courier Recovered");
      await postLedger(tx, session, entries);
      if (toNum(chalan.shortageAmt) > 0) {
        await recoverShortage(tx, session, {
          date: chalan.chalanDate,
          module: "CHALAN",
          refId: chalanId,
          refNo: chalan.chalanNo,
          source: "OWNER",
          partyId: chalan.brokerId,
          partyKind: "OWNER",
          amount: toNum(chalan.shortageAmt),
          remarks: `Deducted from chalan ${chalan.chalanNo}`,
        });
      }

      await tx.chalan.update({
        where: { id: chalanId },
        data: {
          cancelledAt: null,
          cancelReason: null,
          balance: Math.round((toNum(chalan.grandTotal) - toNum(chalan.advanceTotal)) * 100) / 100,
          paymentStatus: "PENDING",
        },
      });
      await audit(tx, session, {
        entity: "Chalan",
        entityId: chalanId,
        action: "UPDATE",
        after: { restored: true },
      });
      revalidatePath("/chalan/register");
      return { ok: true as const };
    });
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Restore failed" };
  }
}

// ---------------------------------------------------------------- balance payment

const balancePaymentSchema = z.object({
  chalanId: z.string().min(1),
  roundOff: z.number().default(0),
  shortage: z.number().min(0).default(0),
  paymentDate: z.string().min(1, "Payment date is required"),
  paymentHeadId: z.string().optional().nullable(),
  paymentMode: z
    .enum(["CASH", "BANK", "CARD", "UPI", "CHEQUE", "NEFT_RTGS", "ADVANCE_ADJ"])
    .default("BANK"),
  remarks: z.string().optional().nullable(),
  /** manual voucher-wise advance adjustment applied to the balance */
  advanceLines: z
    .array(z.object({ advanceId: z.string().min(1), amount: z.number() }))
    .default([]),
});

/**
 * Settle a chalan's balance: chalan moves PENDING -> PAID, and the payment is
 * posted to the ledger (credit the bank/cash head, debit the broker) so the
 * bank/cash books and broker ledger update automatically.
 */
export async function saveBalancePayment(
  input: unknown
): Promise<{ ok: true; paidAmount: number } | { ok: false; error: string }> {
  const session = requireSession();
  await authorize(session, "chalan", "edit");
  const parsed = balancePaymentSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid input" };
  }
  const data = parsed.data;
  try {
    return await withTenant(session.tenantId, async (tx) => {
      const chalan = await tx.chalan.findFirst({
        where: { id: data.chalanId, firmId: session.firmId, deletedAt: null },
      });
      if (!chalan) return { ok: false as const, error: "Chalan not found." };
      if (chalan.cancelledAt) {
        return { ok: false as const, error: "This chalan is cancelled — nothing is payable on it." };
      }
      if (!chalan.isFinal) {
        return { ok: false as const, error: "Finalize the chalan before settling its balance." };
      }
      // balance payment is a MARKET-vehicle concept: an own vehicle has no
      // payee, and a relative vehicle settles through the owner's ledger —
      // paying here would double the hisab
      const chalanVehicle = await tx.vehicle.findFirst({
        where: { id: chalan.vehicleId },
        select: { ownershipType: true, number: true },
      });
      if (chalanVehicle && chalanVehicle.ownershipType !== "BROKER") {
        return {
          ok: false as const,
          error: `${chalanVehicle.number} is a${chalanVehicle.ownershipType === "OWNER" ? "n OWN" : " RELATIVE"} vehicle — balance payment does not apply; its hisab flows through the ${chalanVehicle.ownershipType === "OWNER" ? "vehicle P&L" : "relative owner's ledger"}.`,
        };
      }
      // all attached LRs must have a confirmed POD before balance can be paid
      const links = await tx.chalanLr.findMany({
        where: { chalanId: chalan.id },
        include: { lr: { include: { pods: true } } },
      });
      const operational = links.filter(
        (l) => l.lr.lrType !== "CANCELLED" && l.lr.lrType !== "PAPER_CHANGE"
      );
      const podDone = operational.filter((l) => l.lr.pods.length > 0).length;
      if (operational.length > 0 && podDone < operational.length) {
        return {
          ok: false as const,
          error: `POD is only ${podDone}/${operational.length} confirmed — all LRs must have a confirmed POD before balance payment.`,
        };
      }
      // a Payment Voucher may already have settled part of this chalan — the
      // two modules share one outstanding, so only the remainder is settleable
      const pos = await payableSettlement(tx, {
        firmId: session.firmId,
        fyId: session.fyId,
        refType: "FREIGHT_CHALLAN",
        docs: [
          {
            id: chalan.id,
            balance: toNum(chalan.balance),
            // this action replaces the chalan-side settlement, so exclude it
            ownPaid: 0,
            ownShortage: 0,
            ownRoundOff: 0,
          },
        ],
      });
      const viaVoucher = pos.get(chalan.id)?.voucherSettled ?? 0;
      const settleable =
        Math.round(
          (toNum(chalan.balance) - viaVoucher - data.roundOff - data.shortage) * 100
        ) / 100;
      if (settleable < 0) {
        return {
          ok: false as const,
          error: viaVoucher > 0
            ? `Round-off + shortage exceed the balance still open (${formatOpen(toNum(chalan.balance) - viaVoucher)} after ${formatOpen(viaVoucher)} settled by voucher).`
            : "Round-off + shortage exceed the balance.",
        };
      }
      const paymentDate = new Date(`${data.paymentDate}T00:00:00`);
      // the settlement voucher is stamped into the SESSION FY — a back-dated
      // payment date would put it in the wrong year's registers and exports
      await assertDateInFy(tx, session, paymentDate, "balance payment");

      // manual advance adjustment first; only the residual moves through bank/cash
      const advTotal =
        Math.round(data.advanceLines.reduce((s, l) => s + l.amount, 0) * 100) / 100;
      if (advTotal < 0) {
        return { ok: false as const, error: "Adjustment amount cannot be negative." };
      }
      if (advTotal > settleable + 0.009) {
        return {
          ok: false as const,
          error: `Advance adjusted (${advTotal}) exceeds the payable amount (${settleable}).`,
        };
      }
      const paidAmount = Math.round((settleable - advTotal) * 100) / 100;
      if (paidAmount > 0.009 && !data.paymentHeadId) {
        return { ok: false as const, error: "Payment head (bank/cash) is required." };
      }
      await applyManualAdvanceUses(tx, {
        tenantId: session.tenantId,
        firmId: chalan.firmId,
        fyId: chalan.fyId,
        partyId: chalan.brokerId,
        kinds: ["PAID"],
        refType: ADV_USE_BALANCE,
        refId: chalan.id,
        refNo: chalan.chalanNo,
        date: paymentDate,
        lines: data.advanceLines,
      });

      // The money side of this settlement is a REAL Payment Voucher, so it
      // shows in the Voucher Register and can be edited/deleted from there
      // like any other payment. The chalan keeps only the advance adjustment
      // and the status stamps; the paid/shortage/round-off figures live on
      // the voucher's allocation (payableSettlement counts them from there —
      // storing them on the chalan too would double the settlement).
      let voucherId: string | null = null;
      if (paidAmount > 0.009 || data.shortage > 0.009 || Math.abs(data.roundOff) > 0.009) {
        const voucherNo = await nextDocNumber(tx, {
          tenantId: session.tenantId,
          firmId: session.firmId,
          fyId: session.fyId,
          docType: "VOUCHER_PAYMENT",
        });
        const entryType =
          data.paymentMode === "CASH" ? "CASH" : data.paymentMode === "CARD" ? "CARD" : "BANK";
        const voucher = await tx.voucher.create({
          // header follows the voucher module's semantics: amount = GROSS
          // (cash + shortage), netAmount = cash actually moved — the register
          // Net column and the Tally export both read these
          data: {
            tenantId: session.tenantId,
            firmId: session.firmId,
            fyId: session.fyId,
            createdById: session.userId,
            voucherNo,
            voucherDate: paymentDate,
            type: "PAYMENT",
            entryType,
            moduleLink: "FREIGHT_CHALLAN",
            partyId: chalan.brokerId,
            bankPartyId: data.paymentHeadId || null,
            amount: round2(paidAmount + data.shortage),
            deduction: data.shortage,
            netAmount: paidAmount,
            remarks: `Balance payment — chalan ${chalan.chalanNo}${data.remarks ? " — " + data.remarks : ""}`,
            allocations: {
              create: [
                {
                  tenantId: session.tenantId,
                  refType: "FREIGHT_CHALLAN",
                  refId: chalan.id,
                  refNo: chalan.chalanNo,
                  billAmt: toNum(chalan.balance),
                  amount: paidAmount,
                  deduction: data.shortage,
                  roundOff: data.roundOff,
                  // marks an auto-created settlement voucher: the register
                  // blocks EDITING it (delete + re-settle instead)
                  remarks: "CHALAN_BAL_SETTLEMENT",
                },
              ],
            },
          },
        });
        voucherId = voucher.id;
      }

      const after = await tx.chalan.update({
        where: { id: chalan.id },
        data: {
          paymentStatus: "PAID",
          balRoundOff: 0,
          balShortage: 0,
          balAdvanceAdjusted: advTotal,
          balPaidAmount: 0,
          balPaymentDate: paymentDate,
          balPaymentHeadId: data.paymentHeadId || null,
          balPaymentMode: data.paymentMode,
          balRemarks: data.remarks || null,
        },
      });
      await reverseLedger(tx, "CHALAN_BALANCE", chalan.id);
      // adjustments are reference links, not transactions — nothing is posted;
      // only stale rows from the earlier (incorrect) design are cleared
      await reverseLedger(tx, ADV_ADJ_REF, chalan.id);

      // Shortage and round-off reduce what we hand over, so without their own
      // entries the broker would stay credited for money he never receives and
      // his ledger would never close. Each posts against a recovery head.
      // The legs hang off the VOUCHER, so editing/deleting it from the
      // Voucher Register reverses exactly these entries.
      const balCommon = {
        date: paymentDate,
        refType: voucherId ? "VOUCHER" : "CHALAN_BALANCE",
        refId: voucherId ?? chalan.id,
        refNo: chalan.chalanNo,
      };
      const balEntries: Parameters<typeof postLedger>[2] = [];
      if (paidAmount > 0 && data.paymentHeadId) {
        balEntries.push(
          {
            ...balCommon,
            partyId: data.paymentHeadId,
            side: "CREDIT",
            amount: paidAmount,
            narration: `Balance payment for chalan ${chalan.chalanNo} (${data.paymentMode})`,
          },
          {
            ...balCommon,
            partyId: chalan.brokerId,
            side: "DEBIT",
            amount: paidAmount,
            narration: `Balance settled${data.remarks ? " — " + data.remarks : ""}`,
          }
        );
      }
      // shortage at balance payment goes through the register too; only the
      // round-off keeps its own head
      if (Math.abs(data.shortage) > 0.009) {
        balEntries.push({
          ...balCommon,
          partyId: chalan.brokerId,
          side: "DEBIT",
          amount: Math.abs(data.shortage),
          narration: `Shortage deducted at balance payment — chalan ${chalan.chalanNo}`,
        });
      }
      for (const [label, signed, headName] of [
        ["Round off", data.roundOff, "Round Off"],
      ] as const) {
        if (Math.abs(signed) <= 0.009) continue;
        // a negative round-off means we paid a little extra, so the legs flip
        const amount = Math.abs(signed);
        const headId = await ensureAccountHead(tx, session, headName, "INCOME");
        const brokerSide = signed > 0 ? "DEBIT" : "CREDIT";
        balEntries.push(
          {
            ...balCommon,
            partyId: chalan.brokerId,
            side: brokerSide,
            amount,
            narration: `${label} ${signed > 0 ? "deducted" : "added"} at balance payment — chalan ${chalan.chalanNo}`,
          },
          {
            ...balCommon,
            accountHeadId: headId,
            side: signed > 0 ? "CREDIT" : "DEBIT",
            amount,
            narration: `${label} — chalan ${chalan.chalanNo}`,
          }
        );
      }
      await postLedger(tx, session, balEntries);
      // LEGACY-era artifacts only (`:BAL` without a voucher id) — voucher-era
      // recoveries are keyed per voucher (`:BAL:<voucherId>`) so an update or
      // an unrelated voucher's delete can never tear down a LIVE voucher's
      // shortage recovery and unbalance the ledger
      await releaseShortage(tx, "CHALAN", `${chalan.id}:BAL`);
      if (data.shortage > 0.009) {
        await recoverShortage(tx, session, {
          date: paymentDate,
          module: "CHALAN",
          refId: voucherId ? `${chalan.id}:BAL:${voucherId}` : `${chalan.id}:BAL`,
          refNo: chalan.chalanNo,
          source: "OWNER",
          partyId: chalan.brokerId,
          partyKind: "OWNER",
          amount: data.shortage,
          remarks: `Deducted at balance payment of chalan ${chalan.chalanNo}`,
        });
      }
      await audit(tx, session, {
        entity: "Chalan",
        entityId: chalan.id,
        action: "UPDATE",
        before: chalan,
        after,
      });
      revalidatePath("/chalan/register");
      return { ok: true as const, paidAmount };
    });
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Balance payment failed" };
  }
}

// ---------------------------------------------------------------- chalan status

export interface ChalanStatusData {
  chalanNo: string;
  chalanDate: string;
  vehicle: string;
  transporter: string;
  owner: string;
  driverName: string;
  origin: string;
  destination: string;
  createdAt: string;
  isFinal: boolean;
  lrs: {
    lrNo: string;
    lrDate: string;
    consignor: string;
    consignee: string;
    qty: number;
    freight: number;
    status: string;
    billed: boolean;
    invoiceNo: string;
    invoiceDate: string | null;
    invoiceAmount: number;
    invoiceReceived: number;
    invoiceBalance: number;
    invoiceStatus: string; // Paid | Partially Paid | Pending | Not Billed
  }[];
  advances: {
    name: string;
    amount: number;
    date: string | null;
    mode: string;
    remarks: string;
  }[];
  /** advance vouchers consumed by this chalan (both sections) */
  advanceAdjustments: {
    voucherNo: string;
    voucherDate: string | null;
    amount: number;
    section: string; // Advance | Balance
    date: string;
  }[];
  advanceAdjustedTotal: number;
  advanceTotal: number;
  grandTotal: number;
  balance: number;
  /** settled through Payment Vouchers allocated to this chalan */
  voucherSettled: number;
  /** balance still open across BOTH settlement paths */
  outstanding: number;
  paymentStatus: string;
  balPaidAmount: number;
  balPaymentDate: string | null;
  balPaymentMode: string;
  /** round-off across both settlement paths (chalan screen + payment voucher) */
  balRoundOff: number;
  /** shortage across both settlement paths */
  balShortage: number;
  /** deductions a Payment Voucher applied to this chalan */
  voucherTds: number;
  voucherShortage: number;
  voucherOther: number;
  voucherRoundOff: number;
  balRemarks: string;
  payments: {
    date: string;
    amount: number;
    account: string; // bank / cash head or broker
    side: string;
    refType: string;
    narration: string;
  }[];
}

/** Complete lifecycle of a chalan: LRs, per-LR billing, payments, history. */
export async function getChalanStatus(
  chalanId: string
): Promise<{ ok: true; data: ChalanStatusData } | { ok: false; error: string }> {
  const session = requireSession();
  return withTenant(session.tenantId, async (tx) => {
    const chalan = await tx.chalan.findFirst({
      where: { id: chalanId, firmId: session.firmId, deletedAt: null },
      include: {
        lrs: { include: { lr: { include: { items: true, invoiceLrs: { include: { invoice: true } } } } } },
        advances: true,
      },
    });
    if (!chalan) return { ok: false as const, error: "Chalan not found" };

    const [broker, vehicle, parties, cities, ledger, advUses, voucherAllocs] = await Promise.all([
      tx.party.findUnique({ where: { id: chalan.brokerId } }),
      tx.vehicle.findUnique({ where: { id: chalan.vehicleId } }),
      tx.party.findMany(),
      tx.city.findMany(),
      tx.ledgerEntry.findMany({
        where: {
          refId: chalanId,
          refType: { in: ["CHALAN_ADVANCE", "CHALAN_BALANCE"] },
        },
        orderBy: { date: "asc" },
      }),
      tx.partyAdvanceUse.findMany({
        where: { refId: chalanId, refType: { in: [ADV_USE_ADVANCE, ADV_USE_BALANCE] } },
        include: { advance: true },
        orderBy: { date: "asc" },
      }),
      // payment-voucher settlements belong in the payment history too — their
      // ledger entries carry the voucher's id, not the chalan's, so they are
      // read from the allocations that the settlement position is built from
      tx.voucherAllocation.findMany({
        where: {
          refType: "FREIGHT_CHALLAN",
          refId: chalanId,
          voucher: { deletedAt: null },
        },
        include: {
          voucher: {
            select: { voucherNo: true, voucherDate: true, type: true, bankPartyId: true },
          },
        },
        orderBy: { voucher: { voucherDate: "asc" } },
      }),
    ]);
    const partyName = (id: string | null) =>
      id ? parties.find((p) => p.id === id)?.name ?? "" : "";
    const cityName = (id: string | null) =>
      id ? cities.find((c) => c.id === id)?.name ?? "" : "";

    // combined position across the chalan screen and any Payment Voucher
    const position = (await payableSettlement(tx, {
      firmId: session.firmId,
      fyId: session.fyId,
      refType: "FREIGHT_CHALLAN",
      docs: [
        {
          id: chalan.id,
          balance: toNum(chalan.balance),
          ownPaid: toNum(chalan.balPaidAmount),
          ownShortage: toNum(chalan.balShortage),
          ownRoundOff: toNum(chalan.balRoundOff),
          ownAdvanceAdjusted: toNum(chalan.balAdvanceAdjusted),
        },
      ],
    })).get(chalan.id)!;

    // Invoice.balance is frozen at bill-creation time; the real position comes
    // from live voucher allocations, so a receipt entered later shows here.
    const settlement = await invoiceSettlement(tx, {
      firmId: session.firmId,
      fyId: session.fyId,
      invoices: chalan.lrs.flatMap(({ lr }) => lr.invoiceLrs.map((il) => il.invoice)),
    });

    const lrRows = chalan.lrs.map(({ lr }) => {
      const inv = lr.invoiceLrs[0]?.invoice ?? null;
      const s = inv ? settlement.get(inv.id) : undefined;
      const invAmount = s?.net ?? 0;
      const invReceived = s?.received ?? 0;
      const invBalance = s?.outstanding ?? 0;
      return {
        lrNo: lr.lrNo,
        lrDate: lr.lrDate.toISOString(),
        consignor: partyName(lr.consignorId),
        consignee: partyName(lr.consigneeId),
        qty: lr.items.reduce((s, i) => s + toNum(i.qty), 0),
        freight: toNum(lr.freight),
        status: lr.status,
        billed: !!inv,
        invoiceNo: inv?.invoiceNo ?? "",
        invoiceDate: inv ? inv.invoiceDate.toISOString() : null,
        invoiceAmount: invAmount,
        invoiceReceived: invReceived,
        invoiceBalance: invBalance,
        invoiceStatus: !s
          ? "Not Billed"
          : s.status === "PAID"
            ? "Paid"
            : s.status === "PARTLY PAID"
              ? "Partially Paid"
              : "Pending",
      };
    });

    const sources = Array.from(new Set(chalan.lrs.map(({ lr }) => cityName(lr.sourceCityId)).filter(Boolean)));
    const dests = Array.from(new Set(chalan.lrs.map(({ lr }) => cityName(lr.destCityId)).filter(Boolean)));

    return {
      ok: true as const,
      data: {
        chalanNo: chalan.chalanNo,
        chalanDate: chalan.chalanDate.toISOString(),
        vehicle: vehicle?.number ?? "",
        transporter: chalan.transportName ?? broker?.transportName ?? "",
        owner: chalan.ownerName ?? broker?.name ?? "",
        driverName: chalan.driverName ?? "",
        origin: sources.join(", "),
        destination: dests.join(", "),
        createdAt: chalan.createdAt.toISOString(),
        isFinal: chalan.isFinal,
        lrs: lrRows,
        advances: chalan.advances.map((a) => ({
          name:
            a.type === "ADVANCE_ADJ"
              ? `Voucher ${a.advanceVoucherNo ?? "—"}`
              : a.bankName || a.supplierName || a.type.replace(/_/g, " "),
          amount: toNum(a.amount),
          date: a.date ? a.date.toISOString() : null,
          mode:
            a.type === "BANK"
              ? "Bank"
              : a.type === "CASH"
                ? "Cash"
                : a.type === "ADVANCE_ADJ"
                  ? "Advance Adjustment"
                  : a.type.replace(/_/g, " "),
          remarks: a.remarks ?? "",
        })),
        advanceAdjustments: advUses.map((u) => ({
          voucherNo: u.advance?.voucherNo ?? "—",
          voucherDate: u.advance ? u.advance.date.toISOString() : null,
          amount: toNum(u.amount),
          section: u.refType === ADV_USE_ADVANCE ? "Advance" : "Balance",
          date: u.date.toISOString(),
        })),
        advanceAdjustedTotal: advUses.reduce((s, u) => s + toNum(u.amount), 0),
        advanceTotal: toNum(chalan.advanceTotal),
        grandTotal: toNum(chalan.grandTotal),
        balance: toNum(chalan.balance),
        voucherSettled: position.voucherSettled,
        outstanding: position.outstanding,
        // the chalan is settled when nothing is open, whichever module paid it
        paymentStatus: position.outstanding <= 0.009 ? "PAID" : chalan.paymentStatus,
        // combined: chalan-side legacy figure + the settlement voucher's cash
        // (voucher-era chalan columns stay 0 — the money lives on the voucher)
        balPaidAmount: round2(toNum(chalan.balPaidAmount) + position.voucherPaid),
        balPaymentDate: chalan.balPaymentDate ? chalan.balPaymentDate.toISOString() : null,
        balPaymentMode: chalan.balPaymentMode ?? "",
        // a deduction entered on the voucher IS the chalan's deduction — one
        // figure each, shown identically from either module
        balRoundOff: toNum(chalan.balRoundOff) + position.voucherRoundOff,
        balShortage: toNum(chalan.balShortage) + position.voucherShortage,
        voucherTds: position.voucherTds,
        voucherShortage: position.voucherShortage,
        voucherOther: position.voucherOther,
        voucherRoundOff: position.voucherRoundOff,
        balRemarks: chalan.balRemarks ?? "",
        payments: [
          ...ledger.map((e) => ({
            date: e.date.toISOString(),
            amount: toNum(e.amount),
            account: partyName(e.partyId),
            side: e.side as string,
            refType: e.refType,
            narration: e.narration ?? "",
          })),
          ...voucherAllocs.map((a) => {
            const extras = [
              toNum(a.tdsAmt) > 0.009 && `TDS ${formatOpen(toNum(a.tdsAmt))}`,
              toNum(a.deduction) > 0.009 && `shortage ${formatOpen(toNum(a.deduction))}`,
              toNum(a.otherAmt) > 0.009 && `other ${formatOpen(toNum(a.otherAmt))}`,
              Math.abs(toNum(a.roundOff)) > 0.009 &&
                `round off ${formatOpen(toNum(a.roundOff))}`,
            ].filter(Boolean);
            return {
              date: a.voucher.voucherDate.toISOString(),
              amount: toNum(a.amount),
              account: partyName(a.voucher.bankPartyId),
              side: "DEBIT",
              refType: "VOUCHER",
              narration: `${a.voucher.type === "JOURNAL" ? "Journal" : "Payment"} voucher ${a.voucher.voucherNo}${
                extras.length ? ` (${extras.join(", ")} adjusted)` : ""
              }`,
            };
          }),
        ].sort((x, y) => x.date.localeCompare(y.date)),
      },
    };
  });
}
