# OmniSight — AI Guide

> Previously branded as **WorkLensAI** — legacy identifiers are intentionally preserved.

How the AI features work under the hood, what they can and cannot do, and how to configure them honestly.

Related docs: [ARCHITECTURE.md](./ARCHITECTURE.md) §10 · [API.md](./API.md) §14 · [SECURITY.md](./SECURITY.md) §5 · [PRIVACY.md](./PRIVACY.md) §7

---

## 1. What AI exists

| Surface | Entry point | Trigger |
|---|---|---|
| AI Insights | **AI Insights** page → Run Analysis | manager+ (viewer can view) |
| Sentiment | **Sentiment** page → Run Analysis; project → Sentiment tab → Run Analysis | manager+ |
| Daily report AI summary | **Reports → Daily Report → Generate AI Summary** | manager+ (rate-limited 10/min) |
| Screenshot analysis | Screenshots page → **Analyze** | admin+ |

There is **no general-purpose chat bot**, no scheduled AI, and no AI-driven data collection. Everything is on-demand and operator-initiated.

## 2. How an analysis runs

1. The request builds a **measured dataset** (`buildInsightDataset`): aggregated, consent-gated, org-scoped stats — activities, productivity, apps, websites (domains), keyboard, breaks, screenshots, alerts, anomalies, projects/time, sentiment history. Only data the operator already sees in the UI is used — the AI never gets access to anything the UI can't show.
2. The server calls the configured provider via `callAIProvider` (SSRF-guarded, HTTPS-only, 30 s timeout, 10 MB cap, no redirects).
3. The response is validated with a **strict schema** (`z.strictObject`): unknown fields are rejected; AI-provided values must match the measured dataset (e.g. a made-up "top app" is rejected because it doesn't match the dataset).
4. The result persists with full **provenance**: `provider`, `model`, `mode` (`AI` or `DATA_SUMMARY`), timestamps, scopes (employee/department/project).

**Fallback (important):** if the provider is unconfigured, fails, rate-limits, or returns invalid JSON, the app does **not** fake an AI answer — it produces a deterministic **Data Summary** (`mode: DATA_SUMMARY`) with a clear reason, computed from the same measured dataset. The UI badges each result honestly.

## 3. Providers

| Provider | Type | Base URL default |
|---|---|---|
| OpenAI | hosted | api.openai.com |
| Anthropic | hosted | api.anthropic.com |
| Google | hosted | generativelanguage.googleapis.com |
| Mistral | hosted | api.mistral.ai |
| Ollama | local | http://localhost:11434 (loopback — SSRF guard allows it) |
| Custom (BYOK) | bring-your-own | any **HTTPS** URL (SSRF-guarded) |

**Configuration** (admin+): AI Provider page → Configure → API key + optional base URL/model → **Test Connection** (only on success is the config persisted; rate-limited 10/min) → Set Active. Compatibility checks reject invalid provider/model pairs.

## 4. Secrets & privacy

- Keys are stored in `SystemSetting` (`ai_api_key`), encrypted **AES-256-GCM** with `ENCRYPTION_KEY`; the API returns `REDACTED`; never logged.
- Data leaves your network **only** when you run an analysis against a hosted provider (BYOK). Ollama keeps everything local.
- Prompts carry aggregated, consent-gated data — never raw keystrokes, URLs, or webcam frames.

## 5. Sentiment specifics

- Per-employee scores: `positive | neutral | negative | critical | no-data`, with signals, risk factors, and recommendations.
- Project sentiment is **project-scoped** — the dataset is filtered to that project's members/time; data never leaks across projects.
- With no provider: deterministic **rules-based** sentiment (`aiProviderUsed: 'rules'`) computed from measured activity patterns.

## 6. Usage statistics

AI Provider page → **Usage Statistics**: tracks real provider calls only (successes/failures/latency/tokens where known); `DATA_SUMMARY` fallbacks and rule-based sentiment are not counted as provider usage.

## 7. Failure codes you may see

- `AI_PROVIDER_NOT_CONFIGURED` — no active provider (configure one, or accept Data Summaries)
- `AI_PROVIDER_RATE_LIMITED` — provider 429; retry later
- `AI_PROVIDER_TIMEOUT` — provider slow; retry
- `AI_PROVIDER_INVALID_RESPONSE` — schema validation failed; the response was discarded
- `AI_PROVIDER_SSRF_BLOCKED` — custom base URL is not HTTPS/allowlisted
- `AI_PROVIDER_AUTH_FAILED` — key rejected; re-test connection

## 8. Recommended workflow

1. Configure provider + key + model → Test Connection → Set Active (admin+).
2. AI Insights → filters (period 7/30 days, employee/department/project) → Run Analysis.
3. Review mode badge (AI vs Data Summary) and action/dismiss insights.
4. Sentiment → Run Analysis (employee or project).
5. Screenshots → Analyze (vision) for flagged images.
6. Daily Report → Generate AI Summary.
