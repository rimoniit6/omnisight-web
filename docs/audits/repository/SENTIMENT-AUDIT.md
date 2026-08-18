# WorkLensAI — Sentiment Analysis Production Readiness Audit

**Date:** 2026-08-12
**Scope:** Admin Panel → Sentiment Analysis feature
**Method:** Audit-only. No source code modified. Findings verified against the running local application (Next.js on `localhost:3000`, PostgreSQL `workai` on 5432) via live HTTP tests, direct DB queries, and code tracing. Two runtime side effects of testing are disclosed in §17; DB state was restored.

---

## 1. Executive Summary

**Status: NOT PRODUCTION READY** — **Overall Score: 40/100**

The Sentiment Analysis feature has a genuinely real backend: a deterministic rules-based scoring pipeline over real activity data, a real (BYOK, encrypted) AI provider integration for insight text, real persistence in `SentimentRecord`, tenant-scoped APIs with JWT auth, and working cross-organization isolation. **However, the feature's primary user action — "Run Analysis" — is broken from the UI today: the exact request the button sends returns HTTP 500 on every click, and the UI then shows a success toast for the failed request.** The page also truncates results at 10 records with no pagination while computing stats over all records, exposes PII via the detail API to any role, accepts garbage query input that crashes endpoints with 500s, has no retention policy for sentiment data, and mislabels the feature as "AI-powered" when the score itself never touches an AI model. The polished UI cannot be shipped as-is; it is a polished shell over a solid but incomplete backend.

---

## 2. Implementation Discovery

| File | Purpose | Status |
|---|---|---|
| `src/components/sentiment/sentiment-page.tsx` (925 lines) | Entire Sentiment UI: stats bar, mood distribution bar, filter toolbar, employee card grid, detail dialog, Run Analysis button | Functional, but broken analyze call + truncation bugs |
| `src/app/api/sentiment/route.ts` | GET list + stats + departments | Works; validation bugs (500s); unbounded stats query |
| `src/app/api/sentiment/[id]/route.ts` | GET detail / DELETE | Works; detail leaks PII (email/phone); delete admin-gated |
| `src/app/api/sentiment/analyze/route.ts` | POST: scoring + AI pipeline + atomic replace | Works with JSON body; **crashes 500 on the UI's bodyless call**; no input validation; no role gate |
| `src/app/api/sentiment/summary/route.ts` | GET summary (avg, dept breakdown, top at-risk/positive) | Works; **completely unused by any UI** |
| `prisma/schema.prisma:782-806` | `SentimentRecord` model | Persists; no retention integration |
| `src/lib/ai-provider-helper.ts` | `callAIProvider` — 6 providers, SSRF-guarded, encrypted key | Works (verified live via OpenRouter/gpt-4o) |
| `src/lib/api.ts:135-211` | `getSessionOrg`, `requireSessionOrg`, `requireAdminOrg`, `authError` | Sound JWT-based org scoping |
| `src/proxy.ts` | Global middleware: auth, RBAC, rate limits | Works; `/api/sentiment` has **no role rule** (viewer can hit all endpoints) |
| `src/lib/auth.ts` | JWT sign/verify (HS256), role hierarchy | Sound |
| `src/lib/navigation.ts:39` | `sentiment: 'viewer'` — nav gating | Feature exposed to viewer role by design |
| `src/lib/seed.ts:1261-1340` | Demo seed incl. **`Math.random()`** sentiment scores | Dev-only, guarded (`SEED_ALLOWED`); not present in live DB |
| `src/lib/jobs/retention.ts` | Retention job | **SentimentRecord not included** — no purge ever |
| `src/lib/jobs/cli.ts`, `run.ts` | Scheduled jobs | No sentiment job exists (analysis is manual-only) |
| `src/app/api/ai-provider/usage/route.ts` | AI usage stats (counts SentimentRecord) | Counts non-AI `rules` records as "AI usage" |
| `tests/multi-org-isolation.test.ts` (MO-17) | Cross-org isolation tests (summary + detail) | Exists; no tests for analyze/validation/UI |
| `src/lib/rate-limit.ts` | In-memory sliding-window limiter | Works (429 verified) |

Dependency map:

