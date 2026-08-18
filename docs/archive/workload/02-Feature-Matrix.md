# WorkLensAI — Feature Matrix

> **File:** workload/02-Feature-Matrix.md · **Created:** 2026-08-02 · Updated as features land.
> Legend: ✅ = implemented & verified · ⚠ = partial/stub/fake · ❌ = missing/planned · — = not applicable
> Status: Completed / In Progress / Not Started / Deferred · Priority: P0 (blocker) → P3 (later)

| Feature | UI | API | Database | Windows Agent | AI | Status | Priority | Notes |
|---|---|---|---|---|---|---|---|---|
| Login (email+password) | ✅ | ✅ | ✅ | — | — | Completed | P0 | bcrypt-12, rate-limited (verified) |
| Logout | ✅ | ✅ | — | — | — | Completed | P0 | Cookie clear |
| Sessions (multi-device) | ❌ | ⚠ | ❌ | — | — | Not Started | P2 | Stub endpoint; no sessions table |
| Login history / audit | ❌ | ⚠ | ❌ | — | — | Not Started | P1 | Placeholder; console.log only |
| Forgot / reset password | ❌ | ❌ | ❌ | — | — | Not Started | P1 | Route whitelisted only |
| 2FA (TOTP) | ❌ | ❌ | ⚠ fields | — | — | Not Started | P2 | Columns exist; no flow |
| SSO / OIDC / SAML | ❌ | ❌ | ⚠ fields | — | — | Deferred | P3 | Phase 4 |
| RBAC / role enforcement | ❌ | ❌ | ⚠ role col | — | — | Not Started | P0 | requireRole unused — BL-003 |
| Dashboard (KPIs/trends/drill) | ✅ | ✅ | ✅ | — | ⚠ | Completed* | P0 | *Hardcoded "Administrator"; AI summary via SDK |
| Analytics | ✅ | ⚠ | ✅ | — | ❌ | In Progress | P0 | Contains Math.random — BL-006 |
| Activity timeline | ✅ | ✅ | ✅ | — | — | Completed* | P0 | *No real ingest yet — wait for agent |
| Live 24h sparkline | ✅ | ✅ | ✅ | — | — | Completed | P1 | Polls /api/timeline |
| Organizations CRUD | ✅ | ✅ | ✅ | — | — | Completed | P1 | No tenant enforcement needed (single-tenant) |
| Users CRUD | ✅ | ⚠ | ✅ | — | — | In Progress | P0 | Leaks passwordHash/2FA — BL-002 |
| Devices CRUD | ✅ | ✅ | ✅ | — | — | Completed | P0 | Will be agent-driven in Sprint 02 |
| **Windows Agent (core)** | ❌ | ❌ | ❌ | ❌ | — | Not Started | P0 | **THE missing piece** — 10-Agent-Roadmap.md |
| Agent registration/heartbeat | ❌ | ❌ | ❌ | ❌ | — | Not Started | P0 | Sprint 02 |
| Telemetry ingestion | ❌ | ❌ | ❌ | ❌ | — | Not Started | P0 | Sprint 02 |
| Idle detection | ❌ | — | ⚠ model | ❌ | — | Not Started | P0 | Agent-side |
| Screenshots (capture/view/blur) | ⚠ | ⚠ meta | ⚠ meta | ❌ | — | Not Started | P0 | Metadata only; no files — BL-104 |
| OCR pipeline | ❌ | ❌ | ⚠ fields | — | ⚠ | Deferred | P1 | Phase 2 — BL-201 |
| Employee 22-category profile | ✅ | ✅ | ✅ | — | ⚠ | Completed* | P1 | *Partial random stats — BL-006 |
| AI chat | ✅ | ⚠ | ❌ | — | ⚠ | In Progress | P0 | Uses sandbox SDK, not BYOK — BL-005 |
| AI insights / summaries | ✅ | ⚠ | ❌ | — | ⚠ | In Progress | P0 | Not persisted; not BYOK |
| AI Providers (BYOK config) | ✅ | ⚠ | ✅ | — | ❌ | In Progress | P0 | Keys plaintext; not wired — BL-005/007 |
| Security Policies CRUD | ✅ | ✅ | ✅ | — | — | Completed | P1 | No enforcement engine (Phase 3 DLP) |
| Security Events CRUD | ✅ | ✅ | ✅ | — | — | Completed | P1 | Seeded demo data |
| Reports CRUD | ✅ | ✅ | ✅ | — | — | Completed | P1 | No generation/export yet |
| CSV export | ❌ | ❌ | — | — | — | Not Started | P1 | Replace mock — BL-107 |
| Licenses CRUD | ✅ | ✅ | ✅ | — | — | Completed | P2 | Validation is Phase-1 P2 (BL-114) |
| Plugin Marketplace | ✅ | ✅ | ✅ | — | — | Deferred | P3 | CRUD only; no runtime — Phase 4 |
| Settings | ⚠ | ❌ | ❌ | — | — | Not Started | P1 | Cosmetic — BL-107/304 |
| Notifications | ⚠ mock | ❌ | ❌ | — | — | Not Started | P1 | Hardcoded — BL-204 |
| Command palette (⌘K) | ✅ | — | — | — | — | Completed | P2 | |
| Dark/light theme | ✅ | — | — | — | — | Completed | P2 | |
| Responsive mobile layout | ✅ | — | — | — | — | Completed | P2 | Drawer sidebar |
| Employee self-view portal | ❌ | ❌ | ❌ | — | — | Deferred | P1 | Phase 2 — BL-203 |
| Private time / pause | ❌ | ❌ | ❌ | ❌ | — | Deferred | P1 | Phase 2 |
| Audit log (real) | ❌ | ❌ | ❌ | — | — | Not Started | P1 | BL-205 |
| Backup / restore | ❌ | ❌ | ❌ | — | — | Not Started | P2 | BL-208 |
| Real API keys (scoped) | ❌ | ❌ | ❌ | — | — | Deferred | P2 | Phase 3 — BL-303 |
| White-label branding | ⚠ cosmetic | ❌ | ❌ | — | — | Deferred | P2 | Phase 3 — BL-304 |
| DLP basics | ❌ | ❌ | ⚠ model | ❌ | — | Deferred | P2 | Phase 3 — BL-301 |
| Screen video recording | ❌ | ❌ | ❌ | ❌ | — | Deferred | P3 | Phase 4 |
| Mobile agent | ❌ | ❌ | ❌ | ❌ | — | Deferred | P3 | Phase 4 |

