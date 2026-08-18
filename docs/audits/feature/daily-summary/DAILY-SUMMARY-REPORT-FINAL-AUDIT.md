# ADMIN PANEL — DAILY SUMMARY REPORT — FULL PRODUCTION-READINESS AUDIT

**Date:** 2026-08-13
**Scope:** Admin Panel → Daily Summary Report (Daily Report page, AI Summary, Generate, Export, Report History)
**Mode:** AUDIT ONLY — no source, schema, seed, settings, or data modified.

---

## Executive Summary

| Question | Answer |
|---|---|
| Is the AI provider actually configured? | **YES** — `systemSetting` has `ai_provider=google`, encrypted `ai_api_key`, `ai_model=gemini-pro`, `ai_insights_enabled=true`. |
| Why does AI Summary claim "unavailable"? | The stored `ai_base_url` is Google's **OpenAI-compatible** endpoint (`https://generativelanguage.googleapis.com/v1beta/openai`), but `callAIProvider`'s `google` branch calls the **native** `generateContent` REST API. `apiEndpoint()` builds `…/v1beta/openai/v1/models/gemini-pro:generateContent` → **HTTP 404 → `AI_HTTP_404`** → generic fallback text. |
| Does Settings use the same provider resolution as the report? | **YES** — both read the same `systemSetting` keys (`ai_provider`, `ai_api_key`, `ai_base_url`, `ai_model`). |
| Why does Settings look "connected"? | The "Connected" badge is **cosmetic** (provider active + key present — no connectivity test), and the test-connection route classifies **400 as "connected"**. So Settings can say Connected while generation 404s. |
| Is report data itself correct? | **YES** — independently re-aggregated from the DB: activities 280 / 4828 min / 56% productive / alerts 10 / screenshots 8 / online 28 — exact match with the API. |
| Fake / mock / hardcoded data? | **NO** — clean sweep; every metric traces to org-scoped persisted rows. |
| Tenant isolation / RBAC? | **PASS** — org from session; viewer → 403, anon → 401, manager → 200 (live). |
| Rate limiting? | **PASS** — daily-report + ai-summary POST: 10/min/user. |
| Production-ready verdict | **CONDITIONAL** — the flagship AI-insights path is broken for the stored config (P1), plus a P1 date-contract bug, two P2 bugs, four P3s. |

**Score: 79/100 → Needs Hardening. Verdict: CONDITIONAL.**
`P0 = 0, P1 = 2, P2 = 2, P3 = 4`

---

## 1. Architecture / Data Flow

```
DailyReportPage (src/components/reports/daily-report.tsx)
 ├─ Generate ───────────► POST /api/reports/daily          ──► org-scoped DB aggregation ──► Report row + audit ──► JSON
 ├─ Show AI Summary ────► POST /api/reports/daily/ai-summary ──► org-scoped aggregation ──► callAIProvider() ──► provider HTTP ──► aiSummary
 ├─ Export ─────────────► client-side text from reportData (no server round-trip)
 └─ Report History ─────► GET /api/reports?type=productivity&pageSize=7 ──► org-scoped Report rows (hasData, no raw payload)

Provider resolution (single source):
systemSetting[ai_provider | ai_api_key(encrypted) | ai_base_url | ai_model]
   └─ src/lib/ai-provider-helper.ts getSettings() → callAIProvider()
      └─ used by BOTH the AI Provider Settings page AND the daily ai-summary route
```

- Settings page (`src/components/ai-provider/ai-provider-page.tsx`) reads/writes the **same** `systemSetting` keys the report path reads — one source of truth, no separate env-vs-DB divergence for the report path.
- `GET /api/settings` is admin+; `PUT /api/settings` and `/api/ai-provider/test-connection` are **super_admin-only** (P1-7). The AI key is encrypted at rest (`encryptSecret`) and redacted (`REDACTED`) in GET responses.

---

## 2. Event Metrics Inventory (Daily Summary)

