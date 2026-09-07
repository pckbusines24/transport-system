"use server";

import { z } from "zod";
import { requireSession } from "@/lib/session";
import { authorize } from "@/lib/authz";
import { saveDocRow, deleteDocRow, type ActionResult, type DocCrudConfig } from "@/lib/doc-crud";
import { parseDateInput, optStr } from "../masters/_lib/util";
import { round2 } from "@/lib/calc/tds";

const CFG: DocCrudConfig = {
  delegate: "outwardCrossing",
  refKind: "outwardCrossing",
  entity: "OutwardCrossing",
  path: "/outward-crossing",
  docType: "OUTWARD_CROSSING",
  numberField: "ocNo",
  scope: "firmfy",
  softDelete: true,
};

const schema = z.object({
  id: z.string().optional(),
  ocNo: z.string().trim().default(""),
  chalanDate: z.string().min(1, "Chalan date is required"),
  arrivalNo: optStr,
  arrivalDate: optStr,
  vehicleId: optStr,
  transporterId: optStr,
  sourceCityId: optStr,
  destCityId: optStr,
  lrType: z.enum(["TO_PAY", "TBB", "PAID", "FOC", "CANCELLED"]).default("TO_PAY"),
  unit: optStr,
  remarks: optStr,
  totalQty: z.coerce.number().default(0),
  totalWt: z.coerce.number().default(0),
  totFreight: z.coerce.number().default(0),
  crossingFreight: z.coerce.number().default(0),
});

export async function saveOutwardCrossing(input: unknown): Promise<ActionResult> {
  const session = requireSession();
  const parsed = schema.safeParse(input);
  if (!parsed.success) return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid input" };
  const { id, chalanDate, arrivalDate, ...data } = parsed.data;
  await authorize(session, "crossing", id ? "edit" : "create");
  const date = parseDateInput(chalanDate);
  if (!date) return { ok: false, error: "Invalid chalan date" };
  const grandTotal = round2(data.totFreight + data.crossingFreight);
  return saveDocRow(session, CFG, id, {
    ...data,
    chalanDate: date,
    arrivalDate: parseDateInput(arrivalDate),
    grandTotal,
    ...(id ? {} : { lines: [] }),
  });
}

export async function deleteOutwardCrossing(id: string): Promise<ActionResult> {
  const session = requireSession();
  await authorize(session, "crossing", "delete");
  return deleteDocRow(session, CFG, id);
}
