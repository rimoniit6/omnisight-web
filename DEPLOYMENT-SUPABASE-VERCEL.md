# OmniSight — Production Deployment: Supabase + GitHub + Vercel

This is the step-by-step, exact deployment procedure for the web/admin/API stack. The Windows desktop agent is a **separate artifact** built on a Windows CI host — it is not part of the Vercel deployment (see §7).

**Architecture after deployment:**

```
Desktop Agent (Windows)          Admin UI (browser)
        │  HTTPS                        │
        ▼                              ▼
┌─────────────────────  Vercel  ─────────────────────┐
│  Next.js web app + API (Node runtime, src/proxy.ts) │
│  ─ all /api/* routes, screenshots, avatars          │
└──────────┬──────────────────────┬──────────────────┘
           │ pooled connection    │ Supabase Storage
           ▼ (DATABASE_URL)       ▼ (STORAGE_DRIVER=supabase)
┌─────────────────────  Supabase ────────────────────┐
│  PostgreSQL (direct URL for migrations)             │
│  Storage: private "screenshots" + public "avatars"  │
└──────────────────────────────────────────────────────┘
   Realtime Socket.IO service (mini-services/live-updates)
   ── runs on a VM/container OUTSIDE Vercel, same DATABASE_URL/JWT_SECRET
```

---

## Status of this document

- **COMPLETED (executed against the real Supabase project `ujkgzgnxcmihgewkibly` this session)** — connectivity (pooled 6543 + direct 5432), all **25 migrations applied** (`prisma migrate status`: up to date), **43 tables + 203 indexes** verified, CRUD/relations/transactions/JSON/cascade verified, **Super Admin bootstrapped** (idempotent) with login + session revocation + RBAC verified over real HTTP, production-server smoke test, and a **controlled agent flow + tenant-isolation run** (throwaway orgs, fully cleaned up). Full suite: **1131 tests / 0 failures**.
- **EXTERNAL DEPENDENCY** — realtime Socket.IO service (Step 4) and the Windows agent-build host (Step 3 §7) run outside Vercel by design.
- **OPERATOR ACTION REQUIRED** — only these remain: paste the real `SUPABASE_SERVICE_ROLE_KEY` into the gitignored `.env` (replacing `__OP_SERVICE_ROLE_KEY__`), run the bucket provisioning below (private `screenshots` + public `avatars`), verify screenshot upload/read end-to-end, then create the GitHub repo + import into Vercel. The database password and admin email are already in `.env`. None of these values may be printed or committed.

## Step 1 — Supabase

1. Create a project at https://supabase.com (pick a region close to your users).
2. Open **Project Settings → Database → Connection strings**.
   - **Pooled** (Transaction pooler, port **6543**, `?pgbouncer=true`) → this is `DATABASE_URL`.
   - **Direct** (Session pooler, port **5432**) → this is `DIRECT_URL`.
   - This deployment's project (ref `ujkgzgnxcmihgewkibly`, `ap-northeast-1`) uses:
     ```
     DATABASE_URL="postgresql://postgres.ujkgzgnxcmihgewkibly:<PASSWORD>@aws-0-ap-northeast-1.pooler.supabase.com:6543/postgres?pgbouncer=true&connection_limit=1"
     DIRECT_URL="postgresql://postgres.ujkgzgnxcmihgewkibly:<PASSWORD>@aws-0-ap-northeast-1.pooler.supabase.com:5432/postgres"
     ```
     The pooler host has been verified reachable on both ports (TCP) and the runtime/direct connections both **succeeded against the real project**. `connection_limit=1` on `DATABASE_URL` is **required** for Prisma interactive transactions through the Supabase transaction pooler — without it, login/consent intermittently fail with `Transaction API error: Transaction not found` (verified in production here; the fix is the canonical Prisma+Supabase parameter). The password is an **operator secret**: it lives only in the local gitignored `.env` and in Vercel's environment store — never in any committed file or report.
3. Create the storage buckets. From the Supabase dashboard → **Storage → New bucket**:
   - `screenshots` — **Private** bucket. Do **not** make it public. Objects are served only through the authenticated `/api/screenshots/[id]/image` route and signed URLs (AI vision).
   - `avatars` — **Public** bucket (avatars are displayed in `<img>` tags under the unchanged `/uploads/avatars/<id>.png` URL, served via the app route).