| Metric | Source | DB Model / Query | Calculated | Real-time | Ready |
|---|---|---|---|---|---|
| Total Employees | server | `employee.count(status=active, org)` | count | on-demand | ✅ |
| Active Employees | server | distinct employees in day's activities | count | on-demand | ✅ |
| Total Activities | server | `activity.findMany(timestamp∈day, org)` | count | on-demand | ✅ |
| Working Minutes | server | sum `duration` per activity | sum | on-demand | ✅ |
| Productivity % | server | productive duration / total | ratio | on-demand | ✅ |
| Breakdown (p/n/u/idle) | server | category × duration sums | sums/ratios | on-demand | ✅ |
| Break Count | server | break-title activities | count | on-demand | ✅ |
| Alerts | server | `alert.count(createdAt∈day, org)` | count | on-demand | ✅ |
| Screenshots | server | `screenshot.count(capturedAt∈day, org)` | count | on-demand | ✅ |
| Online Devices | server | `device.count(status=online, org)` | count | on-demand | ✅ |
| Employee Stats | server | per-employee aggregation, top 20, top 5 apps | aggregation | on-demand | ✅ |
| Break History | server | break activities + employee names | list | on-demand | ✅ |
| AI Summary | provider HTTP | AI call on server-derived snapshot | LLM | on-demand | ❌ 404 |

All report metrics verified correct against an independent DB re-aggregation (see §5).

---

## 3. Source-Level Findings

### DS-P1-1 — AI Summary fails with `AI_HTTP_404` because the stored google base URL is the OpenAI-compatible endpoint, not the native one (PRIMARY)

- **Files:** `src/lib/ai-provider-helper.ts` (`getSettings`, `apiEndpoint`, google branch), `src/app/api/reports/daily/ai-summary/route.ts` (fallback), `src/components/ai-provider/ai-provider-page.tsx` (badge/test), `src/app/api/ai-provider/test-connection/route.ts`.
- **Stored config (live DB):**
  ```
  ai_provider = google
  ai_base_url = https://generativelanguage.googleapis.com/v1beta/openai   ← OpenAI-compat gateway
  ai_model    = gemini-pro
  ai_api_key  = present (encrypted)
  ```
- **What happens:** `callAIProvider`'s google branch calls the **native** Gemini REST API and builds:
  ```
  apiEndpoint('https://generativelanguage.googleapis.com/v1beta/openai', '/v1/models/gemini-pro:generateContent')
  → https://generativelanguage.googleapis.com/v1beta/openai/v1/models/gemini-pro:generateContent
  ```
  Direct fetch probe → **HTTP 404**. The `/v1beta/openai` path is Google's **OpenAI-compatible** surface (expects `chat/completions` + `Authorization: Bearer`), not the native `generateContent` API (expects `x-goog-api-key`). The `google` branch must be pointed at the native root (`https://generativelanguage.googleapis.com`) or empty (default).
- **Live evidence:** `POST /api/reports/daily/ai-summary` → `200 {"aiError":"AI_HTTP_404","aiProviderUsed":"google","aiModelUsed":"gemini-pro"}` and the generic fallback `executiveSummary`; server log `reports.daily.ai_summary.unavailable code=AI_HTTP_404 provider=google`.
- **Why Settings shows Connected:**
  1. `getProviderStatus()` returns `'connected'` whenever `providerId === activeProvider && apiKey` — a **key-presence check, not a connectivity check**.
  2. `test-connection/route.ts` classifies `400` as `'connected'` (`"Connection successful (endpoint reachable)"`). A probe of `…/v1beta/openai/models` returned **400** → the route would report success for this exact broken config.
- **Production impact:** the headline "AI-powered insights" feature is completely non-functional for the stored configuration, while the UI asserts the provider is Connected.
- **Recommended fix (NOT applied):**
  - Correct the stored config: `ai_base_url = ''` (native default) with `ai_provider=google`, **or** switch to `ai_provider=custom` with the `/v1beta/openai` base (OpenAI-compat chat path).
  - Harden `validateProviderConfig`: for `google`, reject base URLs whose path is not the native root (currently only the **host** is checked, so `/v1beta/openai` passes).
  - Make the Settings badge reflect a real connection state, and stop classifying 400 as success.
  - Differentiate the fallback message per error code instead of always saying "Configure an AI provider in Settings" (the `aiError` field is already returned and surfaced in `keyFindings`, but the headline is generic).

### DS-P1-2 — AI Summary ignores the selected report date (always analyzes today)

