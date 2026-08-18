# Admin Section Production-Readiness Audit

**Scope:** Admin → Organization / Reports / Daily Report / Settings (including all PDF/export/report-generation endpoints and any handler accepting `employeeId`, `projectId`, `reportId`, `organizationId`, or similar identifiers).

**Audit type:** AUDIT ONLY — no source code was modified. Temporary probe data was created, used for evidence, and cleaned (details in §26).

**Date:** 2026-08-13 · **Evidence basis:** direct source reads + live HTTP probes against the running dev server + real-Chrome (headless, CDP-driven) browser E2E + throwaway-PG test suites + static gates.

**Evidence classification:** CONFIRMED (direct source read AND live behavior), UNVERIFIED (could not test), INFERRED (source-only), NON-BLOCKING.

---

## 1. Executive Verdict

**NOT PRODUCTION READY.**

Confirmed P1 multi-tenant isolation failures exist in the Admin → Reports / Daily Report surface. An admin of Organization A can, through the normal product UI:

- see Organization B employees, departments, applications, activity hours, alerts and screenshots inside Organization A's **Daily Report** (live-confirmed in the browser: "Active Employees 2 of 1 total", PROBE-B rows rendered),
- see Organization B departments inside Organization A's **Team Activity Heatmap** (live-confirmed in the browser),
- generate and download **PDF employee/activity reports for Organization B employees** (HTTP 200 returned for a foreign-org `employeeId`),
- export a PDF **aggregating audit logs across all organizations**,
- overwrite **instance-global AI configuration** consumed by every organization through `PUT /api/settings`.

No P0 was found (no unauthenticated data access, no privilege escalation). The block is entirely P1 tenant-isolation + the instance-global settings write.

---

## 2. Page-by-Page Verdict

| Page | Verdict | Basis |
|---|---|---|
| Admin → Organization | READY WITH ISSUES | Scoped + audited; heatmap leaks cross-org activity (§7) |
| Admin → Reports | NOT READY | list/export scoped; generate title leak; dead custom-PDF button (§8) |
| Admin → Daily Report | NOT READY | cross-org contamination live-confirmed (§10) |
| Admin → Settings | NOT READY | instance-global PUT by any org-bound admin (§11) |

---

## 3. P0 Blockers

None found.

Unauthenticated access to every audited endpoint returns 401 (probed: `/api/reports`, `/api/organization`, `/api/settings`, `/api/ai-provider/*`). No privilege escalation found (viewer/manager 403s enforced at both proxy and handler level).

---

## 4. P1 Issues

