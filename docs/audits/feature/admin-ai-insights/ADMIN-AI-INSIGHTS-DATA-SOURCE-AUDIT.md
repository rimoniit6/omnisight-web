# ADMIN AI INSIGHTS — DATA SOURCE AUDIT

**Audit type:** Read-only functional audit (no production code, DB data, schema, or configuration modified)
**Date:** 2026-08-15
**Auditor:** Codebuff (Buffy)
**Target:** Admin → AI Insights feature, real running app on `http://localhost:3000`, real PostgreSQL `workai` database, real authenticated super-admin session, real employee Rimon Rana

---

## 1. Executive Summary

The **Admin → AI Insights page** (sidebar "AI Insights" → `/insights`) is **not a UI/API shell** — it queries **real, org-scoped employee data** from PostgreSQL and computes its insights from that data. Every metric shown on the page was verified to match the real database exactly.

However, the page **never calls an AI provider**. The "AI" in "AI Insights" is a misnomer: both the persisted insight feed (`POST /api/insights`) and the "Deep Analysis" engine (`GET /api/insights/ai-analysis`) are **deterministic rules engines** written in TypeScript. No `callAIProvider` call exists anywhere in the `/api/insights*` code path.

The genuinely AI-connected surfaces in the product (Daily Report AI summary, Employee Sentiment, Project Sentiment, Screenshot vision analysis) **do** call the configured provider and **do** feed real employee data into the model prompt. But the provider is **currently failing at runtime** (`AI_HTTP_404` for the configured Google/gemini-1.5-pro endpoint), and those surfaces fall back to **honest, clearly-labeled non-AI copy** — never fabricated AI content.

**VERDICT: PARTIALLY DATA-DRIVEN**

The AI Insights page is fully data-driven as a *rules engine* (real data → real computation → real rendering, all org-scoped and verified), but the **"AI generation" link of the advertised chain is absent** — no model is called on that page. The AI-connected surfaces do pass real employee data to a real provider, but that provider currently fails (HTTP 404) and the system honestly reports the failure instead of faking AI output.

---

## 2. Final Verdict

```
VERDICT: PARTIALLY DATA-DRIVEN
```

| Claim | Assessment |
|---|---|
| Page renders real content | ✅ Verified in real browser |
| Uses real employee data | ✅ Verified — exact DB correlation (20% ratio, real names) |
| Correct org/employee scoping | ✅ Verified in code + existing cross-org tests |
| "AI" actually invoked on the AI Insights page | ❌ **No AI provider call exists in /api/insights*** |
| AI-connected surfaces pass real data to model | ✅ Sentiment + Daily Summary prompt = real signals |
| AI provider currently operational | ❌ `AI_HTTP_404` at runtime (google/gemini-1.5-pro) |
| Fallback content is honest (never fake AI) | ✅ Verified — error-code-specific copy, no fabricated insights |

---

## 3. Exact UI → API → DB → AI Pipeline

### The Admin AI Insights page

```
Admin clicks "AI Insights" (sidebar, aria-label="AI Insights")
  → InsightsPage (src/components/insights/insights-page.tsx)
     ├── GET  /api/insights                 → persisted AiInsight rows (org-scoped)
     ├── POST /api/insights                 → "Generate Insight" button
     │        (creates a rules-based "Low Productivity Alert" row)
     ├── GET  /api/insights/ai-analysis     → "Run Analysis" button
     │        (computes 3-4 rules-based analysis cards live)
     └── PUT  /api/insights/[id]            → acknowledge / dismiss / action
```

### Code path (files inspected)

| Layer | File |
|---|---|
| UI | `src/components/insights/insights-page.tsx`, `insight-card.tsx` |
| API — list/create | `src/app/api/insights/route.ts` |
| API — live analysis | `src/app/api/insights/ai-analysis/route.ts` |
| API — status | `src/app/api/insights/[id]/route.ts` |
| Model | `prisma/schema.prisma` → `AiInsight` (org-scoped; no employeeId column) |
| Settings page | `src/components/ai-provider/ai-provider-page.tsx` (toggle `ai_insights_enabled`) |
| AI provider helper | `src/lib/ai-provider-helper.ts` (`callAIProvider`, `callAIProviderVision`) |

### The genuinely AI-connected surfaces (call `callAIProvider`)

