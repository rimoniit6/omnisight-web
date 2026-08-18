# WorkLensAI — Production Deployment Certification

Scope: `E:\Workslens\workai` (Admin Web App) + `E:\Workslens\workai\desktop-agent` (Desktop Agent)
Date: 2026-08-10
Certification phase: Phase F — Production Deployment + Operational Readiness
Audit chain: Phase D (42/43) → Phase E (44) → Phase F (45–49)

---

## Executive Verdict

> **PRODUCTION CANDIDATE**

**Rationale:**
- **PRODUCTION READY is not claimed.** The mandatory requirements that remain unverified or unimplemented are: production **PostgreSQL** (schema still SQLite), **backup + restore execution test** (procedure documented, not executed), **HTTPS/TLS** (Caddyfile provided, live TLS not verified), **clean-machine certification** (never executed), **Windows Service** background execution (login-item only), and **installer code signing** (unsigned).
- **NOT READY is not appropriate.** Every verifiable product gate passes: zero-touch (29/29), consent (27/27), security (26/28 — the 2 failures are pre-existing employee-module failures outside the zero-touch/consent boundary, verified in Phase D), desktop agent (105/105), TypeScript clean, production build succeeds, fresh-DB `prisma migrate deploy` succeeds, and no critical security or data-loss issue was found in this phase.

Per the hard verdict rules: "If any mandatory item is not verified → PRODUCTION CANDIDATE."

---

## 1. Production Infrastructure Requirements — ✅ DOCUMENTED

`workload/45-Production-Deployment-Architecture.md` documents: servers (admin app, reverse proxy, DB, live-updates WS, desktop agent), ports (81 public / 3000 + 3010 internal), env vars, domains/TLS, storage (`uploads/screenshots/`), background jobs, file permissions, and every API endpoint with auth + rate limit. No infrastructure was invented — only what exists in the repo is documented; gaps are marked explicitly.

**Gaps:** Dockerfile does not exist; Live Updates WS (`mini-services/live-updates/`) not deployment-certified; monitoring/alerting external integrations absent.

---

## 2. Environment Variables — ✅ PASS

- `.env.production.example` created — names + safe placeholders only, no real secrets.
- Verified: no secrets committed to git (`.env` gitignored); no dev credentials in production paths; `JWT_SECRET`/`ENCRYPTION_KEY` are env-driven with fail-fast production behavior (`src/lib/crypto.ts`); no hardcoded API keys; seed credentials only in `src/lib/seed.ts` (dev bootstrap, documented).

---

## 3. Database Production Setup — ⚠️ WARNING

| Item | Status |
|------|--------|
| PostgreSQL configured | ❌ **Schema is still SQLite** (`provider = "sqlite"`) — PostgreSQL is intended but requires a provider change + migration regeneration |
| Migration mechanism | ✅ Production path is `prisma migrate deploy` — **`db push` is dev-only** and explicitly called out as forbidden for production |
| Fresh DB migration | ✅ `prisma migrate deploy` applied all 28 migrations on a clean DB (verified Phase E) |
| `prisma generate` | ✅ `npm run db:generate` |
| Connection pooling | ⚠️ N/A for SQLite; document for PostgreSQL when adopted |
| Backup/restore | ⚠️ Documented (workload/46); execution test NOT VERIFIED |

**Statement:** The current production database is SQLite. If PostgreSQL is the intended production target, the provider switch is a **release-blocking work item** (it is additive and safe to perform before the pilot, but must be done deliberately).

---

## 4. Database Backup + Restore — ⚠️ WARNING

- `workload/46-Database-Backup-Restore-Runbook.md` created: scheduled + manual backup, retention policy (7 daily / 4 weekly / 3 monthly), backup verification, SQLite restore, PostgreSQL `pg_dump`/`pg_restore` procedure, restore verification checklist, and a note to back up `uploads/screenshots/` alongside the DB.
- **Restore execution test: NOT VERIFIED** (no live DB was restored in this environment). Required before PRODUCTION READY.

---

## 5. HTTPS / TLS — ⚠️ WARNING