| # | Issue | Evidence | Status |
|---|---|---|---|
| P1-1 | **Daily Report cross-org contamination** — `POST /api/reports/daily` runs unscoped `db.activity.findMany` (route.ts:38), `db.activity.aggregate` for breaks (route.ts:136), unscoped `alertsCount` (route.ts:148) and `screenshotsCount` (route.ts:155); only activeEmployees/onlineDevices are scoped. | Source + live: `leak=true` in probe; real-browser rendered "Active Employees 2 of 1 total", PROBE-B EMPLOYEE / PROBE-B-ENG rows with PROBE-B-APP-* activities, "Activities 16", "Alerts 4", "Screenshots 2" (both orgs counted). | **CONFIRMED** |
| P1-2 | **Team Activity Heatmap cross-org** — `GET /api/organization/team-data` runs `db.activity.findMany({ include })` with **no `where`** (route.ts:76-82); depts/employees are scoped, the activity source is not. | Live: adminA heatmap contained `PROBE-B-ENG` (7 rows); real-browser Organization page rendered PROBE-B-ENG 1.0h on Wednesday. | **CONFIRMED** |
| P1-3 | **AI Summary cross-org** — `POST /api/reports/daily/ai-summary` DB-mode runs unscoped `activity.findMany` (route.ts:44-46), `alert.findMany` (route.ts:67-74), `screenshot.findMany` (route.ts:82-87). Also trusts client-supplied `reportData` (prompt-injection / cost vector; probe returned 200 with fabricated payload). | Source + live 200s. | **CONFIRMED** |
| P1-4 | **Cross-org employee PDF** — `POST /api/reports/pdf/employee`: `db.employee.findUnique({ where: { id } })` (route.ts:25-28) with **no org constraint**; activities fetched by `employeeId` only (route.ts:42-53). | Live: adminA + orgB employeeId → **200**, 40KB PDF; filename/identity rendered. AdminB (own-org) also 200. | **CONFIRMED** |
| P1-5 | **Cross-org activity PDF** — `POST /api/reports/pdf/activity`: `db.activity.findMany({ where: { employeeId } })` (route.ts:22-54) with no org scope; `db.department.findMany({})` unfiltered. | Live: adminA + orgB employeeId → **200**, 38.9KB PDF. | **CONFIRMED** |
| P1-6 | **Cross-org audit PDF** — `POST /api/reports/pdf/audit`: `db.auditLog.findMany({ where: { date range only } })` (route.ts:21-44) — no `organizationId` constraint; a PDF of ALL organizations' audit logs is exported. | Source (no org filter) + live 200 for both orgs. | **CONFIRMED** |
| P1-7 | **Instance-global settings write by any org-bound admin** — `PUT /api/settings` (route.ts:55-124) upserts into the instance-global `SystemSetting` table (no org column). Any org-bound admin can overwrite `ai_provider` / `ai_model` / `ai_base_url` / `ai_api_key` for **every organization**, or create arbitrary free-form keys. No audit log is written. Handler-level `requireAdminOrg` is present (defense-in-depth OK) but the authorization boundary itself is wrong: org-scoped privileges grant instance-global writes. | Live: adminA PUT created global row + overwrote global `ai_provider` → `openai` (restored after probe). | **CONFIRMED** |
| P1-8 | **Report-generation employee title leak** — `POST /api/reports/generate` employee case: `db.employee.findUnique({ where: { id } })` unscoped (route.ts:84) leaks the foreign employee's name into the report title; `computeEmployeeReport` itself IS org-scoped (route.ts:419-420). | Live: adminA + orgB employeeId → **201**, report titled "PROBE-B EMPLOYEE Performance Report — Aug 13, 2026…" visible in orgA report list. | **CONFIRMED** |

**PDF text-extraction note:** PDF binary glyph decoding was not required for confirmation — the unscoped DB queries and live HTTP 200s for foreign-org identifiers independently prove cross-org data retrieval.

---

## 5. P2 Issues

| # | Issue | Evidence |
|---|---|---|
| P2-1 | **Dashboard PDF export is 100% broken** — `POST /api/reports/pdf/dashboard` passes `orgFilter = { organizationId }` to `db.activity.aggregate(...)` (route.ts:46-48, 71-74, 103-107, 142-147), but the `Activity` model has **no `organizationId` field** (org scope exists only via the employee relation). Every org-bound caller gets 500 (Prisma validation error logged); only an org-less session would succeed. Broken for all real tenants. | Live: 500 for adminA and adminB across 4 request variants; server log shows `Unknown argument 'organizationId'` on `ActivityWhereInput`. |
| P2-2 | **Input validation: 500 instead of 400** — garbage/empty inputs to `POST /api/reports` (empty body, garbage dates), `POST /api/reports/daily` (bad date, empty body), `POST /api/reports/generate` (garbage dates), `POST /api/reports/pdf/audit` (garbage dates), `PUT /api/settings` (missing value) all return **500** with a generic error; `new Date('garbage')` is passed through to Prisma. | Live-probed (10 cases, 7 → 500). |
| P2-3 | **Settings / report mutations are not audited** — settings PUT, reports POST and reports generate write no `AuditLog` row. Failed and unauthorized mutations correctly write zero rows (verified), but successful admin mutations leave no trace. | Source read + D-AUDIT probes. |
| P2-4 | **No rate limit on AI-cost endpoints** — proxy `RATE_RULES` covers `/api/reports`, `/api/reports/pdf`, `/api/reports/generate` but **not** `/api/reports/daily` or `/api/reports/daily/ai-summary`; ai-summary calls an external AI provider per request (cost-DoS vector). | Source read (src/proxy.ts). |