4. Note these values (server-only): `SUPABASE_URL` (https://<project-ref>.supabase.co) and `SUPABASE_SERVICE_ROLE_KEY` (**Settings → API → service_role**). This key is a super-user credential — keep it out of the browser; set it only as a server environment variable.

### Apply the migrations

Run against the **direct** URL (never the pooler). From a machine with the repo checked out:

```bash
npm install
export DATABASE_URL="postgresql://postgres.<ref>:<password>@...pooler.supabase.com:6543/postgres?pgbouncer=true"
export DIRECT_URL="postgresql://postgres.<ref>:<password>@...pooler.supabase.com:5432/postgres"
npm run db:deploy        # = prisma migrate deploy  (applies prisma/migrations in order)
```

Verify the migration was applied:

```bash
npx prisma migrate status        # → "Database schema is up to date!"
```

> ⚠️ **Never** run `prisma db push` or `prisma migrate reset` against the production database. `npm run db:push:dev` hard-refuses production and non-local hosts.

### Create the initial Super Admin

The bootstrap is the **only** account-creation mechanism (idempotent; it never overwrites an existing account, never creates demo data, requires a strong password):

```bash
export SUPER_ADMIN_EMAIL="you@example.com"
export SUPER_ADMIN_PASSWORD="$(openssl rand -base64 18)"
npx tsx scripts/bootstrap-super-admin.ts
```

**Already done against this project this session** (idempotent — re-running is a no-op and never duplicates the account). After the first Super Admin logs in, the UI guides creation of the organization. No insecure default accounts exist.

---

## Step 2 — GitHub

1. Create a **private** repository and push the project:
   ```bash
   git remote add origin git@github.com:<you>/omnisight.git
   git push -u origin main
   ```
2. `.gitignore` already excludes `.env*` (except the two example templates), `node_modules`, `.next`, `uploads/`, `*.db`, `.worklens/`, `.vercel`, omnisight-agent build outputs, backups and logs. **Before pushing, confirm no `.env` or credential files are tracked:**
   ```bash
   git ls-files | grep -E "(^|/)\.env($|\.)"    # expect only .env.example / .env.production.example
   ```
3. Never commit real `SUPER_ADMIN_PASSWORD`, `JWT_SECRET`, `ENCRYPTION_KEY`, `DATABASE_URL`, or `SUPABASE_SERVICE_ROLE_KEY`. If a secret was ever committed, rotate it (deleting the file from the history is not sufficient).
4. Optional but recommended: enable GitHub secret scanning / push protection for the repo.

---

## Step 3 — Vercel

1. **Import the GitHub repository** in the Vercel dashboard (Framework preset auto-detects **Next.js**).
2. **Root directory:** repository root.
3. **Build & install settings:** leave defaults — Vercel uses `package-lock.json` (npm) and runs `next build`. No custom commands needed.
4. **Node version:** Vercel's default (22) — supported.
5. **Environment variables** — set in **Project → Settings → Environment Variables** (Production + Preview + Development as appropriate):

   | Variable | Value |
   |---|---|
   | `DATABASE_URL` | Supabase **pooled** URL (port 6543, `?pgbouncer=true&connection_limit=1` — the `connection_limit=1` parameter is mandatory for Prisma interactive transactions through the pooler) |
   | `DIRECT_URL` | Supabase **direct** URL (port 5432) — used only by local migrations; harmless on Vercel |
   | `JWT_SECRET` | random ≥ 32 chars (`openssl rand -base64 48`) — **must match the realtime service** |
   | `SUPER_ADMIN_EMAIL` | the bootstrap email (see Step 1) |
   | `SUPER_ADMIN_PASSWORD` | only needed for the one-time bootstrap; can be removed afterwards |
   | `ENCRYPTION_KEY` | 32-byte hex (`node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`) |
   | `STORAGE_DRIVER` | `supabase` |
   | `SUPABASE_URL` | `https://<project-ref>.supabase.co` |
   | `SUPABASE_SERVICE_ROLE_KEY` | service_role key (**server-only**) |
   | `NEXT_PUBLIC_LIVE_UPDATES_URL` | public URL of the realtime service, e.g. `wss://live.omnisight.example.com` (see Step 4) |
   | `ALLOWED_ORIGIN` | `https://<your-app>.vercel.app` (or custom domain) |

   Optional: `JWT_EXPIRES_IN`, `SESSION_COOKIE_NAME`, `JOBS_INTERVAL_SECONDS`, `PROJECT_TIME_SYNC_INTERVAL_SECONDS`, `PRESENCE_ONLINE_THRESHOLD_MS`.

6. **Deploy.** Vercel runs `next build`; the output shows the `Proxy (Middleware)` (this app's auth/RBAC/rate-limit gate) and all API routes, including `/uploads/avatars/[filename]`.
7. **Custom domain** (recommended): add it under **Project → Settings → Domains**. HTTPS is automatic.

---

## Step 4 — Realtime service (Live Monitor push)

The Live Monitor's realtime feed needs a persistent Socket.IO process that **Vercel cannot host**. Deploy it on any always-on host (VPS, Railway/Render/Fly container, etc.):

1. Check out the repo on that host.
2. `npm install` (the service resolves Prisma + socket.io from the root).
3. Set `DATABASE_URL` (pooled), `JWT_SECRET` (must equal Vercel's), `ALLOWED_ORIGIN` (must equal the app origin), optional `LIVE_UPDATES_PORT` (default 3010).
4. Run: `npm run dev:live` (uses `bun --hot`) or, for production, run `mini-services/live-updates/index.ts` with a process manager (e.g. `bun run mini-services/live-updates/index.ts` under systemd/PM2).
5. Expose port 3010 over `wss://`. Either:
   - direct: `NEXT_PUBLIC_LIVE_UPDATES_URL=wss://live.omnisight.example.com`, or
   - behind the same origin using the included Caddyfile transform (`?XTransformPort=3010`) with `NEXT_PUBLIC_LIVE_UPDATES_URL=https://app.omnisight.example.com`.

> The app **works without this service** (every page reads from the database; the socket is a delta layer). Without it, the Live Monitor feed simply does not push new events in real time — nothing is faked.

### Background jobs on Vercel

`src/instrumentation.ts` runs the maintenance jobs and the project-time sync **while a serverless instance is warm** — best-effort, not guaranteed cadence. For deterministic scheduling:
- Create a Vercel Cron in `vercel.json` (or dashboard):
  ```json
  { "crons": [ { "path": "/api/cron/jobs", "schedule": "0 * * * *" } ] }
  ```
  backed by a route that calls the same `runScheduledJobs()` (currently invoked by `npm run jobs`). The crash-safe `JobRun` leases make concurrent runs harmless.
- Or run `npm run jobs` from the same host that runs the realtime service.

---

## Step 5 — Post-deployment verification checklist

1. **Health:** `GET /api/health` → 200 `{status:"ok",...}`; `GET /api/health/database` → 200 `{database:"reachable",bootstrap:"complete"}` (503 only if the DB is truly unreachable — never a credentials leak).
2. **Login:** sign in with the bootstrapped Super Admin; invalid credentials → uniform 401; session cookie is httpOnly.
3. **DB:** create an Organization; employees/departments/devices CRUD works.
4. **Agent:** register/approve a device (zero-touch or credentials), authenticate, verify heartbeat/activity/screenshots appear.
5. **Screenshots:** upload → visible in the admin UI, image served through the authenticated route; cross-org users get 404.
6. **Avatars:** upload an avatar → it renders under `/uploads/avatars/<id>.png` (served from Supabase Storage through the app route).
7. **AI:** configure a provider in Settings → AI (key stored encrypted); run an analysis/OCR — a missing/unauthorized provider yields an honest error, never fabricated output.
8. **Realtime:** with the external service running, Live Monitor updates on new activity within ~1 s; without it, the UI still works (polling).
9. **Authorization spot checks:** viewer cannot open admin-only routes (403); `SUPER_ADMIN_PASSWORD`/`JWT_SECRET`/`SUPABASE_SERVICE_ROLE_KEY` are not in any client bundle (`NEXT_PUBLIC_` usage is limited to the non-secret socket URL).

---

## Features that cannot run on Vercel (and their required external runtime)

| Feature | Why | External runtime |
|---|---|---|
| Live Monitor WebSocket push | persistent Socket.IO server | VM/container running `mini-services/live-updates` (+ optional Caddy TLS) |
| OmniSightAgent.exe build | Electron packaging needs Windows + native toolchain | Windows CI host (GitHub Actions / self-hosted runner) or a Windows dev box; attach the installer in Settings → Agent Software |
| Agent-build artifact download | installer lives on the build host | Serve the EXE from the build host / CI release assets; the org-scoped download route returns 404 if the file is not on the same host |
| Background jobs (deterministic) | serverless timers are best-effort | Vercel Cron → job endpoint, or `npm run jobs` on the realtime host |

The **desktop agent itself** (monitoring client) runs on employee Windows machines and talks to the Vercel API over HTTPS — it is never deployed to Vercel.
