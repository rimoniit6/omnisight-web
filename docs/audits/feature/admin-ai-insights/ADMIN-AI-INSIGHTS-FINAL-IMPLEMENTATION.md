# Admin → AI Insights — Final Implementation Report

**Verdict: FUNCTIONAL — REAL AI + REAL EMPLOYEE DATA**

The full chain was verified against the real running application, the real
PostgreSQL database, and a real AI provider request:

```
REAL EMPLOYEE DATA (Rimon's real agent activity)
→ REAL SERVER AGGREGATION (org-scoped, consent-gated)
→ REAL AI PROVIDER REQUEST (google/gemini-3.1-flash-lite)
→ REAL STRUCTURED AI RESPONSE (validated: schema + entities + numbers)
→ REAL PERSISTED INSIGHT (with full provenance metadata)
→ REAL ADMIN UI (renders same insight + evidence, survives refresh)
```

---

## 1. Previous behavior

The Admin → AI Insights page was a **deterministic TypeScript rules engine
mislabeled as "AI"**. `GET /api/insights/ai-analysis` computed productivity-gap,
department-comparison, device-fleet, and activity-pattern cards from live DB
queries, and `POST /api/insights` persisted a rules-based "Low Productivity
Alert". **No AI provider was ever called** — there are exactly 5 production
`callAIProvider` call sites in the codebase (daily AI summary, employee
sentiment, project sentiment, 2 screenshot-vision routes) and zero of them were
under `/api/insights*`.

The audit also found:
- The configured provider/model (`google/gemini-1.5-pro`) returned **HTTP 404**.
- `ai_insights_enabled` was a **dead setting** (never read server-side).
- The insight calculations were nevertheless based on real DB data and correctly
  org-scoped (verified exact correlation in the audit).

## 2. Root cause of the provider 404

`gemini-1.5-pro` **no longer exists for the configured API key**. Direct
provider probes proved:
- The API key is valid (models list → 200).
- `gemini-1.5-pro` → **404** (retired model on this account).
- `gemini-3.5-flash` → 200, `gemini-3.1-flash-lite` → 200.

The application code was correct — the stored `ai_model` setting pointed at a
retired model.

## 3. Provider issue and fix

- Root cause: stored `ai_model = gemini-1.5-pro` (retired).
- Fix: updated the stored `ai_model` setting to a verified-working model and
  refreshed `DEFAULT_MODELS.google` + the AI Provider page model list
  (`gemini-3.5-flash`, `gemini-3.1-flash-lite`, …). No API keys were exposed.
- During E2E, the free-tier quota for `gemini-3.5-flash` (20 requests/window)
  was exhausted by repeated test calls; the model was switched to the also-verified
  `gemini-3.1-flash-lite`, which the E2E uses successfully.
- The system handles provider unavailability **truthfully**: a 404/429/5xx/timeout
  is surfaced as an explicit `aiStatus: error` with a specific message, and
  **nothing is persisted** — deterministic content is never labeled AI.

## 4. New architecture

New module `src/lib/ai-insights/`:

| File | Responsibility |
|---|---|
| `dataset.ts` | Bounded, org-scoped aggregation of real data (employees, activity, TimeEntry, projects). Aggregate-only: no raw rows, no secrets. Consent-gated (fail-closed). Deterministic hash. |
| `contract.ts` | Zod `strictObject` output schema + validation: entity references must exist in the dataset; numeric evidence claims must match measured values within tolerance. |
| `prompt.ts` | System prompt (only-supplied-data rules, no invented facts) + user prompt carrying the bounded dataset. |
| `engine.ts` | Orchestrator: build dataset → check `ai_insights_enabled` → call provider (injectable `aiCall` for tests) → validate → return `{ measured, ai, meta }`. Never labels rules as AI. |
| `filters.ts` | Shared server-side filter parsing/validation (period, employee, department, project), org-scoped entity checks, max-90-day cap, org-local day boundaries. |

Routes:
- `GET /api/insights/ai-analysis` — real AI + measured + `meta` (provider, model,
  generatedAt, period, filters, datasetHash) + backward-compatible rule-based
  `data` array (labeled "Rule-based analysis (not AI)" in the UI).
- `POST /api/insights` — AI-backed generate: RBAC (manager+) → filters →
  aggregation → provider → validation → persist with provenance → audit log.

## 5. Data sources

All from the real database, org-scoped, consent-gated:

| Source | Table | Aggregated fields |
|---|---|---|
| Employee | `Employee` | name, designation, department, status |
| Activity | `Activity` | productive/neutral/unproductive seconds, total, activity count, top apps (internal agent rows excluded) |
| TimeEntry | `TimeEntry` | hours per employee+project (manual + auto) |
| Project | `Project` | status, estimatedHours, totalHours, overdue |

