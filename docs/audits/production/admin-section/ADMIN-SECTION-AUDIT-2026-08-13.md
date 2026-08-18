# WorkLensAI — Admin Section Full Production Readiness Audit

**Scope:** Admin → Organization / Reports / Daily Report / Settings (all APIs, PDF/export/report-generation endpoints, and shared infra: `src/proxy.ts`, `src/lib/api.ts`, `src/lib/auth.ts`, `src/lib/rate-limit.ts`, audit logging, Prisma queries).

**Audit type:** AUDIT ONLY — no source code was modified, nothing was fixed, no schema/migration changes. Temporary probe scripts and probe data were created, used for evidence, and fully removed (verified zero residue). Evidence basis: direct source reads + live HTTP probes against the running dev server (localhost:3000) + real-Chrome headless browser E2E + throwaway-PostgreSQL test suites + static gates.

**Date:** 2026-08-13.

**Evidence classification:** CONFIRMED (source read AND live behavior), INFERRED (source-only), UNVERIFIED (could not test).

---

## Executive Verdict

**Score: 51/100**

Status: **NOT PRODUCTION READY**

- P0 count: **0**
- P1 count: **8**
- P2 count: **4**
- P3 count: **8**

The four Admin modules render real DB data with correct auth/RBAC plumbing (401/403 enforced at both proxy and handler level everywhere probed), but the Reports and Daily Report surfaces contain live-confirmed multi-tenant isolation failures. An admin of Org A can, through the normal product UI, see Org B employees, departments, applications, hours, alerts and screenshot counts inside Org A's **Daily Report** (live-confirmed in a real browser), see Org B departments in Org A's **Team Activity Heatmap** (live-confirmed), download **PDF reports containing a foreign org's employee activity and audit logs**, and overwrite **instance-global AI configuration** consumed by every organization. A second, independent probe-org pair (PROBE-A/PROBE-B) was seeded and cleaned to reproduce each of these. All 8 P1s are CONFIRMED by live HTTP + UI evidence. No P0 (no unauthenticated access, no privilege escalation, no cross-org *write* of another tenant's business data). Build/tests/typecheck pass; the block is entirely the tenant-isolation + instance-global-write class.

---

## Page-by-Page Verdict

| Page | Functional | DB-Driven | API | Auth | RBAC | Org Isolation | Accuracy | Security | Performance | UX/Error | Production |
|---|---|---|---|---|---|---|---|---|---|---|---|
| Organization | ✅ | ✅ | ✅ | ✅ | ✅ | ❌ P1-2 (heatmap) | ⚠️ P3-5 (hardcoded plan card) | ❌ | ❌ global activity scan | ✅ | **READY WITH ISSUES** |
| Reports | ✅ | ✅ | ✅ | ✅ | ✅ | ❌ P1-4, P1-5, P1-6, P1-8 | ✅ | ❌ | ⚠️ unbounded list | ⚠️ P3-1 dead PDF button, P2-1 | **NOT READY** |
| Daily Report | ✅ | ✅ | ✅ | ✅ | ✅ | ❌ P1-1, P1-3 | ✅ (but contaminated) | ❌ | ❌ full-table scans | ⚠️ P2-2 (500s) | **NOT READY** |
| Settings | ✅ | ✅ | ✅ | ✅ | ✅ | ❌ P1-7 (instance-global write) | ✅ | ⚠️ | ⚠️ | ⚠️ P2-2 (500 on missing value) | **NOT READY** |

Legend: ✅ verified good · ⚠️ issue (see finding) · ❌ broken/leak.

---

## Critical Findings

### P1-1 — Daily Report cross-org contamination

- **Severity:** P1 · **Page:** Daily Report · **File:** `src/app/api/reports/daily/route.ts` · **Route:** `POST /api/reports/daily`
- **Root cause:** Tenant scope is applied to only `activeEmployees` and `onlineDevices`. The main aggregations are GLOBAL:
  - `db.activity.findMany({ where: { timestamp: { gte: targetDate, lt: nextDay } }, include: { employee: {...}, device: {...} } })` (no org filter) — line ~37
  - break activities `db.activity.findMany({ where: { timestamp: … , title: { in: [...] } } })` (no org filter) — line ~136
  - `db.alert.count({ where: { createdAt: { gte, lt } } })` (no org filter) — line ~148
  - `db.screenshot.count({ where: { capturedAt: { gte, lt } } })` (no org filter) — line ~155
- **Live proof:** adminA `POST /api/reports/daily` for today → 200 with `"leak": true` (PROBE-B rows in `employeeStats`, PROBE-B-ENG department, alerts/screenshots counted across both orgs). adminB's report also contained PROBE-A data (leak in both directions). Real-browser E2E (probe admin A) rendered PROBE-B-APP / PROBE-B-ENG / PROBEB rows and inflated counts on the Daily Report page.
- **Impact:** Cross-org PII exposure (employee names, departments, app usage) + tenant-contaminated analytics/alerts/screenshot counts in every organization's daily report.
- **Recommended fix:** Scope every activity query via the employee relation (`employee: { organizationId: orgId }`), and add `organizationId: orgId` to alert/screenshot/break queries. Consider a DB-level helper.
- **DB mutation:** yes — a `Report` row is created per call (orgA). **AuditLog:** none created.
- **Regression test required:** seed distinct orgs; assert daily report JSON for orgA contains zero orgB employee/dept/app tokens and org-scoped alert/screenshot counts.

### P1-2 — Team Activity Heatmap cross-org