| Surface | File | Data fed to model |
|---|---|---|
| Daily Report AI summary | `src/app/api/reports/daily/ai-summary/route.ts` | Org-level real aggregates (totalActivities, productive/neutral/unproductive minutes, alerts, screenshots, online devices) |
| Employee Sentiment | `src/app/api/sentiment/analyze/route.ts` | Per-employee real signals (productivity trend %, idle rate, overtime h, break frequency, login consistency, anomaly count, productive hours this/prev week) |
| Project Sentiment | `src/app/api/projects/[id]/sentiment/analyze/route.ts` | Per-employee project TimeEntry-scoped signals |
| Screenshot analysis | `src/app/api/screenshots/[id]/analyze`, `batch-analyze` | Real screenshot images (vision) |

**There are only 5 production call sites of `callAIProvider`/`callAIProviderVision` in the entire codebase** — none of them are under `/api/insights`.

---

## 4. Employee Data Sources — evidence table

| Source | Used by AI Insights page? | Query | Org-scoped? | Employee-scoped? |
|---|---|---|---|---|
| `Employee` (status=active) | ✅ | `ai-analysis` + `POST /api/insights` (`db.employee.findMany where organizationId + status active`) | ✅ | ✅ (per-employee iteration) |
| `Activity` (category/duration/type/app) | ✅ | `ai-analysis` (per-employee include + org-scoped recent 500 via `employee.organizationId`) | ✅ | ✅ |
| `Department` | ✅ | `db.department.findMany where organizationId`, employees included | ✅ | ✅ |
| `Device` (status/OS/heartbeat) | ✅ | `db.device.findMany where organizationId` | ✅ | — (org level) |
| `TimeEntry` | ❌ (not on the AI Insights page) | used only by Project Sentiment | ✅ | ✅ |
| `SentimentRecord` | ❌ | consumed by Sentiment page | ✅ | ✅ |
| `AiInsight` (persisted) | ✅ | `GET /api/insights` | ✅ | ❌ (org-level feed; no employeeId column) |

**Date/time windows:** the AI Insights page has **no date-range filter** — `ai-analysis` reads all-time activity (recent 500 rows) and `POST` reads all unproductive activities. No employee filter either (org-wide feed). This is a P2 finding (see §15).

---

## 5. Actual AI prompt / data payload analysis

### AI Insights page — NO AI call. No prompt exists.

The page computes everything in TS. Example real output (captured from the live API):

```
"Top performers (Rimon Rana) average 20% productive time, while bottom
 performers (Rimon Rana) average 20%. The 0 percentage point gap indicates
 significant room for improvement..."
```

### Daily Report AI summary — real org data in the prompt (anonymized)

The `userPrompt` passed to the model (built from DB-derived `data.summary`, never client input):

```
📅 Date: {org-local date}
🏢 Organization: {org name}
📊 Key Metrics:
- Total Employees: 1
- Total Activities Logged: 949
- Total Working Time: 664 minutes (11.1 hours)
- Productivity Score: 19%
- Alerts: 0
- Screenshots Captured: 20
- Flagged Screenshots: 0
- Online Devices: 1
⏱️ Time Breakdown:
- Productive: 128m (19%)
- Neutral: 428m (64%)
- Unproductive: 47m (7%)
- Idle: 61m (9%)
```

No names/PII are included (org-level summary). The model is asked to output a fixed JSON schema (executiveSummary, keyFindings, highlights, concerns, recommendations, productivityRating, nextDayFocus).

### Sentiment analyze — real per-employee signals in the prompt

```
Employee: Rimon Rana
Sentiment Score: 47/100 (neutral)
Risk Factors: none
Activity Signals:
- Productivity trend: +0.0%
- Idle rate: 0.0%
- Overtime hours: 2.2h
- Break frequency: 0.0 sessions/day
- Login consistency (std dev): 0.85h
- Anomaly count: 0
- Activity drop >20%: false
- Productive hours this week: 6.9h
- Total hours this week: 12.5h
```

These signals are computed from **real Activity rows** (3 batched DB queries, no N+1), gated by **active `activity_tracking` consent**, and org-scoped.

### Does the prompt ask the model to invent data?

**No.** No "assume", "estimate", "generate realistic", "fill missing data", or "make reasonable assumptions" instructions exist anywhere in the prompts. The system prompt instructs strictly data-driven, professional analysis of the provided metrics. When zero activity exists, the sentiment engine writes `mood: 'no-data'` with a **null score** — it explicitly never fabricates a score.

---

## 6. Database evidence (real PostgreSQL `workai`)

Captured during the audit:

