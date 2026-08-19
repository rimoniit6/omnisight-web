# OmniSight — Installation Guide

> Previously branded as **WorkLensAI** — technical identifiers from that era (cookie names, environment variables, native module names) are intentionally preserved for compatibility.

This guide covers a fresh-machine installation of the OmniSight **server** (admin console + API + realtime service) and the **Windows desktop agent**. Every command and environment variable below was verified against the repository (`package.json`, `.env.example`, `.env.production.example`, `scripts/`, `omnisight-agent/`).

Related docs: [README.md](./README.md) · [DEPLOYMENT.md](./DEPLOYMENT.md) · [omnisight-agent.md](./omnisight-agent.md) · [TROUBLESHOOTING.md](./TROUBLESHOOTING.md)

---

## 1. System requirements

### Server

| Requirement | Version / notes |
|---|---|
| OS | Linux, macOS, or Windows (Node.js must be installable) |
| Node.js | **22.5 or newer recommended** (the SQLite→PostgreSQL migration script uses `node:sqlite`; no `engines` field is declared, so older versions are not guaranteed) |
| Package managers | `npm` (primary; `package-lock.json` committed) and `bun` (required for `dev:live` / the live-updates mini-service) |
| Database | **PostgreSQL** — the only supported application database. SQLite is not supported in production (`db/*.db` files are legacy dev artifacts) |
| Disk | Database + `uploads/` (screenshots) + `node_modules` |
| RAM | Server process memory is capped via `NODE_OPTIONS=--max-old-space-size=768` in the provided configs; 1–2 GB free is a practical floor |
| Git | Required to clone |

### Windows desktop agent (client machines)

- **Windows 10 or 11, x64**.
- Runtime uses: DPAPI (secret storage), WinRT geolocation (location tracking), Media Foundation (webcam).
- **Building the native addon** (only needed when building the agent yourself):
  - Node.js 22.x LTS
  - Visual Studio Build Tools with **MSVC v143** and **Windows SDK 10.0.26100.0** (required by `omnisight-agent/native/binding.gyp`)
  - `node-gyp` compatible toolchain
- Building the **native messaging host** additionally needs an MSVC cl.exe toolchain (`scripts/build-native-host.mjs` searches vcvars64; override with `MSVC_VCVARS` env) — gcc/clang fallbacks are attempted.

## 2. Clone

```bash
git clone <your-repository-url> OmniSight
cd OmniSight
```

## 3. Install dependencies

```bash
# Root (server app)
npm install

# Realtime mini-service (uses the shared Prisma schema)
(cd mini-services/live-updates && npm install)

# Desktop agent (only if you will develop/build the agent here)
(cd omnisight-agent && npm install)
```

Both `bun.lock` and `package-lock.json` are committed; `npm install` is the supported path.

## 4. Environment configuration

Copy the template and edit it:

```bash
cp .env.example .env
```

### Environment variables — complete reference

All names verified against source code. Secrets are marked **SENSITIVE** — never commit `.env`, never share values.

