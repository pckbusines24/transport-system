import { NextResponse } from "next/server";
import { requireSession } from "@/lib/session";
import { storage } from "@/lib/storage";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/uploads/status — which file store is THIS deployment using, and
 * does it actually work? Admin / Owner only.
 *
 * Exists because a missing STORAGE_DRIVER on the host silently falls back to
 * the disk driver: uploads "succeed" into the container's throwaway
 * filesystem and the bucket stays empty. Open this URL on the live site and
 * the answer is immediate, no console access needed.
 */
export async function GET() {
  let session;
  try {
    session = requireSession();
  } catch {
    return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  }
  if (session.role !== "ADMIN" && session.role !== "OWNER") {
    return NextResponse.json({ ok: false, error: "Forbidden" }, { status: 403 });
  }

  const store = storage();
  const endpoint = process.env.S3_ENDPOINT;
  let endpointHost: string | null = null;
  try {
    endpointHost = endpoint ? new URL(endpoint).host : null;
  } catch {
    endpointHost = "(invalid URL)";
  }

  const config = {
    driver: store.name,
    STORAGE_DRIVER: process.env.STORAGE_DRIVER ?? null,
    bucket: process.env.S3_BUCKET ?? null,
    endpointHost,
    region: process.env.S3_REGION ?? null,
    hasAccessKey: Boolean(process.env.S3_ACCESS_KEY_ID),
    hasSecretKey: Boolean(process.env.S3_SECRET_ACCESS_KEY),
    uploadDir: store.name === "disk" ? (process.env.UPLOAD_DIR ?? "uploads") : null,
  };

  // live probe inside this tenant's own prefix — never touches real documents
  const probe: Record<string, string> = {};
  const tenantPrefix = `${session.tenantId}/`;
  try {
    const keys = await store.list(tenantPrefix);
    probe.list = `ok — ${keys.length} object(s) under this tenant`;
  } catch (e) {
    probe.list = `FAIL — ${e instanceof Error ? e.message : String(e)}`;
  }
  const key = `${session.tenantId}/_probe/status-${Date.now()}.txt`;
  try {
    await store.put(key, Buffer.from("status probe"), "text/plain");
    probe.write = "ok";
    probe.readBack = (await store.exists(key)) ? "ok" : "FAIL — written object not found";
    await store.delete(key);
    probe.delete = "ok";
  } catch (e) {
    probe.write = `FAIL — ${e instanceof Error ? e.message : String(e)}`;
  }

  const healthy = Object.values(probe).every((v) => v.startsWith("ok"));
  return NextResponse.json({
    ok: healthy,
    ...config,
    probe,
    hint:
      store.name === "disk"
        ? "Files are written to the local disk of this server. On App Platform that disk is discarded on every deploy — set STORAGE_DRIVER=s3 and the S3_* variables."
        : healthy
          ? "Uploads from this deployment land in the bucket."
          : "The bucket is configured but not reachable — check endpoint, bucket name and token permissions.",
  });
}
