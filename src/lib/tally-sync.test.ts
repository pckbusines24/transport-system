import { describe, expect, it } from "vitest";
import { buildVouchersXml, voucherHash, type TallyVoucher } from "./tally";
import { applyOps, docIdOfKey, ledgerSig, planDoc, type RegistryRow, type SyncDoc } from "./tally-sync";

/**
 * The scenarios from the Tally sync spec (Chalan + Billing), run through the
 * planner. "Tally" here is the export register as the confirmed files left
 * it — each test exports, confirms (applyOps), edits and exports again.
 */

const v = (key: string, lines: [string, number, "DR" | "CR"][], extra: Partial<TallyVoucher> = {}): TallyVoucher => ({
  key,
  remoteId: key,
  type: "Journal",
  date: "20261020",
  voucherNo: "7",
  narration: "n",
  lines: lines.map(([ledger, amount, side]) => ({ ledger, amount, side })),
  ...extra,
});

const chalan = (over: { comm?: number; mamool?: number; freight?: number; det?: number } = {}): SyncDoc => {
  const { comm = 700, mamool = 800, freight = 50000, det = 0 } = over;
  const vs: TallyVoucher[] = [
    v("CHALAN:c1:MAIN", [["FREIGHT", freight, "DR"], ["BROKER", freight, "CR"]], { type: "Purchase" }),
  ];
  if (det > 0) vs.push(v("CHALAN:c1:DET", [["DETENTION", det, "DR"], ["BROKER", det, "CR"]]));
  if (comm > 0) vs.push(v("CHALAN:c1:COMM", [["BROKER", comm, "DR"], ["COMMISSION", comm, "CR"]]));
  if (mamool > 0) vs.push(v("CHALAN:c1:MAMOOL", [["BROKER", mamool, "DR"], ["MAMOOL", mamool, "CR"]]));
  return { id: "c1", refNo: "7", vouchers: vs };
};

/** export + confirm the import; returns the new register */
function exportAndConfirm(doc: SyncDoc, reg: Map<string, RegistryRow>, opts = {}) {
  const plan = planDoc(doc, Array.from(reg.values()), { sync: true, ...opts });
  return { plan, reg: applyOps(reg, plan.ops) };
}

