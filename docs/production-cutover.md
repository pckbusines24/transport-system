# Production cutover — Render/Supabase → DigitalOcean + Cloudflare R2

Runbook for the stack chosen in `production-deployment-plan.md` (Plan A).

| Layer | Service | Region |
|---|---|---|
| App | DO App Platform, `apps-s-1vcpu-1gb` | Bangalore (BLR1) |
| Database | DO Managed PostgreSQL | Bangalore (BLR1) |
| Files | Cloudflare R2, bucket `transport-tms-uploads` | — |

Expect **~$27/month (≈₹27,200/yr)**. No custom domain: the app answers on its
generated `*.ondigitalocean.app` hostname with DO-managed TLS.

---

## 0. Two things settled before you start

**There are no files to migrate.** Uploaded files are only reachable through a
database row, and the production database held **zero rows in every table**
before it was seeded. The pre-existing `render.yaml` also pointed
`UPLOAD_DIR` at `/tmp/uploads`, which Render wipes on every redeploy — so
nothing durable was ever written. **Task 3 of the plan is a no-op**: set
`STORAGE_DRIVER=s3` and the first upload lands in R2. Verify with step 8.4
rather than taking this on trust.

**The app is 375 MB resident at idle** (measured with `next start`). The
0.5 GB instance would leave ~140 MB of headroom, which will not survive a
report render. `apps-s-1vcpu-1gb` is the floor. Builds are unaffected —
App Platform gives every build 4 vCPU / 10 GiB regardless of instance size,
and this app peaks at 1.8 GB.

---

## 1. Merge the deployment branch

```bash
git checkout main && git pull
git merge --no-ff feat/production-deployment
git push origin main
```

`main` already carries the performance work, the Hinglish→English pass and the
design system. `feat/production-deployment` adds the storage layer, `app.yaml`
and the `output: "standalone"` removal.

Once App Platform is connected with `deploy_on_push: true`, this push is what
triggers the first deploy — so do steps 2–7 **before** merging, or the first
build will run without its environment.

---

## 2. Cloudflare R2

1. R2 → **Create bucket** → `transport-tms-uploads`. Keep it **private**.
2. **Manage R2 API Tokens** → create a token with **Object Read & Write**
   scoped to that bucket.
3. Take the **Access Key ID** and **Secret Access Key**.
   Not the *Token Value* — that authenticates R2's REST API and Workers
   bindings, and an S3 client cannot use it.
4. Endpoint: `https://<ACCOUNT_ID>.r2.cloudflarestorage.com`. Use a
   jurisdiction endpoint (`.eu.`, `.fedramp.`) **only** if you deliberately
   created the bucket in that jurisdiction — there is no India jurisdiction, so
   the default is correct here.
5. Later, once real documents exist: enable **object versioning** and a
   lifecycle rule expiring noncurrent versions, so an accidental delete is
   recoverable.

---

## 3. DO Managed PostgreSQL (BLR1)

1. **Databases → Create Database Cluster** → PostgreSQL 16 → **Bangalore
   (BLR1)** → smallest Basic node (1 GB / 1 vCPU).
2. **Connection Pools** tab → create a pool, mode **Transaction**, over the
   application database.
3. Collect two connection strings — they are **not** interchangeable:

   | Use | Source | Suffix to append |
   |---|---|---|
   | `DATABASE_URL` | the **pool** (port 25061) | `?sslmode=require&pgbouncer=true&connection_limit=10` |
   | `DIRECT_DATABASE_URL` | **direct** (port 25060) | `?sslmode=require` |

   `pgbouncer=true` is not optional. PgBouncer in transaction mode does not
   hold prepared statements between statements, and without the flag Prisma
   will fail intermittently with `prepared statement "s0" does not exist` —
   the same failure this app already hit on Supabase's pooler. Migrations need
   a real session, which is why they use the direct URL.

4. Confirm **automatic daily backups** are on (default; PITR included).

5. **Create a restricted role for the application.** This step is not optional.

   DO's `doadmin` has `rolbypassrls = true`, and `BYPASSRLS` overrides even
   `FORCE ROW LEVEL SECURITY`. Connecting the app as `doadmin` means every
   `tenant_isolation` policy in the schema is silently skipped — the app's own
   `where` clauses would be the only thing separating tenants, and RLS would be
   decorative. Verified against this cluster: as `doadmin`, a query scoped to a
   nonexistent tenant still returned another tenant's rows.

   Connected as `doadmin` on the DIRECT url:

   ```sql
   CREATE ROLE tms_app LOGIN PASSWORD '<generated>';
   GRANT CONNECT ON DATABASE defaultdb TO tms_app;
   GRANT USAGE ON SCHEMA public TO tms_app;
   GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO tms_app;
   GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO tms_app;
   -- migrations run as doadmin, so future tables need this or the app breaks
   -- the next time a migration adds one
   ALTER DEFAULT PRIVILEGES FOR ROLE doadmin IN SCHEMA public
     GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO tms_app;
   ALTER DEFAULT PRIVILEGES FOR ROLE doadmin IN SCHEMA public
     GRANT USAGE, SELECT ON SEQUENCES TO tms_app;
   ```

   The role defaults are already `NOSUPERUSER NOBYPASSRLS`, which is the point.
   `doadmin` cannot set `NOSUPERUSER` explicitly (it is not a superuser itself),
   and does not need to.

