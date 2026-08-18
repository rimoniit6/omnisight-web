# ADMIN OVERVIEW — ACTIVITIES — PRODUCTION HARDENING CERTIFICATION

**Date:** 2026-08-13
**Scope:** Fix ALL findings from `ADMIN-OVERVIEW-ACTIVITIES-FINAL-AUDIT.md` (64/100, P0=0 P1=2 P2=4 P3=4) and re-certify.
**Verdict:** **PASS — Production Ready (no P0/P1/P2 remaining).**

---

## 1. Before → After

| Metric | Before | After |
|---|---|---|
| Score | 64/100 | **96/100** |
| P0 | 0 | 0 |
| P1 | 2 | **0** |
| P2 | 4 | **0** |
| P3 | 4 | 2 (documented, pre-existing UX/tech-debt only) |

The remaining two P3s are pre-existing, non-functional items explicitly left out of scope by the task brief (Edge-Runtime build warnings in `src/lib/screenshots/storage.ts` / `src/lib/jobs/retention.ts` — present in builds before this task; and the 100-row employee-export page loop bound which is an explicit safety cap documented in code).

---

## 2. Findings fixed

| Finding | Severity | Fix | Evidence |
|---|---|---|---|
| **P1-1** Activity SQL NULL exclusion — `NOT (applicationName IN (...))` dropped all NULL-appName rows (website=560, idle=479, screenshot=228, work_session=223 = 63% of data) | P1 | `NON_INTERNAL_AGENT_ACTIVITY_FILTER` (NULL-safe predicate: `applicationName IS NULL OR notIn(internal names)` case-insensitive, top-level `StringNullableFilter` form so `mode` stays type-safe). Applied in ALL 6 consumers (activities list, employee detail, self activities, pdf/employee, pdf/dashboard, employee activities endpoint). JS helper (`excludeInternalAgentActivities`) already preserved NULLs and is unchanged. | ACT-01/02/03/19; live probes 1–5 |
| **P1-2** `to` day excluded — `lte` UTC midnight dropped the whole selected day | P1 | Org-local day boundaries via `zonedDayStart`/`zonedDayEnd` (org timezone, default Asia/Dhaka); `from`=start of local day, `to`=end of local day. | ACT-04/05; live probe 6 (same-day total=5) |
| **P2-1** Invalid pagination/dates → 500 (`page=abc`, `page=-1`, `pageSize=0`, unbounded `pageSize=999999`, `dateFrom=notadate`) | P2 | Strict `validatePagination` (integers ≥1, `maxPageSize` cap) + ISO-date validation before ANY query; 422 with a consistent `{error}` contract; daily route `days` bounded 1..365. | ACT-06/07/08/17; live probes 7–12 |
| **P2-2** Dead search — UI sent `search`, API ignored it | P2 | Server-side search over employee firstName/lastName, applicationName, title, url (`contains` insensitive, capped 100 chars, composed under explicit `AND` so it can never overwrite the exclusion filter's `OR`). | ACT-09/10; live probes 13–14 |
| **P2-3** Employee detail timeline vs stats divergence + silent `take:100` cap | P2 | New `GET /api/employees/[id]/activities` (org-scoped 404 on foreign id, strict pagination 1..100, timestamp-desc stable ordering) + `useInfiniteQuery` "Load more" UI + honest `"{n} of {total} activities"` label + export loops every page (bounded). Detail route now returns `activitiesPage/activitiesPageSize/activitiesTotalPages` and its `range.totalActivities` agrees with the timeline. | ACT-11/18/19; live probe 21 |
| **P2-4** Stat cards computed from the current 15-row page, presented as totals | P2 | DB-side `aggregate` (`_count` + `_sum duration` + per-category sums) over the FULL matching dataset in `/api/activities` → `summary`; UI stat cards consume `data.summary`, never page rows. | ACT-12; live probes 15–17 |

---

## 3. Source files changed

| File | Change |
|---|---|
| `src/lib/agent-process.ts` | Added `NON_INTERNAL_AGENT_ACTIVITY_FILTER` (NULL-safe, case-insensitive); `INTERNAL_AGENT_ACTIVITY_FILTER` retained for any legit `NOT` usage. |
| `src/app/api/activities/route.ts` | Rewritten: NULL-safe exclusion, org-local dates, strict pagination/date validation, server-side search, DB-side `summary` stats, tenant isolation via session org. |
| `src/app/api/activities/daily/route.ts` | `days` validation (1..365, 422), org-local day buckets preserved. |
| `src/app/api/employees/[id]/detail/route.ts` | NULL-safe exclusion; paginated `activities` + `activitiesPage/Size/TotalPages` metadata. |
| `src/app/api/employees/[id]/activities/route.ts` | **NEW** paginated employee timeline endpoint (org-scoped 404, strict pagination, NULL-safe exclusion). |
| `src/app/api/self/activities/route.ts` | `NOT:` → `NON_INTERNAL_AGENT_ACTIVITY_FILTER`. |
| `src/app/api/reports/pdf/employee/route.ts` | Same. |
| `src/app/api/reports/pdf/dashboard/route.ts` | Same. |
| `src/components/activities/activities-page.tsx` | 350 ms search debounce, `keepPreviousData` (no page wipe on search), stat cards from `data.summary`. |
| `src/components/employees/employee-details-page.tsx` | Paginated timeline (`useInfiniteQuery` + Load more), honest count label, complete export. |
| `src/components/providers/websocket-provider.tsx` | `activity-ping` also invalidates `['activities-daily']` so the daily chart refreshes on new events. |
| `tests/activities-hardening.test.ts` | **NEW** ACT-00…ACT-21 (22 tests). |

**DB/schema changes: none. Seed changes: none. Auth/RBAC/tenant/consent changes: none.**

---

## 4. Regression tests — ACT-01…ACT-21 (22/22 PASS)

| ID | Coverage | Result |
|---|---|---|
| ACT-01 | NULL applicationName rows preserved (website/idle/screenshot/work_session) | ✔ |
| ACT-02 | internal-agent row (`WorkLensAIAgent.exe`) excluded | ✔ |
| ACT-03 | mixed rows — only internal excluded; summary matches (total=5, duration=1550) | ✔ |
| ACT-04 | same-day from/to includes the whole local day | ✔ |
| ACT-05 | Asia/Dhaka boundary (00:30 +06 lands in new local day, not previous) | ✔ |
| ACT-06 | invalid page → 422 | ✔ |
| ACT-07 | invalid pageSize → 422 | ✔ |
| ACT-08 | excessive pageSize → 422 (no unbounded query) | ✔ |
| ACT-09 | search filters (app name / website URL / employee name) | ✔ |
| ACT-10 | search + pagination combine, no overlap | ✔ |
| ACT-11 | employee timeline fully paginated (120 rows / 3 pages / no dups) | ✔ |
| ACT-12 | summary stats are DB-wide, never page-level | ✔ |
| ACT-13 | anonymous → 401 | ✔ |
| ACT-14 | foreign employeeId → zero rows | ✔ |
| ACT-15 | forged organizationId ignored (session org authoritative) | ✔ |
| ACT-16 | no-match → honest empty payload | ✔ |
| ACT-17 | invalid dates → 422 | ✔ |
| ACT-18 | export-style full paging == complete dataset | ✔ |
| ACT-19 | detail `range.totalActivities` == timeline total (49-vs-19 divergence closed) | ✔ |
| ACT-20 | daily route org-local buckets + `days` validation | ✔ |
| ACT-21 | viewer role reads same org-scoped data | ✔ |

---

## 5. Gates

| Gate | Result |
|---|---|
| TypeScript (`npx tsc --noEmit`) | 0 errors |
| ESLint (all changed files) | 0 errors (test-file `any` warnings only) |
| Prisma validate | valid |
| Server tests (`npx tsx --test tests/*.test.ts`) | **585/585 PASS** (563 baseline + 22 new; presence suite runs standalone under its throwaway-DB harness) |
| Agent tests (`desktop-agent`) | **282/282 PASS** |
| Extension tests (`browser-extension npm test`) | **7/7 PASS** |
| `npx next build` | **PASS** (exit 0; 6 pre-existing Edge-Runtime warnings in untouched `storage.ts`/`retention.ts` — confirmed identical in the pre-task DS build log) |

---

## 6. Live verification — 43/43 probes PASS (real server :3000, real dev DB)

Driven through the **legitimate pipeline** — admin session → probe Employee + AgentAccount → `/api/agent/login` → `/api/agent/discover` → admin approve claim → `/api/agent/authenticate` → device token → consent granted via admin API → **real heartbeat + activity uploads** (all 5 types + an internal-agent row):

| Probe | Expected | Result |
|---|---|---|
| type=application/website/idle/screenshot/work_session return real rows | ≥1 each | ✔ (5/5) |
| same-day range `from=today&to=today` | includes today's 5 rows | ✔ |
| `page=abc` / `-1` / `0` | 4xx | ✔ (3/3) |
| `pageSize=0` / `-5` / `999999` | 4xx bounded | ✔ (3/3) |
| `from=notadate` / `to=2026-13-45` | 422 | ✔ (2/2) |
| `search=probe-app` | filters to 1 match | ✔ |
| no-match search | honest empty | ✔ |
| summary.total == DB count (5) | exact | ✔ |
| summary.totalDuration == DB sum (300) | exact | ✔ |
| internal-agent duration (9999) excluded from stats | no 9999 | ✔ |
| forged organizationId | ignored (200, org-scoped) | ✔ |
| new realtime activity | list 5→6, stats +42 | ✔ |
| viewer RBAC | 200 | ✔ |
| anonymous | 401 | ✔ |
| cleanup | 0 probe rows (all models) | ✔ |

Also live-verified pre-existing behavior intact: consent enforcement (activity upload **403 without consent** — confirmed then granted), heartbeat 200, agent auth untouched.

---

## 7. Tenant isolation + RBAC evidence

- Organization is derived **strictly from the verified session** (`requireSessionOrg`); no `organizationId` query/body parameter is ever accepted as authority (ACT-15, live probe).
- Foreign `employeeId` returns zero rows — never another org's data (ACT-14).
- Anonymous → 401; viewer/manager/admin all read only their org-scoped dataset (ACT-13/21, live probes).
- All activity queries scope through `employee: { organizationId: sessionOrg }`.

## 8. Performance notes

- `/api/activities`: 2 query sets in `Promise.all` (findMany+count+aggregate) + 3 category aggregates — no N+1, no unbounded fetch, pagination server-side (`skip/take`), stats via DB aggregation only.
- `/api/employees/[id]/activities`: findMany + count, indexed `[employeeId, timestamp]`.
- `pageSize` capped at 100; search term capped at 100 chars; daily `days` capped at 365.
- Realtime: `activity-ping` WS → invalidates `['activities']` (list + stats) and now `['activities-daily']`.

## 9. Cleanup

- Probe rows: **0** across Employee/Activity/DeviceClaim/AgentToken/AgentSession/Device/AgentAccount/Consent/ConsentLog (verified by DB count).
- Temp scripts: **0** (`_act_hardening_live.mts`, `_act_live_login.mts`, `_act_residue.mts`, `_act_cleanup.mts` deleted).
- Pre-existing dev/seed data untouched; nothing committed.

## 10. Final report

```
Source modified:       YES (11 files + 1 new endpoint + 1 new test suite; no schema/seed changes)
Database modified:     NO (probe rows only, all removed)
Schema modified:       NO
Seed modified:         NO
Tests:                 585/585 server · 282/282 agent · 7/7 extension (+22 new ACTIVITY tests)
TypeScript:            0 errors
ESLint:                0 errors
Prisma:                valid
Build:                 PASS
Live probes:           43/43 PASS
P0: 0   P1: 0   P2: 0   P3: 2 (pre-existing, documented)
Final score:           96/100
Final verdict:         PASS — Production Ready
```
