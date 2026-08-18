# OmniSight — Supabase + Vercel Production Readiness Audit

Audit date: 2026-08-18. This document records the **actual state of the repository** (inspected source, config, and runtime behavior) ahead of the Supabase + GitHub + Vercel production migration. Every statement is backed by repository evidence; nothing is assumed.

---

## 1. Repository Overview

| Item | Value | Evidence |
|---|---|---|
| Framework | Next.js 16 (App Router) | `package.json`: `"next": "^16.1.1"`; app lives under `src/app/` |
| React | 19 | `package.json`: `"react": "^19.0.0"` |
| TypeScript | ^5 | `package.json`: `"typescript": "^5"`; `tsconfig.json` |
| Node.js requirement | ≥ 18 (tested on v24.14.0) | no `engines` field; Vercel's default Node 22 runtime is supported |
| Package manager | npm (primary) + bun (realtime service) | `package-lock.json` committed; `bun.lock` committed; `npm run dev:live` spawns `bun --hot mini-services/live-updates/index.ts` |
| Lockfile | `package-lock.json` (npm), `bun.lock` (realtime dev) | repository root |
| Build script | `next build` | `package.json` |
| Start script | `next start` (`NODE_ENV=production`) | `package.json` |
| Dev script | `node scripts/dev.mjs` (Next app :3000 + realtime service :3010) | `scripts/dev.mjs` |
| Test script | `npx tsx --test tests/*.test.ts` (node:test, DB-backed) | `package.json` + `tests/` (76 files) |
| Lint script | `eslint .` | `eslint.config.mjs`; **0 errors, 142 pre-existing warnings** (unused vars in test files) |
| Middleware / proxy | `src/proxy.ts` (Next 16 proxy, exported `proxy` + `config.matcher`) | builds report `ƒ Proxy (Middleware)` |
| Config | `next.config.ts` (`output: "standalone"`, strict CSP, security headers) | Vercel ignores `standalone` and uses its own runtime; CSP is strict in production |

Git history is intentionally minimal: one squashed commit plus the working-tree migration (all changes below are uncommitted). No secrets have ever been committed (see §11).

---

## 2. Database Audit

| Item | Value | Evidence |
|---|---|---|
| Provider | **PostgreSQL only** | `prisma/schema.prisma`: `provider = "postgresql"` |
| Prisma version | ^6.11.1 (installed 6.19.3) | `package.json`; `npx prisma --version` |
| Datasource | `url = env("DATABASE_URL")`, `directUrl = env("DIRECT_URL")` | `prisma/schema.prisma` lines 9–18. On Supabase: pooled URL (port 6543, `?pgbouncer=true&connection_limit=1`) for runtime, direct URL (port 5432) for Migrate/DDL |
| Migration status | 25 sequential PostgreSQL migrations, **all applied successfully** to a fresh throwaway PostgreSQL database during this audit (`prisma migrate deploy`) | `prisma/migrations/` (20260810105722 → 20260817140000); verification §6 |
| SQLite | **Fully removed from the active path** — `grep -ri "sqlite|better-sqlite3"` → 0 matches. The pre-migration SQLite migrations are archived (not active) under `prisma/migrations-sqlite-archive/` (29 dirs, ignored by `prisma migrate`) | repo search; `prisma/migrations/` is the only active migration dir |
| Seed | Dev-only, explicitly guarded: `NODE_ENV === 'production'` or missing `SEED_ALLOWED=1` refuses to run; creates only the Super Admin from env, no demo data | `src/lib/seed.ts` |
| Initial admin | `scripts/bootstrap-super-admin.ts` → `src/lib/super-admin.ts`: idempotent, env-driven, requires a strong password (≥ 12 chars, upper/lower/digit), never overwrites an existing account, never prints the password | verified in runtime smoke test |
| Serverless compatibility | Pooled `DATABASE_URL` + connection_limit capped by the realtime service (`connection_limit=5`); Prisma singleton (`src/lib/db.ts`) caches the client on `globalThis` — no per-request instantiation, no import-time connections in unsuitable environments | `src/lib/db.ts`, `mini-services/live-updates/index.ts` `resolveDbUrl()` |
| Destructive ops | `prisma db push` wrapped in `scripts/db-push-dev.mjs` which **refuses** production (`NODE_ENV=production`) and refuses non-local hosts without `--force`; `scripts/production-cleanup.ts` requires `CONFIRM_PRODUCTION_CLEANUP` | scripts audited |

