"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { Prisma } from "@prisma/client";
import { requireSession } from "@/lib/session";
import { withTenant } from "@/lib/db";
import { authorize } from "@/lib/authz";
import { audit } from "@/lib/audit";
import { nextDocNumber, syncSequenceTo } from "@/lib/sequences";
import { ensureAccountHead, postLedger, reverseLedger } from "@/lib/ledger";
import { round2 } from "@/lib/calc/tds";
import { tripLegTotal, tripLegBalance } from "@/lib/calc/trip";
import { chalanTotals, slipTotals } from "@/lib/trip-docs";

const TRIP_EXPENSE_CATEGORIES = [
  "DIESEL",
  "TOLL",
  "DRIVER_BATA",
  "LOADING",
  "UNLOADING",
  "PARKING",
  "POLICE_RTO",
  "UREA",
  "MISC",
] as const;

/** remark marker for the auto-generated company urea expense row */
const UREA_AUTO_REMARK = "AdBlue (auto)";

const expenseSchema = z.object({
  category: z.enum(TRIP_EXPENSE_CATEGORIES),
  amount: z.number().min(0).default(0),
  remarks: z.string().nullish(),
  date: z.string().nullish(), // ISO yyyy-mm-dd
});

const tripSchema = z.object({
  id: z.string().nullish(),
  tripNo: z.string().trim().min(1, "Trip number is required"),
  tripDate: z.string().min(1, "Trip date is required"),
  returnDate: z.string().nullish(),
  vehicleId: z.string().min(1, "Vehicle is required"),
  vehicleType: z.string().nullish(),
  driverId: z.string().nullish(),
  /** trip driver +/- : positive = payable to driver, negative = receivable */
  driverBalance: z.number().default(0),
  /** PENDING driver-advance ids fetched from the Driver Advance Register */
  advanceIds: z.array(z.string()).default([]),
  /** AdBlue: litres fetched from the stock register; rate entered per trip */
  ureaQty: z.number().min(0).default(0),
  ureaRate: z.number().min(0).default(0),
  ureaExpenseType: z.enum(["DRIVER", "COMPANY"]).default("DRIVER"),

  // ---- trip settlement (redesigned sheet) ----
  calcMethod: z.enum(["DIESEL_AVG", "FIXED", "ACTUAL"]).default("DIESEL_AVG"),
  fromDate: z.string().nullish(),
  toDate: z.string().nullish(),
  /** chalans / broker slips settled by this trip */
  docs: z
    .array(z.object({ refType: z.enum(["CHALAN", "BROKER_SLIP"]), refId: z.string().min(1) }))
    .default([]),
  tollExpenseType: z.enum(["DRIVER", "COMPANY"]).default("DRIVER"),
  tollAmount: z.number().min(0).default(0),
  actualDiesel: z.number().min(0).default(0),
  actualAdvance: z.number().min(0).default(0),
  loadingKm: z.number().min(0).default(0),
  unloadingKm: z.number().min(0).default(0),
  newLoadingKm: z.number().min(0).default(0),
  dieselAvg: z.number().min(0).default(0),
  dieselAvg2: z.number().min(0).default(0),
  dieselRate: z.number().min(0).default(0),
  apprDriverAdvance: z.number().min(0).default(0),
  roadBillExp: z.number().min(0).default(0),
  foodingDays: z.number().min(0).default(0),
  foodingRate: z.number().min(0).default(0),
  rtoExp: z.number().min(0).default(0),
  fixedTripExp: z.number().min(0).default(0),
  // ACTUAL method operating expenses
  roadExp: z.number().min(0).default(0),
  otherOpExp: z.number().min(0).default(0),
  autoFetchedExp: z.number().min(0).default(0),
  actualTotal: z.number().min(0).default(0),
  approvedTotal: z.number().min(0).default(0),
  grandTotal: z.number().min(0).default(0),

  goingPartyId: z.string().nullish(),
  goingSourceCityId: z.string().nullish(),
  goingDestCityId: z.string().nullish(),
  gFreight: z.number().min(0).default(0),
  gHamali: z.number().min(0).default(0),
  gOthers: z.number().min(0).default(0),
  gDiesel: z.number().min(0).default(0),
  gDriverAdvance: z.number().min(0).default(0),
  gPartyAdvance: z.number().min(0).default(0),
  gOther: z.number().min(0).default(0),
  gBankName: z.string().nullish(),
  gRemarks: z.string().nullish(),

  returnPartyId: z.string().nullish(),
  returnSourceCityId: z.string().nullish(),
  returnDestCityId: z.string().nullish(),
  rFreight: z.number().min(0).default(0),
  rHamali: z.number().min(0).default(0),
  rOthers: z.number().min(0).default(0),
  rDiesel: z.number().min(0).default(0),
  rDriverAdvance: z.number().min(0).default(0),
  rPartyAdvance: z.number().min(0).default(0),
  rDetention: z.number().min(0).default(0),
  rBankName: z.string().nullish(),
  rRemarks: z.string().nullish(),

  expenses: z.array(expenseSchema).default([]),
});

