# WorkLensAI — Progress Log (append-only)

> **Rule:** never overwrite or delete previous entries. Always append. One dated entry per working session.
> Format: **Date → Completed / Fixed / Next**

---

## 2026-08-02

**Completed:**
- Resolved P2021 "table `main.User` does not exist" — root cause: `.env` `DATABASE_URL` changed from absolute path to `file:./db/custom.db`, which Prisma resolves relative to `prisma/schema.prisma` → empty decoy DB `prisma/db/custom.db`. Fix: `.env` → `file:../db/custom.db` (verified end-to-end: login 200, admin found, 36 users intact).
- Completed full **functional audit** (architecture, 33 API routes, 76 components, DB, auth, security, tests, deployment). Live-verified: login/rate-limit/logout, dashboard rendering (no console errors), auth bypass (bogus headers → 200), credential leak (`passwordHash`/`twoFactorSecret` returned by `/api/users`), fake analytics data (`Math.random`).
- Created the **product roadmap** (4 phases) + workload management system (`workload/`): Roadmap, Backlog (60+ items), Sprint-01, Sprint-02, Completed, Known-Issues, Architecture-Decisions (10 ADRs), Future-Ideas.
- Conducted **market research** on Teramind/ActivTrak/Insightful/Hubstaff/Time Doctor/DeskTime/Veriato/Kickidler → captured core must-haves, review pain points, CodeCanyon positioning.

**Fixed:**
- Authentication/database issue: P2021 (above).
- Audit findings C1–C4, H1–H10, M1–M10, L1–L6 → **recorded in Known-Issues.md, tracked in Backlog.md (BL-001…BL-606)**. Not yet implemented.

**Next:**
- Sprint 01 kickoff: security hardening (BL-001…BL-008, BL-111–113, BL-601–606)
- Windows Agent v1 design spike (S2.1) — start agent repo
- Decide CodeCanyon listing assets (demo video, screenshots, listing copy)

---

## 2026-08-02 — PM system upgrade

**Completed:**
- Upgraded `workload/` into the numbered 17-file commercial PM system (content of all previous files preserved):
  - Renamed existing files → numbered equivalents (`00`–`16`)
  - **Added:** 00-Product-Vision, 02-Feature-Matrix, 10-Agent-Roadmap, 11-AI-Roadmap, 12-Release-Checklist, 13-CodeCanyon-Checklist, 14-Deployment, 15-Release-History
- **No application source code, API, database, or frontend modified** during this task (documentation only).

**Next:**
- Sprint-01 kickoff (security hardening — BL-001…BL-008)
- Draft CodeCanyon listing copy (title/description/tags) using 13-CodeCanyon-Checklist

## 2026-08-02 — Feature verification audit

**Completed:**
- Verified **every feature** in `02-Feature-Matrix.md` against the live source (33 routes, 76 components, Prisma schema, runtime checks).
- Appended **Verification Report** to `02-Feature-Matrix.md`: per-feature status + implementation % + evidence; reclassified 13 features (see matrix).
- Added BL-607 (missing `/api/settings/health`) to `03-Backlog.md`; confirmed BL-006 scope (fabricated data = analytics + activity-matrix only).
- Confirmed the sidebar `Math.random()` is skeleton width (cosmetic, not fake data).

**Verification outcome:**
- Overall completion ~39% · Frontend ~80% · Backend ~45% · Database ~65% · Windows Agent 0% · AI (BYOK) ~15% · Commercial readiness ~10%
- No source code, API, or database changes made (documentation only).

**Next:**
- Sprint-01 kickoff (security hardening)
- Windows Agent v1 design spike

## 2026-08-02 — Agent ↔ Server protocol contract

**Completed:**
- Designed the **complete Agent ↔ Server communication protocol** → `workload/17-Agent-API-Contract.md` (v1.0, implementation-ready).
  - 16 endpoints covering all 18 flows (register, activate, heartbeat, policy, activity, screenshots, health, version, update, logs, errors, commands, config, shutdown, uninstall, token-rotate)
  - Auth: Installation + Device + hashed Agent Token + HMAC-SHA256 request signing + nonce/timestamp replay protection + clock-drift sync + token rotation
  - Screenshot: two-step chunked upload, WebP, sha256 content dedup, privacy mode
  - Activity: typed events, batch limits, offline SQLite queue, `(deviceId, seq)` idempotency
  - DB impact (9 new tables), versioning, failure matrix, deployment compatibility
- Appended **ADR-011…017** to `09-Architecture-Decisions.md` (identity, signing, ingestion, screenshots, versioning, updates, policy/config).
- **No source code, API, schema, or database modified** (documentation only).

**Next:**
- Implement protocol step 1–3 (schema + agent auth + register/heartbeat)
- Windows Agent .NET spike (transport + signing + queue)

## 2026-08-02 — Telemetry database design (final)

**Completed:**
- Designed the **final telemetry database model** → `workload/18-Telemetry-Database-Design.md` (v1.0, implementation-ready):
  - 17 new entities (Installation, AgentCredential, DeviceAssignment, ActivityEvent, UploadTicket, AgentCommand, AgentLog, AgentError, AgentNonce, AgentUpdate, DeviceUpdateHistory, AgentPolicy + PolicySnapshot, DeviceHealthSnapshot, UserDailySummary, AISummary, AIConversation/AIMessage, AuditLog) + 6 modified (Device, ActivityLog→ActivityEvent, LoginSession, Screenshot, User, AgentPolicy) + 10 reused as-is
  - Every entity spec'd: purpose, fields, PK/FKs, indexes, unique constraints, enums, nullability, retention, expected size, read/write frequency
  - Key decisions: hybrid event storage (one ActivityEvent table — WHY not separate/JSON-only), screenshot metadata+sha256-dedup (no ScreenshotChunk table), UserDailySummary rollup as analytics/AI backbone, no raw Heartbeat table (sampled DeviceHealthSnapshot), AISummary persistence, policy active-row + snapshot history, DeviceAssignment attribution windows
  - ER diagram, retention strategy, analytics/AI query strategies, SQLite→PostgreSQL scalability (100/500/5000), migration strategy, performance recommendations, Postgres notes
- Appended **ADR-018…025** to `09-Architecture-Decisions.md` (hybrid events, screenshot dedup, rollup backbone, heartbeat sampling, AI persistence, policy history, assignment windows, baseline migration).
- **No source code, API, schema, or database modified** (documentation only; `prisma/schema.prisma` untouched).

**Next:**
- Implement protocol step 1 (schema → baseline migration `0001_telemetry_v1` per ADR-025 + reseed demo)
- Implement agent auth middleware (token verify, HMAC, nonce cache, clock window)
- Windows Agent .NET spike (transport + signing + queue)

## 2026-08-02 — Prisma migration plan

**Completed:**
- Created `workload/19-Prisma-Migration-Plan.md` (v1.0, implementation planning — no schema/code written):
  - Classified all 19 existing models (10 reuse unchanged, 6 modify, 1 rename ActivityLog→ActivityEvent, 0 delete/replace; Device.deviceId legacy column deprecated)
  - Classified all 17 new models by phase (P1 immediate: RBAC/Installation/AgentCredential/DeviceAssignment · P2 Agent MVP: UploadTicket/commands/logs/errors/updates/policy/health/rollup/audit · P3 AI: AISummary/conversations · P4 enterprise: future only)
  - 10-migration sequence M001–M010, each with purpose/models/risk/rollback/verification + why isolated + pre-v1 squash option (ADR-025)
  - FK & referential-action audit (no CASCADE on telemetry/audit; critical SET NULL traps on uploadId/dedupRef), unique/index plan, enum review (no Prisma enums on SQLite), naming review, technical-debt list, SQLite limitations, Postgres notes, risk table, verification checklist
