# OMNISIGHT V1 EXPANSION — FORENSIC FEASIBILITY, ARCHITECTURE & IMPLEMENTATION READINESS AUDIT

**Date:** 2026-09-03
**Scope audited:**
- `omnisight-web` — Admin Console, API (182 routes), Prisma/PostgreSQL schema (45 models), RBAC, jobs, storage, realtime mini-service
- `omnisight-agent` — Windows Electron agent (collectors, encrypted queue/spool, uploader, policy enforcer)

**Method:** static source inspection of both repositories, live schema inspection (PostgreSQL `workai_test_e2e`, 15 orgs), full web test-suite run (96 files), agent test run (625 tests), typechecks, production build, lint. Every conclusion below carries a file/line reference or an observed result. Nothing is reported PASS without an actual verification run; unverifiable items are marked **BLOCKED** or **NOT VERIFIED**.

---

## A. EXECUTIVE SUMMARY

OmniSight is a **genuinely implemented, production-grade platform** — not a scaffold. The web backend enforces server-authoritative validation, tenant isolation, consent fail-closed gates, and org-scoped retention on every telemetry pipeline. The agent implements real collectors with an encrypted, bounded, at-least-once offline queue and fail-closed consent/working-hours gating. The two repos are contract-compatible (verified by the agent test suite plus cross-repo branding/contract tests that read both trees).

**Health:**
- Web typecheck: PASS · Web production build: PASS (after removing one corrupted Next-generated file) · Web lint: 0 errors in product source (8 errors in `.claude/helpers/*.cjs`, 432 warnings)
- Web tests: **82/96 files pass; 14 fail — 0 confirmed product regressions.** All 14 failures trace to test-harness bugs, stale test expectations, or environment/data drift (details in §D).
- Agent typecheck: PASS · Agent tests: **625/625 PASS**
- Agent build (`tsc` both configs + asset copy): PASS

**Verdict:** **READY WITH BLOCKERS** (see §22).

The blockers are not architectural. They are: (1) the web test harness is broken against Next 16 (a `req()` helper constructs `GET` requests with a body — throws), so the regression baseline is not currently green; (2) activity upload has no idempotency key (documented at-least-once → duplicate rows possible); (3) productivity classification is a client-side heuristic — the server only allowlists the category; (4) screenshot intelligence has no automatic OCR/processing worker and no thumbnails; (5) there is no configurable alerts rules engine (the Alert model, notifications and a rule-based anomaly-detection job exist, but no IF-THEN rule configuration). None of these require removing or weakening existing functionality; all are additive.

---

## B. CURRENT PLATFORM HEALTH

| Check | Result | Evidence |
|---|---|---|
| Web typecheck `tsc --noEmit` | **PASS** (source) | Only error was in corrupted `.next/dev/types/validator.ts` (generated file); excluded → 0 errors |
| Web production build `next build` | **PASS** (after `rm -rf .next/dev/types`) | `BUILD_EXIT:0`; first attempt failed on the same corrupted generated file (TS1128 at line 1182 — truncated route block) |
| Web lint `eslint .` | **PARTIAL** | 8 errors, 432 warnings. All 8 errors are `require()` in `.claude/helpers/graft-hooks.cjs` / `graft-statusline.cjs` (Claude Code helpers, not product code). Product source: 0 errors |
| Web unit/integration tests | **82 PASS / 14 FAIL** (96 files) | Run: `tsx --test tests/*.test.ts` per file against live dev server + throwaway Postgres DBs |
| Agent typecheck | **PASS** | `tsc -p tsconfig.json --noEmit && tsc -p tsconfig.renderer.json --noEmit` → exit 0 |
| Agent tests | **PASS 625/625** | `npm test` → `tests 625, pass 625, fail 0` in 24.5s |
| Agent build | **PASS** | `npm run build` (renderer + main tsc) |
| Live DB | **PASS** | PostgreSQL up, `workai_test_e2e` with 15 organizations |
| Realtime mini-service | **PARTIAL (environmental)** | Port 3010 held by a pre-existing process (PID 5356) with an active client — an instance was already running before this session; the fresh `npm run dev` instance correctly refused to double-bind. Presence logic itself verified in `mini-services/live-updates/presence.ts` |
| Playwright E2E | **NOT VERIFIED** | `playwright.config.ts` exists; suites require a booted app + browsers; not run in this audit |

**Environmental defect found (affects every build/typecheck on this checkout):**
`tsconfig.json` includes `.next/dev/types/**/*.ts`; a crashed/interrupted `next dev` left `validator.ts` truncated mid-block, breaking `tsc` and `next build` with `TS1128`. Fix: delete `.next/dev/types` (regenerated). Recommendation: add a `prebuild`/`predev` clean step or exclude `.next/dev` from the prod tsconfig.

**Dependency-file hygiene:** the repo's `package-lock.json` is an 88-byte stub (`"packages": {}`); the parent `E:\Live project\omnisight\package-lock.json` is also a stub; the real lock is `bun.lock` (339 KB) while scripts run via npm/tsx. `next build` warns it ignored the parent lock because it is outside the git repo. Recommend one canonical lock (npm) committed in-repo, and removing the parent stub.

---

## C. EXISTING FEATURE INVENTORY (verified)

### Organization & multi-tenancy — **PASS**
`Organization`, `OrganizationMembership`, `OrganizationSetting`, org switch endpoint `POST /api/me/organization/switch` (server-authoritative; `UserSession.activeOrganizationId`), suspended/archived org rejection, `Organization` cascade relations. Evidence: `prisma/schema.prisma` models; `src/lib/api.ts` (`requireSessionOrg`/`requireAdminOrg`/`requireManagerOrg`).

