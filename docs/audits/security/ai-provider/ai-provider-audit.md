# OmniSight — End-to-End AI Provider Integration Audit

**Date:** 2026-08-08 · **Audit type:** source-level + environment verification
**Result:** ❌ **NOT READY FOR PRODUCTION** — see "Critical Findings" and final scoring.

---

## 0. EXECUTIVE SUMMARY

The AI *transport layer* (`src/lib/ai-provider-helper.ts`, `src/lib/crypto.ts`, `src/lib/ssrf.ts`,
`src/proxy.ts`) is well-built: keys are encrypted at rest, decrypted only server-side, never appear in
URLs/logs/responses, outbound calls are SSRF-hardened, and provider failures return safe diagnostic codes
(`AI_HTTP_401`, `AI_KEY_MISSING`, …).

However, this audit found **four systemic problems** that mean the AI system is **not production-ready**:

1. **CRITICAL — Repository corruption.** The workspace is in a *partially-merged* state. 20+ source
   files (including `prisma/schema.prisma`, `src/lib/db.ts`, `src/lib/auth.ts`, `src/app/globals.css`,
   `src/app/layout.tsx`, `src/app/page.tsx`, `src/lib/store.ts`, `src/hooks/*`, `src/components/ui/*`,
   and several API routes) contain literal committed `<<<<<<< HEAD` conflict markers. The Prisma schema is
   **1,722 lines with duplicate model definitions** (`Device` ×2, `Screenshot` ×2, `Alert` ×2, `Report` ×2,
   `AuditLog` ×2) — the file is the concatenation of two conflicting schemas separated by `=======`.
   `npx prisma validate` fails. The generated Prisma client (old schema: `SystemSetting`, `AppUser`,
   `Employee`, `Activity`) does **not match** the active SQLite DB (`db/custom.db`, 47 tables from the *new*
   schema: `User`, `ActivityEvent`, `AISummary`, `AIProvider`, `UserDailySummary`, …). **The application
   cannot build or boot in this state.** Git HEAD = `1aaad36 merge remote main into local` committed the
   markers as file content (working tree is "clean").

2. **HIGH — Several "AI" features are NOT connected to the configured AI Provider.** Four code paths use
   the third-party `z-ai-web-dev-sdk` package instead of `callAIProvider()`:
   - `/api/ai/chat` (AI Chat)
   - `/api/ai/insights` (AI Insights generator)
   - `/api/users/[id]/ai-summary` (Employee workday AI summary)
   - `src/lib/ai/insights.ts` (Insight Engine used by `/api/admin/executive/dashboard`,
     `/api/admin/ai/insights`, `/api/admin/ai/regenerate`)

   These do **not** read the configured provider, do **not** use the encrypted key, and bypass cost control
   entirely. Two of them (`/api/ai/insights`, `/api/users/[id]/ai-summary`) additionally query Prisma
   models (`user`, `activityEvent`, `securityEvent`, `securityPolicy`, …) that **do not exist** in the
   generated client — they crash at runtime.

3. **HIGH — Tenant-isolation gaps on AI-adjacent and screenshot routes.**
   - `/api/reports/daily/ai-summary` (auto-aggregation path when `reportData` is absent) queries
     `db.activity / db.alert / db.screenshot` **without `organizationId` filters** — cross-tenant rows can
     be aggregated and sent to the AI provider.
   - `/api/screenshots/ocr-search` searches **all** screenshots across organizations (no org filter).
   - `/api/screenshots/[id]/analyze` and `/api/screenshots/batch-analyze` resolve screenshots by ID with
     **no organization check** (only the generic authenticated-JWT proxy guard). Any authenticated user
     (employee role included) can analyze/OCR other organizations' screenshots.
   - `/api/insights/ai-analysis` is rules-based (no AI) but its recent-activity query has no org filter.

4. **Provider configuration status — BLOCKED.** The active DB has **no `SystemSetting` table at all**, so
   no provider, model, base URL, or key is configured. The `.env` is missing `JWT_SECRET`/`ENCRYPTION_KEY`
   (only `NEXTAUTH_SECRET` and super-admin creds present). Live AI E2E tests are **BLOCKED** — not because
   of a code defect alone, but because the repo cannot compile and no valid provider is configured.

