# PHASE 4 REPORT — Daily Aggregation / WorkDaySummary

Status: **GREEN**
Date: 2026-09-03
Repositories: `omnisight-web`, `omnisight-agent`
Authoritative scope: Phase 4 prompt (daily employee work summaries,
server-side aggregation, idempotency, rebuild, consumption API, retention,
tests). No Phase 5 work was started.

---

## 1. Executive Summary

Phase 4 adds a deterministic daily rollup (`WorkDaySummary`, one row per
organization + employee + org-local day) computed from the existing raw
Activity rows and BreakSession records. Raw telemetry remains authoritative
and untouched. Aggregation is idempotent by construction (whole-day recompute
+ upsert on a unique key — never incremental), concurrent-safe (JobRun lease +
unique constraint), org-timezone-correct (never server-local), working-hours-
aware (row-start convention identical to the anomaly detector), break-aware
(from canonical BreakSessions), retention-bounded (purged with the activity
window), and admin-readable/rebuildable through two new org-scoped APIs. Full
regression gates pass on both repositories (102 web suites / 1627 tests / 0
fail; agent 628/628; typecheck/lint/build green). No existing feature,
endpoint, security boundary or privacy control was weakened.

## 2. Baseline

Pre-change forensic state is captured in `docs/PHASE-4-BASELINE.md`. Key
facts: no summary table existed; the dashboard/reports compute per-day
category durations by summing Activity rows bucketed by the org-local day
(`localDayKey`); working hours are `work_start_time`/`work_end_time`
(OrganizationSetting, HH:MM in `Organization.timezone`, overnight supported by
`isWithinWorkWindow`); BreakSession is the canonical break record (break
mirror Activity rows carry duration 0 and title ∈ BREAK_TITLES); the org
timezone is the single source of truth for day boundaries; Phase 3
classification is stored on rows at ingestion time. Phase 3 baseline: web
100/100 suites · 1606/1606 · 0 fail; agent 628/628.

## 3. Architecture Before / After

Before: every dashboard/report query re-derived per-day durations by scanning
raw Activity rows (bounded to their windows, but repeated per consumer) and
no daily aggregate existed.

After: the aggregation job (hourly / `npm run jobs`, crash-safe lease) and the
admin rebuild route deterministically recompute one `WorkDaySummary` per
(org, employee, org-local day) for a bounded trailing window and upsert it on
the unique key. Admin GET reads the rollups org-scoped. Raw rows stay
authoritative; dashboard raw queries remain unchanged and are PROVEN equal to
the summaries over the same window (test WD-19).

## 4. Database Changes

Additive migration `20260903030000_workday_summary` (new table + 2 FKs +
unique key + 2 indexes; nothing else touched). Verified:

```text
scratch DB: prisma migrate deploy → clean (all 40 migrations applied)
prisma migrate diff (migrated scratch DB → schema) → "No difference detected."
```

Unique constraint `(organizationId, employeeId, workDate)` is the
idempotency boundary; indexes `(organizationId, workDate)` and
`(employeeId, workDate)` serve org-scoped trend reads and the retention
purge.

## 5. Aggregation Semantics (documented + tested)

- Org-local day bucketing (row attributed to `localDayKey(timestamp)` of
  Organization.timezone; never split across days) — matches the dashboard.
- productive/neutral/unproductive/idle seconds = SUM of row durations by the
  stored Phase 3 category; `activeSeconds = p+n+u` (invariant enforced);
  working/outside split of ACTIVE time by the org work window at the row
  start-minute (overnight windows supported); `breakSeconds` from BreakSession
  overlap; internal-agent rows and break-mirror rows excluded; invalid
  durations counted but never timed.
- No fabrication: empty days get no row ("no data" like the dashboard today);
  a break-only day gets a breakSeconds-only row; offline gaps are never
  filled.
- Rule changes never rewrite history: summaries are frozen at ingestion-time
  classification (test WD-14).

## 6. Job / Worker

- `runWorkDaySummaryJob` — self-claiming `workday_summary` lease; orgs iterate
  under per-org try/catch isolation; errors → `JobRun.lastResult` + failed
  lease; deterministic reruns.
