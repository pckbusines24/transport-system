import { describe, expect, it } from "vitest";
import type { Tx } from "./db";
import { lrNumberAllocator, nextLrNumber } from "./sequences";

/**
 * NEXT LR NUMBER = LAST NEW LR ENTERED + 1, not the highest number.
 * `lrs` is in entry order (oldest first); the fake tx answers the two
 * queries the allocator makes.
 */
function fakeTx(lrs: string[]): Tx {
  const rows = lrs.map((lrNo) => ({ lrNo }));
  return {
    lr: {
      findMany: async () => rows,
      findFirst: async () => rows[rows.length - 1] ?? null,
    },
  } as unknown as Tx;
}
const args = { firmId: "f", fyId: "y" };

describe("next LR number follows the last LR entered", () => {
  it("continues from the last entry, not the highest", async () => {
    // 9001 was a stray entry; work went back to the 1240s
    expect(await nextLrNumber(fakeTx(["1240", "9001", "1241"]), args)).toBe("1242");
  });

  it("follows a high entry when that IS the last one", async () => {
    expect(await nextLrNumber(fakeTx(["1240", "9001"]), args)).toBe("9002");
  });

  it("skips numbers a live LR already holds", async () => {
    expect(await nextLrNumber(fakeTx(["1242", "1243", "1241"]), args)).toBe("1244");
  });

  it("reads the digits of a prefixed number", async () => {
    expect(await nextLrNumber(fakeTx(["LR-77"]), args)).toBe("78");
  });

  it("starts at 1 in an empty year", async () => {
    expect(await nextLrNumber(fakeTx([]), args)).toBe("1");
  });

  it("hands a batch consecutive free numbers, honouring its typed ones", async () => {
    // last entered is 100; 102 is already taken, 103 is typed in the batch
    const next = await lrNumberAllocator(fakeTx(["102", "100"]), args);
    const typed = new Set(["103"]);
    expect([next((n) => typed.has(n)), next((n) => typed.has(n)), next((n) => typed.has(n))]).toEqual([
      "101",
      "104",
      "105",
    ]);
  });
});
