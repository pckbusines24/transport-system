"use server";

import { z } from "zod";
import { requireSession } from "@/lib/session";
import { authorize } from "@/lib/authz";
import { saveDocRow, deleteDocRow, type ActionResult, type DocCrudConfig } from "@/lib/doc-crud";
import { parseDateInput, optStr } from "../masters/_lib/util";
import { round2 } from "@/lib/calc/tds";

const CFG: DocCrudConfig = {
  delegate: "loadingChalan",
  refKind: "loadingChalan",
  entity: "LoadingChalan",
  path: "/loading-chalan",
  docType: "LOADING_CHALAN",
  numberField: "chalanNo",
  scope: "firmfy",
  softDelete: true,
};

const schema = z.object({
  id: z.string().optional(),
  chalanNo: z.string().trim().default(""),
  chalanDate: z.string().min(1, "Chalan date is required"),
  type: z.enum(["DIRECT", "CROSSING"]).default("DIRECT"),
  vehicleId: optStr,
  driverName: optStr,
  driverMobile: optStr,
  licenseNo: optStr,
  vehicleOwner: optStr,
  brokerId: optStr,
  sourceCityId: optStr,
  destCityId: optStr,
  remarks: optStr,
  totFreight: z.coerce.number().default(0),
  truckFreight: z.coerce.number().default(0),
  advance: z.coerce.number().default(0),
  commAmt: z.coerce.number().default(0),
  lcCharge: z.coerce.number().default(0),
  dcCharge: z.coerce.number().default(0),
  cfCharge: z.coerce.number().default(0),
  totCrossing: z.coerce.number().default(0),
});

export async function saveLoadingChalan(input: unknown): Promise<ActionResult> {
  const session = requireSession();
  const parsed = schema.safeParse(input);
  if (!parsed.success) return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid input" };
  const { id, chalanDate, ...data } = parsed.data;
  await authorize(session, "loading", id ? "edit" : "create");
  const date = parseDateInput(chalanDate);
  if (!date) return { ok: false, error: "Invalid chalan date" };
  const netAmount = round2(
    data.truckFreight - data.advance - data.commAmt + data.lcCharge + data.dcCharge + data.cfCharge
  );
  return saveDocRow(session, CFG, id, { ...data, chalanDate: date, netAmount, lrIds: [] });
}

export async function deleteLoadingChalan(id: string): Promise<ActionResult> {
  const session = requireSession();
  await authorize(session, "loading", "delete");
  return deleteDocRow(session, CFG, id);
}
