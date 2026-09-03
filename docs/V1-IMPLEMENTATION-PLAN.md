# OMNISIGHT V1 — IMPLEMENTATION PLAN (post-audit)

Companion to `docs/V1-FORENSIC-AUDIT.md`. Verdict was **READY WITH BLOCKERS**; this plan resolves the blockers first (Phase 0–1) before any new capability. **Every phase preserves all existing features** — no endpoint, field, permission, UI flow, or agent capability is removed or weakened. Rollback strategy per phase: revert the additive migration + feature-flag off; no data migration rewrites existing rows.

---

## PHASE 0 — EXISTING-SYSTEM STABILIZATION (blocker, must ship first)

**Goal:** restore a green regression baseline so every later phase is provably non-destructive.

**Fix the broken test harness (6 files):**
- Files: `tests/agent-hardening.test.ts`, `tests/telemetry-backend.test.ts`, `tests/screenshots.test.ts`, `tests/claim-cancel.test.ts`, `tests/agent-active-device-backend.test.ts`, `tests/super-admin.test.ts` (SA-15..17)
- Root cause: the per-file `req()` helper defaults to `GET`; `createAndLogin`/setup calls `loginApi.POST(req(null, { body }))` without `method: 'POST'` → `new NextRequest(url, { method: 'GET', body })` throws on Next 16 (undici enforces the fetch spec).
- Change: in each helper, default `method` to `'POST'` when a body is present (or pass `method: 'POST'` at the call sites); keep the helper signature. Add a tiny unit test asserting `new NextRequest` with GET+body throws is never produced by the helper.
- Verify: re-run all 6 suites green against the dev server.

**Fix stale/incorrect tests (6 files):**
- `tests/admin-prod-sidebar.test.ts` NAV-1: include `'super_admin'` in the allowed `PAGE_MIN_ROLE` value set (navigation.ts is correct — `NavMinRole` includes `super_admin`).
- `tests/role-rbac-nav-fix.test.ts` ROLE-20: update the asserted comment text to the current wording in `src/lib/navigation.ts` ("Super Admin pages — require exact super_admin role…") or assert on a stable symbol instead of prose.
- `tests/branding-regression.test.ts` BRAND-6: the `/branding/` legacy-ref check collides with the new platform-branding feature — exempt `src/app/page.tsx` (or the branding entry point) from the `/branding/` substring check; keep all other legacy-ref checks.
- `tests/rbac-hardening.test.ts`: read the super-admin password from env (`SUPER_ADMIN_PASSWORD` with a documented fallback) instead of hardcoding `Rimon2714`; or bootstrap a dedicated test user in a `before` hook.
- `tests/agent-discover.test.ts` (SEC-1/3/4): update test queries to the current schema (post `20260828000000_remove_agent_registration`); the test constructs `db.device.findUnique`/`db.deviceClaim.findUnique` `where` shapes the schema no longer accepts.
- `tests/super-admin-organizations.test.ts` SA-ORG-06: make the restore step idempotent (upsert by slug; use full cuid in the slug) — the assertion itself is fine.
- `tests/sound-live-monitor-browser.test.ts`: convert `beforeAll` to node:test `before` (or move to `tests/e2e/` with Playwright `test`) and wire it to a script; otherwise remove it.

**Adjudicate (decision required):**
- `tests/agent-existing-device-security.test.ts` (AUTH-EXIST-17b/25): decide deliberately whether unauthenticated device rediscovery returns 401 `AUTHENTICATION_REQUIRED` (current behavior — arguably correct) or 404 concealment (test expectation). Pick one, document in the route, align test + code.

**CI + environment hardening:**
- Add a prebuild/predev step: `rm -rf .next/dev/types` (or exclude `.next/dev` from the prod tsconfig `include`) — prevents the `TS1128` corruption from blocking builds.
- Canonicalize the lockfile: commit a real `package-lock.json` (or standardize on `bun.lock`) in-repo; delete the parent-dir stub `E:\Live project\omnisight\package-lock.json`.
- Add a CI job: clean typecheck → lint (allow-list `.claude/` or ignore it) → build → the full `tsx --test tests/*.test.ts` suite → agent `npm test` + `npm run typecheck`.
- Lint: add `.claude/` to `.eslintignore` (the 8 errors live there).