- **Files:** `src/components/reports/daily-report.tsx` (AiSummaryPanel posts `{ reportData }`), `src/app/api/reports/daily/ai-summary/route.ts` (reads `body.date`).
- **Root cause:** the client sends `{ reportData }` only; the route reads `const { date } = body` → `undefined` → defaults to `new Date()` (today). `reportData` is deliberately ignored server-side (SECURITY: never trust client metrics) — but the client never sends the `date` field either.
- **Live evidence:** `POST` with `{ reportData: { date: '2026-07-01', ... } }` → server used **today** (`ai.date: 2026-08-12`). So "Show AI Summary" on Yesterday / 2-days-ago reports produces a summary of **today's** data once the 404 is fixed.
- **Production impact:** silently wrong analysis for any non-today report date.
- **Recommended fix:** client should send `{ date: reportData.date }` (or the selected date) in the mutation body.

### DS-P2-1 — Date label off-by-one for UTC+ timezones

- **Files:** `/api/reports/daily/route.ts` and `/api/reports/daily/ai-summary/route.ts` — `targetDate.setHours(0,0,0,0)` (local midnight) then `targetDate.toISOString().split('T')[0]` for the `date` label; client displays `reportData.date`.
- **Root cause:** server TZ is `Asia/Dhaka` (UTC+6). Local midnight `2026-07-01 00:00 Dhaka` = `2026-06-30T18:00Z` → label becomes `2026-06-30`.
- **Live evidence:** requested `2026-07-01` → `ai.date: 2026-06-30`. Stored report payload: `payload.date: 2026-08-12` while the report title says "Thursday, August 13, 2026". The query **window** is correct (local-midnight gte/lt) — only the displayed label is wrong.
- **Impact:** the UI badge shows the previous day for UTC+ zones. Cosmetic-to-moderate (client also formats the title locally, so the mismatch is visible).

### DS-P2-2 — Report History never refreshes after generating

- **Files:** `src/components/reports/daily-report.tsx` — history query `queryKey: ['report-history']` (line 497); after generation the client invalidates `queryClient.invalidateQueries({ queryKey: ['reports'] })` (line 514).
- **Root cause:** key mismatch — `['reports']` ≠ `['report-history']`. The history list stays stale until the page remounts.
- **Impact:** after clicking Generate, Report History does not show the new report (requires reload/navigation).

### DS-P3-1 — Settings "Connected" badge is cosmetic (key presence only)

- `getProviderStatus()` → `'connected'` when `providerId === activeProvider && apiKey`. No actual connectivity check. Misleads admins (contributes to DS-P1-1).

### DS-P3-2 — test-connection classifies HTTP 400 as "connected"

- `test-connection/route.ts`: `if (response.ok || status === 400 || status === 401)` → 400 becomes `'connected'` ("endpoint reachable"). A 400 can mean "endpoint exists but request malformed/wrong protocol" — exactly the broken google + `/v1beta/openai` combination.

### DS-P3-3 — `validateProviderConfig` only checks the host for google

- `google` config validation compares `new URL(baseUrl).hostname` to the Google host; the path is ignored, so `…/v1beta/openai` passes. Should also reject non-native paths for `google`.

### DS-P3-4 — Generic AI-unavailable fallback wording

- The fallback `executiveSummary` is always "AI summary generation is currently unavailable. Configure an AI provider in Settings…" regardless of the real cause. The precise code (`AI_HTTP_404`) IS returned in `aiError` and rendered inside `keyFindings`, so it's recoverable, but the headline is misleading when a provider IS configured.

---

## 4. Database Verification

| Check | Result |
|---|---|
| `systemSetting` AI keys present | `ai_provider`, `ai_api_key` (encrypted), `ai_base_url`, `ai_model` all present |
| Report row created on Generate | ✅ (title + `data` payload + `periodStart/periodEnd`, org-scoped) |
| Audit log on Generate | ✅ (`action=create, resource=report`, actor = session user, org set) |
| Report History API | ✅ org-scoped `GET /api/reports`, validated pagination, exposes `hasData` only (no raw payload / `filePath` — S-4) |
| Seed reports exist | ✅ (18 report rows, created via seed + prior legitimate use) |
| Probe residue after cleanup | **0 rows** (2 probe reports + 2 probe audit rows removed; pre-existing data untouched) |

---