- Window `[today − W + 1 .. today]`, `W` = activity retention clamped [7, 90]
  (90-day product window when retention = 0). No full-table scans: activity
  loads are one org × one org-local-day query each; upserts in 50-row
  bounded transactions.
- Wired into `run.ts` `runScheduledJobs()` alongside the existing jobs
  (same scheduler — no new scheduling system).

## 7. API Changes

| Route | Access | Behavior |
|---|---|---|
| `GET /api/workday-summaries` | manager+ | org-scoped rollups over `from`/`to` (default last 7 org-local days, max 90) with optional org-validated `employeeId`; 422 on bad/unbounded ranges; 404 on foreign employee; 401 unauth; 403 viewer |
| `POST /api/workday-summaries/rebuild` | manager+ | deterministic rebuild over `{startDate, endDate, employeeId?}` (≤ 90 days, endDate ≤ org-local today, validated 422s); content-identical to the scheduled job; never touches raw data |

Existing APIs unchanged; `POST /api/agent/activity` untouched (no ingestion
change in this phase).

## 8. Security Verification

- Org isolation proven: summary rows, reads and rebuilds all scoped by the
  authenticated org; same telemetry in two orgs lands in each org's own
  org-local day; zero cross-org rows (tests WD-11, WD-17).
- RBAC proven: manager+ 2xx; viewer 403; unauthenticated 401; foreign
  employee ids 404 (tests WD-17, WD-18).
- No client-controlled org context; no raw-data mutation path; rebuild
  bounded and manager-only.
- No new roles, no consent/working-hours/break changes, no rate-limit or
  session changes.

## 9. Privacy Verification

No new telemetry or content collection. Everything aggregated is pre-existing
domain-only website data, count-only telemetry, and BreakSession records.
Nothing new is uploaded or stored beyond the existing fields.

## 10. Performance Evidence

```text
WD-PERF-1 (engine, fast path): 100 orgs × 30 employees × 30 days
  → 3,600,000 rows aggregated in 9,934 ms ≈ 362,392 rows/s (includes row
  construction); totals exactly equal the deterministic generator
  (productive 14×60s, neutral 14×60s, unproductive 12×60s per employee-day).
WD-PERF-2 (DB job path): 48,000 seeded rows across 2 orgs × 20 employees ×
  30 days → 1,200 summaries (one per (org, employee, day)) in ~2.4 s of job
  time (≈20k rows/s through the full loader+engine+upsert path); spot-checked
  totals exact.
```

- Job queries are per-org × per-org-local-day (indexed), so a run is bounded
  by org activity within W ≤ 90 days — never an unbounded scan.
- Receipt-style growth is trivial: 100 employees ≈ 3k summary rows/org/month,
  purged with the activity window.

## 11. Tests Executed

New suites (all pass):

```text
node --import tsx --test tests/workday-summary.test.ts
  → ℹ tests 19   ℹ pass 19   ℹ fail 0
node --import tsx --test tests/workday-summary-performance.test.ts
  → ℹ tests 2    ℹ pass 2    ℹ fail 0
```

Coverage (WD-1..WD-19): category totals + active invariant + idle +
exclusions (break mirror, internal agent) + type counts; day attribution at
the org-timezone boundary (the same instant is a different local day for a UTC
org); window-edge + overnight working/outside splits; invalid durations;
break-overlap clipping (closed, crossing, open-clipped-to-now, outside);
DST fall-back day (25 h, both passes of the repeated hour counted — no
fabrication); end-to-end rebuild with exact expected fields; idempotent
re-runs; concurrent aggregation race-safety (one row, identical totals);
deterministic rebuild after data changes (never accumulates); tenant
isolation; employee isolation; no-fabrication (empty day vs break-only day);
rule-change invariance (history frozen); scheduled-job scoping/window/
determinism; retention purge on the activity window with org-local cutoff;
GET API RBAC/validation/404s; rebuild API RBAC/validation/future-day/90-day
bound; dashboard/report consistency (summary totals == dashboard-style raw
aggregation over the same org-local days).

