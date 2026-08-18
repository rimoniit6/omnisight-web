# WorkLensAI — Master Production Audit

**Date:** 2026-08-07 · **Scope:** 254 TS/TSX files, 47,392 lines, 108 API routes, 1 page.tsx
**Method:** 7 parallel domain audits + independent verification of all Critical claims

## Overall Score: 36/100 — NOT production-ready

| Domain | Score | Domain | Score |
|---|---|---|---|
| Architecture | 38 | UI | 72 |
| Database | 32 | Theme | 58 |
| API | 16 | CSS | 62 |
| Security | 14 | Pages | 35 |
| Next.js | 22 | Components | 65 |
| Performance | 45 | TypeScript | 38 |
| Prisma | 45 | Code Quality | 55 |
| **Production Readiness** | **30** | | |

---

## Summary of findings by severity

- **Critical:** 13 · **High:** 18 · **Medium:** 24 · **Low:** 15

---

## CRITICAL ISSUES

### CR-1. ~90 of 108 API routes are unauthenticated — full PII/surveillance data breach
- **Files:** `src/app/api/**/route.ts` (67 routes verified with zero auth references; only 18 import auth modules; 4 check Authorization inline). No `middleware.ts` exists.
- **Exposed:** `employees` (PII: names/emails/phones + `agentPassword` plaintext), `screenshots` (returns `ocrText`/`aiAnalysis`), `sentiment`, `audit-logs`, `insights`, `analytics`, `alerts`, `settings` (returns `ai_api_key` plaintext), `self/*`, `search`, `organization`, `export/*`, `import/*`.
- **Unauthenticated writes:** `POST /api/employees`, `PUT /api/settings`, `POST /api/agent-registrations/[id]/approve`, `POST /api/import/*`.
- **Root cause:** `withAuth`/`withAuthAndRole` helpers exist (`src/lib/api.ts:63-95`) but are imported by **zero** files; `'use server'` directives (43 files) give false sense of server-only protection.
- **Impact:** Any anonymous visitor can read employee monitoring data, OCR'd screenshots, audit logs, stored AI API key — and write. **Total breach of the product's core data.**
- **Fix:** Add `src/middleware.ts` enforcing JWT on all `/api/*` (allowlist: `/api/auth/login`, `/api/agent/*`); apply `withAuthAndRole` per-route; remove `'use server'` from route handlers.

### CR-2. Secrets and database committed to git
- **Files:** `.env` (tracked since "Initial commit", contains `JWT_SECRET=worklens-ai-jwt-secret-key-2025-super-secure`, `SUPER_ADMIN_PASSWORD=Admin@2025`), `db/custom.db`, `prisma/db/custom.db` — all in `git ls-files`.
- **Root cause:** `.gitignore` has `.env*` but files were force-added/added before ignore; `git rm --cached` never run.
- **Impact:** Anyone with repo or history access can forge JWTs for any user and read the entire monitoring DB (bcrypt hashes, agent tokens, activity).
- **Fix:** `git rm --cached .env db/custom.db prisma/db/custom.db`; add `.db` to `.gitignore`; **rotate JWT_SECRET and super-admin password now**; generate random secret; purge history (BFG/filter-repo) if repo is/was shared; add `.env.example`.

### CR-3. Hardcoded super-admin credentials fallback
- **File:** `src/lib/auth.ts:193-197` — `getSuperAdminCredentials()` falls back to `admin@worklens.ai` / `Admin@2025`; `src/lib/seed.ts:53-54,73-79,163` creates `admin123`/`manager123`/`viewer123` and agent passwords `pass@emp-001`…
- **Impact:** With no rate limiting, default creds are brute-forceable to full `super_admin`; re-seeding resets the super-admin password.
- **Fix:** Remove fallbacks; throw if `SUPER_ADMIN_PASSWORD` unset (like `getJWTSecret` already does). Never delete+recreate in production.

### CR-4. Agent passwords stored & compared in plaintext
- **Files:** `prisma/schema.prisma:88` (`agentPassword String?`), `src/app/api/agent/authenticate/route.ts:28`, `agent/register/route.ts:42` — `agentPassword !== password` direct string compare.
- **Impact:** DB read (CR-2/CR-1) yields working agent credentials; attackers enroll devices and upload fake activity/screenshots — corrupting the monitoring data the product sells.
- **Fix:** bcrypt-hash agent passwords, compare with `verifyPassword`, migrate existing rows.