---

### Phase-to-Feature rollup

| Phase | Features it completes |
|---|---|
| Phase 1 (MVP) | Windows Agent, ingestion, screenshots, BYOK wiring, RBAC, sanitized APIs, export, licensing, packaging, tests |
| Phase 2 | OCR, AI summaries, employee portal, notifications, audit log, PDF, auto-update, backup |
| Phase 3 | DLP, advanced analytics, scoped keys, white-label, Postgres, anomaly detection |
| Phase 4 | Integrations, plugins, video recording, mobile agent, SSO/SCIM, upgrade server |

---

## Verification Report — 2026-08-02 (source-code verified)

> **Method:** full source inspection (33 API routes, 76 components, Prisma schema) + live runtime checks (curl/browser) + grep evidence. One status per feature. `Impl %` = weighted across UI/API/DB/business-logic/validation/permissions/testing with code evidence. This section **supersedes** any status above where they differ; original notes are preserved above.

| Feature | Status (verified) | Impl % | Evidence / Notes |
|---|---|---|---|
| Login (email+password) | Completed | 100% | bcrypt-12, zod schema, rate-limit (live-verified 401×5→403), JWT+httpOnly cookie |
| Logout | Completed | 100% | cookie clear, live-verified |
| Sessions (multi-device) | Placeholder | 10% | `auth/sessions/route.ts` returns fake single session; DELETE no-op; no table |
| Login history / audit | Placeholder | 15% | `auth/login-history/route.ts` returns fabricated row; `recordLogin` = console.log |
| Forgot / reset password | Not Started | 0% | only whitelisted in middleware; no endpoint/UI/flow |
| 2FA (TOTP) | Not Started | 5% | DB columns only (`twoFactorSecret/Enabled`); no flow |
| SSO / OIDC / SAML | Cancelled (deferred P4) | 0% | DB columns only |
| RBAC / role enforcement | Not Started | 10% | `requireAuth/requireRole` exist but 0/33 routes call them (grep) |
| Dashboard | Mostly Complete | 90% | UI+API+DB real (live-verified render, no console errors); data is seeded demo, not agent-fed; hardcoded "Administrator"; AI summary via SDK |
| Analytics | Partial | 60% | UI complete; API contains `Math.random()` for focus/risk/collaboration (BL-006) |
| Activity timeline | Mostly Complete | 75% | real API over seeded DB; no live agent ingest yet |
| Live 24h sparkline | Completed | 90% | polls `/api/timeline`; works on seeded data |
| Organizations CRUD | Mostly Complete | 90% | full CRUD + UI; no validation/error-handling/pagination (BL-111/112) |
| Users CRUD | Partial | 85% | CRUD works but returns `passwordHash`/`twoFactorSecret` (BL-002); no zod; no set-password flow |
| Devices CRUD | Mostly Complete | 90% | full CRUD + UI; not yet agent-driven |
| **Windows Agent (core)** | Not Started | 0% | no agent code exists (no .cs/.NET anywhere) — THE blocker |
| Agent registration/heartbeat | Not Started | 0% | no `/api/agent/*` endpoints (middleware whitelists non-existent routes) |
| Telemetry ingestion | Not Started | 0% | no ingest/upload endpoints |
| Idle detection | Not Started | 0% | agent-side; nothing exists |
| Screenshots (capture/view/blur) | Not Started (metadata only) | 10% | schema + read routes exist; **no image bytes stored** (route comment: "we don't store actual image bytes"); no capture/upload/viewer |
| OCR pipeline | Not Started | 5% | schema fields + comments only; no Tesseract/engine |
| Employee 22-category profile | Mostly Complete | 80% | UI+API+DB real (activity-matrix route validates date, 404s); `Math.random()` downloads/uploads (BL-006) |
| AI chat | Partial | 55% | UI+API work via `z-ai-web-dev-sdk` (live-verified UI); **not BYOK**; no persistence |
| AI insights / summaries | Partial | 55% | works via SDK incl. employee ai-summary route; not BYOK; not persisted |
| AI Providers (BYOK config) | Partial | 60% | UI+API+DB; keys plaintext; **never read by AI routes** (BL-005/007) |
| Security Policies CRUD | Mostly Complete | 85% | full CRUD; no enforcement engine (DLP is Phase 3) |
| Security Events CRUD | Mostly Complete | 85% | full CRUD on seeded demo events |
| Reports CRUD | Mostly Complete | 75% | CRUD only; no generation/export |
| CSV export | Mock | 0% | settings-view toast `(mock)` only; no API |
| Licenses CRUD | Mostly Complete | 75% | CRUD; non-crypto key gen (`Math.random`); no validation server (BL-114) |
| Plugin Marketplace | Partial (CRUD, no runtime) | 50% | UI+API+DB; no install/update/extension system (P4) |
| Settings | UI Only | 15% | 100% cosmetic: local state + toast; reset/export mocked; no persistence |
| Notifications | Mock | 5% | hardcoded `NOTIFICATIONS` array in topbar; "View all" no-op |
| Command palette (⌘K) | Completed | 100% | client-side, works |
| Dark/light theme | Completed | 100% | next-themes, verified |
| Responsive mobile layout | Completed | 90% | drawer sidebar, mobile layouts; dense tables remain desktop-centric |
| Employee self-view portal | Not Started (deferred P2) | 0% | — |
| Private time / pause | Not Started (deferred P2) | 0% | — |
| Audit log (real) | Not Started | 0% | no table (BL-205) |
| Backup / restore | Not Started | 0% | no tooling (BL-208) |
| Real API keys (scoped) | Not Started (deferred P3) | 0% | — |
| White-label branding | UI Only | 5% | cosmetic color picker in settings only |
| DLP basics | Not Started (deferred P3) | 0% | policy/event models exist but no engine |
| Screen video recording | Not Started (deferred P4) | 0% | — |
| Mobile agent | Not Started (deferred P4) | 0% | — |

