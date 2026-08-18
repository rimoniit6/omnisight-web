# OmniSight — Production Readiness Certification

Certification date: 2026-08-18 (updated after real-Supabase provisioning) · Target stack: **Supabase PostgreSQL + GitHub + Vercel**

This certification records only results that were actually executed. Nothing is claimed without evidence. All Supabase evidence below was collected against the **real** operator project `ujkgzgnxcmihgewkibly`.

---

## 0. Status Matrix (COMPLETED / EXTERNAL DEPENDENCY / OPERATOR ACTION REQUIRED)

| Area | Status | Notes |
|---|---|---|
| PostgreSQL schema + migrations (25) | **COMPLETED** | applied to the **real Supabase DB** via `npm run db:deploy` (25/25) |
| Prisma generate / validate / migrate deploy | **COMPLETED** | all verified; `prisma migrate status` shows 25 applied / 0 pending on Supabase |
| SQLite removal | **COMPLETED** | 0 references; old migrations archived |
| Storage driver abstraction | **COMPLETED** | local + Supabase drivers; local path bug fixed |
| Avatar serving route (/uploads/avatars/[filename]) | **COMPLETED** | driver-backed, security-tested |
| Avatar + screenshot upload/read authorization | **COMPLETED** | org-scoped routes, magic-byte validation (verified on real DB) |
| `.env.example` / `.env.production.example` | **COMPLETED** | rebuilt from the real env inventory, placeholders only |
| GitHub readiness (secret scan, .gitignore, history) | **COMPLETED** | clean (re-verified this session) |
| Build / typecheck / lint / tests | **COMPLETED** | **1131 tests, 0 failures** (full suite), tsc 0, eslint 0, `next build` exit 0 |
| Supabase connectivity | **COMPLETED** | pooler 6543 + direct 5432 verified reachable; DB connection + migrations + queries all exercised against the real project |
| Database migration + verification on Supabase | **COMPLETED** | 25 migrations applied; **43 application tables** (+`_prisma_migrations` = 44 in `public`); 203 indexes; CRUD/relations/transactions/JSON/cascade PASS |
| Super Admin bootstrap against Supabase | **COMPLETED** | idempotent (run twice — no duplicate); login + authorized admin API verified over real HTTP |
| Real-Supabase application smoke test | **COMPLETED** | health / DB health / 401 gates / login / session revocation / authorized read all verified on the production server against Supabase |
| Controlled agent flow + tenant isolation on Supabase | **COMPLETED** | 15 checks PASS (auth, device, consent, activity, persistence, admin retrieval, cross-org concealment) + screenshot upload correctly **BLOCKED** (see below) — throwaway orgs fully cleaned up |
| Storage buckets (private `screenshots`, public `avatars`) | **OPERATOR ACTION REQUIRED** | the service-role key in `.env` is still the literal placeholder `__OP_SERVICE_ROLE_KEY__`; Supabase's Storage API rejects it (`403 Invalid Compact JWS`). Once the real key is in `.env`, run the documented provisioning (server-side, buckets created/verified not recreated) |
| Screenshot upload end-to-end (object storage) | **OPERATOR ACTION REQUIRED** | same service-role-key dependency; the app's fail-closed behavior is verified (403 → 0 rows) |
| Realtime Socket.IO service | **EXTERNAL DEPENDENCY** | must run on a VM/container outside Vercel — not yet deployed |
| Windows agent-build host | **EXTERNAL DEPENDENCY** | builds run on Windows CI — Vercel refuses builds by design |
| GitHub push + Vercel deployment | **OPERATOR ACTION REQUIRED** | repo is ready; import + env vars + deploy documented in DEPLOYMENT-SUPABASE-VERCEL.md |

## 1. Environment