- Caddyfile provided (:81, proxies :3000 + :3010). Caddy auto-provisions Let's Encrypt when a domain is configured.
- Production domain, live TLS handshake, HTTP→HTTPS redirect, HSTS (header is set in `next.config.ts`: `Strict-Transport-Security max-age=63072000; includeSubDomains; preload`), CSP (`next.config.ts`), secure cookies (`secure: NODE_ENV === 'production'` in `src/lib/auth.ts`) — **all configured in code**, but **no live HTTPS verification was performed**.
- Agent server URL default is `http://localhost:3000` (dev-only); production must set `WORKLENSAI_SERVER_URL` to the HTTPS endpoint.

**Verdict:** TLS configuration exists; live verification NOT VERIFIED.

---

## 6. Authentication — ✅ PASS (automated)

Verified by the security suite (26/28) + code audit:
- Login/logout, JWT session validation, httpOnly cookie, 7d expiry, bcrypt password hashing (cost 12), RBAC (`super_admin`/`owner`/`admin`/`manager`/`viewer`), org isolation from token/session only.
- Viewer mutation → 403 (EMPLOYEE-10, PROJECT-15); cross-org → 404/422 (EMPLOYEE-9, PROJECT-16/17); unauthenticated → 401 (PROJECT-13).
- The 2 failures (EMPLOYEE-11/12) are pre-existing employee-CRUD failures verified in Phase D as outside the zero-touch/consent scope.
- **Password reset:** ⚠️ not found in this codebase's API inventory — flagged as a gap for the operations manual (manual admin reset via the users UI or DB is the fallback).

---

## 7. Rate Limiting — ✅ PASS

Documented in `workload/45`: login 10/5min/IP+email; agent discover 20/min/IP+key; agent authenticate 20/min/IP; device-claim writes 30/min/IP; heartbeat 600/min/token; agent writes 120/min/token; export/PDF/import/bulk/AI all centrally rate-limited in `src/proxy.ts`. Server-side, bounded, and IP is spoof-resistant (rightmost XFF / x-real-ip). In-memory store (single-instance) — documented P3.

---

## 8. Screenshot / File Storage — ✅ PASS (with note)

- Storage: local filesystem `uploads/screenshots/`, 5MB per-file cap, image-type validation, served **only** through auth-gated API routes (`/api/screenshots/[id]` is protected by the global proxy JWT middleware — it is not a public static path; Next `standalone` output does not serve `uploads/` statically).
- Retention: `runRetentionForOrg` purges DB rows **and** physical files (verified in consent.test retention tests). Deleted/expired screenshots are removed per policy.
- ⚠️ Unauthenticated-direct-URL test NOT VERIFIED live, but the architecture (files outside `public/`, served via API behind proxy auth) prevents public exposure.

---

## 9. Logging — ✅ PASS

`src/lib/logger.ts` is structured (single-line JSON), redacts passwords/tokens/JWTs/API keys/authorization headers/session cookies, and includes request correlation (`x-request-id`, ip, user-agent). `requestContext` is used across API routes. Agent logger (`desktop-agent/src/lib/logger.ts`) redacts secrets and never logs tokens. Covers discovery/approval/auth/heartbeat/consent/upload events via `log.*` calls and `auditLog` DB rows.

---

## 10. Error Monitoring / Observability — ⚠️ WARNING

- **Health endpoints implemented this phase:** `GET /api/health` (server up) + `GET /api/health/database` (DB reachable + latency). Both expose no credentials/env/secrets. Safe for public uptime monitors.
- **No external monitoring** (Prometheus/Grafana/Datadog/UptimeRobot etc.) — exact gap documented in workload/45.
- Admin can diagnose devices (status, last heartbeat, agent version, claim status) without touching the employee PC. Agent-local fields (last config sync / consent sync) not surfaced to admin — documented gap.

---

## 11. Deployment Process — ✅ DOCUMENTED

`workload/47-Production-Deployment-Runbook.md`: 17-step checklist with exact commands (backup → pull → npm ci → prisma generate → migrate deploy → build → env → Caddy → start → verify health/login/admin/agent/WS/consent/zero-touch). Deterministic and executable.

---

## 12. Rollback Plan — ✅ DOCUMENTED

`workload/48-Production-Operations-Manual.md` §13:
- Application: redeploy previous tag.
- Database: restore pre-deployment backup; **never blindly `prisma migrate rollback`** — migrations are additive; the zero-touch migration (`20260810120000_zero_touch_device_claims`) is verified additive-only (ALTER TABLE ADD COLUMN + CREATE TABLE), so code rollback does not require reverting the migration.
- Agent: downgrade EXE preserves `%APPDATA%` identity + encrypted credentials.