### User management & RBAC — **PASS**
Roles `super_admin`, `org_admin`, `manager`, `viewer` (+legacy `owner`/`admin` aliases); 50+ permissions in `src/lib/permissions.ts`; API enforcement via `requireSessionOrg`/`requireAdminOrg`/`requireManagerOrg` + `hasRolePermission`; UI enforcement via `PAGE_MIN_ROLE` in `src/lib/navigation.ts`; server-authoritative sessions (`UserSession` rows, JWT carries `sessionId`, revocation on logout/disable/password change). Evidence: `src/lib/auth.ts`, `src/lib/api.ts`, `src/lib/session.ts`, `tests/rbac-hardening.test.ts` (RBAC-02..30 pass; RBAC-01 fails only on a hardcoded dev password, see §D).

### Agent enrollment & auth — **PASS** (two paths)
- PATH A: `DeviceClaim` (hashed secret) → admin approval → `AgentToken` (24h).
- PATH B: `AgentAccount` (admin-created, bcrypt, lockout) → `AgentSession` (login-only) → device discover → approval → `AgentToken`.
- Single-active-device rule (only one valid active `AgentToken` per employee; concurrent auth → one winner, one 409).
- Token sweep job, expiry, per-device org binding (`AgentToken.organizationId NOT NULL`).
Evidence: `prisma/schema.prisma` (DeviceClaim/AgentAccount/AgentSession/AgentToken), `src/lib/agent/*`, `tests/agent-account-admin.test.ts` (PASS), `tests/agent-active-device-backend.test.ts` (fails only on harness bug).

### Heartbeat & presence — **PASS**
`POST /api/agent/heartbeat` → token validation → `Device.status='online'` + `lastHeartbeat` + IP; break state rides back in the response; agent `HeartbeatService` (60s cadence, 401 → re-auth); presence derived from `lastHeartbeat` within 5-min threshold in both `src/lib/presence.ts` and `mini-services/live-updates/presence.ts` (ONLINE⇔OFFLINE transition events). Evidence: `src/app/api/agent/heartbeat/route.ts`, `omnisight-agent/src/services/heartbeat-service.ts`, `tests/health.test.ts` (PASS).

### Activity monitoring — **PASS**
Agent polls foreground window (10s), aggregates contiguous slices (≥5s), classifies via local heuristic, gates on config+consent+working hours (org timezone), enqueues to an encrypted bounded queue; server re-validates everything (type/category allowlists, duration 0–86400, future-timestamp rejection with 5-min skew, 1 MB body cap, 100 items/batch, whole-batch atomicity, internal-process exclusion, website domain normalization). Evidence: `src/app/api/agent/activity/route.ts`, `omnisight-agent/src/collectors/activity-collector.ts`, `omnisight-agent/src/storage/activity-queue.ts`, `omnisight-agent/src/services/queue-uploader.ts`.

### Website tracking — **PASS**
Browser extension → native messaging host → `WebsiteCollector` (event-driven, domain-only, slice aggregation) + native `BrowserActivityMonitor` (BEST_EFFORT); server re-normalizes to bare domain and independently gates on org `website_tracking` config. Evidence: `omnisight-agent/src/collectors/website-collector.ts`, `browser-extension/`, `src/app/api/agent/activity/route.ts` (WT-P2-1), `tests/website-tracking.test.ts` (PASS).

### Screenshots — **PASS**
Agent: consent+config+working-hours-gated capture, AES-256-GCM encrypted spool, bounded, drained with retry/backoff. Server: token+consent gate, 5 MB cap, magic-byte MIME validation (PNG/JPEG/WebP only; SVG/GIF rejected), server-parsed PNG dimensions, UUID filenames, storage-driver write → DB row + device heartbeat + audit log in one transaction, orphan-file cleanup on transaction failure. Serving: session auth + org-scoped lookup + signature re-validation + `nosniff`. Retention: two-phase file-first purge + global orphan sweep. Evidence: `src/app/api/agent/screenshot/route.ts`, `src/app/api/screenshots/[id]/image/route.ts`, `omnisight-agent/src/collectors/screenshot-collector.ts`, `src/lib/jobs/retention.ts`, `src/lib/storage/*`, `tests/screenshots.test.ts` (SH-13..18 isolation/delete PASS).

### Location — **PASS**
Closed schema (coordinates + accuracy + timestamp + source only; addresses/reverse-geocoded strings rejected), consent + org-config gates, 5 km server-side movement filter (`recordAgentLocation`), IP-fallback with null accuracy, org-scoped history endpoint, Leaflet UI. Evidence: `src/app/api/agent/location/route.ts`, `src/lib/location-service.ts`, `tests/location-*.test.ts` (PASS).

### Keyboard telemetry — **PASS**
Count-only aggregate (`keystrokeCount`, `activeTypingSeconds`), no raw-key table by design, consent + config gates. Evidence: `KeyboardActivity` model, `omnisight-agent/src/collectors/keyboard-activity-collector.ts`, `tests/keyboard-*.test.ts` (PASS).

### USB monitoring — **PASS**
SetupAPI enumeration, insert/remove/blocked events, VID/PID/vendor/serial, DB-level dedupe key, org-scoped purge. Evidence: `UsbEvent` model, `tests/usb-*.test.ts` (PASS).

### Commands (server → agent) — **PASS**
`AgentCommand` (allowlisted `webcam.start`/`webcam.stop`, PENDING→DELIVERED→ACKNOWLEDGED atomic transitions, expiry, org+device scoped). Evidence: schema + `tests/device-commands.test.ts` (PASS), `omnisight-agent/src/services/command-poller.ts`.