### Prisma connection architecture (Supabase) — verified against the real project

- `DATABASE_URL` — **pooled** connection (port 6543, `?pgbouncer=true&connection_limit=1`). Used by the app at runtime on Vercel serverless. **`connection_limit=1` is mandatory**: Prisma interactive transactions require the whole transaction to stay on one pooler backend connection. Without it, login/consent intermittently fail on Supabase with `Transaction API error: Transaction not found` (reproduced and fixed against the real project this session — see PRODUCTION-READINESS-CERTIFICATION.md §3).
- `DIRECT_URL` — **direct** connection (port 5432). Used by Prisma Migrate / `db push` / admin operations so DDL and advisory locks never run through the transaction pooler.
- On plain PostgreSQL hosts both may be the same value; Prisma falls back to `url` when `DIRECT_URL` is absent.

### Production transaction hardening added this session (real-Supabase findings)

1. **`connection_limit=1`** on the pooled `DATABASE_URL` (above) — canonical Prisma+Supabase pooler parameter.
2. **`src/lib/consent.ts`** — `applyConsentTransition` now resolves the published policy through the **same transaction client** (`tx`) instead of the top-level `db`, eliminating a nested-connection wait that deadlocked interactive transactions on a single-connection pooler.
3. **`src/lib/db.ts`** — the client applies a bounded, generous interactive-transaction timeout (15 s) so cold remote poolers (ap-northeast-1 round-trips ~1.7 s) never hit Prisma's default 5 s ceiling. All three fixes are covered by the full suite (1131 tests, 0 failures) plus the real-Supabase agent flow.

### High-volume query indexes (verified present in the migrated DB)

`Activity(employeeId, timestamp)`, `Activity(employeeId, category)`, `Activity(createdAt)`, `Screenshot(employeeId, capturedAt)`, `Screenshot(createdAt)`, `Anomaly(organizationId, createdAt)`, `Notification(createdAt)`, `AgentRegistration(createdAt)`, `UsbEvent(createdAt)`, `TimeEntry(source, createdAt)`, `Device(updatedAt)` — 203 total indexes across 43 application tables (verified against the real Supabase DB).

---

## 3. Authentication & Authorization Audit

| Area | Status | Evidence |
|---|---|---|
| Login | `POST /api/auth/login` — rate limited per IP+email, case-insensitive lookup, bcrypt (cost 12) | `src/app/api/auth/login/route.ts`, `src/lib/auth.ts` |
| Sessions | Server-authoritative `UserSession` rows; JWT carries `sessionId`; every request re-validates the row (revoked/expired/missing → uniform 401, fails closed) | `src/lib/session.ts`, `src/proxy.ts` |
| JWT | HS256, `crypto.subtle` HMAC, exp/iat validation, no algorithm confusion; `JWT_SECRET` **required** (≥ 16 chars, no fallback — throws if missing) | `src/lib/auth.ts` |
| Cookies | httpOnly, SameSite=Lax, `secure` in production | `src/lib/auth.ts` |
| Password hashing | bcryptjs cost 12; hashes never returned to clients | `src/lib/auth.ts`, login/me responses |
| Agent auth | Device-bound `AgentToken` (PATH A), short-lived `AgentSession` for login bootstrap, claim-secret authenticated zero-touch flow, per-account + IP lockout | `src/app/api/agent/*`, `src/lib/agent/auth.ts` |
| RBAC | Role hierarchy super_admin > owner > admin > manager > viewer enforced centrally in the proxy + per-route `requireAdminOrg` / `requireSessionOrg` | `src/proxy.ts`, `src/lib/api.ts` |
| Tenant isolation | Org scoping derived from the verified JWT, never from client input; cross-org resources 404 (concealed) | `src/app/api/screenshots/*`, tests `multi-org-isolation`, `screenshots` |
| CSRF | SameSite=Lax cookie + proxy origin check on state-changing requests (Bearer path defense); agent API clients (no Origin header) unaffected | `src/proxy.ts` |
| Rate limiting | PostgreSQL-backed token bucket (`RateLimitCounter`), applied centrally in the proxy before auth; agent routes keyed by token hash | `src/lib/rate-limit.ts`, `src/proxy.ts` |
| Secrets | Encryption at rest for stored AI keys (AES-256-GCM, `ENCRYPTION_KEY`), independent from `JWT_SECRET`; production fails fast when `ENCRYPTION_KEY` is missing | `src/lib/crypto.ts` |