- Appended **ADR-026…030** to `09-Architecture-Decisions.md` (no enums on SQLite, referential-action policy, 10-step migration sequence, partial unique index via raw SQL, updatedAt policy).
- **No source code, API, schema, or database modified** (planning only; `prisma/schema.prisma` untouched).

**Next:**
- Implement M001 (backup db → adopt `prisma migrate dev` → baseline capture)
- Apply schema per 18-Telemetry-Database-Design + this plan, then M003 identity/fleet
- Windows Agent .NET spike (transport + signing + queue)

## 2026-08-02 — M001: Prisma Migrate baseline (implemented)

**Completed:**
- Implemented **Migration M001** — converted the project from unmanaged `db push` to **Prisma Migrate**:
  - Created `prisma/migrations/0001_init/migration.sql` (baseline: 19 tables, 4 indexes) + `migration_lock.toml`
  - Marked baseline applied via `prisma migrate resolve --applied 0001_init` (SQL not executed — tables already existed)
  - Added `db:deploy` + `db:status` npm scripts to `package.json`
  - Verified: `migrate status` clean · **36 users / 6 orgs / 10 devices / 491 activity / 146 screenshots intact** · `db:generate` ✔ · `npm run build` ✔ (all 33 API routes compiled, standalone copied)
  - Backups: `db/custom.db.bak-m001` + `prisma/db/custom.db.bak-m001`
  - Report: `workload/20-M001-Implementation.md`

**Fixed / handled:**
- Windows DLL lock (EPERM on `prisma generate`) — stopped stale dev server (PID 4768) and retried
- Shell `DATABASE_URL` decoy hazard — used `env -u DATABASE_URL` for every Prisma command so `.env` (`file:../db/custom.db` → real DB) wins

**Next:**
- M002 RBAC (`Role`/`Permission`/`UserRole`, BL-003) via `prisma migrate dev --name rbac`
- M003 identity/fleet (Installation/AgentCredential/DeviceAssignment)
- Windows Agent .NET spike

## 2026-08-02 — M003: Installation & Device Identity (implemented)

**Completed:**
- Implemented **Migration M003** — Installation & Device Identity layer (database foundation only, no APIs):
  - New models: `Installation` (deployment identity + join key hash), `AgentCredential` (token lifecycle, tokenHash unique, Cascade on device), `DeviceAssignment` (attribution windows, Restrict on device/user)
  - Modified `Device` (+installationId FK, hardwareFingerprint, lastHeartbeatAt, lastErrorAt, highWaterMark, capabilities, agentPlatform, agentArch; status value set extended; legacy deviceId deprecated-but-kept) and `User` (+assignments backlink)
  - Migration `20260802143318_m003_identity` via `prisma migrate dev` (create-only + raw SQL: partial unique index `DeviceAssignment_deviceId_active_idx` per ADR-029 + demo backfill linking all 10 devices to a default Installation)
  - Verified: `prisma validate` ✅ · `db:generate` ✅ · `migrate status` clean (2 migrations) ✅ · `npm run build` ✅ · runtime: login 200 + JWT, `/api/devices` 200 (10 rows), `/api/organizations` 200 (6 rows), `/api/dashboard` 200 ✅
  - Data intact: 36 users / 6 orgs / 10 devices / 491 activity / 146 screenshots
  - Report: `workload/21-M003-Implementation.md`

**Next:**
- M004 telemetry core: ActivityLog→ActivityEvent rename (+kind/seq/payload/sessionId/source, UNIQUE(deviceId,seq)) + LoginSession extensions — HIGHEST risk, ship with updated API routes
- Agent auth middleware + E1 register/E2 activate/E3 heartbeat (needs AgentCredential/Installation now in place)
- Windows Agent .NET spike

## 2026-08-02 — E1: Agent Registration API (implemented)

**Completed:**
- Implemented **E1 — POST /api/agent/v1/register** (first agent-facing endpoint, per 17-Agent-API-Contract.md §4 E1):
  - `src/app/api/agent/v1/register/route.ts` — zod validation, 5/min IP rate limit, error envelope, exact contract DTO
  - `src/lib/agent.ts` — service layer (256-bit base64url token, SHA-256 token hash, timing-safe join-key verify, hardware-fingerprint dedup, `registerAgent`)
  - `src/middleware.ts` — whitelisted `/api/agent/v1/register` (join-key auth, NOT web JWT; route never hits the API-key bypass branches)
  - `scripts/verify-e1.mjs` — automated verification: **23/23 checks passed** covering valid/invalid-join-key/duplicate/missing-fields/invalid-payload/DB-persistence/token-hashing/response-shape
  - Manual raw curl confirmed exact contract response (201, 43-char token, 180d expiry, `status:"pending"`)
- Verified: `prisma validate` ✅ · `db:generate` ✅ · `npm run build` ✅ (route registered in manifest) · data intact (36 users / 10 devices)
- Security: no JWT, no API-key bypass, join key timing-safe + hashed at rest, token stored hashed only, secret-free logging, exact DTO (no hash leak)
- Report: `workload/22-E1-Agent-Registration.md`

**Next:**
- E3 heartbeat + agent auth middleware (token verify via AgentCredential, HMAC signing, nonce cache, clock window)
- E2 activate (server-side user binding → DeviceAssignment)
- Windows Agent .NET spike

---

## 2026-08-02 — E0: Agent Security Foundation (implemented)

**Completed:**
- Implemented **E0 — shared Agent Authentication & Security Foundation** (reusable infra for all future `/api/agent/v1/*` APIs; **no business endpoints**):
  - `src/lib/agent-auth/` (10 modules) — token primitives (256-bit base64url, SHA-256 hashing, constant-time compare, rotation helpers), HMAC-SHA256 request signing + canonicalization (`METHOD\nPATH\nTS\nNONCE\nsha256hex(body)`, contract §2.2), timestamp/clock-skew validation (±300 s + tolerant 600 s heartbeat window), `NonceStore` replay-protection interface + bounded in-memory store (10 min TTL, nonce consumed only after full auth), shared Zod schemas (register/activate/heartbeat/activity/screenshot/command-poll + auth headers), 9 typed errors (401/403/409/413/422/426/429 envelope), response helpers with `X-Server-Time`, `AGENT_*` env validation with safe defaults, composed `verifyAgentRequest` pipeline (token → device binding → signature → clock → nonce)
  - `src/middleware.ts` — whitelisted `/api/agent/v1` prefix as agent-auth (contract §0; replaces granular register entry)
  - `src/lib/agent.ts` — crypto primitives consolidated to import/re-export from `agent-auth` (E1 behavior identical)
  - `scripts/verify-e0.mjs` — unit verification: **107/107 checks passed** (signature valid/invalid/tamper, expired timestamp, clock drift, replay, token hashing, constant-time, reference-signer interop, Zod, verifier pipeline)
- Verified: `prisma validate` ✅ · `prisma generate` ✅ · `npm run build` ✅ (35 routes, standalone copied) · `eslint` on changed files ✅ · E1 regression **23/23** ✅ · data intact (36 users / 10 devices)
- Review: code-reviewer findings applied — verifier/store now default from validated `agentConfig` (env vars take effect); authenticate-then-authorize ordering
- Report: `workload/23-E0-Agent-Security.md`

**Next:**
- E2 activate + E3 heartbeat using the E0 foundation (`verifyAgentRequest` + shared envelope/schemas)
- E16 token rotation endpoint (uses `createToken`/grace helpers)
- Windows Agent .NET spike (transport + signing + queue)

---

## 2026-08-02 — M004: ActivityEvent Foundation (Stage-1, DB only)