### CR-5. Unauthenticated SSRF + AI-key theft via `/api/ai-provider/test-connection`
- **File:** `src/app/api/ai-provider/test-connection/route.ts` — anonymous POST `{baseUrl, apiKey}` → server fetches `${url}/models` (SSRF oracle, incl. cloud metadata IPs) → persists `ai_api_key`/`ai_base_url` in plaintext to `systemSetting`, after which authenticated AI features (`src/lib/ai-provider-helper.ts:142-421`) send employee activity/screenshot/OCR data to the attacker's server.
- **Fix:** Admin auth required; URL allowlist (no private ranges except localhost/ollama); never persist API key from unauthenticated callers; encrypt or env-store the key.

### CR-6. `/api/auth/me` is broken — `verifyJWT` not awaited
- **File:** `src/app/api/auth/me/route.ts:13` — `const payload = verifyJWT(token);` (Promise) → `payload.userId` is `undefined` → route 500s. Also `auth/logout/route.ts:28-31`. Session is **never server-validated**; the UI trusts `localStorage` alone; role gating is client-side theater.
- **Fix:** `await verifyJWT(token)`.

### CR-7. Zero database indexes — every query is a full scan
- **File:** `prisma/schema.prisma` — no `@@index` anywhere. `Activity` (the largest table) time-range queries scan the whole table.
- **Impact:** Degrades with data; dashboard/analytics queries get slower linearly.
- **Fix:** Add indexes: `Activity(organizationId, timestamp)`, `Activity(employeeId, timestamp)`, `Device(organizationId)`, `AppUser(email)`, `AuditLog(organizationId, createdAt)`, `Screenshot(employeeId, capturedAt)`, etc.

### CR-8. Mock/fabricated data in production code paths
- **Files:**
  - `src/app/api/screenshots/[id]/analyze/route.ts:82-117` and `batch-analyze/route.ts:101-109` — `generateSmartMock()` fabricates OCR text + AI analysis when VLM fails, **persists it to the DB**, plus hardcoded `blurScore: 0.85`.
  - `src/app/api/anomalies/detect/route.ts:71,93,123,151` — `Math.random()` confidence scores.
  - `src/components/ai-provider/ai-provider-page.tsx:145-166` — hardcoded `MOCK_USAGE` (fake token stats + request logs) rendered as real billing data (`:274,736-738,781,846`).
- **Impact:** False monitoring data in an employee-monitoring product is worse than no data; misleading billing figures.
- **Fix:** Return explicit `analysis_failed` status instead of synthetic content; derive usage from a real table or remove section.

### CR-9. Single-page SPA — Next.js routing unused
- **File:** `src/app/page.tsx` (the **only** page file; 26 feature pages are `dynamic(..., { ssr: false })` switched via Zustand `currentPage` string, `:46-74`). No URLs, no deep links, no back/forward, no per-route metadata, no code splitting by route.
- **Fix:** Convert each `*-page.tsx` to `src/app/<feature>/page.tsx`; replace `setCurrentPage()` with `router.push()`; add `(auth)` route group.

### CR-10. `typescript.ignoreBuildErrors: true` masks 122 type errors
- **File:** `next.config.ts:5-7` (also `reactStrictMode: false`, `:8`). `npx tsc --noEmit` → **122 errors** (TS2339 ×43, TS2322 ×42). Includes real runtime bugs: `anomalies/detect/route.ts:17-18` `include: { device: true }` (relation is `devices` → `emp.device` is undefined at runtime), `sentiment/analyze/route.ts:143` undefined `productivityTrend` (ReferenceError), `activities/daily/route.ts:79-94` `never[]` type construction.
- **Fix:** Remove `ignoreBuildErrors`, enable `reactStrictMode`, fix the 122 errors, add `typecheck` script + CI gate.

### CR-11. Tenant isolation broken
- **Files:** `src/lib/api.ts:121-123` (`getOrgId` uses **client-supplied** `?organizationId=` query param, overriding session org); `auth/login/route.ts:59-66` + `auth/me/route.ts:27-34` fall back to `db.organization.findFirst()`; `employees/route.ts:85` hardcodes `findFirst()` org; **32 sites** use `findFirst()` with no `where`; only 49/108 routes even reference `organizationId`.
- **Impact:** Second tenant → cross-tenant data leakage. Even after CR-1, isolation remains broken.
- **Fix:** Derive org exclusively from verified session; remove query-param override and `findFirst()` fallbacks; Prisma query-extension to always inject `organizationId`.

