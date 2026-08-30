/**
 * Output-parity harness for `saveLrBatch`.
 *
 * WHY THIS EXISTS
 * `saveLrBatch` used to run two party lookups plus an ODC-product lookup for
 * every entry, serially, inside one transaction. Those were hoisted out of the
 * loop into batched lookups. Nothing about what gets written was meant to
 * change, and a batch save is how a clerk enters a day's LRs, so a silent
 * arithmetic drift here would corrupt real freight bills.
 *
 * WHAT IT CHECKS
 *   A. `saveLrBatch` vs `saveLr` called one entry at a time.
 *      This is the invariant that must hold forever: saving N LRs as a batch
 *      must produce byte-identical rows to saving the same N one by one.
 *   B. `saveLrBatch` vs the same function at a baseline git ref (BASELINE_REF,
 *      default HEAD). Skipped, loudly, when the baseline is byte-identical to
 *      the working tree — otherwise it would pass vacuously.
 *   C. The behaviours that must survive any refactor of this function:
 *      duplicate-number detection within a batch, clash detection against
 *      existing LRs, and sequential number assignment.
 *
 * The payload deliberately mixes intra-state and inter-state GSTIN pairs (so
 * both the CGST/SGST and IGST splits are exercised), a party with no GSTIN,
 * ODC and NORMAL products, multi-item LRs, dummy and real vehicles, GST on and
 * off, and a non-zero advance.
 *
 * HOW TO RUN — see ./README.md. It needs a THROWAWAY database: it deletes all
 * Lr, LrItem, DocumentSequence and AuditLog rows between cases, so never point
 * it at anything you care about.
 */
import assert from "node:assert";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { PrismaClient } from "@prisma/client";
import type { Session } from "@/lib/session";

const ROOT = path.resolve(__dirname, "../..");
const SRC = "src/app/(app)/lr/actions.ts";
const TMP = path.join(ROOT, "scripts/parity/.tmp");

// ---------------------------------------------------------------- module prep
/**
 * `lr/actions.ts` is a "use server" module: it reads the session from cookies
 * and calls revalidatePath, neither of which exists outside a Next request. The
 * transform injects a session and stubs the two cache signals — it touches
 * nothing that can affect what is written to the database.
 */
const HEADER = `import type { Session } from "@/lib/session";
export let SESSION: Session & { firmId: string; fyId: string } = null as never;
export function setSession(s: Session & { firmId: string; fyId: string }) { SESSION = s; }
const requireSession = () => SESSION;
const revalidatePath = (_p: string) => {};
const revalidateOutstanding = (_t: string) => {};
`;

