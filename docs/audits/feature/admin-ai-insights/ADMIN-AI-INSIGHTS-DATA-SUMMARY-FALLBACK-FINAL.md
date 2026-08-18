# ADMIN-AI-INSIGHTS-DATA-SUMMARY-FALLBACK-FINAL

**Status: FUNCTIONAL — BOTH PATHS VERIFIED WITH REAL DATA + REAL PROVIDER**

The Data Summary fallback system is implemented, tested (191 automated tests + real-browser E2E), and verified end-to-end against the real running application, real PostgreSQL data, and a real AI provider.

---

## 1. Architecture

```
                    ┌──────────────────────────────────────────────┐
                    │  canonical measured dataset                  │
                    │  buildInsightDataset() — org-scoped,         │
                    │  consent-gated, filter-aware, bounded,       │
                    │  deterministic hash                          │
                    └─────────────────────┬────────────────────────┘
                                          │ (SAME dataset both paths)
                    ┌─────────────────────▼────────────────────────┐
                    │  engine: runAiInsightsAnalysis()             │
                    │  • empty dataset → honest empty state        │
                    │  • ai_insights_enabled gate                  │
                    │  • provider call (injectable for tests)      │
                    │  • Zod schema + entity + numeric validation  │
                    └──────────┬──────────────────────┬────────────┘
                    AI works   │                      │  AI fails / disabled
                    ┌──────────▼─────────┐   ┌────────▼──────────────────┐
                    │ AI_ANALYSIS        │   │ DATA_SUMMARY             │
                    │ source database+ai │   │ source database          │
                    │ provider/model set │   │ provider/model null      │
                    │ fallbackUsed false │   │ fallbackUsed true        │
                    │                    │   │ fallbackReason = code    │
                    └──────────┬─────────┘   └────────┬──────────────────┘
                               └──────────┬───────────┘
                                          ▼
                    GET /api/insights/ai-analysis  (analysis + measured + meta)
                    POST /api/insights              (persist + audit log)
                                          ▼
                    Admin UI — badge "AI Analysis" vs "Data Summary",
                    Evidence/provenance section, truthful failure copy
```

**Single source of truth:** `buildInsightDataset()` (`src/lib/ai-insights/dataset.ts`) is the one canonical dataset builder. Both the AI prompt AND the deterministic Data Summary consume the exact same `InsightDataset` object — the fallback can never silently query broader data (spec §11 filter consistency).

**No duplicate aggregation:** the Data Summary engine reads only the already-built dataset (`dataset.employees`, `dataset.totals`, `dataset.projects`, `dataset.period`, `dataset.hash`). No new DB queries, no N+1, no added cost to the 60-second sync job (insights are on-demand anyway).

---

## 2. Existing measured dataset (canonical, unchanged behavior)

`buildInsightDataset()` (built in the previous implementation, reused as-is):

- **Org scope:** `db.employee.findMany({ where: { organizationId, status: 'active', ...filters } })`
- **Consent gate:** only employees with an active `activity_tracking` consent are analyzed (fail-closed via `hasActiveConsent`); skipped count tracked in `consentSkipped`
- **Activity:** one batched query over `(employeeId ∈ scoped, timestamp ∈ period)`, internal-agent rows excluded at query time (`NON_INTERNAL_AGENT_ACTIVITY_FILTER`)
- **Top apps:** duration-ordered, capped per employee
- **TimeEntry:** per employee+project hours in period (manual + auto)
- **Projects:** status / estimatedHours / totalHours / overdue
- **Totals:** productive / neutral / unproductive / total seconds, activity count, productivity %
- **Deterministic hash:** SHA-256 over (org, period, filters, per-employee seconds) → 16-hex
- **Bounds:** `MAX_EMPLOYEES = 50`, `MAX_TOP_APPS = 10`, `take: 500` base query — no full-table scans, no raw-row dumps to the model

---

## 3. AI path (unchanged contract, verified live)

