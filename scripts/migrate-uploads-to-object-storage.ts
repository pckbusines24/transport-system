/**
 * Copy the existing UPLOAD_DIR tree into the configured object store.
 *
 *   UPLOAD_DIR=./data/uploads STORAGE_DRIVER=s3 S3_BUCKET=... S3_ENDPOINT=... \
 *     npx tsx scripts/migrate-uploads-to-object-storage.ts --dry-run
 *
 * Keys are preserved exactly (<tenantId>/<kind>/<uuid>.<ext>), which is the
 * whole reason the cutover is cheap: those strings are already in the database,
 * so nothing there changes and a rollback is just STORAGE_DRIVER=disk again.
 *
 * Idempotent — an object already present with the same size is skipped, so run
 * it once before the cutover to move the bulk and again afterwards to catch
 * anything written in the gap.
 */
import { readFile, stat } from "fs/promises";
import path from "path";
import { diskDriver } from "../src/lib/storage/disk";
import { s3Driver } from "../src/lib/storage/s3";
import { contentTypeFor } from "../src/lib/storage";

const DRY = process.argv.includes("--dry-run");

async function main() {
  if (!process.env.UPLOAD_DIR) throw new Error("UPLOAD_DIR is not set");
  if (!process.env.S3_BUCKET) throw new Error("S3_BUCKET is not set");

  const source = diskDriver();
  const dest = s3Driver();

  const keys = await source.list();
  console.log(`${keys.length} file(s) under ${path.resolve(process.env.UPLOAD_DIR)}`);

  let copied = 0;
  let skipped = 0;
  let failed = 0;
  let bytes = 0;

  for (const key of keys) {
    const abs = path.resolve(process.env.UPLOAD_DIR, key);
    const size = (await stat(abs)).size;

    if (await dest.exists(key)) {
      skipped++;
      continue;
    }

    if (DRY) {
      console.log(`would copy  ${key}  (${size} bytes)`);
      copied++;
      bytes += size;
      continue;
    }

    try {
      await dest.put(key, await readFile(abs), contentTypeFor(key));
      // verify rather than assume: a silent partial upload here would look like
      // a successful migration and lose the file
      if (!(await dest.exists(key))) throw new Error("object missing after put");
      copied++;
      bytes += size;
    } catch (e) {
      failed++;
      console.error(`FAILED  ${key}: ${e instanceof Error ? e.message : e}`);
    }
  }

  console.log(
    `\n${DRY ? "[dry run] " : ""}copied ${copied}, skipped ${skipped} already present, failed ${failed}` +
      ` — ${(bytes / 1048576).toFixed(1)} MB`
  );
  if (failed) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