### CR-12. JWT in localStorage — XSS = total takeover; sessions never revoke
- **Files:** `src/lib/store.ts:78-105` (`worklens-auth` localStorage), `src/hooks/use-auth-fetch.ts:31-57` (auto-refresh within 5 min → token alive indefinitely with sliding window), `logout` only clears storage (JWT valid 7 more days; no blacklist/jti).
- **Impact:** Any XSS/malicious extension drains the token; revoked users keep access; demoted roles keep old role.
- **Fix:** httpOnly+SameSite cookie transport; server-side session/revocation; bound sliding window; force logout to revoke.

### CR-13. Screenshot viewer is a placeholder — headline feature missing
- **File:** `src/components/screenshots/screenshots-page.tsx:612` (`{/* Placeholder preview */}`), `:979` — shows a `<Monitor>` icon + gradient; `filePath` fetched but never rendered; **zero `<img>`/`next/image` in the repo**.
- **Fix:** Add `/api/screenshots/[id]/image` serving route; render with `next/image`; or remove feature.

### CR-14. Caddyfile open proxy (bonus, infra)
- **File:** `Caddyfile:1-13` — any request to port 81 with `?XTransformPort=<port>` reverse-proxies to `localhost:<port>`, host header forwarded. **Fix:** pin ports, remove dynamic handler.

---

## HIGH ISSUES (top 18 of 34)

| # | File | Problem | Fix |
|---|---|---|---|
| H-1 | `src/app/api/settings/route.ts:5-40` | Unauthenticated read/write of all settings incl. plaintext `ai_api_key` | `withAuthAndRole('admin')` + never serialize secrets |
| H-2 | `src/app/api/auth/login/route.ts:18` | Loads **all users** per request (`findMany`); no rate limit/lockout; `max_login_attempts` setting exists only as seed data | Direct email query; per-IP+account throttle |
| H-3 | `src/app/api/anomalies/detect/route.ts` | N+1: 6 queries × employee; same in `analytics` and `self/devices` | Batch queries / `include` |
| H-4 | 13+ routes | Unbounded full-table reads (alerts, insights, analytics, audit-logs stats, `ai-analysis` mega-fetch) — no `take`/pagination | Add pagination + `take` caps |
| H-5 | whole codebase | **Zero `$transaction`** — approve/device/toggle/import are multi-step writes | Wrap in `$transaction` |
| H-6 | `src/app/api/upload/avatar/route.ts:27-28,72-89` | IDOR: query-param `id` with no ownership/org check → overwrite any avatar; `id` flows into filename → path traversal (`../x.png`) | Verify org/self; validate id; random filenames |
| H-7 | `src/app/api/agent/authenticate/route.ts:62,111-123` | Agent token: one shared token per employee, plaintext in DB, force-offlines all devices on re-auth, no revocation | Hash tokens, per-device tokens, revoke endpoint |
| H-8 | `mini-services/live-updates/index.ts:12-20` | Unauthenticated WebSocket (`origin: '*'`) broadcasts real employee names | Token-gated socket middleware + same-origin CORS |
| H-9 | `src/lib/ai-provider-helper.ts:187,372` | Google AI API key passed in URL query string (lands in proxy logs) | Header-based auth |
| H-10 | `next.config.ts` | No security headers (CSP/HSTS/X-Frame-Options/X-Content-Type-Options) | Add `headers()` |
| H-11 | `src/app/api/employees/[id]/route.ts` | Returns plaintext `agentPassword` to any caller (compounds CR-1) | Never serialize agentPassword |
| H-12 | 25 files >500 lines (`projects-page.tsx` 1,784) | God components: fetch+state+dialogs+charts+forms inline; SRP/SoC violation | Split by feature |
| H-13 | `src/components/auth/login-page.tsx:58-234` | 40 inline styles, hardcoded hex grays, zero dark-mode support — off design system | Rebuild with shadcn Card/Input/Button + tokens |
| H-14 | `src/lib/chart-theme.ts:4-26` + 6 chart components | Hardcoded hex chart colors (`#10b981`…) diverge from `--chart-*` tokens; 3 different dark-tooltip colors | Drive from CSS vars; one tooltip style fn |
| H-15 | `src/components/ai-provider/ai-provider-page.tsx:618,775,809,829,917,950,1076` | `text-[oklch(0.555_0.163_163.5)]` literals instead of `text-primary` (dark mode ignored) | Replace with tokens |
| H-16 | `src/app/globals.css:124-499` | ~375 lines of copy-pasted "Falcon Admin Template" CSS; 13 defined-but-unused classes; 11 used-but-undefined classes (`stagger-reveal`, `animate-float`, `gradient-mesh` — broken animations) | Prune/replace with tokens |
| H-17 | `src/app/layout.tsx:36-41` | `enableSystem={false} defaultTheme="light"` vs `sonner.tsx:7` default `"system"` — conflicting theme decisions | Align: `enableSystem` or `theme ?? 'light'` |
| H-18 | `eslint.config.mjs` + `tsconfig.json:13` | 25+ rules disabled (no-unused-vars, no-explicit-any, exhaustive-deps); `noImplicitAny: false` negates `strict`; lint reports only 9 problems | Restore rules; remove override; add `noUnusedLocals` |

