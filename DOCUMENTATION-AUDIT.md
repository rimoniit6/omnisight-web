# Documentation Audit — OmniSight

> Previously branded as **WorkLensAI** — legacy identifiers are intentionally preserved.

Audit of the documentation generated for this repository, the evidence used, feature status, known gaps, and verification results. All statements are based on the actual source code — nothing is invented.

---

## 1. Generated documentation

| File | Scope | Status |
|---|---|---|
| [README.md](./README.md) | Overview, quick start, feature summary, doc map | ✅ Complete |
| [FEATURES.md](./FEATURES.md) | Full feature matrix with statuses + verification | ✅ Complete |
| [COMPANY-GUIDE.md](./COMPANY-GUIDE.md) | Org setup, lifecycle, policies, compliance | ✅ Complete |
| [INSTALLATION.md](./INSTALLATION.md) | Requirements, setup, env vars, builds | ✅ Complete |
| [USAGE.md](./USAGE.md) | Step-by-step product manual | ✅ Complete |
| [ARCHITECTURE.md](./ARCHITECTURE.md) | System architecture as implemented | ✅ Complete |
| [API.md](./API.md) | Route reference (auth, roles, rate limits) | ✅ Complete |
| [SECURITY.md](./SECURITY.md) | Auth, RBAC, isolation, AI security, limitations | ✅ Complete |
| [PRIVACY.md](./PRIVACY.md) | Consent model, data minimization, retention | ✅ Complete |
| [DESKTOP-AGENT.md](./DESKTOP-AGENT.md) | Agent internals, collectors, native addon | ✅ Complete |
| [ADMIN-GUIDE.md](./ADMIN-GUIDE.md) | Admin operations handbook | ✅ Complete |
| [EMPLOYEE-GUIDE.md](./EMPLOYEE-GUIDE.md) | Employee-facing overview | ✅ Complete |
| [AI-GUIDE.md](./AI-GUIDE.md) | AI surfaces, providers, fallbacks | ✅ Complete |
| [TROUBLESHOOTING.md](./TROUBLESHOOTING.md) | Symptom → cause → fix | ✅ Complete |
| [DEVELOPMENT.md](./DEVELOPMENT.md) | Layout, commands, conventions, testing | ✅ Complete |
| [DEPLOYMENT.md](./DEPLOYMENT.md) | Build, serve, agent rollout, TLS checklist | ✅ Complete |

The previously existing root `README.md` was unreadable (corrupted/binary content) and was replaced. The old `docs/company-guide/` materials are staged for deletion in git and are therefore not part of the live documentation; this audit serves as their replacement.

## 2. Evidence used (primary sources)

- `package.json` — scripts, name `nextjs_tailwind_shadcn_ts`, version 0.2.1, deps (Next 16, React 19, Prisma 6, Socket.IO client, TanStack Query, zod, bcryptjs).
- `.env.example` / `.env.production.example` — env var reference.
- `prisma/schema.prisma` (41 models, String-valued enumerations, comments) + `prisma/migrations/` (22 migrations, 2026-08-10 → 2026-08-17).
- `src/proxy.ts` — rate limiting table, ROLE_RULES, CSRF, JWT auth.
- `src/lib/` — auth, agent-auth, consent, policies, ai-insights (fallback-codes, schema-validated responses), ai-provider, anomalies (4 rules), jobs (4), notifications (registry, 4 active producers), screenshots/storage, webcam-relay, roles.
- `src/app/api/**/route.ts` (~150 route files) — API.md inventory.
- `src/lib/navigation.ts` (PAGE_MIN_ROLE, 28 PageTypes), `src/lib/store.ts`.
- `desktop-agent/` — main/preload/renderer, services (9), collectors (8), lifecycle, native addon API surface, electron-builder config, tests.
- `mini-services/live-updates/` — Socket.IO server, polling engine, events.
- `tests/` (~60 suites) — behavioral evidence for auth/RBAC/isolation/consent/telemetry/AI/screenshots.
- `docs/audits/` — certification scores (admin 96/100, notifications 93/100, website tracking 92/100, live monitor 94/100, break monitor 86/100, agent approvals 83/100) and the original repo audit (36/100, mock-data era).
- `PRODUCTION.md` — Phase 3 hardening, legacy SQLite migration notes, backup guidance.
- `Caddyfile`, `browser-extension/` (Manifest V3), `native-host/`.