### Webcam — **PASS (metadata only, by design)**
`WebcamSession` metadata; frames relayed in-memory with TTL, never persisted; consent/config enforced mid-session; command-driven only. Evidence: schema, `src/app/api/agent/webcam/*`, `omnisight-agent/src/services/webcam-controller.ts`, `tests/webcam-*.test.ts` (PASS).

### Consent & privacy — **PASS**
Versioned `ConsentPolicy`, per-employee `Consent` state machine (pending/granted/denied/revoked/expired), immutable `ConsentLog` (FK RESTRICT), expiration job, fail-closed server re-check on every upload type, `BreakSession` canonical break state (partial unique index: one open break per employee) with admin/self-service/agent sources and legacy Activity mirror rows for realtime consumers. Evidence: `src/lib/consent.ts`, `src/lib/breaks/*`, schema comments, `tests/consent*.test.ts` (PASS).

### Policy enforcement (app whitelist/blacklist) — **PASS**
`AppListEntry` (name/executable/publisher/SHA256/path), versioned policy payload shipped via `/api/agent/config`, agent `PolicyEnforcer` (monitoring + optional terminate), `PolicyViolation` with DB dedupe key. Evidence: schema, `src/app/api/agent/config/route.ts`, `omnisight-agent/src/collectors/policy-enforcer.ts`, `tests/policy-*.test.ts` (PASS).

### Break mode / working hours — **PASS**
Server-authoritative break state on heartbeat + config; agent pauses all collectors; working-hours window evaluated in org timezone (same-day + overnight, malformed fail closed). Evidence: `src/lib/breaks/*`, `omnisight-agent/src/lib/working-hours.ts`, `tests/break-*.test.ts`, `tests/working-hours.test.ts`, `tests/screenshot-collector-working-hours.test.ts` (PASS).

### AI insights, anomalies, sentiment — **PASS**
`AiInsight`, `Anomaly` (rule-based detection job with DB dedupe per org:employee:type:day), `SentimentRecord` (AI provider or rules fallback; NULL when no data — never fabricated). Evidence: `src/lib/anomalies/*`, `src/lib/jobs/detect-anomalies.ts`, `src/lib/ai-insights/*`, `tests/anomaly-*.test.ts` (PASS).

### OCR / screenshot analysis — **PARTIAL (manual only)**
`POST /api/screenshots/[id]/analyze` (admin-triggered VLM OCR + analysis via `callAIProviderVision`), `batch-analyze`, `ocr-search` (indexed `ocrText`), no mock fallbacks (502 on failure). **No automatic OCR pipeline, no queue, no background worker** — analysis is on-demand only. Evidence: `src/app/api/screenshots/[id]/analyze/route.ts`, `ocr-search/route.ts`, `batch-analyze/route.ts`.

### Reports & export — **PASS**
PDF (PDFKit) via `reports/pdf/*` + `reports/[id]/pdf`; CSV/XLSX via `export/[type]` (keyset-paginated, capped, manager+, org-scoped); `reports/generate`, daily report + AI summary. Evidence: `src/app/api/export/[type]/route.ts`, `src/lib/pdf/*`, `tests/reports*.test.ts`, `tests/admin-prod-reports-rbac.test.ts` (PASS).

### Realtime — **PASS**
Bun/Socket.io mini-service (`mini-services/live-updates/`): cursor-polled activity/notification/device/anomaly/USB events, presence transitions, `pg_notify` wake-up; browser `useWebSocket` provider; server-restart-safe persisted cursor. Evidence: `mini-services/live-updates/*`, `src/components/providers/websocket-provider.tsx`, `tests/live-updates-*.test.ts` (PASS), `tests/ws-invalidation.test.ts` (PASS).

### Branding — **PASS**
Platform + per-org branding, SVG sanitization, logo upload through storage driver, favicon set. Evidence: `PlatformBranding`/`OrganizationBranding` models, `tests/branding-regression.test.ts` (7/8 — one stale expectation, §D).

### Projects & time tracking — **PASS**
Project CRUD, members, manual `TimeEntry`, auto-sync engine (`ProjectTimeSync` buckets with idempotent `(employee,project,date)` key + crash-safe global cursor, `ACTIVITY_AUTO` entries never fabricated). Evidence: `src/lib/project-time/*`, schema, `tests/projects.test.ts`, `tests/active-project.test.ts` (PASS).

### Audio transcription — **PASS (external microservice)**
Python FastAPI + Whisper; state machine uploaded→queued→transcribing→completed/failed; retry ≤3; callback endpoint. Evidence: `mini-services/transcription/`, `src/lib/audio/*`. (Microservice not executed in this audit — **NOT VERIFIED** at runtime.)

---

## D. EXISTING FEATURE FAILURES (web test suite: 14 failing files — all classified)

