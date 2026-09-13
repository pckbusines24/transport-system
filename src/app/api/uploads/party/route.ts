import { NextRequest, NextResponse } from "next/server";
import { requireSession } from "@/lib/session";
import { buildKey, contentTypeFor, storage } from "@/lib/storage";

export const runtime = "nodejs";

// KYC copies are small scans: a PDF under 1 MB is plenty for a PAN card or a
// signed declaration, and the cap keeps object storage from filling with
// phone-camera dumps
const MAX_SIZE = 1 * 1024 * 1024; // 1 MB

/** Upload target for party KYC copies (PAN card, TDS declaration): PDF only, max 1 MB. */
export async function POST(req: NextRequest) {
  let session;
  try {
    session = requireSession();
  } catch {
    return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  }

  const form = await req.formData();
  const file = form.get("file");
  if (!(file instanceof File)) {
    return NextResponse.json({ ok: false, error: "No file provided" }, { status: 400 });
  }

  const isPdf =
    file.type === "application/pdf" || (file.name.split(".").pop() ?? "").toLowerCase() === "pdf";
  if (!isPdf) {
    return NextResponse.json({ ok: false, error: "Only PDF files are allowed" }, { status: 400 });
  }
  if (file.size > MAX_SIZE) {
    return NextResponse.json(
      { ok: false, error: `File too large (max 1 MB, received ${(file.size / 1048576).toFixed(2)} MB)` },
      { status: 400 }
    );
  }

  // object storage (S3-compatible) via the shared driver, under the tenant prefix
  const key = buildKey(session.tenantId, "party", "pdf");
  await storage().put(key, Buffer.from(await file.arrayBuffer()), contentTypeFor(key));

  return NextResponse.json({ ok: true, path: key, name: file.name, size: file.size });
}