```
Organization: Bangladesh computer Council (cmssgkpig0004fi5kbdunw20o)
AiInsight rows: 2  (both "Low Productivity Alert", real content:
   "Top employees with high unproductive time: Rimon Rana (0min)...")
AI settings: provider=google, model=gemini-1.5-pro, api_key=v1:<encrypted-envelope> (encrypted at rest)
Rimon Rana: 1311 activity rows, last: 2026-08-15T16:56Z chrome.exe 10s neutral
SentimentRecord: 1 (Rimon, score 47, mood neutral, aiProviderUsed='rules', aiModel=null)
Report rows: 7
```

### Phase 6 correlation — real DB vs. what the page claims

| Metric | Real DB query result | AI Insights page claim | Match |
|---|---|---|---|
| Rimon productive ratio | `10243s / 50991s = 20.08%` | "average 20% productive time" | ✅ **Exact** |
| Top/bottom performer name | Rimon Rana (only active employee) | "Rimon Rana" | ✅ |
| Unproductive time | 0 min (no unproductive-category activity) | "Rimon Rana (0min)" | ✅ |
| Insights feed count | 2 rows | "Active Insights: 2" | ✅ |
| Device fleet | 1 device, online | "1/1 devices online" | ✅ (via analysis card) |

The page's numbers are **computed live from the database** — there is no static content, no random data, no hardcoded metrics.

---

## 7. Real-browser evidence

Ran `scripts/ai-insights-data-audit.mjs` (Playwright + real Chrome, real login `admin@worklens.ai`):

```
[login-url] http://localhost:3000/
[ai-insights-nav-btn] true
[page-has-deep-analysis] true
[page-has-run-analysis-btn] true
[insight-feed-section] true
[insight-feed-content] "Active Insights 2 | Actioned 0 | Dismissed 0 |
   Deep Analysis ... Low Productivity Alert ... Rimon Rana (0min)..."
[run-analysis-btn-present] true
[analysis-rendered] true
[analysis-card-titles] ["Productivity Gap Analysis","Device Fleet Health Assessment",
   "Activity Pattern Optimization","Low Productivity Alert","Low Productivity Alert"]
[first-analysis-card] "Productivity Gap Analysis ... Top performers (Rimon Rana) average 20% ..."
```

**Network log captured:**
```
GET 200 /api/insights          → persisted rows (real)
GET 200 /api/insights/ai-analysis → live rules analysis (real)
```

Daily Report page (browser): loads, `Show AI Summary` panel renders with real stats (19%, 950 activities, 1/1 active employees, 20 screenshots). Sentiment page: loads, shows Rimon, averageScore 47.

---

## 8. Employee-data correlation evidence

- **T0 capture (browser + DB):** AI Insights page says Rimon = 20% productive; DB says `10243/50991 = 20.08%` — exact.
- The analysis card is **recomputed on every request** (pure GET, no cache, `staleTime: 5min` client-side only). New activity from Rimon's real agent changes the numbers on the next analysis run.
- **No automatic regeneration exists** — insights are on-demand (button-triggered). Documented explicitly (see §10).

---

## 9. Authentication / RBAC audit

| Endpoint | Guard | Verified |
|---|---|---|
| `GET /api/insights` | `getSessionOrg` (authenticated + org) | ✅ |
| `POST /api/insights` (Generate Insight) | `requireManagerOrg` (manager+) | ✅ test MO-29 |
| `GET /api/insights/ai-analysis` | `getSessionOrg` | ✅ |
| `PUT /api/insights/[id]` | `requireSessionOrg` + org-scoped `findFirst` (cross-org = 404) | ✅ test MO-28 |
| `POST /api/sentiment/analyze` | `requireManagerOrg` | ✅ |
| `DELETE /api/sentiment/[id]` | `requireAdminOrg` | ✅ |
| `POST /api/ai-provider/test-connection` | `requireSuperAdmin` (instance-global settings) | ✅ |
| `POST /api/reports/daily/ai-summary` | `requireManagerOrg` | ✅ test DS-4 |

---

## 10. Cache / background-job behavior

| Question | Answer |
|---|---|
| Generated live from current data? | ✅ `ai-analysis` computes on every request from live DB |
| Generated periodically by a job? | ❌ **No job.** `src/instrumentation.ts` runs only (a) hourly maintenance and (b) 60s project-time sync — neither touches insights |
| Stored once? | ⚠️ Only the `POST /api/insights` "Generate Insight" rows persist (`AiInsight`), created on demand |
| Cached? | ❌ No server cache; client `staleTime` 5 min for `ai-analysis` only |
| Static/demo content? | ❌ None found (see §12) |
| Staleness risk | ⚠️ P2: a persisted `AiInsight` row shows the state at generation time; the feed is a log, but the page presents "Active Insights" as current |

