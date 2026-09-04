import { describe, expect, it } from "vitest";
import { computePlacement } from "./popover-placement";

const VIEWPORT = { width: 1280, height: 800 };
/** a field 200px wide at the given vertical/horizontal position */
const field = (top: number, left = 100, width = 200) => ({
  top,
  bottom: top + 36,
  left,
  width,
});

const place = (rect: ReturnType<typeof field>, viewport = VIEWPORT) =>
  computePlacement({ rect, viewport });

describe("vertical placement", () => {
  it("opens downward when there is room below", () => {
    const p = place(field(100));
    expect(p.flip).toBe(false);
    expect(p.maxHeight).toBe(256); // full list
  });

  it("flips above for a field near the bottom of the viewport", () => {
    // 40px of room below, ~700 above
    const p = place(field(724));
    expect(p.flip).toBe(true);
    expect(p.maxHeight).toBe(256);
  });

  it("stays downward near the top even when the list does not fully fit", () => {
    // a field at the very top: little above, plenty below
    const p = place(field(10));
    expect(p.flip).toBe(false);
  });

  it("does not flip when flipping would give LESS room", () => {
    // 196px below (394 - 186 - 4 - 8), 138px above — below is short of the
    // 256 max, but flipping would shrink the list, so it must stay down
    const rect = field(150);
    const p = computePlacement({ rect, viewport: { width: 1280, height: 394 } });
    expect(p.flip).toBe(false);
    expect(p.maxHeight).toBe(196);
  });

  it("sizes to the side it chose, so the list is never cut off", () => {
    const cramped = computePlacement({
      rect: field(600),
      viewport: { width: 1280, height: 700 },
    });
    // 700 - 636 - 4 - 8 = 52 below; above = 600 - 12 = 588 -> flips
    expect(cramped.flip).toBe(true);
    expect(cramped.maxHeight).toBeLessThanOrEqual(588);
    expect(cramped.maxHeight).toBe(256);
  });

  it("never returns a negative height when there is no room at all", () => {
    const p = computePlacement({
      rect: { top: 0, bottom: 800, left: 0, width: 200 },
      viewport: VIEWPORT,
    });
    expect(p.maxHeight).toBeGreaterThanOrEqual(0);
  });
});

describe("horizontal placement", () => {
  it("aligns to the field's left edge when it fits", () => {
    expect(place(field(100, 300)).left).toBe(300);
  });

  it("widens a narrow field to the readable minimum", () => {
    expect(place(field(100, 300, 80)).width).toBe(240);
  });

  it("keeps a wide field's own width", () => {
    expect(place(field(100, 300, 400)).width).toBe(400);
  });

  it("clamps a right-edge field back on screen", () => {
    // a 100px-wide field at x=1200 widens to 240 and would end at 1440
    const p = place(field(100, 1200, 100));
    expect(p.width).toBe(240);
    expect(p.left).toBe(1280 - 240 - 8);
    expect(p.left + p.width).toBeLessThanOrEqual(1280);
  });

  it("never pushes the list off the left edge", () => {
    const p = place(field(100, -50, 100));
    expect(p.left).toBe(8);
  });

  it("keeps a list wider than the viewport at the left margin", () => {
    const p = computePlacement({
      rect: field(100, 0, 900),
      viewport: { width: 400, height: 800 },
    });
    expect(p.left).toBe(8);
  });
});