1. Engine builds the dataset.
2. Empty-dataset guard → honest empty state, **no provider call**.
3. `ai_insights_enabled` gate → if disabled, **no provider call**, deterministic Data Summary.
4. `callAIProvider(systemPrompt, userPrompt, { maxTokens: 1200, temperature: 0.3 })` — the existing provider abstraction (google/gemini), injectable for tests.
5. Zod strict-object schema (`aiInsightResponseSchema`) — unknown fields rejected.
6. Entity validation — `employeeId`/`projectId` must exist in the dataset.
7. Numeric-claim validation — evidence values must match real measured values within tolerance (see §8).
8. Result: `mode: 'AI_ANALYSIS'`, `source: 'database+ai'`, `aiAvailable: true`, provider/model retained, `fallbackUsed: false`, `fallbackReason: null`.

Verified live: `google / gemini-3.1-flash-lite` returned a validated analysis referencing Rimon's real metrics (15.18h tracked, 19% productive, real employeeId).

---

## 4. Data Summary fallback path (NEW)

`src/lib/ai-insights/data-summary.ts` — `generateDataSummary(dataset, fallbackReason)`:

- Produces `mode: 'DATA_SUMMARY'`, `title: 'Employee Data Summary'`, `source: 'database'`, `aiProvider: null`, `aiModel: null`, `fallbackReason`, `datasetHash` (the canonical dataset hash).
- **Summary**: org-scope sentence + recorded-activity total + category split with productivity %.
- **Findings** (every one carries numeric `evidence` copied from the dataset):
  - Per-employee activity breakdown (productive/neutral/unproductive seconds, productivity %, activity count)
  - Most-used application per employee (facts only)
  - Project hours per employee and per project (logged vs estimate)
  - Lowest recorded productivity rate among dataset employees
- **Evidence rows**: Period, Organization, Employees with data, Activity events, Total/Productive/Neutral/Unproductive time, Productivity %, skipped-no-consent.
- **Empty dataset**: honest `"No employee activity data is available for the selected filters and period."` with **zero findings** — nothing invented.

**Claim policy (spec §4):** only totals, percentages, counts, highest/lowest, rankings, and distribution — all mathematically derivable from the dataset. No personality/motivation/intent/diagnosis language (pinned by test DS-05).

---

## 5. Provider failure handling (NEW: `src/lib/ai-insights/fallback-codes.ts`)

| Internal code | From | meta.aiStatus |
|---|---|---|
| `PROVIDER_DISABLED` | `ai_insights_enabled=false` | `disabled` |
| `PROVIDER_NOT_CONFIGURED` | `AI_PROVIDER_NOT_CONFIGURED` / `AI_KEY_MISSING` / `AI_KEY_DECRYPT_FAILED` | `not_configured` |
| `PROVIDER_AUTH_FAILED` | `AI_HTTP_401` / `AI_HTTP_403` | `error` |
| `PROVIDER_NOT_FOUND` | `AI_HTTP_404` | `error` |
| `PROVIDER_RATE_LIMITED` | `AI_HTTP_429` | `error` |
| `PROVIDER_UNAVAILABLE` | `AI_HTTP_500/502/503` | `error` |
| `PROVIDER_TIMEOUT` | `AI_REQUEST_FAILED` | `error` |
| `PROVIDER_INVALID_RESPONSE` | malformed JSON / schema / entity / numeric validation failure | `error` |
| `PROVIDER_UNKNOWN_ERROR` | anything else | `error` |

Semantics:
- **Config-level failures** (never configured / key missing): `aiAvailable: false`, provider/model `null` — the provider was never attempted.
- **HTTP/transport failures** (404/429/5xx/timeout/validation): the provider WAS configured and the call WAS attempted → `aiAvailable: true` with the **attempted** provider/model retained in `meta` (truthful provenance — the UI shows exactly which model failed). The *persisted insight row* still stores `provider: null, model: null` (never stored as AI output).
- **No secrets**: `meta` carries only `{ code }`-style normalized data — never API keys, raw provider payloads, or credentials.
- **No retry**: the fallback triggers **no further AI request** (pinned by DS-13).

---

## 6. API contract

### GET /api/insights/ai-analysis (updated)

