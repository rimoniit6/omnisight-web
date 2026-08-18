# WorkLensAI — Backlog

> **File:** workload/03-Backlog.md · **Updated:** 2026-08-02 (renamed from Backlog.md — content preserved)

> Every outstanding item discovered via audit + market research. No duplicates. Items move to a Sprint file when scheduled.
> Fields: **ID · Item · Priority (P0–P3) · Effort (pd = person-days) · Dependencies · Reason · Status**

**Status:** Not Started / In Progress / Completed / Deferred / Cancelled

---

## P0 — Blockers (must be fixed before any commercial release)

| ID | Item | Effort | Deps | Reason | Status |
|---|---|---|---|---|---|
| BL-001 | Remove `X-API-Key`/`X-Agent-Token` auth bypass in middleware | 0.5 | — | Verified: any bogus header = full auth bypass (HTTP 200 on all routes) | Not Started |
| BL-002 | Sanitize `/api/users` + `/api/users/[id]` responses (drop `passwordHash`, `twoFactorSecret`, `ssoProviderId`) | 0.5 | — | Verified: all 36 bcrypt hashes + TOTP secrets returned to anonymous callers | Not Started |
| BL-003 | Enforce `requireRole('Admin')` on all admin routes; remove dead `requireAuth` gap | 1–2 | BL-001 | No route currently enforces RBAC | Not Started |
| BL-004 | Remove hardcoded JWT fallback secret; fail-fast if `NEXTAUTH_SECRET` unset in prod | 0.5 | — | Publicly-known signing key in repo | Not Started |
| BL-005 | Wire AI chat/insights to configured BYOK providers (OpenAI-compatible gateway) | 4–6 | — | BYOK promise currently fake (uses sandbox SDK) | Not Started |
| BL-006 | Replace `Math.random()` fabricated metrics in analytics + activity-matrix | 2–3 | — | Trust: product presents fake intelligence | Not Started |
| BL-007 | Encrypt AI provider keys at rest; mask on read | 1–2 | BL-005 | Plaintext API keys exposed via API | Not Started |
| BL-008 | Remove/flag admin-password seed helper ("First time? seed admin") in prod; force password change for `admin123` | 1 | — | Known default credential exposed in UI/code | Not Started |

## P1 — MVP scope (scheduled in Sprints)

