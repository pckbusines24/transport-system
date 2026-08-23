"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { Prisma } from "@prisma/client";
import { requireSession } from "@/lib/session";
import { withTenant, type Tx } from "@/lib/db";
import { authorize } from "@/lib/authz";
import { audit } from "@/lib/audit";
import { assertDateInFy } from "@/lib/fy-guard";
import { toNum } from "@/lib/utils";
import { nextLrNumber, syncSequenceTo } from "@/lib/sequences";
import { stateCodeFromGstin } from "@/lib/calc/gst";
import { computeLrTotals, itemAmount } from "@/components/lr/lr-calc";
import { resyncInvoicesForLr } from "@/app/(app)/billing/actions";
import { loadLrFormData, type LrFormData } from "./form-data";

const rateBasisSchema = z.enum(["QTY", "ACTUAL_WT", "CHARGE_WT", "FIXED"]);
const lrTypeSchema = z.enum(["TO_PAY", "TBB", "PAID", "FOC", "CANCELLED", "PAPER_CHANGE"]);

const itemSchema = z.object({
  productId: z.string().nullish(),
  productName: z.string().min(1, "Product is required"),
  description: z.string().nullish(),
  qty: z.number().min(0).default(0),
  actualWt: z.number().min(0).default(0),
  chargeWt: z.number().min(0).default(0),
  unit: z.string().default("MT"),
  rate: z.number().min(0).default(0),
  rateBasis: rateBasisSchema.default("CHARGE_WT"),
});

const lrSchema = z.object({
  id: z.string().nullish(),
  lrNo: z.string().trim().min(1, "LR number is required"),
  lrDate: z.string().min(1, "LR date is required"), // ISO yyyy-mm-dd
  refLrNo: z.string().nullish(),
  privateMarka: z.string().nullish(),
  isDummy: z.boolean().default(false),
  sourceCityId: z.string().min(1, "Source city is required"),
  destCityId: z.string().min(1, "Destination city is required"),
  consignorId: z.string().min(1, "Consignor is required"),
  consigneeId: z.string().min(1, "Consignee is required"),
  billToId: z.string().nullish(),
  vehicleId: z.string().nullish(),
  vehicleText: z.string().nullish(),
  ownerName: z.string().nullish(),
  deliveryAt: z.string().nullish(),
  remarks: z.string().nullish(),
  lrType: lrTypeSchema.default("TBB"),
  cargoType: z.enum(["NORMAL", "ODC"]).default("NORMAL"),
  printFreight: z.boolean().default(true),
  gstApplicable: z.boolean().default(false),

  insCompany: z.string().nullish(),
  insPolicyNo: z.string().nullish(),
  insAmount: z.number().min(0).nullish(),

  invoiceNo: z.string().nullish(),
  obdNo: z.string().nullish(),
  refNo: z.string().nullish(),
  invoiceDate: z.string().nullish(),
  goodsValue: z.number().min(0).nullish(),
  ewayBillNo: z.string().nullish(),
  ewayExpiry: z.string().nullish(),

  freight: z.number().min(0).default(0),
  hamali: z.number().min(0).default(0),
  preBhada: z.number().min(0).default(0),
  biltyCharge: z.number().min(0).default(0),
  collCharge: z.number().min(0).default(0),
  cpc: z.number().min(0).default(0),
  otherCharge: z.number().min(0).default(0),
  advance: z.number().min(0).default(0),
  advanceBank: z.string().nullish(),

  items: z.array(itemSchema).min(1, "At least one item is required"),
});


/** Authoritative cargo type: ODC if any item's product is ODC in the master. */
async function deriveCargoType(
  tx: Tx,
  items: { productId?: string | null }[]
): Promise<"NORMAL" | "ODC"> {
  const ids = items.map((i) => i.productId).filter(Boolean) as string[];
  if (ids.length === 0) return "NORMAL";
  const odc = await tx.product.findFirst({
    where: { id: { in: ids }, productType: "ODC" },
    select: { id: true },
  });
  return odc ? "ODC" : "NORMAL";
}

