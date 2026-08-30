"use server";

import { revalidatePath, revalidateTag } from "next/cache";
import { z } from "zod";
import { LedgerGroup } from "@prisma/client";
import { requireSession } from "@/lib/session";
import { runImport, num as importNum, type ImportSummary } from "@/lib/import-core";
import { authorize } from "@/lib/authz";
import { lookupTag } from "@/lib/cached-lookups";
import { withTenant } from "@/lib/db";
import { audit } from "@/lib/audit";
import { revalidateOutstanding } from "@/lib/outstanding-cache";
import { actionError, optStr, zodError, type ActionResult } from "../_lib/util";

const schema = z.object({
  id: z.string().optional(),
  name: z.string().trim().min(1, "Name is required"),
  ledgerGroup: z.nativeEnum(LedgerGroup),
  alias: optStr,
  address1: optStr,
  address2: optStr,
  stateId: optStr,
  cityId: optStr,
  gstin: optStr,
  pan: optStr,
  mobile: optStr,
  phone: optStr,
  email: optStr,
  ownerName: optStr,
  vendorCode: optStr,
  transportName: optStr,
  tallyName: optStr,
  openingBalance: z.coerce.number().default(0),
  // no silent default: a form may leave the side unchosen, and an opening
  // amount without a chosen Dr/Cr is rejected below rather than assumed
  openingSide: z.enum(["DEBIT", "CREDIT"]).nullish(),
  tdsMode: z.enum(["TDS_APPLICABLE", "DECLARATION"]).nullable().optional(),
  bankName: optStr,
  bankAccount: optStr,
  bankIfsc: optStr,
  isActive: z.boolean().default(true),
});

const GSTIN_RE = /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][0-9A-Z]Z[0-9A-Z]$/;
const PAN_RE = /^[A-Z]{5}[0-9]{4}[A-Z]$/;
const MOBILE_RE = /^[6-9][0-9]{9}$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export async function saveParty(input: unknown): Promise<ActionResult> {
  const session = requireSession();
  const parsed = schema.safeParse(input);
  if (!parsed.success) return zodError(parsed.error);
  const data = parsed.data;
  if (data.gstin && !GSTIN_RE.test(data.gstin.toUpperCase()))
    return { ok: false, error: "Invalid GSTIN format (e.g. 22AAACD1234F1ZK)." };
  if (data.pan && !PAN_RE.test(data.pan.toUpperCase()))
    return { ok: false, error: "Invalid PAN format (e.g. AAACD1234F)." };
  if (data.mobile && !MOBILE_RE.test(data.mobile.replace(/\D/g, "")))
    return { ok: false, error: "Mobile must be a valid 10-digit Indian number." };
  if (data.email && !EMAIL_RE.test(data.email))
    return { ok: false, error: "Invalid email address." };
  if (data.openingBalance > 0.009 && !data.openingSide)
    return { ok: false, error: "Select Debit or Credit for the opening balance." };
  await authorize(session, "masters", data.id ? "edit" : "create");
  try {
    const id = await withTenant(session.tenantId, async (tx) => {
      const values = {
        name: data.name.toUpperCase(),
        ledgerGroup: data.ledgerGroup,
        alias: data.alias,
        address1: data.address1,
        address2: data.address2,
        stateId: data.stateId,
        cityId: data.cityId,
        gstin: data.gstin ? data.gstin.toUpperCase() : null,
        pan: data.pan ? data.pan.toUpperCase() : null,
        mobile: data.mobile,
        phone: data.phone,
        email: data.email,
        ownerName: data.ownerName,
        vendorCode: data.vendorCode,
        transportName: data.ledgerGroup === "OWNER_BROKER" ? data.transportName : null,
        tallyName: data.tallyName ? data.tallyName.toUpperCase() : null,
        openingBalance: data.openingBalance,
        // zero opening carries no direction — DEBIT is just the storage value
        openingSide: data.openingSide ?? "DEBIT",
        tdsMode: data.ledgerGroup === "OWNER_BROKER" ? data.tdsMode ?? "TDS_APPLICABLE" : null,
        bankName: data.bankName,
        bankAccount: data.bankAccount,
        bankIfsc: data.bankIfsc ? data.bankIfsc.toUpperCase() : null,
        isActive: data.isActive,
      };
      if (data.id) {
        const before = await tx.party.findUniqueOrThrow({ where: { id: data.id } });
        const row = await tx.party.update({ where: { id: data.id }, data: values });
        await audit(tx, session, { entity: "Party", entityId: row.id, action: "UPDATE", before, after: row });
        return row.id;
      }
      const row = await tx.party.create({ data: { tenantId: session.tenantId, ...values } });
      await audit(tx, session, { entity: "Party", entityId: row.id, action: "CREATE", after: row });
      return row.id;
    });
    revalidatePath("/masters/parties");
    revalidateTag(lookupTag.parties(session.tenantId));
    revalidateTag(lookupTag.vehicles(session.tenantId));
    revalidateOutstanding(session.tenantId);
    return { ok: true, id };
  } catch (e) {
    return actionError(e);
  }
}