---

## 13. Desktop Agent Release — ✅ BUILT (UNSIGNED)

| Item | Value |
|------|-------|
| Version | 1.0.0 |
| Installer | `desktop-agent/out/WorkLensAI Agent Setup 1.0.0.exe` (82,102,332 bytes) |
| Installer SHA-256 | `a688c96858027b6a5ff6114dda34cd37bcc10b285e5a6beefad6ccbf678a5978` |
| Unpacked EXE SHA-256 | `e3225d5ea63a076c673444a47576e61791dee53e7d4de005fc65f06e88994f7a` |
| Build date | 2026-08-10 |
| Electron | 33.4.11 |
| Node (build machine) | v24.14.0 |
| Native addon | prebuilt `worklens_capture.node` packaged via `extraResources` |
| Signing | ❌ **UNSIGNED** — builder logged "no signing info identified, signing is skipped" |
| Icon | ⚠️ default Electron icon (no branded asset) |

**Statement:** **UNSIGNED RELEASE — PRODUCTION BLOCKER for environments requiring trusted Windows deployment** (SmartScreen "unknown publisher").

---

## 14. Agent Update Strategy — ⚠️ WARNING

- `UpdateService` (`desktop-agent/src/services/update-service.ts`): HTTPS-only feed (`WL_UPDATE_URL`), `autoDownload=false` / `autoInstallOnAppQuit=false` — **no silent unsigned updates**. When unset, updates are disabled entirely (safe default).
- Identity persistence: device identity + DPAPI-encrypted credentials live in `%APPDATA%\worklensai-agent\state`; installer sets `deleteAppDataOnUninstall: false`, so upgrades preserve identity/credentials/assignment.
- **v1→v2 upgrade test: NOT VERIFIED** (no second build + live upgrade executed). Required before PRODUCTION READY.

---

## 15. Data Retention — ✅ PASS

Configured via org settings (`screenshot_retention_days`, `activity_retention_days`, `report_retention_days`, `ai_insight_retention_days`, `audit_log_retention_days`, `consent_log_retention_days`). Verified in consent.test: operational data purged (including physical screenshot files), compliance records anonymized (userId/ip/performedBy nulled, `anonymizedAt` set), idempotent runs, job leases prevent duplicate workers. Scheduled hourly via `instrumentation.ts`.

---

## 16. Disk / Storage Protection — ✅ PASS (with note)

- 5MB per-screenshot cap; bounded client spool (max 50 files / 250MB, oldest dropped); 100 activities/request cap; retention job purges old data; rate limits bound intake.
- Screenshot writes fail gracefully on disk-full (server returns 500, client spools + retries with backoff) — the server does not crash.
- ⚠️ Disk-usage monitoring must be wired to the ops alerting (currently manual `df -h`).

---

## 17. Security Scan — ✅ PASS

Searched: TODO/FIXME/HACK/debugger (0 matches in production code), `disableAuth`/`skipAuth` (only a legitimate client-side `use-auth-fetch` option, no server bypass), hardcoded `password=`/`token=`/`apiKey=` (0 in non-test, non-seed code), `console.log` in agent/device-claims routes (0 — routes use the structured logger). `Math.random` — the two token/secret uses were eliminated in Phase D; remaining uses are IDs, backoff jitter, and seed/UI-skeleton cosmetics (none security-sensitive). **No critical findings.**

---

## 18. Performance Baseline — ⚠️ WARNING

- Code-level review found: bounded `findMany` (pageSize caps), composite indexes on high-frequency query paths (`employeeId+timestamp`, `projectId+date`, `organizationId+status+createdAt`), batched consent state (2 queries per 8 types), server-side search/pagination/sorting. No unbounded queries identified on high-volume endpoints.
- **Latency baselines NOT measured** (no live load test in this environment). Recommended pre-pilot: record login/dashboard/list/agent-endpoint latencies as a baseline.

---

## 19. Pilot Readiness — ⚠️ NOT VERIFIED

The pilot (1–5 machines, several working days) has **not been run**. Before it: switch to PostgreSQL, verify HTTPS live, execute the backup/restore test, and run the clean-machine certification. Agent stability/CPU/RAM/network/reboot/reconnect/update behavior must be observed on the pilot machines.