export type SaveLrResult = { ok: true; id: string } | { ok: false; error: string };

function toDate(s: string): Date {
  return new Date(s.includes("T") ? s : `${s}T00:00:00`);
}

type LrInput = z.infer<typeof lrSchema>;

/** Map a validated LR payload + computed totals to the Lr row shape. */
function lrRowData(
  data: LrInput,
  totals: ReturnType<typeof computeLrTotals>,
  lrNo: string
) {
  return {
    lrNo,
    lrDate: toDate(data.lrDate),
    refLrNo: data.refLrNo || null,
    privateMarka: data.privateMarka || null,
    isDummy: data.isDummy,
    sourceCityId: data.sourceCityId,
    destCityId: data.destCityId,
    consignorId: data.consignorId,
    consigneeId: data.consigneeId,
    billToId: data.billToId || null,
    vehicleId: data.isDummy ? null : data.vehicleId || null,
    vehicleText: data.isDummy ? data.vehicleText || null : null,
    ownerName: data.ownerName || null,
    deliveryAt: data.deliveryAt || null,
    remarks: data.remarks || null,
    lrType: data.lrType,
    cargoType: data.cargoType,
    printFreight: data.printFreight,
    gstApplicable: data.gstApplicable,
    insCompany: data.insCompany || null,
    insPolicyNo: data.insPolicyNo || null,
    insAmount: data.insAmount ?? null,
    invoiceNo: data.invoiceNo || null,
    obdNo: data.obdNo || null,
    refNo: data.refNo || null,
    invoiceDate: data.invoiceDate ? toDate(data.invoiceDate) : null,
    goodsValue: data.goodsValue ?? null,
    ewayBillNo: data.ewayBillNo || null,
    ewayExpiry: data.ewayExpiry ? toDate(data.ewayExpiry) : null,
    freight: data.freight,
    hamali: data.hamali,
    preBhada: data.preBhada,
    biltyCharge: data.biltyCharge,
    collCharge: data.collCharge,
    cpc: data.cpc,
    otherCharge: data.otherCharge,
    total: totals.total,
    cgstAmt: totals.cgstAmt,
    sgstAmt: totals.sgstAmt,
    igstAmt: totals.igstAmt,
    advance: data.advance,
    advanceBank: data.advanceBank || null,
    grandTotal: totals.grandTotal,
  };
}

function lrItemsData(tenantId: string, data: LrInput) {
  return data.items.map((i) => ({
    tenantId,
    productId: i.productId || null,
    productName: i.productName,
    description: i.description || null,
    qty: i.qty,
    actualWt: i.actualWt,
    chargeWt: i.chargeWt,
    unit: i.unit || "MT",
    rate: i.rate,
    rateBasis: i.rateBasis,
    amount: itemAmount(i),
  }));
}

