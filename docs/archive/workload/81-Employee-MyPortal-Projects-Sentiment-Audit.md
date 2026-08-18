# WorkLensAI — Employee My Portal Projects Sentiment Audit

**Date:** 2026-08-12
**Method:** Read-only audit. No source code modified. Evidence gathered from code tracing, live HTTP probes against the running app (`localhost:3000`, PostgreSQL `workai`), direct DB queries, browser verification (real Chrome via browser-use), and test suites.
**Audit scope:** Admin Panel → Employee → My Portal → Projects → Sentiment.

---

## Executive Verdict

**Status: NOT READY**
**Score: 71/100**
**Production readiness: NOT PRODUCTION READY**

The claimed feature journey **"Employee → My Portal → Projects → Sentiment" does not exist as a hierarchy.** My Portal, Projects and Sentiment are **three flat sibling pages** under the sidebar "Employee" section. My Portal has **no Projects tab** and **no Sentiment section**; the Projects page has **no Sentiment tab**; and the Sentiment page is a standalone, org-wide, **employee-level** analysis surface with no project association at all. There is **no `projectId` on `SentimentRecord`**, no project↔sentiment relation in the schema, and no API or UI that associates sentiment with a project.

What *does* exist and work well: a genuinely functional org-scoped Projects module, a genuinely functional Sentiment analysis pipeline (deterministic scoring over real activity data, honest no-data semantics, consent-gated, tenant-isolated, correctly attributed AI-or-rules labeling), and a manager+ My Portal. Security/RBAC/tenant isolation is strong and was verified live.

Blocker-level issues: (1) the advertised journey and project-level sentiment are absent; (2) the Sentiment detail dialog **fabricates zeros** (Productivity 0%, Total Hours 0h, Productive Hrs 0h) because it reads signal keys the analyze route never writes; (3) the configured AI provider (google + OpenAI-compatible base URL + gpt-4o model) would produce a broken request, and the only live record is `aiProviderUsed: rules` — no AI output ever observed; (4) `/api/sentiment/summary` is a dead endpoint with no UI consumer.

---

## 1. Feature Architecture

| Piece | Reality |
|---|---|
| Navigation model | SPA with client-side page switching (`src/app/page.tsx` → `pageComponents[currentPage]`). No nested routes. |
| Sidebar "Employee" section | `My Portal` (`self-portal`), `Projects` (`projects`), `Sentiment` (`sentiment`) — **flat siblings** (`app-sidebar.tsx:90-99`). |
| My Portal (`SelfPortalPage`) | Tabs: **Overview, Activities, Devices, Consents, Anomalies**. **No Projects. No Sentiment.** |
| Projects (`ProjectsPage`) | List + detail tabs: **Overview, Team, Time Log, Analytics**. **No Sentiment.** |
| Sentiment (`SentimentPage`) | Org-wide employee sentiment grid + stats + "Run Analysis". **No project filter, no project context.** |
| Role gating (UI) | `navigation.ts`: `self-portal: 'manager'`, `projects: 'viewer'`, `sentiment: 'viewer'`. |

**Finding A (HIGH):** The audited journey is a **flat SPA page switch**, not a hierarchy. There is no path `Employee → My Portal → Projects → Sentiment`. `My Portal` and `Projects` are completely disjoint in the UI; sentiment is never reachable from a project.

**Finding B (HIGH):** My Portal is a manager/admin *proxy viewer* for any employee (employee combobox, arbitrary `employeeId`), not a self-service portal for the logged-in employee. An employee-role user cannot even navigate to it (nav gate + `/api/self` RBAC both reject employee role).

---

## 2. User Journey (verified in real Chrome)

1. Login as admin → sidebar "Employee" section shows exactly `My Portal`, `Projects`, `Sentiment`.
2. Click **My Portal** → tabs Overview / Activities / Devices / Consents / Anomalies. **No Projects or Sentiment tab exists.**
3. Click **Projects** → project list; open project "ok" → tabs Overview / Team / Time Log / Analytics. **No Sentiment section.**
4. Click **Sentiment** → stats cards (Avg Sentiment, Positive, At Risk, Burnout Risk, Analyzed), Mood Distribution bar, filters (All Moods / All Departments / Search / Sort), employee cards, Run Analysis button. **No project name or filter appears.**
5. Two non-fatal console resource errors (a 401 and a 404) during load — badge/avatar fetch noise, not feature-breaking.