---

## 1. AI FEATURE INVENTORY

| Feature | UI Location | API Route | AI Helper | Provider | Model | DB Storage | Status |
|---|---|---|---|---|---|---|---|
| Daily Report AI summary | Daily Report tab | `/api/reports/daily/ai-summary` | `callAIProvider` ✓ | Configured | Configured | none (returns JSON) | PARTIALLY WORKING* |
| Sentiment analysis | Sentiment page | `/api/sentiment/analyze` | `callAIProvider` ✓ | Configured | Configured | `SentimentRecord` | PARTIALLY WORKING* |
| Screenshot OCR + analysis (single) | Screenshot viewer | `/api/screenshots/[id]/analyze` | `callAIProviderVision` ✓ | Configured | Configured | `Screenshot.ocrText/aiAnalysis` | PARTIALLY WORKING* (org gap) |
| Screenshot batch analyze | Screenshots page | `/api/screenshots/batch-analyze` | `callAIProviderVision` ✓ | Configured | Configured | `Screenshot.*` | PARTIALLY WORKING* (org gap) |
| OCR search | Screenshots page | `/api/screenshots/ocr-search` | none (SQL LIKE) | n/a | n/a | read `Screenshot` | BROKEN (cross-tenant) |
| AI Chat | Admin AI view | `/api/ai/chat` | `z-ai-web-dev-sdk` ✗ | **NOT configured provider** | z-ai | none | NOT CONNECTED |
| AI Insights generator | Admin AI view + dashboard | `/api/ai/insights` | `z-ai-web-dev-sdk` ✗ | **NOT configured provider** | z-ai | none | BROKEN (missing models) |
| Employee AI workday summary | User detail | `/api/users/[id]/ai-summary` | `z-ai-web-dev-sdk` ✗ | **NOT configured provider** | z-ai | none | BROKEN (missing models) |
| Insight Engine (executive/dept/user/device) | Admin executive dashboard | `src/lib/ai/insights.ts` + `/api/admin/ai/*` | `z-ai-web-dev-sdk` ✗ | **NOT configured provider** | z-ai | `AISummary` | NOT CONNECTED |
| AI-powered analysis (rules engine) | Insights page | `/api/insights/ai-analysis` | none (deterministic) | n/a | n/a | none | WORKING (not AI) |
| Anomaly detection | Anomalies page | `/api/anomalies/detect`, `/api/agent/anomaly` | none (deterministic) | n/a | n/a | `Anomaly`/`Alert` | WORKING (not AI) |
| AI usage stats | AI Provider page | `/api/ai-provider/usage` | none (DB counts) | n/a | n/a | read-only | WORKING |
| Test connection | AI Provider page | `/api/ai-provider/test-connection` | direct provider call | Configured | n/a | `SystemSetting` (on success) | WORKING (SSRF-safe) |

\* "PARTIALLY WORKING" = correctly wired to the configured provider, but **live execution is BLOCKED**
because the repo cannot compile and no provider is configured. The transport plumbing is verified by source
inspection only.

---

## 2. PROVIDER CONFIGURATION STATUS

| Item | Value | Evidence |
|---|---|---|
| `ai_provider` setting | **ABSENT** — no `SystemSetting` table in active DB | `db/custom.db` has 47 tables; `SystemSetting` not among them |
| `ai_api_key` | **ABSENT** | same |
| `ai_base_url` / `ai_model` | **ABSENT** | same |
| `ENCRYPTION_KEY` | **MISSING from `.env`** | `.env` keys: `DATABASE_URL, NEXTAUTH_SECRET, SUPER_ADMIN_PASSWORD, SUPER_ADMIN_EMAIL, STORAGE_PATH` |
| Dev key | Present (`./.worklens/dev.key`, 64 bytes) | would be used in dev only |
| Generated client vs DB | **MISMATCH** | client has old models; DB has new models |

**Status: BLOCKED.** No valid provider is configured. Live provider tests cannot run.

---