Adjacent suites re-run and green: activity-dedupe 11/11, category-
classification 14/14, anomaly-hardening 56/56 (retention/jobs consumers).

## 12. Regression Gate (exact results)

### Web (omnisight-web)

```text
npm run typecheck → exit 0 (clean-next-types pre-step OK)
npm run lint      → exit 0 — ✖ 439 problems (0 errors, 439 warnings)
                    [pre-existing warning baseline unchanged; +0 new]
npm run build     → exit 0 (production build OK)
full suite (102 files, sequential, dev server healthy)
  → 102 suites · ℹ tests 1627 · ℹ pass 1627 · ℹ fail 0 · cancelled 0
```

Suite count grew 100 → 102 (two new suites); test count grew 1606 → 1627
(+21). All 100 pre-existing suites remain green. The two live-server suites
that previously depended on the bootstrapped super admin
(`rbac-forensic-regression`, `security-remediation`) passed (the dev DB was
re-seeded during Phase 3 and this run used the same healthy environment).

### Agent (omnisight-agent) — unchanged repo, gates still required

```text
npm run typecheck → exit 0
npm test          → ℹ tests 628   ℹ pass 628   ℹ fail 0   (exit 0)
npm run build     → exit 0
```

## 13. Files Changed (Phase 4)

New:

- `prisma/migrations/20260903030000_workday_summary/migration.sql`
- `src/lib/workday/summary.ts`
- `src/lib/jobs/workday-summary.ts`
- `src/app/api/workday-summaries/route.ts`
- `src/app/api/workday-summaries/rebuild/route.ts`
- `tests/workday-summary.test.ts`
- `tests/workday-summary-performance.test.ts`
- `docs/PHASE-4-BASELINE.md`, `docs/PHASE-4-IMPLEMENTATION.md`

Modified:

- `prisma/schema.prisma` (WorkDaySummary model + Organization/Employee
  relations)
- `src/lib/jobs/run.ts` (job wiring, `workday_summary` in the lease list,
  `EMPTY_RETENTION.workDaySummaries`, result field)
- `src/lib/jobs/retention.ts` (`workDaySummaries` counter + purge on the
  activity window with org-local cutoff)

No agent changes.

## 14. Migration Verification

```text
scratch DB: prisma migrate deploy → clean; diff vs schema → "No difference detected."
dev DB (workai_test_e2e): prisma migrate deploy → all migrations applied
prisma generate → OK (client exposes workDaySummary)
```

## 15. Rollback

1. Ingestion/API behavior is unchanged — disabling the job leaves every
   existing endpoint byte-identical.
2. Remove the `workday_summary` call from `run.ts` (and the rebuild route) to
   stop all writes; the table becomes inert.
3. Revert the additive code, then drop migration `20260903030000_workday_summary`
   once no deployment reads the table. Raw Activity/BreakSession data is never
   modified at any step; retention keeps working.

## 15b. Addendum — Dashboard consumer wiring (post-report follow-up)

**Scope decision.** The dashboard/report consumption request was scoped with
the user to the EXACT-FIT surfaces only. Investigation of all four candidate
consumers found exactly one byte-exact fit:

- `/api/dashboard` — **wired**. Its per-day p/n/u seconds over org-local days
  equal what WorkDaySummary stores (per-second precision, same exclusions).
- `/api/reports/daily` — NOT wired: it rounds per-employee minutes per ROW
  (`Math.round(dur/60)` accumulated per row) and its neutral bucket absorbs
  every un-categorized duration, so second-precision rollup values can never
  reproduce its displayed numbers. Zero-metric-change wiring is impossible
  without altering report semantics.
- `/api/analytics` — NOT wired: trend `total`/score denominators include idle
  AND un-categorized durations; workload distribution + department views are
  row-count based (not stored in summaries).
- `/api/organization/team-data`, `/api/departments/performance` — NOT wired:
  per-ROW metrics (row-count heatmaps, row-weighted averages) and all-time
  history beyond the rollup's ≤ 90-day window.