**Conclusion:** The journey the audit was asked to certify **cannot be performed**. The pages exist, but the interconnection does not.

---

## 3. Database Audit

Schema (`prisma/schema.prisma`):

- `SentimentRecord` (L782-806): `employeeId`, `score Float?` (NULL = no-data), `mood`, `signals String?`, `insight`, `riskFactors`, `recommendation`, `periodStart`, `periodEnd`, `aiProviderUsed`, `aiModel`, `organizationId`, indexes `[organizationId]`, `[employeeId]`, `[employeeId, periodStart]`. **NO `projectId`.**
- `Project` (L699-726): org-scoped, `members ProjectMember[]`, `timeEntries TimeEntry[]`, `departmentId`. **No sentiment relation.**
- `ProjectMember` (L730-750): `@@unique([projectId, employeeId])`, org-scoped, soft-remove via `leftAt`.
- `Employee` → `SentimentRecord[]`, `ProjectMember[]`, `activities`, etc.

Live DB state:
- 1 organization, 1 employee (cuid `cmsol39...`), 1 project ("ok", active, org-scoped), 1 membership, **0 time entries**, 1 sentiment record (`neutral`, score 45, `aiProviderUsed: rules`, signals keys `productivityTrend, idleRate, overtimeHours, breakFrequency, loginConsistency, anomalyCount, activityDrop…`).
- All 8 consents granted incl. `activity_tracking`.

**Finding C (HIGH — the central one):** **Sentiment is purely employee-level.** There is no `projectId`, no `ProjectSentiment`, no query, endpoint or UI that answers "which sentiment belongs to which project". Any UI claiming project-specific sentiment would be fabricating it; **no such UI exists** (the sentiment page does not even mention projects).

**Data integrity:** no hardcoded/demo sentiment in the live DB (the single record came from a real analysis run); `score` correctly `NULL`-able; no fabricated neutral scores for unmeasured employees (verified in analyze route + tests).

---

## 4. Project Audit

- **List** (`GET /api/projects`): org-scoped, server-side sort/pagination, status/priority/dept/search filters, KPI stats (byStatus/byPriority/totalHours/overdue). Verified live: 200 with 1 project.
- **Detail** (`GET /api/projects/[id]`): org-scoped (404 cross-org), members (active only) with per-member hours, time entries (take 50), progress = hours/estimatedHours, billable. Verified 200.
- **Create/Update/Delete**: admin-only (`requireAdminOrg`), full input validation (enums, date ordering, name length, duplicate-name 409), cross-org `departmentId` rejected 422, audit log on every mutation. Live: manager POST → 403 ✓.
- **Employee↔Project assignment** (`GET/PUT /api/employees/[id]/projects`): GET session-org scoped; PUT admin-only, transaction (create/reactivate/soft-remove), every project validated to belong to the caller's org (422 cross-org). Tested: security.test PROJECT-13/14, projects.test 17/17.
- **Time entries**: schema + API exist; **live DB has 0 time entries** — the project's hours/progress/analytics tabs render from genuinely empty data (honest empty state, not fake).

**Finding D (LOW):** Project detail "Analytics" tab is driven by time entries; with no time-entry ingestion in the live org the tab shows empty/zero metrics. That is truthful, not fabricated.

---

## 5. Sentiment Audit

