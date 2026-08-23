"use server";

import { requireSession } from "@/lib/session";
import { withTenant } from "@/lib/db";
import { authorize } from "@/lib/authz";
import { runImport, type ImportSummary } from "@/lib/import-core";
import { parseDdMmYyyy, toNum } from "@/lib/utils";
import { saveVehicleExpenseTxn } from "./actions";

/**
 * Vehicle Expense bulk import. The template is generated live with
 * dropdown (data-validation) lists built from CURRENT master data — heads,
 * vehicles, cash/bank accounts, suppliers — so a freshly downloaded template
 * always reflects the latest masters. Voucher numbers auto-generate on import.
 */

const TEMPLATE_HEADERS = [
  "DATE",
  "TYPE",
  "EXPENSE HEAD",
  "VEHICLE",
  "AMOUNT",
  "PAYMENT MODE",
  "CASH/BANK ACCOUNT",
  "PAYMENT DATE",
  "SUPPLIER",
  "REF NO",
  "REMARKS",
];

export async function downloadVehicleExpenseTemplate(): Promise<
  { ok: true; base64: string } | { ok: false; error: string }
> {
  const session = requireSession();
  await authorize(session, "vehicle", "view");
  try {
    const { heads, vehicles, banks, suppliers } = await withTenant(
      session.tenantId,
      async (tx) => {
        const [heads, vehicles, banks, suppliers] = await Promise.all([
          tx.accountHead.findMany({
            where: { kind: { in: ["INCOME", "EXPENSE"] } },
            orderBy: { name: "asc" },
          }),
          tx.vehicle.findMany({ where: { isActive: true }, orderBy: { number: "asc" } }),
          tx.party.findMany({
            where: { isActive: true, ledgerGroup: { in: ["BANK", "CASH", "CARD"] } },
            orderBy: { name: "asc" },
          }),
          tx.party.findMany({
            where: { isActive: true, ledgerGroup: { notIn: ["BANK", "CASH", "CARD"] } },
            orderBy: { name: "asc" },
            take: 500,
          }),
        ]);
        return { heads, vehicles, banks, suppliers };
      }
    );

    const ExcelJS = (await import("exceljs")).default;
    const wb = new ExcelJS.Workbook();
    const sheet = wb.addWorksheet("Vehicle Expenses");
    sheet.addRow(TEMPLATE_HEADERS);
    sheet.getRow(1).font = { bold: true };
    sheet.columns.forEach((c) => (c.width = 18));
    sheet.addRow([
      "01/04/2026",
      "EXPENSE",
      heads[0]?.name ?? "Diesel",
      vehicles[0]?.number ?? "CG04AB1234",
      5000,
      "CASH",
      banks.find((b) => b.ledgerGroup === "CASH")?.name ?? "",
      "01/04/2026",
      "",
      "BILL-001",
      "example row — delete before importing",
    ]);

    // hidden Lists sheet feeding the dropdowns (always current master data)
    const lists = wb.addWorksheet("Lists");
    lists.state = "veryHidden";
    const put = (col: number, values: string[]) =>
      values.forEach((v, i) => (lists.getCell(i + 1, col).value = v));
    put(1, ["EXPENSE", "INCOME"]);
    put(2, heads.map((h) => h.name));
    put(3, vehicles.map((v) => v.number));
    put(4, ["CASH", "BANK", "CARD", "CREDIT"]);
    put(5, banks.map((b) => b.name));
    put(6, suppliers.map((s) => s.name));

    const dv = (col: string, listCol: string, count: number) => {
      if (count === 0) return;
      for (let r = 2; r <= 500; r++) {
        sheet.getCell(`${col}${r}`).dataValidation = {
          type: "list",
          allowBlank: true,
          formulae: [`Lists!$${listCol}$1:$${listCol}$${count}`],
          showErrorMessage: true,
          errorTitle: "Invalid value",
          error: "Pick a value from the dropdown (current master data).",
        };
      }
    };
    dv("B", "A", 2); // type
    dv("C", "B", heads.length); // expense head
    dv("D", "C", vehicles.length); // vehicle
    dv("F", "D", 3); // payment mode
    dv("G", "E", banks.length); // cash/bank account
    dv("I", "F", suppliers.length); // supplier

    const buf = await wb.xlsx.writeBuffer();
    return { ok: true as const, base64: Buffer.from(buf).toString("base64") };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Template generation failed" };
  }
}

