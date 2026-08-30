"use server";

import { z } from "zod";
import { requireSession } from "@/lib/session";
import { authorize } from "@/lib/authz";
import { saveDocRow, deleteDocRow, type ActionResult, type DocCrudConfig } from "@/lib/doc-crud";
import { revalidateOutstanding } from "@/lib/outstanding-cache";
import { parseDateInput, optStr } from "../masters/_lib/util";
import { round2 } from "@/lib/calc/tds";

const CFG: DocCrudConfig = {
  delegate: "hireSlip",
  entity: "HireSlip",
  path: "/hire-slip",
  docType: "HIRE_SLIP",
  numberField: "slipNo",
  scope: "firmfy",
  softDelete: true,
};

const schema = z.object({
  id: z.string().optional(),
  slipNo: z.string().trim().default(""),
  slipDate: z.string().min(1, "Slip date is required"),
  vehicleId: optStr,
  ownerName: optStr,
  ownerPan: optStr,
  brokerName: optStr,
  driverName: optStr,
  driverMobile: optStr,
  licenseNo: optStr,
  product: optStr,
  form15: optStr,
  via: optStr,
  payableAt: optStr,
  chalanNo: optStr,
  sourceCityId: optStr,
  destCityId: optStr,
  totalPkgs: z.coerce.number().default(0),
  actualWt: z.coerce.number().default(0),
  guaranteeWt: z.coerce.number().default(0),
  ratePmt: z.coerce.number().default(0),
  lorryHire: z.coerce.number().default(0),
  loadingH: z.coerce.number().default(0),
  craneCharge: z.coerce.number().default(0),
  unloadingH: z.coerce.number().default(0),
  overHeightCharge: z.coerce.number().default(0),
  others: z.coerce.number().default(0),
  lessTds: z.coerce.number().default(0),
  lessSc: z.coerce.number().default(0),
  advance: z.coerce.number().default(0),
  narration: optStr,
});

export async function saveHireSlip(input: unknown): Promise<ActionResult> {
  const session = requireSession();
  const parsed = schema.safeParse(input);
  if (!parsed.success) return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid input" };
  const { id, slipDate, ...data } = parsed.data;
  await authorize(session, "hireslip", id ? "edit" : "create");
  const date = parseDateInput(slipDate);
  if (!date) return { ok: false, error: "Invalid slip date" };
  const totalHire = round2(
    data.lorryHire +
      data.loadingH +
      data.craneCharge +
      data.unloadingH +
      data.overHeightCharge +
      data.others -
      data.lessTds -
      data.lessSc
  );
  const balance = round2(totalHire - data.advance);
  const res = await saveDocRow(session, CFG, id, { ...data, slipDate: date, totalHire, balance });
  if (res.ok) revalidateOutstanding(session.tenantId);
  return res;
}

export async function deleteHireSlip(id: string): Promise<ActionResult> {
  const session = requireSession();
  await authorize(session, "hireslip", "delete");
  const res = await deleteDocRow(session, CFG, id);
  if (res.ok) revalidateOutstanding(session.tenantId);
  return res;
}