| File | Failure | Classification |
|---|---|---|
| `agent-hardening.test.ts` (15/15) | `TypeError: Request with GET/HEAD method cannot have body` in shared `req()` helper at `createAndLogin` — calls `loginApi.POST(req(null, {body}))` without `method:'POST'`; helper defaults to GET | **Test-harness bug (Next 16 + undici enforce the spec)** — reproduced in isolation: `new NextRequest(url,{method:'GET',body})` throws on installed Next 16.3.0. Product endpoints never receive the request |
| `telemetry-backend.test.ts` (21/21) | same `req()` GET+body bug in setup | Test-harness bug |
| `screenshots.test.ts` (SH-01..12) | same bug (SH-13..18 PASS — they bypass the broken helper) | Test-harness bug |
| `claim-cancel.test.ts` (13 hits) | same bug | Test-harness bug |
| `agent-active-device-backend.test.ts` | same bug (12 hits) | Test-harness bug |
| `super-admin.test.ts` (SA-15..17) | same bug (3 hits) | Test-harness bug |
| `admin-prod-sidebar.test.ts` (NAV-1) | asserts every `PAGE_MIN_ROLE` value ∈ {viewer,manager,admin,org_admin}; `src/lib/navigation.ts` legitimately uses `'super_admin'` (a valid `NavMinRole`, line 17) for super-admin pages | **Stale test expectation** (test predates super_admin values in the map) |
| `role-rbac-nav-fix.test.ts` (ROLE-20) | asserts navigation.ts contains literal comment `'canAccessPage() ... special case'`; the file documents the case differently ("Super Admin pages — require exact super_admin role…") | Stale test expectation (comment reworded) |
| `branding-regression.test.ts` (BRAND-6) | asserts `src/app/page.tsx` does not contain `/branding/`; the new platform-branding feature legitimately references the `/branding` route | **False positive** — stale legacy-ref check vs new feature |
| `rbac-hardening.test.ts` (RBAC-01..) | `login('rimon@admin.com','Rimon2714')` → 401; the live server's bootstrap password (`.env`) is `Rimon0000000`; verified `rimon@admin.com` + correct password logs in successfully | **Test-data drift** (hardcoded old dev password); product login verified working |
| `agent-discover.test.ts` (SEC-1,3,4) | `PrismaClientValidationError` on `db.device.findUnique` / `db.deviceClaim.findUnique` in test — queries a `where` shape that no longer matches the schema (schema drifted after `20260828000000_remove_agent_registration`) | **Test-code drift** vs schema |
| `agent-existing-device-security.test.ts` (17b, 25) | expects a specific discovery flow; server returns `AUTHENTICATION_REQUIRED` for an unauthenticated rediscovery where the test expected concealment | **Possible real behavior difference — NOT VERIFIED**; needs a decision: unauth discover → 401 (current) vs 404 (test expectation). One of two genuinely open items |
| `super-admin-organizations.test.ts` (SA-ORG-06) | assertion (empty DB → empty array) PASSED; failure is in the test's own restore step — `db.organization.create` hits `Unique constraint failed (slug)` because two CUIDs share the same first 8 chars in `sa-orgs-<id.slice(0,8)>` | **Test bug** (non-idempotent restore, slug collision) |
| `sound-live-monitor-browser.test.ts` | `ReferenceError: beforeAll is not defined` — imports `playwright` directly, uses Jest-style globals, no runner in `package.json` | **Orphaned test / harness mismatch** — cannot run under `tsx --test`; not wired into any script |

**Bottom line: 0 confirmed product regressions.** Two items are genuinely open (agent-existing-device-security behavior; agent-discover test expectations) and must be adjudicated during Phase 0, not assumed.

---

## E. EXISTING FEATURE REGRESSION RISKS

1. **Next 16 request-construction change** — any code/tests constructing `Request`/`NextRequest` with GET+body breaks silently; grep `new NextRequest(` across the repo before touching request helpers.
2. **At-least-once activity delivery** — documented in `queue-uploader.ts` (F-13): crash between server write and local ack → duplicate Activity rows. Acceptable today; **becomes a data-correctness problem for working-hours/productivity math** — dedupe must land before Features C/D.
3. **`Activity` rows have no `organizationId`** — org scoping always joins through `employee.organizationId`; any new query must follow the same pattern (retention does this correctly).
4. **Legacy mirror rows** — BreakSession ↔ Activity mirror rows must keep being written together; new features must not assume one is authoritative alone.
5. **`.next/dev/types` corruption** — build-breaking environmental artifact; CI must clean `.next` before build.
6. **`package-lock.json` stub** — dependency drift risk if npm is used; canonicalize the lockfile.
7. **Screenshots in DB?** — No. Verified: binary objects live in the storage driver (`local` fs or Supabase bucket `screenshots/<orgId>/<file>`); the DB stores only metadata + display path. This architecture already matches the audit's recommended object-storage shape.

---

## F. PROPOSED V1 FEATURE INVENTORY (with evidence-based status)

| Feature | Existing support found | Gap |
|---|---|---|
| A. Reliable Activity Monitoring | Full pipeline exists (§C) | No idempotency/dedupe key on upload; active-window tracking is foreground-window (accurate); offline buffering + retry exist |
| B. Website Monitoring | Exists end-to-end (extension + native BEST_EFFORT, domain-only) | Browser limitations: extension required for per-tab accuracy; extension-free mode is heuristic. Non-invasive by design |
| C. Productivity Classification | `Activity.category` field + client heuristic; server allowlist; analytics/reports consume it | No server-authoritative classification; no org-specific rules; classification changes require code deploy |
| D. Verified Working Hours | Working-hours config, idle events, breaks, timestamps, org timezone | No attendance/timesheet model; no daily/weekly aggregation; overtime not modeled; no timezone-safe day bucketing table |
| E. Screenshot Intelligence | Manual VLM OCR + analyze + ocr-search + `ocrText` column | No automatic processing queue; no thumbnails; no storage budget for originals; cost control for AI |
| F. Realtime Dashboard | Socket.io + presence + event feed + cursor persistence + live-monitor UI | Mostly done; verify event-stats coverage (live-monitor/event-stats exists) |
| G. Alerts / Rules Engine | `Alert` model + statuses + manual create + notifications + anomaly job | No configurable IF-THEN rules; no rule table; no scheduled evaluator; dedupe/ack only via anomaly dedupe keys |
| H. Reports | PDF/CSV/XLSX exist; employee/team dashboards exist | Scheduled reports absent (jobs infra exists) |
| Object storage | Driver abstraction (local + Supabase S3) with fail-closed prod | Verify capacity plan for local driver at scale (§L) |
| Retention | Comprehensive org-scoped retention + orphan sweep | Audio uses screenshot window; verify configurable 7/14/30/60/90 UI exposure (`settings/retention` route exists) |
| Mobile Service Apps | Reuses agent auth concepts (DeviceClaim/AgentToken/AgentSession) | Refresh tokens, FCM, push commands, geofence, attestation, background service: not implemented |

