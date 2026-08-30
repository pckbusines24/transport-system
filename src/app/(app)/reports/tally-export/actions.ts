"use server";

import { z } from "zod";
import { requireSession } from "@/lib/session";
import { withTenant } from "@/lib/db";
import { authorize } from "@/lib/authz";
import { audit } from "@/lib/audit";
import { buildMastersXml, buildVouchersXml, voucherHash } from "@/lib/tally";
import { buildModuleDocs, type TallyModule } from "./build";

const moduleSchema = z.enum(["CHALAN", "BILLING", "SLIP", "VOUCHERS", "EXPENSES", "OFFICE"]);

const exportSchema = z.object({
  module: moduleSchema,
  dateFrom: z.string().nullish(), // ISO yyyy-mm-dd
  dateTo: z.string().nullish(),
  docIds: z.array(z.string()).min(1, "Select at least one document"),
  /** false (default): only NEW / CHANGED vouchers; true: everything selected */
  includeExported: z.boolean().default(false),
});

const toRange = (from?: string | null, to?: string | null) => ({
  dateFrom: from ? new Date(`${from}T00:00:00`) : null,
  dateTo: to ? new Date(`${to}T23:59:59`) : null,
});

/**
 * Generate the Tally vouchers XML for the selected documents of one module
 * and stamp the export register (firm+key → content hash) so the next run
 * skips unchanged vouchers.
 */
export async function runTallyExport(
  input: unknown
): Promise<
  | { ok: true; xml: string; fileName: string; exported: number; skipped: number }
  | { ok: false; error: string }
> {
  const session = requireSession();
  const parsed = exportSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid input" };
  }
  const data = parsed.data;
  await authorize(session, "tally", "export");

  try {
    return await withTenant(session.tenantId, async (tx) => {
      const { docs } = await buildModuleDocs(
        tx,
        session,
        data.module as TallyModule,
        toRange(data.dateFrom, data.dateTo)
      );
      const wanted = docs.filter((d) => data.docIds.includes(d.id));
      const keys = wanted.flatMap((d) => d.vouchers.map((v) => v.key));
      const registry = new Map(
        (
          await tx.tallyExportEntry.findMany({
            where: { firmId: session.firmId, key: { in: keys } },
          })
        ).map((r) => [r.key, r.hash])
      );

      const out: (typeof wanted)[number]["vouchers"] = [];
      let skipped = 0;
      for (const d of wanted) {
        for (const raw of d.vouchers) {
          // Tally's VOUCHERNUMBER carries the SOURCE document's own number
          // (chalan no / invoice no / voucher no) so Tally never assigns a
          // manual number of its own
          const v = { ...raw, voucherNo: raw.voucherNo ?? d.refNo };
          const hash = voucherHash(v);
          const prev = registry.get(v.key);
          if (!data.includeExported && prev === hash) {
            skipped += 1; // unchanged and already in Tally — never send twice
            continue;
          }
          out.push(v);
          await tx.tallyExportEntry.upsert({
            where: { firmId_key: { firmId: session.firmId, key: v.key } },
            create: { tenantId: session.tenantId, firmId: session.firmId, key: v.key, hash },
            update: { hash, exportedAt: new Date() },
          });
        }
      }
      if (out.length === 0) {
        return {
          ok: false as const,
          error:
            "Everything is already exported — nothing new found. (For a full re-export, tick 'include already exported'.)",
        };
      }
      await audit(tx, session, {
        entity: "TallyExport",
        entityId: session.firmId,
        action: "CREATE",
        after: { module: data.module, vouchers: out.length, skipped },
      });
      const range = [data.dateFrom, data.dateTo].filter(Boolean).join("_to_") || "all";
      return {
        ok: true as const,
        xml: buildVouchersXml(out),
        fileName: `tally-${data.module.toLowerCase()}-${range}.xml`,
        exported: out.length,
        skipped,
      };
    });
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Export failed" };
  }
}

/** Party ledger masters for the module's documents — first-time import. */
export async function runTallyMasters(
  input: unknown
): Promise<{ ok: true; xml: string; fileName: string; count: number } | { ok: false; error: string }> {
  const session = requireSession();
  const parsed = z
    .object({ module: moduleSchema, dateFrom: z.string().nullish(), dateTo: z.string().nullish() })
    .safeParse(input);
  if (!parsed.success) return { ok: false, error: "Invalid input" };
  await authorize(session, "tally", "export");
  try {
    return await withTenant(session.tenantId, async (tx) => {
      const { masters } = await buildModuleDocs(
        tx,
        session,
        parsed.data.module as TallyModule,
        toRange(parsed.data.dateFrom, parsed.data.dateTo)
      );
      if (!masters.length) {
        return { ok: false as const, error: "No party found in this period." };
      }
      return {
        ok: true as const,
        xml: buildMastersXml(masters),
        fileName: `tally-masters-${parsed.data.module.toLowerCase()}.xml`,
        count: masters.length,
      };
    });
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Masters export failed" };
  }
}