function toDate(s: string): Date {
  return new Date(s.includes("T") ? s : `${s}T00:00:00`);
}

export type SaveResult = { ok: true; id: string } | { ok: false; error: string };

export async function saveTrip(input: unknown): Promise<SaveResult> {
  const session = requireSession();
  const parsed = tripSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid input" };
  }
  const data = parsed.data;
  await authorize(session, "trips", data.id ? "edit" : "create");

  // Driver settlement compares APPROVED vs ACTUAL only — the Grand Total
  // (company vehicle cost) never enters this calculation.
  //   approved > actual  → +ve → company owes the driver (driver saved)
  //   approved < actual  → −ve → driver owes the company (driver overspent)
  //
  // ACTUAL is a vehicle-profitability method, not a driver-settlement one: it
  // measures actual income against actual running cost and has no approved side
  // to compare against. Forcing the balance to zero here (rather than only in
  // the UI) is what guarantees no +/- row is ever posted for it — including on a
  // sheet switched to ACTUAL after being saved under another method, where the
  // zero balance makes the existing PENDING row be withdrawn below.
  if (data.calcMethod === "ACTUAL") {
    data.driverBalance = 0;
  } else if (data.approvedTotal > 0 || data.actualTotal > 0) {
    data.driverBalance = Math.round((data.approvedTotal - data.actualTotal) * 100) / 100;
  }

  const gTotalFreight = tripLegTotal(data.gFreight, data.gHamali, data.gOthers);
  const gBalance = tripLegBalance(
    gTotalFreight,
    data.gDiesel,
    data.gDriverAdvance,
    data.gPartyAdvance,
    data.gOther
  );
  const rTotalFreight = tripLegTotal(data.rFreight, data.rHamali, data.rOthers);
  const rBalance = tripLegBalance(
    rTotalFreight,
    data.rDiesel,
    data.rDriverAdvance,
    data.rPartyAdvance,
    data.rDetention
  );

  try {
    const id = await withTenant(session.tenantId, async (tx) => {
      // trip sheets exist only for Own / Relative vehicles — market (broker)
      // vehicles settle through the chalan / broker slip workflow
      const vehicle = await tx.vehicle.findFirst({ where: { id: data.vehicleId } });
      if (!vehicle) throw new Error("Vehicle not found");
      if (vehicle.ownershipType === "BROKER") {
        throw new Error(
          "Market / broker vehicles are settled via Chalan & Broker Slip — no trip sheet is created for them."
        );
      }

      // Overlapping windows double-consume the register: diesel / toll / urea
      // fetches select purely by vehicle + date range, so two trips sharing a
      // day would each pull the same purchases. Reject the overlap outright.
      const winStart = data.fromDate ? toDate(data.fromDate) : toDate(data.tripDate);
      const rawWinEnd = data.toDate
        ? toDate(data.toDate)
        : data.returnDate
          ? toDate(data.returnDate)
          : toDate(data.tripDate);
      const dayEnd = (dt: Date) =>
        new Date(dt.getFullYear(), dt.getMonth(), dt.getDate(), 23, 59, 59, 999);
      const winEnd = dayEnd(rawWinEnd);
      const others = await tx.trip.findMany({
        where: {
          firmId: session.firmId,
          vehicleId: data.vehicleId,
          deletedAt: null,
          ...(data.id ? { id: { not: data.id } } : {}),
        },
        select: { tripNo: true, tripDate: true, returnDate: true, fromDate: true, toDate: true },
      });
      const clash = others.find((o) => {
        const oStart = o.fromDate ?? o.tripDate;
        const oEnd = dayEnd(o.toDate ?? o.returnDate ?? o.tripDate);
        return oStart <= winEnd && winStart <= oEnd;
      });
      if (clash) {
        throw new Error(
          `Trip window overlaps trip ${clash.tripNo} for this vehicle — diesel / toll / urea would be fetched into both sheets. Adjust the dates.`
        );
      }

      let tripNo = data.tripNo;
      if (!data.id && !tripNo) {
        tripNo = await nextDocNumber(tx, {
          tenantId: session.tenantId,
          firmId: session.firmId,
          fyId: session.fyId,
          docType: "TRIP",
        });
      }

      const tripData = {
        tripNo,
        tripDate: toDate(data.tripDate),
        returnDate: data.returnDate ? toDate(data.returnDate) : null,
        vehicleId: data.vehicleId,
        vehicleType: data.vehicleType || null,
        driverId: data.driverId || null,
        driverBalance: data.driverBalance,
        ureaQty: data.ureaQty,
        ureaRate: data.ureaRate,
        ureaAmount: Math.round(data.ureaQty * data.ureaRate * 100) / 100,
        ureaExpenseType: data.ureaExpenseType,
        calcMethod: data.calcMethod,
        fromDate: data.fromDate ? toDate(data.fromDate) : null,
        toDate: data.toDate ? toDate(data.toDate) : null,
        tollExpenseType: data.tollExpenseType,
        tollAmount: data.tollAmount,
        actualDiesel: data.actualDiesel,
        actualAdvance: data.actualAdvance,
        loadingKm: data.loadingKm,
        unloadingKm: data.unloadingKm,
        newLoadingKm: data.newLoadingKm,
        dieselAvg: data.dieselAvg,
        dieselAvg2: data.dieselAvg2,
        dieselRate: data.dieselRate,
        apprDriverAdvance: data.apprDriverAdvance,
        roadBillExp: data.roadBillExp,
        foodingDays: data.foodingDays,
        foodingRate: data.foodingRate,
        rtoExp: data.rtoExp,
        fixedTripExp: data.fixedTripExp,
        roadExp: data.roadExp,
        otherOpExp: data.otherOpExp,
        autoFetchedExp: data.autoFetchedExp,
        actualTotal: data.actualTotal,
        approvedTotal: data.approvedTotal,
        grandTotal: data.grandTotal,
        goingPartyId: data.goingPartyId || null,
        goingSourceCityId: data.goingSourceCityId || null,
        goingDestCityId: data.goingDestCityId || null,
        gFreight: data.gFreight,
        gHamali: data.gHamali,
        gOthers: data.gOthers,
        gTotalFreight,
        gDiesel: data.gDiesel,
        gDriverAdvance: data.gDriverAdvance,
        gPartyAdvance: data.gPartyAdvance,
        gOther: data.gOther,
        gBankName: data.gBankName || null,
        gBalance,
        gRemarks: data.gRemarks || null,
        returnPartyId: data.returnPartyId || null,
        returnSourceCityId: data.returnSourceCityId || null,
        returnDestCityId: data.returnDestCityId || null,
        rFreight: data.rFreight,
        rHamali: data.rHamali,
        rOthers: data.rOthers,
        rTotalFreight,
        rDiesel: data.rDiesel,
        rDriverAdvance: data.rDriverAdvance,
        rPartyAdvance: data.rPartyAdvance,
        rDetention: data.rDetention,
        rBankName: data.rBankName || null,
        rBalance,
        rRemarks: data.rRemarks || null,
      };

      const ureaAmount = Math.round(data.ureaQty * data.ureaRate * 100) / 100;
      const expenses = data.expenses
        // the auto urea row is always regenerated server-side — never trusted
        // from the client (prevents duplicates on edit)
        .filter((e) => e.remarks !== UREA_AUTO_REMARK)
        .filter((e) => e.amount > 0 || e.remarks)
        .map((e) => ({
          tenantId: session.tenantId,
          category: e.category,
          amount: e.amount,
          remarks: e.remarks || null,
          date: e.date ? toDate(e.date) : null,
        }));
      // company urea goes into the trip's company expenses / vehicle cost;
      // driver urea stays out of company expenses (actual driver expense side)
      if (data.ureaExpenseType === "COMPANY" && ureaAmount > 0) {
        expenses.push({
          tenantId: session.tenantId,
          category: "UREA",
          amount: ureaAmount,
          remarks: UREA_AUTO_REMARK,
          date: toDate(data.tripDate),
        });
      }

      let savedId: string;
      if (data.id) {
        const before = await tx.trip.findFirstOrThrow({
          // firm-scoped: a trip id from another firm must not be editable here
          where: { id: data.id, firmId: session.firmId },
          include: { expenses: true },
        });
        if (before.deletedAt) throw new Error("Trip has been deleted");
        // chain lock: paid accounts are frozen — editing them would desync the
        // money already handed over via the settlement
        const settled = await tx.driverSettlement.findFirst({
          where: { tripId: data.id, deletedAt: null, status: "SETTLED" },
        });
        if (settled) {
          throw new Error(
            "This trip's driver settlement is already PAID — reverse that settlement/voucher first, then the trip sheet's accounts can change."
          );
        }
        await tx.tripExpense.deleteMany({ where: { tripId: data.id } });
        const updated = await tx.trip.update({
          where: { id: data.id },
          data: { ...tripData, expenses: { create: expenses } },
          include: { expenses: true },
        });
        savedId = updated.id;
        await audit(tx, session, {
          entity: "Trip",
          entityId: savedId,
          action: "UPDATE",
          before,
          after: updated,
        });
      } else {
        const created = await tx.trip.create({
          data: {
            tenantId: session.tenantId,
            firmId: session.firmId,
            fyId: session.fyId,
            ...tripData,
            expenses: { create: expenses },
          },
          include: { expenses: true },
        });
        savedId = created.id;
        await audit(tx, session, {
          entity: "Trip",
          entityId: savedId,
          action: "CREATE",
          after: created,
        });
      }

      await syncSequenceTo(tx, {
        tenantId: session.tenantId,
        firmId: session.firmId,
        fyId: session.fyId,
        docType: "TRIP",
        savedNumber: tripNo,
      });

      // ---- chalan / broker-slip links: unique(refType, refId) guarantees a
      // document settles in exactly ONE trip sheet (pending enforcement)
      await tx.tripDoc.deleteMany({ where: { tripId: savedId } });
      if (data.docs.length) {
        // release links held by DEAD trips for the selected docs — an orphan
        // link (trip deleted/missing but the row left behind) would otherwise
        // hit the unique constraint even though the pending list rightly
        // offered the document
        const holders = await tx.tripDoc.findMany({
          where: { OR: data.docs.map((d) => ({ refType: d.refType, refId: d.refId })) },
          select: { id: true, tripId: true },
        });
        if (holders.length) {
          const holderTrips = await tx.trip.findMany({
            where: {
              id: { in: Array.from(new Set(holders.map((h) => h.tripId))) },
              deletedAt: null,
            },
            select: { id: true },
          });
          const alive = new Set(holderTrips.map((t) => t.id));
          const stale = holders.filter((h) => !alive.has(h.tripId));
          if (stale.length) {
            await tx.tripDoc.deleteMany({ where: { id: { in: stale.map((s) => s.id) } } });
          }
        }
        try {
          await tx.tripDoc.createMany({
            data: data.docs.map((doc) => ({
              tenantId: session.tenantId,
              tripId: savedId,
              refType: doc.refType,
              refId: doc.refId,
            })),
          });
        } catch (e) {
          if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") {
            throw new Error(
              "One of the selected chalans / broker slips is already settled in another trip sheet."
            );
          }
          throw e;
        }
      }

      // ---- Driver Advance Register sync: the register is the source of
      // truth; the trip only consumes (marks ADJUSTED) the fetched advances.
      // Release everything previously linked, then re-link the current set —
      // no duplicates possible.
      await tx.driverAdvance.updateMany({
        where: { tripId: savedId },
        data: { status: "PENDING", tripId: null, adjustedDate: null },
      });
      if (data.driverId && data.advanceIds.length) {
        await tx.driverAdvance.updateMany({
          where: {
            id: { in: data.advanceIds },
            driverId: data.driverId,
            status: "PENDING",
            deletedAt: null,
          },
          // adjusted date = trip sheet finalization (save) date
          data: { status: "ADJUSTED", tripId: savedId, adjustedDate: new Date() },
        });
      }

      // ---- Driver +/- settlement: one row per trip, auto-posted
      const existingSettlement = await tx.driverSettlement.findFirst({
        where: { tripId: savedId, deletedAt: null },
      });
      // a SETTLED balance is money that already moved — silently dropping the
      // recomputed delta hid the mismatch; refuse the edit instead
      if (
        existingSettlement?.status === "SETTLED" &&
        Math.abs(toNumSafe(existingSettlement.amount) - data.driverBalance) >= 0.01
      ) {
        throw new Error(
          `Trip already settled — the driver balance cannot change (settled ${toNumSafe(existingSettlement.amount)}, recomputed ${data.driverBalance}). Reverse the settlement voucher first.`
        );
      }
      if (data.driverId && data.driverBalance !== 0) {
        const sData = {
          date: data.returnDate ? toDate(data.returnDate) : toDate(data.tripDate),
          driverId: data.driverId,
          vehicleId: data.vehicleId,
          tripRef: tripNo,
          amount: data.driverBalance,
          remarks: `Trip ${tripNo} driver balance`,
        };
        if (!existingSettlement) {
          await tx.driverSettlement.create({
            data: {
              tenantId: session.tenantId,
              firmId: session.firmId,
              fyId: session.fyId,
              tripId: savedId,
              ...sData,
            },
          });
        } else if (existingSettlement.status === "PENDING") {
          await tx.driverSettlement.update({
            where: { id: existingSettlement.id },
            data: sData,
          });
        }
        // settled rows are never modified — the settled amount must not change
      } else if (existingSettlement && existingSettlement.status === "PENDING") {
        await tx.driverSettlement.update({
          where: { id: existingSettlement.id },
          data: { deletedAt: new Date() },
        });
      }

      // ---- relative-vehicle urea: the allocated amount moves out of the
      // Urea Expense Ledger into the relative owner's ledger
      await reverseLedger(tx, "TRIP_UREA", savedId);
      if (vehicle.ownershipType === "RELATIVE" && vehicle.ownerId && ureaAmount > 0) {
        const ureaHead = await ensureAccountHead(tx, session, "Urea Expense", "EXPENSE");
        const common = {
          date: toDate(data.tripDate),
          refType: "TRIP_UREA",
          refId: savedId,
          refNo: tripNo,
          narration: `Urea ${data.ureaQty} L × ${data.ureaRate} for relative vehicle — transferred to owner (trip ${tripNo})`,
        };
        await postLedger(tx, session, [
          { ...common, partyId: vehicle.ownerId, side: "DEBIT", amount: ureaAmount },
          { ...common, accountHeadId: ureaHead, side: "CREDIT", amount: ureaAmount },
        ]);
      }

      // ---- ACTUAL method, relative vehicle: the sheet's manual operating
      // expenses were spent on the owner's vehicle — each component lands on
      // HIS ledger (urea/diesel/toll keep their own existing routes)
      await reverseLedger(tx, "TRIP_OPEX", savedId);
      if (
        data.calcMethod === "ACTUAL" &&
        vehicle.ownershipType === "RELATIVE" &&
        vehicle.ownerId
      ) {
        const fooding = round2(data.foodingDays * data.foodingRate);
        const components: [string, number, string][] = [
          ["Road Bill Expense", data.roadBillExp, "Road bills"],
          ["RTO Expense", data.rtoExp, "RTO expenses"],
          ["Fooding Expense", fooding, `Fooding ${data.foodingDays} × ${data.foodingRate}`],
          ["Road Expense", data.roadExp, "Road expenses"],
          ["Other Operating Expense", data.otherOpExp, "Other operating expense"],
        ];
        const entries: Parameters<typeof postLedger>[2] = [];
        for (const [headName, amount, label] of components) {
          if (amount <= 0) continue;
          const headId = await ensureAccountHead(tx, session, headName, "EXPENSE");
          const common = {
            date: toDate(data.tripDate),
            refType: "TRIP_OPEX",
            refId: savedId,
            refNo: tripNo,
            narration: `${label} for relative vehicle — transferred to owner (trip ${tripNo})`,
          };
          entries.push(
            { ...common, partyId: vehicle.ownerId, side: "DEBIT", amount: round2(amount) },
            { ...common, accountHeadId: headId, side: "CREDIT", amount: round2(amount) }
          );
        }
        if (entries.length) await postLedger(tx, session, entries);
      }

      return savedId;
    });

    revalidatePath("/trips");
    return { ok: true, id };
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
      return { ok: false, error: "Trip number already exists" };
    }
    return { ok: false, error: err instanceof Error ? err.message : "Failed to save trip" };
  }
}