---

## 6. P3 Cleanup

| # | Item |
|---|---|
| P3-1 | `POST /api/reports/pdf/custom` is referenced by the Reports page "Generate Custom PDF" button (reports-page.tsx:515) but **no backend route exists** — the button always 404s. Either implement the route or remove the button. |
| P3-2 | `GET /api/reports` has no pagination and ignores `type`/`pageSize`; daily-report.tsx:498 queries `?type=productivity&pageSize=7` which is silently ignored (returns all reports, any type). |
| P3-3 | `POST /api/reports` accepts free-form `type`/`format` (no enum validation; `format:'zzz'` accepted), and `POST /api/reports/daily` creates a new `Report` row on every call with no dedup (4 probe calls → 4 rows). |
| P3-4 | Stale test: `tests/admin-prod-sidebar.test.ts` NAV-2 expects viewer access to the `consent` page, but navigation.ts:39-40 intentionally moved `consent` to manager+ ("matches /api/consent"); `consent` API is manager-gated at the proxy. Test expectation outdated — code is correct. |
| P3-5 | Pre-existing lint errors in src: `require()` in src/lib/pdf-generator.ts:122, `prefer-const` in api/agent/logout/route.ts:37, `setState` in effect in agent-account-dialog.tsx:31. None in the audited surface beyond pdf-generator style. |

---

## 7. Organization Security

**Verdict: READY WITH ISSUES (P1-2 heatmap).**

- `GET /api/organization` — org-scoped counts/auditLogs/alerts; viewer/manager → 403 (proxy + handler). **PASS**
- `PATCH /api/organization` — admin-gated; timezone-only whitelist (client `organizationId` and `userId` ignored — live-proven); IANA validation (invalid → 400); audited (exactly 1 row, actor = session user). **PASS**
- `GET/POST /api/organizations` — list org-scoped; create is super_admin-only, org-less-only, rate-limited, audited, transactional. **PASS**
- `GET /api/organization/team-data` — **P1-2 leak** (unscoped activity source).

---

## 8. Reports Security

**Verdict: NOT READY (P1-8).**

- `GET /api/reports` — org-scoped, payload/filePath stripped → `hasData` only. **PASS**
- `GET /api/reports/[id]/{export,csv,pdf}` — org-scoped; adminB exporting orgA report → 404 (live). **PASS**
- `POST /api/reports` — manager+; client `organizationId` ignored (row stored under session org — live). **PASS** (untyped inputs, un-audited → P2/P3).
- `POST /api/reports/generate` — manager+; compute functions org-scoped (productivity/attendance/activity/device via `employee.organizationId`; department scoped → cross-org dept 404 live); **employee title lookup unscoped → P1-8**.

---

## 9. PDF/Export Security

| Endpoint | Org scope | Status |
|---|---|---|
| `/api/reports/pdf/employee` | ✗ (employee lookup + activities unscoped) | **P1-4** |
| `/api/reports/pdf/activity` | ✗ (employeeId-only filter; `department.findMany({})`) | **P1-5** |
| `/api/reports/pdf/audit` | ✗ (no org filter on auditLog) | **P1-6** |
| `/api/reports/pdf/dashboard` | ✓ scope derived from session (`requireSessionOrg`; body `organizationId` ignored) but **always 500** for org-bound callers | **P2-1** |
| `/api/reports/pdf/project` | ✓ project lookup org-scoped | PASS |
| `/api/reports/pdf/custom` | — no backend route (dead) | **P3-1** |
| `GET /api/reports/[id]/pdf,csv,export` | ✓ | PASS |

