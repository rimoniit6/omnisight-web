# M008 Stage-1 — Real Analytics Engine & Dashboard Consumption Layer — Implementation Report

> **Scope:** Replace every remaining placeholder/fabricated/demo analytics with real
> SQL-backed analytics computed from persisted telemetry (ActivityEvent, Screenshot,
> LoginSession, DeviceHealthSnapshot, UserDailySummary rollups). No `Math.random`,
> no seeded counters, no placeholder percentages anywhere in the application.
> Stage-1 of the M008 analytics mission (ADR-018–030, design 18 §5.18, plan 19).

---

## 1. Files changed

**New schema (additive-only, design §5.18):**
- `prisma/schema.prisma` — added `UserDailySummary` (per-user-per-UTC-day rollup,
  UNIQUE(userId,date)), `AnalyticsJob` (rollup run log), `RollupCheckpoint`
  (single `key="rollup"` row — resume/crash safety). Added index-friendly
  `ActivityEvent` indexes: `@@index([userId, timestamp])`, `@@index([category, timestamp])`, `@@index([domain])`.
- `prisma/migrations/20260803111008_m008_stage1_analytics_rollup/` — applied; `prisma migrate status` = up to date (14 migrations); `prisma validate` OK.

**New analytics module** (`src/lib/analytics/`):
- `scoring.ts` — deterministic scoring (productivity, focus, activity, risk, burnout) — pure functions of persisted telemetry, formulas documented in-file, fixed constants (no AI, no random weights).
- `rollup.ts` — the rollup engine: UTC-day bucketing, incremental (checkpoint-resumed) + rebuild modes, per-(user,day) `$transaction` upsert (idempotent via UNIQUE), per-day atomic checkpoint advance (crash-safe), 3660-day safety bound, "always roll today" (live dashboards).
- `aggregate.ts` — SQL aggregation helpers: rollup totals, daily trend, top apps/domains (GROUP BY), hourly heatmap (raw SQL `strftime`), weekday heatmap, merged timeline (activity+screenshot+session+health+ocr) with keyset cursor pagination, online presence, health alerts.
- `scope.ts` — role-aware analytics scoping (Admin org-wide · Manager org-scoped · Employee self-only) + `analyticsRoute` wrapper (thrown 401/403 `Response` surfaces instead of 500).
- `worker.ts` — background rollup worker (instrumentation-started, 15-min cadence + startup catch-up, single-instance guard, honors `ANALYTICS_ROLLUP_ENABLED`).
- `index.ts` — barrel.

**Dashboard APIs (rewritten — real data, frontend contracts preserved):**
- `src/app/api/dashboard/route.ts` — KPIs (users/active/devices/online/screenshots/productivity/open+critical events/licenses/providers), departments (rollup-averaged scores), 7-day trend, top apps, device statuses, recent events.
- `src/app/api/dashboard/activity/route.ts` — active/idle minutes, sessions, category split, top apps + websites, hourly heatmap.
- `src/app/api/dashboard/productivity/route.ts` — daily trend, averages, top performers, at-risk, department averages — all from rollup scores.
- `src/app/api/dashboard/devices/route.ts` — fleet totals, online/offline/percent, per-device health (latest snapshot), uptime (agentUptimeS), health alerts.
- `src/app/api/dashboard/timeline/route.ts` — merged chronological timeline + cursor pagination.
- `src/app/api/dashboard/heatmap/route.ts` — hourly / weekday / application / website heatmaps (SQL aggregation only).
- `src/app/api/analytics/route.ts` — weeklyTrend / topUsers / atRiskUsers / categories / eventTypes / radar — all real (was `Math.random()`).
- `src/app/api/timeline/route.ts` — 24-h sparkline + live counts + top-now (real focus minutes).
- `src/app/api/admin/analytics/rollup/route.ts` — **new** Super-Admin rollup trigger (`POST …?mode=rebuild`), serialized in-flight.
- `src/app/api/users/[id]/activity-matrix/route.ts` — browser downloads/uploads now from persisted FileActivity (removed `Math.random`).

**Other:**
- `src/instrumentation.ts` — starts the rollup worker (plus OCR worker).
- `scripts/verify-analytics.mjs` — live verification suite (**177 checks**).
- `scripts/smoke-analytics.mjs` — quick live smoke (42 checks).

## 2. Analytics architecture

```
Agent telemetry (E5/E6/E7) ──► ActivityEvent / Screenshot / LoginSession / DeviceHealthSnapshot
                                          │
                     ┌────────────────────┴───────────────────┐
                     │  Rollup engine (src/lib/analytics/rollup.ts) │
                     │  incremental · rebuild · checkpointed · idempotent │
                     ▼                                            ▼
              UserDailySummary (UNIQUE(userId, date))      AnalyticsJob / RollupCheckpoint
                     │
   ┌─────────────────┼──────────────────────┐
   ▼                 ▼                      ▼
 Dashboard KPIs   Productivity/heatmaps   Timeline (raw, bounded)
 (rollup reads)   (rollup + SQL agg)      (explicit drill-down)
```