function transform(src: string): string {
  let s = src.replace('"use server";\n', "");
  s = s.replace('import { revalidatePath } from "next/cache";\n', "");
  s = s.replace('import { revalidateOutstanding } from "@/lib/outstanding-cache";\n', "");
  s = s.replace('import { requireSession } from "@/lib/session";\n', "");
  // relative imports would resolve against the temp dir, not the real one
  s = s.replace(/from "\.\//g, 'from "@/app/(app)/lr/');
  assert.ok(s.includes("requireSession()"), "transform lost the session injection point");
  assert.ok(!s.includes('from "next/cache"'), "transform left a next/cache import behind");
  return HEADER + s;
}

type LrModule = {
  setSession: (s: Session & { firmId: string; fyId: string }) => void;
  saveLr: (i: unknown) => Promise<{ ok: true; id: string } | { ok: false; error: string }>;
  saveLrBatch: (i: unknown) => Promise<{ ok: true; lrNos: string[] } | { ok: false; error: string }>;
};

function writeModule(name: string, source: string): string {
  fs.mkdirSync(TMP, { recursive: true });
  const file = path.join(TMP, `${name}.ts`);
  fs.writeFileSync(file, transform(source));
  return file;
}

// ---------------------------------------------------------------- reporting
let fail = 0;
const ok = (label: string, note = "") => console.log(`  OK    ${label.padEnd(46)} ${note}`);
const skip = (label: string, why: string) => console.log(`  SKIP  ${label.padEnd(46)} ${why}`);
const bad = (label: string, e: unknown) => {
  fail++;
  console.log(`  FAIL  ${label}\n${String((e as Error).message).split("\n").slice(0, 30).join("\n")}`);
};

const prisma = new PrismaClient({
  datasources: { db: { url: process.env.DIRECT_DATABASE_URL ?? process.env.DATABASE_URL } },
});

/** LR + items reduced to the fields that must not change, ordered stably. */
async function snapshot() {
  const lrs = await prisma.lr.findMany({
    where: { deletedAt: null },
    include: { items: { orderBy: [{ productName: "asc" }, { rate: "asc" }] } },
    orderBy: { lrNo: "asc" },
  });
  const n = (v: unknown) => (v == null ? null : Number(v));
  return lrs.map((l) => ({
    lrNo: l.lrNo,
    lrDate: l.lrDate.toISOString(),
    sourceCityId: l.sourceCityId, destCityId: l.destCityId,
    consignorId: l.consignorId, consigneeId: l.consigneeId,
    vehicleId: l.vehicleId, vehicleText: l.vehicleText, isDummy: l.isDummy,
    lrType: l.lrType, cargoType: l.cargoType, status: l.status,
    gstApplicable: l.gstApplicable,
    freight: n(l.freight), hamali: n(l.hamali), preBhada: n(l.preBhada),
    biltyCharge: n(l.biltyCharge), collCharge: n(l.collCharge), cpc: n(l.cpc),
    otherCharge: n(l.otherCharge), total: n(l.total),
    cgstAmt: n(l.cgstAmt), sgstAmt: n(l.sgstAmt), igstAmt: n(l.igstAmt),
    advance: n(l.advance), grandTotal: n(l.grandTotal),
    items: l.items.map((i) => ({
      productId: i.productId, productName: i.productName, qty: n(i.qty),
      actualWt: n(i.actualWt), chargeWt: n(i.chargeWt), unit: i.unit,
      rate: n(i.rate), rateBasis: i.rateBasis, amount: n(i.amount),
    })),
  }));
}

/** Hard reset, so every case starts from an identical blank slate. */
async function reset() {
  await prisma.lrItem.deleteMany({});
  await prisma.lr.deleteMany({});
  await prisma.documentSequence.deleteMany({});
  await prisma.auditLog.deleteMany({});
}

// ---------------------------------------------------------------- fixtures
type Setup = {
  tenantId: string; firmId: string; fyId: string; userId: string;
  cityA: string; cityB: string; vehicleId: string;
  parties: { id: string; gstin: string | null }[];
  odcProductId: string; normalProductId: string;
};

/**
 * Masters shaped so every branch the batching touched is actually taken.
 * Idempotent: re-running reuses what is already there.
 */
async function ensureFixtures(): Promise<Setup> {
  const tenant = await prisma.tenant.findFirstOrThrow();
  const firm = await prisma.firm.findFirstOrThrow();
  const fy = await prisma.financialYear.findFirstOrThrow();
  const user = await prisma.user.findFirstOrThrow();

  // the firm must actually charge GST, or every split is trivially zero
  await prisma.firm.update({
    where: { id: firm.id },
    data: { gstin: "27AAAAA0000A1Z5", cgstPct: 6, sgstPct: 6, igstPct: 0 },
  });

  // 27* = the firm's own state (CGST+SGST), 29* = another state (IGST),
  // and one party with no GSTIN at all
  const specs = [
    ["PARITY PARTY MH-1", "27BBBBB1111B1Z5"],
    ["PARITY PARTY MH-2", "27CCCCC2222C1Z5"],
    ["PARITY PARTY KA-1", "29DDDDD3333D1Z5"],
    ["PARITY PARTY KA-2", "29EEEEE4444E1Z5"],
    ["PARITY PARTY NOGST", null],
  ] as const;
  const parties = [];
  for (const [name, gstin] of specs) {
    const found = await prisma.party.findFirst({ where: { name } });
    parties.push(found ?? (await prisma.party.create({
      data: { tenantId: tenant.id, name, ledgerGroup: "CONSIGNEE_CONSIGNOR", gstin },
    })));
  }

  const group = await prisma.productGroup.findFirstOrThrow();
  const product = async (name: string, productType: string) =>
    (await prisma.product.findFirst({ where: { name } })) ??
    (await prisma.product.create({ data: { tenantId: tenant.id, name, groupId: group.id, productType } }));
  const odc = await product("PARITY ODC PRODUCT", "ODC");
  const normal = await product("PARITY NORMAL PRODUCT", "NORMAL");

  const cities = await prisma.city.findMany({ take: 2, orderBy: { name: "asc" } });
  assert.ok(cities.length >= 1, "seed the database first — no cities found");
  const vehicle = await prisma.vehicle.findFirstOrThrow();

  return {
    tenantId: tenant.id, firmId: firm.id, fyId: fy.id, userId: user.id,
    cityA: cities[0].id, cityB: (cities[1] ?? cities[0]).id, vehicleId: vehicle.id,
    parties: parties.map((p) => ({ id: p.id, gstin: p.gstin })),
    odcProductId: odc.id, normalProductId: normal.id,
  };
}

function entries(s: Setup) {
  const P = s.parties;
  const mix = [
    { from: 0, to: 1, gst: true,  odc: false, items: 1, dummy: false, adv: 0 },
    { from: 0, to: 2, gst: true,  odc: true,  items: 2, dummy: false, adv: 250 },
    { from: 2, to: 3, gst: true,  odc: false, items: 1, dummy: true,  adv: 0 },
    { from: 1, to: 4, gst: true,  odc: true,  items: 3, dummy: false, adv: 100 },
    { from: 4, to: 0, gst: false, odc: false, items: 2, dummy: false, adv: 0 },
    { from: 3, to: 2, gst: true,  odc: false, items: 1, dummy: false, adv: 75 },
    { from: 0, to: 1, gst: false, odc: true,  items: 2, dummy: true,  adv: 0 },
  ];
  return mix.map((e, i) => ({
    lrDate: `2026-06-${String(i + 1).padStart(2, "0")}`,
    sourceCityId: s.cityA, destCityId: s.cityB,
    consignorId: P[e.from].id, consigneeId: P[e.to].id,
    vehicleId: e.dummy ? null : s.vehicleId,
    vehicleText: e.dummy ? `DUMMY ${i}` : null,
    isDummy: e.dummy,
    lrType: "TBB" as const,
    gstApplicable: e.gst,
    freight: 1000 + i * 137, hamali: 50 + i, preBhada: 10 * i,
    biltyCharge: 20, collCharge: 5 * i, cpc: 15, otherCharge: 7 * i,
    advance: e.adv,
    items: Array.from({ length: e.items }, (_, k) => ({
      // the ODC flag must come from the PRODUCT MASTER, never from the payload
      productId: e.odc && k === 0 ? s.odcProductId : s.normalProductId,
      productName: e.odc && k === 0 ? "PARITY ODC PRODUCT" : "PARITY NORMAL PRODUCT",
      qty: 1 + k, actualWt: 10 + k, chargeWt: 12 + k, unit: "MT",
      rate: 100 + k * 10, rateBasis: "CHARGE_WT" as const,
    })),
  }));
}

// ---------------------------------------------------------------- run
async function main() {
  const baselineRef = process.env.BASELINE_REF ?? "HEAD";
  const current = fs.readFileSync(path.join(ROOT, SRC), "utf8");
  let baseline: string | null = null;
  try {
    baseline = execFileSync("git", ["show", `${baselineRef}:${SRC}`], { cwd: ROOT, encoding: "utf8" });
  } catch {
    console.log(`  (could not read ${baselineRef}:${SRC} — comparison B will be skipped)`);
  }

  const newM: LrModule = require(writeModule("current-lr-actions", current));
  const oldM: LrModule | null =
    baseline && baseline !== current ? require(writeModule("baseline-lr-actions", baseline)) : null;

  const s = await ensureFixtures();
  const session = {
    userId: s.userId, tenantId: s.tenantId, username: "parity", name: "Parity Harness",
    role: "OWNER", firmId: s.firmId, fyId: s.fyId,
  } as Session & { firmId: string; fyId: string };
  newM.setSession(session);
  oldM?.setSession(session);
  const payload = entries(s);

  // ---- A: batch vs one-by-one --------------------------------------------
  console.log("A. saveLrBatch  vs  saveLr, one entry at a time");
  await reset();
  const batched = await newM.saveLrBatch({ entries: payload });
  assert.ok(batched.ok, `batch save failed: ${batched.ok ? "" : batched.error}`);
  const fromBatch = await snapshot();

  await reset();
  // saveLr's schema rejects a blank number, so the singles are given exactly
  // the numbers the batch assigned itself
  for (let i = 0; i < payload.length; i++) {
    const r = await newM.saveLr({ ...payload[i], lrNo: batched.lrNos[i], cargoType: "NORMAL" });
    assert.ok(r.ok, `single save ${i} failed: ${r.ok ? "" : r.error}`);
  }
  const fromSingles = await snapshot();

  try {
    assert.strictEqual(fromBatch.length, payload.length);
    assert.deepStrictEqual(fromBatch, fromSingles);
    const odc = fromBatch.filter((l) => l.cargoType === "ODC").length;
    const igst = fromBatch.filter((l) => (l.igstAmt ?? 0) > 0).length;
    const cgst = fromBatch.filter((l) => (l.cgstAmt ?? 0) > 0).length;
    // guard against a vacuous pass: if these branches were never taken the
    // comparison proved far less than it appears to
    assert.ok(odc > 0, "no ODC row produced — the cargoType branch was never taken");
    assert.ok(igst > 0 && cgst > 0, "GST split produced only one of IGST / CGST+SGST");
    ok("every field identical", `${fromBatch.length} LRs · ${odc} ODC · ${cgst} CGST/SGST · ${igst} IGST`);
  } catch (e) { bad("batch vs singles", e); }

  // ---- B: current vs baseline --------------------------------------------
  console.log(`\nB. saveLrBatch  vs  the same function at ${baselineRef}`);
  if (!oldM) {
    skip("baseline comparison", baseline ? `${baselineRef} is identical to the working tree` : "baseline unreadable");
  } else {
    await reset();
    const rOld = await oldM.saveLrBatch({ entries: payload });
    assert.ok(rOld.ok, `baseline batch failed: ${rOld.ok ? "" : rOld.error}`);
    const before = await snapshot();
    await reset();
    const rNew = await newM.saveLrBatch({ entries: payload });
    assert.ok(rNew.ok, `current batch failed: ${rNew.ok ? "" : rNew.error}`);
    const after = await snapshot();
    try {
      assert.deepStrictEqual(after, before);
      assert.deepStrictEqual(rNew.lrNos, rOld.lrNos);
      ok("every field identical", `assigned ${rNew.lrNos.join(",")}`);
    } catch (e) { bad("current vs baseline", e); }
  }

  // ---- C: invariants that must survive any refactor -----------------------
  console.log("\nC. clash detection and number assignment");

  await reset();
  const dup = await newM.saveLrBatch({
    entries: [{ ...payload[0], lrNo: "77" }, { ...payload[1], lrNo: "77" }],
  });
  try {
    assert.ok(!dup.ok && /used twice in this batch/.test(dup.error), `got ${JSON.stringify(dup)}`);
    assert.strictEqual(await prisma.lr.count(), 0, "a rejected batch must write nothing");
    ok("duplicate number inside one batch rejected", dup.ok ? "" : `"${dup.error}"`);
  } catch (e) { bad("in-batch duplicate", e); }

  await reset();
  assert.ok((await newM.saveLr({ ...payload[0], lrNo: "500", cargoType: "NORMAL" })).ok);
  const clash = await newM.saveLrBatch({ entries: [{ ...payload[1], lrNo: "500" }] });
  try {
    assert.ok(!clash.ok && /already exists in the current Financial Year/.test(clash.error), `got ${JSON.stringify(clash)}`);
    assert.strictEqual(await prisma.lr.count(), 1, "the clashing batch must not have written");
    ok("clash with an existing LR rejected");
  } catch (e) { bad("existing-LR clash", e); }

  await reset();
  try {
    const seq = await newM.saveLrBatch({ entries: payload.slice(0, 4) });
    assert.ok(seq.ok);
    assert.deepStrictEqual(seq.lrNos, ["1", "2", "3", "4"]);
    // blanks continue from max+1 and step over anything typed in the same batch
    const mixed = await newM.saveLrBatch({
      entries: [{ ...payload[0], lrNo: "9" }, payload[1], { ...payload[2], lrNo: "" }],
    });
    assert.ok(mixed.ok);
    assert.deepStrictEqual(mixed.lrNos, ["9", "5", "6"]);
    ok("sequential assignment, typed numbers honoured", "[1,2,3,4] then [9,5,6]");
  } catch (e) { bad("number assignment", e); }

  await reset();
  fs.rmSync(TMP, { recursive: true, force: true });
  console.log(`\n${fail === 0 ? "PASS — saveLrBatch is output-identical" : `FAIL — ${fail} check(s) differed`}`);
  await prisma.$disconnect();
  process.exit(fail === 0 ? 0 : 1);
}

main().catch(async (e) => {
  console.error(e);
  fs.rmSync(TMP, { recursive: true, force: true });
  await prisma.$disconnect().catch(() => {});
  process.exit(1);
});
