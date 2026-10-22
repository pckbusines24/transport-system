import { describe, expect, it } from "vitest";
import { buildVouchersXml, voucherHash, type TallyVoucher } from "./tally";

/**
 * CHALAN ADVANCES RE-EXPORT BY REMOTEID.
 *
 *   new advance                 -> Create (with REMOTEID)
 *   edited, same voucher type   -> Alter  (same REMOTEID)
 *   edited, voucher type change -> Delete old + Create new
 */
const adv: TallyVoucher = {
  key: "CHALAN:c1:ADV:a1",
  remoteId: "CHALAN:c1:ADV:a1",
  type: "Payment",
  date: "20261020",
  voucherNo: "7",
  narration: "Advance",
  lines: [
    { ledger: "BROKER", amount: 10000, side: "DR" },
    { ledger: "CASH", amount: 10000, side: "CR" },
  ],
};

describe("chalan advance vouchers carry a REMOTEID", () => {
  it("creates with the REMOTEID by default", () => {
    const xml = buildVouchersXml([adv]);
    expect(xml).toContain('<VOUCHER REMOTEID="CHALAN:c1:ADV:a1" VCHTYPE="Payment" ACTION="Create">');
  });

  it("alters when asked", () => {
    expect(buildVouchersXml([{ ...adv, action: "Alter" }])).toContain('ACTION="Alter"');
  });

  it("puts the delete of the old type before the new create", () => {
    const xml = buildVouchersXml(
      [{ ...adv, type: "Journal" }],
      [{ remoteId: adv.remoteId!, type: "Payment", date: "20261020", voucherNo: "7" }]
    );
    const del = xml.indexOf('VCHTYPE="Payment" ACTION="Delete"');
    const create = xml.indexOf('VCHTYPE="Journal" ACTION="Create"');
    expect(del).toBeGreaterThan(-1);
    expect(create).toBeGreaterThan(del);
  });

  it("leaves vouchers without a REMOTEID unchanged", () => {
    const { remoteId: _r, ...plain } = adv;
    expect(buildVouchersXml([plain])).toContain('<VOUCHER VCHTYPE="Payment" ACTION="Create">');
  });

  it("does not change the content hash, so earlier exports stay matched", () => {
    const { remoteId: _r, ...plain } = adv;
    expect(voucherHash({ ...adv, action: "Alter" })).toBe(voucherHash(plain));
  });
});