```json
{
  "measured": { "totals": { "productiveSeconds": 10343, "totalSeconds": 54661, "productivityPct": 19, "activityCount": 1356 }, "employees": [...], "projects": [...], "period": {...}, "hash": "..." },
  "analysis": {
    "mode": "AI_ANALYSIS" | "DATA_SUMMARY",
    "title": "...",
    "summary": "...",
    "findings": [...],          // AI findings (severity/description) OR data-summary findings (statement + numeric evidence)
    "evidence": [{ "label": "...", "value": "..." }]   // provenance rows
  },
  "meta": {
    "aiStatus": "generated|disabled|not_configured|error",
    "aiError": null | "human-readable reason",
    "fallbackReason": null | "PROVIDER_*",
    "fallbackUsed": true|false,
    "aiAvailable": true|false,
    "source": "database+ai" | "database",
    "provider": null | "google",
    "model": null | "gemini-3.1-flash-lite",
    "period": { "start": "...", "end": "..." },
    "filters": { "employeeId": ..., "departmentId": ..., "projectId": ... },
    "datasetHash": "...",
    "consentSkipped": 0,
    "truncated": false
  },
  "data": [...], "rules": {...}   // legacy rule-based cards preserved (labeled "not AI" in UI)
}
```

### POST /api/insights (updated)

- **AI works** → persists `mode: AI_ANALYSIS`, `source: database+ai`, provider/model, datasetHash, period, filters; audit `AI_ANALYSIS_GENERATED`; status 201.
- **AI fails/disabled** → generates the Data Summary, **persists it** (product behavior: the summary is valuable and explicitly provenance-marked) with `mode: DATA_SUMMARY`, `source: database`, `provider: null`, `model: null`, `fallbackReason`; audit `DATA_SUMMARY_GENERATED`; status 201.
- **Empty dataset** → `{ data: null, message: "No employee activity data is available..." }`, **nothing persisted**, status 200.
- Persisted `metadata` includes `measuredSnapshot` (totals) so the row can be audited against the DB.

### Audit log (split actions)

- `AI_ANALYSIS_GENERATED` — description includes provider/model, period, employee count; metadata includes mode/source/fallbackReason/provider/model/datasetHash.
- `DATA_SUMMARY_GENERATED` — same shape; the audit log intentionally **retains the attempted provider/model** (forensics) while the persisted insight row does not (never AI-labeled).

---

## 7. Exact DB sources

| Dataset field | Source table | Scope |
|---|---|---|
| employees (name, dept, role, status) | `Employee` (+`Department`) | org + status active + filters |
| activity totals | `Activity` (durations, category) | org employees ∩ period, consent-gated, internal-agent excluded |
| top apps | `Activity.applicationName` | per employee, capped |
| project hours | `TimeEntry` (manual + auto) | org + period, per employee+project |
| project metrics | `Project` (status, estimatedHours, deadline) | referenced projects only |
| consent | `Consent` + `ConsentPolicy` (published, version-bound) | fail-closed gate |

---

## 8. Anti-fabrication controls (contract validation, extended)

`validateAiInsightResponse()` rejects:

- **Unknown entities** — `employeeId`/`projectId` not in the dataset.
- **Fabricated numbers** — every `evidence.value` numeric run must match a real measured value within tolerance. Metric-kind gating: a "%" metric only matches the measured pct; a seconds/duration metric only matches seconds/count values. Mixed-unit claims (`"14.79h (53241 sec)"`) are accepted when **any** run matches. Project metrics match per-project `estimatedHours`/`totalHours` in hours **and** seconds (×3600) — a real value like `5760s` (project "ok" 1.59h logged) is accepted, a made-up value matches nothing and is rejected.
- **Strict schema** — unknown keys (a hallucinated field) fail the Zod strict parse.

The Data Summary engine needs no fabrication checks because it only *copies* dataset numbers — pinned by tests DS-03 (no employee outside the dataset), DS-04 (every numeric claim exists in the dataset), DS-05 (no opinion language), DS-06 (empty → no invented summary).

---

## 9. Settings behavior

- `ai_insights_enabled` is read server-side by the engine on every call. Default **enabled** (matches the UI toggle default).
- Disabled → **no provider call**, Data Summary served, `aiStatus: 'disabled'`, `PROVIDER_DISABLED`, UI shows "AI Insights disabled by administrator — showing a database-backed data summary." The Insights page remains fully useful.