| Variable | Required | Purpose | Example / format | Sensitivity |
|---|---|---|---|---|
| `DATABASE_URL` | **Required** | PostgreSQL connection string | `postgresql://user:pass@host:5432/workai?schema=public` | SENSITIVE (credentials) |
| `SUPER_ADMIN_EMAIL` | **Required** (bootstrap) | Super Admin account email; used by `bootstrap-super-admin` | `superadmin@example.com` | Moderate |
| `SUPER_ADMIN_PASSWORD` | **Required** (bootstrap) | Super Admin password. Policy: ≥ 12 chars, upper + lower + digit. Generate: `openssl rand -base64 18` | `your-strong-password-here` | SENSITIVE |
| `JWT_SECRET` | **Required** | HS256 JWT signing secret; ≥ 16 chars (≥ 32 recommended). Generate: `openssl rand -base64 48`. Must be independent of `ENCRYPTION_KEY` | `your-secret-here` | SENSITIVE |
| `JWT_EXPIRES_IN` | Optional | JWT/session lifetime; suffixes `s`, `m`, `h`, `d` | `7d` (default) | — |
| `SESSION_COOKIE_NAME` | Optional | httpOnly session cookie name | `worklens_token` (default) | — |
| `ENCRYPTION_KEY` | **Required in production** | 32-byte hex key for AES-256-GCM encryption of stored secrets (AI provider keys). Generate: `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`. **Production fails fast if missing/short; never falls back to JWT_SECRET.** Dev fallback: auto-generated per-workspace key at `.worklens/dev.key` (gitignored) | `your-32-byte-hex-key` | SENSITIVE |
| `JOBS_INTERVAL_SECONDS` | Optional | Interval between scheduled job runs (consent expiry, retention, anomaly detection); min 60 | `3600` (default) | — |
| `OMNISIGHT_SERVER_URL` | Agent-side | Server URL the desktop agent connects to (primary name). Legacy `WORKLENSAI_SERVER_URL` still honored; the new var wins when both are set | `https://omnisight.example.com` | — |
| `WORKLENSAI_SERVER_URL` | Agent-side (legacy) | Legacy server URL variable | `https://omnisight.example.com` | — |
| `AGENT_SERVER_URL` | Build-time (agent) | URL baked into the installer by `omnisight-agent/scripts/build-prod.mjs`; validated (https always; http only loopback) | `https://omnisight.example.com` | — |
| `AGENT_ENROLLMENT_CODE` / `WL_ENROLLMENT_CODE` | Build-time / runtime (agent) | Zero-touch enrollment code baked at build or read at runtime | `your-enrollment-code` | SENSITIVE (grants org binding) |
| `WL_UPDATE_URL` | Optional (agent) | HTTPS feed URL for agent auto-updates; when unset updates are disabled; https only | `https://updates.example.com/feed.json` | — |
| `LIVE_UPDATES_PORT` | Optional | Port for the live-updates Socket.IO service | `3010` (default) | — |
| `LIVE_UPDATES_URL` | Optional | `wss://…` URL for production WebSocket; dev uses `NEXT_PUBLIC_LIVE_UPDATES_URL` | `wss://omnisight.example.com:3010` | — |
| `ALLOWED_ORIGIN` | Optional (live-updates) | CORS origin for the Socket.IO service | `http://localhost:3000` (default) | — |
| `PROJECT_TIME_SYNC_INTERVAL_SECONDS` | Optional | Loop interval for activity→project-time sync; min 15 | `60` (default) | — |
| `PRESENCE_ONLINE_THRESHOLD_MS` | Optional | Heartbeat freshness threshold for online presence; floor 15 s | `300000` (default 5 min) | — |
| `NODE_OPTIONS` | Optional | Node memory cap (used in provided scripts) | `--max-old-space-size=768` | — |
| `LOG_LEVEL` | Optional | Server log level | `info` | — |
| `NEXT_TELEMETRY_DISABLED` | Optional | Disable Next.js telemetry | `1` | — |
| `SEED_ALLOWED` | Dev only | `1` enables the dev seed (creates ONLY the Super Admin, no demo data). **Never set in production** — the seed refuses when `NODE_ENV=production` | `1` | — |
| `CONFIRM_DEV_RESET` / `DRYRUN` | Dev only | Confirmation gates for `scripts/reset-database.ts` | `YES` / `1` | — |
| `CONFIRM_PRODUCTION_CLEANUP` | Ops only | Confirmation gate for `scripts/production-cleanup.ts` | `YES` | — |
| `WL_LOG_LEVEL` | Agent | Agent log level `debug|info|warn|error` (default info) | `info` | — |
| `MSVC_VCVARS` | Agent build | Path override for vcvars64.bat when building the native host | `C:\Program Files\Microsoft Visual Studio\2022\BuildTools\VC\Auxiliary\Build\vcvars64.bat` | — |

> **Note:** there are **no AI provider environment variables** — provider keys are configured in the UI (AI Provider page) and stored in the database, encrypted at rest with `ENCRYPTION_KEY`.

## 5. Database setup

Prerequisites: a running PostgreSQL server and a created database (e.g. `workai`).

```bash
# Apply migrations (production-safe; creates the schema)
npx prisma migrate deploy

# Generate the Prisma client (also runs automatically on install/postinstall)
npx prisma generate

# Bootstrap the Super Admin (must be run after migrations)
npm run bootstrap:super-admin
```

Other documented DB scripts (use with care):

| Command | Purpose | Safety notes |
|---|---|---|
| `npm run db:migrate` | `prisma migrate dev` — create/apply dev migrations | dev only |
| `npm run db:reset` | `prisma migrate reset` — drop + re-apply | destructive |
| `npm run db:push:dev` | `prisma db push` wrapper | refuses production, requires `--yes` |
| `npm run db:deploy` | `prisma migrate deploy` | production path |
| `npm run db:generate` | `prisma generate` | safe |
| `npm run db:seed:dev` | dev seed (Super Admin only, `SEED_ALLOWED=1`) | refuses `NODE_ENV=production` |
| `npm run db:production-clean` | wipe business data, keep Super Admin (takes a `pg_dump` backup first) | requires `CONFIRM_PRODUCTION_CLEANUP=YES` |