```
SentimentPage (client)
 ├─ GET  /api/sentiment        → requireSessionOrg → SentimentRecord + Employee + Department → UI (list, stats, mood bar)
 ├─ GET  /api/sentiment/{id}   → requireSessionOrg → SentimentRecord (+Employee PII) → detail dialog
 ├─ POST /api/sentiment/analyze → getSessionOrg → Activity ×2 batches + Anomaly groupBy
 │                                → calculateSignals → calculateScore → determineMood → riskFactors
 │                                → callAIProvider (OpenRouter gpt-4o) per employee (parallel)
 │                                → transaction: deleteMany(period) + create → SentimentRecord
 └─ /api/sentiment/summary     → ❌ UNUSED by UI (dead endpoint, only tested by MO-17)
```

---

## 3. Architecture Flow

```
UI (sentiment-page.tsx)
 → React Query (['sentiment'] / ['sentiment-detail', id] / analyze mutation)   [real]
 → fetch('/api/sentiment*')                                                    [real]
 → proxy.ts middleware: JWT auth ✓ / RBAC (no rule → any role) ▲ / rate limit ✓ / CSRF check ✓
 → route handlers (requireSessionOrg — org from JWT only)                      [real, tenant-safe]
 → Prisma → PostgreSQL: Activity, Anomaly, Employee, SentimentRecord            [real, verified live]
 → AI: callAIProvider → SSRF-safe → OpenRouter (gpt-4o)                        [real, verified live]
 → storage: SentimentRecord (score, mood, signals JSON, insight, provider)     [real]
 → back to UI cards/dialog                                                     [real]
```

Broken/missing links:
- **UI → analyze: CRITICAL breakage** (bodyless POST → 500).
- **Summary endpoint → UI: disconnected** (no consumer).
- **Score ← AI: disconnected** (score is rules-based only; AI writes commentary text only).

---

## 4. Feature-by-Feature Audit

| Feature | Status | Evidence | Severity |
|---|---|---|---|
| Run Analysis button | **BROKEN** — 500 every click; UI shows success toast | Live test: bodyless POST → 500; `sentiment-page.tsx:338`, `analyze/route.ts:297`; toast bug `:339-345` | **CRITICAL** |
| Stats bar (Avg/Positive/At-Risk/Burnout/Analyzed) | Real, but counts ALL records incl. duplicates across runs | `route.ts:81-112`; duplicate accumulation `analyze/route.ts:432-438` | HIGH |
| Mood Distribution bar | Real; percentages from DB counts | Live-verified; `route.ts:136-139` | OK (PASS) |
| Employee cards | Real; from DB | Live-verified | OK |
| Filters (mood/dept/search/sort) | **Client-side on first 10 records only** — silently wrong at >10 employees; `pageSize=10` default | `sentiment-page.tsx:349-385` vs `route.ts:27` | HIGH |
| Pagination | **Missing from UI entirely** (API supports it) | `sentiment-page.tsx` has no pagination controls | HIGH |
| Date range filter | **Not present in UI** (`periodDays` exists in API, never sent) | `sentiment-page.tsx:338` | LOW |
| View Details dialog | Real; score gauge, signals, risks, AI insight, recommendation | Live-verified | OK |
| AI Insight / Recommendation | Real AI text (fallback to deterministic rules on AI failure — not fabricated) | Live-verified (`custom`/`gpt-4o` stored) | OK |
| Empty state | Real, accurate | Live-verified | OK |
| Loading state | Skeletons | Code-verified | OK |
| Error state (load) | Retry works | Code-verified | OK |
| Error state (analyze) | **False success toast on failure** | `:339-345` | HIGH |
| Responsive layout | Tailwind responsive classes | Code-verified | OK |

---

## 5. UI Audit