export async function deleteTrip(id: string): Promise<{ ok: true } | { ok: false; error: string }> {
  const session = requireSession();
  if (session.role !== "ADMIN" && session.role !== "OWNER") {
    return { ok: false, error: "Only Admin/Owner may delete trips" };
  }
  await authorize(session, "trips", "delete");
  try {
    await withTenant(session.tenantId, async (tx) => {
      const before = await tx.trip.findFirst({
        where: { id, firmId: session.firmId },
      });
      if (!before) throw new Error("Trip not found in this firm");
      // chain lock: a trip whose settlement is already PAID must never vanish
      // under the money — reverse the settlement/voucher first
      const settled = await tx.driverSettlement.findFirst({
        where: { tripId: id, deletedAt: null, status: "SETTLED" },
      });
      if (settled) {
        throw new Error(
          "This trip's driver settlement is already PAID — reverse that settlement/voucher first, then the trip can be deleted."
        );
      }
      await tx.trip.update({ where: { id }, data: { deletedAt: new Date() } });
      // release consumed driver advances; drop the pending settlement row
      await tx.driverAdvance.updateMany({
        where: { tripId: id },
        data: { status: "PENDING", tripId: null, adjustedDate: null },
      });
      await tx.driverSettlement.updateMany({
        where: { tripId: id, status: "PENDING" },
        data: { deletedAt: new Date() },
      });
      await reverseLedger(tx, "TRIP_UREA", id);
      await reverseLedger(tx, "TRIP_OPEX", id);
      // release the chalans / broker slips back to pending
      await tx.tripDoc.deleteMany({ where: { tripId: id } });
      await audit(tx, session, { entity: "Trip", entityId: id, action: "DELETE", before });
    });
    revalidatePath("/trips");
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "Failed to delete trip" };
  }
}