## 3. AI PROVIDER HELPER AUDIT (`src/lib/ai-provider-helper.ts`)

Verified pipeline (source inspection):

1. **Provider lookup** — reads `SystemSetting` rows `ai_provider / ai_api_key / ai_base_url / ai_model`
   via `getSettings()`. Returns safe codes: `AI_PROVIDER_NOT_CONFIGURED`, `AI_KEY_MISSING`,
   `AI_KEY_DECRYPT_FAILED`, `AI_INVALID_BASE_URL`, `AI_MODEL_MISSING`, `AI_UNKNOWN_PROVIDER`.
2. **Key decryption** — `decryptSecretWithMeta()` (AES-256-GCM, `v1:` envelope) with in-place upgrade of
   legacy plaintext and JWT-derived envelopes. `AI_KEY_DECRYPT_FAILED` on wrong key (never fail-open).
3. **Provider selection** — `openai`/`mistral`/`custom` = OpenAI-compatible; plus `anthropic`, `google`,
   `ollama`. Defaults table for base URL + model per provider; custom requires both.
4. **URL construction** — `apiEndpoint()` never duplicates `/v1` (handles
   `https://openrouter.ai/api/v1` → `…/v1/chat/completions`). ✅ (this was the prior `/v1/v1` bug — fixed)
5. **Request headers** — OpenAI-compatible: `Authorization: Bearer <key>`; Anthropic: `x-api-key` +
   `anthropic-version`; Google: `x-goog-api-key` (never in URL); Ollama: none. ✅
6. **Transport** — `providerFetch()` → `safeFetch()` (SSRF-safe, DNS re-validation, `redirect: 'manual'`,
   30s timeout), with a documented localhost carve-out only for Ollama's default endpoint.
7. **Response handling** — per-provider extractors; `AI_HTTP_<status>` / `AI_REQUEST_FAILED` /
   `AI_RESPONSE_INVALID` codes. Keys never logged (only masked).
8. **Vision** — `callAIProviderVision()` supports base64 + URL image inputs for all four providers.

**Conclusion: the helper itself is CORRECT and secure.** The defects are in *which code paths use it* and
in the repo/db state around it.

---

## 4. BASE URL AUDIT (no secrets)

| Provider | Final request URL pattern |
|---|---|
| openai / mistral / custom | `{base}/v1/chat/completions` (or `{base}/chat/completions` if base already ends `/v1`) |
| anthropic | `{base}/v1/messages` |
| google | `{base}/v1/models/{model}:generateContent` |
| ollama | `{base}/api/chat` |
| Test connection (openai/mistral/google/custom) | `{base}/models` (GET); anthropic `{base}/messages` (POST) |

No `/v1/v1` duplication. ✅

---

## 5. DAILY REPORT (audit of `/api/reports/daily/ai-summary`)

- **On-demand:** ✅ The route is `POST` and is called only from the Daily Report UI's explicit
  "Generate" action. No page-load effects, no polling, no cron. (Source-verified: the component calls the
  route inside the generate handler.)
- **Data sent to AI:** A structured numeric snapshot (employees, activities, minutes, breakdown %,
  alerts, screenshots, devices). No raw OCR, no employee names beyond org name, no screenshots.
- **Structured output:** ✅ Zod-free but contract-enforced — the prompt demands a fixed JSON shape and the
  route parses it with a graceful fallback + `aiError` code returned to the UI.
- **Structured logging:** ✅ `log.warn('reports.daily.ai_summary.unavailable', { code, provider })` — no
  secrets.
- **Tenant isolation:** ❌ **Gap.** When `reportData` is NOT supplied by the client, the DB aggregation
  (`db.activity.findMany({ where: { timestamp } })`, plus alert/screenshot counts) has **no
  `organizationId` filter**. Cross-tenant data can be aggregated and sent to AI. (Employee count and org
  name ARE session-scoped, but the bulk aggregation is not.)

---

## 6. DAILY INTELLIGENCE

