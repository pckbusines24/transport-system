/**
 * Validate the environment before deploying, without printing any secret.
 *
 *   npx tsx scripts/check-env.ts
 *
 * Checks, in order of how expensive the mistake is to discover later:
 *   1. every required variable is present
 *   2. the connection strings have the right SHAPE — the pooled URL carries
 *      pgbouncer=true, the direct URL does not go through the pool, both
 *      require TLS. Getting this wrong produces intermittent failures under
 *      load rather than an obvious error at boot, which is far worse.
 *   3. both database URLs actually connect, and the pooled one survives the
 *      repeated round-trips that break a mis-flagged PgBouncer setup
 *   4. object storage accepts a write, read and delete
 *
 * Output is pass/fail plus hosts. Passwords, keys and secrets are never
 * printed, so this is safe to run in a shared terminal or paste into a ticket.
 */
import { PrismaClient } from "@prisma/client";

const REQUIRED = [
  "DATABASE_URL",
  "DIRECT_DATABASE_URL",
  "AUTH_SECRET",
  "STORAGE_DRIVER",
] as const;

const REQUIRED_IF_S3 = [
  "S3_BUCKET",
  "S3_ENDPOINT",
  "S3_REGION",
  "S3_ACCESS_KEY_ID",
  "S3_SECRET_ACCESS_KEY",
] as const;

let failures = 0;
const ok = (m: string) => console.log(`  PASS  ${m}`);
const bad = (m: string) => {
  failures++;
  console.log(`  FAIL  ${m}`);
};
const warn = (m: string) => console.log(`  WARN  ${m}`);

/** host:port/database — never the credentials. */
function describe(url: string): string {
  try {
    const u = new URL(url);
    return `${u.hostname}:${u.port || "5432"}${u.pathname}`;
  } catch {
    return "<unparseable>";
  }
}

function checkPresence() {
  console.log("\n1. required variables");
  for (const k of REQUIRED) {
    if (process.env[k]) ok(k);
    else bad(`${k} is not set`);
  }
  if (process.env.STORAGE_DRIVER === "s3") {
    for (const k of REQUIRED_IF_S3) {
      if (process.env[k]) ok(k);
      else bad(`${k} is not set (required when STORAGE_DRIVER=s3)`);
    }
    if (process.env.UPLOAD_DIR) {
      warn("UPLOAD_DIR is set but STORAGE_DRIVER=s3 — it is ignored; remove it to avoid confusion");
    }
  } else {
    warn(`STORAGE_DRIVER is "${process.env.STORAGE_DRIVER}" — uploads go to the local disk, which is ephemeral on App Platform`);
  }
  if ((process.env.AUTH_SECRET ?? "").length < 32) {
    bad("AUTH_SECRET is shorter than 32 characters");
  }
}

function checkShapes() {
  console.log("\n2. connection string shape");
  const pooled = process.env.DATABASE_URL ?? "";
  const direct = process.env.DIRECT_DATABASE_URL ?? "";

  for (const [label, url] of [
    ["DATABASE_URL", pooled],
    ["DIRECT_DATABASE_URL", direct],
  ] as const) {
    if (!url) continue;
    console.log(`        ${label} -> ${describe(url)}`);
    // a space instead of '=' is the classic paste error and silently yields a
    // URL with no sslmode at all
    if (/sslmode[^=]/.test(url) && !url.includes("sslmode=")) {
      bad(`${label}: "sslmode" is present but not as "sslmode=require" — check for a missing '='`);
    } else if (!url.includes("sslmode=require") && !url.includes("sslmode=verify")) {
      bad(`${label}: TLS is not requested (add ?sslmode=require)`);
    } else {
      ok(`${label}: TLS requested`);
    }
  }

  if (pooled && direct) {
    if (pooled.includes("pgbouncer=true")) {
      ok("DATABASE_URL: pgbouncer=true set");
    } else {
      bad(
        "DATABASE_URL: pgbouncer=true is missing. Under a transaction pooler Prisma's " +
          'prepared statements break intermittently ("prepared statement \\"s0\\" does not exist")'
      );
    }
    if (direct.includes("pgbouncer=true")) {
      bad("DIRECT_DATABASE_URL must NOT go through the pooler — migrations need a real session");
    } else {
      ok("DIRECT_DATABASE_URL: not pooled");
    }
    try {
      if (new URL(pooled).port === new URL(direct).port) {
        warn("both URLs use the same port — on DigitalOcean the pool is 25061 and direct is 25060");
      }
    } catch {
      /* shape errors already reported */
    }
    if (!/connection_limit=/.test(pooled)) {
      warn("DATABASE_URL has no connection_limit — set one so a single instance cannot exhaust the pool");
    }
  }
}

async function checkDatabase() {
  console.log("\n3. database connectivity");
  for (const [label, url] of [
    ["DIRECT_DATABASE_URL", process.env.DIRECT_DATABASE_URL],
    ["DATABASE_URL", process.env.DATABASE_URL],
  ] as const) {
    if (!url) continue;
    const prisma = new PrismaClient({ datasources: { db: { url } } });
    try {
      const rows = await prisma.$queryRawUnsafe<{ v: string }[]>("SELECT version() AS v");
      ok(`${label}: connected (${rows[0]?.v.split(" ").slice(0, 2).join(" ")})`);

      if (label === "DATABASE_URL") {
        // the failure this is really looking for only shows after several
        // round-trips on a pooled connection, not on the first query
        for (let i = 0; i < 25; i++) await prisma.$queryRawUnsafe("SELECT 1");
        ok("DATABASE_URL: 25 sequential queries survived the pooler");
      }
    } catch (e) {
      bad(`${label}: ${e instanceof Error ? e.message.split("\n")[0] : String(e)}`);
    } finally {
      await prisma.$disconnect().catch(() => {});
    }
  }
}

async function checkStorage() {
  if (process.env.STORAGE_DRIVER !== "s3") return;
  console.log("\n4. object storage");
  console.log(`        bucket ${process.env.S3_BUCKET} at ${process.env.S3_ENDPOINT}`);
  const { storage } = await import("../src/lib/storage");
  const store = storage();
  // a probe key under a reserved prefix, so it can never collide with a tenant
  const key = `__envcheck__/probe-${Date.now()}.pdf`;
  try {
    await store.put(key, Buffer.from("env check"), "application/pdf");
    ok("write accepted");
    const got = await store.get(key);
    if (got?.body.toString() === "env check") ok("read back identical");
    else bad("read back did not match what was written");
    await store.delete(key);
    if (await store.exists(key)) bad("delete did not remove the probe object");
    else ok("delete works");
  } catch (e) {
    bad(`storage: ${e instanceof Error ? e.message.split("\n")[0] : String(e)}`);
    await store.delete(key).catch(() => {});
  }
}

async function main() {
  console.log("environment check — no secret values are printed");
  checkPresence();
  checkShapes();
  await checkDatabase();
  await checkStorage();
  console.log(
    `\n${failures === 0 ? "READY — environment looks deployable" : `NOT READY — ${failures} problem(s) above`}`
  );
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