---

## 4. API Surface Audit

- ~90 route handlers under `src/app/api/`. All `/api/*` traffic passes `src/proxy.ts`, which enforces auth + RBAC + rate limits + CSRF origin checks. Public paths are an explicit allowlist: `/api/auth/login`, `/api/health*`, `/api/agent/*` (token-verified inside the routes), and the device-owned `/api/device-claims/{id}/cancel` path.
- Health: `/api/health` (app liveness, no secrets) and `/api/health/database` (DB reachability + bootstrap state; returns 503 **only** on a real connectivity failure, never leaks driver errors). Both public for external monitoring by proxy whitelist.
- Error handling: route-level try/catch returns generic safe bodies; detailed diagnostics go through the redacting logger. No SQL/Prisma internals reach clients (verified by tests `H-4`, `SH-30`).
- Logging: `src/lib/logger.ts` redacts `password/token/secret/authorization/api-key/cookie` field names and Bearer/JWT-shaped values; no secrets are logged.
- No Edge runtime routes: `grep "runtime = 'edge'"` → 0 matches. All DB routes run on the Node runtime.
- External AI calls (provider-agnostic) run through an SSRF-safe client (`src/lib/ssrf.ts`); AI keys are stored encrypted, provider config stored in `SystemSetting`.

## 5. Storage / Filesystem Audit (Vercel ephemeral-filesystem risk)

| Component | Before | After (this migration) | Vercel-safe |
|---|---|---|---|
| Screenshots | local `uploads/screenshots/` via `fs` | **Storage driver abstraction** (`src/lib/storage/`): local driver (self-host/dev/tests) or **Supabase Storage** private `screenshots` bucket on Vercel. DB `filePath` is display-only; the physical key is derived server-side (`screenshots/<orgId>/<basename>`). Signed URLs (1 h) for the AI vision pipeline; images are served only through the org-scoped, authenticated `/api/screenshots/[id]/image` route. | ✅ |
| Avatars | local `public/uploads/avatars/` | Driver-backed: local filesystem or public Supabase `avatars` bucket. **New:** `src/app/uploads/avatars/[filename]/route.ts` serves avatars through the driver under the unchanged `/uploads/avatars/<id>.png` URL scheme (PNG signature check, nosniff, immutable cache, basename-only lookup). | ✅ |
| Retention/orphan sweep | `fs.unlink` flat dir | Screenshot deletes go through the driver; orphan sweep is a **no-op on Supabase** by design (no shared filesystem). | ✅ |
| Agent-build artifacts | `uploads/agent-builds/<orgId>/<buildId>.exe` | Unchanged (builds run on a Windows host, see §8). On Vercel builds are refused up front. | ⚠️ (external host) |
| Reports (PDF/Excel) | Generated **in-memory** (pdfkit buffer collector, xlsx) | In-memory; no temp-file dependency | ✅ |
| Webcam relay | In-memory frame buffer (TTL 60 s, ≤ 16 sessions) inside the app | In-memory; per serverless instance, frames are never persisted | ✅ (per-instance) |
| Dev crypto key | `.worklens/dev.key` (gitignored) | Dev-only; production requires `ENCRYPTION_KEY` | ✅ |

**Bug found & fixed during this audit:** the local storage driver's path resolution doubled the bucket segment (`uploads/screenshots/screenshots/<org>/<file>`, `public/uploads/avatars/avatars/<file>`). Fixed in `src/lib/storage/local.ts` to keep the legacy flat screenshot layout and the correct avatar root; pinned by new `tests/avatars-route.test.ts` (6 tests) and the full `tests/screenshots.test.ts` suite (34 tests, all passing).

## 6. Database Migration Verification (this audit)

**Stage 1 — throwaway PostgreSQL** (`prisma migrate deploy`, all 25 migrations):
- 42 tables, 203 indexes, CRUD/relations/transactions/JSON/cascade all PASS. Throwaway DB dropped after verification.