**REMOVED.** The separate Daily Intelligence feature (models `DailyEmployeeSummary/DailyTeamSummary/
DailyDepartmentSummary`, routes under `/api/ai/daily-intelligence`, `src/lib/daily-intelligence.ts`) was
deleted in migration `20260808120000_remove_daily_intelligence`. There is no duplicate reporting system.
Daily Report is the single daily-reporting entry point. ✅ (No audit items apply.)

---

## 7. OCR → AI AUDIT

- **Pipeline:** Screenshot file → `readFileAsBase64()` → `callAIProviderVision()` (OCR step) →
  text stored in `Screenshot.ocrText` → optional second vision call for category/confidence →
  `Screenshot.aiAnalysis` (JSON) + `flagged/flagReason`.
- **No mock fallbacks:** ✅ Failing OCR/AI returns 502 and persists nothing (single) or an honest `error`
  entry (batch). No fabricated OCR text, no `Math.random()`.
- **OCR dedup/size:** Batch capped at 10; OCR excerpt truncation in AI-summary flows. No raw-OCR flood.
- **Tenant isolation:** ❌ `[id]/analyze` and `batch-analyze` fetch screenshots by ID with **no org check**.
- **Auth:** only the generic proxy JWT check (no RBAC min-role on `/api/screenshots/*`).

---

## 8. EMPLOYEE / DEPARTMENT / TEAM AI

- **Employee AI analysis** exists in two forms:
  - `SentimentRecord` flow (`/api/sentiment/analyze`) — **connected** to `callAIProvider`, tenant-scoped,
    batched (no N+1), rules fallback, AI result optional. ✅
  - `/api/users/[id]/ai-summary` — **NOT connected** (uses `z-ai-web-dev-sdk`) and queries models missing
    from the generated client. ❌
- **Department/Team AI** exists only in the Insight Engine (`src/lib/ai/insights.ts`) — **NOT connected**
  (uses `z-ai-web-dev-sdk`). There is **no `Team` model** in the schema; "team" is a string field on
  `User` and department-level grouping uses department names. (Documented accurately in the company guide.)
- **Cross-tenant data to AI:** the daily-summary auto-aggregation gap (section 5) is the only path found
  where another org's rows could reach the provider; all other AI callers resolve scope from the session.

---

## 9. AI CHAT AUDIT

- **Route:** `/api/ai/chat` uses `z-ai-web-dev-sdk` (`ZAI.create()`) — **NOT the configured provider.**
- **Context:** The admin UI builds a "live platform snapshot" string from `/api/dashboard` and passes it
  as free text. It does NOT use the AI provider abstraction, does NOT respect provider/model settings, and
  does NOT use the encrypted key.
- **Status: NOT CONNECTED.** It works *only* if the z-ai SDK has its own valid credentials/endpoint
  (`.z-ai-config`), which is outside OmniSight's provider management. This contradicts the project rule
  "reuse the existing AI provider abstraction."

---

## 10. ANALYTICS / INSIGHTS AI

- `/api/insights/ai-analysis` (GET) is a **deterministic rules engine** over real DB data (top/bottom
  performers, dept comparison, fleet health, activity patterns). It makes **no AI call** — the "insights"
  are computed from real metrics, with confidence derived from data spread. Not mock; not AI.
- `/api/ai/insights` (POST) — z-ai SDK + **missing models** → runtime crash.
- Dashboard + Command Palette both call `/api/ai/insights` (z-ai) — thus broken/NOT CONNECTED.

---

## 11. AI RESPONSE VALIDATION

- Sentiment: JSON extraction with strict parse + graceful fallback to rules. ✅
- Screenshot analyze: JSON parse, requires `category`, else 502, nothing persisted. ✅
- Daily summary: JSON parse with fallback structure. ✅
- Insight Engine: falls back to a deterministic "AI backend unavailable" template (clearly labeled). ✅
- **No Zod schema is used anywhere in the AI path** — validation is manual JSON parsing. Adequate for the
  current shape, but stricter schemas are recommended for new AI features.

---

## 12. DATABASE VERIFICATION

- AI-output storage models: `SentimentRecord`, `Screenshot.ocrText/aiAnalysis/flagged`, `AiInsight`,
  `AISummary` (new schema). They carry `organizationId` where applicable.