### Reclassifications vs. previous matrix (corrections)

| Feature | Previous | Verified | Why corrected |
|---|---|---|---|
| Dashboard | Completed* | Mostly Complete (90%) | Data is seeded demo, not agent-fed; hardcoded welcome |
| Activity timeline | Completed* | Mostly Complete (75%) | No live ingestion pipeline |
| Organizations / Devices / Reports / Licenses / Policies / Events / Plugins CRUD | Completed | Mostly Complete (85–90%) | No validation, try/catch, or pagination (verified 500 on dup email) |
| Users CRUD | In Progress | Partial (85%) | Verified credential leak (BL-002) |
| Employee profile | Completed* | Mostly Complete (80%) | `Math.random()` browser stats remain |
| AI chat / insights | In Progress | Partial (55%) | Confirmed not BYOK (SDK import in 3 routes) |
| Sessions / Login-history | Not Started | Placeholder (10%/15%) | Fake rows returned |
| Settings | Not Started | UI Only (15%) | Cosmetic only |
| Notifications | Not Started | Mock (5%) | Hardcoded array |
| CSV export | Not Started | Mock (0%) | Toast only |
| Plugin Marketplace | Deferred | Partial (50%) | CRUD exists; runtime missing |
| Screenshots | Not Started | Not Started — metadata only (10%) | Verified no image bytes |

### Global quality gates (verified 2026-08-02)

| Gate | Status | Evidence |
|---|---|---|
| Input validation | ❌ 1/33 routes (zod: login only) | grep |
| Error handling | ❌ 5/33 routes have try/catch | grep |
| RBAC enforcement | ❌ 0/33 | grep |
| Pagination | ❌ 0 list routes | code |
| Tests | ❌ none (no test script/config) | repo scan |
| CI | ❌ none | no .github |
| Migrations | ❌ none (db push workflow) | prisma/ |
| Docker | ❌ none | repo scan |
| Health endpoint | ❌ `/api/settings/health` referenced but missing | middleware + 14-Deployment |
| Fabricated data | ⚠ analytics + activity-matrix (`Math.random`) | grep (sidebar skeleton width is cosmetic — not an issue) |
