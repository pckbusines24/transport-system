import { describe, it, expect } from "vitest";
import { Prisma } from "@prisma/client";
import { MASTER_RULES, describeReferences, delegateName } from "./master-refs";

/**
 * The reference registry is plain data, so a typo in a model or column name
 * would not fail typecheck — it would silently make a master look unused and
 * let it be deleted. This test pins every name to the Prisma schema.
 */
const models = new Map(Prisma.dmmf.datamodel.models.map((m) => [m.name, m]));

describe("master reference registry matches the schema", () => {
  for (const [kind, rules] of Object.entries(MASTER_RULES)) {
    describe(kind, () => {
      it("is registered", () => expect(Array.isArray(rules)).toBe(true));
      for (const rule of rules) {
        it(`${rule.model}.${rule.columns.join("|")}`, () => {
          const model = models.get(rule.model);
          expect(model, `model ${rule.model} missing`).toBeDefined();
          const fields = new Set(model!.fields.map((f) => f.name));
          for (const c of rule.columns) expect(fields.has(c), `column ${c}`).toBe(true);
          if (rule.numberCol) expect(fields.has(rule.numberCol), `numberCol ${rule.numberCol}`).toBe(true);
          if (rule.soft) expect(fields.has("deletedAt"), "soft model needs deletedAt").toBe(true);
          for (const k of Object.keys(rule.extraWhere ?? {}))
            expect(fields.has(k), `extraWhere relation ${k}`).toBe(true);
          expect(delegateName(rule.model)).toMatch(/^[a-z]/);
        });
      }
    });
  }
});

describe("describeReferences", () => {
  it("lists counts with samples and an ellipsis when truncated", () => {
    expect(
      describeReferences({
        total: 9,
        groups: [
          { label: "LRs", count: 7, samples: ["1001", "1002"] },
          { label: "rates", count: 2, samples: [] },
        ],
      })
    ).toBe("7 LRs (1001, 1002, …); 2 rates");
  });
});