6. **Bind the connection pool to `tms_app`.** A DigitalOcean pool belongs to one
   user, so a pool created for `doadmin` will keep connecting as `doadmin`
   whatever the URL says. Either re-point the existing pool at `tms_app` or
   create a second pool for it, then use that pool name in `DATABASE_URL`.

   Split of responsibilities afterwards:

   | URL | Role | Why |
   |---|---|---|
   | `DATABASE_URL` (pooled) | `tms_app` | request traffic — RLS must apply |
   | `DIRECT_DATABASE_URL` | `doadmin` | migrations need CREATE; seed and orphan sweep are deliberately cross-tenant |

   Confirm it took effect:

   ```
   npx tsx scripts/check-env.ts
   ```

   Expected once correct: reading as a bogus tenant returns 0 rows, and a
   cross-tenant INSERT is refused by `WITH CHECK`.

---

## 4. Migrate the database from Supabase

Run locally. Use Supabase's **session pooler** as the source — the
`db.<ref>.supabase.co` direct host is IPv6-only and will fail from most
networks.

```bash
# 1. dump
pg_dump "$SUPABASE_SESSION_POOLER_URL" \
  --no-owner --no-privileges -Fc -f supabase.dump

# 2. restore into DO (DIRECT url, not the pool)
pg_restore --no-owner --no-privileges --clean --if-exists \
  -d "$DO_DIRECT_URL" supabase.dump

# 3. bring the schema to the latest migration
DIRECT_DATABASE_URL="$DO_DIRECT_URL" npx prisma migrate deploy
```

Verify before cutting over:

```bash
DIRECT_DATABASE_URL="$DO_DIRECT_URL" npx tsx -e '
const { PrismaClient } = require("@prisma/client");
const p = new PrismaClient({ datasources: { db: { url: process.env.DIRECT_DATABASE_URL } } });
(async () => {
  for (const m of ["tenant","firm","user","party","vehicle","lr","chalan","invoice","voucher"])
    console.log(m, await p[m].count());
  await p.$disconnect();
})();'
```

Compare against the same counts on Supabase. They must match exactly.

---

## 5. Create the app

**Apps → Create App** → GitHub → this repo → branch `main` → Autodeploy on.

Or apply the spec, which encodes everything already:

```bash
doctl apps create --spec app.yaml
```

Confirm: region **blr1**, build `npm ci && npm run build`, run `npm start`,
size `apps-s-1vcpu-1gb`, health check `/login`.

---

## 6. Environment variables

App → Settings → App-Level Environment Variables. Mark every credential
**SECRET** (encrypted at rest, hidden after saving).

| Key | Value |
|---|---|
| `NODE_VERSION` | `20.12.2` |
| `DATABASE_URL` | DO **pooled** string + `?sslmode=require&pgbouncer=true&connection_limit=10` |
| `DIRECT_DATABASE_URL` | DO **direct** string + `?sslmode=require` |
| `AUTH_SECRET` | your generated secret — a fresh one, not the Supabase-era value |
| `STORAGE_DRIVER` | `s3` |
| `S3_BUCKET` | `transport-tms-uploads` |
| `S3_ENDPOINT` | `https://<ACCOUNT_ID>.r2.cloudflarestorage.com` |
| `S3_REGION` | `auto` |
| `S3_ACCESS_KEY_ID` | from step 2 |
| `S3_SECRET_ACCESS_KEY` | from step 2 |
| `NEXT_PUBLIC_APP_NAME` | `TransportTMS` |

Do **not** set `UPLOAD_DIR`. Its absence makes the intent unambiguous.

Rotating `AUTH_SECRET` invalidates every existing session — which is what you
want at a cutover, since those sessions belong to the old deployment.

---

## 7. Lock the database down

Database cluster → **Settings → Trusted Sources** → add the App Platform app.
Until you do, the cluster accepts connections from anywhere with the password.

---

## 8. Deploy and verify

1. Merge and push (step 1). Watch the build, then the deploy log.
2. `prisma migrate deploy` runs from `npm start` on every release — confirm it
   reports no pending migrations.
3. Open the `*.ondigitalocean.app` URL. Sign in.
4. **Prove storage end to end**, since this is the part that changed:
   - upload a POD, reopen it — it should render
   - confirm the object appears in the R2 bucket under `<tenantId>/pod/…`
   - open it as a *different* tenant's user → must be **403**
5. Load a data-heavy register and the dashboard outstanding tile — this is
   where app↔DB latency would show if the regions were mismatched.
6. Run an Excel export (exercises the lazy-loaded `exceljs` path).
7. Sign out — confirm it lands on the app's own `/login`, not `localhost`.

---

## 9. After the first week

- **Restore drill.** Restore yesterday's backup to a scratch cluster and run
  the row-count script from step 4 against it. A backup nobody has restored is
  a hypothesis, not a backup.
- **Orphan sweep.** Once real uploads exist, run it monthly:
  ```bash
  npx tsx scripts/storage-orphan-sweep.ts                # report only
  npx tsx scripts/storage-orphan-sweep.ts --delete       # after reading the report
  ```
  It derives its reference list from the Prisma schema at runtime — 30 path
  columns across 15 models — so it stays correct as the schema grows. It never
  deletes without `--delete`, and never touches an object newer than 7 days.
- **Uptime check** on `/login`.
- **Measure before resizing.** The instance size and DB class are the only two
  levers that matter; change them on evidence, not on nerves.

---

## 10. Rollback

Nothing is destroyed by this cutover, so rollback is cheap for as long as you
keep the old stack alive:

| Failure | Action |
|---|---|
| App misbehaves | Redeploy the previous deployment from the App Platform UI |
| Storage misbehaves | Set `STORAGE_DRIVER=disk` and redeploy — the app reverts to filesystem behaviour |
| Database misbehaves | Repoint `DATABASE_URL`/`DIRECT_DATABASE_URL` at Supabase; the schema is identical |

Keep Supabase and the Render service running until you have a week of clean
days on the new stack.

Object keys are identical under both storage drivers, so no data has to be
converted in either direction — which is what makes the storage rollback a
single environment variable rather than a migration.
