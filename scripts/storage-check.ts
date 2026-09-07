/**
 * Storage connectivity check — run BEFORE `npm run dev` after changing the
 * S3 variables, and any time uploads "succeed" but nothing lands in the bucket.
 *
 *   npm run storage:check
 *
 * Reads .env the same way Next does (no dotenv dependency), prints which
 * driver the app will use, then — for s3 — lists the bucket, writes a probe
 * object, reads it back and deletes it. Each step reports pass or the exact
 * error, so a wrong endpoint, key or bucket name is obvious in one run.
 */
import { readFileSync } from "fs";
import path from "path";

function loadEnv(file: string) {
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    return;
  }
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq < 0) continue;
    const key = line.slice(0, eq).trim();
    let val = line.slice(eq + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'")))
      val = val.slice(1, -1);
    if (process.env[key] === undefined) process.env[key] = val;
  }
}

function mask(v: string | undefined): string {
  if (!v) return "(not set)";
  return v.length <= 8 ? "****" : `${v.slice(0, 4)}…${v.slice(-4)}`;
}

async function main() {
  loadEnv(path.join(process.cwd(), ".env"));
  const driver = process.env.STORAGE_DRIVER === "s3" ? "s3" : "disk";
  console.log(`STORAGE_DRIVER        ${process.env.STORAGE_DRIVER ?? "(not set)"}  -> app will use: ${driver}`);
  if (driver === "disk") {
    console.log(`UPLOAD_DIR            ${path.resolve(process.env.UPLOAD_DIR || "uploads")}`);
    console.log("\nFiles go to the local folder above, NOT to the bucket. Set STORAGE_DRIVER=\"s3\" in .env to use the bucket.");
    return;
  }
  console.log(`S3_BUCKET             ${process.env.S3_BUCKET ?? "(not set)"}`);
  console.log(`S3_ENDPOINT           ${process.env.S3_ENDPOINT ?? "(not set — AWS S3 assumed)"}`);
  console.log(`S3_REGION             ${process.env.S3_REGION ?? "(not set — 'auto')"}`);
  console.log(`S3_ACCESS_KEY_ID      ${mask(process.env.S3_ACCESS_KEY_ID)}`);
  console.log(`S3_SECRET_ACCESS_KEY  ${mask(process.env.S3_SECRET_ACCESS_KEY)}`);
  const missing = ["S3_BUCKET", "S3_ACCESS_KEY_ID", "S3_SECRET_ACCESS_KEY"].filter((k) => !process.env[k]);
  if (missing.length) {
    console.log(`\nFAIL  missing: ${missing.join(", ")} — fill them in .env and run again.`);
    process.exitCode = 1;
    return;
  }

  const { S3Client, ListObjectsV2Command, PutObjectCommand, HeadObjectCommand, GetObjectCommand, DeleteObjectCommand } =
    await import("@aws-sdk/client-s3");
  const client = new S3Client({
    region: process.env.S3_REGION || "auto",
    ...(process.env.S3_ENDPOINT ? { endpoint: process.env.S3_ENDPOINT } : {}),
    forcePathStyle: Boolean(process.env.S3_ENDPOINT),
    credentials: {
      accessKeyId: process.env.S3_ACCESS_KEY_ID as string,
      secretAccessKey: process.env.S3_SECRET_ACCESS_KEY as string,
    },
  });
  const Bucket = process.env.S3_BUCKET as string;
  const step = async (label: string, fn: () => Promise<string | void>) => {
    try {
      const note = await fn();
      console.log(`PASS  ${label}${note ? ` — ${note}` : ""}`);
      return true;
    } catch (e) {
      const err = e as { name?: string; message?: string; $metadata?: { httpStatusCode?: number } };
      console.log(`FAIL  ${label} — ${err.name ?? "Error"}: ${err.message ?? e}${err.$metadata?.httpStatusCode ? ` (HTTP ${err.$metadata.httpStatusCode})` : ""}`);
      process.exitCode = 1;
      return false;
    }
  };

  console.log("");
  const listed = await step("list bucket", async () => {
    const res = await client.send(new ListObjectsV2Command({ Bucket, MaxKeys: 5 }));
    const n = res.KeyCount ?? res.Contents?.length ?? 0;
    const sample = (res.Contents ?? []).map((o) => o.Key).filter(Boolean).slice(0, 3).join(", ");
    return `${res.IsTruncated ? "5+" : n} object(s)${sample ? `, e.g. ${sample}` : " — bucket is empty"}`;
  });
  if (!listed) {
    console.log("\nListing failed, so uploads from this machine cannot work either. Check the endpoint URL, the bucket name and that the token has Object Read & Write on this bucket.");
    return;
  }
  const Key = `_probe/storage-check-${Date.now()}.txt`;
  const body = `storage-check ${new Date().toISOString()}`;
  const wrote = await step(`write probe ${Key}`, async () => {
    await client.send(new PutObjectCommand({ Bucket, Key, Body: body, ContentType: "text/plain" }));
  });
  if (!wrote) return;
  await step("head probe", async () => {
    await client.send(new HeadObjectCommand({ Bucket, Key }));
  });
  await step("read probe back", async () => {
    const res = await client.send(new GetObjectCommand({ Bucket, Key }));
    const text = await res.Body?.transformToString();
    if (text !== body) throw new Error("content mismatch");
  });
  await step("delete probe", async () => {
    await client.send(new DeleteObjectCommand({ Bucket, Key }));
  });
  if (!process.exitCode) console.log("\nAll good: uploads from this machine will land in the bucket.");
}

void main();
