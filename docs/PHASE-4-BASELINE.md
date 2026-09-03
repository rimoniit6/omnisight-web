# PHASE 4 BASELINE — Daily Aggregation / WorkDaySummary (as-built, pre-Phase-4)

Status: forensic baseline, captured 2026-09-03 before Phase 4 changes.
Phase scope (authoritative): daily employee work summaries over server-side
activity data — timezone-safe day bucketing, working-hours-aware totals,
productive/neutral/unproductive durations, idempotent aggregation, rebuild,
dashboard/report consumption. No alerts, no new collectors, no screenshot AI,
no realtime redesign.

## 1. Facts verified in this audit

### 1.1 Data model (omnisight-web, Prisma/PostgreSQL)

- `Organization.timezone` (IANA, default `Asia/Dhaka`) is the single source of
  truth for org-local days and working hours. `Organization.status` =
  `active|suspended|archived`.
- `Employee` rows carry `organizationId`, `status` (`active|inactive|
  archived`), `joinDate`/`leaveDate`. No per-employee timezone — org timezone
  applies to everyone.
- `Activity`:
  - `type`: `application | website | idle | screenshot | work_session`.
  - `category`: `productive | neutral | unproductive | idle` (null allowed) —
    the Phase 3 server-authoritative verdict (or agent hint when the org has
    `server_classification` OFF).
  - `duration` (int seconds), `timestamp` (start of the interval),
    `employeeId`, `deviceId`, `title`, `url`, `applicationName`, `createdAt`.
  - **No `organizationId` column** — org scope always resolves through the
    employee relation.
  - Break-mode mirror rows are Activity rows with `type='idle'`,
    `category='idle'`, `duration=0`, and `title ∈ BREAK_TITLES`
    (`src/lib/breaks/service.ts`: “Break Mode Started [by Admin|by Employee]”,
    “Break Mode Ended …”). They exist to back the realtime/report event
    stream; they carry zero duration.
  - Indexes: `(employeeId)`, `(timestamp)`, `(employeeId, timestamp)`,
    `(employeeId, category)`, `(category, timestamp)`,
    `(employeeId, timestamp, category)`, `(createdAt)`.
- `BreakSession` (canonical break record): org + employee + device,
  `startedAt`, `endedAt` (null = active), `source`, `endReason`. Retention
  purges only ENDED sessions past `break_session_retention_days`.
- `OrganizationSetting(organizationId, key, value)` — org-scoped typed
  settings; monitoring keys are NEVER read from global `SystemSetting`.
- Existing additive precedents from Phases 1–3: `ActivityBatchReceipt`
  (`@@unique([organizationId, employeeId, batchId])`) and `CategoryRule`
  (org FK, CASCADE) — both migrated additively with index + FK patterns to
  follow.
- No `WorkDaySummary` (or any daily summary) table exists today.

### 1.2 Working-hours configuration

`MONITORING_KEYS` registry (`src/lib/jobs/settings.ts`):

- `working_hours_only` (boolean, default **true**) — agent suppresses
  collection outside the org work window by default.
- `work_start_time` / `work_end_time` (`time` HH:MM, defaults `09:00`/`18:00`)
  — the work window, interpreted **in the org timezone**.
- Agent config route ships `workingHoursOnly`, `workStartTime`, `workEndTime`,
  `timezone` to agents (org timezone is authoritative; the agent never uses
  the machine clock for the window).
- Canonical time helpers already exist (reuse, do not duplicate):
  - `src/lib/timezone.ts`: `localDayKey`, `zonedDayStart`, `zonedDayEnd`,
    `orgDayWindow`, `dayKeysBetween`, `lastNDayKeys`, `addDaysToKey`,
    `safeTimezone`, `isValidTimezone`, `hourInTimezone`, `zonedDayOfWeek`.
  - `src/lib/anomalies/time.ts`: `tzDayKey`, `tzMinutesSinceMidnight`,
    `isWithinWorkWindow` (supports overnight windows, `end <= start`),
    `parseHHMM`.
- Existing product semantics (verified in code):
  - Dashboard (`/api/dashboard`): org-local day buckets via `localDayKey`;
    per-day productive/neutral/unproductive = SUM of row `duration` grouped by
    `category` (rows bucketed to the local day of their `timestamp`; a row is
    never split across days). Productivity score = productive ÷ total
    categorized × 100. Internal-agent rows excluded
    (`NON_INTERNAL_AGENT_ACTIVITY_FILTER` / `excludeInternalAgentActivities`,
    `src/lib/agent-process.ts`).
  - Anomaly detector classifies “outside working hours” PER ROW by the row’s
    start minute (`tzMinutesSinceMidnight` + `isWithinWorkWindow`), then
    counts whole rows — never splits a row across the window edge.