---

## 10. UI (Admin → AI Insights)

- **Badge** in the meta row: `AI Analysis` (emerald, Bot icon) vs `Data Summary` (amber, Database icon) vs `Measured only`.
- **Data Summary mode** additionally shows: `AI provider unavailable (PROVIDER_...) — showing database-backed summary`, and the section header renders `Data Summary — generated directly from employee database data`. **"AI Analysis" is never shown when no AI provider produced the analysis** (pinned in the real-browser E2E: the Deep Analysis section contains no AI label after a forced failure).
- **Evidence/provenance section** under every analysis: Period, Organization, Employees with data, Activity events, Total/Productive/Neutral/Unproductive time, Productivity %, dataset hash, skipped-no-consent.
- **Findings** render with per-finding Evidence blocks (AI metric/value pairs or data-summary numeric records).
- **Insight feed cards**: `Data Summary` badge + expanded "Data Summary Details" (period, evidence rows, fallback reason). Card AI-detection keys on `mode === 'AI_ANALYSIS'` only — a persisted DATA_SUMMARY carrying the attempted provider in its metadata can never render the AI badge.
- **Disabled/error states**: explicit copy; measured statistics remain visible.

---

## 11. Tests

`tests/ai-insights-ai.test.ts` — 43 tests (AI-01…AI-24 + AI-EXTRA-* + DS-01…DS-14):

- **AI path**: AI-01..AI-06 (real dataset metrics, provider called, metadata, entity/numeric validation), AI-07..AI-10 (filters change the dataset), AI-11/12 (org isolation, RBAC), AI-13 (disabled → no provider call + DATA_SUMMARY), AI-14..AI-18 (404/429/timeout/malformed/invalid → DATA_SUMMARY with normalized reasons), AI-19 (no secrets), AI-20 (fallback persistence with provenance), AI-21 (split audit actions), AI-22 (measured correct when AI fails), AI-23 (deterministic hash), AI-24 (sentiment/daily-summary unaffected).
- **Data Summary**: DS-01 (every failure code maps), DS-02 (deterministic content), DS-03 (no out-of-dataset employee), DS-04 (every numeric claim in dataset), DS-05 (no opinion language), DS-06 (empty → honest state, no provider call), DS-07 (employee filter isolation), DS-08 (project filter only), DS-09 (unified GET contract), DS-10 (cross-org blocked), DS-11 (POST empty → nothing persisted), DS-12 (AI success still AI_ANALYSIS), DS-13 (no second AI request on fallback), DS-14 (no `Math.random` in the pipeline).

**Regression (full run): 191/191 pass** across ai-insights, multi-org-isolation, consent, rbac, project-time-sync, ws-invalidation, active-project, website-tracking, employee-sentiment, daily-summary. `npx tsc --noEmit` clean; ESLint clean.

---

## 12. Real-browser E2E (31/31 checks)

`scripts/ai-insights-fallback-e2e.mjs` against the real app + real PostgreSQL + real Google provider:

| Step | Result |
|---|---|
| A–C: admin login, open AI Insights, filter to Rimon | ✔ |
| D–E: Run Analysis with working provider → **AI_ANALYSIS** + provider/model metadata | ✔ |
| F: recorded measured numbers from API | ✔ (10343 prod / 54661 total / 19% / 1356 events) |
| G: forced REAL provider failure (set `ai_model` → nonexistent model → genuine HTTP 404) | ✔ |
| H: Run Analysis again → **DATA SUMMARY** badge, no AI label in Deep Analysis section, "AI provider unavailable" + "database-backed summary" copy | ✔ |
| Contract: `mode=DATA_SUMMARY`, `source=database`, `fallbackUsed=true`, `fallbackReason=PROVIDER_NOT_FOUND`, attempted provider/model retained | ✔ |
| I: displayed numbers vs PostgreSQL — **byte-exact** (productive/total/count/%) | ✔ |
| K: Generate Insight under fallback → persisted DATA_SUMMARY with provider/model null | ✔ |
| L: refresh → persisted Data Summary card survives | ✔ |
| M: employee filter change → dataset re-scopes | ✔ |
| N: restore working model | ✔ |

