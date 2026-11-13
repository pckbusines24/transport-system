"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { requireSession } from "@/lib/session";
import { withTenant } from "@/lib/db";
import { authorize } from "@/lib/authz";
import { audit } from "@/lib/audit";

const firmSchema = z.object({
  name: z.string().trim().min(1, "Firm name is required"),
  alias: z.string().nullish(),
  address1: z.string().nullish(),
  address2: z.string().nullish(),
  stateId: z.string().nullish(),
  cityId: z.string().nullish(),
  phone: z.string().nullish(),
  mobile: z.string().nullish(),
  email: z.string().nullish(),
  website: z.string().nullish(),
  gstin: z.string().nullish(),
  pan: z.string().nullish(),
  cin: z.string().nullish(),
  msmeNo: z.string().nullish(),
  ibaCode: z.string().nullish(),
  vendorCode: z.string().nullish(),
  rcmCovered: z.boolean().default(true),
  jurisdiction: z.string().nullish(),
  cgstPct: z.number().min(0).max(100).default(0),
  sgstPct: z.number().min(0).max(100).default(0),
  igstPct: z.number().min(0).max(100).default(0),
  defaultTdsPct: z.number().min(0).max(100).default(1),
  podFollowUpDays: z.number().int().min(1).max(90).default(15),
  balanceFollowUpEnabled: z.boolean().default(true),
  balanceFollowUpDays: z.number().int().min(0).max(365).default(15),
  defaultBankPartyId: z.string().nullish(),
  bankName: z.string().nullish(),
  bankAccount: z.string().nullish(),
  bankBranch: z.string().nullish(),
  bankIfsc: z.string().nullish(),
  smtpHost: z.string().nullish(),
  smtpUser: z.string().nullish(),
  smtpPass: z.string().nullish(),
});

export type SaveFirmResult = { ok: true } | { ok: false; error: string };

export async function saveFirmSettings(input: unknown): Promise<SaveFirmResult> {
  const session = requireSession();
  await authorize(session, "settings", "edit");
  const parsed = firmSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid input" };
  }
  const d = parsed.data;
  try {
    await withTenant(session.tenantId, async (tx) => {
      const before = await tx.firm.findUniqueOrThrow({ where: { id: session.firmId } });
      const after = await tx.firm.update({
        where: { id: session.firmId },
        data: {
          name: d.name,
          alias: d.alias || null,
          address1: d.address1 || null,
          address2: d.address2 || null,
          stateId: d.stateId || null,
          cityId: d.cityId || null,
          phone: d.phone || null,
          mobile: d.mobile || null,
          email: d.email || null,
          website: d.website || null,
          gstin: d.gstin || null,
          pan: d.pan || null,
          cin: d.cin || null,
          msmeNo: d.msmeNo || null,
          ibaCode: d.ibaCode || null,
          vendorCode: d.vendorCode || null,
          rcmCovered: d.rcmCovered,
          jurisdiction: d.jurisdiction || null,
          cgstPct: d.cgstPct,
          sgstPct: d.sgstPct,
          igstPct: d.igstPct,
          defaultTdsPct: d.defaultTdsPct,
          podFollowUpDays: d.podFollowUpDays,
          balanceFollowUpEnabled: d.balanceFollowUpEnabled,
          balanceFollowUpDays: d.balanceFollowUpDays,
          defaultBankPartyId: d.defaultBankPartyId || null,
          bankName: d.bankName || null,
          bankAccount: d.bankAccount || null,
          bankBranch: d.bankBranch || null,
          bankIfsc: d.bankIfsc || null,
          smtpHost: d.smtpHost || null,
          smtpUser: d.smtpUser || null,
          smtpPass: d.smtpPass || null,
        },
      });
      await audit(tx, session, {
        entity: "Firm",
        entityId: session.firmId,
        action: "UPDATE",
        before,
        after,
      });
    });
    revalidatePath("/settings/firm");
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "Failed to save firm" };
  }
}