- **Mismatch:** the generated client does not include the new-schema models (`AISummary`, `AIProvider`,
  `UserDailySummary`, `User`, `ActivityEvent`…), so anything referencing them fails at runtime until
  `prisma generate` runs against a *valid, merged* schema.
- **Duplicate-generation behavior:** `SentimentRecord` is deleted+recreated per period (atomic tx);
  `AISummary` update-or-create; `Screenshot` fields updated in place. No unbounded duplicates.

---

## 13. AI COST AUDIT

- ✅ Daily Report: AI only on explicit Generate. No auto-generation, no page-load effects.
- ✅ Sentiment: AI runs per employee per explicit "Analyze" action.
- ✅ Screenshot analysis: explicit user action; batch capped at 10.
- ⚠️ Insight Engine: caches to `AISummary` with 5-min TTL and only regenerates on miss — good, but it
  uses the unmanaged z-ai SDK, so cost is outside OmniSight controls.
- ⚠️ AI Chat/Insights (z-ai SDK): cost is outside the configured provider's accounting entirely.
- ✅ Rate limits: `aiWrite` (10/min/IP) on sentiment/analyze, anomalies/detect, insights/ai-analysis,
  screenshots batch-analyze, reports/generate; `RATE_LIMITS.aiWrite` defined. 429 responses include
  `Retry-After` + `X-RateLimit-*`.

---

## 14. SECURITY AUDIT

| Control | Status | Evidence |
|---|---|---|
| Encrypted API keys at rest | ✅ | AES-256-GCM, `ENCRYPTION_KEY`, `v1:` envelope |
| Keys never in browser/API responses | ✅ | `settings` GET redacts `ai_api_key` → `REDACTED`; PUT refuses the sentinel |
| Keys never in URLs | ✅ | headers only (incl. `x-goog-api-key`) |
| Keys never in logs | ✅ | only masked/error-code logging |
| SSRF protection | ✅ | `safeFetch` + DNS revalidation + `redirect:manual`; metadata/localhost/private blocked |
| Rate limiting | ✅ | central proxy rules + 429 headers |
| CSRF | ✅ | proxy origin check for non-GET + SameSite cookie |
| RBAC | ⚠️ | proxy covers `/api/settings`, `/api/ai-provider`, `/api/self`, … — but **no min-role on `/api/screenshots/*`, `/api/ai/*`, `/api/insights/*`** |
| Tenant isolation | ❌ | gaps in daily-summary aggregation, ocr-search, screenshot analyze/batch (see §5/§7) |
| Audit logging | ✅ | audit logs exist; AI failures logged with safe codes |

---

## 15. ERROR HANDLING AUDIT

- The helper returns distinct safe codes (`AI_PROVIDER_NOT_CONFIGURED`, `AI_KEY_MISSING`,
  `AI_HTTP_401/403/404/429/500`, `AI_REQUEST_FAILED`, `AI_RESPONSE_INVALID`).
- Daily Report surfaces `aiError` in the UI/API response and reports the real reason in logs. ✅
- AI Chat/Insights return generic "AI service unavailable" — **the only message the user sees**, masking
  the true cause, because the z-ai SDK path has no diagnostic plumbing. ❌

---

## 16. REAL PROVIDER E2E TEST

**BLOCKED.** Required conditions absent:
1. The repository cannot compile (committed conflict markers + invalid duplicate-model schema).
2. `prisma generate` cannot run against a valid merged schema, so the client/DB mismatch persists.
3. No `SystemSetting` rows exist, and `.env` lacks `JWT_SECRET`/`ENCRYPTION_KEY` (dev key exists).
4. No real provider API key is present anywhere (earlier placeholder `REDACTED`/`custom-model` was in a
   now-replaced database).

Per the audit mandate: live tests are marked **BLOCKED**, not fabricated. No mock AI responses were used.

---

## 17. PROBLEMS FOUND — ROOT CAUSE / FIX