export async function saveLr(input: unknown): Promise<SaveLrResult> {
  const session = requireSession();
  const parsed = lrSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid input" };
  }
  const data = parsed.data;
  await authorize(session, "lr", data.id ? "edit" : "create");

  try {
    const id = await withTenant(session.tenantId, async (tx) => {
      // firm GST config + party GSTINs for server-side recompute
      const [firm, consignor, consignee] = await Promise.all([
        tx.firm.findUniqueOrThrow({ where: { id: session.firmId } }),
        tx.party.findUniqueOrThrow({ where: { id: data.consignorId } }),
        tx.party.findUniqueOrThrow({ where: { id: data.consigneeId } }),
      ]);
      const igstPct = Number(firm.igstPct);
      const gstPct = igstPct > 0 ? igstPct : Number(firm.cgstPct) + Number(firm.sgstPct);

      const totals = computeLrTotals({
        freight: data.freight,
        hamali: data.hamali,
        preBhada: data.preBhada,
        biltyCharge: data.biltyCharge,
        collCharge: data.collCharge,
        cpc: data.cpc,
        otherCharge: data.otherCharge,
        gstApplicable: data.gstApplicable,
        gstPct,
        supplierStateCode: stateCodeFromGstin(consignor.gstin),
        recipientStateCode: stateCodeFromGstin(consignee.gstin),
        advance: data.advance,
      });

      let lrNo = data.lrNo;
      if (!data.id && !lrNo) {
        lrNo = await nextLrNumber(tx, { firmId: session.firmId, fyId: session.fyId });
      }

      // the LR being edited — ANY year's LR opens from here (FY continuity);
      // the date guard below then keeps its date inside the LR's OWN year
      const before = data.id
        ? await tx.lr.findFirst({
            where: { id: data.id, firmId: session.firmId },
            include: { items: true },
          })
        : null;
      if (data.id && !before) throw new Error("LR not found in this firm");
      if (before?.deletedAt) throw new Error("LR has been deleted");
      // an edit stays in the LR's own financial year; only a fresh LR belongs
      // to the session's — numbering, the clash check and the date guard all
      // follow the document's year, not the year the user is standing in
      const docFyId = before?.fyId ?? session.fyId;

      // duplicate check: only ACTIVE LRs in the DOCUMENT'S financial year
      // count — deleted LR numbers are reusable, and other FYs may repeat
      // the sequence
      const clash = await tx.lr.findFirst({
        where: {
          firmId: session.firmId,
          fyId: docFyId,
          lrNo,
          deletedAt: null,
          ...(data.id ? { id: { not: data.id } } : {}),
        },
        select: { id: true },
      });
      if (clash) {
        throw new Error(
          "This LR Number already exists in the current Financial Year. Please enter a different LR Number."
        );
      }

      data.cargoType = await deriveCargoType(tx, data.items);
      const lrData = lrRowData(data, totals, lrNo);
      const items = lrItemsData(session.tenantId, data);
      // wrong-FY guard: the date must belong to the LR's own FY (edit) or the
      // session FY (fresh)
      await assertDateInFy(tx, { fyId: docFyId }, lrData.lrDate, "LR entry");

      let savedId: string;
      if (before) {
        await tx.lrItem.deleteMany({ where: { lrId: before.id } });
        const updated = await tx.lr.update({
          where: { id: before.id },
          data: { ...lrData, items: { create: items } },
          include: { items: true },
        });
        savedId = updated.id;
        await audit(tx, session, {
          entity: "Lr",
          entityId: savedId,
          action: "UPDATE",
          before,
          after: updated,
        });
        // invoice totals are snapshots — a billed LR edited here (e.g. from
        // the bill preview) must flow through to its live bills
        await resyncInvoicesForLr(tx, session, savedId);
      } else {
        const created = await tx.lr.create({
          data: {
            tenantId: session.tenantId,
            firmId: session.firmId,
            fyId: session.fyId,
            createdById: session.userId,
            ...lrData,
            items: { create: items },
          },
          include: { items: true },
        });
        savedId = created.id;
        await audit(tx, session, {
          entity: "Lr",
          entityId: savedId,
          action: "CREATE",
          after: created,
        });
      }

      await syncSequenceTo(tx, {
        tenantId: session.tenantId,
        firmId: session.firmId,
        // LR numbering restarts each FY — an old-year edit must bump ITS
        // year's sequence, not fast-forward the current year's counter
        fyId: docFyId,
        docType: "LR",
        savedNumber: lrNo,
      });

      return savedId;
    });

    revalidatePath("/lr/register");
    // the two audit reports read the same LRs, so they must not serve a
    // stale copy after an edit or delete
    revalidatePath("/reports/cancelled-lrs");
    revalidatePath("/reports/paper-change-lrs");
    return { ok: true, id };
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
      return {
        ok: false,
        error:
          "This LR Number already exists in the current Financial Year. Please enter a different LR Number.",
      };
    }
    return { ok: false, error: err instanceof Error ? err.message : "Failed to save LR" };
  }
}