### 1.3 Break semantics

Break time is NOT visible as duration in Activity rows (agent suppresses
collection during break mode; the only Activity rows are zero-duration
start/end markers). The authoritative break source is `BreakSession`
(startedAt → endedAt). Break/privacy history retention:
`break_session_retention_days` (default 0 = keep). A summary’s `breakSeconds`
must therefore come from `BreakSession` overlap with the org-local day, never
from Activity durations.

### 1.4 Job/worker infrastructure

- `JobRun(job)` unique row + crash-safe lease. `claimJob`/`finishJob`
  (`src/lib/jobs/run.ts`, lease 5 min, atomic updateMany claim). Job result
  JSON stored in `JobRun.lastResult`.
- `runScheduledJobs()` orchestrates: `expire_consents`, `retention_cleanup`,
  `project_time_sync`, `anomaly_detection`, `agent_token_sweep`,
  `rate_limit_sweep`, `device_integrity`, `user_session_sweep`,
  `audio_transcription`, `screenshot_processing`.
- Pattern for jobs that also run on a faster loop: a self-contained
  `runXJob()` that claims its own lease and returns a typed result; the
  orchestrator wraps it in try/catch and `finishJob(..., String(error))` on
  failure. Example: `detect-anomalies.ts`, `detect-device-integrity.ts`,
  `src/lib/screenshots/processing.ts` (via run.ts), project-time sync.
- `instrumentation.ts` runs a faster loop (60 s) that invokes the
  screenshot-processing job; `npm run jobs` triggers one
  `runScheduledJobs()` pass; hourly cron-equivalent is the scheduler.
- Retention (`src/lib/jobs/retention.ts`): org-iterating `runRetention()`
  → `runRetentionForOrg(orgId, now, limit)`; per-org try/catch isolation;
  `RetentionResult` counters merged from an `EMPTY` shape; `EMPTY_RETENTION`
  in run.ts mirrors the same shape. `RETENTION_KEYS` (org settings):
  `activity_retention_days` default **90** (0 = never purge),
  `break_session_retention_days` default 0, etc. Activity purge excludes
  break-mirror rows (title NOT IN BREAK_TITLES, NULL-safe OR); receipts follow
  the activity window.

### 1.5 Existing analytics consumers (what “consistency” must mean)

- `/api/dashboard` — 10-day org activity load, 7-day org-local productivity
  trend + score.
- `/api/analytics`, `/api/employees/[id]/performance`, `/api/employees/
  statistics`, reports (PDF/CSV), live-updates — all compute durations by
  summing `duration` grouped by `category`, day-bucketed in the org timezone.
- Because Phase 3 classification is stored on the row at ingestion time, a
  WorkDaySummary recomputed from stored rows is deterministic and identical
  to what these consumers compute from the same rows over the same window
  (they may round seconds → minutes for display; a summary must keep seconds).

### 1.6 Baselines

- Phase 3 GREEN: web 100/100 suites · 1606/1606 tests · 0 fail; typecheck
  PASS; lint 0 errors (439 pre-existing warnings); build PASS.
  Agent 628/628 tests; typecheck + build PASS.
- Agent repo: zero Phase-4 scope (aggregation is server-side). No agent
  change expected.

## 2. Design constraints derived from this baseline

1. WorkDaySummary must be keyed `(organizationId, employeeId, workDate)` where
   `workDate` is the **org-local calendar day** (`localDayKey` in the org
   timezone). The same UTC instant may fall on different `workDate`s for
   different orgs.
2. Duration semantics must match the dashboard/product: rows bucket to the
   local day of their `timestamp` (never split across days); per-day category
   seconds = sum of row durations; internal-agent rows excluded; break-mirror
   rows (duration 0) excluded from counts/time.
3. Working/outside-hours split follows the anomaly convention (row start
   minute against the org window, `isWithinWorkWindow`, overnight supported).
4. `breakSeconds` from `BreakSession` overlaps, not Activity durations.
5. Offline gaps are NOT fabricated — a summary covers only what raw rows
   exist; no clock-time interpolation.
6. Aggregation must be idempotent + concurrent-safe: deterministic
   whole-day recompute and upsert on the unique key (never
   “existing + incremental” accumulation).
7. Job must be bounded (trailing window tied to activity retention, capped at
   the 90-day product window), org-isolated (continue-on-error), and
   restart-safe (rebuild semantics need no cursor).
8. Retention: summaries follow the activity window (purge when raw rows are
   purged). Rule changes do NOT rewrite historical summaries (Phase 3
   semantics: history reflects ingestion-time classification).