**Tests:** the 14 failing files + a new `tests/request-helper.test.ts`.
**Risks:** touching tests that encode real security expectations — change assertions only where the product code is verifiably correct (per §D table).
**Dependencies:** none.
**Rollback:** revert test/CI edits only; no DB impact.

---

## PHASE 1 — RELIABLE TELEMETRY / ACTIVITY PIPELINE

**Goal:** at-most-once activity ingestion; versioned agent capability contract.

**Agent changes:**
- `omnisight-agent/src/api/activity.ts`: attach a per-drain `batchId` (uuid) + `batchSeq` to uploads; `queue-uploader.ts` generates one id per drain cycle; keep old agents working (server accepts absence).
- `activity-collector.ts`/`website-collector.ts`: no change to slice logic; rely on server dedupe.

**Backend changes:**
- `src/app/api/agent/activity/route.ts`: accept optional `batchId`; store receipts in a new table (below) in the same transaction; return `deduplicated: n` when a receipt already exists. Absent `batchId` → today's behavior (backward compatible).
- `src/lib/jobs/settings.ts`: add `agent_min_version` registry entry (optional) for capability gating.

**Database:** new table `ActivityBatchReceipt (id, organizationId, employeeId, batchId, receivedAt, rowCount)` with `@@unique([organizationId, employeeId, batchId])`. Additive; no backfill.

**APIs:** extended `POST /api/agent/activity` only (no new endpoint).

**Migrations:** `20260903_activity_batch_receipts` (additive).
**Tests:** unit (dedupe logic), integration (same batchId twice → one row set, second 200 with deduplicated count), cross-repo (old-agent payload without batchId still accepted), offline/retry (crash-replay uploads a duplicate batchId → no dupes).
**Risks:** receipt table growth — bound by per-employee cleanup in the retention job (add receipt purge older than activity retention).
**Dependencies:** none.
**Rollback:** feature-flag `ACTIVITY_DEDUPE=off`; receipts ignored; migration revert is a plain drop.

---

## PHASE 2 — SCREENSHOT / STORAGE / RETENTION HARDENING

**Goal:** scale-safe screenshot storage; thumbnails; capacity controls.

**Backend:**
- `src/lib/screenshots/storage.ts` + `src/app/api/agent/screenshot/route.ts`: generate a thumbnail at ingestion (sharp — already a dependency) and persist via `src/lib/storage` (new `putThumbnail` / `thumbnailKey`).
- `src/lib/screenshots/sweep.ts`: extend orphan sweep to thumbnails (same age guard).
- `src/lib/jobs/retention.ts`: add thumbnail deletion alongside file-first screenshot purge (same two-phase pattern); add `ActivityBatchReceipt` purge (Phase 1); expose all retention windows through `settings/retention` UI (7/14/30/60/90 presets).
- `src/lib/storage/local.ts`: add optional per-org quota accounting (track bytes; reject overshoot with 507) — config-gated so existing deployments are unaffected.

**Database:** `Screenshot.thumbnailPath String?`, `Screenshot.thumbSize Int?` (additive columns).
**Frontend:** `src/components/screenshots/*` viewer loads thumbnails first, full image on demand (keep existing URLs intact).
**Tests:** unit (thumbnail gen for PNG/JPEG/WebP; failure path keeps original), retention (thumbnail purged with original; retryable file errors), quota (507 on overshoot, org-isolated).
**Risks:** sharp on the request path adds latency — keep thumbnail generation tiny (≤ 320 px) and synchronous; full OCR stays out of this path.
**Dependencies:** Phase 1 (receipt purge shares retention).
**Rollback:** columns nullable, driver default unchanged; flag `THUMBNAILS=off` reverts to original-only.

---

## PHASE 3 — PRODUCTIVITY + WORKING HOURS

**Goal:** server-authoritative classification and verified daily timesheets.