- **Dashboards read the rollup table** (`UserDailySummary`) for day-scale numbers.
- **Raw `ActivityEvent` is read only** for explicitly-requested live views (top apps/websites rankings, hourly heatmap, timeline) — all bounded by `(userId, timestamp)` / `(category, timestamp)` indexes, never full-table scans.
- **Scoring** is deterministic and documented in `scoring.ts` (single source of truth shared by rollup + APIs).

## 3. Rollup engine

- **UTC-day based** — day = midnight UTC; never user-local midnight (avoids timezone double counting).
- **Incremental** — resumes from `RollupCheckpoint.lastDate`; **always rolls today** (worker feeds live dashboards even when the checkpoint is caught up).
- **Rebuild** — `mode='rebuild'` recomputes every day with telemetry (admin-triggered via `POST /api/admin/analytics/rollup?mode=rebuild`).
- **Idempotent** — `UNIQUE(userId,date)` upsert; re-running a day overwrites, never duplicates (verified: second trigger 0 errors, no drift).
- **Transaction-safe** — each (user, day) is one `$transaction` (read sources + upsert); a failed day never corrupts others; per-day errors recorded in `AnalyticsJob`, run never throws.
- **Checkpointed** — per-day atomic `lastDate` advance; a crash mid-run resumes from the last fully-rolled day.
- **Resumable** — verified by construction (checkpoint row persists, fromDay = nextUtcDay(checkpoint)).

## 4. Dashboard APIs

| Endpoint | Auth | What it returns (all real) |
|---|---|---|
| `GET /api/dashboard?range=` | JWT+scope | kpis · departments · trend(7) · topApps · deviceStatuses · recentEvents |
| `GET /api/dashboard/activity` | JWT+scope | active/idle minutes · sessions · category split · topApps · topWebsites · hourly heatmap(24) |
| `GET /api/dashboard/productivity` | JWT+scope | daily trend · averages · topPerformers · atRisk · departments |
| `GET /api/dashboard/devices` | JWT+scope | totals · online/offline/% · per-device health · uptime · healthAlerts |
| `GET /api/dashboard/timeline` | JWT+scope | merged activity+screenshot+session+health+ocr, cursor pagination |
| `GET /api/dashboard/heatmap` | JWT+scope | hourly(24) · weekday(7) · application · website |
| `GET /api/analytics` | JWT+scope | weeklyTrend · topUsers · atRiskUsers · categories · eventTypes · radar |
| `GET /api/timeline` | JWT+scope | 24-h sparkline · topNow · live counts |
| `POST /api/admin/analytics/rollup[?mode=rebuild]` | Super-Admin | `{jobId, mode, from, to, days, rows, errors}` |

## 5. SQL strategy

- Rollup totals/trends/heatmap-weekday: `UserDailySummary` reads (small, indexed).
- Top apps/websites + hourly heatmap: raw SQL `GROUP BY` over the scoped, indexed `(userId, timestamp)` range — **never a full-table scan**.
- Hourly heatmap: `SELECT CAST(strftime('%H', (timestamp/1000),'unixepoch') AS INTEGER) AS h, SUM(focusTime) … GROUP BY h` (SQLite string→number coercion handled).
- Timeline: bounded per-source `take: limit+1` over `(timestamp DESC, id DESC)` with `tsPred < cursor.t` keyset pagination — 4 parallel indexed queries merged + sorted.

## 6. Performance

- Dashboard/activity respond **< 2000 ms** with 300+ injected bulk events (measured in verify suite; typical dev-server p95 far lower — rollup reads are tiny).
- No N+1: every loop aggregates in-memory after a single indexed query; department/radar averages computed over fetched rollup rows.
- `UserDailySummary` is the hot path (per design 18 §5.18 + ADR-020) — the 50M-row `ActivityEvent` table is never scanned for dashboard KPIs.

## 7. Security

- **Organization-scoped / user-scoped / role-aware** (`src/lib/analytics/scope.ts`):
  - Admin → org-wide (`userIds: null`); explicit `userId` filter honored (drill-downs, empty-telemetry tolerance).
  - Manager → resolves own `organizationId`'s users only (verified: sees only org users, never foreign-org).
  - Employee → self only; no `userId` → 403; other user's `userId` → 403 (verified).
