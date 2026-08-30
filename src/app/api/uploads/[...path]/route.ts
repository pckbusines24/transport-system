import { NextRequest, NextResponse } from "next/server";
import { requireSession } from "@/lib/session";
import { safeTenantKey, storage } from "@/lib/storage";

export const runtime = "nodejs";

/**
 * Serve an uploaded file.
 *
 * The URL shape, the auth check and the tenant isolation are unchanged from
 * the disk-backed version — only where the bytes come from has moved. Reads
 * are proxied through this route rather than handed out as public or presigned
 * URLs, so the bucket stays entirely private and one tenant can never be given
 * a link to another's document.
 *
 * The proxy costs bandwidth. On Cloudflare R2 that egress is free, which is
 * what makes this the right trade rather than a lazy one. If the app ever
 * moves to a store that bills egress, short-TTL presigned URLs are the
 * optimisation — but they weaken the isolation story, so they should be a
 * deliberate decision, not a default.
 */
export async function GET(_req: NextRequest, { params }: { params: { path: string[] } }) {
  let session;
  try {
    session = requireSession();
  } catch {
    return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  }

  // decodes twice, rejects dot-segments, separators, NULs and empty segments,
  // and requires the key to sit under this session's own tenant prefix
  const key = safeTenantKey(params.path, session.tenantId);
  if (!key) return NextResponse.json({ ok: false, error: "Forbidden" }, { status: 403 });

  const obj = await storage().get(key);
  if (!obj) return NextResponse.json({ ok: false, error: "Not found" }, { status: 404 });

  return new NextResponse(new Uint8Array(obj.body), {
    headers: {
      "Content-Type": obj.contentType,
      "Content-Disposition": `inline; filename="${key.split("/").pop()}"`,
      "Cache-Control": "private, max-age=3600",
    },
  });
}