export async function deleteLr(id: string): Promise<{ ok: true } | { ok: false; error: string }> {
  const session = requireSession();
  if (session.role !== "ADMIN" && session.role !== "OWNER") {
    return { ok: false, error: "Only Admin/Owner may delete LRs" };
  }
  await authorize(session, "lr", "delete");
  try {
    await withTenant(session.tenantId, async (tx) => {
      const before = await tx.lr.findFirst({
        where: { id, firmId: session.firmId },
        include: {
          invoiceLrs: { include: { invoice: { select: { invoiceNo: true, deletedAt: true } } } },
          chalanLrs: { include: { chalan: { select: { chalanNo: true, deletedAt: true, cancelledAt: true } } } },
          pods: { select: { id: true } },
        },
      });
      if (!before) throw new Error("LR not found in this firm");
      // an LR woven into financial documents must not vanish: the invoice's
      // totals/ledger and the chalan's hire were computed WITH this LR — the
      // dependent document must go first, never the LR under it
      const liveBill = before.invoiceLrs.find((l) => !l.invoice.deletedAt);
      if (liveBill) {
        throw new Error(
          `LR ${before.lrNo} is billed on invoice ${liveBill.invoice.invoiceNo} — delete that bill first.`
        );
      }
      const liveChalan = before.chalanLrs.find(
        (l) => !l.chalan.deletedAt && !l.chalan.cancelledAt
      );
      if (liveChalan) {
        throw new Error(
          `LR ${before.lrNo} is loaded on chalan ${liveChalan.chalan.chalanNo} — remove it from that chalan (or delete the chalan) first.`
        );
      }
      if (before.pods.length > 0) {
        throw new Error(`LR ${before.lrNo} has a POD — delete the POD entry first.`);
      }
      // cascade: only stale links to deleted/cancelled documents remain now
      await tx.chalanLr.deleteMany({ where: { lrId: id } });
      await tx.invoiceLr.deleteMany({ where: { lrId: id } });
      await tx.lr.update({ where: { id }, data: { deletedAt: new Date() } });
      await audit(tx, session, { entity: "Lr", entityId: id, action: "DELETE", before });
    });
    revalidatePath("/lr/register");
    // the two audit reports read the same LRs, so they must not serve a
    // stale copy after an edit or delete
    revalidatePath("/reports/cancelled-lrs");
    revalidatePath("/reports/paper-change-lrs");
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "Failed to delete LR" };
  }
}

export interface LrLifecycle {
  booking: {
    lrNo: string;
    lrDate: string;
    status: string;
    lrType: string;
    route: string;
    consignor: string;
    consignee: string;
    vehicle: string;
    freight: number;
    grandTotal: number;
    items: string;
  };
  chalans: {
    chalanNo: string;
    chalanDate: string;
    broker: string;
    vehicle: string;
    driver: string;
    freight: number;
    unloadDate: string | null;
  }[];
  pods: {
    docNo: string;
    docDate: string;
    unloadDate: string | null;
    ackNo: string;
    recWt: number | null;
    shortageWt: number | null;
    status: string;
  }[];
  invoices: {
    invoiceNo: string;
    invoiceDate: string;
    kind: string;
    party: string;
    netTotal: number;
    balance: number;
  }[];
}

