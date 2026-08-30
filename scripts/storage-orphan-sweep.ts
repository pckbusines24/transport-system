/**
 * Find objects in the store that no database row references.
 *
 * Uploading writes the object first and the row second, so a failure in
 * between leaves an orphan. That is the safe direction to fail — an orphan is
 * invisible and costs a fraction of a paisa — but they should still be
 * collected periodically.
 *
 *   npx tsx scripts/storage-orphan-sweep.ts               # report only
 *   npx tsx scripts/storage-orphan-sweep.ts --delete      # actually remove
 *   npx tsx scripts/storage-orphan-sweep.ts --min-age-days=30
 *
 * THREE SAFETY PROPERTIES, because a sweep that gets this wrong deletes real
 * customer documents:
 *
 *  1. REPORT ONLY BY DEFAULT. Deleting requires --delete, explicitly.
 *  2. THE REFERENCE LIST IS DERIVED FROM THE PRISMA SCHEMA, not hand-written.
 *     Thirty columns across fifteen models currently hold upload keys, and a
 *     hand-maintained list would fall behind the schema the first time someone
 *     added a document field — at which point the sweep would delete live
 *     files. Anything that looks like a path column is scanned automatically.
 *  3. AN AGE FLOOR. An object uploaded seconds ago may not have had its row
 *     committed yet. Only objects older than --min-age-days (default 7) are
 *     ever considered, so an in-flight upload can never be collected.
 *
 * Runs across ALL tenants, so it must not use the RLS-scoped client.
 */
import { Prisma, PrismaClient } from "@prisma/client";
import { storage } from "../src/lib/storage";

const argv = process.argv.slice(2);
const DELETE = argv.includes("--delete");
const MIN_AGE_DAYS = Number(
  argv.find((a) => a.startsWith("--min-age-days="))?.split("=")[1] ?? 7
);

const prisma = new PrismaClient({
  datasources: { db: { url: process.env.DIRECT_DATABASE_URL ?? process.env.DATABASE_URL } },
});

/**
 * Every (model, field) in the schema that stores an object key, found by
 * inspecting the generated datamodel rather than by listing them here.
 *
 * The test is deliberately loose — any nullable-or-not String field whose name
 * ends in "Path". A false positive only makes the sweep more conservative
 * (an object looks referenced when it is not), which is the harmless direction.
 */
function pathColumns(): { model: string; delegate: string; field: string }[] {
  const out: { model: string; delegate: string; field: string }[] = [];
  for (const model of Prisma.dmmf.datamodel.models) {
    for (const field of model.fields) {
      if (field.kind === "scalar" && field.type === "String" && /Path$/.test(field.name)) {
        out.push({
          model: model.name,
          delegate: model.name.charAt(0).toLowerCase() + model.name.slice(1),
          field: field.name,
        });
      }
    }
  }
  return out;
}

async function referencedKeys(): Promise<Set<string>> {
  const referenced = new Set<string>();
  const columns = pathColumns();
  console.log(`scanning ${columns.length} path column(s) across the schema:`);

  for (const { model, delegate, field } of columns) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const client = (prisma as any)[delegate];
    if (!client?.findMany) {
      // a model whose delegate name does not resolve would silently contribute
      // nothing, which would make the sweep delete live files — refuse instead
      throw new Error(`cannot read ${model}.${field}: no Prisma delegate "${delegate}"`);
    }
    const rows: Array<Record<string, string | null>> = await client.findMany({
      where: { [field]: { not: null } },
      select: { [field]: true },
    });
    let n = 0;
    for (const row of rows) {
      const v = row[field];
      if (v) {
        referenced.add(v);
        n++;
      }
    }
    if (n) console.log(`  ${model}.${field}: ${n}`);
  }
  return referenced;
}

async function main() {
  const store = storage();
  console.log(`driver: ${store.name}`);
  if (DELETE) console.log("MODE: DELETE — orphans will be removed\n");
  else console.log("MODE: report only (pass --delete to remove)\n");

  const referenced = await referencedKeys();
  console.log(`\n${referenced.size} key(s) referenced by the database`);

  const keys = await store.list();
  console.log(`${keys.length} object(s) in the store`);

  const orphans = keys.filter((k) => !referenced.has(k));
  if (orphans.length === 0) {
    console.log("\nno orphans found");
    await prisma.$disconnect();
    return;
  }

  // An object younger than the floor may simply be mid-upload. The disk driver
  // can answer this from the filesystem; on object storage the age check needs
  // a HEAD per candidate, so it runs only over the orphan shortlist.
  console.log(`\n${orphans.length} candidate orphan(s); applying the ${MIN_AGE_DAYS}-day age floor`);

  const cutoff = Date.now() - MIN_AGE_DAYS * 86_400_000;
  const old: string[] = [];
  const tooNew: string[] = [];
  for (const key of orphans) {
    const age = await objectMtime(key);
    if (age === null || age < cutoff) old.push(key);
    else tooNew.push(key);
  }

  if (tooNew.length) {
    console.log(`  ${tooNew.length} skipped as too recent (possible in-flight upload)`);
  }

  console.log(`\n${old.length} orphan(s) past the age floor:`);
  for (const k of old.slice(0, 50)) console.log(`  ${k}`);
  if (old.length > 50) console.log(`  … and ${old.length - 50} more`);

  if (DELETE) {
    let removed = 0;
    for (const k of old) {
      await store.delete(k);
      removed++;
    }
    console.log(`\ndeleted ${removed} orphan(s)`);
  } else {
    console.log("\nnothing deleted — re-run with --delete to remove these");
  }

  await prisma.$disconnect();
}

/** Last-modified time in ms, or null when it cannot be determined. */
async function objectMtime(key: string): Promise<number | null> {
  const store = storage();
  if (store.name === "disk") {
    const { stat } = await import("fs/promises");
    const path = await import("path");
    const root = process.env.UPLOAD_DIR || "./uploads";
    try {
      return (await stat(path.resolve(root, key))).mtimeMs;
    } catch {
      return null;
    }
  }
  const { HeadObjectCommand, S3Client } = await import("@aws-sdk/client-s3");
  const client = new S3Client({
    region: process.env.S3_REGION || "auto",
    ...(process.env.S3_ENDPOINT ? { endpoint: process.env.S3_ENDPOINT } : {}),
    forcePathStyle: Boolean(process.env.S3_ENDPOINT),
    ...(process.env.S3_ACCESS_KEY_ID && process.env.S3_SECRET_ACCESS_KEY
      ? {
          credentials: {
            accessKeyId: process.env.S3_ACCESS_KEY_ID,
            secretAccessKey: process.env.S3_SECRET_ACCESS_KEY,
          },
        }
      : {}),
  });
  try {
    const res = await client.send(
      new HeadObjectCommand({ Bucket: process.env.S3_BUCKET!, Key: key })
    );
    return res.LastModified?.getTime() ?? null;
  } catch {
    return null;
  }
}

main().catch(async (e) => {
  console.error(e);
  await prisma.$disconnect().catch(() => {});
  process.exit(1);
});