Pipeline (`POST /api/sentiment/analyze`, read + verified):
- RBAC manager+ (`requireManagerOrg`); body validation (400 for bad/absent/malformed JSON, `periodDays` 1-90, `employeeIds` ≤50); **in-process 409 guard** against concurrent runs per (org, period); rate-limited in proxy (`aiWrite`).
- Tenant-scoped employee selection (org always from verified JWT; client ids only narrow).
- **Consent gate:** only employees with active `activity_tracking` consent are analyzed (`hasActiveConsent`); others counted as `consentSkipped`. Verified in code + tests.
- Signals from real `Activity` (3 batched queries — no N+1) + `Anomaly` counts; deterministic rules score; mood thresholds; risk factors.
- **No-data:** zero activity in window → `score: null`, `mood: 'no-data'`, `aiProviderUsed: 'none'`, honest insight/recommendation. Never a fabricated neutral.
- **AI:** `generateAIInsight` (concurrency 3) → `callAIProvider`; on success stores provider/model; on failure **falls back to rules** with accurate `aiProviderUsed: 'rules'` attribution.
- **Atomic replace:** deletes the exact (org, employee, periodStart) set, then inserts — re-runs never stack duplicates. Audit log per run.
- **List** (`GET /api/sentiment`): org-scoped; latest-per-employee dedup (server-side, orderBy createdAt desc + first-occurrence); server-side mood/dept/search filters + sort (null scores last); pagination; stats computed over the deduped full set; departments dropdown org-scoped. Verified live 200.
- **Detail** (`GET /api/sentiment/[id]`): org-scoped via `employee.organizationId` (cross-org → 404, tested MO-17), **PII stripped** (no email/phone in response — previously leaked; now fixed), JSON-parsed signals/riskFactors. **Delete:** admin-only, id validated.
- **Summary** (`GET /api/sentiment/summary`): org-scoped, latest-per-employee, no-data excluded from averages. **No UI consumer anywhere** (verified: zero references in `src/components`).

**Finding E (MEDIUM):** `/api/sentiment/summary` is a **dead endpoint** — only referenced by tests. Its dashboard-widget consumer no longer exists (or was never wired).

**Finding F (HIGH — UI truthfulness):** The Sentiment **detail dialog** renders `Key Signals` from signal keys the API never writes:

| SignalCard label | Reads (`sentiment-page.tsx`) | Analyzer persists (`analyze/route.ts`) | Result |
|---|---|---|---|
| Productivity | `s.productivityPct` | `productivityTrend` | **always 0% (fabricated)** |
| Idle Rate | `s.idleRate` | `idleRate` | correct |
| Total Hours | `s.totalHours` | `totalHoursThisWeek` | **always 0h (fabricated)** |
| Productive Hrs | `s.productiveHours` | `productiveHoursThisWeek` | **always 0h (fabricated)** |
| Activities | `s.activityCount` | `activityCount` | correct |

Verified against the live DB row (stored keys are `productivityTrend`, `totalHoursThisWeek`, `productiveHoursThisWeek` — the `productivityPct`/`totalHours`/`productiveHours` keys **do not exist**). The card grid is less harmful (the `!== undefined` guard hides missing chips), but the detail dialog's `?? 0` fallback **displays fabricated zeros as real data**. The seed data uses `productivityPct` (a different contract), so seeded environments mask this; production analyze runs expose it.

**Finding G (MEDIUM):** The card-grid chips only ever show "X% idle" — productivity and total-hours chips are silently absent for analyzed (non-seeded) records.

---

## 6. Project ↔ Sentiment Data Relationship

**Answer: there is none.**

- Schema: no `SentimentRecord.projectId`, no join table.
- API: no endpoint accepts a `projectId` for sentiment; `analyze` is org/employee scoped only.
- UI: Sentiment page has no project filter, no project column, no project mention. Projects page has no sentiment mention.
- Therefore any claim that sentiment is shown per-project in this app would be **misleading**; currently the UI makes **no such claim** (the gap is the *missing feature*, not a false one).

---

## 7. API Audit

| Endpoint | Auth | RBAC | Scoping | Validation | Verified live |
|---|---|---|---|---|---|
| `GET /api/sentiment` | proxy JWT | viewer+ | org from JWT | mood/sort enum, page/pageSize ints, search ≤100, deptId ≤64 | 200 admin / 401 anon |
| `GET /api/sentiment/[id]` | proxy + route | viewer+ read | org via employee relation (404 cross-org) | id ≤64 | 200 / 404 garbage |
| `DELETE /api/sentiment/[id]` | proxy + route | **admin+** | org via employee (404 cross-org) | id ≤64 | 403 viewer / 200 admin |
| `POST /api/sentiment/analyze` | proxy + route | **manager+** | org from JWT | body, periodDays, ≤50 ids, 409 concurrency | 403 viewer / 200 manager |
| `GET /api/sentiment/summary` | proxy | viewer+ | org from JWT | none (no params) | 200 |
| `GET /api/projects` | proxy | viewer+ | org from JWT | status/priority/dept/search, page≤200 | 200 |
| `POST /api/projects` | proxy + route | **admin+** | org from JWT | full payload validation, dup 409 | 403 manager |
| `GET /api/projects/[id]` | proxy | viewer+ | org (404 cross-org) | — | 200 |
| `PUT/DELETE /api/projects/[id]` | proxy + route | **admin+** | org (404 cross-org) | enums, dates, dup 409 | (tests cover) |
| `GET/PUT /api/employees/[id]/projects` | proxy | viewer+ read / **admin+** write | org via employee (404) + project (422) | ids ≤100, string-only | 200 admin |
| `GET /api/self/*` | proxy | **manager+** (`ROLE_RULES`) | employeeId resolved within caller's org (`getScopedEmployee`) | required employeeId | 403 viewer/employee / 200 manager |