**Implementation.** `src/lib/workday/consume.ts` (`readOrgDayTotals`): one
bounded rollup read per org for covered past days + exact raw fallback
(SAME `aggregateEmployeeDay` engine, org-scoped in SQL via the
employee→organization relation) for the current org-local day and uncovered
past days; each day is read from exactly one source (never mixed).
`/api/dashboard` now derives `dailyProductivity`, `productivityScore`,
`avgProductivity` and `topEmployees` from that reader over the same 7
org-local day keys; the recent-activity feed and device/count queries are
unchanged raw reads. Response fields/units unchanged (`productiveTime`
seconds, buckets minutes). The old rolling 7×24 h productive-employee cutoff
is superseded by the same 7 org-local day window the trend/score use, so all
productivity KPIs agree by construction.

**Consumer-consistency tests** (`tests/dashboard-consumer.test.ts`, 3/3):

- DC-1 all-raw org → dashboard equals an independent raw recomputation
  (avg 3, score 80, exact per-day minutes, `productiveTime` 10800 s).
- DC-2 same org with past days materialized as summaries (today raw) →
  byte-identical dashboard values; reader reports summary for every
data-bearing past day and raw for today.
- DC-3 tenant isolation — org A (summaries) vs org B (own rows incl. an
  extra 999999 s unproductive block) differ correctly; empty org C returns a
  zero dashboard with exactly 7 empty buckets.

**Regression gate after wiring** (103 files now, incl. the new suite):

```text
npx tsc --noEmit            → exit 0
npm run build               → exit 0 (production build OK)
npx eslint .                → 0 errors, 439 warnings (unchanged baseline)
full suite (103 files, sequential, dev server healthy)
  → 103 suites · ℹ tests 1630 · ℹ pass 1630 · ℹ fail 0
pinned dashboard suites: dashboard-api 11/11, dashboard-productivity 7/7,
  admin-prod-dashboard 6/6 — all green before and after the wiring
Agent (unchanged repo): typecheck exit 0 · tests 628/628 · build exit 0
```

**Files (addendum):** new `src/lib/workday/consume.ts`,
`tests/dashboard-consumer.test.ts`; modified `src/app/api/dashboard/route.ts`
(summary-first read + raw fallback; feed/counts untouched). No schema or
migration change. Rollback: restore the previous consolidated raw derivation
in the dashboard route; the reader module is additive and unused.

## 16. Remaining Risks / Warnings

- Summaries for the CURRENT org-local day are partial until the day ends and
  are recomputed each run (whole-day upsert — never accumulated, so no
  double-count; `generatedAt`/`updatedAt` expose freshness). Consumers of a
  live "today" figure should still read raw rows (dashboard does) or accept
  hourly freshness.
- Window alignment between summary retention (org-local day key) and raw
  retention (UTC instant) is exact only at day granularity; the documented
  org-local cutoff rule never deletes the summary of a day that still has
  surviving raw rows.
- Fast-path engine arithmetic is only used for plain 24 h days; DST-transition
  days fall back to the (slower, exact) Intl clock — correctness preserved,
  only those rare days cost more CPU.
- Lint keeps the pre-existing 439 warnings (0 errors); the new Phase 4 files
  add 0 errors and 0 warnings.

## 17. Final Verdict

**GREEN**

All acceptance criteria met: daily employee work summaries over
server-side data; working-hours-aware productive/neutral/unproductive/
active/idle/break totals with org-timezone day boundaries and no fabricated
activity; idempotent (duplicate + concurrent aggregation proven safe) with a
database uniqueness boundary; historical rebuild capability (bounded,
manager-only, deterministic); rule changes never corrupt history; summary
totals proven equal to dashboard-style raw aggregation; tenant isolation and
RBAC verified end-to-end; bounded indexed queries with measured engine
throughput ≈362k rows/s; retention purges summaries with the activity window;
Web typecheck PASS, lint 0 errors, production build PASS, full suite
102/102 suites · 1627/1627 tests · 0 failures; Agent typecheck PASS,
628/628 tests, build PASS.
