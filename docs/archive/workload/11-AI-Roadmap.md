# WorkLensAI — AI & BYOK Roadmap

> **File:** workload/11-AI-Roadmap.md · **Created:** 2026-08-02
> Companion to 01-Roadmap.md and 09-Architecture-Decisions.md (ADR-004 = OpenAI-compatible gateway, ADR-005 auth).

---

## 1. AI Principles

1. **BYOK is sacred** — all AI calls use the buyer's configured provider/key. No vendor API keys, no AI markup.
2. **Never invent metrics** — prompts only reference data actually fetched; remove all `Math.random()` fabrication.
3. **Privacy by default** — prompts include only the minimum context; screenshots/OCR handled locally.
4. **Cost transparency** — token/cost tracking per provider surfaced in the UI.

## 2. Version Plan

| Version | Scope | Status |
|---|---|---|
| **AI v0.1 (Sprint 01)** | OpenAI-compatible gateway; chat + insights route through the configured provider; keys encrypted + masked; token/cost counters real | Not Started |
| **AI v0.2 (Phase 2)** | Scheduled daily/weekly/executive summaries persisted to DB (AISummary table) + email; OCR pipeline with Tesseract; keyword search | Not Started |
| **AI v0.3 (Phase 2/3)** | Semantic search (embedding + vector), employee "AI story" auto-generated, private-time-aware summaries | Not Started |
| **AI v1.0 (Phase 3)** | Anomaly/risk detection from real behavioral signals; workload-balance & burnout analytics | Not Started |
| **AI v2.x (Phase 4)** | Optional local LLM bundle (Ollama auto-install) for zero-external AI; agent-side prompt analysis | Deferred |

## 3. Feature Backlog (AI)

| Feature | Description | Business Value | Complexity | Deps | Effort | Priority | Status |
|---|---|---|---|---|---|---|---|
| BYOK gateway | Reads active provider (baseUrl/model/key) from AIProviders; OpenAI-compatible fetch with retries/timeouts | Core promise | L | — | 4–6 | P0 | Not Started |
| Wire chat to gateway | AI Insights chat uses gateway + platform context | Core promise | M | gateway | 2 | P0 | Not Started |
| Wire insights to gateway | daily/executive/security/productivity prompts use gateway | Core promise | M | gateway | 2–3 | P0 | Not Started |
| Encrypt keys at rest | AES-256-GCM, key from env; mask on read | Security | M | — | 1–2 | P0 | Not Started |
| Token & cost tracking | Real usage per provider from gateway responses; UI totals | Cost transparency | M | gateway | 2 | P1 | Not Started |
| Persist summaries | AISummary table + history UI | Recurring value | M | DB schema | 3 | P1 | Not Started |
| Scheduled generation | Cron-like job for daily/weekly summaries | Recurring value | M | persist | 3 | P1 | Not Started |
| OCR pipeline | Tesseract on screenshots → text + keywords | Searchable history | L | screenshots | 6–8 | P1 | Not Started |
| Keyword search | Search activities/screenshots by text | Buyer demo wow | M | OCR | 2–3 | P1 | Not Started |
| Embeddings + semantic search | pgvector/vec.sqlite; "find similar days" | Differentiator | L | OCR | 6–8 | P2 | Not Started |
| Anomaly detection | Baseline from real signals → risk/burnout scores | Insider-risk story | L | analytics | 6–8 | P2 | Not Started |
| Local LLM bundle (Ollama) | One-click local model for zero cloud calls | Ultimate privacy | L | gateway | 6–8 | P2 | Deferred |

## 4. Supported Providers (MVP gateway targets)

OpenAI · Azure OpenAI · Google Gemini (OpenAI-compat endpoint) · Anthropic Claude · OpenRouter · DeepSeek · Qwen · Ollama (local) · LM Studio · vLLM-compatible endpoints

## 5. Milestones

| Milestone | Target | Gate |
|---|---|---|
| Gateway + chat/insights wired | Sprint 01 | Chat returns real answer with Ollama (free) |
| Keys encrypted + masked; no leaks | Sprint 01 | Pentest-style check on /api/ai-providers |
| Summaries persisted + scheduled | Phase 2 | Daily email lands |
| OCR + search live | Phase 2 | Search finds text from a screenshot |