---

## 10. Daily Report Security

**Verdict: NOT READY (P1-1, P1-3).** Live-confirmed cross-org contamination in the rendered UI: orgA's Daily Report shows orgB employees, departments, apps, activity hours, alert and screenshot counts.

---

## 11. Settings Security

**Verdict: NOT READY (P1-7).**

- `GET /api/settings` — admin+ (proxy + handler); global `SystemSetting` view with secret redaction (`REDACTED`) and dead-key filtering. Read-only leak is informational; secrets are redacted. NON-BLOCKING.
- `PUT /api/settings` — handler-level `requireAdminOrg` (401 unauth / 403 viewer+manager live-proven); **but** writes instance-global rows; any org-bound admin can alter global AI config consumed by all orgs; free-form keys (only a dead-key blocklist); no audit log. **P1-7.**
- `GET/PUT /api/settings/monitoring` and `/retention` — org-scoped `OrganizationSetting`, typed registry, validated, audited. **PASS.**
- Mass-assignment: `organizationId`, `role`, `isSuperAdmin`, `securityLevel` in PUT body are ignored (handler destructures only `key`/`value`) — no privilege escalation. The free-form-key write itself is the issue.
- Super-admin note: in the current dev DB the super admin is org-bound (organizationId `cmsr3iuqg000afi7gssdifp1n`, "Bangladesh computer Council"), so `requireAdminOrg` passes for it — the earlier "org-less super_admin cannot edit settings" inversion does not apply to this DB state.

---

## 12. API Inventory

```
┌─────────────────────────────┬────────┬────────┬──────────────┬────────────┬─────────────┐
│ Endpoint                    │ Method │ Auth   │ RBAC         │ Org Scope  │ Status      │
├─────────────────────────────┼────────┼────────┼──────────────┼────────────┼─────────────┤
│ /api/organization           │ GET    │ ✓      │ admin        │ ✓          │ PASS        │
│ /api/organization           │ PATCH  │ ✓      │ admin        │ ✓          │ PASS        │
│ /api/organization/team-data │ GET    │ ✓      │ admin        │ ✗ (P1-2)   │ P1          │
│ /api/organizations          │ GET    │ ✓      │ admin        │ ✓          │ PASS        │
│ /api/organizations          │ POST   │ ✓      │ super_admin  │ n/a (creates)│ PASS      │
│ /api/reports                │ GET    │ ✓      │ manager      │ ✓          │ PASS        │
│ /api/reports                │ POST   │ ✓      │ manager      │ ✓          │ PASS (P3)   │
│ /api/reports/daily          │ POST   │ ✓      │ manager      │ ✗ (P1-1)   │ P1          │
│ /api/reports/daily/ai-summary│ POST  │ ✓      │ manager      │ ✗ (P1-3)   │ P1          │
│ /api/reports/generate       │ POST   │ ✓      │ manager      │ ⚠ title (P1-8)│ P1      │
│ /api/reports/[id]/export    │ GET    │ ✓      │ manager      │ ✓          │ PASS        │
│ /api/reports/[id]/csv       │ GET    │ ✓      │ manager      │ ✓          │ PASS        │
│ /api/reports/[id]/pdf       │ GET    │ ✓      │ manager      │ ✓          │ PASS        │
│ /api/reports/pdf/employee   │ POST   │ ✓      │ manager      │ ✗ (P1-4)   │ P1          │
│ /api/reports/pdf/activity   │ POST   │ ✓      │ manager      │ ✗ (P1-5)   │ P1          │
│ /api/reports/pdf/audit      │ POST   │ ✓      │ manager      │ ✗ (P1-6)   │ P1          │
│ /api/reports/pdf/dashboard  │ POST   │ ✓      │ manager      │ ✓ but 500  │ P2          │
│ /api/reports/pdf/project    │ POST   │ ✓      │ manager      │ ✓          │ PASS        │
│ /api/reports/pdf/custom     │ —      │ —      │ —            │ —          │ DEAD (P3)  │
│ /api/settings               │ GET    │ ✓      │ admin        │ global read│ PASS*       │
│ /api/settings               │ PUT    │ ✓      │ admin        │ global W   │ P1-7        │
│ /api/settings/monitoring    │ GET/PUT│ ✓      │ admin        │ ✓          │ PASS        │
│ /api/settings/retention     │ GET/PUT│ ✓      │ admin        │ ✓          │ PASS        │
│ /api/ai-provider/usage      │ GET    │ ✓      │ admin (proxy)│ ✓          │ PASS        │
│ /api/ai-provider/test-conn  │ POST   │ ✓      │ admin (proxy)│ n/a        │ PASS        │
└─────────────────────────────┴────────┴────────┴──────────────┴────────────┴─────────────┘
*redacted secrets, dead keys filtered — informational only
```

