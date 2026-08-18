# WorkLensAI — Known Issues

> **File:** workload/08-Known-Issues.md · **Renamed:** 2026-08-02 (content preserved)

> Source: functional audit 2026-08-02 (live-verified). Each issue links to its Backlog item. Status: Open / In Progress / Fixed / Won't Fix.

---

## 🔴 Critical

| ID | Issue | Evidence | Files | Fix (Backlog) | Status |
|---|---|---|---|---|---|
| C1 | **Full auth bypass via any `X-API-Key` or `X-Agent-Token` header** | `curl -H 'X-API-Key: totally-bogus-key-123' /api/users` → **HTTP 200** with full dataset (verified) | `src/middleware.ts:44-53` | BL-001 | Open |
| C2 | **Password hashes & 2FA secrets exposed via API** | `/api/users` & `/api/users/[id]` return `passwordHash` + `twoFactorSecret` for all 36 users (verified) | `src/app/api/users/route.ts:26-44`, `users/[id]/route.ts:7-13` | BL-002 | Open |
| C3 | **Hardcoded fallback JWT secret** (publicly-known signing key) | `process.env.NEXTAUTH_SECRET \|\| 'worklensai-dev-secret-…'` | `src/middleware.ts:6`, `src/lib/auth.ts:8` | BL-004 | Open |
| C4 | **No authorization/RBAC** — `requireAuth`/`requireRole` exist but 0/33 routes call them; any role (incl. Employee) can delete users/orgs/licenses | grep across `src/app/api` | `src/lib/auth.ts:60-78` + all routes | BL-003 | Open |

## 🟠 High

| ID | Issue | Evidence | Files | Fix | Status |
|---|---|---|---|---|---|
| H1 | **Fabricated analytics data** (`Math.random()` for focus/risk/collaboration; downloads/upload counts) | `src/app/api/analytics/route.ts:57-58,90`; `activity-matrix/route.ts:150-151` | same | BL-006 | Open |
| H2 | **BYOK decorative** — AI chat/insights use `z-ai-web-dev-sdk`, ignore configured AIProviders | `ai/chat/route.ts`, `ai/insights/route.ts` never query `db.aIProvider` | same | BL-005 | Open |
| H3 | **AI provider keys plaintext** stored & returned | `ai-providers/route.ts:20-34` stores `body.apiKey` as-is | same | BL-007 | Open |
| H4 | **Known default admin password `admin123`** + public "seed admin" helper on login page | `login/route.ts:122-126`, `login-view.tsx:52-60`; hash-compare verified | same | BL-008 | Open |
| H5 | **Settings are cosmetic** — local state + toast only; "Reset Data"/"Export" are `(mock)`; no persistence | `settings-view.tsx` (all save fns are toasts) | same | BL-107/304 | Open |
| H6 | **No validation on 32/33 routes; ~28 no try/catch** — duplicate email → HTTP 500 (verified); `where: any` | zod only in `auth/login` | all CRUD routes | BL-111 | Open |
| H7 | **Unbounded queries / no pagination** | `analytics` fetches ALL activity rows; users/devices/orgs return full tables | `analytics/route.ts`, list routes | BL-112 | Open |
| H8 | **Zero automated tests, zero CI** — no test script, no framework config, `tests/` only screenshots + deploy scripts | `package.json`, `tests/` | — | BL-110 | Open |
| H9 | **`ignoreBuildErrors: true`** masks type errors; ESLint disables 10+ core rules | `next.config.ts`, `eslint.config.mjs` | same | BL-601 | Open |
| H10 | **No DB migrations** (db push only); SQLite vs documented PostgreSQL | no `prisma/migrations/`; schema `provider="sqlite"` | `prisma/schema.prisma` | BL-602 | Open |
| H11 | **Missing core documented features**: Windows Agent, Docker deploy, notifications engine, DLP engine, license enforcement, plugin runtime; middleware whitelists non-existent `/api/agent/*`, `forgot-password`, `verify-2fa`, `license/validate`, `settings/health` | file tree; `src/middleware.ts` | — | Sprint 02 / Phases 2–4 | Open |

## 🟡 Medium

| ID | Issue | Files | Fix | Status |
|---|---|---|---|---|
| M1 | Auth gating client-side only; **refresh bounces to login** (no session restore) | `src/app/page.tsx`, `login-view.tsx` | BL-113 | Open |
| M2 | Topbar profile hardcoded "Admin User/admin@worklensai.local"; notifications hardcoded array; "View all" no-op | `topbar.tsx` | BL-113 | Open |
| M3 | Sessions & login-history are placeholders; `recordLogin` → console only (no audit table) | `auth/sessions`, `auth/login-history`, `lib/auth.ts` | BL-205 | Open |
| M4 | JWT HS256 (docs say RS256), no refresh/revocation | `lib/auth.ts` | ADR-005 | Open |
| M5 | In-memory rate limit resets on restart; no limits on other APIs | `auth/login/route.ts` | — | Open |
| M6 | No security headers (CSP/X-Frame-Options) | `next.config.ts` | BL-606 | Open |
| M7 | Docs aspirational/inconsistent: 91 files, duplicate specs, **unresolved merge conflict** in `docs/03-Database-Design.md`; `.env` committed; no `.env.example`; no run instructions in README; package named `nextjs_tailwind_shadcn_ts` | repo root | BL-603/604 | Open |
| M8 | Non-cryptographic license keys (`Math.random`) | `licenses/route.ts` | BL-114 | Open |
| M9 | Duplicated aggregation/color logic across dashboard/analytics/insights/views | multiple files | — | Open |
| M10 | AI insights not persisted (no AISummary table) | `ai/insights/route.ts` | BL-202 | Open |

## 🟢 Low

| ID | Issue | Files | Status |
|---|---|---|---|
| L1 | package.json name/version are scaffold defaults; footer version hardcoded "v1.0.3" | `package.json`, `sidebar.tsx` | Open |
| L2 | Missing favicon/OG metadata polish | `app/layout.tsx`, `public/` | Open |
| L3 | ESLint wholesale rule disables | `eslint.config.mjs` | Open |
| L4 | No accessibility audit; some icon-only buttons rely on aria-labels inconsistently | UI components | Open |
| L5 | `seed.ts` starts with destructive `deleteMany` on all models | `prisma/seed.ts` | BL-605 |
| L6 | Empty `mini-services/` referenced by build scripts; `.zscripts` removed in sandbox re-sync | repo | Open |
| L7 | `docs/` + `worklog.md` removed from working tree during sandbox re-sync (2026-08-02) — git history retains them | — | Open |

---

## Escalation rules

- C1–C4 must be **Fixed before any deployment or listing** (blocking).
- H1–H11 targeted for Sprint 01/02.
- Medium/Low items are tracked in Backlog with effort estimates.