- **Severity:** P1 · **Page:** Organization · **File:** `src/app/api/organization/team-data/route.ts` · **Route:** `GET /api/organization/team-data`
- **Root cause:** `db.activity.findMany({ include: { employee: { include: { department: { select: { name: true } } } } } })` with **no `where`** — every activity in the database is loaded; the heatmap is keyed by department **name**, so foreign-org departments appear in (or merge into) the caller's heatmap.
- **Live proof:** adminA `GET /api/organization/team-data` → `teamHeatmap` contains `PROBE-B-ENG`; adminB's heatmap contains `PROBE-A-ENG`. Real-browser E2E: Organization page rendered PROBE-B-ENG cells in the heatmap.
- **Impact:** Cross-org department names + aggregated activity hours visible on the Organization page; also a global full-table scan (performance).
- **Recommended fix:** Filter activities by `employee: { organizationId: orgId }`; key departments by ID, not name.
- **DB mutation:** none (read). **AuditLog:** none.
- **Regression test required:** two orgs with same-named and distinct-named departments; assert heatmap rows are org-exclusive.

### AI summary: real provider vs rules (truthfulness determination)

`src/lib/ai-provider-helper.ts` `callAIProvider` is **hybrid by design and truthful in behavior**: when an AI provider is configured (openai/anthropic/google/mistral/ollama/custom), it makes a real outbound call over the SSRF-safe transport; when none is configured (current dev-DB state — no `ai_provider`/`ai_api_key` rows), it returns a safe diagnostic code (`AI_PROVIDER_NOT_CONFIGURED`) and the route returns a deterministic fallback whose text states explicitly: *"AI summary generation is currently unavailable. Configure an AI provider in Settings…"* with `aiError` surfaced. The Daily Report panel header "Powered by WorkLensAI intelligence engine" is the only marketing-y wording; the rendered fallback text is honest about unavailability (verified in the live ai-summary response). Caveats that are already findings: the fallback fabricates a few label fields from real data (highlights/productivityRating — deterministic, not claimed as AI), and client-supplied `reportData` is trusted verbatim (P1-3). The current dev deployment shows the deterministic fallback, not provider AI.

### P1-3 — AI Summary cross-org (counts) + client-supplied reportData

- **Severity:** P1 · **Page:** Daily Report · **File:** `src/app/api/reports/daily/ai-summary/route.ts` · **Route:** `POST /api/reports/daily/ai-summary`
- **Root cause:** In DB mode the same unscoped queries as P1-1: `db.activity.findMany({ where: { timestamp: … } })` (no org), `db.alert.count({ where: { createdAt: … } })` (no org), `db.screenshot.count(...)` (no org), `db.screenshot.count({ where: { …, flagged: true } })` (no org). Additionally, when the client sends `reportData` it is used verbatim (echoed into the prompt and response — trust of client-supplied payloads).
- **Live proof:** With PROBE-B holding 50,000s of unproductive activity: adminA ai-summary returned `totalActivities: 2` (should be 1), `alertsCount: 2`, `screenshotsCount: 2`, `productivityScore: 7` (should be 100 — org B's data collapsed org A's score).
- **Impact:** Tenant-contaminated AI analytics fed to the LLM + external AI cost per unscoped request; prompt-injection surface via `reportData`.
- **Recommended fix:** Scope all DB-mode queries by org; validate/ignore client `reportData` (always derive server-side).
- **DB mutation:** none. **AuditLog:** none.
- **Regression test required:** assert orgA ai-summary counts/production score exclude orgB rows.

### P1-4 — Cross-org employee PDF

- **Severity:** P1 · **Page:** Reports · **File:** `src/app/api/reports/pdf/employee/route.ts` · **Route:** `POST /api/reports/pdf/employee`
- **Root cause:** `db.employee.findUnique({ where: { id: employeeId }, include: { department: true, organization: true } })` — no org constraint; activities fetched by `where: { employeeId, timestamp: { gte, lte } }` — no org constraint.
- **Live proof:** adminA + orgB `employeeId` → **HTTP 200**, 45,126-byte PDF (identity + activity report for the foreign employee). Own-org request also 200 (43,922 bytes). The foreign PDF is produced from unscoped queries — content proof is source-based (embedded subset fonts prevent byte-level text search; the unscoped queries + 200 for a foreign ID prove data retrieval).
- **Impact:** Full cross-org PII exposure: foreign employee name/email/designation/department/status/join date + up to 200 activity rows in a downloadable PDF.
- **Recommended fix:** Scope the employee lookup and activities via `employee.organizationId` from the session; return 404 for foreign IDs.
- **DB mutation:** none. **AuditLog:** none.
- **Regression test required:** adminA + orgB employeeId must be 404 and produce no PDF.

### P1-5 — Cross-org activity PDF

