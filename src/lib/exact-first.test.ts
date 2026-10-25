import { describe, expect, it } from "vitest";
import { findExactFirst } from "./exact-first";

// in-memory stand-in for a Prisma model: rows in date order, `where` shapes
// as findExactFirst builds them ({ AND: [base, exact | id-filter] })
type Row = { id: string; no: string };
const rows: Row[] = ["2872", "28", "128", "1280", "28", "2801"].map((no, i) => ({ id: `r${i}`, no }));
type W = { AND?: W[]; contains?: string; equals?: string; id?: { in?: string[]; notIn?: string[] } };
const match = (r: Row, w: W): boolean =>
  (!w.AND || w.AND.every((x) => match(r, x))) &&
  (w.contains === undefined || r.no.includes(w.contains)) &&
  (w.equals === undefined || r.no === w.equals) &&
  (!w.id?.in || w.id.in.includes(r.id)) &&
  (!w.id?.notIn || !w.id.notIn.includes(r.id));
const run = (skip: number, take: number | undefined, q = "28") =>
  findExactFirst<W, Row>({
    where: { contains: q },
    exact: { equals: q },
    ids: async (w, t) => rows.filter((r) => match(r, w)).slice(0, t).map((r) => r.id),
    fetch: async (w, s, t) => rows.filter((r) => match(r, w)).slice(s, t === undefined ? undefined : s + t),
    skip,
    take,
  }).then((out) => out.map((r) => r.id));

describe("findExactFirst", () => {
  it("serves exact matches first, then the rest in order", async () => {
    expect(await run(0, 10)).toEqual(["r1", "r4", "r0", "r2", "r3", "r5"]);
  });
  it("pages across the exact/rest boundary without gaps or repeats", async () => {
    const pages = [...(await run(0, 3)), ...(await run(3, 3))];
    expect(pages).toEqual(["r1", "r4", "r0", "r2", "r3", "r5"]);
    expect(await run(1, 2)).toEqual(["r4", "r0"]);
  });
  it("take undefined returns every row", async () => {
    expect(await run(0, undefined)).toHaveLength(6);
  });
  it("no exact match keeps the plain order", async () => {
    expect(await run(0, 10, "80")).toEqual(["r3", "r5"]);
  });
});
