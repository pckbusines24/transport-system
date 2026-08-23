"use server";

import { z } from "zod";
import { requireSession } from "@/lib/session";
import { withTenant } from "@/lib/db";
import { authorize } from "@/lib/authz";

/**
 * Vehicle Tracking — live register with automatic saving. Every edit upserts
 * TODAY's snapshot for the vehicle (seeded from the latest known values), so
 * earlier days remain untouched as history. Each call also enforces the
 * 120-day retention policy (this module only).
 */

const TRACKING_RETENTION_DAYS = 120;

const patchSchema = z.object({
  vehicleId: z.string().min(1),
  transporterName: z.string().nullish(),
  fromLocation: z.string().nullish(),
  toLocation: z.string().nullish(),
  currentLocation: z.string().nullish(),
  status: z.string().nullish(),
  remarks: z.string().nullish(),
});

function today(): Date {
  const n = new Date();
  return new Date(n.getFullYear(), n.getMonth(), n.getDate());
}

export async function updateVehicleTracking(
  input: unknown
): Promise<{ ok: true; date: string } | { ok: false; error: string }> {
  const session = requireSession();
  const parsed = patchSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: "Invalid input" };
  const d = parsed.data;
  await authorize(session, "vehicle", "edit");

  try {
    return await withTenant(session.tenantId, async (tx) => {
      const day = today();
      // seed today's row from the latest snapshot so untouched fields carry over
      const latest = await tx.vehicleTracking.findFirst({
        where: { firmId: session.firmId, vehicleId: d.vehicleId },
        orderBy: { date: "desc" },
      });
      const merged = {
        transporterName:
          d.transporterName !== undefined ? d.transporterName || null : latest?.transporterName ?? null,
        fromLocation:
          d.fromLocation !== undefined ? d.fromLocation || null : latest?.fromLocation ?? null,
        toLocation: d.toLocation !== undefined ? d.toLocation || null : latest?.toLocation ?? null,
        currentLocation:
          d.currentLocation !== undefined ? d.currentLocation || null : latest?.currentLocation ?? null,
        status: d.status !== undefined ? d.status || null : latest?.status ?? null,
        remarks: d.remarks !== undefined ? d.remarks || null : latest?.remarks ?? null,
        updatedById: session.userId,
      };
      await tx.vehicleTracking.upsert({
        where: {
          tenantId_firmId_vehicleId_date: {
            tenantId: session.tenantId,
            firmId: session.firmId,
            vehicleId: d.vehicleId,
            date: day,
          },
        },
        create: {
          tenantId: session.tenantId,
          firmId: session.firmId,
          vehicleId: d.vehicleId,
          date: day,
          ...merged,
        },
        update: merged,
      });

      // 120-day retention — this module only, fully automatic
      const cutoff = new Date(day);
      cutoff.setDate(cutoff.getDate() - TRACKING_RETENTION_DAYS);
      await tx.vehicleTracking.deleteMany({
        where: { firmId: session.firmId, date: { lt: cutoff } },
      });

      return { ok: true as const, date: day.toISOString() };
    });
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Auto-save failed" };
  }
}