**Production rules** (from `.env.production.example`):

- Use `npx prisma migrate deploy` — **never** `prisma db push` against production.
- Order: `1. npx prisma migrate deploy` → `2. npx prisma generate` → `3. npx tsx scripts/bootstrap-super-admin.ts`.

## 6. Start development

```bash
npm run dev
```

This starts both the Next.js app (port **3000**) and the live-updates service (port **3010**, via Bun) using `scripts/dev.mjs`.

Individual processes:

```bash
npm run dev:app    # Next.js only, port 3000
npm run dev:live   # live-updates mini-service only (bun --hot)
```

Open `http://localhost:3000`, log in with the Super Admin credentials, and create the organization on first login.

## 7. Build (production server)

```bash
npm run build        # next build (output: standalone)
node scripts/copy-standalone.js   # copies .next/static and public/ into .next/standalone
npm run start        # NODE_ENV=production next start -p 3000
```

`next.config.ts` sets `output: "standalone"` — the `copy-standalone.js` step is required for standalone deployments.

## 8. Desktop agent

### 8.1 Requirements (Windows, building the agent yourself)

- Node.js 22.x, MSVC v143 Build Tools, Windows SDK 10.0.26100.0 (see section 1).

### 8.2 Install + build native addon

```bash
cd omnisight-agent
npm install
npm run build        # type-checks + compiles renderer + copies assets
# native addon (worklens_capture.node) is built during install via node-gyp;
# verify: native/build/Release/worklens_capture.node exists
npm run typecheck    # optional
```

### 8.3 Run in development

```bash
npm run dev          # from omnisight-agent/ (or npm run dev:agent from repo root)
```

The agent connects to `http://localhost:3000` by default (dev), overridable with `OMNISIGHT_SERVER_URL` / `WORKLENSAI_SERVER_URL` env vars.

### 8.4 Build a production installer

```bash
# From omnisight-agent/
npm run package                  # electron-builder --win nsis (dev URL baked)
# With a production server URL + optional enrollment code:
AGENT_SERVER_URL=https://omnisight.example.com AGENT_ENROLLMENT_CODE=<code> npm run package:prod
```

Notes:

- `package:prod` runs `scripts/build-prod.mjs` which validates the URL (https required unless loopback), bakes URL + enrollment code, builds, and prints the installer path and SHA-256.
- In production, `http://` URLs are rejected except loopback.
- The preferred path for production is the **CLI build**: `AGENT_SERVER_URL=... AGENT_ENROLLMENT_CODE=... node omnisight-agent/scripts/build-prod.mjs` (see [DEPLOYMENT.md](./DEPLOYMENT.md)).

### 8.5 Enrollment

Enrollment happens at first run: the agent shows an onboarding screen (login with Agent Account, or use a baked enrollment code for zero-touch), then requests device approval (device claim) which an admin approves in **Agent Approvals**. See [COMPANY-GUIDE.md](./COMPANY-GUIDE.md) §2.2 and [omnisight-agent.md](./omnisight-agent.md).

## 9. Production deployment (summary)

See [DEPLOYMENT.md](./DEPLOYMENT.md) for the full guide. Verified/supported layout:

```
Caddy (reverse proxy)  ──► :3000  Next.js server
                        └─► :3010  live-updates (Socket.IO)
PostgreSQL  ◄── Prisma
uploads/    (screenshots) — must be backed up with the DB
```

Key production environment: `DATABASE_URL`, `JWT_SECRET`, `ENCRYPTION_KEY` (mandatory), `SUPER_ADMIN_EMAIL/PASSWORD` (bootstrap only), `SESSION_COOKIE_NAME`, `NODE_ENV=production`. The committed `Caddyfile` proxies `:81` → `:3000` and `?XTransformPort=3010` → `:3010` (fixed allowlist).

## 10. Verification

| Check | Command | Expected |
|---|---|---|
| Server up | `curl http://localhost:3000/api/health` | `{"status":"ok",...}` |
| DB reachable | `curl http://localhost:3000/api/health/database` | ok response |
| Realtime up | open the app → header shows LIVE badge | WebSocket connected |
| Lint | `npm run lint` | no errors |
| Tests | `npx tsx --test tests/*.test.ts` | suites pass (require a throwaway PostgreSQL test DB; see [DEVELOPMENT.md](./DEVELOPMENT.md)) |
| Super Admin login | browser at `http://localhost:3000` | login works, org creation prompt (first run) |
| Agent install | install installer on Windows machine | agent tray icon appears; device appears in Agent Approvals |
