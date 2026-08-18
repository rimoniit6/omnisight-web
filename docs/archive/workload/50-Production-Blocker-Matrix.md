# WorkLensAI — Final Production Blocker Matrix

Date: 2026-08-10
Scope: Phase G go-live certification. Baseline: Phase F verdict = PRODUCTION CANDIDATE.

Status legend: ✅ PASS · ❌ FAIL · 🔒 BLOCKED (cannot be executed in this environment) · ⚠️ NOT VERIFIED

---

## P1 — Production Blockers

### B-01 PostgreSQL not implemented (production is SQLite)

| Field | Value |
|---|---|
| Current status | ❌ **OPEN** — schema provider is `sqlite`; `db/custom.db` (SQLite) is the active database |
| Evidence | `prisma/schema.prisma:9` `provider = "sqlite"`; `.env.example` `DATABASE_URL=file:./db/custom.db`; 29 migrations are SQLite-flavored (contain `PRAGMA`, `AUTOINCREMENT` table-rebuild patterns); **no `pg_isready`/`psql`/Docker in this environment** |
| Production impact | SQLite is single-writer, file-locked, unsuitable for concurrent multi-admin + agent load; no network access for a hosted deployment |
| Required action | Adopt PostgreSQL: provider switch + migration regeneration + connection pooling. Prepared plan + schema artifact in `workload/51` |
| Files/configuration | `prisma/schema.prisma`, `prisma/migrations/*`, `.env.production.example` (`DATABASE_URL=postgresql://…`), `src/lib/db.ts` |
| Verification method | Fresh PostgreSQL → `prisma migrate deploy` → seed → full zero-touch/consent E2E → backup |
| PASS/FAIL | 🔒 **BLOCKED — PostgreSQL provisioning required** (no PG server/Docker available in this environment; live migration cannot be executed) |
| Remaining risk | SQLite remains the only *executed* database. PG plan is code-complete but unverified live |

### B-02 Clean-machine certification not executed

| Field | Value |
|---|---|
| Current status | ❌ **OPEN** |
| Evidence | No Windows VM/machine available; `scripts/clean-machine-certification.ps1` + `docs/clean-machine-certification.md` exist |
| Production impact | The core "employee does nothing" acceptance test has never been witnessed on a truly clean host |
| Required action | Run the existing script/runbook on a fresh Windows VM; record evidence per `workload/55` |
| Files/configuration | `scripts/clean-machine-certification.ps1`, `docs/clean-machine-certification.md`, `workload/55` |
| Verification method | Fresh VM: install EXE → auto-start → silent discover → admin approve → auto-auth → reboot → identity unchanged |
| PASS/FAIL | 🔒 **BLOCKED — no clean Windows VM available** |
| Remaining risk | Unverified end-to-end on clean hardware |

### B-03 Windows installer unsigned

| Field | Value |
|---|---|
| Current status | ❌ **OPEN** — electron-builder logs `no signing info identified, signing is skipped` |
| Evidence | `desktop-agent/out/builder-effective-config.yaml` (no `win.certificateFile`/CSC env); builder output in Phase G build |
| Production impact | SmartScreen "unknown publisher" warning; untrusted deployment for enterprise fleets |
| Required action | Provision an Authenticode/OV cert, set `CSC_LINK` + `CSC_KEY_PASSWORD`, rebuild, `signtool verify`. Scaffold prepared in `workload/54` |
| Files/configuration | `desktop-agent/electron-builder.yml` (win signing block), CI secrets |
| Verification method | `signtool verify /pa` on installer + unpacked EXE; Windows file properties → Digital Signatures |
| PASS/FAIL | 🔒 **BLOCKED — CERTIFICATE PROVISIONING REQUIRED** (no cert/signtool in this environment) |
| Remaining risk | Every released installer to date is unsigned |

### B-04 Backup/restore test not executed

| Field | Value |
|---|---|
| Current status | ❌ **OPEN** (was documented-only) |
| Evidence | `workload/46` documented procedures; no restore was ever performed |
| Production impact | Undiscovered restore defects → silent data loss on a real incident |
| Required action | **Performed in this phase for SQLite** (see B-04a). PostgreSQL restore remains to be executed |
| Files/configuration | `workload/52` |
| Verification method | BACKUP → DELETE/RESET test DB → RESTORE → integrity + row-count + app queries |
| PASS/FAIL | ✅ **SQLite PASS (executed this phase)** · 🔒 **PostgreSQL restore BLOCKED (no PG)** |
| Remaining risk | PG restore path unverified live |

### B-05 Live HTTPS not verified