/** Complete lifecycle of one LR: booking -> chalan -> POD -> billing. */
export async function getLrLifecycle(id: string): Promise<LrLifecycle | null> {
  const session = requireSession();
  return withTenant(session.tenantId, async (tx) => {
    const lr = await tx.lr.findFirst({
      where: { id, firmId: session.firmId, deletedAt: null },
      include: {
        items: true,
        chalanLrs: { include: { chalan: true } },
        pods: true,
        invoiceLrs: { include: { invoice: true } },
      },
    });
    if (!lr) return null;
    const [cities, parties, vehicles] = await Promise.all([
      tx.city.findMany(),
      tx.party.findMany(),
      tx.vehicle.findMany(),
    ]);
    const cityName = (cid: string | null) => cities.find((c) => c.id === cid)?.name ?? "";
    const partyName = (pid: string | null) => parties.find((p) => p.id === pid)?.name ?? "";
    const vehicleNo = (vid: string | null) => vehicles.find((v) => v.id === vid)?.number ?? "";
    const n = (v: unknown) => toNum(String(v));
    return {
      booking: {
        lrNo: lr.lrNo,
        lrDate: lr.lrDate.toISOString(),
        status: lr.status,
        lrType: lr.lrType,
        route: `${cityName(lr.sourceCityId)} → ${cityName(lr.destCityId)}`,
        consignor: partyName(lr.consignorId),
        consignee: partyName(lr.consigneeId),
        vehicle: (lr.vehicleId && vehicleNo(lr.vehicleId)) || lr.vehicleText || "",
        freight: n(lr.freight),
        grandTotal: n(lr.grandTotal),
        items: lr.items.map((i) => i.productName).join(", "),
      },
      chalans: lr.chalanLrs.map(({ chalan }) => ({
        chalanNo: chalan.chalanNo,
        chalanDate: chalan.chalanDate.toISOString(),
        broker: partyName(chalan.brokerId),
        vehicle: vehicleNo(chalan.vehicleId),
        driver: chalan.driverName ?? "",
        freight: n(chalan.freight),
        unloadDate: chalan.unloadDate ? chalan.unloadDate.toISOString() : null,
      })),
      pods: lr.pods.map((pod) => ({
        docNo: pod.docNo,
        docDate: pod.docDate.toISOString(),
        unloadDate: pod.unloadDate ? pod.unloadDate.toISOString() : null,
        ackNo: pod.ackNo ?? "",
        recWt: pod.recWt == null ? null : n(pod.recWt),
        shortageWt: pod.shortageWt == null ? null : n(pod.shortageWt),
        status: pod.status,
      })),
      invoices: lr.invoiceLrs.map(({ invoice }) => ({
        invoiceNo: invoice.invoiceNo,
        invoiceDate: invoice.invoiceDate.toISOString(),
        kind: invoice.kind,
        party: partyName(invoice.partyId),
        netTotal: n(invoice.netTotal),
        balance: n(invoice.balance),
      })),
    };
  });
}

const batchSchema = z.object({
  entries: z.array(lrSchema.omit({ id: true, lrNo: true }).extend({ lrNo: z.string().optional() })).min(1, "Add at least one LR"),
});

/**
 * Multiple LR creation: full LR payloads saved in ONE database transaction —
 * either every LR is created or none. Each entry keeps its own vehicle, date
 * and owner exactly as the batch tray shows them; LR numbers are assigned
 * sequentially (max existing + 1 onwards) at save time.
 */