**Backend:**
- New `CategoryRule` model + CRUD API (`/api/category-rules`): org-scoped pattern → category (application name regex, domain regex, executable), ordered, with defaults mirroring the current agent heuristics so nothing changes until an org overrides.
- `src/app/api/agent/activity/route.ts`: after allowlist validation, resolve `category` server-side from `CategoryRule` (agent value treated as hint only). Analytics/reports keep reading `Activity.category` unchanged.
- New `WorkDaySummary` model + aggregator job (`src/lib/jobs/timesheets.ts`, scheduled via `src/lib/jobs/run.ts`): per (org, employee, UTC-day-bucket-in-org-timezone) compute active/idle/break/overtime from Activity (excluding break mirror rows) + BreakSession; idempotent per day; backfill on a rolling window from existing Activity.
- Edge cases to handle explicitly: machine sleep (idle gap > idle timeout → idle), agent restart (slice gap), timezone changes (org timezone is authoritative — already the design), clock changes (server timestamp bounds already reject future), duplicate events (Phase 1 dedupe), offline days (summary row exists with zero/absent marker — never fabricated).

**Database:** `CategoryRule`, `WorkDaySummary` (additive).
**APIs:** `/api/category-rules` CRUD (admin+); `/api/work-days?from&to&employeeId` (manager+); employee self-summary via existing `self/*` pattern.
**Frontend:** employee detail productivity tab + daily/weekly timesheet table; reuse existing analytics charts.
**Tests:** unit (classification precedence, timesheet math incl. overnight windows + DST-ish boundaries), integration (upload with no rule → default; with rule → overridden), isolation (org A rules never classify org B), retention (summary purge), performance (summary index plan).
**Risks:** misclassification changes dashboards — ship with defaults identical to today's heuristics; provide dry-run evaluation endpoint.
**Dependencies:** Phase 1 (dedupe correctness).
**Rollback:** flag `CLASSIFICATION_SERVER=off` (agent category passes through); summaries are additive.

---

## PHASE 4 — REALTIME DASHBOARD

**Goal:** complete realtime coverage; secure the socket.

**Backend/mini-service:**
- `mini-services/live-updates/`: add an authentication handshake (verify the browser session cookie / an issued token against the same session store) so event channels are org-scoped and authenticated; keep cursor-polling fallback for disconnected clients (already implemented).
- Add event coverage for alerts (Phase 5), work-day summaries (Phase 3) and screenshot-processing status (Phase 2) via the existing `notify-triggers.ts`/cursor pattern.
- Verify `live-monitor/event-stats` contract against the new event types.

**Frontend:** `src/components/live-monitor/*` + `websocket-provider.tsx`: consume new event types; add loading/error/empty/permission states if missing.

**Tests:** ws invalidation regression (exists — keep green), presence transition (exists), auth handshake (new), fallback polling (exists).
**Risks:** breaking the socket contract — additive event types only.
**Dependencies:** Phases 2–3 events.
**Rollback:** old event types remain; socket auth flag can be disabled.

---

## PHASE 5 — ALERTS / RULES ENGINE

**Goal:** tenant-configurable IF-THEN rules with dedupe, severity, ack, audit.

