"use server";

import { revalidatePath } from "next/cache";
import { requireSession } from "@/lib/session";
import { withTenant } from "@/lib/db";
import { authorize } from "@/lib/authz";
import { audit } from "@/lib/audit";

/**
 * E-Way Bill monitoring actions. Dates are handled as CALENDAR dates
 * (yyyy-mm-dd): stored timestamps sit at the saving machine's midnight, so the
 * +12h trick recovers the intended calendar day regardless of timezone.
 */

const REVALIDATE = "/eway";

const calDate = (d: Date): string =>
  new Date(d.getTime() + 12 * 3600 * 1000).toISOString().slice(0, 10);

/** Mark an LR's e-way bill as verified (or clear the mark with checked=false). */
export async function setEwayChecked(
  lrId: string,
  checked: boolean
): Promise<{ ok: true } | { ok: false; error: string }> {
  const session = requireSession();
  await authorize(session, "lr", "edit");
  try {
    await withTenant(session.tenantId, async (tx) => {
      const lr = await tx.lr.findFirst({
        where: { id: lrId, firmId: session.firmId, fyId: session.fyId, deletedAt: null },
      });
      if (!lr) throw new Error("LR not found");
      await tx.ewayMonitor.upsert({
        where: { lrId },
        create: {
          tenantId: session.tenantId,
          firmId: session.firmId,
          fyId: session.fyId,
          lrId,
          checkedAt: checked ? new Date() : null,
          checkedById: checked ? session.userId : null,
          checkedBy: checked ? session.name : null,
        },
        update: {
          checkedAt: checked ? new Date() : null,
          checkedById: checked ? session.userId : null,
          checkedBy: checked ? session.name : null,
        },
      });
    });
    revalidatePath(REVALIDATE);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "Failed" };
  }
}

/** Extend / correct the e-way expiry. The old date goes into the history so
 *  the old tab reads "Extended Till <new>"; the check mark resets because the
 *  renewed bill needs a fresh verification. */
export async function extendEway(
  lrId: string,
  newExpiry: string,
  /** which e-way bill of the LR (an LR may carry several); blank = the first */
  ewayNo?: string | null
): Promise<{ ok: true } | { ok: false; error: string }> {
  const session = requireSession();
  await authorize(session, "lr", "edit");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(newExpiry)) {
    return { ok: false, error: "Valid expiry date is required" };
  }
  // an extension moves the expiry FORWARD — today (IST) or later; a mistyped
  // past date would silently bury the LR in an old tab
  const todayIst = new Date(Date.now() + 5.5 * 3600 * 1000).toISOString().slice(0, 10);
  if (newExpiry < todayIst) {
    return { ok: false, error: `New expiry cannot be before today (${todayIst})` };
  }
  try {
    await withTenant(session.tenantId, async (tx) => {
      const lr = await tx.lr.findFirst({
        where: { id: lrId, firmId: session.firmId, fyId: session.fyId, deletedAt: null },
      });
      if (!lr) throw new Error("LR not found");
      // the invoice line that carries this e-way bill (first line if unnamed)
      const line = await tx.lrInvoice.findFirst({
        where: { lrId, ...(ewayNo ? { ewayBillNo: ewayNo } : { ewayBillNo: { not: null } }) },
        orderBy: { sortOrder: "asc" },
      });
      const oldExpiry = line?.ewayExpiry ?? lr.ewayExpiry;
      const oldCal = oldExpiry ? calDate(oldExpiry) : null;
      const monitor = await tx.ewayMonitor.findUnique({ where: { lrId } });
      const prev: string[] = Array.isArray(monitor?.prevExpiries)
        ? (monitor?.prevExpiries as string[])
        : [];
      if (oldCal && oldCal !== newExpiry && !prev.includes(oldCal)) prev.push(oldCal);

      const expiry = new Date(`${newExpiry}T00:00:00`);
      if (line) {
        await tx.lrInvoice.update({ where: { id: line.id }, data: { ewayExpiry: expiry } });
      }
      // the LR's own column mirrors the FIRST line (or is the only record)
      if (!line || line.sortOrder === 0 || !lr.ewayBillNo || lr.ewayBillNo === line.ewayBillNo) {
        await tx.lr.update({ where: { id: lrId }, data: { ewayExpiry: expiry } });
      }
      await tx.ewayMonitor.upsert({
        where: { lrId },
        create: {
          tenantId: session.tenantId,
          firmId: session.firmId,
          fyId: session.fyId,
          lrId,
          prevExpiries: prev,
          checkedAt: null,
        },
        update: { prevExpiries: prev, checkedAt: null, checkedById: null, checkedBy: null },
      });
      await audit(tx, session, {
        entity: "Lr",
        entityId: lrId,
        action: "UPDATE",
        after: { ewayExpiry: newExpiry, extendedFrom: oldCal },
      });
    });
    revalidatePath(REVALIDATE);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "Failed" };
  }
}
