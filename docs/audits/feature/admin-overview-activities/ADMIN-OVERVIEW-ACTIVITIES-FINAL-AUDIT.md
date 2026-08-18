# ADMIN OVERVIEW — ACTIVITIES — FINAL PRODUCTION AUDIT

**Date:** 2026-08-13 · **Mode:** AUDIT ONLY (no source/DB/schema/seed changes)

---

## 1. Executive Summary

The Overview → Activities feature is **partially functional**. The tenant isolation, RBAC, pagination (for application rows), realtime invalidation, and the dashboard-side aggregation are production-grade and verified. However, **two P1 data-integrity bugs hide ~63% of all activity data**:

1. The internal-agent exclusion filter (`NOT: INTERNAL_AGENT_ACTIVITY_FILTER`) is translated by Prisma into `NOT (applicationName IN (...))`, which under SQL three-valued logic **also excludes every row whose `applicationName` is NULL** — and NULL applicationName covers **all** website, idle, screenshot, and work_session rows (1,490 of 2,371 = 63%).
2. The date-range `to`/`dateTo` boundary is **midnight UTC of the selected day**, so the selected "to" day (including "today" in the default 7-day range) is entirely excluded — live probe: `from=2026-08-13&to=2026-08-13` → **0** rows while the DB has **281** activities today.

**Score: 64/100 — NOT PRODUCTION READY** (P1s present). `P0=0 · P1=2 · P2=4 · P3=4`.

| Verdict | NOT PRODUCTION READY |
|---|---|
| Source modified | NO |
| Database modified | NO |
| Schema modified | NO |
| Seed modified | NO |
| Probe rows remaining | 0 |
| Temporary scripts remaining | 0 |

---

## 2. Architecture / Data Flow

```text
Overview → Dashboard (activity-feed widget)     → GET /api/dashboard        → recentActivities (top 10, org-scoped, JS-excluded)     ✅ healthy
Activities page                                  → GET /api/activities       → list feed + totals        ❌ P1-1 NULL-drop + P1-2 date boundary
Activities page (Daily Productivity chart)       → GET /api/activities/daily → UTC-bucketed daily chart  ⚠️ P3-1 UTC buckets + unvalidated days
Employee details → Timeline + stats              → GET /api/employees/[id]/detail → activities (take:100) + aggregates ❌ P1-1 undercounts stats
Realtime                                        → WS 'activity-ping' → invalidates ['activities']        ✅ near-real-time refetch
```

---

## 3. Findings

### P1-1 — Internal-agent exclusion drops ALL NULL-applicationName activities (63% of data)
- **File:** `src/app/api/activities/route.ts` (where clause), `src/app/api/employees/[id]/detail/route.ts` (all aggregates), plus every consumer of `INTERNAL_AGENT_ACTIVITY_FILTER` under SQL.
- **Root cause:** `NOT: { applicationName: { in: ['worklensaiagent.exe'], mode: 'insensitive' } }` → SQL `NOT (applicationName IN (...))` → for `applicationName IS NULL`, `NULL IN (...)` is NULL → `NOT NULL` is NULL → **row filtered out**. The JS helper `excludeInternalAgentActivities` keeps NULL rows (verified `AP-2`: `['chrome.exe', null, 'Code.exe']`), so SQL and JS disagree.
- **Evidence (live + DB):** org-wide `total=2,371`; `applicationName IS NULL → 1,490 (63%)`; by type, NULL rows = website 560, idle 479, screenshot 228, work_session 223 (all). API type-filter totals: `application → 881` (== all application rows), **`website → 0`, `idle → 0`, `screenshot → 0`, `work_session → 0`**.
- **Impact:** the Activities feed shows application rows only; the type filter is dead for 4 of 5 types; employee-detail stats (`range.totalActivities` etc.) undercount; productivity scores computed on a 37% subset. `tests/agent-process-exclusion.test.ts` only creates non-NULL application rows, so the NULL-drop is untested (coverage gap).
- **Fix (next phase):** use `OR: [{ applicationName: null }, { applicationName: { not: { in: [...] } } }]` or perform exclusion in JS on all rows (as the daily route already does); add regression tests with NULL-applicationName rows.