**Backend:**
- New `AlertRule (organizationId, name, condition JSONB, severity, enabled, cooldown)` + `RuleEvaluation` log; CRUD at `/api/alerts/rules` (admin+).
- Evaluator job (`src/lib/jobs/rules.ts`): scheduled scan (reuse `detect-anomalies.ts` pattern) over: offline > X (presence map/heartbeat), idle > X (Activity idle rows), unproductive > X (category), blocked app (PolicyViolation), suspicious activity (anomaly job output). Dedupe key `org:rule:employee:utcDay` on Alert (mirror the Anomaly pattern).
- Producers reuse `createOrgNotification` for delivery; ack/resolve via existing `/api/alerts` status transitions; audit via AuditLog.
- Initial rules ship as presets (matching the audit's candidate list) so orgs get value without configuration.

**Database:** `AlertRule`, `RuleEvaluation` (additive; Alert model reused).
**Frontend:** `src/components/alerts/*`: rule list/detail + enable toggle; alert list gains rule source + dedupe badge.
**Tests:** unit (condition evaluation, cooldown, dedupe), integration (rule fires → Alert + Notification; resolved alerts never re-fire), isolation, retention (RuleEvaluation purge), ack/audit.
**Risks:** alert spam — cooldown + dedupe + severity caps; evaluation cost bounded by rule count.
**Dependencies:** Phase 3 summaries for productive-time rules.
**Rollback:** evaluator disabled by flag; rules rows additive.

---

## PHASE 6 — REPORTS

**Goal:** employee + team report pages, scheduled CSV/PDF.

**Backend:**
- Reuse `src/lib/pdf/*`, `export/[type]`, `reports/*`. Add `GET /api/reports/employee/:id` and `GET /api/reports/team` (manager+) aggregating from `WorkDaySummary` (Phase 3) + Activity + Screenshot counts + Alerts — mirror existing dashboard query patterns with keyset pagination/caps.
- Scheduled reports: `ReportSchedule` model + job (reuse jobs infra) → generates a Report row; delivery via notification/email placeholder (in-app first).

**Database:** `ReportSchedule` (optional, additive).
**Frontend:** reports page tabs (employee/team), schedule modal.
**Tests:** report RBAC (exists — keep green), aggregation correctness vs raw queries, schedule idempotency (no double-generation on crash), export format regression.
**Risks:** heavy aggregation — always read summaries, never full-table scans; enforce 90-day default window like export.
**Dependencies:** Phase 3.
**Rollback:** schedule job off; pages additive.

---

## PHASE 7 — SCREENSHOT INTELLIGENCE

**Goal:** automatic, cost-capped OCR + classification + searchable metadata.

**Backend:**
- `ScreenshotJob` queue table; worker (`src/lib/jobs/screenshots.ts`): enqueue on upload (sampled per org cadence, default off), process: thumbnail (Phase 2) → OCR via VLM (`callAIProviderVision`, same helper as manual analyze) → write `ocrText`/`aiAnalysis`; retry ≤3 with backoff; per-org monthly cost cap setting (halt queue on cap, surface in UI).
- Manual analyze endpoints remain unchanged.

**Database:** `ScreenshotJob` (additive).
**Frontend:** screenshot gallery gains OCR badge/searchable filter (uses existing `ocr-search`), processing-status chip.
**Tests:** worker retry/failure handling, cost-cap halt, isolation, retention (jobs + results purge), regression on manual analyze.
**Risks:** cost — caps mandatory; provider failure → requeue with exponential backoff, never fabricate text.
**Dependencies:** Phase 2 (thumbnails), AI provider config (exists).
**Rollback:** queue processor off by default; jobs rows additive.

---

## PHASE 8 — MOBILE SERVICE APPS (separate track)

**Goal:** scoped, non-blocking exploration only.

**Reuse:** `AgentToken`/`AgentSession` auth patterns, `DeviceClaim` enrollment, `/api/agent/config` shape, org/RBAC enforcement, `/api/agent/commands` pattern for push commands.

**New (separate mobile repo/services):** refresh-token lifecycle, FCM registration + push transport, geofence evaluation (reuses LocationEvent schema), device attestation, background-service state machine, app-inventory collection. **Explicitly NOT in V1** (see audit §26). No web/agent schema changes in V1 for this phase.

---

## DEPENDENCY SUMMARY (implementation order)

Phase 0 → 1 → 2 → (3 → 6) ∥ 4 → 5 → 7, with 8 as an independent track. Phases 0–1 are the hard gate; nothing else starts before a green baseline + dedupe.

## GLOBAL REGRESSION GATE (every phase)

Re-run: web `tsx --test tests/*.test.ts` (all 96 files), agent `npm test` (625), both typechecks, `next build` (with `.next` clean step), lint (0 errors in `src/`). The audit's §D table is the reference for which pre-existing failures are known/accepted (none should remain after Phase 0).