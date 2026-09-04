import { describe, expect, it } from "vitest";
import { canMoveToOnChalan, newlyLinkedLrIds, type LrStatusName } from "./lr-status";

const ALL: LrStatusName[] = ["PENDING", "ON_CHALAN", "ARRIVED", "DELIVERED", "BILLED"];

describe("a chalan never drags an LR backwards", () => {
  it("leaves a BILLED LR alone", () => {
    // the reported bug: re-saving a final chalan reset its billed LRs
    expect(canMoveToOnChalan("BILLED")).toBe(false);
  });

  it("leaves a DELIVERED LR alone — that status is POD-derived", () => {
    expect(canMoveToOnChalan("DELIVERED")).toBe(false);
  });

  it("moves an LR that has not got there yet", () => {
    expect(canMoveToOnChalan("PENDING")).toBe(true);
    expect(canMoveToOnChalan("ARRIVED")).toBe(true);
  });

  it("only ever moves LRs earlier in the lifecycle than DELIVERED", () => {
    const movable = ALL.filter(canMoveToOnChalan);
    expect(movable).toEqual(["PENDING", "ARRIVED"]);
  });

  it("ignores an unknown status rather than moving it", () => {
    expect(canMoveToOnChalan("SOMETHING_NEW")).toBe(false);
  });
});

describe("only LRs an edit adds are touched", () => {
  const onChalan = ["lr-1", "lr-2", "lr-3", "lr-4", "lr-5", "lr-6", "lr-7"];

  it("touches nothing when a final chalan is re-saved unchanged", () => {
    // the exact reported scenario: 7 billed LRs, chalan edited for some other
    // field — none of them may be re-stamped
    expect(newlyLinkedLrIds(onChalan, onChalan)).toEqual([]);
  });

  it("touches nothing when an unrelated field changes and the LR set is reordered", () => {
    const reordered = [...onChalan].reverse();
    expect(newlyLinkedLrIds(reordered, onChalan)).toEqual([]);
  });

  it("returns only the genuinely new LR", () => {
    expect(newlyLinkedLrIds([...onChalan, "lr-8"], onChalan)).toEqual(["lr-8"]);
  });

  it("returns every LR on a chalan that had none", () => {
    expect(newlyLinkedLrIds(onChalan, [])).toEqual(onChalan);
  });

  it("ignores LRs the edit removes", () => {
    expect(newlyLinkedLrIds(["lr-1", "lr-8"], onChalan)).toEqual(["lr-8"]);
  });

  it("de-duplicates a repeated id", () => {
    expect(newlyLinkedLrIds(["lr-8", "lr-8", "lr-9"], onChalan)).toEqual(["lr-8", "lr-9"]);
  });

  it("scales past a handful — no limit on how many LRs are processed", () => {
    const many = Array.from({ length: 250 }, (_, i) => `lr-${i}`);
    expect(newlyLinkedLrIds(many, [])).toHaveLength(250);
    expect(newlyLinkedLrIds(many, many.slice(0, 200))).toHaveLength(50);
  });
});
