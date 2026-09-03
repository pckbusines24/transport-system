import { describe, expect, it } from "vitest";
import { ImportDedup } from "./import-dedup";

/** Two legitimate diesel-card fills, same day, same amount, same head. */
const DIESEL = "2026-09-01|EXPENSE|head-diesel|veh-1|5000||card-hdfc||";

/** Run a file of rows through a ledger, reporting what each row did. */
const runFile = (dedup: ImportDedup, rows: string[], opts?: { unique?: boolean }) =>
  rows.map((k) => (dedup.isDuplicate(k, opts ?? {}) ? "skipped" : "created"));

describe("same-day, same-amount expenses are not duplicates", () => {
  it("imports both diesel fills from a fresh database", () => {
    const dedup = new ImportDedup([]);
    expect(runFile(dedup, [DIESEL, DIESEL])).toEqual(["created", "created"]);
  });

  it("imports all of a longer repeated run", () => {
    const dedup = new ImportDedup([]);
    expect(runFile(dedup, [DIESEL, DIESEL, DIESEL, DIESEL])).toEqual([
      "created",
      "created",
      "created",
      "created",
    ]);
  });
});

describe("re-importing the same file adds nothing", () => {
  it("recognises both records the second time", () => {
    // first import created two; the database now holds two
    const second = new ImportDedup([DIESEL, DIESEL]);
    expect(runFile(second, [DIESEL, DIESEL])).toEqual(["skipped", "skipped"]);
  });

  it("is stable over repeated re-imports", () => {
    for (let round = 0; round < 3; round++) {
      const dedup = new ImportDedup([DIESEL, DIESEL]);
      expect(runFile(dedup, [DIESEL, DIESEL])).toEqual(["skipped", "skipped"]);
    }
  });

  it("imports only the genuinely new row when the file grows", () => {
    // database has 2; the corrected file lists 3 of the same fill
    const dedup = new ImportDedup([DIESEL, DIESEL]);
    expect(runFile(dedup, [DIESEL, DIESEL, DIESEL])).toEqual([
      "skipped",
      "skipped",
      "created",
    ]);
  });

  it("skips a partial re-import without inventing work", () => {
    const dedup = new ImportDedup([DIESEL, DIESEL]);
    expect(runFile(dedup, [DIESEL])).toEqual(["skipped"]);
  });
});

describe("a reference number is treated as a real transaction id", () => {
  const withRef = "2026-09-01|EXPENSE|head-diesel|veh-1|5000|BILL-77|card-hdfc||";

  it("collapses repeats of the same reference inside one file", () => {
    const dedup = new ImportDedup([]);
    expect(runFile(dedup, [withRef, withRef], { unique: true })).toEqual([
      "created",
      "skipped",
    ]);
  });

  it("skips a reference already in the database", () => {
    const dedup = new ImportDedup([withRef]);
    expect(runFile(dedup, [withRef], { unique: true })).toEqual(["skipped"]);
  });
});

describe("distinct transactions stay distinct", () => {
  it("separates rows that differ in any signature field", () => {
    const dedup = new ImportDedup([DIESEL]);
    const differentVehicle = "2026-09-01|EXPENSE|head-diesel|veh-2|5000||card-hdfc||";
    const differentAmount = "2026-09-01|EXPENSE|head-diesel|veh-1|4000||card-hdfc||";
    const differentDate = "2026-09-02|EXPENSE|head-diesel|veh-1|5000||card-hdfc||";
    expect(runFile(dedup, [differentVehicle, differentAmount, differentDate])).toEqual([
      "created",
      "created",
      "created",
    ]);
    // and the seeded one is still recognised
    expect(runFile(dedup, [DIESEL])).toEqual(["skipped"]);
  });

  it("counts each signature independently", () => {
    const other = "2026-09-01|EXPENSE|head-toll|veh-1|5000||card-hdfc||";
    const dedup = new ImportDedup([DIESEL, other]);
    expect(dedup.count(DIESEL)).toBe(1);
    expect(dedup.count(other)).toBe(1);
    expect(runFile(dedup, [DIESEL, DIESEL, other])).toEqual([
      "skipped",
      "created",
      "skipped",
    ]);
  });
});
