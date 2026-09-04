import { describe, expect, it } from "vitest";
import { resolveOnBlur } from "./combobox-resolve";

/**
 * The Chalan form's Transport Name options: value = broker id, label =
 * transport name, and the transport name is NOT unique.
 */
const RAJAN = { value: "broker-rajan", label: "SSBL" };
const RAMESHWAR = { value: "broker-rameshwar", label: "SSBL" };
const OTHER = { value: "broker-vrl", label: "VRL LOGISTICS" };
const OPTIONS = [RAJAN, RAMESHWAR, OTHER];

/** blurring a field that displays `label` with `value` selected */
const blur = (value: string | null, text: string) =>
  resolveOnBlur({ text, value, options: OPTIONS });

describe("duplicate transport names stay independently selectable", () => {
  it("Case 1: Rajan Yadav -> SSBL survives moving to another field", () => {
    const r = blur(RAJAN.value, "SSBL");
    expect(r.value).toBe(RAJAN.value);
    expect(r.changed).toBe(false);
  });

  it("Case 2: Rameshwar -> SSBL survives moving to another field", () => {
    // the regression: this used to resolve back to broker-rajan, the first
    // option sharing the label
    const r = blur(RAMESHWAR.value, "SSBL");
    expect(r.value).toBe(RAMESHWAR.value);
    expect(r.value).not.toBe(RAJAN.value);
    expect(r.changed).toBe(false);
  });

  it("Case 3: switching Rajan -> Rameshwar keeps the Rameshwar record", () => {
    let selected: string | null = RAJAN.value;
    expect(blur(selected, "SSBL").value).toBe(RAJAN.value);
    // user picks the Rameshwar SSBL from the list, then blurs
    selected = RAMESHWAR.value;
    expect(blur(selected, "SSBL").value).toBe(RAMESHWAR.value);
  });

  it("Case 4: switching back restores the Rajan record", () => {
    let selected: string | null = RAMESHWAR.value;
    expect(blur(selected, "SSBL").value).toBe(RAMESHWAR.value);
    selected = RAJAN.value;
    expect(blur(selected, "SSBL").value).toBe(RAJAN.value);
  });

  it("survives repeated blurs without drifting", () => {
    let value: string | null = RAMESHWAR.value;
    for (let i = 0; i < 5; i++) {
      const r = blur(value, "SSBL");
      value = r.value;
      expect(value).toBe(RAMESHWAR.value);
    }
  });
});

describe("type-ahead still resolves text that has no selection behind it", () => {
  it("selects by an exact typed label when nothing is selected", () => {
    const r = blur(null, "VRL LOGISTICS");
    expect(r.value).toBe(OTHER.value);
    expect(r.changed).toBe(true);
  });

  it("is case-insensitive", () => {
    expect(blur(null, "vrl logistics").value).toBe(OTHER.value);
  });

  it("moves off the current selection when a different name is typed", () => {
    const r = blur(RAJAN.value, "VRL LOGISTICS");
    expect(r.value).toBe(OTHER.value);
    expect(r.changed).toBe(true);
  });

  it("picks the first match for an ambiguous name with nothing selected", () => {
    // no selection to preserve, so first-match is the only available answer;
    // the list's owner meta is what lets the user disambiguate deliberately
    expect(blur(null, "SSBL").value).toBe(RAJAN.value);
  });
});

describe("clearing and unmatched text", () => {
  it("an emptied box clears the selection", () => {
    const r = blur(RAMESHWAR.value, "");
    expect(r.value).toBeNull();
    expect(r.changed).toBe(true);
  });

  it("an already-empty box stays empty without reporting a change", () => {
    expect(blur(null, "   ")).toEqual({ value: null, text: "", changed: false });
  });

  it("unmatched text reverts the display and keeps the selection", () => {
    const r = blur(RAMESHWAR.value, "SSB");
    expect(r.value).toBe(RAMESHWAR.value);
    expect(r.text).toBe("SSBL");
    expect(r.changed).toBe(false);
  });

  it("unmatched text with no selection leaves the field empty", () => {
    const r = blur(null, "NOT A BROKER");
    expect(r.value).toBeNull();
    expect(r.text).toBe("");
  });

  it("keeps a selection whose option has since disappeared from the list", () => {
    const r = resolveOnBlur({ text: "SSBL", value: "broker-deleted", options: OPTIONS });
    // no option to confirm against, so the exact-label path applies
    expect(r.value).toBe(RAJAN.value);
  });
});
