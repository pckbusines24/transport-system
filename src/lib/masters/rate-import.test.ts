import { describe, expect, it } from "vitest";
import { parseProductNames, resolveProductColumn } from "./rate-import";

/** headers as the importer builds them: trimmed, upper-cased, 1-based column */
const sheet = (...names: string[]) =>
  new Map(names.map((n, i) => [n.trim().toUpperCase(), i + 1]));

describe("product column detection", () => {
  it("finds the plural 'Products' header the export itself writes", () => {
    // the exact sheet shape from Rate Setup's own export
    const headers = sheet("Party", "Products", "From", "To", "Rate", "Basis");
    expect(resolveProductColumn(headers)).toBe(2);
  });

  it("still finds the singular and other spellings", () => {
    expect(resolveProductColumn(sheet("Party", "Product", "From"))).toBe(2);
    expect(resolveProductColumn(sheet("Party", "Product Name", "From"))).toBe(2);
    expect(resolveProductColumn(sheet("Party", "Item", "From"))).toBe(2);
    expect(resolveProductColumn(sheet("Party", "Material", "From"))).toBe(2);
    expect(resolveProductColumn(sheet("Party", "Commodity", "From"))).toBe(2);
  });

  it("falls back to any PRODUCT-prefixed header", () => {
    expect(resolveProductColumn(sheet("Party", "Product Group", "From"))).toBe(2);
  });

  it("reports 0 when the sheet genuinely has no product column", () => {
    expect(resolveProductColumn(sheet("Party", "From", "To", "Rate"))).toBe(0);
  });
});

describe("product cell parsing", () => {
  it("splits the multi-product cell from the imported sheet", () => {
    expect(parseProductNames("ANGLE, BEAM, CHANNEL, PLATE, SHEET PILE")).toEqual([
      "ANGLE",
      "BEAM",
      "CHANNEL",
      "PLATE",
      "SHEET PILE",
    ]);
  });

  it("treats an empty cell as every product", () => {
    expect(parseProductNames("")).toEqual([]);
    expect(parseProductNames("   ")).toEqual([]);
  });

  it("reads the exported 'ALL' back as every product, not a product named ALL", () => {
    expect(parseProductNames("ALL")).toEqual([]);
    expect(parseProductNames("all")).toEqual([]);
    expect(parseProductNames(" All ")).toEqual([]);
  });

  it("keeps slashes and plusses, which belong to product names", () => {
    expect(parseProductNames("OIL/GREASE")).toEqual(["OIL/GREASE"]);
    expect(parseProductNames("NUT + BOLT")).toEqual(["NUT + BOLT"]);
  });

  it("tolerates ragged spacing and trailing separators", () => {
    expect(parseProductNames("ANGLE ,BEAM,  CHANNEL ,")).toEqual(["ANGLE", "BEAM", "CHANNEL"]);
  });

  it("does not treat a product merely containing 'all' as the ALL token", () => {
    expect(parseProductNames("METAL BALL")).toEqual(["METAL BALL"]);
  });
});