---

## MEDIUM ISSUES (24) — selected

- `src/components/auth/user-management.tsx` etc.: ~40 unused imports (no-unused-vars off) — `app-header.tsx` ×6, `user-management.tsx` ×4
- `src/hooks/use-mobile.ts:14`, `tour-overlay.tsx`, `command-palette.tsx`: 9 lint errors, all `react-hooks/set-state-in-effect` (cascading renders)
- `src/hooks/use-auth-fetch.ts:136-137`: `window.location.href = '/login'` — route doesn't exist (hard reload + dead redirect)
- 26 duplicated type names: local `Employee` in 4 files (drifts — `employee-table.tsx:228` fails tsc), `ExportColumn` in 3 divergent shapes (root of `never[]` errors), 13 websocket event types duplicated incl. typo `UsbEventEvent`
- `src/lib/agent/auth.ts:96-99`: trusts `x-forwarded-for` verbatim — spoofable IP attribution
- `src/app/api/screenshots/ocr-search/route.ts:27-46`: `$queryRawUnsafe` (parameterized — safe from injection, but unauthenticated + not org-scoped, LIKE escaping incomplete)
- `src/app/api/break-status/route.ts:56,81` + `summary/route.ts:34,60`: `string | null` forced to `string`
- `src/lib/seed.ts` runs `deleteMany` on all tables — running it in prod wipes data + resets super-admin password
- 279 sub-11px font usages (`text-[10px]` ×228, `text-[9px]` ×46, `text-[8px]` ×5) — fails WCAG 1.4.3
- Status-badge hex pattern duplicated in ≥12 files with drift (`dark:bg-emerald-900/30` vs `/25`)
- 129 inline styles / 161 hex literals across 37/23 files
- z-index chaos: 50 / 100 / 101-102 / 30-40 four different scales
- `globals.css:74` — `--sidebar-primary-foreground` copy-paste bug (should be `oklch(0.985 0 0)`)
- Magic numbers everywhere: refetch `30000` ×4, `60000` ×4, thresholds 80/50 vs 90/70 vs 85/70 vs 0.8/0.6
- 32 sites `db.organization.findFirst()` (ties to CR-11)
- `next-auth@4.24.11` with Next 16 — unsupported combo; app doesn't even use it (custom JWT)
- `use-toast.ts:12` `TOAST_REMOVE_DELAY = 1000000` (shadcn quirk)
- `package.json` no `typecheck`/`test` scripts; `tests/` has only 3 shell scripts; zero unit tests

---

## LOW ISSUES (15) — selected

- `src/app/globals.css.bak` committed (14 KB duplicate); footer `© 2025 WorkLensAI v1.0.0` vs package version 0.2.1
- `src/app/api/audit-logs/route.ts:1` — literal `'server';` typo (missing `use`, dead code)
- 61 non-null assertions (risky: `agent/tamper/route.ts:45`, `agent/screenshot/route.ts:31` — `employee` is optional in `validateAgentToken`)
- `verifyJWT` doesn't check `iat`/`nbf`, alg not restricted to HS256 explicitly
- `@ts-ignore` ×1 (`self-portal-page.tsx:244`)
- `.next/dev/types` included in tsconfig `include` — compile graph polluted
- 31 `console.log` (all in seed.ts — fine); 160 `console.error` (mostly legit API logging)
- Duplicate CSV implementations: `lib/csv-export.ts` vs `lib/export.ts`
- 40 `<button>` without `type`; 18 icon-only buttons, several without `aria-label`
- `bg-primary/8` non-standard opacity; `w-[18px] h-[18px]` should be `size-4.5`
- `globals.css:455-459` global `*:focus-visible` outline overrides shadcn ring system
- `text-muted-foreground/50` low-contrast instances
- Seed `any` ×19 (dev-only — acceptable, keep isolated)
- Stale `src/app/api/route.ts` (orphan root handler)
- No CSP/security headers (H-10); 0 metadata on all pages (ties to CR-9)