export async function saveLrBatch(
  input: unknown
): Promise<{ ok: true; lrNos: string[] } | { ok: false; error: string }> {
  const session = requireSession();
  await authorize(session, "lr", "create");
  const parsed = batchSchema.safeParse(input);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    return {
      ok: false,
      error: issue ? `LR ${Number(issue.path[1] ?? 0) + 1} — ${issue.message}` : "Invalid input",
    };
  }
  const entries = parsed.data.entries;
  try {
    return await withTenant(session.tenantId, async (tx) => {
      const firm = await tx.firm.findUniqueOrThrow({ where: { id: session.firmId } });
      const igstPct = Number(firm.igstPct);
      const gstPct = igstPct > 0 ? igstPct : Number(firm.cgstPct) + Number(firm.sgstPct);
      const first = await nextLrNumber(tx, { firmId: session.firmId, fyId: session.fyId });
      let cursor = parseInt(first, 10);
      const lrNos: string[] = [];

      // user-typed LR numbers are honoured exactly; blanks are auto-assigned
      const used = new Set<string>();
      const assigned: string[] = [];
      for (let i = 0; i < entries.length; i++) {
        const typed = entries[i].lrNo?.trim();
        let lrNo: string;
        if (typed) {
          if (used.has(typed)) {
            return { ok: false as const, error: `LR number ${typed} is used twice in this batch.` };
          }
          lrNo = typed;
        } else {
          while (used.has(String(cursor))) cursor++;
          lrNo = String(cursor++);
        }
        used.add(lrNo);
        assigned.push(lrNo);
      }
      const clashes = await tx.lr.findMany({
        where: {
          firmId: session.firmId,
          fyId: session.fyId,
          lrNo: { in: assigned },
          deletedAt: null,
        },
        select: { lrNo: true },
      });
      if (clashes.length) {
        return {
          ok: false as const,
          error: `LR Number ${clashes[0].lrNo} already exists in the current Financial Year. Please enter a different LR Number.`,
        };
      }

      for (let i = 0; i < entries.length; i++) {
        const data = {
          ...entries[i],
          id: null,
          lrNo: assigned[i],
        };
        const [consignor, consignee] = await Promise.all([
          tx.party.findUniqueOrThrow({ where: { id: data.consignorId } }),
          tx.party.findUniqueOrThrow({ where: { id: data.consigneeId } }),
        ]);
        data.cargoType = await deriveCargoType(tx, data.items);
        const totals = computeLrTotals({
          freight: data.freight,
          hamali: data.hamali,
          preBhada: data.preBhada,
          biltyCharge: data.biltyCharge,
          collCharge: data.collCharge,
          cpc: data.cpc,
          otherCharge: data.otherCharge,
          gstApplicable: data.gstApplicable,
          gstPct,
          supplierStateCode: stateCodeFromGstin(consignor.gstin),
          recipientStateCode: stateCodeFromGstin(consignee.gstin),
          advance: data.advance,
        });
        const created = await tx.lr.create({
          data: {
            tenantId: session.tenantId,
            firmId: session.firmId,
            fyId: session.fyId,
            createdById: session.userId,
            ...lrRowData(data, totals, data.lrNo),
            items: { create: lrItemsData(session.tenantId, data) },
          },
        });
        await audit(tx, session, {
          entity: "Lr",
          entityId: created.id,
          action: "CREATE",
          after: created,
        });
        lrNos.push(data.lrNo);
      }

      await syncSequenceTo(tx, {
        tenantId: session.tenantId,
        firmId: session.firmId,
        fyId: session.fyId,
        docType: "LR",
        savedNumber: lrNos[lrNos.length - 1],
      });
      revalidatePath("/lr/register");
      // the two audit reports read the same LRs, so they must not serve a
      // stale copy after an edit or delete
      revalidatePath("/reports/cancelled-lrs");
      revalidatePath("/reports/paper-change-lrs");
      return { ok: true as const, lrNos };
    });
  } catch (err) {
    // two clerks saving batches at the same moment can race the MAX+1 number
    // scan — surface a retryable message, not a raw constraint error
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
      return {
        ok: false,
        error:
          "An LR number in this batch was just taken by another entry — save again to get fresh numbers.",
      };
    }
    return { ok: false, error: err instanceof Error ? err.message : "Batch save failed" };
  }
}

/**
 * Full LR-form data for editing an LR inside a dialog (e.g. from the bill
 * preview) — same payload the /lr edit page loads. Null if the LR is gone.
 */
export async function getLrFormDataById(lrId: string): Promise<LrFormData | null> {
  const data = await loadLrFormData(lrId);
  if (data.mode !== "edit" || !data.lrId) return null;
  return data;
}
