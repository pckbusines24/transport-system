import { describe, it, expect } from "vitest";
import { driverNetFigures, driverNetPositions, signedRemainder, settlementStatus } from "./settlement";
import type { Tx } from "./db";

/**
 * Regression tests for the driver +/- settlement live-remainder rule: a row
 * already (partly) settled by Payment/Receipt-voucher allocations must be
 * payable only for what remains — never the full recorded amount again.
 */
describe("signedRemainder (driver settlement live outstanding)", () => {
  it("unpaid positive row stays fully payable", () =>
    expect(signedRemainder(5000, 0)).toBe(5000));
  it("fully voucher-settled positive row -> 0 (nothing to pay again)", () =>
    expect(signedRemainder(5000, 5000)).toBe(0));
  it("partially settled positive row -> only the remainder", () =>
    expect(signedRemainder(30000, 20000)).toBe(10000));
  it("over-settlement never flips the direction", () =>
    expect(signedRemainder(5000, 6000)).toBe(0));
  it("negative row (driver owes) shrinks toward zero as receipts settle it", () =>
    expect(signedRemainder(-5000, 2000)).toBe(-3000));
  it("fully received negative row -> 0", () =>
    expect(signedRemainder(-5000, 5000)).toBe(0));
  it("paisa rounding stays clean", () =>
    expect(signedRemainder(100.1, 33.37)).toBe(66.73));
});

describe("settlementStatus", () => {
  it("outstanding within a paisa reads PAID", () =>
    expect(settlementStatus(100, 0.005)).toBe("PAID"));
  it("partly settled reads PARTLY PAID", () =>
    expect(settlementStatus(100, 40)).toBe("PARTLY PAID"));
  it("untouched reads UNPAID", () => expect(settlementStatus(100, 100)).toBe("UNPAID"));
});

/**
 * One driver = ONE position on the Outstanding register / dashboard tiles:
 * the +/- trip rows net exactly like the running balance on the settlement
 * tab, and land on the payable side if positive, receivable if negative —
 * never on both.
 */
describe("driverNetPositions (per-driver netting)", () => {
  const row = (id: string, driverId: string, day: number, amount: number, extra = {}) => ({
    id,
    driverId,
    date: new Date(2026, 8, day),
    amount,
    status: "PENDING",
    settledDate: null,
    tripRef: id,
    voucherNo: null,
    ...extra,
  });
  // no voucher allocations unless a test supplies them
  const txWith = (allocations: { refId: string; amount: number }[] = []) =>
    ({
      voucherAllocation: {
        findMany: async () =>
          allocations.map((a) => ({ ...a, tdsAmt: 0, deduction: 0, otherAmt: 0, roundOff: 0 })),
      },
    }) as unknown as Tx;

  it("−7,010.56 then +10,455 nets to ONE payable of 3,444.44", async () => {
    const out = await driverNetPositions(txWith(), {
      firmId: "f",
      docs: [row("3", "ramesh", 5, -7010.56), row("4", "ramesh", 16, 10455)],
    });
    expect(out).toHaveLength(1);
    expect(out[0].net).toBe(3444.44);
    expect(out[0].refs).toEqual(["3", "4"]);
    expect(out[0].date).toEqual(new Date(2026, 8, 16));
    expect(driverNetFigures(out[0])).toEqual({ gross: 3444.44, paid: 0, outstanding: 3444.44 });
  });

  it("a negative net is a receivable, drivers are kept apart", async () => {
    const out = await driverNetPositions(txWith(), {
      firmId: "f",
      docs: [row("1", "a", 1, -5000), row("2", "a", 2, 1000), row("9", "b", 3, 700)],
    });
    const a = out.find((d) => d.driverId === "a")!;
    const b = out.find((d) => d.driverId === "b")!;
    expect(a.net).toBe(-4000);
    expect(b.net).toBe(700);
  });

  it("a chain that nets to zero disappears from the register", async () => {
    const out = await driverNetPositions(txWith(), {
      firmId: "f",
      docs: [row("1", "a", 1, -2500), row("2", "a", 2, 2500)],
    });
    expect(out).toHaveLength(0);
  });

  it("voucher allocations reduce the net, never pay a row twice", async () => {
    const out = await driverNetPositions(txWith([{ refId: "2", amount: 4000 }]), {
      firmId: "f",
      docs: [row("1", "a", 1, -1000), row("2", "a", 2, 10000)],
    });
    expect(out[0].net).toBe(5000);
    expect(driverNetFigures(out[0])).toEqual({ gross: 9000, paid: 4000, outstanding: 5000 });
  });

  it("as-on: a row settled on/before the date is left out of the chain", async () => {
    const out = await driverNetPositions(txWith(), {
      firmId: "f",
      asOf: new Date(2026, 8, 10),
      docs: [
        row("1", "a", 1, -7000, { status: "SETTLED", settledDate: new Date(2026, 8, 8) }),
        row("2", "a", 9, 3000, { status: "SETTLED", settledDate: new Date(2026, 8, 20) }),
      ],
    });
    expect(out).toHaveLength(1);
    expect(out[0].net).toBe(3000);
  });
});
