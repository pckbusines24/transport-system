import { NextRequest, NextResponse } from "next/server";
import { requireSession } from "@/lib/session";
import { buildKey, contentTypeFor, storage } from "@/lib/storage";

export const runtime = "nodejs";

const MAX_SIZE = 10 * 1024 * 1024; // 10 MB maximum
const ALLOWED_EXT: Record<string, string> = {
  "application/pdf": "pdf",
  "image/jpeg": "jpg",
  "image/jpg": "jpg",
  "image/png": "png",
};

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
    (["pdf", "jpg", "jpeg", "png"].includes(
      (file.name.split(".").pop() ?? "").toLowerCase()
    )
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
      {
        ok: false,
        error: `POD file must be at most 10 MB (received ${(file.size / (1024 * 1024)).toFixed(2)} MB). Please upload a smaller file.`,
      },
      { status: 400 }
    );
  }

  // The object is stored here and its key returned; the caller writes that key
  // into the Pod row. Object first, row second — an unreferenced object is a
  // harmless orphan the sweep collects, whereas a row pointing at a file that
  // was never written is a broken document in an audit trail.
  const key = buildKey(session.tenantId, "pod", ext);
  await storage().put(key, Buffer.from(await file.arrayBuffer()), contentTypeFor(key));

  return NextResponse.json({ ok: true, path: key, size: file.size });
}