export interface TripSource {
  kind: "LR" | "BROKER_SLIP";
  id: string;
  docNo: string;
  partyId: string | null;
  partyName: string | null;
  sourceCityId: string | null;
  sourceCity: string | null;
  destCityId: string | null;
  destCity: string | null;
  weight: number;
  freight: number;
  advance: number;
}

/** Matching LRs / broker slips for a vehicle on a date — used to prefill the going leg. */
export async function findTripSources(vehicleId: string, dateIso: string): Promise<TripSource[]> {
  const session = requireSession();
  const dayStart = toDate(dateIso);
  const dayEnd = new Date(dayStart);
  dayEnd.setDate(dayEnd.getDate() + 1);
  const range = { gte: dayStart, lt: dayEnd };

  return withTenant(session.tenantId, async (tx) => {
    const [lrs, slips, cities, parties] = await Promise.all([
      tx.lr.findMany({
        // date-scoped, not FY-scoped: a trip range crossing 31 March must
        // fetch documents from both years (the trip owns its dates)
        where: {
          firmId: session.firmId,
          vehicleId,
          lrDate: range,
          deletedAt: null,
          lrType: { notIn: ["CANCELLED", "PAPER_CHANGE"] },
        },
        include: { items: true },
      }),
      tx.brokerSlip.findMany({
        where: {
          firmId: session.firmId,
          vehicleId,
          slipDate: range,
          deletedAt: null,
        },
      }),
      tx.city.findMany(),
      tx.party.findMany(),
    ]);
    const cityName = new Map(cities.map((c) => [c.id, c.name]));
    const partyName = new Map(parties.map((p) => [p.id, p.name]));

    const out: TripSource[] = [];
    for (const lr of lrs) {
      out.push({
        kind: "LR",
        id: lr.id,
        docNo: lr.lrNo,
        partyId: lr.consignorId,
        partyName: partyName.get(lr.consignorId) ?? null,
        sourceCityId: lr.sourceCityId,
        sourceCity: cityName.get(lr.sourceCityId) ?? null,
        destCityId: lr.destCityId,
        destCity: cityName.get(lr.destCityId) ?? null,
        weight: lr.items.reduce((s, i) => s + Number(i.chargeWt), 0),
        freight: Number(lr.freight),
        advance: Number(lr.advance),
      });
    }
    for (const s of slips) {
      out.push({
        kind: "BROKER_SLIP",
        id: s.id,
        docNo: s.slipNo,
        partyId: s.partyId,
        partyName: s.partyId ? partyName.get(s.partyId) ?? null : null,
        sourceCityId: s.loadStationId,
        sourceCity: s.loadStationId ? cityName.get(s.loadStationId) ?? null : null,
        destCityId: s.destCityId,
        destCity: s.destCityId ? cityName.get(s.destCityId) ?? null : null,
        weight: Number(s.chargeWt),
        freight: Number(s.pFreight),
        advance: Number(s.pAdvance),
      });
    }
    return out;
  });
}

