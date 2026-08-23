"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { requireSession } from "@/lib/session";
import { withTenant, type Tx } from "@/lib/db";
import { authorize } from "@/lib/authz";
import { audit } from "@/lib/audit";

/**
 * Courier Dispatch — standalone manual register. Deliberately NOT linked to
 * any master (party / vehicle / courier company are free text) and posts
 * nothing to the ledger. One dispatch carries unlimited vehicle/document rows.
 */

const REVALIDATE = "/broker/courier";

const itemSchema = z.object({
  vehicleNo: z.string().trim().min(1, "Vehicle number is required in every row"),
  documentDetails: z.string().trim().min(1, "Document details are required in every row"),
  remarks: z.string().nullish(),
});

const schema = z.object({
  id: z.string().nullish(),
  dispatchDate: z.string().min(1, "Dispatch date is required"),
  courierCompany: z.string().trim().min(1, "Courier company is required"),
  trackingNo: z.string().nullish(),
  partyName: z.string().trim().min(1, "Party name is required"),
  remarks: z.string().nullish(),
  attachmentPath: z.string().nullish(),
  attachmentName: z.string().nullish(),
  items: z.array(itemSchema).min(1, "Add at least one vehicle / document row"),
});

async function nextDispatchNo(tx: Tx, firmId: string, fyId: string): Promise<string> {
  const rows = await tx.$queryRaw<{ max: bigint | null }[]>`
    SELECT MAX(NULLIF(regexp_replace("dispatchNo", '\\D', '', 'g'), '')::bigint) AS max
    FROM "CourierDispatch"
    WHERE "firmId" = ${firmId} AND "fyId" = ${fyId}`;
  const max = rows[0]?.max ? Number(rows[0].max) : 0;
  return `CDR-${String(max + 1).padStart(6, "0")}`;
}

export async function saveCourierDispatch(
  input: unknown
): Promise<{ ok: true; id: string; dispatchNo: string } | { ok: false; error: string }> {
  const session = requireSession();
  const parsed = schema.safeParse(input);
  if (!parsed.success) return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid input" };
  const d = parsed.data;
  await authorize(session, "courier", d.id ? "edit" : "create");
  if (d.attachmentPath && !d.attachmentPath.startsWith(`${session.tenantId}/`)) {
    return { ok: false, error: "Invalid attachment path" };
  }

  try {
    return await withTenant(session.tenantId, async (tx) => {
      const values = {
        dispatchDate: new Date(`${d.dispatchDate}T00:00:00`),
        courierCompany: d.courierCompany,
        trackingNo: d.trackingNo?.trim() || null,
        partyName: d.partyName,
        remarks: d.remarks || null,
        attachmentPath: d.attachmentPath || null,
        attachmentName: d.attachmentName || null,
      };

      let id: string;
      let dispatchNo: string;
      if (d.id) {
        const before = await tx.courierDispatch.findFirstOrThrow({
          where: { id: d.id, deletedAt: null },
          include: { items: true },
        });
        const updated = await tx.courierDispatch.update({ where: { id: d.id }, data: values });
        id = updated.id;
        dispatchNo = updated.dispatchNo;
        await tx.courierDispatchItem.deleteMany({ where: { dispatchId: id } });
        await audit(tx, session, {
          entity: "CourierDispatch",
          entityId: id,
          action: "UPDATE",
          before,
          after: { ...updated, items: d.items },
        });
      } else {
        dispatchNo = await nextDispatchNo(tx, session.firmId, session.fyId);
        const created = await tx.courierDispatch.create({
          data: {
            tenantId: session.tenantId,
            firmId: session.firmId,
            fyId: session.fyId,
            dispatchNo,
            createdById: session.userId,
            ...values,
          },
        });
        id = created.id;
        await audit(tx, session, {
          entity: "CourierDispatch",
          entityId: id,
          action: "CREATE",
          after: { ...created, items: d.items },
        });
      }

      await tx.courierDispatchItem.createMany({
        data: d.items.map((it) => ({
          tenantId: session.tenantId,
          dispatchId: id,
          vehicleNo: it.vehicleNo.toUpperCase().replace(/\s+/g, ""),
          documentDetails: it.documentDetails,
          remarks: it.remarks || null,
        })),
      });

      revalidatePath(REVALIDATE);
      return { ok: true as const, id, dispatchNo };
    });
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "Save failed" };
  }
}

export async function deleteCourierDispatch(
  id: string
): Promise<{ ok: true } | { ok: false; error: string }> {
  const session = requireSession();
  if (session.role !== "ADMIN" && session.role !== "OWNER") {
    return { ok: false, error: "Only Admin/Owner may delete courier dispatches" };
  }
  await authorize(session, "courier", "delete");
  try {
    await withTenant(session.tenantId, async (tx) => {
      const before = await tx.courierDispatch.findFirstOrThrow({
        where: { id, deletedAt: null },
        include: { items: true },
      });
      await tx.courierDispatch.update({ where: { id }, data: { deletedAt: new Date() } });
      await audit(tx, session, {
        entity: "CourierDispatch",
        entityId: id,
        action: "DELETE",
        before,
      });
    });
    revalidatePath(REVALIDATE);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "Delete failed" };
  }
}