| Item | Value |
|---|---|
| Node.js | v24.14.0 (Vercel's Node 22 runtime is supported) |
| Package manager | npm (lockfile `package-lock.json`); bun only for the realtime dev runner |
| Framework | Next.js 16.3.0 (App Router, `src/proxy.ts` middleware) |
| React / TypeScript | React 19.2.8 / TypeScript 5.9.3 |
| Prisma | 6.19.3 (client + CLI) |

## 2. Database (REAL Supabase project `ujkgzgnxcmihgewkibly`)

| Check | Result | Evidence |
|---|---|---|
| Provider | PostgreSQL (Supabase) | `prisma/schema.prisma`: `provider = "postgresql"`, `url = env("DATABASE_URL")` + `directUrl = env("DIRECT_URL")` |
| Runtime connection | **PASS** | `DATABASE_URL` = transaction pooler `aws-0-ap-northeast-1.pooler.supabase.com:6543?pgbouncer=true&connection_limit=1` — all runtime queries/login/agent flows exercised over it |
| Direct/migration connection | **PASS** | `DIRECT_URL` = `:5432` (no pooler params) — `npm run db:deploy` and `prisma migrate status` ran over it |
| Migration status | **PASS** | `prisma migrate deploy`: all **25 migrations** applied; `prisma migrate status` → 25 applied, 0 pending, no drift |
| Prisma generation / validation | **PASS** | `npx prisma generate` exit 0; `npx prisma validate` exit 0 (env set) |
| Tables | **PASS** | 43 application tables (every Prisma model) + `_prisma_migrations` = 44 in `public`; verified by direct `pg_tables` query through Prisma |
| Indexes | **PASS** | 203 indexes incl. activity/telemetry/device query paths; verified by `pg_indexes` query |
| CRUD / relations / cascade | **PASS** | org → department → employee create/read/update; activity FK; org delete cascaded all throwaway rows to 0 (verified zero orphans) |
| Transactions | **PASS** | `$transaction` rollback + interactive transactions (consent transitions) exercised repeatedly on Supabase |
| JSON fields / timestamps | **PASS** | `PolicyViolation.metadata` Json round-trip; `createdAt`/`updatedAt` defaults verified |
| Connection test | **PASS** | `/api/health/database` → 200 `{database:"reachable", bootstrap:"complete"}` on the running production server |
| SQLite | Removed | 0 references in active code; archived under `prisma/migrations-sqlite-archive/` (inactive) |
| Destructive-safety | `db push` hard-refuses production; `migrate reset` never used | `scripts/db-push-dev.mjs`; only `migrate deploy` against Supabase |

## 3. Production issues found & fixed by real-Supabase verification

The real-Supabase run surfaced three issues that only appear against a remote **transaction-mode pooler** — none reproducible on a local Postgres. All three were fixed in the source and re-verified:

| Severity | Issue | Root cause | Fix | Verified by |
|---|---|---|---|---|
| HIGH | Login intermittently failed `PrismaClientKnownRequestError: Transaction API error: Transaction not found` | Supabase transaction pooler (6543, `pgbouncer=true`) + Prisma interactive transactions: the pooler can route the transaction's statements to different backend connections | Added Prisma's canonical pooler parameter `connection_limit=1` to `DATABASE_URL` (pooler architecture untouched) | 6/6 consecutive logins stable after fix; full agent flow + suite after |
| MEDIUM | `applyConsentTransition` deadlocked on a 1-connection pooler (`Transaction API error: Transaction not found`/timeout) | Inside a `$transaction` callback the transition resolved the published policy through the **top-level** `db` — a nested connection wait while the pool holds the only connection | `src/lib/consent.ts` now resolves the policy through the **same transaction client** (`tx`) | agent-flow consent grant/revoke PASS on Supabase |
| LOW | Interactive transaction exceeded Prisma's default 5 s timeout on a cold remote pooler (~1.7 s/round-trip) | ap-northeast-1 latency + several sequential queries inside one transaction | `src/lib/db.ts`: bounded, generous interactive-transaction timeout (15 s) via the existing `$transaction` wrapper | consent transitions + full suite PASS |

Also verified-by-design: **all test suites now pin `STORAGE_DRIVER=local`** where they assert against the local filesystem (`screenshots`, `zero-touch`, `avatars-route`, `consent`, `daily-summary-hardening`, `multi-org-isolation`). Without the pin, a developer's `.env` (which selects `supabase` for real deployments) leaks into the test process via Next's env loading. This is test-isolation hygiene, not a product change.

## 4. Storage (Supabase)

| Bucket | Required | Status | Evidence |
|---|---|---|---|
| `screenshots` | **PRIVATE** — sensitive workforce data | **NOT CREATED YET** | server-side provisioning via the service-role key is blocked while `.env` holds the placeholder token. Fail-closed behavior verified: screenshot POST with consent returns 403 `Invalid Compact JWS` and **persists 0 rows** (verified on the real DB) |
| `avatars` | **PUBLIC** — matches the `/uploads/avatars/[filename]` contract | **NOT CREATED YET** | same service-role-key dependency |

The storage access model is **exclusively server-side** (Prisma + the storage driver; no browser Supabase client, no RLS surface). Never create the screenshots bucket public; access stays behind app authorization + signed URLs. Exact provisioning commands are in `DEPLOYMENT-SUPABASE-VERCEL.md` Step 1.

## 5. Authentication / Authorization (verified on real Supabase)

| Check | Result | Evidence |
|---|---|---|
| Super Admin bootstrap | **PASS** | `scripts/bootstrap-super-admin.ts` exit 0; **idempotent** (second run left the account unchanged, no duplicate) |
| Super Admin login | **PASS** | real HTTP POST `/api/auth/login` → 200, token issued, response contains **no password/hash field** |
| Session revocation | **PASS** | logout → revoked cookie → subsequent authorized call 401 (server-side revocation, verified over HTTP) |
| Unauthenticated protected API | **PASS** | `/api/employees` → 401 JSON (not HTML), before auth |
| RBAC + org scope | **PASS** | admin A vs admin B cross-org concealment (activities, employees, screenshots list) — all 404/empty on the real DB |
| Invalid login | **PASS** | wrong password → 401, no user enumeration in the error |
| Agent auth (PATH A) / invalid secret | **PASS** | device token issued after approval; wrong secret → 401 |
| Consent enforcement | **PASS** | activity POST without/revoked `activity_tracking` → 403; after grant → 200 + persisted (verified on real Supabase) |

## 6. Build & Quality Gates (re-run after the fixes above)

| Check | Result | Evidence |
|---|---|---|
| TypeScript (`tsc --noEmit`) | **PASS** — 0 errors | exit 0 |
| Lint (`eslint .`) | **PASS** — 0 errors, 142 warnings | all warnings are pre-existing `no-unused-vars` in test files |
| Production build (`next build`) | **PASS** — exit 0 | route manifest includes `/uploads/avatars/[filename]` + `ƒ Proxy (Middleware)` |
| Prisma generate / validate | **PASS** | both exit 0 against the real Supabase env |

## 7. Tests Executed

| Scope | Result | Evidence |
|---|---|---|
| **Full suite** — all `tests/*.test.ts` (76 files) | **PASS — 1131 tests, 0 failures** | `npx tsx --test tests/*.test.ts` exit 0 (final run after all fixes) |
| Representative baseline (the certified 160) | **PASS** | health / super-admin / agent-auth-login / agent-software-build / screenshots (34) / zero-touch / rate-limit-shared / telemetry-backend / avatars-route (6) — all green |
| Storage suites (local-driver assertions) | **PASS** | `screenshots` (34) + `zero-touch` (39) + `avatars-route` (6) + `consent` (27) + `daily-summary-hardening` + `multi-org-isolation` (54) |

Each suite provisions and drops its own throwaway PostgreSQL database. Production (Supabase) data was only ever touched by the controlled agent-flow verification, which deleted every throwaway row (verified 0 orphans: employees/devices/claims/consents).

## 8. Real-Supabase integration evidence (this session)

| Check | Result |
|---|---|
| Supabase DB connection (pooler + direct) | **PASS** |
| 25 migrations applied / 0 pending | **PASS** |
| 43 app tables + 203 indexes match schema | **PASS** |
| CRUD / relations / transactions / JSON / cascade | **PASS** (throwaway orgs, fully removed) |
| Super Admin bootstrap + idempotency | **PASS** |
| Production-server smoke (health, DB health, auth gates, login, authorized read) | **PASS** |
| Agent flow (discover 201 → approve → PATH A auth → consent → activity 200 → persisted → admin retrieval → tenant isolation) | **PASS** (15 checks) |
| Screenshot upload (object storage) | **BLOCKED — needs the real service-role key** (fail-closed behavior verified) |
| Cleanup | **PASS** — zero leftover probe rows in the real DB |

## 9. Final Certification

**CONDITIONALLY PRODUCTION READY**

What is now verified against the **real** Supabase project: database connectivity (pooled + direct), all 25 migrations, 43 tables, 203 indexes, CRUD/relations/transactions/JSON/cascade, Super Admin bootstrap + login + session revocation + RBAC, the production server smoke, and the controlled agent flow with tenant isolation. Build gates: tsc 0, eslint 0, **1131 tests / 0 failures**, `next build` exit 0.

The remaining dependencies are operational, not code defects:

1. **Storage provisioning** (`screenshots` private + `avatars` public buckets) — blocked only by the service-role key placeholder in the gitignored `.env` (OPERATOR ACTION REQUIRED; the exact one-time command sequence is in `DEPLOYMENT-SUPABASE-VERCEL.md`).
2. **Realtime Socket.IO service** on an external always-on host — EXTERNAL DEPENDENCY, not yet deployed; the app degrades to polling without it.
3. **Windows agent-build host/CI** — EXTERNAL DEPENDENCY by design.
4. **GitHub push + Vercel import/deploy** — OPERATOR ACTION REQUIRED (all prerequisites pass; exact steps in `DEPLOYMENT-SUPABASE-VERCEL.md`).

No critical blocker remains in the codebase. The certification upgrades to **PRODUCTION READY** only after: the buckets are provisioned with the real key, the external realtime service is deployed, and the Vercel deployment is verified against the production URL.