**Stage 2 — the REAL Supabase project `ujkgzgnxcmihgewkibly`** (this session, operator-configured credentials in the gitignored `.env`):
- `prisma migrate deploy` against `DIRECT_URL` (port 5432): all **25 migrations applied**; `prisma migrate status` → up to date, no drift.
- **43 application tables** (every Prisma model; the earlier "42" undercounted `SentimentRecord`) + `_prisma_migrations` = 44 in `public` — verified by a direct `pg_tables` query.
- **203 indexes** verified by a direct `pg_indexes` query.
- CRUD, relations, transactions (incl. interactive consent transitions), JSON round-trip, cascade delete — all PASS on the real DB with throwaway orgs, fully removed afterward (0 orphan rows verified).

## 7. Realtime / Live Monitor Audit

- The Live Monitor uses **Socket.IO** pushed events from a **separate long-running service** (`mini-services/live-updates`, port 3010) that polls the database for real changes (5 s poll + `pg_notify` wake-ups), scopes every broadcast to the authenticated user's org room, and never fabricates events.
- This service **cannot run on Vercel** (persistent WebSocket server). It is designed to run on a VM/container (or locally via `npm run dev:live`) and connects to the same Supabase database with the same `JWT_SECRET`. This is the intended architecture — the Vercel app keeps working without it (all pages read from the DB; React Query polling covers the dashboards), and the realtime feed activates once the external service is deployed. No fake compatibility was introduced.
- Auth on the socket: JWT handshake or httpOnly session cookie, `UserSession` revocation re-validated, org derived from the token — tenant/RBAC boundaries are unchanged.
- The webcam frame relay is in-app (not the socket service) and is not affected by Vercel beyond being per-instance (frames are in-memory, TTL-bounded, never persisted).

## 8. Desktop Agent & Vercel Boundary

The Windows desktop agent (`desktop-agent/`) is a **separate client** and is explicitly not forced into Vercel:

- `probeBuildHostCapability()` in `src/lib/agent-software.ts` returns `capable:false` on Vercel with a clear reason; the admin UI never pretends a build ran and records the failure with guidance (build on a Windows CI host / self-hosted runner).
- The agent talks to the web/API over HTTPS only; server URLs are validated by the canonical env-aware policy (`https://` mandatory in production).
- Agent API routes (`/api/agent/*` — register, authenticate, discover, activity, screenshot, keystroke, location, usb, policy-violations, webcam, heartbeat, commands, consent, config) are all Vercel-compatible Node handlers; the Supabase migration changes only where the *bytes* are stored, not the protocol.

## 9. Background Jobs (instrumentation)

`src/instrumentation.ts` starts two interval schedulers (maintenance jobs, project-time sync) guarded to the Node runtime (`NEXT_RUNTIME === 'nodejs'`) with crash-safe `JobRun` leases. On Vercel this is **best-effort** (timers only fire while a serverless instance is warm). Deterministic cadence is available via `npm run jobs` (Vercel Cron) — see DEPLOYMENT-SUPABASE-VERCEL.md. The leases make concurrent runners safe (only one instance executes each job).

## 10. Environment Variable Inventory

