import { NextRequest, NextResponse } from "next/server";
import path from "path";
import { requireSession } from "@/lib/session";
import { safeTenantKey, storage } from "@/lib/storage";
import { withTenant } from "@/lib/db";
import { authorize } from "@/lib/authz";
import { audit } from "@/lib/audit";

export const runtime = "nodejs";

const MAX_SIZE = 2 * 1024 * 1024; // 2 MB max for logo/seal images
const ALLOWED_EXT: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/jpg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
};

/** content types for pre-move rows, whose mime was never recorded */
const LEGACY_TYPES: Record<string, string> = {
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".webp": "image/webp",
};

/**
 * POST multipart: { file, kind: "logo" | "seal" }
 * Stores the bytes on the Firm row itself; Firm.logoPath / sealPath remain only
 * for reading uploads made before that change.
 * Serving is handled by the shared /api/uploads/[...path] route.
 */
export async function POST(req: NextRequest) {
  let session;
  try {
    session = requireSession();
  } catch {
    return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  }

  try {
    await authorize(session, "settings", "edit");
  } catch {
    return NextResponse.json({ ok: false, error: "Forbidden" }, { status: 403 });
  }

  const form = await req.formData();
  const file = form.get("file");
  const kind = form.get("kind");
  if (!(file instanceof File)) {
    return NextResponse.json({ ok: false, error: "No file provided" }, { status: 400 });
  }
  if (kind !== "logo" && kind !== "seal") {
    return NextResponse.json({ ok: false, error: "kind must be 'logo' or 'seal'" }, { status: 400 });
  }

  const ext = ALLOWED_EXT[file.type];
  if (!ext) {
    return NextResponse.json(
      { ok: false, error: "Only JPG, PNG or WEBP images are allowed" },
      { status: 400 }
    );
  }
  if (file.size > MAX_SIZE) {
    return NextResponse.json(
      { ok: false, error: "Image must be smaller than 2 MB" },
      { status: 400 }
    );
  }

  // Stored in the database, not on disk. Two images per firm, capped at 2 MB
  // each, is well within what a row can carry — and unlike a file it survives a
  // redeploy on a host with no persistent volume.
  const bytes = Buffer.from(await file.arrayBuffer());

  const version = await withTenant(session.tenantId, async (tx) => {
    const before = await tx.firm.findUniqueOrThrow({ where: { id: session.firmId } });
    const after = await tx.firm.update({
      where: { id: session.firmId },
      data: {
        ...(kind === "logo"
          ? { logoData: bytes, logoMime: file.type, logoPath: null }
          : { sealData: bytes, sealMime: file.type, sealPath: null }),
        // the URL is stable, so without this the browser would keep showing the
        // previous image from cache after a re-upload
        brandingVersion: { increment: 1 },
      },
    });
    await audit(tx, session, {
      entity: "Firm",
      entityId: session.firmId,
      action: "UPDATE",
      // never audit the image bytes themselves — only that they changed
      before: { [`${kind}Mime`]: kind === "logo" ? before.logoMime : before.sealMime },
      after: { [`${kind}Mime`]: kind === "logo" ? after.logoMime : after.sealMime },
    });
    return after.brandingVersion;
  });

  return NextResponse.json({ ok: true, url: `/api/uploads/firm?kind=${kind}&v=${version}` });
}

/**
 * GET ?kind=logo|seal — the current firm's branding image.
 *
 * Scoped to the session's firm rather than taking an id, so one tenant can
 * never address another's. Falls back to the file on disk for rows written
 * before the move, which is the only way a pre-existing logo keeps working.
 */
export async function GET(req: NextRequest) {
  let session;
  try {
    session = requireSession();
  } catch {
    return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  }

  const kind = req.nextUrl.searchParams.get("kind");
  if (kind !== "logo" && kind !== "seal") {
    return NextResponse.json({ ok: false, error: "kind must be 'logo' or 'seal'" }, { status: 400 });
  }

  const firm = await withTenant(session.tenantId, (tx) =>
    tx.firm.findUnique({ where: { id: session.firmId } })
  );
  if (!firm) return NextResponse.json({ ok: false, error: "Not found" }, { status: 404 });

  const data = kind === "logo" ? firm.logoData : firm.sealData;
  const mime = (kind === "logo" ? firm.logoMime : firm.sealMime) ?? "application/octet-stream";
  const legacyPath = kind === "logo" ? firm.logoPath : firm.sealPath;

  let body: Buffer | null = data ? Buffer.from(data) : null;
  let contentType = mime;

  if (!body && legacyPath) {
    // uploads made before logo/seal bytes moved onto the Firm row. legacyPath
    // comes from this firm's own record, but it is still a stored string, so
    // it goes through the same validation as any caller-supplied key.
    const key = safeTenantKey(legacyPath.split("/"), session.tenantId);
    if (key) {
      const legacy = await storage().get(key);
      if (legacy) {
        body = legacy.body;
        contentType = LEGACY_TYPES[path.extname(key).toLowerCase()] ?? contentType;
      }
      // otherwise the file is gone — the usual case, and why this moved into the DB
    }
  }

  if (!body) return NextResponse.json({ ok: false, error: "Not found" }, { status: 404 });

  return new NextResponse(new Uint8Array(body), {
    headers: {
      "Content-Type": contentType,
      // the ?v= query changes on every upload, so this can be cached hard
      "Cache-Control": "private, max-age=86400",
    },
  });
}
