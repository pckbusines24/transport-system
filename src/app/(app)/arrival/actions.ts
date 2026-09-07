"use server";

import { z } from "zod";
import { requireSession } from "@/lib/session";
import { authorize } from "@/lib/authz";
import { saveDocRow, deleteDocRow, type ActionResult, type DocCrudConfig } from "@/lib/doc-crud";
import { parseDateInput, optStr } from "../masters/_lib/util";

const CFG: DocCrudConfig = {
  delegate: "arrival",
  refKind: "arrival",
  entity: "Arrival",
  path: "/arrival",
  docType: "ARRIVAL",
  numberField: "arrivalNo",
  scope: "firmfy",
  softDelete: false,
};

const schema = z.object({
  id: z.string().optional(),
  arrivalNo: z.string().trim().default(""),
  unloadDate: z.string().min(1, "Unload date is required"),
  unloadedBy: optStr,
  godownNo: optStr,
  manifestNo: optStr,
});

export async function saveArrival(input: unknown): Promise<ActionResult> {
  const session = requireSession();
  const parsed = schema.safeParse(input);
  if (!parsed.success) return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid input" };
  const { id, unloadDate, ...data } = parsed.data;
  await authorize(session, "loading", id ? "edit" : "create");
  const date = parseDateInput(unloadDate);
  if (!date) return { ok: false, error: "Invalid unload date" };
  return saveDocRow(session, CFG, id, { ...data, unloadDate: date });
}

export async function deleteArrival(id: string): Promise<ActionResult> {
  const session = requireSession();
  await authorize(session, "loading", "delete");
  return deleteDocRow(session, CFG, id);
}