| Variable | Consumed by | Required | Scope | Notes |
|---|---|---|---|---|
| `DATABASE_URL` | Prisma client, realtime service, tests | **Required** | server | Supabase pooled URL on Vercel |
| `DIRECT_URL` | Prisma Migrate / DDL | **Required for migrations** | server | Supabase direct URL; same as `DATABASE_URL` on plain PG |
| `JWT_SECRET` | auth, realtime service | **Required** | server | ≥ 16 chars, shared across services |
| `SUPER_ADMIN_EMAIL` / `SUPER_ADMIN_PASSWORD` | bootstrap + dev seed | Required (bootstrap) | server | strong password enforced |
| `ENCRYPTION_KEY` | crypto (AI keys) | Required in prod | server | ≥ 16 chars, independent of `JWT_SECRET` |
| `STORAGE_DRIVER` | storage | optional (`local` default) | server | `supabase` on Vercel |
| `SUPABASE_URL` | storage driver | required when `STORAGE_DRIVER=supabase` | server | never `NEXT_PUBLIC_` |
| `SUPABASE_SERVICE_ROLE_KEY` | storage driver | required when `STORAGE_DRIVER=supabase` | **server-only** | never exposed to the browser |
| `JWT_EXPIRES_IN` | auth | optional | server | default `7d` |
| `SESSION_COOKIE_NAME` | auth, realtime | optional | server | default `worklens_token` |
| `NEXT_PUBLIC_LIVE_UPDATES_URL` | browser socket client | optional | **public (client)** | non-secret; endpoint URL only |
| `LIVE_UPDATES_PORT` | realtime service | optional | server | default 3010 |
| `ALLOWED_ORIGIN` | realtime service CORS | optional | server | must match app origin in prod |
| `JOBS_INTERVAL_SECONDS` | instrumentation | optional | server | default 3600 |
| `PROJECT_TIME_SYNC_INTERVAL_SECONDS` | instrumentation | optional | server | default 60 |
| `PRESENCE_ONLINE_THRESHOLD_MS` | presence (app + service) | optional | server | default 300000 |
| `NODE_ENV` | Next/Node | set by platform | — | |
| `VERCEL` | agent-software capability probe | set by platform | — | `1` on Vercel |
| `AGENT_SERVER_URL` / `AGENT_ENROLLMENT_CODE` / `WL_ENROLLMENT_CODE` | desktop-agent build scripts | optional | server (build host) | agent packaging only |
| `PG_TEST_BASE_URL` | test suite only | tests only | — | never set in prod |

`.env.example` and `.env.production.example` were rebuilt from this inventory with placeholders only. No fake variables were added. `OPENAI_API_KEY` and similar are **not** environment variables — AI provider keys are stored encrypted in `SystemSetting` and set through the admin UI.

## 11. Security / GitHub Readiness

- **Secret scan (tracked files):** no API keys, JWT material, private keys, passwords, service-role keys, or `.env` files — only `.env.example` / `.env.production.example` (placeholders) are tracked. Git history contains no `.env` files.
- `.gitignore` covers `.env*` (with the two example templates allow-listed), `node_modules`, `.next`, `uploads/` (including `public/uploads`), `*.db`, `.worklens/`, `.vercel`, desktop-agent build outputs, backups, and logs.
- Working tree contains only the intended source changes + new `src/lib/storage/` + `tests/avatars-route.test.ts`; generated/ignored artifacts are ignored correctly.
- No hardcoded secrets, no `http://localhost` baked into app code (only dev scripts and the documented Ollama localhost default), no `Math.random()` in production paths, no demo/mock data in the production path (dev seed is hard-guarded).
- Logging redaction verified; health endpoints leak nothing; error responses are generic.

## 12. Status Legend

- **COMPLETED** — implemented and evidenced in this repository (code, config, or verification gate). This now includes: real Supabase connectivity, all 25 migrations applied, 43 tables + 203 indexes verified, Super Admin bootstrap (idempotent) + login/RBAC/session revocation, production-server smoke test, and the controlled agent flow + tenant-isolation run — all against the real project with cleanup.
- **EXTERNAL DEPENDENCY** — architectural by design; must run outside Vercel (realtime Socket.IO service, Windows agent-build host).
- **OPERATOR ACTION REQUIRED** — remaining items that need the operator: paste the real `SUPABASE_SERVICE_ROLE_KEY` into the gitignored `.env`, run the storage-bucket provisioning (private `screenshots` + public `avatars`) + screenshot end-to-end check, then GitHub repo creation + Vercel import/deploy. Never print or commit these values.

## 13. Remaining Risks / Notes (non-blocking)

1. **Realtime service on Vercel** — must be hosted outside Vercel (documented; the app degrades gracefully to polling).
2. **Background jobs on Vercel** — in-process intervals are best-effort; use Vercel Cron → `npm run jobs` for determinism (documented).
3. **Agent builds on Vercel** — intentionally disabled with a clear UI message; builds require a Windows CI host.
4. **Agent-build artifacts** are local to the build host (`uploads/agent-builds`); on Vercel-deployed orgs, attach the installer produced on the CI host (see deployment doc). A future enhancement could push artifacts to Supabase Storage; out of scope for this audit.
5. **`output: "standalone"`** in `next.config.ts` is inert on Vercel (used by self-hosted deployments) — no change needed.
6. `bun.lock` exists alongside `package-lock.json` for the realtime service's dev runner; Vercel installs with npm. No action required.