### P1-2 — `to`/`dateTo` excludes the entire selected "to" day (current day missing by default)
- **File:** `src/app/api/activities/route.ts` — `if (dateTo) ts.lte = new Date(dateTo)` → `2026-08-13` = `2026-08-13T00:00:00Z` → `lte` midnight excludes the whole UTC day.
- **Evidence:** `from=2026-08-13&to=2026-08-13` → API `total: 0`; DB today (local & UTC day) = **281**. Default page range (`from=6 days ago`, `to=new Date()` → yyyy-MM-dd) therefore always drops the current day. Contrast: the employee-detail route correctly ends the day with `setHours(23,59,59,999)`.
- **Fix:** build the end boundary as the end of the org-local day (reuse the project's `localDayKey`/timezone helpers already used by the dashboard), with explicit inclusive-exclusive documentation.

### P2-1 — Invalid query params return 500 (no validation)
- `page=abc` → 500; `page=-1` → 500; `dateFrom=notadate` → 500; `dateFrom=2026-13-99` → 500; daily `days=abc` → 500. All should be 400/422 (the project already has `validatePagination` in `src/lib/api.ts` and the pattern used by projects/time-entries).
- **Evidence:** live probes above (status 500, `{"error":"Failed to fetch activities"}`).

### P2-2 — Pagination under-validated / unbounded
- `pageSize=0` → 200 with `pageSize:0, totalPages:null` and empty data (broken shape); `pageSize=999999` → 200 full-table query (no cap); `page=1.5` accepted (fractional skip). No `maxPageSize` cap unlike sibling endpoints.
- **Evidence:** live probes.

### P2-3 — Employee search control is dead UI
- `ActivitiesPage` sends `search` (`p.set('search', searchQuery)`, line 172) but `/api/activities` never reads `search` → typing does nothing. Confirmed live: identical results with/without `search=zzzz-no-such-app`.

### P2-4 — Employee-detail timeline vs summary divergence + 100-row cap
- Timeline shows `activities` (take:100, JS-excluded → includes NULL-appName rows) while `range.totalActivities`/duration/productivity (SQL `NOT` → drops NULL rows) disagree — live: **49 rows returned vs `range.totalActivities: 19`**. The "{n} activities in selected period" header and the CSV export (≤100 rows) can therefore disagree with the stats cards, and >100-activity employees silently truncate.

### P2-5 — Activities-page stat cards computed from the current 15-row page
- `activityStats` (`totalActivities`, `totalDuration`, `productiveTime`, `unproductiveTime`) are reduced client-side over `data.data` (15 rows). With 881 total activities the cards display page-1 sums only, labeled as if representative. Misleading summary, no server aggregation.

### P3-1 — Daily chart buckets by UTC day, not org-local day
- `/api/activities/daily` uses `new Date(ts).toISOString().split('T')[0]` (UTC) while the dashboard's daily chart uses `localDayKey(ts, orgTz)` (Asia/Dhaka +06). Same data can land on different dates in the two charts. Also `days=0|-3|9999` unvalidated (9999 → 27-year bucket array; 0 → today only).

### P3-2 — `type`/`category` not allowlisted
- Arbitrary values pass straight into the Prisma where (unknown values → empty 200, `<script>` accepted). Harmless today (no injection: parameterized) but contract-less vs sibling endpoints that validate.

### P3-3 — Employee-detail alerts/notifications filtered client-side by substring
- `allAlerts.filter(a => a.metadata?.includes(employee.employeeId) ...)` — fragile string matching (employeeId/email/firstName) after a 20-row org fetch; can miss or misattribute. Minor.

### P3-4 — Mixed timezone semantics in the detail route
- `parseISO('2026-08-13')` (UTC midnight) → `startOfDay` (local) → `setHours(23,59,59,999)` (local) — works for the server TZ but the explicit-range day boundaries differ from the list API's UTC-midnight boundary; inconsistent across the two activity surfaces.

---

## 4. Verified HEALTHY (production-grade)

- **Tenant isolation:** org from verified session only; `employeeId` is ANDed with `employee: { organizationId }` — foreign/nonexistent employeeId → empty 200, no leak (live). Org-less super_admin → empty list.
- **RBAC:** anonymous → 401; viewer/manager/admin (session-org) → 200. No client `organizationId` accepted anywhere in these routes.
- **Pagination integrity (application rows):** 59 pages, stable `orderBy timestamp desc`, no duplicates across pages (spot-checked), page-size honored.
- **Realtime:** WS `activity-ping` invalidates `['activities']` and `['dashboard']` → the Activities page and Overview feed refetch near-real-time (mechanism verified in `websocket-provider.tsx`).
- **Dashboard recentActivities:** org-scoped, top-10, JS-excluded (keeps NULL-appName website rows correctly) — the Overview widget is the *only* surface where website/idle rows actually appear.
- **Employee lookup:** detail route org-scopes the employee (foreign → 404, concealing).
- **No fabricated data:** no Math.random/hardcoded/mock values in any Activities component or route (swept).
- **Loading/empty/error states:** skeletons, honest empty states, error banners present (no fabricated fallback numbers).

---

## 5. Live Probe Evidence Matrix

| Test | Expected | Actual | Status |
|---|---|---|---|
| Overview activities load | Real rows | 200, recentActivities top-10 | PASS |
| List page 1 (application) | 15 rows / total 881 | 15 / 881 / 59 pages | PASS |
| `type=website` filter | 560 rows | **0** | FAIL (P1-1) |
| `type=idle` filter | 479 rows | **0** | FAIL (P1-1) |
| `type=screenshot` filter | 228 rows | **0** | FAIL (P1-1) |
| `type=work_session` filter | 223 rows | **0** | FAIL (P1-1) |
| `from=today&to=today` | 281 rows | **0** | FAIL (P1-2) |
| `search=zzzz-no-such-app` | 0 rows | identical to no-search | FAIL (P2-3) |
| `page=abc` | 400/422 | **500** | FAIL (P2-1) |
| `page=-1` | 400/422 | **500** | FAIL (P2-1) |
| `dateFrom=notadate` | 400/422 | **500** | FAIL (P2-1) |
| `dateFrom=2026-13-99` | 400/422 | **500** | FAIL (P2-1) |
| `pageSize=0` | 400/422 | 200, `pageSize:0, totalPages:null` | FAIL (P2-2) |
| `pageSize=999999` | capped | 200 full-table | FAIL (P2-2) |
| daily `days=abc` | 400/422 | **500** | FAIL (P2-1) |
| daily `days=9999` | 400/422 | 200, 27-year bucket array | FAIL (P2-2) |
| Foreign employeeId | empty / no leak | 200, total 0 | PASS |
| Anonymous | 401 | 401 | PASS |
| Forged orgId (query) | ignored | session org intact | PASS |
| Employee detail (EMP top) | timeline === stats | **49 rows vs 19 total** | FAIL (P1-1/P2-4) |
| Employee with zero activities (EMP-001) | honest empty | 0 rows, stats 0 | PASS |
| Realtime new activity | appears | WS invalidate → refetch | PASS |
| Employee detail timeline export | ≤100 rows | capped at 100 | FAIL (P2-4, >100 case) |
| Dashboard daily buckets | org-local (Dhaka) | localDayKey (correct) | PASS |

---

## 6. Test Results (this session, no source changes)

```
Server suite:        563/563 PASS (tests/*.test.ts glob)
Presence suite:       14/14 PASS (standalone — throwaway-DB harness sets DATABASE_URL,
                      excluded from the combined glob run; 563 + 14 = 577 total)
Agent suite:         282/282 PASS (earlier today)
Extension:            7/7 PASS (earlier today)
TypeScript:            0 errors · ESLint: 0 errors on changed files (none this audit)
Prisma validate:      PASS · Next build: PASS (earlier today; no code changed since)
Existing activities coverage: agent-process-exclusion tests cover the agent-process
  filter with NON-NULL applicationName only — the NULL-drop (P1-1) is untested.
```

## 7. Cleanup Verification

- Probe scripts (`_act_audit.mts`, `_act_detail.mts`) deleted.
- No probe rows created (logins + read-only queries only). DB untouched (activities 2,371 — pre-existing).
- Audit created no rows: `0 probe rows · 0 temp scripts`.

## 8. Recommended Fix Plan (next phase)

1. **P1-1:** Fix the exclusion predicate to keep NULL-applicationName rows (explicit `OR: [{ applicationName: null }, …]` or JS-side exclusion everywhere); add regression tests seeding NULL-appName website/idle/screenshot/work_session rows.
2. **P1-2:** End the `to` boundary at the end of the org-local day (reuse `localDayKey`/TZ helpers).
3. **P2-1/P2-2:** Apply `validatePagination` + date validation (400/422) to `/api/activities` and `/api/activities/daily` (`days` 1–365 cap).
4. **P2-3:** Wire `search` into the API (title/applicationName/url contains, org-scoped) or remove the control.
5. **P2-4:** Align the detail timeline and summaries on one exclusion path; add "load more"/cursor pagination beyond `take: 100`; label the count truthfully.
6. **P2-5:** Move the stat cards to server aggregation (extend `/api/activities` with an org-scoped summary block).
7. **P3:** UTC→org-local daily bucketing; type/category allowlists; drop the fragile substring alert/notification matching; document TZ semantics.

**Exact files to change:** `src/app/api/activities/route.ts`, `src/app/api/activities/daily/route.ts`, `src/app/api/employees/[id]/detail/route.ts`, `src/lib/agent-process.ts` (predicate), `src/components/activities/activities-page.tsx`, and `tests/agent-process-exclusion.test.ts` (+ new activities regression suite).

---

## 9. Final Verdict

```
Source modified:    NO
Database modified:  NO
Schema modified:    NO
Seed modified:      NO
Probe rows remaining: 0
Temporary scripts remaining: 0
P0: 0   P1: 2   P2: 4   P3: 4
Final score:        64/100
Production verdict: NOT PRODUCTION READY
```

**Score breakdown:** Functional correctness 55 · Data correctness 50 · Employee-activity correctness 60 · Tenant isolation 100 · RBAC 100 · API integrity 55 · Filtering 40 · Pagination 60 · Realtime 90 · Error/loading states 65 · Performance 75 · Export 65 · UX truthfulness 60 · Test coverage 70 · Production readiness 55 → **64/100**. The two P1s (63% of data hidden; current day dropped from the default range) block production readiness; everything else is fixable in the planned hardening pass without touching auth, tenant isolation, or the ingestion pipeline.