- **Proxy** (`src/proxy.ts`, Next 16 `proxy` export — valid middleware convention, confirmed `next@16.3.0`): JWT auth, RBAC by prefix (`/api/self` → manager+), CSRF origin check on mutations, central rate limits (`/api/sentiment/analyze` POST limited).
- **PII:** sentiment detail no longer returns email/phone (verified in code); employee detail returns PII only to authenticated org members (per existing employee feature design).
- **API keys:** never returned; `callAIProvider` never logs secrets; safe diagnostic error codes only.

---

## 8. RBAC & Tenant Isolation

Live probe results (minted verified JWTs for admin/manager/viewer/employee/super_admin + foreign-org token):

```
sentiment list (no token)                   -> 401
projects list (no token)                    -> 401
self/dashboard (no token)                   -> 401
self/dashboard viewer                       -> 403   ✓
self/dashboard employee                     -> 403   ✓
self/dashboard manager                      -> 200   ✓
analyze viewer                              -> 403   ✓
projects POST manager                       -> 403   ✓
sentiment DELETE viewer                     -> 403   ✓
sentiment list admin                        -> 200
projects list admin                         -> 200
employee projects admin                     -> 200
employee detail admin                       -> 200
sentiment summary admin                     -> 200
self/dashboard foreign-org token            -> 404   ✓ (concealed)
projects list foreign-org token             -> 200 (empty — org from JWT, no data leak)
sentiment foreign-org token                 -> 200 (empty — org from JWT, no data leak)
self/dashboard garbage employeeId           -> 404   ✓
projects [id] garbage                       -> 404   ✓
sentiment [id] garbage                      -> 404   ✓
projects list super_admin                   -> 200 (global scope, allowGlobal)
```

**No IDOR/BOLA found.** Client-controlled `employeeId`/`projectId`/`id`/`organizationId` are always resolved *within* the verified session's org; foreign-org and garbage ids are concealed (404/empty), never leaking rows. Cross-org sentiment detail concealed as 404 (test MO-17). Manager+ `self` APIs are manager-gated — an employee cannot read their own or anyone's data via `/api/self` (by design: the "My Portal" is an admin tool, not employee self-service).

---

## 9. AI Provider Audit

- Provider plumbing (`src/lib/ai-provider-helper.ts`): 6 providers, **SSRF-safe** transport (`safeFetch`), **encrypted API keys** at rest with auto-upgrade, keys never returned to clients or logged, OpenAI-compat endpoint normalization (no `/v1/v1`).
- Sentiment prompts contain **only** name + computed signals (no raw URLs, no emails, no sensitive PII beyond employee name).
- **Finding H (MEDIUM — AI integration is effectively non-functional in current config):**
  - Live `SystemSetting`: `ai_provider = google`, `ai_base_url = https://generativelanguage.googleapis.com/v1beta/openai` (an **OpenAI-compatible** endpoint), `ai_model = gpt-4o`.
  - `callAIProvider`'s google branch builds `{baseUrl}/v1/models/{model}:generateContent` with `x-goog-api-key` — against an OpenAI-compat base URL this is a mismatched request (404/400), and `gpt-4o` is not a valid Gemini model name.
  - **The only live SentimentRecord is `aiProviderUsed: rules`** — consistent with the AI call failing and the rules fallback (correctly attributed) being used.
  - So the "AI-generated" label can appear only when the provider config is corrected; today the feature is deterministic-rules in production. Attribution is honest; the integration is not proven working with the current config.