No passwords, tokens, API keys, or unnecessary PII are sent to the model.

## 6. AI input contract

The user prompt carries ONLY the bounded aggregate dataset, e.g.:

```
📅 Period: 2026-08-08T18:00:00.000Z → 2026-08-15T17:59:59.999Z
🏢 Organization: Bangladesh computer Council
=== ORG TOTALS (measured) ===
- Tracked time: 15.18h (54661 sec)
- Productivity: 19%
- Activity events: 1356
=== EMPLOYEES ===
Employee: Rimon Rana (id cmssi3spk…)
  Dept: ICT · Role: CEO · Status: active
  Tracked: 54661 sec · Productive: 10343 sec · Neutral: 44318 sec
  Productivity: 19% · Activity events: 1356
=== PROJECTS ===
- ok (id …): status active, logged 1.6h, estimated 200h
```

The system prompt explicitly forbids inventing facts, fabricating percentages/
durations/projects/events, infers missing data as fact, and requires
"evidence.value" to be a bare number copied from the dataset.

## 7. AI output contract

Zod `strictObject` — unknown fields (e.g. a hallucinated `managerName`) fail the
parse. Validation rejects:
- references to unknown `employeeId`/`projectId`,
- numeric claims that match NO measured value within tolerance (percent ±5 pts,
  seconds ±10% rel / 60s floor),
while accepting legitimate formatting (e.g. `"14.79h (53241 sec)"` matches the
53241 run) and legitimate project metrics (estimated/logged hours).

## 8. Security / RBAC

- `POST /api/insights`: `requireManagerOrg` (manager+; viewer → 403,
  unauthenticated → 401) — verified by tests.
- `GET /api/insights/ai-analysis`: `getSessionOrg` (org-scoped), cross-org
  employee/department/project ids concealed as 404.
- All dataset queries are org-scoped; `Activity` filtered via
  `employee.organizationId`; client-supplied `orgId`/`organizationId` can never
  switch the tenant (tests MO-33).
- No API keys/secrets in any response (test AI-19 seeds a fake key and asserts
  it never leaks).
- Audit: `AI_INSIGHT_GENERATED` rows with actor, org, provider, model, period,
  filters, datasetHash, employees analyzed.

## 9. Settings behavior

`ai_insights_enabled` is now **read server-side** by the engine. When disabled:
- no provider call is made (`aiStatus: 'disabled'`),
- nothing is persisted,
- deterministic `measured` statistics remain available,
- the UI shows "AI Insights disabled by administrator."

## 10. Error handling

Provider failures are explicit (`aiStatus: 'error'` + specific copy), and
**nothing is saved**:

| Error | Message |
|---|---|
| not configured / key missing | "No AI provider is configured…" |
| HTTP 404 | "Configured AI model/provider endpoint is unavailable (HTTP 404)…" |
| HTTP 429 | "AI provider rate limit reached. Please try again later." |
| 401/403 | "The AI provider rejected the API key…" |
| 5xx | "The AI provider returned a server error…" |
| timeout/request failure | "AI analysis timed out or could not reach the provider…" |
| malformed JSON / schema / numeric failure | specific validation message |

## 11. Tests

New suite `tests/ai-insights-ai.test.ts` (29 tests) covering AI-01…AI-24 plus
extras:

- AI-01/07/08/09/10: real data → deterministic metrics; date/employee/department/
  project filters change the dataset (hash differs).
- AI-02/03: provider actually called; provider/model metadata returned.
- AI-04/05/06: only supplied employees accepted; unknown employeeId rejected;
  fabricated numeric claim rejected.
- AI-11/12: cross-org isolation; viewer blocked (403).
- AI-13: disabled flag prevents the provider call.
- AI-14/15/16/17/18: 404/429/timeout/malformed JSON/schema-invalid → truthful
  error, nothing persisted.
- AI-19: no API keys leaked.
- AI-20/21: persistence + audit plumbing.
- AI-22: measured metrics stay correct even when AI fails.
- AI-23: deterministic hash.
- AI-24: existing AI features (daily ai-summary) remain functional.
- AI-EXTRA-0/1/1b/2/3: mixed-unit evidence accepted; strict schema; org-local
  default window; invalid dates/cross-org 404/422; manager can GET.

`tests/multi-org-isolation.test.ts` MO-29 updated for the honest contract
(manager+ reaches the AI path; with no provider configured nothing is persisted)
and a timezone regression was fixed (default window now uses org-local days).

