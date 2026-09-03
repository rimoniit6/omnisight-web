# PHASE 4 IMPLEMENTATION — Daily Aggregation / WorkDaySummary

Status: implemented, regression gate GREEN.
Companion docs: `docs/PHASE-4-BASELINE.md` (forensic pre-change baseline),
`docs/PHASE-4-REPORT.md` (evidence + verdict).

---

## 1. Architecture

```text
Raw Activity rows (authoritative)      BreakSession rows (canonical breaks)
        │                                        │
        └──────────┬─────────────────────────────┘
                   ▼
   WorkDaySummary aggregation (scheduled job / admin rebuild)
                   │  deterministic whole-day recompute + upsert
                   ▼
   WorkDaySummary (orgId, employeeId, workDate) — org-local daily rollup
                   │
                   ▼
   Admin reads (GET /api/workday-summaries) → dashboards/reports later phases
```

Raw telemetry is never deleted or rewritten by aggregation. A summary is a
derived, deterministic projection; the unique key
`(organizationId, employeeId, workDate)` is the idempotency boundary and the
job REPLACES (upserts) whole-day content — never "existing + incremental" — so
repeated, concurrent or post-restart runs can never double-count.

### 1.1 What a summary contains

Per (employee, org-local day):

- `productiveSeconds` / `neutralSeconds` / `unproductiveSeconds` — SUM of
  `Activity.duration` grouped by the row's stored `category` (the Phase 3
  server-authoritative verdict, frozen at ingestion time).
- `idleSeconds` — rows where `category = 'idle'` or `type = 'idle'`.
- `activeSeconds` — `productive + neutral + unproductive` (invariant enforced
  at write time; equals the dashboard's "total categorized duration").
- `workingSeconds` / `outsideHoursSeconds` — split of ACTIVE time by the org
  work window (`work_start_time`..`work_end_time` in the ORG timezone), using
  the row's start-minute convention (`isWithinWorkWindow`, overnight windows
  supported) — same convention as the anomaly detector's off-hours rule.