**Completed:**
- Implemented **M004 Stage-1** — telemetry-core database foundation (no business logic, no routes except one compile-compat line):
  - `prisma/schema.prisma` — renamed `ActivityLog` → `ActivityEvent` (all 18 fields kept) + 6 additive nullable fields (`seq`, `kind`, `payload Json`, `sessionId`, `source`, `receivedAt`); `@@map("ActivityLog")` keeps the physical table + legacy relation names keep FK constraint names → **pure `ALTER TABLE ADD COLUMN` migration** (491 activity rows preserved, zero recreate); 3 safe indexes (`deviceId`/`timestamp`/`kind`); `User.activities`/`Device.activities` relation field names kept
  - `src/lib/db.ts` — `db.activityLog` delegate alias → `activityEvent` (deprecated note) so all 10 API routes + 3 seed scripts compile/run unchanged
  - `src/app/api/users/[id]/activity-matrix/route.ts` — 1-line compile-compat fix (moved `kind: 'activity'` literal after the spread; new `kind` column was clobbering it → TS2783 + `kind:null`). Behavior-preserving; the only route touched; required by "old queries must still compile"
  - Migration `20260802152439_m004_activity_event_foundation` applied; backup `db/custom.db.bak-m004`
- Verified: `prisma validate` ✅ · `prisma generate` ✅ · `migrate status` clean (3 migrations) ✅ · data intact (491 activity / 36 users / 6 orgs / 10 devices / 146 screenshots) ✅ · `npm run build` ✅ · `tsc` 0 new errors ✅ · runtime **18/18** endpoints + timeline `kind` check ✅
- Stage-2 intel: all 491 rows already have `deviceId` (0 NULLs); `seq`/`kind` are NULL → backfill before `UNIQUE(deviceId, seq)`/required columns
- Report: `workload/24-M004-ActivityEvent-Foundation.md`

**Next:**
- Stage-2 telemetry: backfill `seq` (per-device monotonic) + `kind` (from legacy `type`), then `UNIQUE(deviceId, seq)` + required `deviceId`; ingest path on `db.activityEvent`
- Decide physical table rename (`ActivityLog` → `ActivityEvent`) and alias removal after routes migrate
- E2/E3 agent endpoints on the E0 foundation

---

## 2026-08-02 — M004 Stage-2: ActivityEvent Telemetry Identity (DB only)

**Completed:**
- Implemented **M004 Stage-2** — telemetry identity + idempotency ring (no API/UI/analytics/business-logic changes):
  - `prisma/schema.prisma` — added `@@unique([deviceId, seq])` to `ActivityEvent`; refreshed Stage-2 field comments (comment-only)
  - Migration `20260802160000_m004_stage2_telemetry_identity` (authored via `prisma migrate diff` + manual SQL, applied via `migrate deploy` — `migrate dev` is blocked non-interactively in this env):
    1. `seq` = `ROW_NUMBER() OVER (PARTITION BY deviceId ORDER BY timestamp, rowid)` → monotonic 1..N per device (verified)
    2. `kind` normalized from legacy `type`: `App`→`app` (381), `Website`→`website` (110); `Idle`/`System`→`idle`/`system` latent branches; else `unknown`
    3. `source='legacy'`; `receivedAt=timestamp`; `payload` left NULL (no fabricated JSON)
    4. `CREATE UNIQUE INDEX "ActivityLog_deviceId_seq_key"` — created **after** backfill so duplicates abort the migration; 0 violations
- **deviceId stays nullable (documented escape hatch):** Devices UI hard-deletes devices (`api/devices/[id]` DELETE) — FK is `ON DELETE SET NULL`, so `NOT NULL deviceId` would force RESTRICT and break device deletion. All rows backfilled, but the constraint change would regress a live feature.
- Verified: `prisma validate` ✅ · `prisma generate` ✅ · `migrate status` up to date (4 migrations) ✅ · data intact (**491 rows**, deviceId/seq/kind/source/receivedAt 0 NULLs, seq monotonic per device, UNIQUE violations 0, payload NULL) ✅ · `npm run build` ✅ · `tsc` 0 new errors ✅ · runtime **21/21** endpoints ✅ · backup `db/custom.db.bak-m004s2`
- Report: `workload/25-M004-Stage2-Report.md`

**Next:**
- **M004 Stage-3**: agent ingest API on `db.activityEvent` (agent-supplied `seq` → idempotent upsert via `UNIQUE(deviceId, seq)`; `receivedAt`=server clock; `source='agent'`); wire `sessionId` → `LoginSession`; migrate routes/seeds off deprecated `db.activityLog` alias; decide physical table rename
- E2/E3 agent endpoints on the E0 foundation

---

## 2026-08-02 — M004 Stage-3 (Final): ActivityEvent adoption — zero ActivityLog left

**Completed:**
- **Full ActivityEvent adoption** — removed the deprecated `db.activityLog` delegate alias from `src/lib/db.ts`; migrated all 8 API routes (activity, dashboard, analytics, timeline, ai/insights, users/[id]/timeline, users/[id]/ai-summary, users/[id]/activity-matrix) + 3 seed scripts (seed, seed-timeline, seed-matrix) to `db.activityEvent.*`. No business logic or UI changed — response shapes identical.
- `prisma/schema.prisma` — removed `@@map("ActivityLog")` (physical table rename) + renamed relation labels to `ActivityEvent_userId`/`ActivityEvent_deviceId`; no legacy token remains in the schema.
- Migration `20260802170000_m004_stage3_rename_activity_log` (manual, data-preserving): `ALTER TABLE "ActivityLog" RENAME TO "ActivityEvent"` + 4 index renames. ⚠ `prisma migrate diff` generates `DROP TABLE` for renames — must author manually. **491 rows intact**, zero drift (empty migrate diff), backup `db/custom.db.bak-m004s3`.
- Verified: `prisma validate` ✅ · `generate` ✅ · `migrate status` (5 migrations) ✅ · `tsc` 0 new errors ✅ · `eslint` ✅ · `npm run build` ✅ (35 routes, standalone) · runtime **15/15** endpoints (dashboard/analytics/timeline/activity/users/devices/reports/user-timeline/activity-matrix/screenshots/device-detail/ai-summary + 401 gate).
- Regression: **zero `ActivityLog` references in application code** — only immutable migration-history SQL + the unrelated `activityLogging` Settings UI toggle remain.
- Report: `workload/26-M004-Stage3-Report.md`

**Next:**
- **M005**: agent ingest/heartbeat on `db.activityEvent` (agent `seq` → idempotent upsert via `UNIQUE(deviceId,seq)`; `receivedAt`=server clock; `source='agent'`)
- E2 activate + E3 heartbeat on the E0 foundation
- Windows Agent .NET spike

---

## 2026-08-02 — M005 Stage-1: Agent registration backend foundation (verified — delivered by E1)

**Completed:**
- Confirmed the **M005 Stage-1 registration layer is fully delivered by contract E1** (`POST /api/agent/v1/register`, on the E0 security foundation). **No code changes needed** — per decision: contract-aligned E1 is authoritative; `DeviceAssignment` intentionally deferred to E2/activate (no `userId` at registration, anti-spoof; schema requires the FK).
- Re-verified end-to-end: `prisma validate` ✅ · `generate` ✅ (after clearing an orphaned dev-server DLL lock) · `migrate status` 5/5 ✅ · `tsc --noEmit` 0 new errors ✅ · `eslint` clean ✅ · `verify-e0` **107/107** ✅ · `verify-e1` **23/23** (live dev server) ✅ · `npm run build` ✅ (route in manifest, standalone copied) · data intact (10 devices, 0 leftover test rows)
- Documented mission ↔ contract mapping + deliberate deltas → `workload/27-M005-Stage1-Report.md` (files, contract, DB, verification, risks, rollback, commit message, Stage-2 readiness)
- Environment fix: killed orphaned dev server (PID 14500, port 3100) holding `query_engine-windows.dll.node` → `EPERM` on `prisma generate` (Windows DLL lock, cf. M001)