// ------------------------------------------------- trip settlement fetches

export interface PendingTripDoc {
  refType: "CHALAN" | "BROKER_SLIP";
  refId: string;
  docNo: string;
  date: string; // ISO
  name: string; // company (chalan broker) / broker (slip transporter)
  from: string;
  to: string;
  actualWt: number;
  chargeWt: number;
  rate: number;
  freight: number;
  /** detention + ODC + fine slip + other */
  additions: number;
  /** LD + commission + mamul + courier + TDS + shortage */
  deductions: number;
  /** final receivable/payable of the document — freight + additions − deductions */
  grandTotal: number;
}

/**
 * PENDING chalans & broker slips of a vehicle in a date range — documents
 * already settled in another trip sheet never appear again. Values are read
 * live from the source documents, so later edits reflect automatically.
 */
export async function getPendingTripDocs(input: {
  vehicleId: string;
  dateFrom: string;
  dateTo: string;
  excludeTripId?: string | null;
}): Promise<PendingTripDoc[]> {
  const session = requireSession();
  // Documents are stored at MIDNIGHT OF WHATEVER TIMEZONE the saving machine
  // was in — a chalan dated 3/8 entered on an IST machine is 2/8 18:30 UTC,
  // the same chalan entered on a UTC server is 3/8 00:00 UTC. Comparing raw
  // timestamps against boundaries built on THIS machine therefore drops
  // documents dated exactly on the range edge whenever the two machines
  // disagree. So: fetch a day wide on both ends, then filter by the intended
  // CALENDAR date — timestamp + 12h in UTC recovers the calendar day for any
  // storage timezone within ±12 hours of UTC.
  const range = {
    gte: new Date(new Date(`${input.dateFrom}T00:00:00Z`).getTime() - 24 * 3600 * 1000),
    lte: new Date(new Date(`${input.dateTo}T23:59:59.999Z`).getTime() + 24 * 3600 * 1000),
  };
  const calendarDate = (d: Date) =>
    new Date(d.getTime() + 12 * 3600 * 1000).toISOString().slice(0, 10);
  const inRange = (d: Date) => {
    const c = calendarDate(d);
    return c >= input.dateFrom && c <= input.dateTo;
  };
  return withTenant(session.tenantId, async (tx) => {
    const linked = await tx.tripDoc.findMany({
      where: input.excludeTripId ? { tripId: { not: input.excludeTripId } } : {},
      select: { tripId: true, refType: true, refId: true },
    });
    // only a link whose trip is still ALIVE hides a document — an orphan link
    // (its trip deleted or missing, but the link row left behind) must not
    // bury a chalan/slip in no-man's-land forever
    const liveTrips = await tx.trip.findMany({
      where: {
        id: { in: Array.from(new Set(linked.map((l) => l.tripId))) },
        deletedAt: null,
      },
      select: { id: true },
    });
    const liveTripIds = new Set(liveTrips.map((t) => t.id));
    const linkedSet = new Set(
      linked.filter((l) => liveTripIds.has(l.tripId)).map((l) => `${l.refType}:${l.refId}`)
    );

    const [chalans, slips, cities, parties] = await Promise.all([
      tx.chalan.findMany({
        // date-scoped, not FY-scoped: a trip range crossing 31 March must
        // fetch documents from both years
        where: {
          firmId: session.firmId,
          vehicleId: input.vehicleId,
          chalanDate: range,
          deletedAt: null,
        },
        include: { lrs: { include: { lr: true } } },
      }),
      tx.brokerSlip.findMany({
        where: {
          firmId: session.firmId,
          vehicleId: input.vehicleId,
          slipDate: range,
          deletedAt: null,
        },
      }),
      tx.city.findMany(),
      tx.party.findMany(),
    ]);
    const cityName = (id: string | null | undefined) =>
      id ? cities.find((c) => c.id === id)?.name ?? "" : "";
    const partyName = (id: string | null | undefined) =>
      id ? parties.find((p) => p.id === id)?.name ?? "" : "";

    const out: PendingTripDoc[] = [];
    for (const c of chalans) {
      if (linkedSet.has(`CHALAN:${c.id}`)) continue;
      if (!inRange(c.chalanDate)) continue;
      const firstLr = c.lrs[0]?.lr;
      const totals = chalanTotals(c);
      out.push({
        refType: "CHALAN",
        refId: c.id,
        docNo: c.chalanNo,
        date: c.chalanDate.toISOString(),
        name: c.transportName || partyName(c.brokerId),
        from: cityName(firstLr?.sourceCityId),
        to: cityName(firstLr?.destCityId),
        actualWt: toNumSafe(c.actualWt),
        chargeWt: toNumSafe(c.chargeWt),
        rate: toNumSafe(c.rate),
        freight: totals.freight,
        additions: totals.additions,
        deductions: totals.deductions,
        grandTotal: totals.grandTotal,
      });
    }
    for (const s of slips) {
      if (linkedSet.has(`BROKER_SLIP:${s.id}`)) continue;
      if (!inRange(s.slipDate)) continue;
      const totals = slipTotals(s);
      out.push({
        refType: "BROKER_SLIP",
        refId: s.id,
        docNo: s.slipNo,
        date: s.slipDate.toISOString(),
        name: partyName(s.transporterId) || partyName(s.partyId) || s.ownerName || "",
        from: cityName(s.loadStationId),
        to: cityName(s.destCityId),
        actualWt: toNumSafe(s.actualWt),
        chargeWt: toNumSafe(s.chargeWt),
        rate: toNumSafe(s.vRate),
        freight: totals.freight,
        additions: totals.additions,
        deductions: totals.deductions,
        grandTotal: totals.grandTotal,
      });
    }
    return out.sort((a, b) => a.date.localeCompare(b.date));
  });
}