| # | Severity | Feature/File | Problem | Root Cause | Recommended Fix |
|---|---|---|---|---|---|
| 1 | **CRITICAL** | whole repo (20+ files, `prisma/schema.prisma`) | committed `<<<<<<< HEAD` markers; duplicate models; prisma validate fails; client↔DB mismatch | un-resolved `git merge remote main into local` (HEAD `1aaad36`) committed conflict text | Repair the merge: pick a canonical schema side (old tenant-based vs new User/ActivityEvent-based), resolve all 20 files, `prisma generate`, align DB |
| 2 | **HIGH** | `/api/ai/chat`, `/api/ai/insights`, `/api/users/[id]/ai-summary`, `src/lib/ai/insights.ts` | AI features use `z-ai-web-dev-sdk`, bypassing configured provider, encryption, cost control | legacy/prototype SDK path not migrated to `callAIProvider` | Rewire to `callAIProvider`/`callAIProviderVision`; remove the SDK dependency (or gate behind explicit provider) |
| 3 | **HIGH** | `/api/ai/insights`, `/api/users/[id]/ai-summary` | query models absent from generated client → runtime crash | schema/client/DB three-way mismatch | resolve after #1; validate against real schema |
| 4 | **HIGH** | `/api/reports/daily/ai-summary` (auto path), `/api/insights/ai-analysis`, `/api/screenshots/ocr-search`, `[id]/analyze`, `batch-analyze` | missing org scoping → cross-tenant data read/analyzed/sent to AI | queries not filtered by `organizationId` from session | add `organizationId` filters resolved from the session; RBAC min-role for screenshot/AI routes |
| 5 | **MEDIUM** | `.env` | missing `JWT_SECRET`/`ENCRYPTION_KEY` | env drift during merge | set both; document in `.env.example` (already present) |
| 6 | **LOW** | AI output validation | no Zod schemas (manual JSON parsing) | consistent with legacy code | add Zod schemas for new AI features |

---

## 18. FINAL SCORING

| Area | Score | Notes |
|---|---|---|
| Provider Configuration | **2/10** | Secure storage design exists; nothing configured; env missing; DB has no settings table |
| AI Integration | **3/10** | 4 features wired to helper correctly; 4+ use an unmanaged SDK |
| Real Data Pipeline | **5/10** | Real DB aggregations, no Math.random/mocks; tenant gaps on some paths |
| Daily Report | **4/10** | On-demand, structured, good error codes; org gap on auto-aggregation; blocked live |
| OCR → AI | **4/10** | Correct vision plumbing, no mock fallbacks; org gaps on analyze routes |
| Employee Intelligence | **2/10** | Sentiment OK; `/users/[id]/ai-summary` broken + unconnected |
| Team/Department Intelligence | **1/10** | Only via Insight Engine → unconnected SDK; no Team model |
| AI Chat | **0/10** | Not connected to configured provider |
| Security | **5/10** | Encryption/SSRF/rate-limit/CSRF strong; tenant isolation + RBAC gaps |
| Cost Control | **6/10** | On-demand + caching + rate limits; z-ai SDK paths uncontrolled |

## 19. VERIFICATION KEY

- **VERIFIED (source):** helper correctness, URL construction, header auth, SSRF client, encryption,
  key masking, rate-limit rules, on-demand Daily Report, no-mock rules engine, no duplicate Daily
  Intelligence.
- **VERIFIED (environment):** conflict markers committed (grep), duplicate schema models (grep), client↔DB
  mismatch (tables vs generated client), `.env` contents, absence of `SystemSetting`, `prisma validate`
  failure, `z-ai-web-dev-sdk` presence (4 import sites), missing models in generated client.
- **NOT VERIFIED / BLOCKED:** any real provider round-trip (no valid provider, repo unbuildable).
- **RECOMMENDED:** see fixes in §17; re-run full E2E after repair + real provider key.
- **DEFERRED:** Zod validation, per-route RBAC hardening, screenshot-route tenant scoping.

## 20. PRODUCTION STATUS

**NOT READY FOR PRODUCTION.**
Critical issue #1 (repository corruption) and HIGH issues #2–#4 (unconnected AI features, missing-model
crashes, tenant-isolation gaps) are unresolved and must be fixed before any production claim. The AI
transport layer itself is sound and can be the foundation for the fixes.