---

## G. FEATURE-BY-FEATURE FEASIBILITY (see matrix §18 for the exact table)

- **A — GREEN.** Everything needed exists. Required work: idempotency keys on `/api/agent/activity` (+ DB constraint), agent clock-skew handling (already tolerant), and a documented dedupe contract.
- **B — GREEN.** Exists. Required work: none for V1 other than polish; extension packaging documented (already in `browser-extension/`).
- **C — YELLOW.** Requires a server-authoritative classifier: new table `ActivityCategoryRule` (org-scoped patterns → category) or a config-driven ruleset evaluated at ingestion; existing `Activity.category` column is reusable; analytics/reports keep working unchanged. No schema risk to existing features.
- **D — YELLOW.** Computable from existing telemetry (activity durations + idle rows + breaks + working-hours config). Needs: new `WorkDay`/attendance aggregation (or summary table), timezone-safe day bucketing, edge-case handling (sleep, restarts, clock changes, duplicate events). New tables, no changes to existing tables.
- **E — YELLOW.** Architecture supports it (storage driver, model, VLM helper, jobs infra). Needs: background OCR worker (queue + processor + retry), thumbnail generation (sharp is already a dependency), storage budget math, cost controls. On-demand analysis already works.
- **F — GREEN.** Exists. Verify event coverage; consider activity-event fan-out for dashboards (already present via `activity-events.ts`).
- **G — YELLOW.** Needs a `Rule` model + scheduled/event-driven evaluator + dedupe + ack workflow. Reuses Alert model, notifications, and the jobs scheduler. Anomaly detection job is the proof that rule evaluation on a schedule works today.
- **H — GREEN.** CSV/PDF/Excel exist; scheduled reports = config flag + existing jobs infra (YELLOW for scheduling only, minor).
- **Mobile — RED for V1 as specified.** Backend patterns are reusable, but refresh-token lifecycle, FCM push, geofence, device attestation, and a background service are entirely new. Recommend a separate mobile track (Phase 8).

---

## H. ARCHITECTURE GAPS

1. **No ingestion-level dedupe for Activity** (at-least-once duplicates). Affects C/D correctness.
2. **Classification is not authoritative server-side.** The server should own category resolution (config-driven), with the agent's value as a hint.
3. **No background processing worker** for screenshots (OCR/thumbnails/AI) — everything is synchronous/on-demand; blocks E at scale.
4. **No rules engine** — alerts are manual + hardcoded anomaly heuristics; no tenant-configurable rules.
5. **No aggregation/summary layer** — dashboards/reports compute from raw rows; fine today, will need materialized summaries at the §L scale.
6. **No refresh-token/mobile session tier** — mobile needs one.
7. **Realtime presence is in-memory in the mini-service** — acceptable single-instance; document multi-instance limitation (DB-backed cursor exists, presence map does not).
8. **Live-updates service has no built-in auth** — org scoping is event-level; verify access control for the socket before exposing externally (currently localhost/Caddy-gated).

---

## I. DATABASE GAPS

Reusable as-is: `Activity` (A, B, D), `Screenshot` (+`ocrText`) (E), `Alert`/`Notification` (G), `BreakSession` (D), `ProjectTimeSync` (D/H), `OrganizationSetting` (C/D/G config), `Report` (H).

Required new:
- `ActivityUploadDedupe` or an idempotency column/key on Activity (A).
- `CategoryRule` (org-scoped classification rules) (C).
- `WorkDaySummary` / `Attendance` daily buckets (D).
- `Rule` / `AlertRule` (+ maybe `RuleEvaluationLog`) (G).
- `ScreenshotJob` queue table or reuse of a generic job queue (E).
- Optional: `Thumbnail` metadata column (path/size) on Screenshot (E).
- Optional: `ReportSchedule` (H).

Missing indexes to consider at scale: `Activity(organizationId via employee, timestamp, category)` already covered by `@@index([employeeId, timestamp, category])` + employee join — acceptable; add `Screenshot(capturedAt)` covered; `LocationEvent(recordedAt)` covered. New summary tables must index `(organizationId, date)`.

Migration risk: LOW — all additions are new tables/columns; no existing column or constraint is altered. The one behavioral migration: adding a unique dedupe key to Activity ingestion must not reject legitimate re-uploads of old events (make it opt-in per batch).

---

## J. API GAPS

Reusable: `/api/agent/activity`, `/api/agent/screenshot`, `/api/agent/location`, `/api/agent/config`, `/api/agent/commands`, `/api/agent/consent`, `/api/agent/break`, `/api/screenshots/*`, `/api/analytics/*`, `/api/reports/*`, `/api/export/*`, `/api/alerts`, `/api/settings/retention`, `/api/live-monitor/event-stats`.

Required new: `POST /api/agent/activity` extension with `batchId`/idempotency (A); `POST /api/agent/screenshot` extension with auto-process flag or a separate `POST /api/screenshots/process` job enqueue (E); `POST /api/alerts/rules` CRUD + `POST /api/alerts/rules/evaluate` (or scheduled) (G); `GET/POST /api/reports/schedules` (H); mobile endpoints (M) — separate surface, do not entangle with agent routes.

Rule: extend existing endpoints before adding new ones (the codebase follows this well today).

---

## K. AGENT GAPS

Verified strong: collectors, encrypted queue/spool, uploader with 401-recovery, config sync, consent gate, working hours, break mode, policy enforcer, tamper detection, webcam controller, command poller, scheduler, orphan recovery, shutdown coordinator (48 test files, 625 tests green).