function toNumSafe(v: unknown): number {
  const n = Number(String(v ?? 0));
  return isNaN(n) ? 0 : n;
}

export interface TripSettlementInfo {
  previousBalance: number; // pending settlements of the driver (excl. this trip)
  current: {
    id: string;
    amount: number;
    status: string;
    voucherNo: string;
  } | null;
}

/** Previous pending driver balance + this trip's settlement row (if saved). */
export async function getTripSettlementInfo(input: {
  driverId: string;
  excludeTripId?: string | null;
}): Promise<TripSettlementInfo> {
  const session = requireSession();
  return withTenant(session.tenantId, async (tx) => {
    const pending = await tx.driverSettlement.findMany({
      where: {
        firmId: session.firmId,
        driverId: input.driverId,
        status: "PENDING",
        deletedAt: null,
        ...(input.excludeTripId ? { OR: [{ tripId: null }, { tripId: { not: input.excludeTripId } }] } : {}),
      },
    });
    const previousBalance =
      Math.round(pending.reduce((s, r) => s + toNumSafe(r.amount), 0) * 100) / 100;
    const current = input.excludeTripId
      ? await tx.driverSettlement.findFirst({
          where: { tripId: input.excludeTripId, deletedAt: null },
        })
      : null;
    return {
      previousBalance,
      current: current
        ? {
            id: current.id,
            amount: toNumSafe(current.amount),
            status: current.status,
            voucherNo: current.voucherNo ?? "",
          }
        : null,
    };
  });
}

/**
 * Last saved "New Loading KM" of the vehicle's previous trip sheet — used to
 * prefill the next trip's Loading KM (editable; warning only, never blocks).
 */
export async function getPrevLoadingKm(input: {
  vehicleId: string;
  excludeTripId?: string | null;
}): Promise<{ km: number; tripNo: string } | null> {
  const session = requireSession();
  return withTenant(session.tenantId, async (tx) => {
    const prev = await tx.trip.findFirst({
      where: {
        firmId: session.firmId,
        vehicleId: input.vehicleId,
        deletedAt: null,
        ...(input.excludeTripId ? { id: { not: input.excludeTripId } } : {}),
      },
      orderBy: [{ tripDate: "desc" }, { createdAt: "desc" }],
    });
    if (!prev) return null;
    const km = toNumSafe(prev.newLoadingKm) || toNumSafe(prev.unloadingKm);
    return km > 0 ? { km, tripNo: prev.tripNo } : null;
  });
}