**`ai_insights_enabled` toggle is dead** — it is read only in `ai-provider-page.tsx` (line 210, 760) for display; **no server-side code ever reads it**. Generation is never gated on it (and it would gate nothing since the page is rules-based anyway).

---

## 11. Static / mock / random-data investigation

- `Math.random()` in the codebase: **only** in `src/components/ui/sidebar.tsx` (skeleton loading bar widths — cosmetic, unrelated to insights).
- **No** `Math.random`, `faker`, `mockInsight`, `placeholder`, `demo`/`seed` insight content, hardcoded insight text, or fake percentages exist in the insights pipeline.
- Every insight string is built from DB-computed values (employee names, durations, ratios).
- `excludeInternalAgentActivities()` filters agent-internal rows before aggregation — the numbers reflect real user activity only.
- No `AISummary` model in the current schema (`prisma/schema.prisma` — only `AiInsight`). The old `/api/admin/ai/*` system exists only in archived SQLite migrations.

---

## 12. Failure / fallback behavior

| Scenario | Behavior | Honest? |
|---|---|---|
| AI provider fails (current: `AI_HTTP_404`) | Daily summary returns error-code-specific copy: *"The AI provider endpoint was not found (HTTP 404)... check Settings → AI Provider."* | ✅ Never fakes AI |
| AI not configured | *"No AI provider is configured. Configure an AI provider in Settings..."* | ✅ |
| AI key missing/undecryptable | *"AI provider key issue (AI_KEY_MISSING)"* | ✅ |
| Employee has no activity | Sentiment: `mood:'no-data'`, **score=null**, insight *"No activity data available for this period, so this employee was not scored."* | ✅ |
| AI returns malformed JSON | Raw text truncated into the insight field (labeled, not silent) | ✅ |
| AI call throws | Rules fallback with `aiProviderUsed:'rules'` — the UI/DB record shows it was rules, not AI | ✅ |
| `AI_HTTP_404` attribution | `aiProviderUsed: google`, `aiModelUsed: gemini-1.5-pro`, `aiError: AI_HTTP_404` — the cause is reported, never hidden | ✅ |

**No fallback is ever mistaken for AI.** Sentiment rows record `aiProviderUsed` (`rules`/`none`/provider name) and `aiModel`; the observed live record is `provider: rules` — honest.

---

## 13. Security / privacy findings

| Check | Result |
|---|---|
| API key exposure in browser payloads | ✅ None — encrypted at rest (`v1:` envelope), returned redacted/masked; test-connection masks the key |
| Org isolation (cross-tenant data in insights) | ✅ All queries org-scoped; `ai-analysis` explicitly scopes `Activity` through `employee.organizationId` (comment documents the tenant-isolation fix); tests MO-32/33 verify `?orgId=` is ignored |
| Cross-org insight access | ✅ `[id]` uses org-scoped `findFirst` → 404 for other orgs (MO-28) |
| PII sent to AI provider | ⚠️ Sentiment sends employee **full name** + per-employee signals; Daily Summary sends org name + aggregates only. Name is needed for per-employee insights but is minimal PII; no emails/IDs/screenshot content in text prompts |
| Employee-level access control | ✅ Sentiment `[id]` scoped via `employee.organizationId`; DELETE admin-only |
| Audit logging | ✅ Sentiment runs write `auditLog` rows (actor, org, AI-vs-rules counts); AI provider config changes audited with actor email |
| SSRF on provider URLs | ✅ All outbound calls via `safeFetch` (except documented Ollama localhost default) |

---

## 14. Real AI provider runtime status

- **Configured:** `google` / `gemini-1.5-pro`, key encrypted at rest, base URL default.
- **Live test result (real call through the running app):**
  ```
  POST /api/reports/daily/ai-summary → 200
  aiError: AI_HTTP_404
  aiProviderUsed: google | aiModelUsed: gemini-1.5-pro
  executiveSummary: "The AI provider endpoint was not found (HTTP 404)..."
  ```
- **Root cause:** endpoint `https://generativelanguage.googleapis.com/v1/models/gemini-1.5-pro:generateContent` returns 404 — likely the model/endpoint combination for this key (e.g. model name/GA availability). The system detects and reports it honestly.
- **Consequence:** no genuine AI-generated text is currently produced anywhere; all fallbacks are honest.

