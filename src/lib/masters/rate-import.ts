/**
 * Rate-import sheet parsing — the header and cell rules, kept out of the
 * "use server" action so they can be unit-tested.
 *
 * The trap this exists to close: the Rate Setup screen's own Excel export
 * writes the product column as "Products" (plural) and an all-products row as
 * the literal "ALL". The importer used to look only for "PRODUCT" / "PRODUCT
 * NAME", so exporting rates and re-importing that very file matched no column,
 * read no products, and silently rewrote every row as an ALL-products rate.
 * A round-trip must be lossless.
 */

/** Header spellings that mean "the product column". */
export const PRODUCT_HEADERS = [
  "PRODUCT",
  "PRODUCTS",
  "PRODUCT NAME",
  "PRODUCT NAMES",
  "ITEM",
  "ITEMS",
  "MATERIAL",
  "MATERIALS",
  "COMMODITY",
  "COMMODITIES",
] as const;

/** The cell value that means "every product", as written by the export. */
export const ALL_PRODUCTS_TOKEN = "ALL";

/**
 * Column number of the product column, or 0 when the sheet has none (which
 * legitimately means every row is an all-products rate). Falls back to any
 * header starting with PRODUCT so a stray "Product Group" style heading still
 * lands, rather than silently degrading every row to ALL.
 */
export function resolveProductColumn(headers: Map<string, number>): number {
  for (const name of PRODUCT_HEADERS) {
    const c = headers.get(name);
    if (c) return c;
  }
  for (const [h, c] of Array.from(headers.entries())) {
    if (h.startsWith("PRODUCT")) return c;
  }
  return 0;
}

/**
 * Product names in one cell. COMMA-separated only — a slash or plus can be
 * part of a product's own name (e.g. "OIL/GREASE"). An empty cell, or the
 * literal "ALL", means no specific products: the rate covers everything.
 */
export function parseProductNames(cell: string): string[] {
  const trimmed = cell.trim();
  if (!trimmed || trimmed.toUpperCase() === ALL_PRODUCTS_TOKEN) return [];
  return trimmed
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}