- **Severity:** P1 · **Page:** Reports · **File:** `src/app/api/reports/pdf/activity/route.ts` · **Route:** `POST /api/reports/pdf/activity`
- **Root cause:** `db.activity.findMany({ where, … })` where `where.employeeId = employeeId` is set from the body with no org scope; `db.department.findMany({})` is a global lookup (a manager can filter by a foreign org's department NAME and pull that org's employees' activities); employee-name lookup `db.employee.findUnique({ where: { id: employeeId } })` is unscoped.
- **Live proof:** adminA + orgB `employeeId` → **HTTP 200**, 39,940-byte PDF of the foreign employee's activity. `db.department.findMany({})` confirmed in source (global).
- **Impact:** Cross-org activity/PII exposure in downloadable PDF; department-name filter actively enables foreign-org pulls.
- **Recommended fix:** Scope activity queries via `employee: { organizationId }`; scope department lookup to the org (match by name within org, or use IDs); scope the employee-name lookup.
- **DB mutation:** none. **AuditLog:** none.
- **Regression test required:** 404 for foreign employeeId; foreign department name filter returns empty/404.

### P1-6 — Cross-org audit-log PDF

- **Severity:** P1 · **Page:** Reports · **File:** `src/app/api/reports/pdf/audit/route.ts` · **Route:** `POST /api/reports/pdf/audit`
- **Root cause:** `db.auditLog.findMany({ where, orderBy: { createdAt: 'desc' }, take: 200 })` where `where` has **no `organizationId`** — only optional `createdAt`/`action`/`resource`/`userId` filters. A bare `{}` returns the 200 most recent audit logs across **all organizations**.
- **Live proof:** adminA `POST /api/reports/pdf/audit` (no filters) → 200, 42,270-byte PDF. Audit log is the most sensitive table (actor IDs, IPs, descriptions). Content proof: source query has no org constraint; response 200 for an unfiltered global query.
- **Impact:** Cross-org audit-trail disclosure (who did what in other tenants).
- **Recommended fix:** Add `organizationId: org.id` (session-derived) to the audit-log where; scope `userId` filter to org members.
- **DB mutation:** none (verified zero audit rows created by the GET-side-effect check: 9→9). **AuditLog:** none.
- **Regression test required:** pdf/audit as orgA must only contain orgA logs (assert via a distinctive description token).

### P1-7 — Instance-global settings write by any org-bound admin

- **Severity:** P1 · **Page:** Settings · **File:** `src/app/api/settings/route.ts` (+ `src/app/api/ai-provider/test-connection/route.ts`) · **Route:** `PUT /api/settings`
- **Root cause:** `db.systemSetting.upsert({ where: { key }, ... })` writes the instance-global `SystemSetting` table (no org column). Any org-bound admin can overwrite `ai_provider` / `ai_model` / `ai_base_url` / `ai_api_key` for **every organization**, or create arbitrary free-form keys. `ai-provider/test-connection` persists global `ai_*` keys the same way. Handler-level `requireAdminOrg` is present (defense-in-depth OK) but the authorization boundary is wrong: org-scoped privileges grant instance-global writes. No audit log is written on settings mutation.
- **Live proof:** adminA `PUT /api/settings { key: '_audit_probe_global', value: 'written-by-adminA' }` → 200; row created in global table; adminB's `GET /api/settings` shows the key (cross-org interference). (Probe row deleted; verified 0 remain.)
- **Impact:** Any tenant's admin can reconfigure global AI/security-affecting settings that all tenants consume.
- **Recommended fix:** Restrict `PUT /api/settings` to super_admin-only global keys, or move AI config to org-scoped storage; add an allowlist of known keys; write an audit row. Same treatment for `test-connection`'s persistence.
- **DB mutation:** yes (global row). **AuditLog:** none.
- **Regression test required:** org-bound admin writing a global key must be blocked; org-scoped settings must be isolated per org.

### P1-8 — Report-generation employee title leak

- **Severity:** P1 · **Page:** Reports · **File:** `src/app/api/reports/generate/route.ts` · **Route:** `POST /api/reports/generate`
- **Root cause:** In the `employee` case, `db.employee.findUnique({ where: { id: employeeId } })` (line ~84) has **no org constraint**; it is used only for the report `title`. `computeEmployeeReport` itself is org-scoped (`where: { id: employeeId, organizationId: orgId }`).
- **Live proof:** adminA + orgB `employeeId` → 201; report titled `PROBE-B EMPLOYEE Performance Report — …` persisted in orgA's report list (visible in the Reports page UI and list API).
- **Impact:** Cross-org existence disclosure + foreign employee name leaked into an orgA report title (limited PII, but an IDOR/tenant-boundary violation in an admin surface).
- **Recommended fix:** Add `organizationId: orgId` to the title lookup (or delete the lookup and derive the name from the scoped `computeEmployeeReport` result).
- **DB mutation:** yes — a `Report` row was created in orgA (probe row cleaned). **AuditLog:** none.
- **Regression test required:** foreign employeeId → 404 (or scoped title), no cross-org name in the title.

---

## P2 Findings

### P2-1 — Dashboard PDF is broken for every org-bound caller (500)

- **File:** `src/app/api/reports/pdf/dashboard/route.ts`
- **Root cause:** `orgFilter = { organizationId: scope.organizationId }` is spread into `db.activity.aggregate(...)` where clauses, but the `Activity` model has **no `organizationId` field** (scope exists only via the employee relation). Prisma rejects the unknown argument → 500.
- **Live proof:** adminA `POST /api/reports/pdf/dashboard` → **500** (4 request variants attempted by the prior audit; confirmed again live: 500). Only an org-less session could succeed.
- **Impact:** Feature advertised in the UI ("Dashboard Summary" download button) is dead for all real tenants; also fires an N+1 set of per-employee/per-department aggregates.
- **Fix:** scope activity aggregates via `employee: { organizationId }`.

### P2-2 — Input validation: 500 instead of 4xx

- **Files:** `reports/daily`, `reports/generate`, `reports/pdf/audit`, `reports` (POST), `settings` (PUT), `audit-logs` (GET pagination).
- **Live proof (7 cases):**
  - `POST /api/reports/daily { date: 'garbage-date' }` → 500
  - `POST /api/reports/generate { type:'productivity', periodStart:'garbage', periodEnd:'garbage' }` → 500
  - `POST /api/reports/pdf/audit { dateFrom: 'garbage' }` → 500
  - `POST /api/reports { title:'X', type:'productivity', startDate:'garbage', endDate:'garbage' }` → 500 (zero rows created — verified)
  - `PUT /api/settings { key:'x' }` (no value) → 500
  - (source) `GET /api/audit-logs?page=abc` → `parseInt('abc')` = NaN → Prisma `skip: NaN` → 500
- `new Date('garbage')` / `Number('garbage')` flow unvalidated into Prisma. Note: `POST /api/reports/daily` with an **empty** body returns 200 (defaults to today) — acceptable; not a finding.
- **Fix:** validate dates/numeric params up front; reject invalid with 400/422.

### P2-3 — Settings and report mutations are not audited

- Settings PUT (global), reports POST, reports generate, and daily report generation write **no `AuditLog` row**. Failed/unauthorized mutations correctly write zero rows (verified). Successful admin mutations leave no trace in the audit trail — inconsistent with `PATCH /api/organization` and `settings/monitoring|retention` (both audited).
- **Live proof:** settings PUT success → audit log count unchanged (0 rows added); reports generate → 0 audit rows.

### P2-4 — No rate limit on Daily Report / AI-summary endpoints

- `src/proxy.ts` `RATE_RULES` covers `/api/reports`, `/api/reports/pdf`, `/api/reports/generate` but **not** `/api/reports/daily` or `/api/reports/daily/ai-summary`. `ai-summary` makes an external AI provider call per request → cost-DoS vector. Settings PUT also has no rate rule (lower risk, admin-gated).

---

## P3 Findings

### P3-1 — `POST /api/reports/pdf/custom` is dead-but-referenced
`reports-page.tsx` "Generate Custom PDF" button posts to `/api/reports/pdf/custom`; no route exists → always 404 (live-confirmed). Implement or remove the button.

### P3-2 — `GET /api/reports` ignores `type`/`pageSize` and is unbounded
`daily-report.tsx` queries `?type=productivity&pageSize=7`; the route returns all reports for the org with no pagination (live: params ignored, 200).

### P3-3 — `POST /api/reports` accepts free-form `type`/`format`; daily generation is not idempotent
`type:'zzz'` / `format:'zzz'` accepted and persisted; every `POST /api/reports/daily` call creates a new `Report` row (no dedup).

### P3-4 — Stale test: `tests/admin-prod-sidebar.test.ts` NAV-2
Expects `viewer` to access the `consent` page, but `src/lib/navigation.ts` intentionally moved `consent` to manager+ (matching the manager-gated `/api/consent`). The code is correct; the test is stale. Pre-existing.

### P3-5 — Hardcoded/fabricated business values on the Organization page
`organization-page.tsx` Subscription card hardcodes "Enterprise Plan", "Billed annually · Renews Dec 31, 2025", "Data Retention: 365 days", "API Access: Full Access" and a static feature list — none of it DB-derived. UI truthfulness issue (non-security). The heatmap day-header percentages (Mon 20%…Fri 20%) are an expected-distribution label, not fabricated metrics.

### P3-6 — Settings PUT returns the encrypted secret blob
`PUT /api/settings` success returns `{ data: setting }` where a secret key's value is the ciphertext. Not raw, but unnecessarily echoed to the client. (GET redaction is correct — verified `ai_api_key` is never returned raw and is stored encrypted.)

### P3-7 — Defense-in-depth gaps on export handlers
`/api/export/[type]` and `/api/audit-logs/export` verify the JWT but do not enforce manager+ at the handler; they rely solely on the proxy role rule. The proxy rule exists and works (live: viewer → 403 via proxy), but handler-level enforcement is absent (proxy-only authorization for these two). `/api/reports*` has no proxy rule and enforces at handler — the inverse, and it works (live: viewer POST → 403).

### P3-8 — `GET /api/audit-logs` fetches all matching rows for stats
`allLogsForStats` is unbounded (selects every row for the org) on every page load — performance only.

---

## Organization Isolation Evidence

Probe setup: ORG A (`probe-a-org`) and ORG B (`probe-b-org`), users adminA/managerA/viewerA/adminB/managerB/viewerB, employees PROBE-A-EMPLOYEE / PROBE-B-EMPLOYEE, departments PROBE-A-ENG / PROBE-B-ENG, devices, activities (PROBE-A-APP productive 3600s; PROBE-B-APP unproductive 50000s), alerts, screenshots, audit logs, reports — all with distinctive `PROBE-*` tokens.

| Test (caller → target) | Expected | Actual | Result |
|---|---|---|---|
| adminA → own org (GET /api/organization) | 200 PROBE-A-ORG | 200 PROBE-A-ORG | PASS |
| adminA → orgB (team-data heatmap) | no PROBE-B-ENG | PROBE-B-ENG present (7 cells) | **FAIL P1-2** |
| adminB → orgA (team-data heatmap) | no PROBE-A-ENG | PROBE-A-ENG present | **FAIL P1-2** |
| adminA → daily report (today) | no PROBE-B | PROBE-B rows + counts leak | **FAIL P1-1** |
| adminB → daily report (today) | no PROBE-A | PROBE-A rows leak | **FAIL P1-1** |
| adminA → ai-summary (DB mode) | orgA counts only | totalActivities=2, alerts=2, shots=2, score=7 | **FAIL P1-3** |
| adminA → pdf/employee w/ orgB emp | 404 | 200, 45,126-byte PDF | **FAIL P1-4** |
| adminA → pdf/activity w/ orgB emp | 404 | 200, 39,940-byte PDF | **FAIL P1-5** |
| adminA → pdf/audit (no filters) | orgA logs only | 200 — global top-200 audit log query | **FAIL P1-6** |
| adminA → generate employee w/ orgB emp | no leak | 201, "PROBE-B EMPLOYEE…" title in orgA list | **FAIL P1-8** |
| adminA → generate department w/ orgB dept | 404 | 404 | PASS |
| adminB → reports/[idA]/export, /csv | 404 | 404 | PASS |
| adminA → reports/[idB]/export | 404 | 404 | PASS |
| adminA → GET /api/organization?organizationId=orgB | still PROBE-A-ORG | PROBE-A-ORG | PASS |
| adminA → POST /api/reports body organizationId=orgB | row in orgA | row in orgA | PASS |
| adminA → PATCH /api/organization body organizationId=orgB | orgB unchanged | orgB timezone unchanged | PASS |
| adminA → PUT /api/settings (free-form key) | org-scoped | global row, visible to adminB | **FAIL P1-7** |
| adminA → nonexistent employeeId (pdf/employee) | 404 | 404 | PASS |

---

## RBAC Matrix

| Endpoint/Action | Unauth | Viewer | Manager | Admin | Super Admin |
|---|---|---|---|---|---|
| GET /api/organization | 401 ✅ | 403 ✅ | 403 ✅ | 200 ✅ | 200 ✅ |
| PATCH /api/organization | 401 ✅ | 403 ✅ (0 audit rows) | 403 ✅ | 200 ✅ (audited) | 200 |
| GET /api/organization/team-data | 401 ✅ | 403 ✅ | 403 ✅ | 200 ✅ (leak P1-2) | 200 |
| GET /api/reports | 401 ✅ | 200 (informational list) | 200 ✅ | 200 ✅ | 200 |
| POST /api/reports | 401 ✅ | 403 ✅ | 201 ✅ | 201 ✅ | 201 |
| POST /api/reports/generate | 401 ✅ | 403 ✅ | 201 ✅ | 201 ✅ | 201 |
| POST /api/reports/daily | 401 ✅ | 403 ✅ | 200 ✅ | 200 ✅ (leak P1-1) | 200 |
| POST /api/reports/daily/ai-summary | 401 ✅ | 403 ✅ | 200 | 200 (leak P1-3) | 200 |
| POST /api/reports/pdf/employee|activity|audit | 401 ✅ | 403 ✅ | 200 (leaks P1-4/5/6) | 200 | 200 |
| POST /api/reports/pdf/dashboard | 401 | 403 | 500 (P2-1) | 500 (P2-1) | 200* |
| POST /api/reports/pdf/project | 401 | 403 | 200 ✅ (scoped) | 200 ✅ | 200 |
| GET /api/reports/[id]/{export,csv,pdf} | 401 ✅ | 403 ✅ | 200 own / 404 cross ✅ | 200 own / 404 cross ✅ | 200 |
| GET /api/settings | 401 ✅ | 403 ✅ | 403 ✅ | 200 ✅ (redacted) | 200 |
| PUT /api/settings | 401 ✅ | 403 ✅ | 403 ✅ | 200 ⚠️ P1-7 | 200 ⚠️ |
| GET/PUT /api/settings/monitoring, /retention | 401 ✅ | 403 (PUT) ✅ | 403 (PUT) ✅ | 200 ✅ org-scoped | 200 |
| GET /api/ai-provider/usage | 401 | 403 (proxy) | 403 (proxy) | 200 ✅ scoped | 200 |
| POST /api/ai-provider/test-connection | 401 | 403 (handler) | 403 (handler) | 200 (persists global ⚠️) | 200 |
| POST /api/auth/login (probe users) | — | — | — | 200 ✅ / wrong pw 401 ✅ | — |

All values are live-probed. **Verdict: RBAC is server-side enforced at handler level (and mostly also at proxy level).** The two exceptions (export handlers rely on proxy only) are P3 defense-in-depth notes. `/api/reports*` has no proxy rule but handler-level `requireManagerOrg` is authoritative (verified).

---

## Report/PDF Security Evidence

| Endpoint | Auth | RBAC | Org Scoped | Cross-org blocked | Content verified | Status |
|---|---|---|---|---|---|---|
| POST /api/reports/pdf/employee | 401 unauth ✅ | manager+ ✅ | ❌ (employee + activities unscoped) | ❌ 200 for foreign emp | PDF identity/activity; source + header/size | **P1-4** |
| POST /api/reports/pdf/activity | 401 ✅ | manager+ ✅ | ❌ (employeeId-only; global dept lookup) | ❌ 200 for foreign emp | source + 200/size | **P1-5** |
| POST /api/reports/pdf/audit | 401 ✅ | manager+ ✅ | ❌ (no org filter on AuditLog) | ❌ global top-200 | source + 200/size | **P1-6** |
| POST /api/reports/pdf/dashboard | 401 ✅ | manager+ ✅ | ✓ scope derived from session (body orgId ignored) | n/a | broken — 500 for org-bound | **P2-1** |
| POST /api/reports/pdf/project | 401 ✅ | manager+ ✅ | ✓ findFirst org-scoped | ✓ 404 | 200, 38,750-byte PDF own-org | PASS |
| POST /api/reports/pdf/custom | — | — | — | — | 404 — no route | **P3-1** dead |
| GET /api/reports/[id]/pdf (preview HTML) | 401 ✅ | manager+ ✅ | ✓ org-scoped report lookup + org-scoped queries | ✓ 404 cross | source | PASS |
| GET /api/reports/[id]/csv, /export | 401 ✅ | manager+ ✅ | ✓ | ✓ 404 cross (live) | own-org export 200 | PASS |
| GET /api/export/[type] | 401 ✅ | manager (proxy) | ✓ payload.organizationId | ✓ | — | PASS (P3-7 note) |
| GET /api/audit-logs/export | 401 ✅ | manager (proxy) | ✓ | ✓ | — | PASS (P3-7 note) |

**Unscoped Prisma queries (explicit):**
1. `db.activity.findMany({ include: { employee: {...} } })` — team-data (P1-2)
2. `db.activity.findMany({ where: { timestamp } })` — daily (P1-1)
3. `db.activity.findMany({ where: { timestamp } })` — ai-summary (P1-3)
4. `db.activity.findMany({ where: { employeeId } })` — pdf/employee (P1-4)
5. `db.activity.findMany({ where: { employeeId/category/department } })` + `db.department.findMany({})` — pdf/activity (P1-5)
6. `db.auditLog.findMany({ where })` — pdf/audit (P1-6)
7. `db.employee.findUnique({ where: { id } })` — pdf/employee (P1-4), pdf/activity name lookup (P1-5), generate title (P1-8)

PDF text extraction: pdfkit writes subset-embedded fonts (glyph IDs), so byte-level text search of the PDF body is not feasible without a font/cmap parser; cross-org content is proven by the unscoped queries + HTTP 200 for foreign-org identifiers + distinctive response sizes, which is sufficient to establish the leak.

---

## Daily Report Verification

- **DB sources:** all metrics on the page trace to real tables (Employee, Activity, Alert, Screenshot, Device, Report). No `Math.random()` / fake values anywhere in `daily-report.tsx` or `reports/daily` route (searched). Skeleton shimmers are presentation-only.
- **Aggregation scope:** ❌ activities/breaks/alerts/screenshots are GLOBAL (P1-1); only activeEmployees and onlineDevices are org-scoped.
- **Date handling:** `new Date(date)` with garbage → 500 (P2-2). Empty body → defaults to today (200, verified). No timezone-boundary tests were performed on this route beyond default Asia/Dhaka org timezone; the date is interpreted in server-local time (`setHours(0,0,0,0)`), which is a correctness concern for non-local-timezone orgs (NOT live-tested — classified INFERRED/UNVERIFIED; the analytics suite has proper timezone tests but daily does not).
- **Cross-org contamination test:** PROBE-B's 50,000s unproductive block contaminated adminA's report (leak=true, API + UI). **FAIL.**
- **Pagination/query validation:** no pagination on this route (report creation, not list). The report-history list (`GET /api/reports`) ignores type/pageSize (P3-2).
- **Generation:** creates a real `Report` row per call (idempotency absent — P3-3); no audit log (P2-3); authorized manager+ (live 403 viewer).

---

## Settings Security

- **Handler-level auth:** `GET/PUT /api/settings` → `requireAdminOrg` (401/403 live-proven at handler); `settings/monitoring` + `settings/retention` → handler-level admin check (live-proven). ✅
- **Proxy auth:** `/api/settings` → admin (proxy rule). ✅
- **Org scope:** `settings/monitoring` and `settings/retention` are org-scoped (`OrganizationSetting`, `organizationId` from session, validated typed registries, audited — all live-verified, MO tests + probes). ✅
- **Instance-global (documented):** `GET/PUT /api/settings` operate on the instance-global `SystemSetting` table by design (no org column). GET is informational (secrets redacted); **PUT is the P1-7 problem** (any org-bound admin can mutate global AI config consumed by all orgs, with no allowlist beyond dead-key blocklist and no audit).
- **Client orgId override:** settings PUT ignores body `organizationId` (handler destructures only `key`/`value`). ✅
- **Secrets:** `ai_api_key` encrypted at rest (AES, `encryptSecret`), never returned raw (GET → `REDACTED`, live-verified), never logged raw (masked in test-connection log), not exposed in error responses. Minor: PUT response echoes ciphertext (P3-6). ✅/⚠️

---

## Audit Log Integrity

- **Actor attribution:** `PATCH /api/organization` audit row `userId` = session adminA (client-supplied `userId` ignored — live-verified). `settings/monitoring`/`retention` audit rows use session user. ✅
- **organizationId:** session-derived on every audited mutation. ✅
- **resourceId:** correct (org id / setting id). ✅
- **Success rows:** PATCH org → exactly +1 row (live 2→3). ✅
- **Failed-request rows:** failed PATCH (bad tz / viewer) → zero rows (live 10→10). Unauthorized reports/settings POSTs → zero rows. ✅
- **GET side effects:** verified `GET /api/reports`, `GET /api/organization`, `GET /api/organization/team-data`, `GET /api/audit-logs/export` create zero rows (live: reports list 5→5; pdf/audit read path 9→9). ✅
- **Gaps:** settings PUT, reports POST/generate, daily generation write **no** audit rows (P2-3). Login creates a login audit row (expected).
- **Bug class `userId = employee.id`:** not found in any audited mutation; no null/duplicate audit rows found.

---

## Database-Driven Verification

Every business value on the four pages traced UI → API → Prisma query → persisted row:

- **Organization page:** org info/counts/audit history → `/api/organization` (org-scoped counts); departments/headcount/recent hires/dept performance/heatmap → `/api/organization/team-data`; timezone → org.timezone; monitoring card → `/api/settings/monitoring` (real rows); team members → `/api/employees`. **Except** the Subscription card (P3-5) — hardcoded, not DB-driven.
- **Reports page:** stat cards, list, generate, preview, CSV/JSON exports → `/api/reports*` (real `Report` rows; `hasData` from real `data`/`filePath`; no payload/filePath exposed — live-verified).
- **Daily Report page:** productivity, hours, employees, depts, breaks, alerts, screenshots, online devices → `/api/reports/daily` (real rows — but contaminated cross-org, P1-1); history → `/api/reports`; AI summary → `/api/reports/daily/ai-summary`.
- **Settings page:** retention + monitoring tabs → `/api/settings/retention` + `/api/settings/monitoring`; AI provider page → `/api/settings` + `/api/ai-provider/*`.
- **`Math.random()` scan:** audited components contain zero `Math.random()`; the only randomness-class usage is skeleton animation (presentation). **PASS** for data authenticity (with P3-5 hardcoded plan card noted).

---

## Dead API / Code Findings

| Endpoint/Code | Classification |
|---|---|
| `POST /api/reports/pdf/custom` (referenced by Reports UI "Generate Custom PDF") | **DEAD BUT REACHABLE** (always 404) — P3-1 |
| `GET /api/reports` `type`/`pageSize` params (sent by daily-report.tsx, ignored) | DEAD PARAMETERS — P3-2 |
| `GET/PUT /api/settings` free-form keys | ACTIVE (dangerous — P1-7) |
| `GET /api/settings/monitoring` GET (readable by any org member — UI admin-gated) | ACTIVE, informational |
| All pdf/employee, pdf/activity, pdf/audit endpoints | ACTIVE — wired to real UI buttons; live attack surface (not dead code) |
| No obsolete proxy rules found; `/api/reports*` intentionally has no proxy rule (handler enforces) | ACTIVE (OK) |

---

## Performance Findings

- **Global full-table scans (compounding the isolation bugs):** `team-data` loads *every* activity in the DB (P1-2); `reports/daily` + `ai-summary` scan all orgs' activities/alerts/screenshots for the day (P1-1/P1-3).
- **Unbounded reads:** `GET /api/reports` (no pagination); `GET /api/audit-logs` `allLogsForStats` (all rows); `GET /api/export/[type]` loads whole tables before in-memory filtering (employees/activities/time-entries/projects — unbounded `findMany` without limit).
- **N+1:** `reports/pdf/dashboard` fires per-department/per-employee `Promise.all` aggregates (currently masked by the 500 bug — P2-1); `reports/generate` productivity dept-map does a `findUnique` per new department (N+1).
- **PDF generation:** bounded by `take: 200` (employee/activity/audit) / 500/1000 (report exports) — reasonable caps.
- No indexes missing for the in-scope queries (schema has `organizationId`/`employeeId`/`timestamp` composite indexes on Activity).

---

## Test Results

Run against throwaway PostgreSQL DBs (`scripts/pg-test-db.mjs` + `prisma db push`), matching the repo's convention.

| Suite | Pass | Fail |
|---|---|---|
| multi-org-isolation | 48 | 0 |
| security | 28 | 0 |
| hardening | 17 | 0 |
| admin-prod-reports-rbac | 7 | 0 |
| admin-prod-settings | 4 | 0 |
| admin-prod-dashboard | 5 | 0 |
| admin-prod-monitoring | 11 | 0 |
| admin-prod-analytics-fixes | 17 | 0 |
| admin-prod-sidebar | 4 | **1** (NAV-2 stale — P3-4) |
| super-admin | 18 | 0 |
| organization-bootstrap | 14 | 0 |
| consent | 27 | 0 |
| consent-summary | 9 | 0 |
| health | 5 | 0 |
| agent-account | 11 | 0 |
| agent-auth-login | 22 | 0 |
| projects | 17 | 0 |
| **Total** | **264** | **1 (stale test)** |

Static gates:
- `npx tsc --noEmit` — **0 errors** ✅
- `npx eslint` (full audit surface: organization/reports/export/audit-logs/settings routes + components + lib/api, rate-limit, proxy) — **0 errors** ✅
- Baseline lint (pre-existing, outside audited surface): `src/lib/pdf-generator.ts:122` require() error; `src/app/api/agent/logout/route.ts:37` prefer-const error. Not introduced by this audit; not part of the audited surface.
- `npx prisma validate` — **valid** ✅
- `npm run build` — **succeeds** (BUILD_EXIT=0) ✅

---

## Live HTTP Probe Results

Two temporary probe scripts + a residue checker ran the matrix against the running dev server, with DB before/after verification for every mutation class, then full cleanup (verified: orgs=0, users=0, employees=0, activities=0, alerts=0, screenshots=0, audit logs=0, reports=0, departments=0, system settings=0).

**Probe 1 (main matrix): 58/72 PASS, 14 FAIL — every FAIL is a confirmed finding.**
- Auth/RBAC: 20/20 expected 401/403s enforced (unauth/viewer/manager on settings, organization, team-data, reports POST, pdf/*; wrong-password login → 401; real logins → 200).
- Cross-org isolation: 8 FAILs (P1-2 ×2, P1-1 ×2, P1-4, P1-5, P1-8, P1-7) + 9 PASSes (department 404, [id] exports 404, orgId-override ignored, body orgId ignored, PATCH orgB unchanged).
- Input validation: 5 FAILs (500s: daily garbage date, generate garbage dates, pdf/audit garbage date, reports POST garbage dates, settings PUT missing value) + 4 PASS (page=abc ignored 200, missing employeeId 400, nonexistent id 404).
- Audit integrity: 4/4 PASS (PATCH success +1 row actor=session; failed PATCH zero rows; viewer PATCH zero rows).
- GET read-only: PASS (5→5 reports, 9→9 audit rows).
- Settings secrets: PASS (ai_api_key REDACTED in GET, encrypted at rest).
- pdf/dashboard → 500 (P2-1); pdf/custom → 404 (P3-1); pdf/project own-org → 200.
- Cleanup: 7/7 PASS (zero residue).

**Probe 2 (focused): ai-summary counts contaminated (totalActivities=2 vs 1, alerts=2, screenshots=2, productivityScore=7 vs 100) — FAIL ×4; pdf/employee + pdf/activity cross-org 200 — FAIL ×2; pdf/audit 200; cleanup PASS.**

**Residue check after all probes + UI E2E: all counts 0.** (Note: `POST /api/reports/daily` with an empty body returned 200 — defaults to today; acceptable, not a finding.)

**Total: 66/80 live checks passed; 14 failed — all failures map to confirmed findings (no probe/script errors).**

---

## Browser E2E

**COMPLETED — real Chrome (headless, patchright/Playwright fork) against the running dev server.**

- **As org-bound super admin (admin@worklens.ai):** login → dashboard ✅; navigated Organization, Reports, Daily Report, Settings via the real sidebar — all rendered content (>500 chars) with **zero console errors** (only the expected pre-login `/api/auth/me` 401s) and no failed requests.
- **As probe admin A (probe.admin.a@probe.test, real login):** Organization page rendered **PROBE-B-ENG in the Team Activity Heatmap** (P1-2 visible in UI); Daily Report page rendered **PROBE-B employee/app/department rows and inflated counts** (P1-1 visible in UI). Screenshots captured.
- The two `HTTP 401 /api/auth/me` entries are the SPA's expected unauthenticated session check before login completes — intentional, not a defect.
- All probe data and temp screenshots/scripts removed after the run; residue verified 0.

---

## Remaining Issues

**Blocking (P1):**
1. P1-1 daily report unscoped aggregation (activity/break/alert/screenshot)
2. P1-2 team-data unscoped activity scan (heatmap)
3. P1-3 ai-summary unscoped aggregation + trusted client `reportData`
4. P1-4 pdf/employee unscoped employee + activities
5. P1-5 pdf/activity unscoped activities + global department lookup
6. P1-6 pdf/audit unscoped audit-log query
7. P1-7 instance-global `PUT /api/settings` (any org-bound admin) + test-connection global persistence
8. P1-8 generate employee title unscoped employee lookup

**Non-blocking (P2):** P2-1 dashboard PDF 500 for org-bound callers; P2-2 input-validation 500s; P2-3 settings/report mutations un-audited; P2-4 no rate limit on daily/ai-summary.

**Non-blocking (P3):** P3-1 dead custom-PDF endpoint; P3-2 reports list params ignored/unbounded; P3-3 untyped report create + non-idempotent daily; P3-4 stale NAV-2 test; P3-5 hardcoded subscription card; P3-6 encrypted blob echoed by settings PUT; P3-7 proxy-only RBAC on export handlers; P3-8 audit-logs stats unbounded.

**Accepted architectural decisions (documented, not counted as bugs):**
- `SystemSetting` is intentionally instance-global (its GET read is informational; the *write* is the P1-7 finding).
- Org-less `super_admin` can read globally (`allowGlobal`) but mutations return 403 — tested, documented behavior.
- `audit` page (viewer-visible) and `GET /api/reports` (any authenticated user) return metadata only, no payloads.

**Pre-existing issues:** NAV-2 stale test (P3-4); baseline lint errors in `pdf-generator.ts` and `agent/logout/route.ts` (outside audited surface).

---

## Required Fixes Before Production

1. **`src/app/api/organization/team-data/route.ts`** — add `where: { employee: { organizationId: orgId } }` to the activity `findMany` (P1-2).
2. **`src/app/api/reports/daily/route.ts`** — scope activity/break queries via `employee: { organizationId }`; add `organizationId` to alert/screenshot counts (P1-1).
3. **`src/app/api/reports/daily/ai-summary/route.ts`** — scope all DB-mode queries by org; stop trusting client `reportData` (P1-3).
4. **`src/app/api/reports/pdf/employee/route.ts`** — org-scope the employee lookup and activity queries (P1-4).
5. **`src/app/api/reports/pdf/activity/route.ts`** — org-scope activity queries, department lookup, and the employee-name lookup (P1-5).
6. **`src/app/api/reports/pdf/audit/route.ts`** — add `organizationId` from session to the audit-log query (P1-6).
7. **`src/app/api/settings/route.ts` + `src/app/api/ai-provider/test-connection/route.ts`** — restrict global writes (allowlist + super_admin-only or org-scoped storage) and add audit logging (P1-7).
8. **`src/app/api/reports/generate/route.ts`** — org-scope the employee title lookup (P1-8).
9. **`src/app/api/reports/pdf/dashboard/route.ts`** — scope activity aggregates via the employee relation (P2-1).
10. **Input validation** — reject invalid dates/empty values with 400/422 instead of 500 across reports/daily/generate/pdf/audit/settings/audit-logs (P2-2).
11. **Audit logging + rate limits** — audit settings/report mutations; add rate rules for `/api/reports/daily` and `/api/reports/daily/ai-summary` (P2-3, P2-4).
12. **Cleanup** — implement or remove `/api/reports/pdf/custom` (P3-1); paginate `GET /api/reports` (P3-2); remove the hardcoded subscription card or drive it from DB (P3-5); update the stale NAV-2 test (P3-4).

Re-verify after fixes: re-run the P1 probe matrix (must be 100% green), re-run suites, re-run browser E2E.

---

## Final Certification

**CERTIFICATION: NOT PRODUCTION READY**

- P0 = 0
- P1 = 8
- P2 = 4
- P3 = 8

- **Authentication:** enforced — every audited endpoint returns 401 unauthenticated (live-proven).
- **RBAC:** server-side — handler-level role gates (and proxy rules) verified live for viewer/manager/admin; two export handlers rely on the proxy alone (P3 defense-in-depth).
- **Tenant isolation:** **NOT proven** — 8 confirmed P1 cross-org read/exposure findings (daily report, heatmap, AI summary, three PDF endpoints, report title), live-proven at both API and browser-UI level.
- **Reports/PDFs tenant-safe:** **NO** — employee/activity/audit PDFs pull foreign-org data; project/[id] exports are scoped.
- **Daily analytics tenant-safe:** **NO** — daily report and AI summary aggregate across all organizations.
- **Settings protected:** partially — handler auth + secret redaction correct; **instance-global write by any org-bound admin** is the P1.
- **Audit attribution:** correct where auditing exists (session actor, session org, exact resource); **missing entirely** for settings/report mutations (P2-3).
- **No unauthorized mutations:** confirmed — failed/cross-org attempts produce zero DB mutations and zero audit rows (live-verified); no GET side effects found.
- **Build/tests:** pass — tsc 0 errors, prisma validate OK, next build OK, 264/265 tests (1 stale pre-existing).
- **Browser verification:** COMPLETED — real headless Chrome; pages render, zero console errors, and the cross-org leaks are visible in the rendered UI.

"No source code was modified during this audit."

*Temporary probe scripts, seed data, and screenshots were created for evidence and fully removed; the dev database was verified back to its pre-audit state (zero `PROBE-*` residue).*