---

## 13. RBAC Matrix (live-probed)

| Caller | settings GET | settings PUT | organization GET/PATCH | team-data | reports GET/POST | reports/pdf | ai-provider |
|---|---|---|---|---|---|---|---|
| Unauthenticated | 401 | 401 | 401 | 401 | 401 | 401 | 401 |
| viewer | 403 | 403 | 403 | 403 | 403 POST / 200 GET? | 403* | 403 |
| manager | 403 | 403 | 403 | 403 | 200 | 200 | 403 |
| admin (orgA) | 200 | 200 ⚠ | 200 | 200 ⚠ | 200/201 | 200 ⚠ | 200 |
| admin (orgB) | 200 | — | 200 | 200 | 200 (own only) | 200 | 200 |

*viewer on `/api/ai-provider/usage` returned 403 via the proxy rule `/api/ai-provider` → admin (defense-in-depth; handler allows any session). `/api/reports*` has **no proxy rule** — handler-level `requireManagerOrg` is the only gate (works; viewer POST → 403 live).

---

## 14. Multi-Tenant Isolation Evidence

Probe setup: ORG A (`probe-org-a`) and ORG B (`probe-org-b`) with distinct employees (PROBE-A-/PROBE-B-), departments, devices, activities, alerts, audit logs, screenshots.

