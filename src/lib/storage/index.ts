import path from "path";
import { randomUUID } from "crypto";
import type { StorageDriver } from "./driver";
import { diskDriver } from "./disk";
import { s3Driver } from "./s3";

export type { StorageDriver, StoredObject } from "./driver";

/**
 * Uploaded-file storage.
 *
 * One interface, two drivers, chosen by STORAGE_DRIVER:
 *
 *   disk  (default)  files under UPLOAD_DIR — exactly today's behaviour
 *   s3               any S3-compatible object store: Cloudflare R2, AWS S3,
 *                    DigitalOcean Spaces, MinIO
 *
 * The flag is explicit rather than inferred from whether a bucket is
 * configured, because the cutover wants to be a deliberate, reversible switch:
 * set it to `s3`, and if anything looks wrong set it back to `disk` without a
 * redeploy of different code.
 *
 * THE KEY FORMAT IS THE CONTRACT. Keys are `<tenantId>/<kind>/<uuid>.<ext>` —
 * the same strings already stored in Pod.filePath, Firm.logoPath and the
 * document register. Identical under both drivers, so migrating is a byte copy
 * with no database change, and rolling back needs no data conversion.
 */

let cached: StorageDriver | null = null;

export function storage(): StorageDriver {
  if (!cached) {
    cached = process.env.STORAGE_DRIVER === "s3" ? s3Driver() : diskDriver();
  }
  return cached;
}

/** Test seam — lets a test swap the driver without touching module state. */
export function __setStorageForTests(driver: StorageDriver | null): void {
  cached = driver;
}

export const CONTENT_TYPES: Record<string, string> = {
  ".pdf": "application/pdf",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  // the firm logo/seal upload accepts webp, so serving has to know it too —
  // without this it went out as octet-stream and no browser rendered it
  ".webp": "image/webp",
};

export function contentTypeFor(key: string): string {
  return CONTENT_TYPES[path.extname(key).toLowerCase()] ?? "application/octet-stream";
}

export function buildKey(tenantId: string, kind: string, ext: string): string {
  return `${tenantId}/${kind}/${randomUUID()}.${ext}`;
}

/**
 * Validate a caller-supplied key before it is used for anything.
 *
 * This is the hardening the disk-backed serving route already did, kept
 * verbatim in behaviour because it is still exactly as necessary. On object
 * storage a `..` cannot escape a bucket the way it escapes a directory — but
 * it CAN address another tenant's prefix, and that is the attack that matters
 * in a multi-tenant system.
 *
 * Returns the normalised key, or null if the caller must be refused.
 */
export function safeTenantKey(segments: string[], tenantId: string): string | null {
  const clean: string[] = [];
  for (const raw of segments) {
    let seg = raw;
    try {
      // decode twice, to catch a double-encoded separator or dot-segment
      for (let i = 0; i < 2; i++) seg = decodeURIComponent(seg);
    } catch {
      return null;
    }
    if (
      !seg ||
      seg === "." ||
      seg === ".." ||
      seg.includes("/") ||
      seg.includes("\\") ||
      seg.includes("\0")
    ) {
      return null;
    }
    clean.push(seg);
  }
  // tenant isolation: a key must live under the session tenant's own prefix
  if (clean[0] !== tenantId) return null;
  return clean.join("/");
}

/**
 * Store an object, then run `persist` to record its key in the database.
 *
 * The ordering rule, and why it is this way round:
 *
 *   object first, row second. If the row write fails we are left with an
 *   object nobody references — invisible, costs a fraction of a paisa, and the
 *   orphan sweep collects it later. If we wrote the row first and the upload
 *   failed, we would have a POD record pointing at a file that does not exist:
 *   a broken document in a financial audit trail, discovered months later by
 *   whoever needed it most.
 *
 * So: never delete an object before its row is gone, and always prefer a
 * harmless orphan to a dangling reference.
 */
export async function putThenPersist<T>(
  key: string,
  body: Buffer,
  contentType: string,
  persist: () => Promise<T>
): Promise<T> {
  const store = storage();
  await store.put(key, body, contentType);
  try {
    return await persist();
  } catch (err) {
    // best effort only: if this delete also fails the object simply becomes an
    // orphan, which the sweep handles. Never let cleanup mask the real error.
    try {
      await store.delete(key);
    } catch {
      /* swallowed on purpose — the original failure is what the caller needs */
    }
    throw err;
  }
}