- AI usage accounting (`/api/ai-provider/usage`): correctly excludes `rules`/`none` rows.

---

## 10. Consent & Retention

- **Consent:** analyze hard-gates on `hasActiveConsent(employeeId, 'activity_tracking')`; no consent → skipped & counted, no record created. Verified in code + sentiment-fixes tests (consent-skip cases). Live DB: consent granted.
- **Retention:** `retention.ts` purges `SentimentRecord` older than `ai_insight_retention_days` (org-scoped via `organizationId`; 0 = keep forever). Correct org-scoped deleteMany. Tests cover the purge path.
- **Revoked consent:** revoked employee is excluded on the next run; previously queued analysis is server-driven (there is no client queue), so no post-revocation ingestion path exists. New analysis requires the consent to be active at run time.

---

## 11. No-Data Behavior

- Employee with no activity in the window → `score: null`, mood `no-data`, insight "No activity data available…", `aiProviderUsed: 'none'`. **No fabricated score/mood/insight/risk.**
- List stats exclude null-score rows from averages (`scoredCount`, `totalScore`); `noDataCount` surfaced separately; `avgScore` 0 when none scored.
- Summary endpoint excludes null scores from department/org averages and from top-at-risk ranking.
- UI renders `—` / "no data" gauge for null scores; "No Data" mood chip.
- Empty org → empty-state payloads (verified in code paths; both list & summary return structured empty shapes).

---

## 12. UI Truthfulness