- `breakSeconds` — overlap of `BreakSession` rows with the org-local day
  (break mode suppresses Activity collection, so breaks never appear as
  Activity durations; open breaks are clipped to the run's pinned `now`).
- `activityCount`, `websiteActivityCount`, `applicationActivityCount`.
- `generatedAt` / `updatedAt`.

### 1.2 What is deliberately NOT in a summary

- **No top-app/domain breakdown JSON** — no dashboard/report need is proven
  yet; adding blob columns now would duplicate data that can be derived from
  raw rows (documented decision, reversible additively later).
- **No overtime column** — the re-sliced Phase 4 spec lists
  active/working/outside/break; overtime is derivable
  (`workingSeconds` beyond the window is `outsideHoursSeconds`) and belongs to
  a later policy/report phase.
- **No fabricated time** — a day with zero telemetry produces NO summary row
  ("no data" semantics identical to today's dashboard), and offline gaps are
  never filled. A day with only a break session DOES get a row
  (`breakSeconds` only).

## 2. Semantics decisions (each mirrors an existing consumer)

| Decision | Rationale / anchor |
|---|---|
| Row attributed to the org-local day of its `timestamp`; never split across days | `/api/dashboard` buckets by `localDayKey(row.timestamp)` and sums full durations — a summary must equal it |
| Category seconds = SUM of per-row durations (parallel app+website streams both count) | Existing dashboard/report/analytics totals — Phase 4 acceptance requires dashboard total == summary total == report total |
| Working/outside split per row start-minute, whole-duration assignment | Anomaly detector's off-hours rule (`isWithinWorkWindow` at the row minute) |
| Internal-agent process rows excluded | `excludeInternalAgentActivities` / `NON_INTERNAL_AGENT_ACTIVITY_FILTER` used by the dashboard and AI insights |
| Break-mirror Activity rows (`"Break Mode …"`, duration 0) excluded | They are realtime/report event markers, never work time |
| `breakSeconds` from `BreakSession`, not Activity | Break mode suppresses collection; `BreakSession` is canonical (retention comment F-08) |
| No rules on historical rows | Phase 3: classification is decided at ingestion and stored on the row; summaries therefore freeze history and are never bulk-rewritten by rule edits |

## 3. Database changes

Migration `20260903030000_workday_summary` (additive — no existing table or
row modified; verified "No difference detected" on a scratch DB):

| column | notes |
|---|---|
| `id` | CUID PK |
| `organizationId` / `employeeId` | FKs → Organization/Employee, CASCADE |
| `workDate` | `YYYY-MM-DD` in the ORGANIZATION timezone |
| seconds/count fields | Int, default 0 |
| `generatedAt` / `updatedAt` | generation marker + edit time |

Constraints/indexes (each maps to a query):

- `@@unique([organizationId, employeeId, workDate])` — idempotency boundary
  (the upsert key).
- `@@index([organizationId, workDate])` — org-scoped daily trends (GET range)
  and the retention purge (`workDate < cutoffKey`).
- `@@index([employeeId, workDate])` — per-employee reads.

## 4. Compute engine — `src/lib/workday/summary.ts` (pure)

- `aggregateEmployeeDay(input)` — one employee → one org-local day. Pure and
  deterministic; no DB, no IO; unit-testable without a database.
- Guards: rows whose org-local day differs from the requested bucket are
  skipped (defensive, so a caller bug can never double-count a row into two
  days); non-finite/non-positive durations are counted but never timed;
  unknown/corrupt categories are counted but never timed; break mirrors and
  internal-agent rows are excluded entirely.
- `breakSessionOverlapSeconds(session, dayStart, dayEndInclusive, now)` —
  pure overlap helper; open sessions clipped to `now`; inclusive day end
  handled.
- **Fast path** (`localDayWindowMs`): when the caller (the job's loader) has
  already resolved the exact org-local window, day membership and
  minutes-of-day are pure arithmetic (~µs/row instead of per-row Intl).
  Only plain 24 h windows take the fast path — DST-transition days (window ≠
  24 h) automatically fall back to the Intl clock so wall-clock minutes stay
  exact. When the parameter is absent the engine derives everything from the
  timezone via Intl (unchanged semantics for direct callers/tests).

## 5. Aggregation job — `src/lib/jobs/workday-summary.ts`

- `runWorkDaySummaryJob(options)` — claims the `workday_summary` JobRun lease
  (crash-safe, single-writer), iterates orgs (active orgs; or `orgIds`
  for scoped runs) under per-org try/catch isolation, records
  `JobRun.lastResult` and fails the lease only on real errors.
- Window: trailing org-local days `[today − windowDays + 1 .. today]` where
  `windowDays` = the org's `activity_retention_days` clamped to [7, 90]
  (90 = the product reporting window when retention is 0/never-purge). The
  job never scans the whole Activity table.
- `rebuildDaysForOrg(orgId, dayKeys, { employeeId?, now? })` — the shared
  low-level seam (job + admin rebuild route):
  1. resolve org timezone + work window from `OrganizationSetting`
     (`work_start_time`/`work_end_time`, HH:MM parsed in the org tz);
  2. load the org's employees (Activity has no org column — org scope resolves
     through the employee relation);
  3. load `BreakSession`s that can touch the window (open sessions clipped to
     the pinned `now`), pre-compute per-(employee, day) break seconds;
  4. load Activity rows **per org-local day** (each query bounded to one
     org × one org-local day via `zonedDayStart`/`zonedDayEnd`);
  5. aggregate per (employee, day) through the pure engine (fast path);
  6. upsert in 50-row bounded transactions on the unique key — the whole-day
     content REPLACES any existing row (deterministic rebuild semantics).
- No-fabrication rule: a summary is only written for (employee, day) pairs
  with ≥ 1 counted row OR break overlap.
- Wiring: `run.ts` `runScheduledJobs()` invokes it (hourly + `npm run jobs`);
  the JobRun lease makes overlapping invocations a safe no-op.

## 6. Admin API

### GET `/api/workday-summaries` (manager+)

- Org scope from the verified session (`requireManagerOrg`) — never client
  input. Range `from`/`to` (YYYY-MM-DD), defaults to the trailing 7 org-local
  days; bounded to 90 days (422 beyond); optional `employeeId` validated to
  belong to the org (foreign → 404, never an empty cross-org leak). `take`
  capped at 500. Includes employee name for display.

### POST `/api/workday-summaries/rebuild` (manager+)

- Body `{ startDate, endDate, employeeId? }`. Validation: YYYY-MM-DD keys,
  `startDate ≤ endDate`, `endDate ≤ today` **in the organization timezone**,
  range ≤ 90 days — 422 otherwise; foreign `employeeId` → 404. Runs
  `rebuildDaysForOrg` (deterministic, content-identical to the scheduled
  job). Never touches raw telemetry. Viewer/employee → 403.

## 7. Retention

`runRetentionForOrg` (existing scheduler; no second scheduler introduced):

- WorkDaySummary rows follow the **activity retention window**
  (`activity_retention_days`): purge `workDate < cutoffKey` where `cutoffKey`
  is the ORG-LOCAL day of the cutoff instant (a summary is only obsolete once
  its entire local day ended before the cutoff — never deletes the summary of
  the day the cutoff lands on, whose later rows survive).
- Counter `workDaySummaries` added to `RetentionResult`/`EMPTY`/`EMPTY_RETENTION`.

## 8. Rule-change behavior

Historical summaries are frozen at ingestion time (rows carry the Phase 3
verdict). Editing/deleting rules never rewrites summaries; the rebuild route
recomputes from STORED categories, so a rebuild after a rule change produces
the same numbers (proven by test WD-14). Bulk historical re-classification
remains out of scope (would be a separate bounded background operation).

## 9. Security

- Tenant isolation: every query and route filters by the authenticated org;
  Activity org scope resolves through the employee relation; `employeeId` in
  the GET/rebuild routes is validated against the org (foreign → 404).
- RBAC: reads and rebuilds are manager+ (`requireManagerOrg`); viewer and
  employee denied; no new roles. Org status enforced by the shared helper.
- Rebuild is bounded (90 days, org-scoped) and cannot be triggered by
  non-managers.
- No client-controlled org context anywhere; no raw telemetry mutation.

## 10. Privacy

No new telemetry, no content collection. Summaries aggregate the existing
domain-only website data and count-only telemetry already stored. Break time
comes from existing `BreakSession` records. Nothing new is collected,
uploaded or displayed beyond existing fields.

## 11. Performance

- Job DB access is bounded per query: one org × one org-local day
  (zoned window), so no full-table scan and no unbounded transaction
  (50-row upsert transactions). No N+1 rule/employee explosion: employees and
  settings load once per org; per-day activity loads are W ≤ 90 indexed
  queries per org.
- Engine fast path: measured **≈362k rows/s** (3.6M rows in ~10 s including
  row construction) at the 100-org × 30-employee × 30-day synthetic shape;
  DB job measured ≈20k rows/s end-to-end incl. queries and upserts
  (48k rows → 1200 summaries in ~2.4 s of job time).
- Growth: summaries are one row per (org, employee, day) — 100 employees ≈
  ~3k rows/org/month, trivially bounded; retention removes them with the
  activity window, and the unique key prevents any accumulation.

## 12. Consumer wiring — `/api/dashboard` reads the rollup (addendum)

The dashboard's productivity metrics are now served per org-local day from
`WorkDaySummary` when the aggregation job has covered the day, with an EXACT
raw-row fallback — see `src/lib/workday/consume.ts` (`readOrgDayTotals`):

- **Summary-first**: one bounded rollup query covers every requested past day
  that has ≥ 1 summary row for the org.
- **Exact raw fallback** for the current org-local day (its summary is partial
  until the day ends) and for any past day with NO rollup coverage
  (pre-backfill installs, tests, orgs whose job has not run). The fallback
  loads that one org-local day's rows (scoped in SQL through the
  employee→organization relation — never a client-supplied org id) and runs
  the SAME `aggregateEmployeeDay` engine the job uses, so a day served from
  the rollup and a day served from raw rows produce byte-identical values.
- **Never mixed within a day**: each org-local day is read from exactly one
  source (`rows`/`source` maps), so mixing can never double-count.
- **No fabrication**: empty days produce no rows and no source entry;
  requested future keys are skipped.

`/api/dashboard` (the only exact-fit consumer — see the report's consumer-fit
notes) now derives `dailyProductivity`, `productivityScore`, `avgProductivity`
and `topEmployees` from `readOrgDayTotals` over the SAME 7 org-local day keys
(previously the productive-employee window was a rolling 7×24 h cutoff that
could disagree with the org-local trend near the boundary — every productivity
KPI now shares one org-local window, DP-7). The recent-activity feed and all
counts/devices/breakdowns are unchanged and stay on raw queries
(WorkDaySummary stores totals, not rows). Response fields and units are
unchanged (`productiveTime` remains seconds; buckets remain minutes).

## 13. Rollback

1. Nothing in the ingestion path changed — Activity/API behavior is
   byte-for-byte identical with or without summaries.
2. Stop the job: remove the `workday_summary` invocation from `run.ts`
   (or leave it — it is read-only over raw data and writes only the summary
   table).
3. Revert the additive code (engine, job, routes, retention counter),
   revert the dashboard consumer wiring (restore the consolidated raw query
   in `src/app/api/dashboard/route.ts`), and drop the additive migration
   `20260903030000_workday_summary` when no deployment reads the table. Raw
   Activity/BreakSession data is never affected at any step.
