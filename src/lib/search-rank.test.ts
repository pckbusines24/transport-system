import { describe, expect, it } from "vitest";
import { rankByMatch, searchRanked } from "./search-rank";

describe("search ranking", () => {
  const lrs = ["2872", "128", "28", "1280", "  28 "];
  it("puts exact matches first, then starts-with, keeping order", () => {
    expect(rankByMatch(lrs, "28", (x) => x)).toEqual(["28", "  28 ", "2872", "128", "1280"]);
  });
  it("ignores case and spaces", () => {
    const parties = ["Shree Balaji Traders", "BALAJI", "balaji  roadlines"];
    expect(searchRanked(parties, " balaji ", (x) => x)).toEqual([
      "BALAJI",
      "balaji  roadlines",
      "Shree Balaji Traders",
    ]);
  });
  it("matches across fields and on combined text", () => {
    const opts = [
      { label: "Raipur", meta: "CG" },
      { label: "Durg", meta: "Raipur road" },
      { label: "Bhilai", meta: "" },
    ];
    expect(searchRanked(opts, "raipur", (o) => [o.label, o.meta]).map((o) => o.label)).toEqual([
      "Raipur",
      "Durg",
    ]);
    expect(searchRanked(opts, "durg raipur", (o) => [o.label, o.meta]).map((o) => o.label)).toEqual([
      "Durg",
    ]);
  });
  it("empty query keeps everything in order", () => {
    expect(searchRanked(lrs, "  ", (x) => x)).toEqual(lrs);
  });
});

describe("rankByFilters", () => {
  it("ranks by every active column filter", async () => {
    const { rankByFilters } = await import("./search-rank");
    const rows = [
      { lr: "128", city: "Raipur" },
      { lr: "28", city: "Durg" },
      { lr: "28", city: "Raipur" },
    ];
    expect(
      rankByFilters(rows, [
        ["28", (r) => r.lr],
        ["raipur", (r) => r.city],
        ["", (r) => r.city],
      ])
    ).toEqual([rows[2], rows[0], rows[1]]);
  });
});