| ID | Item | Effort | Deps | Reason | Status |
|---|---|---|---|---|---|
| BL-101 | Windows Agent v1 (C#/.NET 8): active window, app/web, idle, sessions, offline queue, heartbeat | 15–20 | — | Core data source; no product without it | Not Started |
| BL-102 | Agent registration + per-device token auth + device fleet UI | 3–4 | BL-101 | Buyers need fleet visibility | Not Started |
| BL-103 | Telemetry ingestion API (batched POST, validation, rate limit, gzip) | 4–5 | BL-101 | Reliable pipeline | Not Started |
| BL-104 | Screenshot capture (agent) + upload + viewer + blur option + retention | 6–8 | BL-101, BL-103 | Table-stakes feature | Not Started |
| BL-105 | Real analytics engine (SQL aggregation, pagination, remove random) | 5–7 | BL-103 | Dashboard trust | Not Started |
| BL-106 | Dashboards/Activity/Profile consume real data; remove hardcoded welcome | 4–5 | BL-105 | UI honesty | Not Started |
| BL-107 | CSV export (replace mock) | 2–3 | BL-105 | Buyers need deliverables | Not Started |
| BL-108 | Docker Compose packaging + native install path + `.env.example` | 5–7 | BL-101, BL-005 | Conversion factor | Not Started |
| BL-109 | Buyer docs: install guide, agent setup, quick start, FAQ, screenshots | 3–5 | BL-108 | Self-hosted support burden | Not Started |
| BL-110 | Vitest (lib/API) + Playwright smoke + GitHub Actions CI | 4–6 | BL-001…008 | No tests exist; protects paid product | Not Started |
| BL-111 | Zod validation + unified error handling on all 33 routes | 3–4 | BL-001 | 32/33 routes unvalidated; ~28 no try/catch; verified 500 on dup email | Not Started |
| BL-112 | Pagination on list APIs (users/devices/orgs/activity/analytics) | 2–3 | BL-105 | Unbounded queries today | Not Started |
| BL-113 | Session restore on refresh + real topbar user/notifications | 2 | BL-001 | Verified: refresh bounces to login; topbar hardcoded | Not Started |
| BL-114 | Simple offline license key validation (install-time) | 2–3 | BL-108 | Basic piracy deterrent | Not Started |

## P2 — Phase 2 (post-launch)

| ID | Item | Effort | Deps | Reason | Status |
|---|---|---|---|---|---|
| BL-201 | OCR pipeline (Tesseract) + search | 6–8 | BL-104 | Headline intelligence feature | Not Started |
| BL-202 | Scheduled + persisted AI summaries; email delivery | 4–5 | BL-005 | Recurring value | Not Started |
| BL-203 | Employee self-view portal + private time + blur/delete personal data | 6–8 | BL-106 | Trust + review complaint + GDPR posture | Not Started |
| BL-204 | Notifications: SMTP email + Slack/Teams webhook + rules | 4–6 | BL-106 | Buyers expect alerting | Not Started |
| BL-205 | Real audit log (append-only table + UI) | 3–5 | BL-003 | Compliance buyers | Not Started |
| BL-206 | PDF reports | 3–4 | BL-107 | Stakeholder deliverables | Not Started |
| BL-207 | Agent auto-update + uninstall protection | 5–7 | BL-101 | Fleet hygiene | Not Started |
| BL-208 | Backup/restore utilities + docs | 2–3 | — | Self-hosted ops | Not Started |

## P3 — Phase 3 / 4 (enterprise & ecosystem)

| ID | Item | Effort | Deps | Reason | Status |
|---|---|---|---|---|---|
| BL-301 | DLP basics (USB/file/clipboard rules) | 10–14 | BL-204 | Teramind-lite upsell | Not Started |
| BL-302 | Advanced analytics (heatmaps, benchmarks, burnout) | 6–8 | BL-106 | ActivTrak parity | Not Started |
| BL-303 | Scoped, validated customer API keys | 3–4 | BL-003 | Integration buyers | Not Started |
| BL-304 | White-label branding (persisted) | 3–5 | — | Reseller market | Not Started |
| BL-305 | PostgreSQL option + indexes + migration tooling | 6–8 | BL-112 | Scale | Not Started |
| BL-306 | Anomaly detection from real signals | 6–8 | BL-302 | Insider-risk credibility | Not Started |
| BL-401 | Integrations: Slack, Teams, Jira, HRIS | 6–10 | BL-204 | Ecosystem | Not Started |
| BL-402 | Plugin system (signed, extension API) | 12–16 | — | Add-on revenue | Not Started |
| BL-403 | Event-triggered screen recording | 12–16 | BL-301 | Kickidler parity | Not Started |
| BL-404 | Mobile agent (Android/iOS) | 12–16 | BL-101 | Field teams | Not Started |
| BL-405 | SSO (OIDC/SAML) + SCIM | 8–12 | BL-003 | Enterprise-only deals | Not Started |
| BL-406 | Vendor license/update server + paid major upgrades | 6–8 | BL-114 | Upgrade revenue model | Not Started |

## Deferred / Non-MVP (tracked in Future-Ideas.md)

| ID | Item | Status |
|---|---|---|
| BL-501 | Multi-tenancy / workspaces | Deferred |
| BL-502 | Redis/Kafka queue infrastructure | Deferred |
| BL-503 | Kubernetes/helm | Deferred |
| BL-504 | Payroll/invoicing (Hubstaff segment) | Deferred |
| BL-505 | GPS/geofencing (field teams) | Deferred |
| BL-506 | Self-hosted local LLM bundle (Ollama auto-install) | Deferred |

---

## Housekeeping backlog (quality gates)

| ID | Item | Priority | Effort | Reason | Status |
|---|---|---|---|---|---|
| BL-601 | Remove `ignoreBuildErrors: true` from next.config; restore strict lint rules | P1 | 1 | Build masks type errors | Not Started |
| BL-602 | Adopt `prisma migrate` (versioned migrations) even on SQLite | P1 | 2 | Upgrade path to Postgres; reproducibility | Not Started |
| BL-603 | Add `.env.example`; rotate/remove committed secrets from git history | P0 | 1 | `.env` (with NEXTAUTH_SECRET) is in git history | Not Started |
| BL-604 | Resolve docs merge conflict + reconcile docs with reality | P2 | 2 | Docs describe unimplemented product | Not Started |
| BL-605 | Fix `seed.ts` destructive `deleteMany` start (guard for prod) | P1 | 0.5 | Data-loss risk | Not Started |
| BL-606 | Add security headers (CSP, X-Frame-Options) | P2 | 1 | OWASP hygiene | Not Started |
| BL-607 | Implement `/api/settings/health` endpoint (referenced by middleware PUBLIC_ROUTES + Docker healthcheck in 14-Deployment.md but missing) | P1 | 0.5 | Deployment guard; compose healthcheck target | **Added 2026-08-02 (verification)** | Not Started |

> **Verification note (2026-08-02):** BL-006 scope confirmed — fabricated `Math.random()` data exists in `analytics/route.ts` (focus/risk/collaboration) and `activity-matrix/route.ts` (downloads/uploads). `Math.random()` in `ui/sidebar.tsx` is skeleton-loading width (cosmetic — not an issue); `Math.random()` in seeds/license-key-gen is acceptable for demo/non-crypto use. BL-001–BL-004 remain verified as **live-exploitable** (auth bypass + credential leak confirmed by curl). No other new missing work discovered beyond BL-607.