**Next:**
- **M005 Stage-2**: E3 heartbeat + E5 activity ingest on `db.activityEvent` (agent `seq` → idempotent upsert via `UNIQUE(deviceId,seq)`; `receivedAt`=server clock; `source='agent'`)
- E2 activate (server-side user binding → `DeviceAssignment`) + E16 token rotation on the E0 foundation
- Windows Agent .NET spike (transport + signing + queue)

---

## 2026-08-02 — M005 Stage-2: Production agent authentication layer (implemented)

**Completed:**
- Implemented the **reusable one-call agent verifier** on the E0 foundation (`src/lib/agent-auth/context.ts`): `authenticateAgentRequest()` resolves the credential by `SHA-256(bearer)` (hash-at-rest, constant-time), rejects **revoked/expired tokens (401) · inactive devices — Pending/Suspended/Retired (403) · disabled installations (403 AGENT_INSTALLATION_DISABLED)**, then runs the crypto pipeline (HMAC signature, ±300 s clock window, nonce replay) via `verifyAgentRequest`. State checks run before nonce consumption (no nonce-burning DoS). Future endpoints make ONE call (recipe in report §2.2).
- **Header aliases**: `X-Agent-Timestamp`/`X-Agent-Nonce` accepted alongside contract `X-Timestamp`/`X-Nonce` (contract names win when both present).
- **Schema**: added `Installation.status` (`Active|Disabled`) via migration `20260802175839_m005_stage2_installation_status` (additive table-recreate, existing row → `'Active'`; backup `db/custom.db.bak-m005s2`; 36 users / 10 devices / 491 activity intact).
- New error classes: `AgentInstallationDisabledError`, `AgentDevicePendingError`, `AgentDeviceRevokedError` (+ `AGENT_INSTALLATION_DISABLED` code).
- Verified: `scripts/verify-m005s2.mjs` **30/30** (mission's 8 cases + aliases/state/hash-proof) · E0 regression **107/107** · E1 regression **23/23** (live) · `prisma validate`/`migrate status` (6) ✅ · `tsc` 0 new errors ✅ · `eslint` clean ✅ · `npm run build` ✅ (standalone copied)
- Report: `workload/28-M005-Stage2-Report.md`

**Next:**
- **M005 Stage-3**: E3 heartbeat (first `authenticateAgentRequest` consumer, tolerant clock window) + E5 activity ingest on `db.activityEvent` (agent `seq` → idempotent upsert via `UNIQUE(deviceId,seq)`; `receivedAt`=server clock; `source='agent'`)
- E2 activate (server-side user binding → `DeviceAssignment`) + E16 token rotation on the composed verifier
- Windows Agent .NET spike (transport + signing + queue)

---

## 2026-08-02 — M005 Stage-3: E3 Heartbeat endpoint (implemented)

**Completed:**
- Implemented **POST /api/agent/v1/heartbeat** — the first authenticated agent endpoint, built entirely on Stage-2's `authenticateAgentRequest()` (no duplicated auth): tolerant 600 s clock window for bootstrap + `allowPending` (E3 is the pending-device poll channel, contract §2.6; default verifier still rejects Pending).
- **Presence-only**: changed-value `Device` update — `lastHeartbeatAt`/`lastSeen`/`status→Online` always; `agentVersion`/`agentPlatform`/`agentArch`/`hostname`/`ipAddress`/`capabilities` only when they differ; `highWaterMark` monotonic (never decreases). No telemetry/screenshots/commands/analytics.
- `heartbeatSchema` extended with additive optional identity/health fields (agentVersion/platform/architecture/hostname/ipAddress/bootTime/uptimeSeconds/memoryUsage/cpuUsage/diskUsage/capabilities/policyVersion/highWaterMark/timezone) — validated; only Device-mapped fields persist.
- Response: contract E3 DTO (`serverTime/heartbeatIntervalMs/policyVersion/configVersion/updateAvailable/updateVersion/commands/flags`) + `timeOffset = serverTime − clientTimestamp`; `commands` = pending-command metadata (always `[]` until M006).
- Verified: `verify-e3.mjs` **26/26** live (authenticated 200 + DTO + timeOffset · revoked 401 · disabled install 403 · suspended device 403 · stale ts 429 · replay 409 · invalid payload 422 · DB persistence + highWaterMark monotonic) · E1 **23/23** · E0 **107/107** · S2 **30/30** · `tsc` 0 new errors ✅ · `eslint` ✅ · `npm run build` ✅ (`ƒ /api/agent/v1/heartbeat` in manifest)
- Report: `workload/29-M005-Stage3-Report.md`

**Next:**
- **M005 Stage-4**: E5 activity ingest on `db.activityEvent` (agent `seq` → idempotent upsert via `UNIQUE(deviceId,seq)`; `receivedAt`=server clock; `source='agent'`; `rejected[]`; highWaterMark already advanced by E3)
- E2 activate (server-side user binding → `DeviceAssignment`) + E16 token rotation
- Centralized per-device rate limiting (contract §3) before the data plane opens
- Windows Agent .NET spike (transport + signing + queue)

---

---

## 2026-08-03 — M005 Stage-4: E5 Activity Ingestion endpoint (implemented)

**Completed:**
- Implemented **POST /api/agent/v1/activity** — the primary telemetry entry point (contract §4 E5 / flows 5–8), built on Stage-2's `authenticateAgentRequest()` (single auth path, no JWT/cookies; default state checks — Pending rejected).
- Accepts **both** contract typed events (`app`/`web`/`idle`/`session` kind-payload objects) and the mission's flat events (`timestamp`/`title`/`application`/`website`/`isIdle`/`payload`) — normalized to `ActivityEvent` rows; additive-only (contract §8).
- **One `$transaction` per batch**: existing-`(deviceId, seq)` pre-check → `createMany` (single batched INSERT, no N+1) → monotonic `Device.highWaterMark` advance (only after successful persistence — a failed write rolls back the HWM update too). Prisma SQLite `createMany` has no `skipDuplicates` (verified) → the pre-check IS the idempotency guard and yields exact per-seq duplicate counts.
- **Partial success**: `202 { batchId, accepted, duplicates, rejected[], highWaterMark, serverTime }`; `rejected[]` = `{ seq, code: AGENT_VALIDATION | AGENT_CLOCK_SKEW }` (per-event ±24 h clock window) — one malformed event never fails the batch; duplicates never error.
- Every row: `source='agent'`, `receivedAt`=server clock, `timestamp`=event ts (unclamped); out-of-order events persisted as-is. Body `deviceId`/`highWaterMark` accepted but ignored (server-authoritative, anti-spoof).
- gzip bodies decoded (Next.js does not auto-decompress request bodies) + 1 MB gate with decompression-bomb guard; >1 MB → `413`.
- Verified: `verify-e5.mjs` **44/44** live (valid · duplicate · replay-nonce 409 · out-of-order · malformed partial success · oversized/empty 422 · transaction rollback [API + mid-tx unit] · gzip · 413 · DB integrity + HWM) · E3 **30/30** live · E1 **23/23** live · E0 **107/107** · S2 **30/30** · `tsc` 0 new errors ✅ · `eslint` ✅ · `npm run build` ✅ (`ƒ /api/agent/v1/activity` in manifest)
- **No migration** — all columns/indexes existed since M003/M004.
- Report: `workload/30-M005-Stage4-Report.md`

**Next:**
- **M005 Stage-6**: E16 token rotation on the composed verifier (X-Token-Expires plumbing already live from Stage-3/4); then the centralized per-device rate limiter (contract §3: E5 1 req/2 s) before the data plane opens
- Consumption side: analytics/dashboard reads over persisted `ActivityEvent` rows

---

### M005 Stage-5 (E2 — Device Activation) — COMPLETE

- **Goal:** bind a registered device to its employee via `DeviceAssignment`. After this stage **DeviceAssignment — NOT `Device.status` — authorizes data ingestion** (ADR-024, flagged in Stage-3).
- **New endpoint:** `POST /api/agent/v1/activate` — body `{ clientTime }` only; `authenticateAgentRequest` (`allowPending`, no `requireAssignment`); server-authoritative user resolution via the `User.deviceId` cursor (admin UI sets it; agent never supplies `userId`).
- **`activateDevice()`** (src/lib/agent.ts): 11-step activation in ONE transaction — load device → verify installation active → reject Retired/Suspended → resolve user (none → 403 `AGENT_DEVICE_PENDING`) → idempotent same-user window / close prior window (`revokedAt`+`revokeReason='reassigned'`) → create `assignedBy='system'` window → `Device.status='Online'` + `lastSeen`/`lastHeartbeatAt` → commit.
- **Schema:** `DeviceAssignment.revokeReason` (mission step 8). Clean `ALTER TABLE ADD COLUMN` migration — **ADR-029 partial unique index verified present before & after** (M003 fragility note honored).
- **Auth refactor:** `assertAssignedDevice()` reusable gate + `requireAssignment` option; E3 heartbeat (keeps `allowPending` = pending poll channel, contract §2.6) and E5 activity now require an active assignment; `+AGENT_DEVICE_UNASSIGNED` 403. Status is presence only.
- **Files:** activate route (new), agent.ts, context/loaders/errors (agent-auth), schema + migration, heartbeat + activity routes, verify-e2/e3/e5 scripts.
- **Verified:** `verify-e2.mjs` **53/53** live (first/repeat/duplicate activation · reassignment · revoked window re-activation · gates E3/E5 → 403 UNASSIGNED · Pending separation [status vs assignment] · partial unique index via raw SQL → UNIQUE violation · unauthorized/expired/disabled/suspended/retired · **transaction rollback** (mid-tx failure rolls back inserted assignment) · DTO audit · build) · E1 **23/23** · E3 **32/32** (was 30; +2 Stage-5 setup checks) · E5 **46/46** (was 44; +2) · E0 **107/107** · S2 **30/30** · `tsc` 0 new errors ✅ · `eslint` ✅ · `npm run build` ✅ (`ƒ /api/agent/v1/activate` in manifest).
- **Fix during verification:** verify-e3/e5 `assignAndActivate` + e5 `heartbeat` used two `Date.now()` calls (signing vs `X-Timestamp` header) → ms-boundary flake → `AGENT_SIGNATURE_INVALID`. Captured a single `ts` for signing AND header; suites now stable back-to-back.
- **DB state post-run:** 10 demo devices / 0 creds / 0 assignments / 0 test-user leftovers (clean). Report: `workload/31-M005-Stage5-Report.md`.

**Next:**
- **M006**: centralized per-device rate limiting (contract §3: E1 5/min/IP · E3 1/15 s · E5 1/2 s burst 4) on the composed verifier, then the data-plane endpoints (screenshots E6, health E7) and the consumption side
- Consumption side: analytics/dashboard reads over persisted `ActivityEvent` rows

---

### M005 Stage-6 (E16 — Agent Token Rotation) — COMPLETE

- **Goal:** seamless agent-token rotation with a 60 s grace window for the old token (contract §2.5) — the final P0 piece of agent security; the Agent API is now production-ready end-to-end.
- **New endpoint:** `POST /api/agent/v1/token/rotate` — `authenticateAgentRequest` (`requireAssignment`, no `allowPending`) → old-token rotation rejected → `rotateAgentToken` → `{ token, expiresAt, graceUntil, serverTime }`.
- **`rotateAgentToken()`** (agent.ts): one transaction — verify device/installation/assignment/credential-not-revoked (TOCTOU) → generate 256-bit token → in-place update `tokenHash→prevTokenHash`, `rotatedAt/issuedAt/expiresAt` refreshed → plaintext returned once, sha256 stored only (ADR-011).
- **Verifier:** `resolveValidCredential()` dual-token — current (`tokenHash`) valid; old (`prevTokenHash`) valid ≤ 60 s from `rotatedAt`, after → `401 AGENT_TOKEN_EXPIRED`; neither → `AGENT_UNAUTHORIZED`. Loader OR-matches `tokenHash|prevTokenHash` (deterministic). HMAC compares the matched half. Replay/nonce/clock unchanged.
- **Security:** old-token rotation blocked (`authenticatedByCurrentToken` gate) — a captured old token can't mint a fresh one; assignment required (data-plane gate); no plaintext/hash/token logging.
- **Schema:** **no migration** — `AgentCredential.prevTokenHash/rotatedAt` already existed (M003 design for E16).
- **Files:** rotate route (new), agent.ts, context/loaders/schemas (agent-auth), verify-e16.mjs.
- **Verified:** `verify-e16.mjs` **63/63** live (normal/repeated rotation · new-works-now · old-grace-works · grace expiry · expired/revoked/disabled/suspended · assignment gate · old-token rotate rejected · replay 409 · DTO audit · transaction rollback · concurrent rotations [last-writer-wins, both tokens live, pre-race superseded, self-heal] · pending gate · hash-at-rest proof) · E2 **53/53** · E1 **23/23** · E3 **32/32** · E5 **46/46** (Register → Activate → Heartbeat → Activity unchanged) · E0 **107/107** · S2 **30/30** · `prisma validate` ✅ · `tsc` 0 errors ✅ · `eslint` ✅ · `npm run build` ✅ (`ƒ /api/agent/v1/token/rotate` in manifest).
- **Reviewer fixes:** credential-not-revoked re-check in service (TOCTOU) + strengthened hash-at-rest assertions in the verify script.
- **DB state post-run:** 10 demo devices / 0 creds / 0 assignments / 0 test-user leftovers (clean). Report: `workload/32-M005-Stage6-Report.md`.

**Next:**
- **M006**: centralized per-device rate limiting (contract §3: E1 5/min/IP · E3 1/15 s · E5 1/2 s burst 4) on the composed verifier, then the data-plane endpoints (screenshots E6, health E7) and the consumption side
- Consumption side: analytics/dashboard reads over persisted `ActivityEvent` rows

---

### M007 Stage-1 (E6 - Screenshot Upload Foundation) - COMPLETE

- **Goal:** the first agent data-plane endpoint - resumable chunked screenshot uploads with full mission gates; no OCR/AI/viewer/consumption yet.
- **Endpoints (mission shapes):** `POST /api/agent/v1/screenshots` (initiate -> `{uploadId, chunkSize, chunks, expiresAt, duplicate}` or dedup hit `{duplicate, existingId}`; `?mode=single` = full WebP body + signed query-param metadata -> `{screenshotId, duplicate, stored}`) . `PUT /api/agent/v1/screenshots/{ticket}/chunk?index=N` (bitmap progress -> `{received, nextIndex}`) . `POST /api/agent/v1/screenshots/{ticket}/complete` (server verifies completeness/WebP/size/sha256 -> row + atomic final file -> `{screenshotId, duplicate, stored}`).
- **Gates:** WebP-only (magic sniff) . <= 5 MB . 256 KB chunks . 10-min ticket TTL . +/-24 h clock . metadata body <= 64 KB . rate limit `screenshots` rule (capacity 16 / refill 125 ms = 2 MB/s aggregate) on all three routes . `requireAssignment` on all three.
- **New error codes:** `AGENT_UPLOAD_NOT_FOUND` 404 (no existence leak - foreign/unknown indistinguishable) . `AGENT_UPLOAD_EXPIRED` 410 (marks + purges) . `AGENT_UPLOAD_CONFLICT` 409 (duplicate/invalid chunk, not-open ticket, incomplete/size-mismatch complete).
- **Dedup (ADR-014):** initiate hit -> no ticket; complete/single-shot hit -> row with `dedupRef -> twin`, `storagePath`/`sha256` null (unique content address exists once, on the twin); privacy mode skips dedup + stores metadata only.
- **Schema (3 migrations):** `Screenshot` extended (required deviceId Restrict, sha256 @unique, storagePath, size, format, width/height, monitorId, uploadId @unique FK, privacyMode, dedupRef self-rel, sessionId FK, 4 indexes) . `UploadTicket` added (bitmap/receivedBytes/status machine open|completed|expired|aborted|dedup, TTL) . ticket capture-metadata columns (capturedAt, width/height, monitorId, blurSensitive, sessionId) added after verification caught width/height loss on the chunked path.
- **Storage:** `STORAGE_PATH` config (default `storage/screenshots`) . chunks -> `.tmp/{ticket}/{i}.bin` . final `{yyyy}/{mm}/{dd}/{id}.webp` via temp+atomic rename . DB stores relative posix paths only . temp purged on complete/abort/expire . client ids never in paths.
- **Verified:** `verify-e6.mjs` **113/113** live (initiate 19 . chunk valid 6 + rejections 7 . complete valid 14 . dedup 7 . single-shot 10 . rollback 9 . resumable incl. out-of-order 13 . expired 3 . foreign/assignment 6 . rate limit 4 . final integrity 6) . E1 **23/23** . E2 **53/53** . E3 **32/32** . E5 **46/46** . E16 **63/63** . E0 **107/107** . `prisma validate` OK . `tsc` 0 new errors OK . `eslint` clean OK . `npm run build` OK (screenshots routes in manifest).
- **Notable fixes during verification:** undici sends `[object Object]` for object fetch bodies (signed JSON != wire bytes -> 401s) . `cleanupTicketDir` `unlink`-on-directory no-op -> `rm` recursive . dedup/privacy rows violated the unique sha256 (now null + dedupRef) . WebpFormatError -> 422 mapping missing in single-shot/complete catches . script pacing >=150 ms against the 8/s refill (burst section opts out) . stale-fixture dedup-hits in script sections 7/9/10.
- **DB state post-run:** 10 demo devices / 146 legacy screenshots / 0 test rows (clean). Report: `workload/33-M007-Stage1-Report.md`.

**Next:**
- **M007 Stage-2:** screenshot storage consumption side - viewer/gallery over persisted rows + files, blur-sensitive display, monitor metadata, session binding; screenshot deletion/retention
- **E7 (agent health)** + the remaining data-plane endpoints; OCR pipeline (roadmap 2.1) on stored screenshots

---

### M007 Stage-2 (E7 - Device Health Endpoint) - COMPLETE

- **Endpoint:** `POST /api/agent/v1/health` — detailed machine/agent telemetry (mission payload: cpu/memory/disk/battery/uptime/processes/network/services/temperatures/agentVersion/osVersion/hostname/bootTime/antivirus/firewall/pendingReboot + contract 17 aliases ram/av/os/agent; all optional; unknown fields ignored).
- **Gates:** body <= 128 KB -> 413 pre-auth (mission supersedes contract's 16 KB — flagged in report) . strict auth (requireAssignment, no pending, no tolerant clock: Suspended/Retired 403 AGENT_DEVICE_REVOKED, Disabled installation 403 AGENT_INSTALLATION_DISABLED, unassigned 403 AGENT_DEVICE_UNASSIGNED, pending 403 AGENT_DEVICE_PENDING, clock skew 429 AGENT_CLOCK_SKEW inside auth) . centralized rate limit `health` rule (1/60 s, burst 2 = capacity 2 / refill 60 s) . zod -> 422.
- **Persistence (one $transaction):** Device changed-values-only (hostname/osVersion/ram/diskSpace/ipAddress, semver no-downgrade agentVersion; no UPDATE call at all when unchanged — updatedAt verified identical) + `DeviceHealthSnapshot` per 18 §5.17 exactly (id/deviceId FK Cascade ADR-024/ts server-authoritative/cpuPct/ramPct/diskFreeGB/batteryPct/network JSON/osVersion/patches JSON/avName/avEnabled/agentMemMB/agentUptimeS, @@index([deviceId, ts])). Fields without a column validated but not persisted (M005 precedent); surfaced via warnings.
- **Response (additive DTO):** 200 {serverTime, accepted:true, warnings[], nextHeartbeat=+60s} — server-computed warnings: Antivirus disabled / Pending reboot / Low disk (<10 GB) / High CPU (>90%) / Low battery (<=10%).
- **Schema (1 migration):** `20260803065520_m007_stage2_device_health_snapshot`.
- **Verified:** `verify-e7.mjs` **97/97 live ×2** (happy path 22 . changed-only 6 . atomicity 4 . warnings 7 . validation 9 . oversized 2 . forward-compat+aliases 11 . auth matrix 16 . replay 2 . rate limit 2 . X-Token-Expires 1 . DB integrity 6 . regression E1/E2/E3/E5/E6/E16 9) . `prisma validate` OK . `migrate status` up to date . `tsc` 0 new (4 baseline) . eslint changed files clean (20 pre-existing react-hooks errors on admin components) . `npm run build` OK.
- **Notable findings during verification:** clock skew is 429 AGENT_CLOCK_SKEW (retryable, pre-rate-limit — not 401) . register route has its OWN inline 5/min-per-IP limiter (suite now uses a unique TEST-NET-3 IP per simulated agent; back-to-back runs stable) . E1 register persists hardware ram/disk + os.version + x-forwarded-for IP, so changed-only tests compare full rows, not nulls.
- **DB state post-run:** 10 demo devices / 146 legacy screenshots / 0 test rows / 0 snapshots (clean). Report: `workload/34-M007-Stage2-Report.md`.

**Next:**
- **M007 Stage-3:** screenshot storage consumption side — viewer/gallery over persisted rows + files, blur-sensitive display, monitor metadata, session binding; screenshot deletion/retention
- OCR pipeline (roadmap 2.1) on stored screenshots; remaining data-plane endpoints


## M007 Stage-3 — Screenshot Consumption Layer (Worklens 2026-08-03)

- **Scope:** admin consumption over the Stage-1/2 screenshot store per contract 17 §5 (E6 design)/§7.4 retention + workload 18 §8 + ADR-024 (device-scoped control). Report: `workload/35-M007-Stage3-Report.md`.
- **Endpoints (all super-admin, middleware JWT + route-level `requireSuperAdmin`):**
  - `GET /api/admin/screenshots` — metadata-only gallery, ONE query, never touches files; keyset cursor `(capturedAt DESC, id DESC)` base64url `{t,id}` (deterministic same-ms tiebreak); filters organizationId/userId/deviceId/monitorId/privacyMode/blurSensitive (strict booleans) + from/to; limit 1..100 (default 50, clamp, 0→400); response `{screenshots, hasMore, nextCursor}`.
  - `GET /api/admin/screenshots/:id` — full detail, no bytes, `storagePath` never serialized; image/privacy/dedup(+twin)/provenance/content blocks; `hasBytes` resolves via dedup twin.
  - `GET /api/admin/screenshots/:id/file` — streamed (`Readable.toWeb`, never buffered), ETag `"sha256"` + If-None-Match 304, Last-Modified, private, nosniff; default blurs `blurSensitive` rows (sharp: rotate→480px→blur(18)→webp q60; failure 500 BLUR_FAILED, never original); `?original=true` re-checks role; privacy rows → 410 SCREENSHOT_RETAINED; dedup resolves twin; missing file → 404 SCREENSHOT_FILE_MISSING.
  - `DELETE /api/admin/screenshots/:id` — file-first-then-row two-phase; legacy → fileRemoved:false; privacy → retainedOnly:true; twin delete → child dedupRef SetNull → orphan 404.
  - `POST /api/admin/screenshots/retention` — on-demand pass, stats `{runAt, ticketsExpired, ticketsPurged, tempDirsRemoved, filesRemoved, rowsRemoved}`; contract §7.4: open tickets past TTL → expired+chunks purged, rows >24 h purged, orphan `.tmp` dirs, files >90 d → delete → storagePath NULL (two-phase), rows >365 d file-then-row; referenced-file safety: twin file NEVER deleted while a dedup child is inside the 90-d window; idempotent re-run = zero counters.
  - `GET /api/admin/screenshots/integrity` — read-only, 7 checks: missingFile, orphanDbRow (only inside 90-d window — post-retention NULLs are normal state), orphanFile, brokenDedupRef, invalidDimensions (every row incl. legacy), duplicateHashes (defense in depth), invalidStoragePath; legacy rows informational counts; no auto-repair.
- **Filesystem hardening (`storage.ts`):** strict allowlist `^\d{4}/\d{2}/\d{2}/[a-z0-9]+\.webp$` → lstat (symlink reject) → realpath canonicalize → root containment on every entry (open/read/delete/walk); `walkStorageFiles` skips symlink/junction entries (never traverses outside root).
- **Verification:** `scripts/verify-e6-consumption.mjs` **192/192 live ×2, baseline stable** (144 legacy / 0 tickets; legacy-delete test now uses a crafted row so the baseline can never drift). Covers auth matrix (13), gallery filters + full keyset walk (every row exactly once, 51 pages) + same-ms tiebreak, detail (17), file (24: exact bytes, 304, blur default+original, 410, traversal `../` + `..\` + NTFS junction escape all 404), delete (11), retention (15: expired/24 h/orphan/100 d two-phase/referenced-file survival/365 d/idempotent), integrity (12: all 7 finding types on injected faults), regression E1/E2/E3/E5/E6/E7/E16 (9), perf (3).
- **Build gates:** `prisma validate` OK · `eslint` changed files exit 0 · `tsc` = exactly the 4 pre-existing baseline errors (examples/websocket ×2, markdown.tsx ×2, zero new) · `npm run build` OK (all five admin routes in manifest; standalone copied).
- **Findings during verification:** (1) route-level `requireAuth` reads the `wl_session` cookie only (middleware accepts Bearer too) — suite replays the login Set-Cookie; (2) Prisma stores SQLite DateTime as INTEGER epoch-ms — raw-SQL fixtures writing ISO strings are invisible to Prisma date filters (integer-vs-text); script helpers normalize to ms; (3) UNIQUE sha256 index means crafted rows need synthetic hashes; (4) dedupRef FK (SetNull) means broken refs only reachable via FK bypass — integrity check still covers them.
- **Server state:** dev server back on port 3000 (detached, `dev-c3.log`); storage dir empty at rest; DB clean 144 legacy screenshots / 0 tickets / 0 test rows.
*History preserved — previous sessions may be appended above this line by future sessions.*

## M007 Stage-4 — OCR Pipeline & Search Index (Worklens 2026-08-03)

- **Scope:** db-backed OCR job queue + background worker + Tesseract provider + OCR persistence on Screenshot + keyword search + admin OCR APIs (enqueue/status/retry) per contract 17 §5.7/§6.4 + workload 18 §5.7/§6.4 + roadmap 2.1. Report: `workload/36-M007-Stage4-Report.md`. Mission: **no parallel schemas** — all 14 OCR columns live ON the Screenshot model.
- **Schema (migration `20260803081601_m007_stage4_ocr_pipeline`, applied, up to date):** `ocrStatus none|pending|processing|completed|failed`, `ocrQueuedAt`, `ocrLockedAt`, `ocrAttempts` (0), `ocrRetryable` (true; false=permanent), `ocrLanguage eng`, `ocrEngine`, `ocrEngineVersion`, `ocrDuration`, `ocrProcessedAt`, `ocrFailure` (7 stable codes), `ocrFailureDetail` (JSON); + Stage-3 `ocrText`/`ocrKeywords`/`ocrConfidence` (Int 0–100, rounded). Indexes `(ocrStatus, ocrQueuedAt)` FIFO + `(ocrConfidence)` search. Deps: `tesseract.js@7.0.0`, `@tesseract.js-data/eng@1.0.0` (offline langPath); `next.config.ts` `serverExternalPackages`.
- **Provider:** `sniffImageFormat` (RIFF/PNG/JPEG header consistency — corrupt detected pre-engine in microseconds); `TesseractProvider` shared worker, per-job timeout + hard engine reset (`OCR_TIMEOUT`), engine crash → `OCR_PROVIDER_CRASH`, re-sniff defense; registry `getOcrProvider(id)`.
- **Workflow:** enqueue 202 / 404 OCR_ROW_NOT_FOUND / 422 OCR_NOT_ENQUEUEABLE (privacy-mode, byte-less) / 409 OCR_ALREADY_QUEUED; FIFO claim `(ocrQueuedAt asc, id asc)` + atomic conditional updateMany (single winner); process via safe-read funnel (own path, else dedup twin); corrupt/unknown sniff → **permanent fail, zero retry budget spent**; `failInPlace` attempts/retryable/detail; `reclaimStalledOcrJobs` (stallMs=10m, crash recovery, exhausted → permanent OCR_STALLED_RECOVERED); `retryOcrJobs` per-id `{retried, ignored, exceeded}` (never in-flight).
- **Worker:** instrumentation `register()` start, `OCR_WORKER_ENABLED` honored, single-instance guard, one claim/cycle @2s, `stopOcrWorker` park, `getOcrWorkerStats` + `disposeOcrProvider`.
- **Admin API:** `GET/POST /api/admin/screenshots/:id/ocr`; `POST /api/admin/screenshots/ocr/retry` (MAX_IDS=200); `GET /api/admin/screenshots/search` — keyword (case-insensitive LIKE), deviceId/userId/organizationId/minConfidence/from/to filters, keyset pagination `{t,id}` base64url + limit+1 hasMore (exhausted page returns hasMore:false, nextCursor:null). All `requireSuperAdmin` over middleware JWT.
- **Verification:** `scripts/verify-ocr.mjs` **92/92 live** — enqueue matrix (10), worker success path (20, text `HELLO WORLD 24680` exact), search (21), failure handling (corrupt/missing/unsupported), retry budget (attempts 1→3, permanent dispositions), stall recovery (4), delete-under-queue (4), provider attribution (4), burst FIFO (2), E1/E2 regression via real signed agent API.
- **Build gates:** prisma validate OK, migrate status up to date, tsc exactly the 4 pre-existing baseline errors (0 new), eslint clean on ocr+routes+instrumentation, `npm run build` OK (standalone copied).
- **Production bug found by the suite:** `retryOcrJobs` classified `exceeded` only when `attempts >= maxAttempts`, so permanent corrupt failures (attempts=1) were re-queued — fixed to `!ocrRetryable` (permanent means permanent).
- **Dev-environment findings:** (1) Turbopack dev cache can serve STALE compiled server modules after source edits — the long-running server ran pre-repair `errors.ts` (no sniff) and corrupt files reached the engine; cache clear + restart fixed it (source was correct); (2) raw-SQL boolean reads return 1/0, not true/false; (3) Prisma SQLite DateTime is INTEGER epoch-ms (stall fixtures must write ms ints, not ISO strings, or `ocrLockedAt < cutoff` silently misses); (4) `STORED_PATH_PATTERN` is `[a-z0-9]+` — crafted fixture names must be alphanumeric; (5) UNIQUE sha256 across runs → derived rows need per-run salt; (6) content dedup returns duplicate:true on re-run — accepted, bytes resolve via dedup twin.
- **Server state:** dev server on port 3100 (detached, `dev-c4-out.log`/`dev-c4-err.log`), OCR fixture rows present from the suite (dev only).
*History preserved — previous sessions may be appended above this line by future sessions.*

## M008 Stage-1 — Real Analytics Engine & Dashboard Consumption Layer (Worklens 2026-08-03)

- **Mission:** replace every placeholder/fabricated/demo analytics with real SQL-backed analytics from persisted telemetry. No `Math.random` remains anywhere in the app.
- **Schema (additive-only, migration `20260803111008_m008_stage1_analytics_rollup`):** `UserDailySummary` (per-user-per-UTC-day, UNIQUE(userId,date), design §5.18) · `AnalyticsJob` (rollup run log) · `RollupCheckpoint` (single `key="rollup"` row) · ActivityEvent indexes `(userId,timestamp)` `(category,timestamp)` `(domain)`.
- **Rollup engine** (`src/lib/analytics/rollup.ts`): UTC-day bucketing · incremental (checkpoint-resumed) + rebuild modes · per-(user,day) `$transaction` idempotent upsert · per-day atomic checkpoint advance (crash-safe) · always-roll-today (live dashboards) · 3660-day safety bound · per-day errors recorded, never throws.
- **Deterministic scoring** (`scoring.ts`): productivity = productive/categorised · focus = active/(focus+bg) · activity = active/8h · risk = 0.45·distracting + 0.30·idle + 0.25·flagged · burnout = 0.55·overwork + 0.30·lowRest + 0.10·risk + 0.05·switchLoad — all clamped 0..100, fixed documented constants, no AI/random.
- **Dashboard APIs rebuilt on real data** (frontend contracts preserved): `/api/dashboard` (kpis/departments/trend/topApps/deviceStatuses) · `/api/dashboard/{activity,productivity,devices,timeline,heatmap}` (new sub-routes) · `/api/analytics` (weeklyTrend/topUsers/radar — was Math.random) · `/api/timeline` (24h sparkline) · activity-matrix downloads/uploads from FileActivity (was Math.random).
- **Rollup worker:** instrumentation-started, 15-min cadence + startup catch-up, single-instance guard, `ANALYTICS_ROLLUP_ENABLED`/`ANALYTICS_ROLLUP_INTERVAL_MS` env-tunable.
- **Super-Admin rollup trigger:** `POST /api/admin/analytics/rollup[?mode=rebuild]` → `{jobId,mode,from,to,days,rows,errors}`, serialized in-flight.
- **Role-aware scoping** (`scope.ts`): Admin org-wide (explicit userId honored) · Manager org-scoped (own org users only) · Employee self-only (no/foreign userId → 403) · timeline/screenshots/sessions/health scope-filtered · flat admin tables (SecurityEvent/License/AIProvider) Super-Admin-only (no cross-tenant leak) · 401/403 surfaced via `analyticsRoute` wrapper (not 500).
- **Verification (all live, dev server port 3000):** verify-analytics **177/177** (rollup idempotency/rebuild/exact-score contract, all 8 endpoints, cursor pagination, heatmap 24/7 nonzero, auth/scope matrix incl. manager org isolation + employee 403s, 300-event perf <2000 ms, empty-telemetry tolerance) · regressions: E1 **23/23** (node) · E2 **53/53** · E3 **32/32** · E5 **46/46** · E6 **113/113** (rate-limit burst flake then green) · E6-consumption **192/192** (baseline 146/0 after clearing OCR-run stored-twin residue — suites must run serially: analytics → consumption → e6 → e7 → OCR) · E7 **97/97** · OCR **96/96**.
- **Code-review fixes:** cross-tenant leak (deviceStatuses/recentEvents/openEvents/criticalEvents + analytics eventTypes were unscoped — now Super-Admin-only/user-scoped) · dead code removed (appSec/webSec, SummaryRow, userWhere) · incremental rollup always includes today (was 0-rows when checkpoint caught up) · Admin scope now honors explicit userId (ghost filter returns empty, not all users) · bogus range echoes parsed default.
- **Build gates:** prisma validate OK · migrate status up to date (14 migrations) · tsc = exactly the 4 pre-existing baseline errors (0 new; `.tsbuildinfo` cache cleared) · eslint clean · `npm run build` OK.
- **DB state post-session:** 146 legacy screenshots / 0 tickets / 0 stored twins / storage empty; rollup populated (~122 summary rows for seeded telemetry); dev server on port 3000 (`dev-c14-out.log`/`dev-c14-err.log`).
*History preserved — previous sessions may be appended above this line by future sessions.*

## M007 Stage-4 — Re-verification session + permanent-failure fix (Worklens 2026-08-03)

- **Scope:** full re-verification of the Stage-4 OCR pipeline (fresh dev server on port 3000, Turbopack cache cleared) + one real semantic fix found by code review.
- **Fix (workflow.ts):** `enqueueOcrJob` now rejects a `failed` row with `ocrRetryable=false` → **409 `OCR_PERMANENT_FAILED`**. Before, the retry endpoint refused permanent jobs (`exceeded`) but direct `POST /:id/ocr` silently reset `ocrAttempts=0`/`ocrRetryable=true` — an admin could loop-enqueue a corrupt/unsupported screenshot forever with a fresh 3-attempt budget (mission: "never retry permanently failed jobs indefinitely"). Also: retry re-enqueue now clears `ocrFailure`/`ocrFailureDetail` so a pending job never shows a stale failure via GET `/ocr`.
- **Verification (all live, dev server port 3000):** verify-ocr **96/96** (92 + 4 new: permanent-failed enqueue → 409 + not re-armed, unsupported permanent → 409, failure metadata cleared while pending) · verify-e6-consumption **192/192** (baseline stable 144) · E1 **23/23** (node) · E2 **53/53** · E3 **32/32** · E5 **46/46** · E6 **113/113** · E7 **97/97** · E16 **63/63** · E0 **107/107** · S2 **30/30**.
- **Build gates:** `prisma validate` OK · `migrate status` up to date (12 migrations) · `tsc --noEmit` = exactly the 4 pre-existing baseline errors (0 new) · `eslint` clean on ocr + routes · `npm run build` OK (standalone copied, all 3 OCR routes in app-paths-manifest).
- **Dev tooling added:** `scripts/cleanup-ocr-fixtures.mjs` — dev-only helper that removes verify-ocr.mjs leftovers (OCR-status rows, crafted test ids, ocr-* devices, usr_ocr_* users, unreferenced storage files) so the regression suites see a clean 144-row baseline (the e6-consumption integrity clean-state check requires it).
- **DB state post-session:** 144 legacy screenshots / 36 users / 10 devices / 0 tickets / 0 credentials / 0 OCR-status rows / storage empty; dev server on port 3000 (`dev-c8-out.log`/`dev-c8-err.log`).
*History preserved — previous sessions may be appended above this line by future sessions.*