- **No hardcoded/mock/fake data in the page.** Every displayed value traces to `/api/sentiment` responses (live-verified against DB). No `Math.random()` in the UI; seed's `Math.random()` (src/lib/seed.ts:1289,1293-1299) is dev-seed only and **not present in the live DB (0 sentiment rows at audit start)**.
- Charts are simple div bars computed from real counts (`:553-573`).
- **Broken analyze UX:** (a) the request 500s (`fetch` does not throw on 5xx), (b) `mutationFn` ignores `r.ok` and decodes the error body, (c) `onSuccess` fires for the error response → toast `"Analysis complete for all employees"` (`res.count ?? res.analyzed` → `undefined` → `'all'`). The UI **asserts success on failure** — the most dangerous kind of error handling for a monitoring product.
- **Truncation:** only page 1 (10 records) is fetched; the grid shows ≤10 employees while the "Analyzed" stat says N total. Filters/search/sort run in the browser over those ≤10 — at 11+ employees, a dept or mood filter returns a wrong (empty) set, and direct search for employee #11 finds nothing.
- Detail dialog reads `detail.aiProviderUsed` but not `aiModel`; it displays `email`/`phone` nowhere — but the API returns them (§12).
- Empty/loading/retry states are otherwise handled well; `parseRiskFactors` is defensively robust.

---

## 6. API Audit