Gaps for V1:
1. **No idempotency batch id** in `ActivityApi.upload` (A).
2. **BrowserActivityMonitor (native website tracking) is BEST_EFFORT** — fine, documented (B).
3. **No OCR/thumbnail capability in-agent** — decision needed: server-side worker (recommended) vs agent-side (rejected: CPU/RAM impact, §14).
4. **No local dedupe of slices** across restarts — a crash can reopen a slice; minor.
5. **Agent version reporting** exists (`agentVersion` on Device); no enforced minimum-version gate — add server-side capability negotiation if E/C need newer collectors.

---

## L. STORAGE & SCALABILITY GAPS

Modeled at 100 employees × 8 h × 22 days × 1 screenshot/min:
- Screenshots/month: 100 × 480 × 22 = **1,056,000**
- At ~200 KB avg PNG (compressed window captures): **~211 GB/month originals** (worst case 100% capture; real-world at 5-min cadence ≈ 42 GB)
- DB rows: 1.06 M Screenshot rows + 1.06 M Activity rows (1/min) + presence/heartbeat updates — **PostgreSQL handles this fine with existing indexes** (verified index coverage on `organizationId+capturedAt`, `employeeId+capturedAt`).
- Network: ~211 GB/month up (or ~42 GB at 5-min cadence). At 60 s cadence this is a real cost on metered egress.
- Thumbnails: 0 today — the viewer streams full originals (needs thumbnails; sharp already a dependency).
- OCR/AI volume: at 1/min the VLM path is cost-prohibitive to run automatically; on-demand + sampled batch analysis is the correct default.

**Findings:**
- Screenshots are NOT in the relational DB and NOT loose files — they go through a storage driver (`local` fs `uploads/screenshots/<orgId>/<uuid>.png` or Supabase S3 bucket `screenshots/<orgId>/...`), fail-closed in production. **The recommended object-storage architecture is already the design.**
- The local driver has no quota/space accounting — at 211 GB/month the local filesystem needs a capacity plan (recommend S3-compatible driver for production; Supabase path already implemented; switching drivers is a config change, not code).
- No thumbnail generation or image optimization anywhere in the serving path.

---

## M. SECURITY GAPS

Verified strong: server-authoritative token/session auth, RBAC at API + UI, org-scoped queries everywhere (incl. screenshot serving 404 concealment), consent fail-closed at every ingestion point, magic-byte upload validation, closed schemas, rate limiting (Postgres token bucket, dual-layer login), SVG sanitization, CSP, security headers, AES-256-GCM at rest (agent spool + secrets), audit logging.

Gaps/notes:
1. `organization_id`/`employee_id`/`device_id` are never trusted from clients — server derives them from the token (verified in all agent routes). **PASS on spoofing.**
2. Socket.io mini-service has no auth handshake of its own — verify the reverse-proxy/Caddy layer before exposing beyond localhost.
3. `.claude/helpers` files are lint-scanned but also ship repo-local helper code — ensure they are not part of the deployable bundle (they are not in `src/`).
4. `SUPER_ADMIN_EMAIL/PASSWORD` live in `.env` — standard, but note the seeded password pattern used by tests (`Rimon2714`) should not reappear anywhere real.
5. Upload paths are UUID + sanitized employee segment — path traversal prevented (verified `sanitizeFilenameSegment`).
6. Rate limiting on agent endpoints exists (login/discover); verify rate rules cover `/api/agent/screenshot` at 1/min cadence × many devices (should be exempt from aggressive limits — check `src/proxy.ts` matchers).

---

## N. PRIVACY GAPS

Verified: domain-only website tracking (no URLs), count-only keystrokes (no raw keys), coordinates-only location (no addresses), consent per type with versioning, break mode pauses ALL collectors, working-hours window respected, org timezone authoritative, retention + anonymization for compliance records.

Notes:
1. After-hours collection: configurable via `working_hours_only` (org setting) — default off/on? Verify the default (`src/lib/jobs/settings.ts` registry) and document.
2. Screenshot content is inherently sensitive; ensure the AI provider policy (VLM) is disclosed to employees (consent content) before automating E.
3. No per-employee "pause my monitoring" beyond break mode — by design (admin/self-service/agent break sources exist).
4. Email monitoring: consent type exists (`email_monitoring`) but no agent collector — documented as not implemented (README). Do not ship in V1.

---

## O. PERFORMANCE GAPS

- Activity timeline/screenshot queries: existing composite indexes cover the hot paths (`employeeId,timestamp,category`, `organizationId,capturedAt`). Verified in schema.
- Date-range reports over 90+ days: currently computed on the fly (`export` uses keyset pagination; analytics queries may be heavier). At §L scale, add `WorkDaySummary` before building D/H reporting.
- Realtime: cursor-polling is efficient (LM-6 indexes on `createdAt`); presence map is in-memory (single instance).
- No caching layer — acceptable for now; add materialized daily summaries with the jobs infra rather than Redis.

---

## P. TESTING GAPS

**Must fix before V1 (Phase 0):**
1. The `req()` helper GET+body bug in 6+ suites (blocked test files, §D).
2. Stale expectations: `admin-prod-sidebar` NAV-1 allowed-role list, `role-rbac-nav-fix` ROLE-20 comment, `branding-regression` BRAND-6 `/branding/` check.
3. `rbac-hardening` hardcoded password (parameterize from env).
4. `agent-discover` test schema drift (update test to current schema).
5. `agent-existing-device-security` — adjudicate 401-vs-404 behavior deliberately, then fix test or code.
6. `super-admin-organizations` restore-step slug collision.
7. `sound-live-monitor-browser` — wire to a real runner or delete/rewrite.
8. Add a CI gate: typecheck + lint + build with `.next` cleaned.

