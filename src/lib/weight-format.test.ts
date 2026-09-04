import { describe, expect, it } from "vitest";
import { formatWt, roundWt } from "./utils";

describe("weight sums do not leak float noise", () => {
  it("cleans up the values the chalan register was showing", () => {
    expect(roundWt(0.10500000000000001)).toBe(0.105);
    expect(formatWt(0.10500000000000001)).toBe("0.105");
    expect(formatWt(53.105000000000004)).toBe("53.105");
  });

  it("fixes the sum that produced them", () => {
    // POD shortage weights adding up through JS floats
    const sum = [0.1, 0.005].reduce((s, n) => s + n, 0);
    expect(sum).toBe(0.10500000000000001); // the raw float really is off
    expect(roundWt(sum)).toBe(0.105);

    // the larger figure from the report, same cause
    const big = [53.1, 0.005].reduce((s, n) => s + n, 0);
    expect(big).toBe(53.105000000000004);
    expect(formatWt(big)).toBe("53.105");
  });

  it("keeps three decimals, the precision the column is stored at", () => {
    expect(formatWt(1.234)).toBe("1.234");
    expect(formatWt(1.2345)).toBe("1.235"); // rounds, does not truncate
    expect(formatWt(1.2344)).toBe("1.234");
  });

  it("drops trailing zeros rather than padding", () => {
    expect(formatWt(2)).toBe("2");
    expect(formatWt(2.5)).toBe("2.5");
    expect(formatWt(2.1)).toBe("2.1");
  });

  it("groups large weights in the Indian style", () => {
    expect(formatWt(123456.789)).toBe("1,23,456.789");
  });

  it("handles zero, null, undefined and unparseable input as 0", () => {
    expect(formatWt(0)).toBe("0");
    expect(formatWt(null)).toBe("0");
    expect(formatWt(undefined)).toBe("0");
    expect(formatWt("abc")).toBe("0");
  });

  it("accepts a decimal string, as Prisma hands them back", () => {
    expect(formatWt("53.105")).toBe("53.105");
  });

  it("keeps negatives signed", () => {
    expect(roundWt(-0.10500000000000001)).toBe(-0.105);
    expect(formatWt(-0.105)).toBe("-0.105");
  });

  it("is stable when applied twice", () => {
    const once = roundWt(0.10500000000000001);
    expect(roundWt(once)).toBe(once);
  });
});