## 5. Aggregation Accuracy (independent re-check)

| Metric | DB (independent) | API | Match |
|---|---|---|---|
| Activities | 280 | 280 | ✅ |
| Working minutes | 4,828 | 4,828 | ✅ |
| Productivity % | 56 | 56 | ✅ |
| Alerts | 10 | 10 | ✅ |
| Screenshots | 8 | 8 | ✅ |
| Online devices | 28 | 28 | ✅ |

No N+1; per-day window is bounded (`findMany` over one day's activities, ≤ a few thousand rows at this scale).

---

## 6. Authentication / Authorization / Tenant Isolation (live)

| Probe | Result |
|---|---|
| anon → POST /api/reports/daily | **401** |
| anon → POST /api/reports/daily/ai-summary | **401** |
| viewer → POST /api/reports/daily | **403** |
| viewer → POST /api/reports/daily/ai-summary | **403** |
| manager → both | **200** |
| Page min role | `navigation.ts`: `reports: 'manager'`, `daily-report: 'manager'` |
| Org scope | session-derived (`getSessionOrg` → `requireManagerOrg`); client cannot inject `organizationId` (ignored; org always from session) |
| Cross-org report history | not testable with a single seeded org, but the `GET` where-clause is hard-scoped `{ organizationId: org.id }` and the daily aggregation is scoped via `employee.organizationId` |

---

## 7. Rate Limiting / Timeout / Error Handling

- **Rate limits** (`src/proxy.ts`): `POST /api/reports/daily` → 10/min/user; `POST /api/reports/daily/ai-summary` → 10/min/user; `GET /api/reports` → exportPdf budget keyed by IP; `/api/reports/generate` → aiWrite budget. ✅
- **Timeouts:** provider calls go through `safeFetch` (30 s); test-connection 10 s. ✅
- **Error handling:** the ai-summary route never throws on provider failure — it returns `success:true` with the fallback `aiSummary` + `aiError` code (documented design: operator-visible `log.warn` with safe code, no secrets). ✅ truthfulness of *mechanism*; wording of the fallback is DS-P3-4.
- **No fabricated data on failure:** the fallback is a clearly-labeled error summary; the report snapshot in the response is real DB data. ✅

---

## 8. Loading / Empty / Error States

- **Loading:** skeletons for initial report; "Analyzing workforce data…" spinner for AI. ✅
- **Empty:** truthful empty states ("Select a date and click Generate"). ✅
- **Error:** Generate failure → toast; AI failure → fallback panel with the real error code in Key Findings (not silent, not fabricated). ✅ (wording: DS-P3-4)

---

## 9. Export Consistency

- Export is a **client-side text/plain** download built directly from `reportData` (the same object rendered) — UI count == API count == DB count by construction. No server export endpoint for daily reports (a `/api/reports/pdf` route exists in proxy rules but is not wired to this page). Consistent, but a text-file export rather than the PDF the Reports page implies elsewhere — noted as a minor P3 (not in scope to change).

---

## 10. Security / Data Exposure

- `/api/reports` GET returns report **metadata + hasData** only — never the raw JSON payload or `filePath` (S-4). ✅
- AI route ignores client `reportData` (client metrics can never poison the prompt) — server recomputes everything. ✅
- No tokens/passwords/keys in any report response; API key encrypted at rest and never returned (REDACTED). ✅
- Audit log present for generation. ✅

---

## 11. Truthfulness Assessment

| Question | Answer |
|---|---|
| Does Event/report data represent REAL data? | **YES** — all metrics independently verified from the DB |
| Can the UI display fabricated data when the AI fails? | **NO** — real report snapshot + clearly-labeled fallback error |
| Can one organization see another's reports? | **NO** — org hard-scoped in every query |
| Is "Connected" in Settings accurate? | **NO** — cosmetic badge + 400-as-connected classification (DS-P3-1/2) |
| Does the AI summary work for the stored config? | **NO** — `AI_HTTP_404` (DS-P1-1) |
| Does the AI summary respect the selected date? | **NO** — always today (DS-P1-2) |

---

## 12. Findings Summary

| ID | Severity | File(s) | Root cause | Status |
|---|---|---|---|---|
| DS-P1-1 | P1 | `ai-provider-helper.ts`, `test-connection/route.ts`, `ai-provider-page.tsx`, `ai-summary/route.ts` | google provider + OpenAI-compat base URL → native URL 404; Settings badge/test mislead | OPEN |
| DS-P1-2 | P1 | `daily-report.tsx`, `ai-summary/route.ts` | client sends `reportData`, server reads `body.date` → always today | OPEN |
| DS-P2-1 | P2 | `reports/daily/route.ts`, `ai-summary/route.ts` | local-midnight → UTC ISO label off-by-one (UTC+ zones) | OPEN |
| DS-P2-2 | P2 | `daily-report.tsx` | invalidate `['reports']` vs query key `['report-history']` | OPEN |
| DS-P3-1 | P3 | `ai-provider-page.tsx` | Connected badge = key presence only | OPEN |
| DS-P3-2 | P3 | `test-connection/route.ts` | 400 classified as connected | OPEN |
| DS-P3-3 | P3 | `ai-provider-helper.ts` | google validation checks host only | OPEN |
| DS-P3-4 | P3 | `ai-summary/route.ts` | generic fallback wording for every error code | OPEN |

---

## 13. Evidence

- `systemSetting` dump (22 rows; AI keys listed in §3).
- `POST /api/reports/daily` (manager) → 200 with full verified summary.
- `POST /api/reports/daily/ai-summary` → `aiError: AI_HTTP_404`, provider google, model gemini-pro.
- Constructed-URL probe `…/v1beta/openai/v1/models/gemini-pro:generateContent` → **404**; correct native URL shown.
- test-connection-style probe `…/v1beta/openai/models` → **400** (classified as connected by the route).
- Explicit `date: '2026-07-01'` → response `ai.date: 2026-06-30` (TZ off-by-one); client-style payload `{reportData}` → server used today (date-contract bug).
- Independent DB re-aggregation matched the API exactly (6/6 metrics).
- RBAC probes: anon 401, viewer 403, manager 200 on both routes.
- Server log: `reports.daily.ai_summary.unavailable code=AI_HTTP_404`.
- Report history: 7 rows (pageSize=7), org-scoped, `hasData` only.
- Cleanup: 2 probe reports + 2 audit rows deleted; 0 probe rows remain; 0 temp scripts remain.

---

## 14. Production Readiness Score

| Category | Max | Score | Notes |
|---|---|---|---|
| Functionality | 25 | 14 | Generate/Export/History work; AI summary broken (P1) + wrong date (P1) + stale history (P2) |
| Data correctness | 20 | 17 | Core metrics verified exact; date label off-by-one (P2) |
| Security / tenant isolation | 20 | 20 | Session-derived org, RBAC enforced, S-4 payload protection, audited |
| Real-time behavior | 15 | 13 | On-demand feature (not real-time); AI path broken |
| Performance | 10 | 9 | Bounded day-window queries, no N+1; raw payload fetched only internally for `hasData` |
| Error handling / truthfulness | 10 | 6 | Honest error mechanics but misleading "Connected" badge, 400-as-connected, generic wording |
| **Total** | **100** | **79** | **Needs Hardening / CONDITIONAL** |

> Any P0/P1 overrides the numeric score — two P1s present → **CONDITIONAL** (not production-ready for the AI-summary path).

---

## 15. Final Verdict

**CONDITIONAL — 79/100 (P0=0, P1=2, P2=2, P3=4).**

The report **data pipeline is real, correct, org-isolated, and RBAC-protected** — every non-AI metric was independently verified against the database. The two P1s are confined to the **AI executive-summary path and its configuration surface**:

1. The stored Google config points at the OpenAI-compatible endpoint while the google branch calls the native API → `AI_HTTP_404`; the Settings UI simultaneously claims "Connected".
2. The AI summary silently analyzes **today** regardless of the selected report date (client never sends `date`).

Both are frontend/config-surface defects with clear, small fixes (send `{ date }`; correct `ai_base_url` to the native root or switch provider to `custom`), plus optional hardening (validate google base-URL paths, honest Connected badge, 400 classification, per-code fallback text, TZ-safe date label, history key fix). No backend data-integrity or tenant-isolation issue exists.

**Cleanup verified:** 0 probe rows · 0 probe files · 0 temporary scripts · pre-existing seed/production data untouched · nothing committed.
