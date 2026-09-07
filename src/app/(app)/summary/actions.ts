"use server";

import { z } from "zod";
import { requireSession } from "@/lib/session";
import { authorize } from "@/lib/authz";
import { saveDocRow, deleteDocRow, type ActionResult, type DocCrudConfig } from "@/lib/doc-crud";
import { parseDateInput, optStr } from "../masters/_lib/util";
import { round2 } from "@/lib/calc/tds";

const CFG: DocCrudConfig = {
  delegate: "settlementSummary",
  refKind: "summary",
  entity: "SettlementSummary",
  path: "/summary",
  docType: "SUMMARY",
  numberField: "summaryNo",
  scope: "firmfy",
  softDelete: true,
};

const schema = z.object({
  id: z.string().optional(),
  summaryNo: z.string().trim().default(""),
  summaryDate: z.string().min(1, "Summary date is required"),
  chalanNo: optStr,
  chalanDate: optStr,
  vehicleId: optStr,
  sourceCityId: optStr,
  destCityId: optStr,
  remarks: optStr,
  deliveryAmt: z.coerce.number().default(0),
  crossingAmt: z.coerce.number().default(0),
  delCommPct: z.coerce.number().default(0),
  delCharges: z.coerce.number().default(0),
  crossingFreight: z.coerce.number().default(0),
  truckFreight: z.coerce.number().default(0),
  unloadCharges: z.coerce.number().default(0),
  doorDelivery: z.coerce.number().default(0),
});

export async function saveSummary(input: unknown): Promise<ActionResult> {
  const session = requireSession();
  const parsed = schema.safeParse(input);
  if (!parsed.success) return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid input" };
  const { id, summaryDate, chalanDate, ...data } = parsed.data;
  await authorize(session, "summary", id ? "edit" : "create");
  const date = parseDateInput(summaryDate);
  if (!date) return { ok: false, error: "Invalid summary date" };
  // Part A: what we collected; Part B: what we owe on the truck side.
  const delCommAmt = round2((data.deliveryAmt * data.delCommPct) / 100);
  const totPartA = round2(data.deliveryAmt + data.crossingAmt - delCommAmt - data.delCharges);
  const totPartB = round2(
    data.crossingFreight + data.truckFreight + data.unloadCharges + data.doorDelivery
  );
  const balance = round2(totPartA - totPartB);
  return saveDocRow(session, CFG, id, {
    ...data,
    summaryDate: date,
    chalanDate: parseDateInput(chalanDate),
    delCommAmt,
    totPartA,
    totPartB,
    balance,
    ...(id ? {} : { extraLines: [] }),
  });
}

export async function deleteSummary(id: string): Promise<ActionResult> {
  const session = requireSession();
  await authorize(session, "summary", "delete");
  return deleteDocRow(session, CFG, id);
}