**Regression: 190/190 pass** across ai-insights-ai, multi-org-isolation, consent,
sentiment-fixes, hardening, daily-summary-hardening, active-project,
project-time-sync. `npx tsc --noEmit` clean; ESLint clean.

## 12. Real-browser E2E

`scripts/ai-insights-e2e.mjs` — **24/24 checks pass** against the live app
(`http://localhost:3000`), real admin login, real PostgreSQL, real provider:

1. Login as admin ✔
2. Open Admin → AI Insights (sidebar) ✔
3. Select Rimon Rana + last-7-days filter ✔
4. Run Analysis → measured + AI rendered, provider/model badge visible ✔
5. Generate Insight → **POST 201, persisted** ✔
6. Change employee filter → re-renders ✔
7. Change date range (30d) → re-renders ✔
8. Refresh browser → page re-renders, persisted AI insight card survives ✔
9. POST 201 + provider/model metadata + datasetHash/period/measuredSnapshot +
   real employee name in the persisted payload ✔

## 13. Real PostgreSQL evidence

Newest persisted insight:

```
title: Low Productivity Ratio | type: productivity | category: employee
provider/model: google/gemini-3.1-flash-lite
period: 2026-08-08T18:00:00.000Z → 2026-08-15T17:59:59.999Z
filters: { employeeId: cmssi3spk000cfi5k8uzi0i0v }
employeeIds: [cmssi3spk000cfi5k8uzi0i0v]
datasetHash: 27a6886c615c3a6c
keyFindings: 3 | recommendations: 2
audit: "AI insight generated — provider google/gemini-3.1-flash-lite, period …, 1 employee(s) analyzed"
```

## 14. Exact employee-data correlation (Phase 17 proof)

Computed directly from the real Activity table for the persisted period:

```
DB raw:   productive 10343 · neutral 44318 · unproductive 0 · total 54661 · events 1356 · 19%
Persisted measuredSnapshot: 10343 / 54661 / 19% / 1356 events
```

**Byte-for-byte identical.** The AI provider received exactly these numbers
(verified by the AI's own output referencing Rimon Rana and 19% productivity),
and the persisted insight + admin UI show the same figures with an Evidence
section per finding.

## 15. Performance / cost control

- Aggregation is batch/join-based (no N+1; activity aggregated in one query).
- Dataset bounded: max 50 employees, top 5 apps, max 12 findings / 8
  recommendations, max 90-day window.
- No raw Activity rows are sent to the model.
- Deterministic `datasetHash` enables future caching.
- Proxy rate rule: `POST /api/insights` keyed by user (10/min), `GET ai-analysis`
  keyed by IP (10/min).

## 16. Limitations

- **Provider quota**: the free-tier Google quota (20 requests/window per model)
  is shared with all other AI features; heavy usage surfaces truthful 429 errors.
- The rules-based `data` array is retained for backward compatibility and is
  explicitly labeled "Rule-based analysis (not AI)" in the UI.
- Employee-level consent (activity_tracking) gates dataset inclusion
  (fail-closed); employees without consent are skipped and counted in
  `consentSkipped`.
- Insights are generated on demand; no background/scheduled regeneration.

## 17. Files

New:
- `src/lib/ai-insights/dataset.ts`, `contract.ts`, `prompt.ts`, `engine.ts`, `filters.ts`
- `tests/ai-insights-ai.test.ts`
- `scripts/ai-insights-e2e.mjs`

Modified:
- `src/app/api/insights/route.ts` (GET list; POST AI-backed generate + persist + audit)
- `src/app/api/insights/ai-analysis/route.ts` (real AI + measured + meta)
- `src/lib/ai-provider-helper.ts` (`DEFAULT_MODELS.google` refreshed)
- `src/components/ai-provider/ai-provider-page.tsx` (working model list)
- `src/components/insights/insights-page.tsx` (filters, Measured vs AI Analysis,
  Evidence, provider/model/status, disabled/error states)
- `src/components/insights/insight-card.tsx` (provider/model/period metadata)
- `src/proxy.ts` (rate rules)
- `tests/multi-org-isolation.test.ts` (MO-29 honest-contract update)
- `src/lib/ai-insights/filters.ts` (org-local default window fix)

## 18. Final verdict

**FUNCTIONAL — REAL AI + REAL EMPLOYEE DATA**

Verified end-to-end with no mocks, no fake data, no frontend-only statistics:
real Rimon activity → real server aggregation → real Google AI provider request
(`google/gemini-3.1-flash-lite`) → real validated structured response → real
persisted insight with provenance → real admin UI showing the same insight and
evidence, surviving refresh.