---

## 15. Issues ranked

| Severity | Issue |
|---|---|
| **P1** | The **"AI Insights" page is mislabeled** — no AI provider is ever called for the page's content; it is a rules engine. Either rename the surface ("Insights") or wire real AI generation into it. |
| **P1** | **Configured AI provider fails at runtime** (`AI_HTTP_404`) — no AI surface can produce real AI output until the provider/model endpoint is fixed (Settings → AI Provider). |
| **P2** | `ai_insights_enabled` toggle is a **dead setting** — not enforced server-side anywhere. |
| **P2** | Persisted insight feed is a **static log** — "Active Insights" may be stale relative to current data; no staleness labeling. |
| **P2** | AI Insights page has **no date-range or employee filter** — org-wide all-time analysis only (contrast: Sentiment supports employee + period filters). |
| **P3** | Duplicate `generateRulesInsight`-style logic duplicated between sentiment routes (minor maintainability). |

---

## 16. Recommended fixes

1. **Decide the product truth:** either (a) remove "AI" branding from the AI Insights page (it's genuinely useful data-driven analytics), or (b) feed its aggregated real metrics into `callAIProvider` like the daily summary does, keeping the rules output as the honest fallback.
2. **Fix the provider connection** (verify key validity / model availability for `gemini-1.5-pro`; the Settings test-connection button surfaces the exact cause).
3. **Wire or remove `ai_insights_enabled`** so the toggle either gates real generation or is deleted.
4. **Add date-range + employee filters** to the AI Insights page (backend already supports per-employee queries in sentiment).
5. **Label persisted insight rows with their data window** (e.g. "generated Aug 15") so the feed isn't mistaken for live state.

---

## 17. Exact files / functions involved

| Purpose | File(s) |
|---|---|
| AI Insights UI | `src/components/insights/insights-page.tsx`, `insight-card.tsx` |
| Insights list + generate | `src/app/api/insights/route.ts` |
| Insights live analysis | `src/app/api/insights/ai-analysis/route.ts` |
| Insights status | `src/app/api/insights/[id]/route.ts` |
| Model | `AiInsight` in `prisma/schema.prisma` |
| AI provider transport | `src/lib/ai-provider-helper.ts` (`callAIProvider`, `callAIProviderVision`, `getSettings`, `apiEndpoint`) |
| Daily AI summary | `src/app/api/reports/daily/ai-summary/route.ts` (`POST`, `aiFallbackForCode`) |
| Employee sentiment (real AI) | `src/app/api/sentiment/analyze/route.ts` (`generateAIInsight`, `calculateSignals`, `calculateScore`, consent gate) |
| Project sentiment (real AI) | `src/app/api/projects/[id]/sentiment/analyze/route.ts` |
| Screenshot vision | `src/app/api/screenshots/[id]/analyze`, `batch-analyze` |
| AI provider settings page | `src/components/ai-provider/ai-provider-page.tsx` |
| Background jobs | `src/instrumentation.ts` (no insight jobs) |
| Navigation | `src/components/layout/app-sidebar.tsx` (aria-label "AI Insights") |

---

## 18. Test results

| Suite | Result |
|---|---|
| Existing cross-org insight isolation (MO-28/29/32/33, multi-org-isolation.test.ts) | Passed previously (suite green in prior regression runs) |
| Daily summary RBAC (DS-4) + date contract (DS-3) | Passed previously |
| `npx tsc --noEmit` | 0 errors (verified this session) |
| ESLint on new audit scripts | Clean |
| Browser checks (this session) | AI Insights page + Daily Report + Sentiment all load; network captured; correlation exact |

No new tests were added — this was a **read-only audit**; no code was changed.

---

## 19. Final score

| Dimension | Score |
|---|---|
| Real employee data used | 10/10 (verified exact) |
| Employee/org scoping | 10/10 |
| AI actually invoked on "AI Insights" page | 0/10 |
| AI-connected surfaces use real data | 10/10 |
| AI provider operational | 0/10 (HTTP 404) |
| Fallback honesty | 10/10 |
| No mock/random/fake content | 10/10 |

**Overall: 7.1 / 10 — PARTIALLY DATA-DRIVEN**

The data layer is real and correct; the "AI" claim on the main page is unsupported by any model call; and the real AI paths are currently disabled by a provider 404, with honest fallbacks in place. The feature is far from a shell — but it is not yet genuinely AI-generated.