| Test (adminA → orgB identifier) | Expected | Actual | Result |
|---|---|---|---|
| team-data heatmap contains PROBE-B dept | NO | YES (7 rows) | **FAIL (P1-2)** |
| reports/daily contains PROBE-B data | NO | YES (leak=true) | **FAIL (P1-1)** |
| reports/daily/ai-summary (DB mode) | no orgB counts | 200, unscoped queries | **FAIL (P1-3)** |
| pdf/employee w/ orgB employeeId | 404 | 200 + 40KB PDF | **FAIL (P1-4)** |
| pdf/activity w/ orgB employeeId | 404 | 200 + 38KB PDF | **FAIL (P1-5)** |
| pdf/audit (full range) | orgA only | 200 (all orgs' logs) | **FAIL (P1-6)** |
| generate employee report w/ orgB emp | no leak | 201, orgB name in title | **FAIL (P1-8)** |
| generate department w/ orgB dept | 404 | 404 | PASS |
| reports/[id]/csv of orgA report as adminB | 404 | 404 | PASS |
| reports POST w/ body organizationId=orgB | row in orgA | row in orgA | PASS |
| organization PATCH w/ body organizationId=orgB | orgB unchanged | orgB unchanged | PASS |
| pdf/dashboard w/ body organizationId=orgB | ignored | ignored (session scope) | PASS (but 500, P2-1) |
| settings PUT w/ body organizationId=orgB | not org-scoped | global row created | **FAIL (P1-7)** |

---

## 15. Database-Driven Verification

Every business value on the four audited pages was traced UI → API → Prisma query → DB:

- Organization page: org info, counts, heatmap, headcount, recent hires, dept performance, timezone, monitoring config → `/api/organization`, `/api/organization/team-data`, `/api/settings/monitoring`, `/api/employees`.
- Reports page: totals, list, generate, exports → `/api/reports`, `/api/reports/generate`, `/api/reports/[id]/*`.
- Daily Report page: productivity, hours, employees, depts, breaks, alerts, screenshots, online devices, history → `/api/reports/daily`, `/api/reports/daily/ai-summary`.
- Settings page: retention + monitoring tabs → `/api/settings/retention`, `/api/settings/monitoring`; AI provider page → `/api/settings`, `/api/ai-provider/*`.

Searched audited components for `Math.random()`, `mock`, `faker`, `demo`, `sample`, `fake`, `hardcoded` → **zero matches**. No mock/fake chart data. E2E rendered real seeded/probe DB values (PROBE-A-*/PROBE-B-* rows visible). **PASS.**

---

## 16. Report Accuracy Verification

- Report list `hasData` derives from real `data`/`filePath` payloads; no payload/filePath returned (probe + source). **PASS**
- Report rows persisted: daily POST created real `Report` rows (count=4 in orgA at probe time). **PASS**
- Daily report figures matched the seeded DB rows (16 activities, 2 employees, 2 screenshots across both orgs — i.e., the leak is visible in the numbers). **CONFIRMED leak, data itself real.**

---

## 17. Input Validation

| Input | Endpoint | Result | Verdict |
|---|---|---|---|
| empty body | POST /api/reports | 500 | FAIL (expect 400) |
| empty title/type | POST /api/reports | 400 | PASS |
| garbage dates + bogus type/format | POST /api/reports | 500 | FAIL |
| garbage date | POST /api/reports/daily | 500 | FAIL |
| empty body | POST /api/reports/daily | 500 | FAIL |
| garbage dates | POST /api/reports/generate | 500 | FAIL |
| missing type | POST /api/reports/generate | 400 | PASS |
| missing employeeId | pdf/employee | 400 | PASS |
| invalid employeeId | pdf/employee | 404 | PASS |
| garbage dates | pdf/audit | 500 | FAIL |
| missing key | PUT /api/settings | 400 | PASS |
| key w/o value | PUT /api/settings | 500 | FAIL |
| page=abc&pageSize=abc | GET /api/reports | 200 (params ignored) | PASS (no crash; P3 note) |
| invalid timezone | PATCH /api/organization | 400 | PASS |

`NaN`/`Infinity`/huge values: no endpoint in scope performs numeric arithmetic on client input beyond page params, which are unused on `/api/reports` (params ignored) — not reachable.

---

## 18. Audit Log Integrity

- Failed PATCH (bad tz): audit rows before=14, after=14 → **zero rows**. PASS
- Successful PATCH: exactly **1** new row; actor = session user (`cmsr44ix8…`, adminA), client-supplied `userId` ignored; row carries correct `organizationId`. PASS
- Cross-org PATCH attempt: orgB unmodified, no orgB audit row. PASS
- Gap: settings PUT, reports POST, reports generate write **no audit rows at all** (P2-3).

---

## 19. Dead Code / Dead API Findings

- `/api/reports/pdf/custom` — referenced by UI, no route (P3-1). A dead-but-reachable-unsafe endpoint was **not** found; the unsafe endpoints (pdf/employee, pdf/activity, pdf/audit) are all actively wired to real UI buttons — they are live attack surface, not dead code.
- `GET /api/reports` ignores `type`/`pageSize` params sent by daily-report.tsx (P3-2).
- No obsolete proxy rules found; `/api/reports*` intentionally has no proxy rule (handler enforces).

---

## 20. Performance Findings

- `/api/reports/pdf/dashboard` fires an N+1-style set of `Promise.all` per-department/per-employee aggregates without limits (bounded by `take:50` devices only); combined with the 500 bug it is not currently exploitable but will be heavy once fixed.
- `GET /api/reports` is unbounded (no pagination) — every report row for the org is fetched on each load (P3-2).
- `POST /api/reports/daily` performs several unscoped full-table aggregations across all orgs' activities (compounding the isolation issue with performance cost).
- `ai-summary` has no rate limit → external AI cost DoS (P2-4).

---

## 21. Test Results

Run against throwaway PostgreSQL DBs (`scripts/pg-test-db.mjs` + `prisma db push`).

| Suite | Pass | Fail |
|---|---|---|
| multi-org-isolation | 48 | 0 |
| hardening | 17 | 0 |
| security | 28 | 0 |
| projects | 17 | 0 |
| consent | 27 | 0 |
| consent-summary | 9 | 0 |
| super-admin | 18 | 0 |
| agent-account | 11 | 0 |
| agent-account-admin | 27 | 0 |
| agent-auth-login | 22 | 0 |
| health | 5 | 0 |
| organization-bootstrap | 14 | 0 |
| admin-prod-reports-rbac | 7 | 0 |
| admin-prod-settings | 4 | 0 |
| admin-prod-dashboard | 5 | 0 |
| admin-prod-monitoring | 11 | 0 |
| admin-prod-analytics-fixes | 17 | 0 |
| admin-prod-sidebar | 5 | **1** (stale NAV-2, P3-4) |
| **Total** | **292** | **1 (stale test)** |

Note: none of the audited suites cover the daily-report / pdf / team-data org-scope gaps (P1-1..P1-8) — those were proven by this audit's live probes instead.

---

## 22. TypeScript / ESLint / Prisma / Build Results

| Gate | Result |
|---|---|
| `npx tsc --noEmit` | PASS (0 errors) |
| `npx prisma validate` | PASS (schema valid) |
| `npx eslint src` | 3 pre-existing errors (none in audited surface; pdf-generator `require()` is style-level) |
| `npm run build` | PASS — Proxy (Middleware) mounted; all API routes compile |

---

## 23. Live HTTP Probe Results

Probe scripts (temp, deleted after audit): `scripts/_audit_probe_live.mts`, `_audit_probe_part2.mts`, `_audit_probe_pdf*.mts`, `_audit_probe_dash.mts`.

- Login matrix: 6/6 probe users (adminA/managerA/viewerA/adminB/managerB/super_admin) → 200 + token.
- RBAC: 12/12 expected 401/403s enforced (viewer/manager blocked from settings, organization, team-data; viewer blocked from reports POST and ai-provider; unauthenticated → 401).
- Cross-org: **7 confirmed failures** (P1-2, P1-1, P1-4, P1-5, P1-6, P1-7, P1-8) + 6 passes.
- Settings PUT matrix: 401/403 for unauth/viewer/manager; admin + super_admin → 200 (global write).
- Input validation: 7 of 13 cases → 500 (P2-2).
- Audit integrity: all 4 checks passed.
- Dashboard PDF: 4/4 variants → 500 (P2-1).

Total: 30/37 (probe 1) + 21/31 (probe 2) = **51/68**; all 17 failures are findings (none are probe/script errors).

---

## 24. Real Browser E2E Results

Real Chrome (headless, CDP-driven, window 1440×1000) against the running dev server, logged in as adminA.

- **Organization page**: rendered real DB data; heatmap showed **PROBE-B-ENG** (cross-org) — P1-2 visible in UI. Zero console errors.
- **Reports page**: rendered report list (3 rows incl. leaked "PROBE-B EMPLOYEE Performance Report"); zero console errors.
- **Daily Report page**: rendered, and **displayed cross-org data** — "Active Employees 2 of 1 total", PROBE-B EMPLOYEE + PROBE-B-ENG rows, "Activities 16", "Alerts 4", "Screenshots 2" — P1-1 visible in UI. Zero console errors.
- **Settings page**: rendered tabs with real (empty dev-DB) data; zero console errors.
- **Viewer session**: Admin sidebar group absent; clicking Settings footer link → 3 network 403s (proxy+handler), restricted view. PASS.
- Screenshots saved to `%TEMP%\opencode\audit-shots2/3`.

E2E status: **COMPLETED** (real browser, logged-in, both admin and viewer paths).

---

## 25. Remaining Issues

Everything in §4 (P1-1..P1-8) and §5 (P2-1..P2-4) is open. No fixes were applied — this is an audit-only session.

---

## 26. Required Fixes Before Production

1. **Scope every activity/alerts/screenshots query by org** in: `team-data` (P1-2), `reports/daily` (P1-1), `reports/daily/ai-summary` (P1-3), `pdf/employee` (P1-4), `pdf/activity` (P1-5), `pdf/audit` (P1-6) — via the employee/device/org relation where the table lacks `organizationId`.
2. **Scope the employee lookup** in `reports/generate` (add `organizationId` to the `findUnique` where) (P1-8).
3. **Restrict `PUT /api/settings`** to org-scoped keys or a super-admin-only global store; add an allowlist; write an audit row (P1-7).
4. **Fix `pdf/dashboard`** — scope activity aggregates through `employee.organizationId` instead of a non-existent `organizationId` column (P2-1).
5. **Input validation**: reject invalid dates/empty bodies with 400 instead of letting `new Date()`/Prisma throw 500 (P2-2).
6. **Audit settings/report mutations**; add rate limits for daily + ai-summary (P2-3, P2-4).
7. Implement or remove `/api/reports/pdf/custom`; add pagination to GET /api/reports (P3).
8. Update stale NAV-2 sidebar test (P3-4).

After fixes: re-run the P1 probe matrix (must be 100% green), re-run suites, and re-do browser E2E before re-certifying.

---

## 27. Final Score

| Dimension | Score | Notes |
|---|---|---|
| RBAC enforcement | 9/10 | handler + proxy; one proxy-rule gap on /api/reports* is covered by handler |
| Tenant isolation | **3/10** | 5 P1 cross-org read leaks + 1 global write |
| Input validation | 4/10 | 7 endpoints return 500 |
| Audit integrity | 6/10 | correct rows on org PATCH; missing for settings/reports |
| Functional completeness | 5/10 | dashboard PDF dead; custom PDF dead |
| Data authenticity | 10/10 | all DB-backed, no mocks |
| Test coverage | 7/10 | strong suites but gaps on daily/pdf/team-data scope |
| Static quality | 8/10 | tsc/build clean; 3 pre-existing lint errors |
| **Overall** | **5.3/10** | **NOT PRODUCTION READY** |

---

## 28. Final Certification

**CERTIFICATION: NOT PRODUCTION READY**

Blocking: 8 confirmed P1 findings (P1-1..P1-8) including live-confirmed cross-tenant data exposure in the Daily Report UI, the Organization heatmap, three PDF export endpoints, the report-generate title, and an instance-global settings write. Certification will remain blocked until all P1 items are fixed and regression-proven (per §26).

## Probe Data Cleanup Report

All temporary probe data was **fully deleted and re-verified** at the end of the session:

- **Scripts:** all 12 temp scripts (`scripts/_audit_probe_*.mts`, `scripts/_audit_e2e*.mts`) deleted — 0 remain.
- **DB rows deleted (verified via post-delete counts = 0):** 2 probe orgs, 5 probe users, 2 employees, 2 departments, 2 devices, 16 activities, 4 alerts, 2 screenshots, 36 audit logs, 4 reports; `SystemSetting` probe rows removed earlier (0 rows).
- Settings probe rows created during testing (`x`/`y` key and the temporary `ai_provider` row) were removed at the time of probing; `SystemSetting` verified empty (0 rows).
- No source code was modified; the dev DB is back to its pre-audit state.
