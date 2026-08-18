# WorkLensAI — Release History (SemVer)

> **File:** workload/15-Release-History.md · **Created:** 2026-08-02
> Policy: **Semantic Versioning** (`MAJOR.MINOR.PATCH`).
> - `MAJOR` = paid upgrade (v2.0, v3.0) · `MINOR` = free feature release · `PATCH` = bug/security fixes.
> - Entries are **append-only**; never rewrite past entries. Planned versions are clearly marked *(planned)*.
> - Actual release dates backfilled from git history; pre-v0.1 entries summarized.

---

## v0.1.0 — Development Started
- **Date:** 2026 (initial scaffold)
- **Type:** Alpha
- **Highlights:**
  - Next.js 16 + TypeScript + Tailwind 4 + shadcn/ui scaffold
  - Prisma 6 + SQLite schema (19 models)
  - Product documentation suite (PRD, architecture, security, deployment) generated
- *Reconstructed from git history.*

## v0.2.0 — Admin Console Prototype
- **Date:** 2026-08-02 (reconstructed)
- **Highlights:**
  - Custom JWT auth (jose HS256, bcrypt-12) with login rate limiting
  - 33 API route handlers (CRUD for orgs/users/devices/licenses/plugins/reports/security/AI providers)
  - Admin console: dashboard (KPIs/trends/drill-down), analytics, activity timeline, employee 22-category profile, AI insights chat, command palette, dark theme, responsive layout
  - Seed data: 6 orgs, 36 users, 10 devices

## v0.2.1 — Current Build (pre-alpha)
- **Date:** 2026-08-02
- **Highlights / fixes:**
  - **Fixed P2021** "table `main.User` does not exist" — `.env` `DATABASE_URL` pointed at the wrong SQLite path (relative `file:` URL resolved against `prisma/`); corrected to `file:../db/custom.db` (verified end-to-end)
  - Functional audit completed → findings tracked in `08-Known-Issues.md`
  - Product roadmap + workload PM system established
- **Known status:** prototype quality — see `08-Known-Issues.md` (Critical C1–C4 must be fixed before any public release).

---

## Planned (not yet released)

## v0.3.0 — Security Hardening & Foundation *(planned — Sprint 01)*
- Remove auth bypass; sanitize user APIs; RBAC enforcement; secrets management
- Zod validation + unified error handling on all routes; pagination
- BYOK AI gateway (OpenAI-compatible); encrypted provider keys
- Real data (remove `Math.random`); session restore; live topbar
- Tests (Vitest + Playwright) + CI; `prisma migrate` adoption

## v0.4.0 — Windows Agent & Real Telemetry *(planned — Sprint 02)*
- Windows Agent v0.1/v0.2 (C#/.NET 8): telemetry, idle, screenshots, offline queue
- Agent registration/heartbeat + ingestion API
- Dashboards on real data; CSV export; Docker Compose + buyer docs; offline licensing

## v1.0.0 — CodeCanyon Launch *(planned — end of Phase 1)*
- Full release gate: `12-Release-Checklist.md` + `13-CodeCanyon-Checklist.md` green
- Signed agent, docs pack, listing assets

## v1.1.x — Post-launch fixes *(planned)*
- Buyer-reported bug/security patches (free)

## v2.0.0 — Intelligence & Engagement *(planned — Phase 2, paid upgrade)*
- OCR + search, scheduled AI summaries, employee self-view portal, notifications (SMTP/webhooks), audit log, PDF reports, agent auto-update, backup tooling

## v3.0.0 — Security & Scale *(planned — Phase 3, paid upgrade)*
- DLP basics, advanced analytics, scoped API keys, white-label, PostgreSQL option, anomaly detection

## v4.0.0 — Ecosystem *(planned — Phase 4, paid upgrade)*
- Integrations, plugin system, video recording, mobile agent, SSO/SCIM, upgrade server

---

## Versioning notes
- Minor/patch releases: free for life per license (CodeCanyon "one-time purchase, free updates").
- Major releases: paid upgrade path (business model per `00-Product-Vision.md`).
- Every release updates: `CHANGELOG.md`, `07-Progress.md`, this file, and `06-Completed.md`.