**Live API probes (real provider):**
- Working provider → `mode: AI_ANALYSIS`, `google/gemini-3.1-flash-lite`, summary references Rimon's real 15.18h / 19%.
- Forced 404 → `DATA_SUMMARY`/`PROVIDER_NOT_FOUND`.
- Disabled → `DATA_SUMMARY`/`PROVIDER_DISABLED`, POST persists `provider: null`.

---

## 13. PostgreSQL verification

Persisted fallback row (real):

```
title: Employee Data Summary
mode: DATA_SUMMARY | source: database | fallbackUsed: true | fallbackReason: PROVIDER_NOT_FOUND
provider: null | model: null                    ← never stored as AI output
period: 2026-08-08T18:00:00Z → 2026-08-15T17:59:59.999Z
datasetHash: 27a6886c615c3a6c
measuredSnapshot: { productiveSeconds: 10343, totalSeconds: 54661, productivityPct: 19, activityCount: 1356 }

audit: DATA_SUMMARY_GENERATED
  desc: Data summary generated — provider unavailable (PROVIDER_NOT_FOUND), period ..., 1 employee(s) analyzed
  metadata: { mode, source, fallbackUsed, fallbackReason, provider: "google", model: "gemini-this-model-does-not-exist-404", ... }
```

The measuredSnapshot matches the raw DB aggregate exactly: `Activity` in the org-local window = 54661s total / 10343s productive / 1356 events → 19%.

---

## 14. Before / after behavior

| | Before | After |
|---|---|---|
| Provider fails | POST `{ data: null }`, nothing persisted — Insights experience dies | Deterministic Data Summary from the same dataset; persisted + audited as `DATA_SUMMARY_GENERATED` |
| AI disabled | `ai_insights_enabled` already gated; page served data summary | Same, now with `PROVIDER_DISABLED` reason + UI disabled banner |
| Empty dataset | honest empty state | Honest empty state, nothing persisted, no provider call |
| Labeling | fallback/measured could be confused with AI | `mode`-keyed badges; card AI-detection keys on mode only |
| Audit | single `AI_INSIGHT_GENERATED` | split `AI_ANALYSIS_GENERATED` vs `DATA_SUMMARY_GENERATED` |

---

## 15. Known limitations

- **Provider free-tier quota**: Google's free tier (≈20 `generateContent`/window) can 429 during bursts. The system handles it truthfully (`PROVIDER_RATE_LIMITED` → Data Summary); the UI shows the real reason and retrying later restores AI mode. No fake AI is ever shown.
- **AI quality variance**: the model occasionally quotes real values in unusual units/labels; the numeric validator was hardened for mixed units, hours↔seconds, and project metrics — but an exotic phrasing may still trigger a truthful rejection (fallback then serves the Data Summary, which is the designed behavior).
- **Deterministic summary scope**: the Data Summary is intentionally conservative (totals/percentages/rankings only) — it does not attempt trend comparisons across periods (not in the dataset contract).

---

## 16. Acceptance criteria — all met

- ✅ AI provider available → genuine AI analysis using real employee DB data (verified: `google/gemini-3.1-flash-lite`, Rimon's real metrics)
- ✅ AI provider unavailable → deterministic Data Summary using real employee DB data (verified: forced HTTP 404 → `PROVIDER_NOT_FOUND`)
- ✅ AI disabled → deterministic Data Summary using real employee DB data (verified live: `PROVIDER_DISABLED`)
- ✅ No provider → no fake AI output (config-level failures: `provider: null`, `mode: DATA_SUMMARY`)
- ✅ No employee data → no invented summary (empty dataset: honest state, zero findings, nothing persisted)
- ✅ Every metric traceable to database-backed data (measuredSnapshot == raw DB aggregate, byte-exact)
- ✅ AI and fallback use the exact same filtered measured dataset (single canonical `buildInsightDataset()`)
- ✅ UI clearly distinguishes AI Analysis from Data Summary (badges, copy, evidence section)
- ✅ Provider failures never destroy the Insights experience
- ✅ No mocks, no random values, no fabricated employee activity (DS-14 pins no `Math.random`; E2E used only real Rimon data)