describe("Tally sync planner — sync ON", () => {
  it("1. a new chalan is created, every voucher with its REMOTEID", () => {
    const { plan } = exportAndConfirm(chalan(), new Map());
    expect(plan.status).toBe("NEW");
    expect(plan.vouchers.map((x) => x.action)).toEqual(["Create", "Create", "Create"]);
    const xml = buildVouchersXml(plan.vouchers, plan.deletes);
    expect(xml).toContain('REMOTEID="CHALAN:c1:COMM" VCHTYPE="Journal" ACTION="Create"');
  });

  it("2/3. a changed amount (freight, commission 700 -> 600) alters the same voucher", () => {
    let { reg } = exportAndConfirm(chalan(), new Map());
    const { plan } = exportAndConfirm(chalan({ comm: 600, freight: 48000 }), reg);
    expect(plan.status).toBe("CHANGED");
    expect(plan.vouchers.map((x) => [x.key, x.action])).toEqual([
      ["CHALAN:c1:MAIN", "Alter"],
      ["CHALAN:c1:COMM", "Alter"],
    ]);
    expect(plan.deletes).toEqual([]);
    expect(plan.skipped).toBe(1); // mamool unchanged
    reg = applyOps(reg, plan.ops);
    expect(reg.get("CHALAN:c1:COMM")?.hash).toBe(voucherHash(chalan({ comm: 600 }).vouchers[1]));
  });

  it("4/5. mamool 800 -> 0 (or cleared) deletes only the mamool journal", () => {
    const { reg } = exportAndConfirm(chalan(), new Map());
    const { plan, reg: after } = exportAndConfirm(chalan({ mamool: 0 }), reg);
    expect(plan.vouchers).toEqual([]);
    expect(plan.deletes).toEqual([
      { remoteId: "CHALAN:c1:MAMOOL", type: "Journal", date: "20261020", voucherNo: "7" },
    ]);
    expect(after.has("CHALAN:c1:MAMOOL")).toBe(false);
    expect(after.has("CHALAN:c1:COMM")).toBe(true);
  });

  it("6. detention added, edited and removed on its own journal", () => {
    let { reg } = exportAndConfirm(chalan(), new Map());
    let r = exportAndConfirm(chalan({ det: 5000 }), reg);
    expect(r.plan.vouchers.map((x) => [x.key, x.action])).toEqual([["CHALAN:c1:DET", "Create"]]);
    reg = r.reg;
    r = exportAndConfirm(chalan({ det: 4000 }), reg);
    expect(r.plan.vouchers.map((x) => [x.key, x.action])).toEqual([["CHALAN:c1:DET", "Alter"]]);
    reg = r.reg;
    r = exportAndConfirm(chalan({ det: 0 }), reg);
    expect(r.plan.deletes.map((d) => d.remoteId)).toEqual(["CHALAN:c1:DET"]);
  });

  it("7. an unchanged chalan sends nothing; a full re-export alters, never creates", () => {
    const { reg } = exportAndConfirm(chalan(), new Map());
    const again = planDoc(chalan(), Array.from(reg.values()), { sync: true });
    expect(again.status).toBe("EXPORTED");
    expect(again.vouchers).toEqual([]);
    expect(again.skipped).toBe(3);
    const full = planDoc(chalan(), Array.from(reg.values()), { sync: true, includeExported: true });
    expect(full.vouchers.every((x) => x.action === "Alter")).toBe(true);
  });

  it("a changed party (ledger set) goes as Delete + Create with the same REMOTEID", () => {
    const bill = (party: string, amt: number): SyncDoc => ({
      id: "b1",
      refNo: "SB/1",
      vouchers: [v("BILL:b1:MAIN", [[party, amt, "DR"], ["FREIGHT RECEIPTS", amt, "CR"]], { type: "Sales" })],
    });
    const { reg } = exportAndConfirm(bill("ACME", 140245), new Map());
    const amount = planDoc(bill("ACME", 135000), Array.from(reg.values()), { sync: true });
    expect(amount.vouchers[0].action).toBe("Alter");
    const party = planDoc(bill("BETA LTD", 135000), Array.from(reg.values()), { sync: true });
    expect(party.deletes.map((d) => d.remoteId)).toEqual(["BILL:b1:MAIN"]);
    expect(party.vouchers[0].action).toBe("Create");
    const xml = buildVouchersXml(party.vouchers, party.deletes);
    expect(xml.indexOf('ACTION="Delete"')).toBeLessThan(xml.indexOf('ACTION="Create"'));
  });

  it("a deleted / cancelled document deletes every voucher it had", () => {
    const { reg } = exportAndConfirm(chalan(), new Map());
    const gone = planDoc({ id: "c1", refNo: "7", vouchers: [], removed: true }, Array.from(reg.values()), {
      sync: true,
    });
    expect(gone.status).toBe("REMOVE");
    expect(gone.deletes.map((d) => d.remoteId).sort()).toEqual([
      "CHALAN:c1:COMM",
      "CHALAN:c1:MAIN",
      "CHALAN:c1:MAMOOL",
    ]);
    expect(applyOps(reg, gone.ops).size).toBe(0);
  });

  it("legacy (pre-REMOTEID) copies block a changed document until confirmed deleted", () => {
    const legacy: RegistryRow[] = chalan().vouchers.map((x) => ({
      key: x.key,
      hash: voucherHash(x),
      remoteId: false,
      vchType: x.type,
      vchDate: x.date,
      ledgerSig: null,
    }));
    // unchanged legacy: in sync, nothing to do
    expect(planDoc(chalan(), legacy, { sync: true }).status).toBe("EXPORTED");
    // changed legacy: blocked, nothing sent
    const blocked = planDoc(chalan({ comm: 600 }), legacy, { sync: true });
    expect(blocked.status).toBe("LEGACY");
    expect(blocked.blocked).toMatch(/Delete ALL vouchers of 7/);
    expect(blocked.vouchers).toEqual([]);
    // confirmed: everything created fresh, register rewritten with REMOTEIDs
    const ok = planDoc(chalan({ comm: 600 }), legacy, { sync: true, legacyConfirmed: true });
    expect(ok.vouchers.map((x) => x.action)).toEqual(["Create", "Create", "Create"]);
    expect(ok.deletes).toEqual([]);
    const reg = applyOps(new Map(legacy.map((r) => [r.key, r])), ok.ops);
    expect(Array.from(reg.values()).every((r) => r.remoteId)).toBe(true);
  });

  it("editing one chalan never touches another chalan's vouchers", () => {
    const { reg } = exportAndConfirm(chalan(), new Map());
    const other: SyncDoc = {
      id: "c2",
      refNo: "8",
      vouchers: [v("CHALAN:c2:MAIN", [["FREIGHT", 1000, "DR"], ["BROKER", 1000, "CR"]], { type: "Purchase" })],
    };
    const rowsForC2 = Array.from(reg.values()).filter((r) => docIdOfKey(r.key, "CHALAN:") === "c2");
    const plan = planDoc(other, rowsForC2, { sync: true });
    expect(plan.deletes).toEqual([]);
    expect(plan.ops.every((o) => o.docId === "c2")).toBe(true);
  });
});

describe("Tally sync planner — sync OFF keeps the old export", () => {
  it("creates everything, never deletes", () => {
    const doc = chalan();
    const off = { ...doc, vouchers: doc.vouchers.map((x) => ({ ...x, remoteId: undefined })) };
    const plan = planDoc(off, [], { sync: false });
    expect(plan.vouchers.every((x) => (x.action ?? "Create") === "Create")).toBe(true);
    expect(plan.deletes).toEqual([]);
  });
});

describe("helpers", () => {
  it("ledgerSig is order-free; docIdOfKey splits register keys", () => {
    expect(ledgerSig(v("k", [["B", 1, "DR"], ["A", 1, "CR"]]))).toBe("A|B");
    expect(docIdOfKey("CHALAN:abc:ADV:x", "CHALAN:")).toBe("abc");
    expect(docIdOfKey("BILL:b9:MAIN", "CHALAN:")).toBeNull();
  });
});