| Field | Value |
|---|---|
| Current status | ❌ **OPEN** |
| Evidence | `Caddyfile` exists (port 81, proxies 3000/3010, no TLS block/domain); `next.config.ts` sets HSTS/CSP; cookies `secure: NODE_ENV==='production'`; no domain/TLS in this environment |
| Production impact | Plain HTTP in production would leak session cookies and agent data |
| Required action | Configure real domain + Caddy TLS (Let's Encrypt), HTTP→HTTPS redirect, WSS; live request test |
| Files/configuration | `Caddyfile`, `.env.production.example` |
| Verification method | `curl -I https://…` (cert chain), redirect check, secure-cookie flag, WSS upgrade |
| PASS/FAIL | 🔒 **BLOCKED — domain/TLS provisioning required** (config-only verification in `workload/53`) |
| Remaining risk | No live HTTPS has ever been exercised |

## P2 — Recommended

### B-06 Windows Service not implemented (login-item only)

| Field | Value |
|---|---|
| Current status | ⚠️ **PARTIAL** — login-item startup works (`app.setLoginItemSettings`), runtime is main-process (independent of window); no Windows Service |
| Evidence | `desktop-agent/src/main/main.ts` (applyAutoStart, single-instance lock, tray persistence, window-close→hide); Phase E verified background runtime |
| Production impact | Agent runs in the user session; stops at logout. Acceptable for a user-session monitoring agent (documented decision in `workload/56`) |
| Required action | Decide service vs session runtime. Analysis in `workload/56`; no code change unless a before-login mandate appears |
| Files/configuration | `desktop-agent/src/main/main.ts` |
| Verification method | Logout/login, reboot, UI-closed runtime continuity |
| PASS/FAIL | ✅ **Session-runtime design decision documented** · 🔒 Windows Service execution NOT VERIFIED (no VM) |
| Remaining risk | No monitoring between logout and next login |

### B-07 Agent v1 → v2 update test not executed

| Field | Value |
|---|---|
| Current status | ⚠️ **PARTIAL** — v1.1.0 build artifact produced this phase; live in-place upgrade NOT executed (no second Windows machine) |
| Evidence | `workload/57` (build hashes, identity-preservation config `deleteAppDataOnUninstall:false`, upgrade path analysis) |
| Production impact | Upgrade regressions (identity/credentials loss) would force device re-approval fleet-wide |
| Required action | Real v1.0.0→v1.1.0 install-over on a Windows test machine |
| Files/configuration | `desktop-agent/package.json`, `electron-builder.yml`, `out/` artifacts |
| Verification method | Install v1.0.0 → enroll → install v1.1.0 over it → verify identity/assignment/consent + reconnect + no duplicate device |
| PASS/FAIL | ⚠️ **Artifact PASS; live upgrade NOT VERIFIED** |
| Remaining risk | Upgrade path unverified on real hardware |

### B-08 Performance baseline not measured

| Field | Value |
|---|---|
| Current status | ✅ **CLOSED this phase** — real measurements recorded in `workload/58` |
| Evidence | `workload/58-Production-Performance-Baseline.md` (P50/P95/P99 on representative DB + agent operations against the real SQLite DB) |
| Production impact | — (baseline now exists; PG numbers must be re-measured after migration) |
| Required action | Re-measure after PostgreSQL adoption |
| Files/configuration | `workload/58` |
| Verification method | Timed query/operation runs |
| PASS/FAIL | ✅ PASS (SQLite baseline) |
| Remaining risk | PG re-baseline pending |

## P3 — Future

### B-09 External monitoring absent

| Field | Value |
|---|---|
| Current status | ⚠️ **PARTIAL** — internal health endpoints exist and are verified (`/api/health`, `/api/health/database`); no external uptime/alerting integration provisioned |
| Evidence | `workload/59` (endpoint verification + integration requirements) |
| Required action | Provision UptimeRobot/Prometheus/etc. per documented requirements |
| PASS/FAIL | ✅ Internal health PASS · 🔒 External integration NOT VERIFIED |
| Remaining risk | No external alerting until provisioned |

### B-10 Live Updates WebSocket not deployment-certified

| Field | Value |
|---|---|
| Current status | ⚠️ **PARTIAL** — service code audited (JWT auth, org-room isolation, DB-polled real events, CORS restricted); graceful degradation verified in code (`devices-page` falls back to polling); live WSS on a deployed host NOT exercised |
| Evidence | `workload/60` |
| Required action | Deploy behind Caddy :81 → 3010, WSS test with 2+ admin clients |
| PASS/FAIL | ✅ Code-audit PASS · 🔒 Live WSS NOT VERIFIED |
| Remaining risk | Untested under real load/reconnects |

### B-11 Password-reset endpoint not found

| Field | Value |
|---|---|
| Current status | ✅ **CLOSED** — audited. Admin-initiated password reset exists (`PUT /api/auth/users/[id]`, admin-only, bcrypt-hashed, audit-logged). Self-service email reset is intentionally out of scope for this release (single-tenant admin console; documented recovery procedure in `workload/61`) |
| Evidence | `src/app/api/auth/users/[id]/route.ts`, `workload/61` |
| Required action | Documented: NOT REQUIRED FOR CURRENT RELEASE (admin recovery is the supported path) |
| PASS/FAIL | ✅ PASS (documented decision) |
| Remaining risk | Super-admin recovery requires DB/env access (documented) |

---

## Summary

| Severity | Total | Open/Blocked | Resolved/Verified |
|---|---|---|---|
| P1 | 5 | 5 🔒 (all require external provisioning: PG, VM, cert, domain) | 1 ✅ partial (SQLite backup/restore executed) |
| P2 | 3 | 2 ⚠️ partial | 1 ✅ closed (performance baseline) |
| P3 | 3 | 2 ⚠️ partial | 1 ✅ closed (password reset documented) |

**Net:** No P1 can be fully closed inside this sandboxed environment — each requires real-world provisioning (PostgreSQL server, Windows VM, code-signing certificate, production domain). All in-repo executable evidence has been produced. Final gate certification in `workload/66` will therefore remain **PRODUCTION BLOCKED** until those external verifications are performed.
