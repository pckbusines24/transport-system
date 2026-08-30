import { NextRequest, NextResponse } from "next/server";
import { requireSession } from "@/lib/session";
import { buildKey, contentTypeFor, storage } from "@/lib/storage";

export const runtime = "nodejs";

const MAX_SIZE = 10 * 1024 * 1024; // 10 MB
const ALLOWED_EXT: Record<string, string> = {
  "application/pdf": "pdf",
  "image/jpeg": "jpg",
  "image/jpg": "jpg",
  "image/png": "png",
};

/** Upload target for Document Registration files (pdf/jpg/png, max 10 MB). */
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

  const ext =
    ALLOWED_EXT[file.type] ??
    (["pdf", "jpg", "jpeg", "png"].includes((file.name.split(".").pop() ?? "").toLowerCase())
      ? (file.name.split(".").pop() as string).toLowerCase().replace("jpeg", "jpg")
      : null);
  if (!ext) {
    return NextResponse.json(
      { ok: false, error: "Only PDF, JPG or PNG files are allowed" },
      { status: 400 }
    );
  }
  if (file.size > MAX_SIZE) {
    return NextResponse.json(
      { ok: false, error: `File too large (max 10 MB, received ${(file.size / 1048576).toFixed(1)} MB)` },
      { status: 400 }
    );
  }

  const key = buildKey(session.tenantId, "docreg", ext);
  await storage().put(key, Buffer.from(await file.arrayBuffer()), contentTypeFor(key));

  return NextResponse.json({ ok: true, path: key, name: file.name, size: file.size });
}
