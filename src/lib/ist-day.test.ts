import { describe, expect, it } from "vitest";
import { istDayEnd, istDayRange, istDayStart } from "./utils";

/**
 * A 1–31 October register filter must hold every October document and no
 * other, whichever way the date was stored: IST midnight (18:30Z the day
 * before — dates picked in the browser) or UTC midnight (dates parsed on
 * the server).
 */
const inPeriod = (d: Date, from: string, to: string) => d >= istDayStart(from) && d <= istDayEnd(to);

describe("IST day boundaries for date filters", () => {
  const cases: [string, string, boolean][] = [
    ["1 Oct, stored at IST midnight", "2026-09-30T18:30:00Z", true],
    ["1 Oct, stored at UTC midnight", "2026-10-01T00:00:00Z", true],
    ["31 Oct, stored at IST midnight", "2026-10-30T18:30:00Z", true],
    ["31 Oct, stored at UTC midnight", "2026-10-31T00:00:00Z", true],
    ["1 Nov, stored at IST midnight", "2026-10-31T18:30:00Z", false],
    ["1 Nov, stored at UTC midnight", "2026-11-01T00:00:00Z", false],
    ["30 Sep, stored at IST midnight", "2026-09-29T18:30:00Z", false],
    ["30 Sep, stored at UTC midnight", "2026-09-30T00:00:00Z", false],
  ];
  for (const [label, stored, expected] of cases) {
    it(`${label} → ${expected ? "in" : "out of"} 1–31 October`, () => {
      expect(inPeriod(new Date(stored), "2026-10-01", "2026-10-31")).toBe(expected);
    });
  }

  it("works for any month — February in a leap year, and across a year end", () => {
    expect(inPeriod(new Date("2028-02-28T18:30:00Z"), "2028-02-01", "2028-02-29")).toBe(true); // 29 Feb
    expect(inPeriod(new Date("2028-02-29T18:30:00Z"), "2028-02-01", "2028-02-29")).toBe(false); // 1 Mar
    expect(inPeriod(new Date("2026-12-31T18:30:00Z"), "2026-12-01", "2027-01-31")).toBe(true); // 1 Jan
  });

  it("istDayRange agrees with the start / end helpers", () => {
    const r = istDayRange("2026-10-01", "2026-10-31");
    expect(r.gte).toEqual(istDayStart("2026-10-01"));
    expect(r.lt.getTime()).toBe(istDayEnd("2026-10-31").getTime() + 1);
  });
});