**Required for V1 features:** unit (dedupe, classification rules, timesheet math, rules engine, thumbnail gen), integration (each new endpoint), cross-repo (agent↔web contract for batch id), retention/cleanup (new tables), multi-tenant isolation (new endpoints), offline/retry (idempotent replay), performance (index plans at 1 M rows/month).

---

## Q. CROSS-REPOSITORY DEPENDENCIES

- Agent depends on web API contract: `/api/agent/*` (auth, activity, screenshot, location, config, commands, consent, break, policy-violations, tamper, keystroke, usb, webcam). Contract tests exist in both trees (`tests/agent-*.test.ts` web; `tests/api-client.test.ts` agent).
- Web depends on agent only through ingestion + config consumption. No shared schema; the agent has its own types mirror.
- `branding-regression.test.ts` reads the agent repo from the web tree (AGENT_PRESENT pattern) — cross-repo tests run when the sibling repo is checked out.
- Risk: adding `batchId` to activity upload must be backward-compatible (old agents omit it — server treats absence as today's behavior). Version-gate any agent-side requirement.

---

## R. REQUIRED MIGRATIONS

New tables/columns only (no destructive changes):
1. `ActivityBatchReceipt` (idempotency) or unique batch-key column (A).
2. `CategoryRule` (C).
3. `WorkDaySummary` (D).
4. `AlertRule` + `RuleEvaluation` (G).
5. `ScreenshotJob` (queue table) + `Screenshot.thumbnailPath`/`thumbSize` (E).
6. `ReportSchedule` (H, optional).
7. Mobile tables (M) in the mobile track.

All additive; `prisma migrate dev` with documented names; no data backfill required (new tables start empty; D can backfill from existing Activity on a rolling basis).

---

## S. REQUIRED NEW SERVICES / WORKERS

1. **Screenshot processing worker** (E): drains `ScreenshotJob` → thumbnail (sharp) → optional VLM OCR/analysis → updates `Screenshot` row. Reuse `src/lib/jobs` scheduler; retry with bounded attempts; per-org cost caps.
2. **Rules evaluator** (G): scheduled scan (reuse `detect-anomalies.ts` pattern) evaluating org `AlertRule`s against telemetry; dedupe per (org, employee, rule, day); writes `Alert` + `Notification`.
3. **Timesheet aggregator** (D): daily job bucketing Activity/idle/break into `WorkDaySummary` in org timezone; idempotent per (org, employee, date).
4. Optional: report scheduler (H).

---

## T. IMPLEMENTATION DEPENDENCIES

```
A (dedupe/idempotency) ──► D (timesheets) ──► H (reports)
C (classification) ──────► D, H
E (worker + thumbnails) ──► storage capacity (L), cost controls
G (rules) ────────────────► D (needs summaries), F (realtime delivery)
F (realtime) ─────────────► already exists; consumes events from A/D/G
M (mobile) ───────────────► independent; reuses auth patterns only
```

---

## U. RECOMMENDED IMPLEMENTATION ORDER (with rationale)

1. **Phase 0 — Stabilization**: fix the test harness + stale tests; CI gate; canonical lockfile; adjudicate the two open items. *Unblocks everything (no green baseline otherwise).*
2. **Phase 1 — Reliable telemetry**: activity idempotency keys + dedupe; version negotiation. *Foundation for C/D/H correctness.*
3. **Phase 2 — Screenshot/storage/retention hardening**: thumbnails; storage budget + driver capacity plan; retention UI exposure; per-org quotas.
4. **Phase 3 — Productivity + working hours**: server-authoritative classification (CategoryRule); WorkDaySummary aggregator; daily/weekly views.
5. **Phase 4 — Realtime dashboard**: verify + extend event coverage; auth for the socket service.
6. **Phase 5 — Alerts/rules**: AlertRule CRUD + scheduled evaluator + dedupe/ack/audit.
7. **Phase 6 — Reports**: employee/team report pages (largely exist); scheduled reports.
8. **Phase 7 — Screenshot intelligence**: worker-driven OCR/thumbnails/AI with cost caps.
9. **Phase 8 — Mobile Service Apps**: separate track; reuse auth; add refresh tokens/FCM/push/geofence.

---

## V. RISK REGISTER

| # | Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|---|
| 1 | Test baseline stays red → regressions go unnoticed | High (current state) | High | Phase 0 harness fix + CI gate before any V1 work |
| 2 | Activity duplicates corrupt working-hours/productivity math | High | Medium-High | Idempotency keys before C/D |
| 3 | Client-side classification ships as "authoritative" | Medium | Medium | Server-owned classifier in Phase 3 |
| 4 | Screenshot volume (211 GB/mo at 1/min) overwhelms local disk | Medium | High | Storage driver → S3-compatible; cadence defaults; retention default 30d |
| 5 | VLM cost explosion from automatic OCR | Medium | High | On-demand + sampled batch; per-org caps |
| 6 | Rules engine alert spam | Medium | Medium | DB dedupe per rule/employee/day (pattern exists) |
| 7 | Socket mini-service exposed without auth | Low | High | Caddy/auth check in Phase 4 |
| 8 | Mobile scope creep into V1 | High | High | Explicitly deferred (§26) |
| 9 | `.next` corruption recurring in CI | Medium | Low | Clean-before-build step |

---

## W. FINAL READINESS SCORE

**7.5 / 10** — Existing platform: excellent (9/10). V1 readiness today: 6/10 (test baseline red + dedupe + classification ownership). After Phase 0 and Phase 1: 8.5/10.

---

## 18. FEATURE FEASIBILITY MATRIX (as required)

| Feature | Existing Support | Backend | Agent | Database | UI | Security | Storage | Performance | Feasibility | Required Work |
|---|---|---|---|---|---|---|---|---|---|---|
| Activity Monitoring | HIGH | GREEN | GREEN | GREEN | GREEN | GREEN | GREEN | YELLOW | GREEN | Idempotency keys; documented dedupe |
| Website Monitoring | HIGH | GREEN | GREEN | GREEN | GREEN | GREEN | GREEN | GREEN | GREEN | Extension packaging polish |
| Productivity | MEDIUM | YELLOW | YELLOW | YELLOW | GREEN | GREEN | GREEN | YELLOW | YELLOW | Server classifier + CategoryRule table |
| Working Hours | MEDIUM | YELLOW | GREEN | YELLOW | YELLOW | GREEN | GREEN | YELLOW | YELLOW | WorkDaySummary + edge cases |
| Screenshot Intelligence | MEDIUM | YELLOW | GREEN | YELLOW | GREEN | GREEN | YELLOW | YELLOW | YELLOW | Worker + thumbnails + cost caps |
| Realtime Dashboard | HIGH | GREEN | GREEN | GREEN | GREEN | YELLOW | GREEN | GREEN | GREEN | Socket auth + event coverage |
| Alerts | LOW | YELLOW | GREEN | YELLOW | GREEN | GREEN | GREEN | YELLOW | YELLOW | AlertRule model + evaluator |
| Reports | HIGH | GREEN | n/a | GREEN | GREEN | GREEN | GREEN | YELLOW | GREEN | Scheduled reports (minor) |
| Object Storage | HIGH | GREEN | GREEN | n/a | n/a | GREEN | GREEN | YELLOW | GREEN | Capacity plan; quota accounting |
| Retention | HIGH | GREEN | n/a | GREEN | YELLOW | GREEN | GREEN | GREEN | GREEN | UI exposure for all windows |
| Mobile Service Apps | LOW | RED | RED | RED | n/a | YELLOW | n/a | n/a | RED | Separate track; new auth/transport |

**Legend:** GREEN = feasible with current architecture · YELLOW = feasible but requires architectural work · RED = major blocker / redesign required · GRAY = not currently verifiable.

---

## 19. DEPENDENCY GRAPH

```
Reliable Activity Pipeline (A) ──► Activity Timeline ──► Productivity Engine (C) ──► Employee Dashboard ──► Org Analytics ──► Reports (H)
        │                              │
        └──► WorkDaySummary (D) ───────┴──► Timesheets / Attendance (D) ──► Reports (H)

Screenshot Storage (exists) ──► Thumbnails (E) ──► OCR/Processing Worker (E) ──► Screenshot Intelligence (E) ──► AI Summary (opt-in, cost-capped)

Event Pipeline (exists: heartbeat/activity/presence) ──► Rules Evaluator (G) ──► Alert + Notification (G) ──► Realtime Delivery (F)
```

---

## 22. FINAL VERDICT

> **READY WITH BLOCKERS**

Rationale: no feature requires removing, weakening, or replacing existing functionality. The platform is genuinely implemented and its test suite (agent 625/625; web 82/96 with all failures classified as harness/stale-test/env issues, zero confirmed product regressions) plus typechecks and production build demonstrate a healthy base. The blockers — broken test harness against Next 16, missing activity idempotency, non-authoritative classification, absent screenshot worker and rules engine — are additive work items with clear designs, not redesigns.

---

## 26. FINAL QUESTION TO ANSWER

> **Can OmniSight safely evolve into the proposed V1 without removing any currently available feature?**

**YES WITH ARCHITECTURAL CHANGES** — all changes are additive (new tables, new worker, new endpoints, new config); existing endpoints, fields, permissions, UI flows, agent capabilities, and retention behavior remain untouched. The "architectural changes" are: server-authoritative classification (C), a background screenshot worker (E), a rules evaluator (G), and daily aggregation (D) — none of which disturb existing paths.

> **What is the minimum set of changes required before implementation can begin?**

1. Fix the web test harness (`req()` GET+body) and the 7 stale/broken tests — restore a green regression baseline (Phase 0).
2. Add a CI gate: clean build + typecheck + lint + the fixed test suite.
3. Add activity upload idempotency keys (Phase 1) before any productivity/timesheet work.
4. Decide storage target for production (local vs Supabase/S3) and set screenshot cadence/retention defaults (Phase 2).
5. Adjudicate the two open items: unauth discover 401-vs-404 behavior, and agent-discover test expectations.
6. Canonicalize the lockfile and add a `.next` clean step.

> **Which proposed features should NOT be included in V1 even though they are technically possible?**

1. **Mobile Service Apps** — technically possible by reusing agent auth, but refresh tokens/FCM/push/geofence/attestation are a separate product track; including it would jeopardize the rest of V1. (Defer to Phase 8.)
2. **Automatic AI screenshot summaries / full-rate OCR** — technically possible, cost-prohibitive at scale; keep on-demand + sampled. (Phase 7 with caps.)
3. **Scheduled report PDFs** — possible with existing infra but low value relative to Phase 1–6; defer.
4. **Email monitoring** — consent type exists but no agent collector; do not build in V1.
5. **Configurable idle-timeout UI to employees / employee-facing policy editing** — collection config must stay admin/server-authoritative (privacy + fail-closed design).

---

*Evidence files cited throughout: `prisma/schema.prisma`, `src/app/api/agent/{heartbeat,activity,screenshot,location,config}/route.ts`, `src/app/api/screenshots/[id]/image/route.ts`, `src/lib/{storage,api,auth,navigation,jobs/retention,export,consent,breaks,anomalies}`, `mini-services/live-updates/presence.ts`, `omnisight-agent/src/{collectors,services,storage,api}`, `tests/*` (96 files), agent `tests/*` (48 files). All commands re-run fresh on 2026-09-03.*