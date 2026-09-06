/**
 * Shared engine for master-data imports (.xlsx via exceljs, .csv via a small
 * quote-aware parser). Each master's action supplies required headers and a
 * per-row handler; the engine returns a uniform summary with row-wise errors.
 */

export interface ImportSummary {
  ok: boolean;
  imported: number;
  updated: number;
  skipped: number;
  failed: number;
  errors: string[];
}

function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          cell += '"';
          i++;
        } else inQuotes = false;
      } else cell += ch;
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ",") {
      row.push(cell);
      cell = "";
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i++;
      row.push(cell);
      cell = "";
      if (row.some((c) => c.trim() !== "")) rows.push(row);
      row = [];
    } else cell += ch;
  }
  row.push(cell);
  if (row.some((c) => c.trim() !== "")) rows.push(row);
  return rows;
}

async function parseFile(
  file: File
): Promise<{ header: string[]; rows: string[][] } | { error: string }> {
  const name = file.name.toLowerCase();
  try {
    if (name.endsWith(".csv")) {
      const all = parseCsv(await file.text());
      if (all.length === 0) return { error: "The file is empty." };
      return { header: all[0].map((h) => h.trim().toUpperCase()), rows: all.slice(1) };
    }
    const ExcelJS = (await import("exceljs")).default;
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(await file.arrayBuffer());
    const ws = wb.worksheets[0];
    if (!ws) return { error: "Workbook has no sheets." };
    const header: string[] = [];
    ws.getRow(1).eachCell({ includeEmpty: true }, (cell, col) => {
      header[col - 1] = String(cell.value ?? "").trim().toUpperCase();
    });
    const rows: string[][] = [];
    for (let r = 2; r <= ws.rowCount; r++) {
      const row: string[] = [];
      ws.getRow(r).eachCell({ includeEmpty: true }, (cell, col) => {
        const v = cell.value;
        row[col - 1] =
          v === null || v === undefined
            ? ""
            : typeof v === "object" && "text" in (v as object)
              ? String((v as { text: string }).text)
              : String(v);
      });
      if (row.some((c) => (c ?? "").trim() !== "")) rows.push(row);
    }
    return { header, rows };
  } catch {
    return { error: "Could not read the file — upload a valid .xlsx or .csv." };
  }
}

export type RowRecord = Record<string, string>;
export type RowResult = "created" | "updated" | "skipped";

/**
 * Parse the file, verify required headers, then run `handle` per data row.
 * `handle` returns created/updated/skipped or throws to mark the row failed.
 */
export async function runImport(
  file: File | null,
  requiredHeaders: string[],
  handle: (rec: RowRecord, rowNo: number) => Promise<RowResult>
): Promise<ImportSummary> {
  const fail = (error: string): ImportSummary => ({
    ok: false,
    imported: 0,
    updated: 0,
    skipped: 0,
    failed: 0,
    errors: [error],
  });
  if (!file) return fail("No file uploaded.");
  const parsed = await parseFile(file);
  if ("error" in parsed) return fail(parsed.error);

  const idx = new Map(parsed.header.map((h, i) => [h, i]));
  const missing = requiredHeaders.filter((h) => !idx.has(h.toUpperCase()));
  if (missing.length) {
    return fail(`Missing required column(s): ${missing.join(", ")}. Download the sample template.`);
  }

  const summary: ImportSummary = {
    ok: true,
    imported: 0,
    updated: 0,
    skipped: 0,
    failed: 0,
    errors: [],
  };
  for (let i = 0; i < parsed.rows.length; i++) {
    const rowNo = i + 2; // 1-based + header row
    const rec: RowRecord = {};
    idx.forEach((col, header) => {
      rec[header] = (parsed.rows[i][col] ?? "").trim();
    });
    try {
      const res = await handle(rec, rowNo);
      if (res === "created") summary.imported++;
      else if (res === "updated") summary.updated++;
      else summary.skipped++;
    } catch (e) {
      summary.failed++;
      summary.errors.push(`Row ${rowNo}: ${e instanceof Error ? e.message : "failed"}`);
    }
  }
  summary.ok = summary.failed === 0;
  return summary;
}

export const num = (v: string | undefined): number => {
  const n = parseFloat((v ?? "").replace(/[^\d.-]/g, ""));
  return isNaN(n) ? 0 : n;
};

/**
 * Normalise a human-entered enum/label cell so it matches an internal key:
 * "Consignee / Consignor", "consignee-consignor", "CONSIGNEE_CONSIGNOR" and
 * "Consignee Consignor" all become "CONSIGNEE_CONSIGNOR". Exports render enums
 * as labels (e.g. "Owner / Broker"), so imports must accept them back.
 */
export const enumKey = (v: string | undefined): string =>
  (v ?? "")
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");

/**
 * Resolve a cell against an alias map whose keys are already enumKey-normalised.
 * Returns undefined when the value is empty or unknown.
 */
export const matchEnum = <T extends string>(
  v: string | undefined,
  aliases: Record<string, T>
): T | undefined => {
  const key = enumKey(v);
  return key ? aliases[key] : undefined;
};
