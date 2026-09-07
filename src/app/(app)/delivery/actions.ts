"use server";

import { z } from "zod";
import { requireSession } from "@/lib/session";
import { authorize } from "@/lib/authz";
import { saveDocRow, deleteDocRow, type ActionResult, type DocCrudConfig } from "@/lib/doc-crud";
import { parseDateInput, optStr } from "../masters/_lib/util";
import { round2 } from "@/lib/calc/tds";

const CFG: DocCrudConfig = {
  delegate: "delivery",
  refKind: "delivery",
  entity: "Delivery",
  path: "/delivery",
  docType: "DELIVERY",
  numberField: "delNo",
  scope: "firmfy",
  softDelete: true,
};

const schema = z.object({
  id: z.string().optional(),
  delNo: z.string().trim().default(""),
  delDate: z.string().min(1, "Delivery date is required"),
  type: z.enum(["GATE_PASS", "CASH_MEMO"]).default("GATE_PASS"),
  partyId: optStr,
  vehicleId: optStr,
  lrNo: optStr,
  grNo: optStr,
  freight: z.coerce.number().default(0),
  totQty: z.coerce.number().default(0),
  totWeight: z.coerce.number().default(0),
  ewayBillNo: optStr,
  deliveryPerson: optStr,
  through: optStr,
  payType: z.enum(["TO_PAY", "TBB", "PAID", "FOC", "CANCELLED"]).default("TO_PAY"),
  cashType: z.enum(["CASH", "CREDIT"]).default("CASH"),
  deliveryCharges: z.coerce.number().default(0),
  gatepassCharge: z.coerce.number().default(0),
  labourCharges: z.coerce.number().default(0),
  aoc: z.coerce.number().default(0),
  damrage: z.coerce.number().default(0),
  remarks: optStr,
});

export async function saveDelivery(input: unknown): Promise<ActionResult> {
  const session = requireSession();
  const parsed = schema.safeParse(input);
  if (!parsed.success) return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid input" };
  const { id, delDate, ...data } = parsed.data;
  await authorize(session, "delivery", id ? "edit" : "create");
  const date = parseDateInput(delDate);
  if (!date) return { ok: false, error: "Invalid delivery date" };
  const total = round2(
    (data.payType === "TO_PAY" ? data.freight : 0) +
      data.deliveryCharges +
      data.gatepassCharge +
      data.labourCharges +
      data.aoc +
      data.damrage
  );
  return saveDocRow(session, CFG, id, { ...data, delDate: date, total });
}

export async function deleteDelivery(id: string): Promise<ActionResult> {
  const session = requireSession();
  await authorize(session, "delivery", "delete");
  return deleteDocRow(session, CFG, id);
}
