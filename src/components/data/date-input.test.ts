import { describe, expect, it } from "vitest";
import { isoToLocalDate } from "./date-input";

const ymd = (d: Date | null) =>
  d ? `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}` : null;

describe("isoToLocalDate", () => {
  it("reads a bare day as that day", () => {
    expect(ymd(isoToLocalDate("2026-10-25"))).toBe("2026-10-25");
  });
  it("reads an IST-midnight timestamp (18:30Z the day before) as the IST day", () => {
    expect(ymd(isoToLocalDate("2026-10-24T18:30:00.000Z"))).toBe("2026-10-25");
  });
  it("reads a UTC-midnight timestamp as the same day", () => {
    expect(ymd(isoToLocalDate("2026-10-25T00:00:00.000Z"))).toBe("2026-10-25");
  });
  it("rejects junk", () => {
    expect(isoToLocalDate("nope")).toBeNull();
  });
});