| Endpoint | Method | Auth | Backend gate | Validation | Findings |
|---|---|---|---|---|---|
| `/api/sentiment` | GET | JWT (cookie/Bearer) | `requireSessionOrg` (any role) | **None** | `page=-1` → **500**; `page=abc` → **500**; `pageSize=abc` → **500**; `pageSize=999999` → 200 unbounded (all live-tested). Stats query loads ALL org records with an employee join on every load (`route.ts:81-88`). |
| `/api/sentiment/[id]` | GET | JWT | `requireSessionOrg` (any role) | id unchecked | Invalid id → 404 ✓; valid → 200 incl. employee `email` + `phone` (PII exposure, `[id]/route.ts:29-30`). |
| `/api/sentiment/[id]` | DELETE | JWT | `requireAdminOrg` ✓ | id unchecked | Works (live: 200 → 404). No UI consumer. |
| `/api/sentiment/analyze` | POST | JWT | `getSessionOrg` only — **no role check; any viewer can trigger org-wide AI spend** | **None** | Bodyless → **500** (the UI's exact call). `periodDays=abc` → **500** (NaN date). `employeeIds` unvalidated strings — abuse of unbounded list → thousands of parallel AI calls. `periodDays` unbounded (99999 → scans years of activity). |
| `/api/sentiment/summary` | GET | JWT | `requireSessionOrg` | n/a | Works; **no UI consumer**; unbounded `findMany` of all records (`summary/route.ts:25-41`). |
| Rate limiting | | | `proxy.ts:51` — analyze POST 10/min/IP ✓ (429 verified live) | | GET endpoints unthrottled (auth-scoped, acceptable). |
| Caching | – | | None (settings flag `ai_response_caching=true` unused by helper) | | Repeated analyses pay full AI cost every time. |

Error responses never leak internals (generic messages; keys never echoed) ✓.

---

## 7. Authentication & Authorization Audit

- **Authenticated** end-to-end: proxy verifies HS256 JWT (signature + exp + iat-skew, `auth.ts:166-196`); routes re-verify org from JWT only — never from client input (`api.ts:135-143`). Header-based auth: Bearer token is itself a verified JWT — no bypass found.
- **Tenant isolation: verified.** Detail conceals cross-org rows as 404 (`[id]/route.ts:21-22`); list/summary scope by `employee.organizationId` from session; analyze scopes employee selection by `org.id` (`analyze/route.ts:312-317`). The `employeeIds` filter is **intersected with the session org** (live-tested: `["../etc/passwd"]` → empty result, no leak). MO-17 test additionally covers cross-org detail 404.
- **Role checks:**
  - DELETE → admin ✓ (`requireAdminOrg`).
  - GET list/detail/summary → any authenticated org user — **viewer included** (`navigation.ts:39` declares the page viewer-visible by design; `proxy.ts` has no `/api/sentiment` role rule). Deliberate product decision, but combined with the PII in the detail payload (§12) it exceeds least privilege.
  - **POST analyze → no role gate.** A `viewer` (or any compromised low-privilege account) can run org-wide analysis, paying for AI calls from the shared key and overwriting sentiment history. **Authorization gap — HIGH.**
- No IDOR found (all id lookups tenant-scoped, 404-concealed).
- UI nav filtering is UX-only; backend enforces independently ✓ (defense-in-depth in place for other surfaces).

---

## 8. Database Audit

- `SentimentRecord` (schema.prisma:782-806): stores `score`, `mood`, `signals` (JSON string), `insight`, `riskFactors` (JSON string), `recommendation`, `periodStart/End`, `aiProviderUsed`, `aiModel`, `organizationId`, timestamps. Indexed on `[organizationId]`, `[employeeId]`, `[employeeId, periodStart]`. FK cascade on employee/org delete ✓.
- Fields are untyped strings (no `CHECK` on mood) — a malformed write could store arbitrary mood; UI handles it defensively.
- **History-preserving? Yes for older periods.** The analyze "replace" only deletes `periodStart >= dayStart` of the current run (`analyze/route.ts:432-438`). Consecutive daily runs create **duplicate records per employee across periods** (run on day X deletes only records from day X's window start; day X−1's records survive). Result: stats/list double-count employees over time; "Analyzed: N – Total employees" becomes wrong. The `summary` route correctly dedups (latest per employee, `summary/route.ts:71-77`) but the **main list/stats endpoint does not**.
- **Queries:** list query + count are paginated ✓; but stats run an **unbounded** `findMany` of every org record with a join on every page load (`route.ts:81-88`); summary is unbounded too. No `SELECT *` issues (explicit selects), no N+1 loops in the analyze path (3 batched queries — good design), per-employee AI calls are parallel.
- **Retention: SentimentRecord is absent from the retention job** (`retention.ts` purges screenshots/activities/reports/AI insights only). Sentiment data lives forever while its source activity data dies at 90 days → orphaned stale derived data (§13).

---

## 9. AI Pipeline Audit

- Pipeline exists and is real (live-verified end-to-end):
  `Activity (2 batched queries) → calculateSignals → calculateScore (rules) → determineMood → riskFactors → callAIProvider (system+user prompt) → response parse → transaction write → UI`.
- **Provider:** `custom` → `https://openrouter.ai/api/v1`, model `gpt-4o` (live settings). BYOK, stored **encrypted at rest** (AES-256-GCM wrapper), decrypted server-side only, masked in logs, redacted (`REDACTED`) in `/api/settings` responses (verified: `settings/route.ts:8,21-23`). Key never exposed to client code ✓.
- **Provider selection respected** ✓ (DEFAULT_BASE_URLS/DEFAULT_MODELS, per-provider request shapes, `apiEndpoint` avoids `/v1/v1`). SDLC-timeout 30s via `safeFetch`; error codes returned as safe strings; malformed response → `AI_RESPONSE_INVALID` → **rules fallback** (never fabricated data) ✓.
- The insight prompt includes **employee name + aggregated numeric signals only** — no raw activity text, no screenshots, no chat content. Excellent privacy posture for the prompt itself.
- **Missing: timeout on the per-provider fetch is 30s but there is NO retry/backoff**; a single provider blip silently downgrades every employee's insight to templated rules text (acceptable, but note it).
- **CRITICAL accuracy caveat:** the *score* and *mood* are **not AI output at all** — they are deterministic arithmetic over activity signals (`calculateScore`, `determineMood`). AI only writes the 2-sentence commentary. The page header/"AI-generated text insight" labels and the copy "Run your first analysis to generate sentiment scores for all employees" are misleading marketing of a rules engine as an AI sentiment model.

---

## 10. Sentiment Calculation Audit

- `calculateScore` (analyze/route.ts:138-160): starts at 50; heuristic deltas for productivity trend, idle rate, overtime, login consistency std-dev, activity drop, anomaly count; clamped 0–100 ✓.
- `determineMood`: >70 positive, ≥40 neutral, ≥25 negative, else critical ✓ (consistent with UI labels).
- Percentages: UI computes positive/negative/at-risk shares over `totalAnalyzed`; the mood bar sums exactly the four counts → **sum = 100% of records** (verified; no rounding drift — raw counts only). ✓
- **Correctness issues:**
  1. **"Analysis" of zero-activity employees:** an employee with no activity in the window gets all-zero signals → score 50 → `neutral` — i.e., **"no data" is rendered as "neutral sentiment"**. Live evidence: Rimon Rana (no activities) scored 55 neutral, and the AI insight even says "shown no activity this week" while the card colors it neutral/blue. A missing-data state should be `null`/"No data", not a sentiment value — this **fabricates an emotion from absence of evidence** and feeds it into org-wide averages and risk counts.
  2. **Duplicate counting:** stats/mood-distribution count every historical record per employee (see §8), inflating counts after multiple runs.
  3. Seed thresholds differ marginally (`>40` vs `>=40`, `seed.ts:1292`) — cosmetic.
  4. `moodDistribution` skips unknown moods silently — fine defensively.

---

## 11. Data Freshness / Background Processing

- **On-demand only.** Analysis runs exclusively when an admin/user clicks "Run Analysis" (broken from UI today; works via raw API). There is **no scheduler, queue, cron, or job** for sentiment (jobs = expire-consents + retention only). The `ai_realtime_analysis` setting exists but is consumed nowhere in this feature.
- No job-level retry/concurrency handling for analysis (manual click = per-request execution; 429 rate limit can block re-click).
- **Staleness is undetectable in the UI:** cards show no "as of" freshness besides the detail dialog's `Updated:` date; period info is only in the dialog. After 90 days the source activities are purged, yet sentiment cards remain and silently keep presenting old results as current (retention.ts purges Activity, not SentimentRecord).
- Cleanup of stale records happens only via the next successful analysis (deleteMany gte dayStart).

---

## 12. Security Audit

| # | Severity | Finding | Evidence |
|---|---|---|---|
| S1 | **HIGH** | Viewer (lowest role) can trigger org-wide AI spending and rewrite sentiment history via POST analyze — no role gate in route or proxy | `analyze/route.ts:304-309` (only `getSessionOrg`); `proxy.ts:127-141` (no `/api/sentiment` rule) |
| S2 | **HIGH** | Detail API exposes employee **email + phone** to any authenticated org user incl. viewers; UI doesn't display them, so exposure is invisible | `[id]/route.ts:29-30` |
| S3 | **HIGH** | Endpoint crashes (500) on malformed input instead of 400 — poor failure handling, easier probing, noisy logs | Live: `page=-1`, `page=abc`, `periodDays=abc` → 500 |
| S4 | **MED** | `pageSize` unbounded → arbitrary-size response dumps (still org-scoped) | `route.ts:27` |
| S5 | **MED** | No bounds on `employeeIds` count or `periodDays` → unbounded AI call volume per request (cost/DoS within rate limit), no backoff/retry handling | `analyze/route.ts:298-318` |
| S6 | **MED** | In-memory rate limiter — per-process only; multi-instance deployments bypass limits | `rate-limit.ts:1-4` (self-documented) |
| S7 | **LOW** | AI usage stats count `rules`-generated records as AI usage (misleading metering) | `ai-provider/usage/route.ts:34-38` |
| S8 | **PASS** | No API key exposure (encrypted at rest, REDACTED in GET, masked logs) | §9 |
| S9 | **PASS** | Tenant isolation sound; no IDOR; prompt content is aggregated numbers only (no raw employee text sent to AI); CSRF defense for state-changing calls | §7, §9 |

---

## 13. Privacy Audit

- **What is analyzed:** name + aggregated activity metrics (hours, idle rates, overtime, break patterns, login consistency, anomaly counts) — derived from `Activity`/`Anomaly`. No chat content, no keystrokes, no screenshots, no message text. Strong baseline ✓.
- **Transparency:** the consent framework exists (`consent.ts` — monitoring/activity_tracking policies with org-facing notices), and `activity_tracking` consent states aggregated activity data is used for reports. **However, sentiment analysis is not consent-gated server-side** — `analyze/route.ts` processes activity for all active employees regardless of consent status, and withdrawal does not stop derived-sentiment generation over already-collected data (only the agent stops sending). No consent record or notice references "sentiment analysis".
- **Retention:** SentimentRecord has **no retention policy** — unlike its source data (90d). Emotion/stress-derived classifications (risk factors incl. `burnout_risk`) persist indefinitely, with no documented deletion path (DELETE endpoint exists but is unused by UI) and no anonymization pass. GDPR-style erasure of an employee (cascade) works via FK, but a policy-level purge is absent.
- **AI offshoring:** derived signals + names are sent to a **global third-party provider** (OpenRouter — configurable, org admin's key, but one shared key for all orgs; BYOK per tenant is not offered). No raw content (good), but provider choice deserves disclosure in any privacy policy. No "AI analysis happened" transparency in the employee-facing self-portal (a viewer/manager role can inspect every employee's risk flags — by design of this product).
- **Technical risks, not legal conclusions:** no retention for derived sentiment; no consent coupling; name+metrics exported to external AI; PII (email/phone) exposed via detail API; "neutral = no data" misinterpretation can drive wrong manager actions.

---

## 14. Performance & Scalability Audit

- **10 employees:** fine (~4s full analyze incl. 2 AI calls, live-measured; ~950ms page GET).
- **100:** stats query per load loads 100 records + join — OK; analyze = 100 parallel AI calls (minutes, provider throttling likely; single request).
- **1,000:** page GET = unbounded stats fetch of 1,000 rows every load (grows linearly; no date bucketizing); analyze = 1,000 concurrent AI calls — **cost blowup and near-certain provider rate-limits**; per-request latency for the admin's browser is unbounded; Next dev/timeouts will kill long runs; no queue/job.
- **10,000:** stats fetch + summary fetch become multi-MB responses; `SentimentRecord` no aggregate indexes on `(organizationId, createdAt)` for stats ordering, `(mood)` for filtering; the per-load aggregation is client-irrelevant (server computes in JS loop `route.ts:97-110`). No caching anywhere.
- Client: card grid renders all fetched records (≤10 currently — truncation, so rendering is *currently* the least of the problems); mood bar trivial.
- Positive: analyze queries are batch-3, no N+1 ✓; paginated list ✓.

---

## 15. Error Handling Audit

- AI unavailable / key missing → per-employee rules fallback (`generateRulesInsight`), `aiProviderUsed: 'rules'` recorded ✓ — fails safe, never fabricates.
- Malformed AI response → raw text truncated 300 chars as insight (acceptable) or rules fallback ✓.
- Rate-limited → 429 with Retry-After ✓.
- Empty dataset → 200 empty payload + UI empty state ✓.
- **Bodyless analyze → 500 with generic message** (user sees false-success toast) ✗.
- Invalid params → 500 (should be 400 with field-level message) ✗.
- Unauthorized/expired → 401/403 with clear messages ✓.
- DB unavailable → generic 500, logged server-side ✓.
- **Silently swallowing:** `refetchOnWindowFocus: false`; no stale-data indicator; no "last successful run" surfaced; analyze errors only logged server-side (`analyze/route.ts:472`).

---

## 16. Test Coverage Audit

Existing: `tests/multi-org-isolation.test.ts` — MO-17 covers summary & detail cross-org 404 (good). `admin-prod-sidebar.test.ts` covers nav role gating.

**Missing (none exist):**
- Analyze route: success path, empty body, `periodDays` validation, tenant-scoped `employeeIds`, no-AI fallback, duplicate-suppression.
- Input validation tests (page/pageSize/mood edge cases) — all currently crash to 500.
- Stats correctness (duplicate-record double counting; mood sum = 100%).
- Authorization matrix for analyze POST (viewer denial) and PII shape of detail GET.
- UI tests: analyze mutation error path (false-success toast), pagination behavior, filter correctness beyond page 1.
- Retention integration test: sentiment purge.

---

## 17. Critical Findings

### [CRITICAL] C1 — "Run Analysis" always fails from the UI (500) and the UI claims success
- File: `src/components/sentiment/sentiment-page.tsx:338`; `src/app/api/sentiment/analyze/route.ts:297`
- Function: `analyzeMutation` / `POST` handler
- Exact problem: the UI POSTs with **no body**; the handler immediately calls `req.json()` (`route.ts:297`), which throws on an empty body → outer catch → 500. With any valid JSON body (`{}`) the endpoint works (live: 200, 2 records, real AI insights via OpenRouter/gpt-4o).
- Evidence: live — `POST /api/sentiment/analyze` no-body → `500 {"error":"Failed to analyze sentiment"}`; `POST` with `{}` → 200. UI code sends no body and ignores `r.ok` (`:338`), so the 500 response body is treated as success: `toast.success('Analysis complete for all employees')` (`:339-345`, `res.count`/`res.analyzed` undefined).
- Impact: the feature's core action is impossible from the UI; users see a false success and stale data stays "current".
- Why it is a production risk: total loss of the feature + user trust damage (system reports success it never achieved — unacceptable for a monitoring product).
- Recommended fix (NOT implemented): send `{}` from the mutation and check `res.ok` before `toast.success`; handle 4xx/5xx distinctly.

### [HIGH] C2 — Unvalidated query/body input crashes endpoints with 500s
- File: `src/app/api/sentiment/route.ts:26-28`; `analyze/route.ts:298-301`
- Exact problem: `parseInt` on `page`/`pageSize` of `'abc'` → NaN; `page=-1` → negative skip; `periodDays='abc'` → `setDate(NaN)` → invalid Date → Prisma throws. No bounds on `pageSize` (999999 → full dump) or `periodDays` (unbounded scan).
- Evidence (live): `page=-1` → 500; `page=abc` → 500; `pageSize=abc` → 500; `periodDays=abc` → 500; `pageSize=999999` → 200.
- Recommended fix: schema validation (zod) + clamps (`page≥1`, `pageSize 1..100`, `periodDays 1..90`), return 400.

### [HIGH] C3 — Run Analysis has no admin/manager gate — any viewer triggers AI spend and rewrites history
- File: `analyze/route.ts:304-309`; `proxy.ts:127-141`; `navigation.ts:39`
- Exact problem: `getSessionOrg` only authenticates; no role requirement. The AI key is a shared paid key (SystemSetting global).
- Recommended fix: require manager-or-above (e.g., `requireManagerOrg`) and/or add a proxy role rule.

### [HIGH] C4 — Results truncated to 10 with global stats — filters/sort statically wrong at scale
- File: `sentiment-page.tsx:349-385` (client filtering of `data.records`), `route.ts:27` (default `pageSize=10`), no pagination UI in the page
- Exact problem: stats are computed over ALL records; cards list only page 1 (10, newest). At 11+ employees, mood/dept/search filters and sorting silently operate on 10 records — wrong answers, broken feature.
- Recommended fix: server-side filtering (the API already supports query params) + pagination controls.

### [HIGH] C5 — Stats double-count employees across analysis runs (no latest-per-employee rule)
- File: `analyze/route.ts:432-438` (delete window `periodStart >= dayStart`), `route.ts:81-112` (stats over all records)
- Exact problem: consecutive daily runs produce a new record per employee per run (previous run's record falls outside the deletion window); the main stats/mood bar/list count every record, so the same employee appears multiple times; "Analyzed – Total employees" becomes false.
- Recommended fix: dedup ("latest per employee") in stats + list, or enforce one-record-per-employee-per-period replace semantics.

### [HIGH] C6 — "No data" is classified as "Neutral" sentiment (fabricated emotion from absence)
- File: `analyze/route.ts:138-160` (score defaults 50), `:162-167` (mood)
- Exact problem: zero activity → all-zero signals → score 50 → neutral, then fed into org averages and risk pipelines. Live: Rimon (no activity) = neutral 55; AI insight itself contradicts the label ("shown no activity this week").
- Recommended fix: emit `no-data` state when `totalThisWeek == 0 && productiveLastWeek == 0`, exclude from averages.

### [HIGH] C7 — Detail endpoint leaks employee email & phone to any authenticated user (viewer included)
- File: `[id]/route.ts:29-30` (select includes `email`, `phone`)
- Evidence: live GET returned both fields; UI never renders them.
- Recommended fix: strip email/phone from the detail payload (or gate behind manager+).

### [MEDIUM] C8 — No retention for sentiment data (infinite PII/derived-risk persistence; stale after source purge)
- File: `jobs/retention.ts:109-148` (purges screenshots/activities/reports/insights only)
- Recommended fix: add `SentimentRecord` purge by `createdAt`/`periodStart` using `ai_insight_retention_days` (or a dedicated key).

### [MEDIUM] C9 — Sentiment analysis ignores consent status
- File: `analyze/route.ts:312-317` (filters only `status: 'active'`)
- Recommended fix: join consent state and skip/anonymize non-consented employees.

### [MEDIUM] C10 — Misleading "AI-powered" claims: score never uses AI; AI writes commentary only
- File: `analyze/route.ts:138-193` vs `:242-293`; page copy `sentiment-page.tsx:418,466`
- Recommended fix: label scoring as "activity-based", AI as "AI commentary", or actually classify with AI.

### [LOW] C11 — Summary API dead code; AI-usage counts rules records; no response caching despite setting; seed `Math.random()` (dev-only)

---

## 18. False/Decorative Functionality

- **"Run Analysis" UI flow** — appears functional, is 500-broken and *reports success on failure* (worst kind: silently fake).
- **Sentiment score as "AI sentiment"** — the score/mood are pure arithmetic; only the commentary text is AI. The feature's brand promise ("Monitor workforce wellbeing", "AI Insight") exceeds its implementation.
- **Neutral mood for no-data employees** — an artifact presented as measured emotion.
- **Filters/Search/Sort** — look global, operate on the first 10 rows only.
- **Summary endpoint** (`/api/sentiment/summary`) — fully implemented, zero consumers.
- **AI "usage" accounting** — counts rules-generated records as AI requests.
- **Date-range capability** (`periodDays`) — implemented server-side, no UI.
- **DELETE endpoint** — real and admin-gated, but no UI path; the only way to delete sentiment data today is a raw API call.
- (No hardcoded/mock UI data, no `Math.random()` in the running app, no placeholder text — verified against the analysis state of the live DB.)

---

## 19. Production Readiness Checklist

| Requirement | PASS | FAIL | PARTIAL |
|---|---|---|---|
| Page loads with real data | ✓ | | |
| No fake/mock/hardcoded data in UI | ✓ | | |
| Core action (Run Analysis) works from UI | | ✓ | |
| End-to-end pipeline (UI→API→DB→AI→UI) | | | ✓ (works via API only) |
| Authentication enforced | ✓ | | |
| Authorization (role gates) | | | ✓ (delete ok; analyze open; viewer read by design) |
| Tenant isolation | ✓ | | |
| IDOR protection | ✓ | | |
| Input validation on all endpoints | | ✓ | |
| Sentiment persistence | ✓ | | |
| Sentiment calculations correct (no dup, no no-data-as-neutral) | | ✓ | |
| AI provider integration (BYOK, encrypted) | ✓ | | |
| AI failure ⇒ no fabricated data | ✓ | | |
| Error handling (no false success, 4xx not 5xx for bad input) | | ✓ | |
| Data freshness mechanism (scheduled/queued) | | ✓ | |
| Retention policy for sentiment data | | ✓ | |
| Consent integration | | ✓ | |
| PII minimization in API responses | | ✓ | |
| Rate limiting on expensive ops | ✓ | | |
| Pagination/filtering correctness at scale | | ✓ | |
| Test coverage | | | ✓ (isolation only) |

---

## 20. Final Verdict

**NOT READY.** This is not a demo-data sham — the backend is real, tenant-safe, and the AI wiring is genuinely functional. But it cannot ship to customers because:

**Blocker 1 (CRITICAL):** "Run Analysis" fails 500 from the UI and the UI displays a success toast for the failure → the feature's only way to produce data is broken, and the system misreports its own state.
**Blocker 2 (HIGH):** Zero input validation — malformed params crash endpoints to 500.
**Blocker 3 (HIGH):** Any viewer can trigger org-paid AI runs and rewrite sentiment history.
**Blocker 4 (HIGH):** List truncation (10 rows, no pagination) makes filters/sort/search statistically wrong at 11+ employees.
**Blocker 5 (HIGH):** Duplicate records across runs corrupt stats; "no data" counted as "neutral sentiment" corrupts the semantics.
**Blocker 6 (HIGH):** Detail API exposes email/phone PII to all roles.
**Blocker 7 (MEDIUM, still required):** No retention/consent handling for derived sentiment data.

Fix the blockers, add tests for the analyze path and validation, and re-certify. Score: **40/100** — a solid foundation with a broken surface.