## 3. Feature status summary (full matrix in [FEATURES.md](./FEATURES.md))

**Implemented (verified):** auth + JWT sessions, RBAC (5 roles), multi-org isolation, consent lifecycle + versioned policies, activity tracking, website domain tracking, screenshots (+ OCR search, flagging, AI analyze), keyboard aggregates, location, USB events, break/privacy mode, webcam on-demand relay, app whitelist/blacklist enforcement, anomalies (4 auto rules + manual), alerts, notifications (12 types, 4 producers) + preferences, audit logs, dashboards/analytics/compare, projects + time entries + auto time sync, reports (CSV/JSON/PDF/excel) + imports, realtime mini-service (19+ events), AI insights/sentiment/daily summaries (BYOK, 6 providers, deterministic fallback), desktop agent (Electron + N-API addon), zero-touch enrollment + device claims + guests, agent software builds, retention settings, role-gated pages (28 PageTypes), search, PDF exports.

**Partial / limited (honest):**
- Agent tamper/anomaly reporting — server endpoints exist; agent client not wired (dormant).
- Email monitoring — consent type + setting exist; no server-side collector.
- Auto-updates — require an HTTPS `WL_UPDATE_URL` feed; disabled by default.
- Live Monitor pause — pause/resume is client-local.
- Sentiment — rules-based fallback without a provider (no fabrications).
- Employee self-service — "Employee Portal" is manager-assisted; no employee login.
- Teams — departments only; no `Team` entity.
- Tasks — not implemented; projects track time only.
- MFA/2FA, password reset — not implemented.
- Multi-instance rate limiting — in-memory, per-process.
- macOS/Linux agents — not implemented (Windows-only).
- AI is on-demand only — no scheduled/silent AI (by design).
- Legacy SQLite demo schema — deprecated; PostgreSQL only for new deployments.

**Planned (from TODO/FIXME inventory):** items found in code (e.g. certain dashboard widget gaps, live-monitor polish, guest workflows) — see `FEATURES.md` §"Known TODOs/FIXMEs".

## 4. Verification results

| Check | Result |
|---|---|
| Documented npm scripts vs `package.json` | ✅ All matched |
| Documented env vars vs `.env*` examples + code reads | ✅ Matched |
| Documented routes vs `src/app/api` files | ✅ Matched |
| Roles/levels vs `src/lib/roles.ts` + proxy | ✅ Matched |
| Consent types/statuses vs schema + `src/lib/consent.ts` | ✅ Matched |
| AI fallback codes vs `src/lib/ai-insights/fallback-codes.ts` | ✅ Matched |
| Agent phases vs `desktop-agent/src/main/lifecycle.ts` | ✅ Matched |
| Realtime events vs `mini-services/live-updates` | ✅ Matched |
| Test suite names vs `package.json` scripts | ✅ Matched |
| Certification scores vs `docs/audits/` | ✅ Matched |
| **Live run of tests** | ⚠️ Not executed — suites require throwaway PostgreSQL test DBs + live server; run per [DEVELOPMENT.md](./DEVELOPMENT.md) §5 |
| **TypeScript/lint** | ⚠️ Not executed during this pass (docs-only task; no code was modified) |

## 5. Known documentation gaps (future work)

1. Screenshots walkthrough with images (none captured).
2. A migration runbook for the legacy SQLite demo DB (documented in `PRODUCTION.md`, not re-derived here).
3. Localization (UI is English-only).
4. Performance benchmarks (no formal baselines in repo).
5. Ansible/MDM automation for agent fleet deployment (only manual + installer documented).
6. `docs/company-guide/` files are staged for deletion — if they are to be kept, restore them and reconcile with COMPANY-GUIDE.md.

## 6. Scope notes

- This pass created **documentation only** — zero application code changes.
- Feature classifications use the status legend in FEATURES.md; anything not evidenced is labeled accordingly.
- Where the old demo (mock data) era differs from current behavior (e.g. `db:seed:dev`), both are documented with their guards.
