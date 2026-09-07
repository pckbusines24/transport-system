"use server";

import { z } from "zod";
import { requireSession } from "@/lib/session";
import { authorize } from "@/lib/authz";
import { saveDocRow, deleteDocRow, type ActionResult, type DocCrudConfig } from "@/lib/doc-crud";
import { parseDateInput, optStr } from "../masters/_lib/util";
import { round2 } from "@/lib/calc/tds";

const CFG: DocCrudConfig = {
  delegate: "crossing",
  refKind: "crossing",
  entity: "Crossing",
  path: "/crossing",
  docType: "CROSSING",
  numberField: "chalanNo",
  scope: "firmfy",
  softDelete: true,
};

const schema = z.object({
  id: z.string().optional(),
  chalanNo: z.string().trim().default(""),
  chalanDate: z.string().min(1, "Chalan date is required"),
  transporterId: optStr,
  vehicleId: optStr,
  driverName: optStr,
  licenseNo: optStr,
  consigneeId: optStr,
  lrNo: optStr,
  grNo: optStr,
  sourceCityId: optStr,
  addressTo: optStr,
  freight: z.coerce.number().default(0),
  ewayBillNo: optStr,
  payType: z.enum(["TO_PAY", "TBB", "PAID", "FOC", "CANCELLED"]).default("TO_PAY"),
  crossingAmt: z.coerce.number().default(0),
  dcPct: z.coerce.number().default(0),
  toPayAmt: z.coerce.number().default(0),
  paidAmt: z.coerce.number().default(0),
  tbbAmt: z.coerce.number().default(0),
  partA: z.coerce.number().default(0),
  drCr: z.enum(["DEBIT", "CREDIT"]).default("DEBIT"),
});

export async function saveCrossing(input: unknown): Promise<ActionResult> {
  const session = requireSession();
  const parsed = schema.safeParse(input);
  if (!parsed.success) return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid input" };
  const { id, chalanDate, ...data } = parsed.data;
  await authorize(session, "crossing", id ? "edit" : "create");
  const date = parseDateInput(chalanDate);
  if (!date) return { ok: false, error: "Invalid chalan date" };
  const dcAmt = round2((data.crossingAmt * data.dcPct) / 100);
  const balance = round2(data.crossingAmt + dcAmt - data.paidAmt);
  return saveDocRow(session, CFG, id, { ...data, chalanDate: date, dcAmt, balance });
}

export async function deleteCrossing(id: string): Promise<ActionResult> {
  const session = requireSession();
  await authorize(session, "crossing", "delete");
  return deleteDocRow(session, CFG, id);
}