export async function deleteParty(id: string): Promise<ActionResult> {
  const session = requireSession();
  await authorize(session, "masters", "delete");
  try {
    await withTenant(session.tenantId, async (tx) => {
      const before = await tx.party.findUniqueOrThrow({ where: { id } });
      // parties are referenced everywhere — deactivate instead of hard delete
      await tx.party.update({ where: { id }, data: { isActive: false } });
      await audit(tx, session, { entity: "Party", entityId: id, action: "DELETE", before });
    });
    revalidatePath("/masters/parties");
    revalidateTag(lookupTag.parties(session.tenantId));
    revalidateTag(lookupTag.vehicles(session.tenantId));
    revalidateOutstanding(session.tenantId);
    return { ok: true, id };
  } catch (e) {
    return actionError(e);
  }
}

/** Excel/CSV import — see the sample template for expected columns. */
export async function importParties(formData: FormData): Promise<ImportSummary> {
  const session = requireSession();
  await authorize(session, "masters", "create");
  const file = formData.get("file");
  const summary = await withTenant(session.tenantId, async (tx) =>
    runImport(file instanceof File ? file : null, ["NAME", "GROUP"], async (rec) => {
      const name = rec["NAME"].toUpperCase();
      if (!name) throw new Error("Party name is required");
      const groupAliases: Record<string, string> = {
        "OWNER": "OWNER_BROKER",
        "BROKER": "OWNER_BROKER",
        "OWNER/BROKER": "OWNER_BROKER",
        "OWNER_BROKER": "OWNER_BROKER",
        "CONSIGNOR": "CONSIGNEE_CONSIGNOR",
        "CONSIGNEE": "CONSIGNEE_CONSIGNOR",
        "PARTY": "CONSIGNEE_CONSIGNOR",
        "CONSIGNEE_CONSIGNOR": "CONSIGNEE_CONSIGNOR",
        "DRIVER": "DRIVER",
        "STAFF": "STAFF",
        "SUPPLIER": "SUPPLIERS",
        "SUPPLIERS": "SUPPLIERS",
      };
      const group = groupAliases[rec["GROUP"].toUpperCase().replace(/ /g, "_")];
      if (!group) throw new Error(`unknown group "${rec["GROUP"]}"`);
      const gstin = rec["GSTIN"]?.toUpperCase() || null;
      const pan = rec["PAN"]?.toUpperCase() || null;
      const mobile = rec["MOBILE"]?.replace(/\D/g, "") || null;
      if (gstin && !GSTIN_RE.test(gstin)) throw new Error(`invalid GSTIN "${gstin}"`);
      if (pan && !PAN_RE.test(pan)) throw new Error(`invalid PAN "${pan}"`);
      if (mobile && !MOBILE_RE.test(mobile)) throw new Error(`invalid mobile "${rec["MOBILE"]}"`);
      if (rec["EMAIL"] && !EMAIL_RE.test(rec["EMAIL"])) throw new Error(`invalid email "${rec["EMAIL"]}"`);
      const values = {
        gstin,
        pan,
        mobile,
        email: rec["EMAIL"] || null,
        address1: rec["ADDRESS"] || null,
        transportName: group === "OWNER_BROKER" ? rec["TRANSPORT NAME"]?.toUpperCase() || null : null,
        openingBalance: importNum(rec["OPENING BALANCE"]),
        openingSide: rec["OPENING SIDE"]?.toUpperCase() === "CREDIT" ? ("CREDIT" as const) : ("DEBIT" as const),
      };
      const existing = await tx.party.findFirst({
        where: { name, ledgerGroup: group as never },
      });
      if (existing) {
        await tx.party.update({ where: { id: existing.id }, data: values });
        return "updated";
      }
      await tx.party.create({
        data: { tenantId: session.tenantId, name, ledgerGroup: group as never, ...values },
      });
      return "created";
    })
  );
  revalidateTag(lookupTag.parties(session.tenantId));
  revalidateTag(lookupTag.vehicles(session.tenantId));
  revalidateOutstanding(session.tenantId);
  return summary;
}