---

## Verified positive controls

- bcryptjs 12 rounds; password policy ≥8 chars + complexity enforced in `change-password`
- HMAC-SHA256 JWT correctly implemented; secret enforces ≥16 chars and throws
- Agent bearer tokens CSPRNG 64-char, 24h expiry
- Root `layout.tsx` idiomatic (next/font Geist, ThemeProvider, QueryProvider, Toaster)
- 66 shadcn/ui primitives, consistent Card/Button/Badge usage overall
- 159 Skeleton usages across 32 files; EmptyState component exists
- 0 `!important`; 0 TODO/FIXME/HACK; `any` rare (21); `unknown` discipline good at boundaries
- WebSocket provider has proper cleanup, reconnect caps, singleton ref
- React-query discipline: 57 useMemo / 63 useCallback / 36 memo; keys present in spot-checks

---

## Prioritized Remediation Roadmap

### Phase 1 — Security lockdown (do first, ~1 week)
1. CR-1: `middleware.ts` global JWT gate + allowlist; apply `withAuthAndRole`; delete `'use server'` from route handlers
2. CR-2: `git rm --cached .env db/*.db prisma/db/*.db`; rotate JWT_SECRET + super-admin password; add `.env.example`; `.db` to gitignore
3. CR-3: remove credential fallbacks (throw instead)
4. CR-6: `await verifyJWT` in `auth/me` + `auth/logout`
5. CR-5/H-1: lock `/api/ai-provider/test-connection` + `/api/settings` (admin, allowlist, redact keys)
6. CR-4: bcrypt agent passwords
7. H-2: rate-limit login + direct user query
8. CR-14: pin Caddyfile ports
9. H-10/L: security headers (CSP, HSTS, XFO, XCTO)

### Phase 2 — Data integrity & correctness (~1 week)
10. CR-8: remove `generateSmartMock`, `MOCK_USAGE`, `Math.random` confidence
11. CR-7: add indexes (Activity/Device/AuditLog/AppUser/Screenshot)
12. H-3/H-4: N+1 fixes + pagination caps on 13+ routes
13. H-5: `$transaction` on multi-step writes
14. CR-11: org derived from session only; kill query-param override + `findFirst()` fallbacks
15. H-6: avatar IDOR fix
16. CR-10: remove `ignoreBuildErrors`; fix all 122 tsc errors (incl. `anomalies/detect` include typo, `productivityTrend` ReferenceError, `activities/daily` never-type); enable `reactStrictMode`
17. H-18: restore eslint rules + tsconfig strictness; add `typecheck` script

### Phase 3 — Session hardening + routes (~1-2 weeks)
18. CR-12: httpOnly cookie transport + revocation
19. CR-9: SPA → real App Router routes; `error.tsx`/`loading.tsx`/`not-found.tsx`; per-page metadata
20. H-7: agent token lifecycle (hash, per-device, revoke)
21. H-8: gate the WebSocket feed
22. H-9: AI key via header
23. CR-13: real screenshot serving + viewer

### Phase 4 — Architecture & code quality (~2-3 weeks)
24. H-12: split 25 god components (>500 lines)
25. CR-3: seed hardening — never wipe prod; hash agent passwords in seed
26. H-13/H-14/H-15/H-17: theme unification (login page, chart tokens, oklch literals, theme system)
27. H-16: prune Falcon CSS; fix undefined classes
28. M: dedupe types (shared `src/types/`), websocket types, `ExportColumn`
29. M: consolidate CSV libs, kill dead imports, magic-number constants file
30. Add unit/integration tests (vitest) + CI gate (typecheck + lint + test)

### Phase 5 — Polish (ongoing)
31. F8: typography floors (≥11px), status-badge variants, aria-labels, z-index scale, focus-ring consistency
32. `.env.example`, README security docs, version/date branding sync
33. Multi-tenant test org + integration test suite

---

## Detailed sub-reports
- `API-AUDIT.md` — per-route auth/RBAC/validation/pagination table, 29 findings
- `DATABASE-AUDIT.md` — schema/queries/performance findings