- **No `Math.random()`**, no hardcoded sentiment, no fake charts/timestamps/AI messages in `sentiment-page.tsx`, `projects-page.tsx`, or `self-portal-page.tsx` (seed's `Math.random()` is dev-only and `SEED_ALLOWED`-guarded; not in live DB).
- Stats/percentages derive from server-computed values (`avgScore`, `moodDistribution`, `totalAnalyzed`), all org-scoped.
- **Finding F (HIGH, repeat):** detail-dialog Key Signals fabricate `0%`/`0h` via mismatched keys (`?? 0` fallback). This is the one place the UI presents **incorrect values as real data**.
- Loading/empty/error states are implemented everywhere (skeletons, EmptyState, retry).
- My Portal dashboard numbers are server-computed from real activity/device/consent data.

---

## 13. Performance

- **Sentiment list**: loads the **entire org sentiment history** into memory to dedup latest-per-employee, then filters/sorts/paginates in JS (documented tradeoff; indexed by `[employeeId]`, `[organizationId]`, `[employeeId, periodStart]`). At 10k employees × 52 weekly runs ≈ 520k rows fetched per page request — **unbounded in-memory pass**, the largest scaling risk. No N+1 (batched activity queries), 3-worker AI concurrency, bounded per-run writes.
- **Summary**: also loads all org rows; no pagination (dashboard-style endpoint, but currently unused).
- **Projects list**: fetch-all ids + hours groupBy + JS sort + slice; fine to low-thousands of projects; `pageSize` capped at 200.
- **Self dashboard**: 4-5 scoped queries per employee; acceptable.
- Estimate: 10-100 employees fine; 1,000-10,000 employees → sentiment list/summary will degrade (full-history fetch + JS sort per request). No speculative refactor proposed.

---

## 14. Test Results

| Suite | Result |
|---|---|
| `sentiment-fixes.test.ts` (19 tests) | **19/19 PASS** |
| `projects.test.ts` (17 tests) | **17/17 PASS** |
| `multi-org-isolation.test.ts` (22 tests, incl. MO-17 sentiment isolation) | **22/22 PASS** |
| `security.test.ts` (28 tests, incl. PROJECT-13/14) | **28/28 PASS** |

Note: tests initially failed because `scripts/pg-test-db.mjs` (a **tracked file**) had been deleted by the previous session's temp-script cleanup; I **restored it from HEAD** (no source change) and re-ran — all green. Audit probe script was removed after use.

Coverage gaps: no test asserts the **UI signal-key contract** (would have caught Finding F); no test covers "sentiment rendered inside a project"; no live-AI-success integration test.

## 15. Build Results

- Server `tsc --noEmit`: **PASS**
- ESLint (sentiment + projects routes/components): **PASS**
- `prisma validate`: **PASS**
- Next.js build: previously verified green in the last certification; not re-run here (read-only, no changes).

## 16. Security Findings

- **No IDOR/BOLA** found — all id resolution is org-scoped from the verified JWT (live-proven).
- **No API-key/PII/prompt leakage** in sentiment paths.
- CSRF origin check + rate limits + RBAC proxy all live.
- One design observation (not a vulnerability): a **manager** can view **any** employee's portal data and **grant/revoke consents** via My Portal (`/api/self/consents/[id]`). This matches the manager+ gate, but the product's consent UX puts consent control in the manager's hands rather than the employee's.

## 17. Findings Summary

| # | Sev | Finding | Side |
|---|---|---|---|
| A | HIGH | "Employee → My Portal → Projects → Sentiment" journey does not exist; three flat sibling pages; My Portal has no Projects/Sentiment tabs | Admin Panel / Employee Portal |
| B | HIGH | My Portal is a manager proxy-viewer (any-employee), not employee self-service; employee-role users get 403 | Employee Portal / Server |
| C | HIGH | No `projectId` on SentimentRecord; no project↔sentiment relation anywhere | Database / Server |
| F | HIGH | Sentiment detail dialog fabricates 0%/0h (signal-key contract mismatch) | Admin Panel |
| H | MED | AI provider config (google + OpenAI-compat base + gpt-4o) breaks the AI call; live record is rules-only | Server/AI layer |
| E | MED | `/api/sentiment/summary` dead endpoint (no UI consumer) | Server |
| G | MED | Card-grid chips silently omit productivity/total-hours for analyzed records | Admin Panel |
| D | LOW | Projects analytics empty in live org (0 time entries) — truthful but bare | Admin Panel |
| — | LOW | Unbounded in-memory dedup on sentiment list/summary at scale | Server |

## 18. Exact Fix Location

- **Finding A/B:** Employee Portal/Admin Panel — restructure navigation or add tabs: My Portal tab "Projects" (employee's assigned projects) and Projects detail tab "Sentiment"; or Employee Details gets a Sentiment tab. Side: Admin Panel / Employee Portal.
- **Finding C:** Database + Server — requires a schema decision: either add `SentimentRecord.projectId` (nullable) with per-project analysis runs, or honestly label sentiment as employee-level and remove any project claims. Do not build this without a product decision.
- **Finding F/G:** Admin Panel — `src/components/sentiment/sentiment-page.tsx` (detail dialog SignalCards + card chips): read `productivityTrend`, `totalHoursThisWeek`, `productiveHoursThisWeek` (or have the analyze route emit the UI's expected keys and version the stored signals JSON).
- **Finding H:** Server/AI layer — correct the provider config (`ai_base_url`/`ai_model`) in `SystemSetting`, or fix `callAIProvider` google branch to detect OpenAI-compat base URLs.
- **Finding E:** Server — wire summary into a dashboard widget or delete it.

## 19. Recommended Implementation Order (phases only — not implemented)

1. **Phase 1 — Product decision:** project-level sentiment (schema `projectId`) vs. honest employee-level labeling.
2. **Phase 2 — Truthfulness fix:** align sentiment signal keys (F/G) + add a UI-contract test.
3. **Phase 3 — Journey fix:** add Projects+Sentiment surfaces to My Portal / Employee Details / Project detail (A/B).
4. **Phase 4 — AI config:** repair provider endpoint/model so AI path is exercised (H); add an AI-success integration test.
5. **Phase 5 — Hygiene:** wire or remove summary endpoint (E); revisit manager-held consent UX.

## 20. Final Score

- Architecture: **5**/10
- Database: **12**/15
- API: **8**/10
- Projects: **7**/10
- Sentiment: **10**/15
- AI: **5**/10
- Security: **14**/15
- UI: **2**/5
- Performance: **3**/5
- Testing/Build: **5**/5

**TOTAL: 71/100**

## 21. Final Certification

**NOT READY**

Rationale: the audited journey does not exist end-to-end (no path from a project to its sentiment, and My Portal has no Projects/Sentiment content); the sentiment detail UI displays fabricated values; the AI path is not functional under the current configuration. The strong security posture and the solid per-feature backends are what keep this out of "Major Implementation Required" territory, but the feature cannot be certified until the journey, the signal-key contract, and the AI configuration are corrected.