- **Timeline/screenshots/sessions/health all scope-filtered** (mergedTimeline filters activity+screenshot+session by `userId in scope`, health by scoped users' devices).
- **Global admin tables with no org relation** (`SecurityEvent`, `License`, `AIProvider`) are Super-Admin-only — Managers/Employees receive empty values (no cross-tenant leak). `deviceStatuses` user-scoped. *(Cross-tenant leak found in code review and fixed.)*
- Thrown 401/403 `Response` objects surfaced correctly (no 500 leaks) via the `analyticsRoute` wrapper.
- No auth → 401 on every analytics endpoint (verified).

## 8. Verification

**`scripts/verify-analytics.mjs` — 177/177 live (100%)**, covering: rollup (trigger, idempotent re-run, rebuild, checkpoint, exact-score contract 92/60/2, session/app/website counts, flagged screenshots, AnalyticsJob rows) · dashboard (kpis, departments, trend 7/1/90, bogus-range default) · activity (totals, categories, top apps/websites, 24-bucket heatmap nonzero) · productivity (trend, averages 0..100, top performers, at-risk sorted, departments) · devices (total=online+offline, percent, byStatus, health alerts) · timeline (kinds, sort, cursor pagination no-overlap, bad limit/cursor 400, limit>200 → 400) · heatmap (24/7 buckets, nonzero) · analytics (weeklyTrend, topUsers sorted, atRisk>40, categories, radar) · legacy timeline (24 sparkline, live) · DB metrics (screenshots, health snapshots, sessions, idle/active, keyboard/mouse, online) · auth & scoping (manager org isolation, employee self/403s, foreign-org isolation, 401s) · performance (<2000 ms w/ 300 bulk events) · empty-telemetry tolerance.

**Regressions (all green):**
- E1 Register 23/23 (node) · E2 Activate 53/53 · E3 Heartbeat 32/32 · E5 Activity 46/46
- E6 protocol 113/113 · E6 Consumption 192/192 (baseline 146 rows / 0 tickets stable)
- E7 Health 97/97 · OCR pipeline 96/96
- Build: `npm run build` green · tsc 0 new (baseline 4 pre-existing) · eslint clean · `prisma validate`/`migrate status` OK.

## 9. Risks

- **24h range approximation** — the 24h window can straddle two UTC days in the rollup table; acceptable for a live overview (heatmap still exact from raw SQL).
- **Timeline pagination** — cursor is (ts,id); ties across sources at identical ms are rare and bounded by per-source (ts,id) ordering + merge sort.
- **Rollup cost on rebuild** — O(users × days) upserts; guarded by the 3660-day bound and admin-triggered only.
- **SecurityEvent/License/AIProvider scope** — flat admin tables; intentionally Super-Admin-only (documented), so Manager dashboards show 0s/empty for those KPIs.
- **Worker cadence** — 15-min default; startup catch-up covers fresh boots; `ANALYTICS_ROLLUP_INTERVAL_MS`/`ANALYTICS_ROLLUP_ENABLED` env-tunable.

## 10. Rollback

1. `prisma migrate resolve --rolled-back 20260803111008_m008_stage1_analytics_rollup` then drop the three tables (`UserDailySummary`, `AnalyticsJob`, `RollupCheckpoint`) — additive-only, no existing column touched; legacy dashboards fall back to prior behavior.
2. Delete `src/lib/analytics/` (7 files), the rewritten routes (`src/app/api/dashboard/*`, `src/app/api/analytics/route.ts`, `src/app/api/timeline/route.ts`, `src/app/api/admin/analytics/`), revert `src/app/api/users/[id]/activity-matrix/route.ts` + `src/instrumentation.ts` additions, remove `scripts/verify-analytics.mjs` + `scripts/smoke-analytics.mjs`.
3. No storage bytes, agent endpoints, or OCR state are touched by the rollback.

## 11. Git commit message

```
M008 Stage-1: real analytics engine & dashboard consumption layer

- UserDailySummary/AnalyticsJob/RollupCheckpoint schema (migration
  20260803111008) + ActivityEvent indexes (userId,category,domain)
- Rollup engine: UTC-day, incremental (checkpoint-resumed) + rebuild,
  per-(user,day) transactional idempotent upsert, always-roll-today,
  crash-safe per-day checkpoint (src/lib/analytics/)
- Deterministic documented scoring (productivity/focus/activity/risk/
  burnout) — no AI, no random weights (scoring.ts)
- Dashboard APIs rebuilt on persisted telemetry: /api/dashboard +
  activity/productivity/devices/timeline/heatmap, /api/analytics,
  /api/timeline; removed every Math.random/placeholder metric
- Role-aware scoping: Admin org-wide · Manager org-scoped · Employee
  self-only; 401/403 surfaced; Super-Admin-only flat admin tables
- Super-Admin rollup trigger POST /api/admin/analytics/rollup
  (incremental + ?mode=rebuild), serialized in-flight
- verify-analytics.mjs 177/177; regressions E1-E7/E16/OCR/consumption
  all green (700+ checks); tsc 0 new, eslint clean, build OK
```

## 12. Ready for M008 Stage-2

All verification suites pass, every existing endpoint remains green, all dashboard
metrics come from real persisted telemetry, and no fabricated analytics remain
anywhere in the application. The rollup table, deterministic scoring, role scoping,
and the five dashboard sub-APIs are the foundation for Stage-2 (per-user drill-down
pages, team comparisons, retention/GC of rollups, Postgres aggregation notes).