/**
 * Flexible date recognition for Excel imports. Accepts:
 *   YYYY-MM-DD / YYYY/MM/DD, DD/MM/YYYY, DD-MM-YYYY, MM/DD/YYYY, MM-DD-YYYY,
 *   2-digit years, Excel serial numbers, and ISO datetime strings.
 * Ambiguity rule: when both parts could be a month (e.g. 05/06/2026) the
 * value is read as DD/MM (Indian convention). A part > 12 disambiguates
 * automatically (e.g. 06/25/2026 → MM/DD).
 */
function parseAnyDate(v: string): string | null {
  const t = v.trim();
  if (!t) return null;
  const iso = (y: number, m: number, d: number): string | null => {
    if (m < 1 || m > 12 || d < 1 || d > 31) return null;
    const dt = new Date(y, m - 1, d);
    if (dt.getFullYear() !== y || dt.getMonth() !== m - 1 || dt.getDate() !== d) return null;
    return `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
  };
  // Excel serial number (days since 1899-12-30)
  if (/^\d+(\.\d+)?$/.test(t)) {
    const serial = parseFloat(t);
    if (serial > 20000 && serial < 80000) {
      const dt = new Date(Date.UTC(1899, 11, 30) + Math.round(serial) * 86400000);
      return `${dt.getUTCFullYear()}-${String(dt.getUTCMonth() + 1).padStart(2, "0")}-${String(dt.getUTCDate()).padStart(2, "0")}`;
    }
    return null;
  }
  // ISO / YYYY first
  let m = t.match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})/);
  if (m) return iso(+m[1], +m[2], +m[3]);
  // day-month-year or month-day-year with / - .
  m = t.match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{2,4})/);
  if (m) {
    const a = +m[1];
    const b = +m[2];
    let y = +m[3];
    if (y < 100) y += y >= 70 ? 1900 : 2000;
    if (a > 12 && b <= 12) return iso(y, b, a); // DD/MM
    if (b > 12 && a <= 12) return iso(y, a, b); // MM/DD
    return iso(y, b, a); // ambiguous → DD/MM (Indian convention)
  }
  // "1 Apr 2026" / "01-Apr-26" style via Date fallback
  const parsed = new Date(t);
  if (!isNaN(parsed.getTime())) {
    return iso(parsed.getFullYear(), parsed.getMonth() + 1, parsed.getDate());
  }
  const d = parseDdMmYyyy(t);
  if (!d) return null;
  return iso(d.getFullYear(), d.getMonth() + 1, d.getDate());
}

export async function importVehicleExpenses(fd: FormData): Promise<ImportSummary> {
  const session = requireSession();
  await authorize(session, "vehicle", "create");

  const { heads, vehicles, banks, suppliers, existing } = await withTenant(
    session.tenantId,
    async (tx) => {
      const [heads, vehicles, banks, suppliers, existing] = await Promise.all([
        tx.accountHead.findMany({ where: { kind: { in: ["INCOME", "EXPENSE"] } } }),
        tx.vehicle.findMany(),
        tx.party.findMany({ where: { ledgerGroup: { in: ["BANK", "CASH", "CARD"] } } }),
        tx.party.findMany({ where: { ledgerGroup: { notIn: ["BANK", "CASH", "CARD"] } } }),
        tx.vehicleExpenseVoucher.findMany({
          where: { firmId: session.firmId, fyId: session.fyId, deletedAt: null },
          include: { items: true },
        }),
      ]);
      return { heads, vehicles, banks, suppliers, existing };
    }
  );
  const headByName = new Map(heads.map((h) => [h.name.toUpperCase(), h]));
  const vehicleByNo = new Map(vehicles.map((v) => [v.number.toUpperCase().replace(/\s+/g, ""), v]));
  const bankByName = new Map(banks.map((b) => [b.name.toUpperCase(), b]));
  const supplierByName = new Map(suppliers.map((s) => [s.name.toUpperCase(), s]));
  // duplicate signature: date + head + vehicle + amount + refNo
  const dupKeys = new Set<string>();
  for (const v of existing) {
    for (const it of v.items) {
      dupKeys.add(
        `${v.date.toISOString().slice(0, 10)}|${v.headId}|${it.vehicleId}|${toNum(String(it.amount))}|${(v.refNo ?? "").toUpperCase()}`
      );
    }
  }

  return runImport(
    fd.get("file") as File | null,
    ["DATE", "EXPENSE HEAD", "VEHICLE", "AMOUNT"],
    async (rec) => {
      const err = (m: string) => {
        throw new Error(m);
      };

      const dateIso = parseAnyDate(rec["DATE"] ?? "");
      if (!dateIso) throw new Error(`invalid DATE "${rec["DATE"]}" — use dd/mm/yyyy`);

      const txnType = (rec["TYPE"] || "EXPENSE").toUpperCase();
      if (txnType !== "EXPENSE" && txnType !== "INCOME") {
        err(`invalid TYPE "${rec["TYPE"]}" — EXPENSE or INCOME`);
      }

      const head = headByName.get((rec["EXPENSE HEAD"] ?? "").toUpperCase().trim());
      if (!head) throw new Error(`unknown EXPENSE HEAD "${rec["EXPENSE HEAD"]}"`);
      if (head.kind !== txnType) err(`head "${head.name}" is a ${head.kind} head`);

      const vehicle = vehicleByNo.get((rec["VEHICLE"] ?? "").toUpperCase().replace(/\s+/g, ""));
      if (!vehicle) throw new Error(`unknown VEHICLE "${rec["VEHICLE"]}"`);

      const amount = toNum(rec["AMOUNT"]);
      if (amount <= 0) err(`AMOUNT must be a positive number (got "${rec["AMOUNT"]}")`);

      const modeRaw = (rec["PAYMENT MODE"] || "CREDIT").toUpperCase();
      if (!["CASH", "BANK", "CARD", "CREDIT"].includes(modeRaw)) {
        err(`invalid PAYMENT MODE "${rec["PAYMENT MODE"]}" — CASH / BANK / CREDIT`);
      }
      const paymentMode = modeRaw === "CREDIT" ? null : (modeRaw as "CASH" | "BANK");

      let bankPartyId: string | null = null;
      if (paymentMode) {
        const bank = bankByName.get((rec["CASH/BANK ACCOUNT"] ?? "").toUpperCase().trim());
        if (!bank) throw new Error(`unknown CASH/BANK ACCOUNT "${rec["CASH/BANK ACCOUNT"]}"`);
        bankPartyId = bank.id;
      }

      let paymentDate: string | null = null;
      if (paymentMode && rec["PAYMENT DATE"]) {
        paymentDate = parseAnyDate(rec["PAYMENT DATE"]);
        if (!paymentDate) err(`invalid PAYMENT DATE "${rec["PAYMENT DATE"]}"`);
      }

      let partyId: string | null = null;
      if (rec["SUPPLIER"]) {
        const supplier = supplierByName.get(rec["SUPPLIER"].toUpperCase().trim());
        if (!supplier) throw new Error(`unknown SUPPLIER "${rec["SUPPLIER"]}"`);
        partyId = supplier.id;
      }
      if (!paymentMode && !partyId) {
        err("credit rows need a SUPPLIER (or set PAYMENT MODE to CASH/BANK)");
      }

      const refNo = (rec["REF NO"] ?? "").trim();
      const dupKey = `${dateIso}|${head.id}|${vehicle.id}|${amount}|${refNo.toUpperCase()}`;
      if (dupKeys.has(dupKey)) return "skipped";
      dupKeys.add(dupKey);

      const res = await saveVehicleExpenseTxn({
        date: dateIso,
        txnType: txnType as "EXPENSE" | "INCOME",
        headId: head.id,
        partyId,
        paymentMode,
        bankPartyId,
        paymentDate,
        refNo,
        remarks: rec["REMARKS"] || null,
        items: [{ vehicleId: vehicle.id, amount }],
      });
      if (!res.ok) err(res.error);
      return "created";
    }
  );
}