---

## 20. Clean-Machine Test — ❌ NOT VERIFIED

Never executed (documented since Phase C; runbook + evidence script exist: `docs/clean-machine-certification.md`, `scripts/clean-machine-certification.ps1`). Mandatory for PRODUCTION READY.

---

## 21. Windows Service / Background Agent — ⚠️ WARNING

- **Background execution is implemented** — the monitoring runtime (discovery, auth, heartbeat, config/consent sync, collectors, queue, scheduler) runs in the Electron **main process**, independent of the window; closing the window keeps monitoring running (tray). Verified by tests (105/105) and architecture review.
- **Windows Service-grade execution is NOT implemented** — login-item only (`app.setLoginItemSettings`), runs in the user session, stops at logout, no before-login/session-independent operation. Explicitly reported as a production gap.

---

## 22. Test Results Summary

| Suite | Result |
|---|---|
| Backend zero-touch | ✅ 29/29 |
| Backend consent | ✅ 27/27 |
| Backend security | ⚠️ 26/28 (2 pre-existing, out of scope — verified Phase D) |
| Backend projects | ✅ 17/17 |
| Desktop agent | ✅ 105/105 |
| Admin TypeScript | ✅ clean |
| Agent TypeScript | ✅ clean |
| ESLint | ✅ 0 errors |
| Fresh-DB `prisma migrate deploy` | ✅ all 28 migrations applied |

---

## 23. Files Changed (Phase F)

| File | Change |
|------|--------|
| `src/app/api/health/route.ts` | **Created** — public health endpoint (no secrets) |
| `src/app/api/health/database/route.ts` | **Created** — DB connectivity + latency check (no secrets) |
| `.env.production.example` | **Created** — production env template (placeholders only) |
| `workload/45-Production-Deployment-Architecture.md` | **Created** — architecture, ports, env vars, storage, gaps |
| `workload/46-Database-Backup-Restore-Runbook.md` | **Created** — backup/restore procedures + verification checklist |
| `workload/47-Production-Deployment-Runbook.md` | **Created** — deterministic 17-step deploy procedure |
| `workload/48-Production-Operations-Manual.md` | **Created** — daily ops, troubleshooting, emergency procedures |
| `workload/49-Production-Deployment-Certification.md` | **Created** — this certification |
| `desktop-agent/out/WorkLensAI Agent Setup 1.0.0.exe` | **Built** — production installer (unsigned) |

---

## 24. Exact Blockers

| ID | Severity | Blocker |
|----|----------|---------|
| FB-1 | **P1** | **PostgreSQL not implemented** — schema provider is SQLite; required for the intended production architecture |
| FB-2 | **P1** | **Clean-machine certification never executed** — mandatory for PRODUCTION READY |
| FB-3 | **P1** | **Installer unsigned** — "UNSIGNED RELEASE — PRODUCTION BLOCKER for environments requiring trusted Windows deployment" |
| FB-4 | **P1** | **Backup + restore execution test not performed** (procedure documented) |
| FB-5 | **P1** | **Live HTTPS/TLS verification not performed** (config present; domain not deployed) |
| FB-6 | **P2** | **Windows Service** not implemented (login-item only; stops at logout) |
| FB-7 | **P2** | **Agent v1→v2 update test not executed** (update service is HTTPS-gated and safe by default) |
| FB-8 | **P2** | **Performance baseline not measured** (no load test) |
| FB-9 | **P2** | Auto-start defaults off; server URL env-only; `rebuild-native` script malformed; default icon |
| FB-10 | **P3** | External monitoring integrations absent; Live Updates WS not deployment-certified; password-reset endpoint not found |

---

## 25. Final Verdict

> ## PRODUCTION CANDIDATE

Every verifiable product gate in this certification passes (zero-touch, consent, security boundary, migration determinism, installer build, health checks, logging, retention, rollback plan, deployment runbook). The blockers that keep this from PRODUCTION READY are **operational/verification gaps** — PostgreSQL adoption, clean-machine certification, live HTTPS + backup/restore tests, installer signing, and Windows Service execution — none of which are product-code defects. NOT READY is not appropriate because no critical security or data-loss issue was found.
