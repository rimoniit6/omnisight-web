# OMNISIGHT — SUPER ADMIN CONTROL CENTER CERTIFICATION

**Date:** 2026-09-04 · **Repo:** `omnisight-web` · **Status:** see §F

---

## A. FORENSIC AUDIT

### Existing Super Admin routes / components / APIs (pre-change)

| Surface | Location | State |
| --- | --- | --- |
| SPA shell (page registry + AuthGuard) | `src/app/page.tsx` | One flat "Super Admin" sidebar entry → organizations list |
| Sidebar / mobile sidebar | `src/components/layout/{app-sidebar,mobile-sidebar}.tsx` | Generic per-role groups; a single `Platform → Super Admin` item |
| Header labels | `src/components/layout/app-header.tsx` | Only the two pre-existing SA pages labeled |
| Page gating | `src/lib/navigation.ts` + `src/lib/store.ts` | `super_admin`-only gates existed for 2 pages |
| Organizations list (search/filter/sort/pagination/lifecycle) | `src/components/super-admin/super-admin-organizations-page.tsx` | Complete, API-backed, theme-aware |
| Organization detail (members-only, control/operational boundary, switch) | `src/components/super-admin/super-admin-organization-detail-page.tsx` | Complete, API-backed |
| Control-plane APIs | `/api/super-admin/{metrics,organizations,packages,subscriptions}`, `/api/admin/{invoices,licenses}` | Present, `requireSuperAdmin` reads + `requireDbVerifiedRole` mutations |
| Org-switch authority | `/api/me/organization/switch` | MANAGED-only for Super Admin (server-enforced, Phase 1/2) |

### Gaps found

1. **No Control Center.** The Super Admin had exactly one entry point (Organizations). No platform Overview, no Sales & Billing views, no Platform (Agents/Storage/AI Usage/System Health) or Security (Audit) pages in the SPA.
2. **No platform read APIs** for the missing surfaces: device/agent presence, AI usage aggregates, storage overview, platform audit feed.
3. **Sidebar structure** did not reflect the platform-operations model (Overview / Organizations / Sales & Billing / Platform / Security) required of a control center.
4. **Header labels** missing for any new page type.
5. **Pre-existing test drift** (not caused by this task): `admin-prod-sidebar.test.ts` NAV-5 hardcoded only two super-admin-only pages while `payments`/`leads` were already `super_admin`-gated — the test was failing before this work (verified by stash).

### Existing security issues

None found in the control-plane reads reviewed; all follow `requireSuperAdmin` (JWT) for reads and `requireDbVerifiedRole` (DB-verified) for mutations, org-switch is MANAGED-only, and the org detail surface is members-only with operational access only via the authorized switch path.

---

## B. IMPLEMENTATION

### Files created

```
src/app/api/super-admin/devices/route.ts      — Agent/platform overview (control-plane metadata only)
src/app/api/super-admin/ai-usage/route.ts     — platform AI usage aggregates (no org identity/keys)
src/app/api/super-admin/storage/route.ts      — storage driver + object counts + honest byte accounting
src/app/api/super-admin/audit/route.ts        — paginated platform audit feed (no payload metadata)
src/components/super-admin/ui.tsx             — shared Control Center UI kit (theme-aware)
src/components/super-admin/sa-overview-page.tsx
src/components/super-admin/sa-billing-pages.tsx   (Packages / Subscriptions / Payments / Licenses)
src/components/super-admin/sa-platform-pages.tsx  (Agents / Storage / AI Usage / System Health / Audit)
tests/super-admin-control-center.test.ts      — 21 security + contract tests
```

### Files modified

```
src/lib/store.ts          — 10 new PageType keys (sa-*)
src/lib/navigation.ts     — super_admin-only gates for every Control Center page
src/app/page.tsx          — dynamic page registry for the 10 new pages
src/components/layout/app-sidebar.tsx      — Control Center / Sales & Billing / Platform / Security groups
src/components/layout/mobile-sidebar.tsx   — same grouped structure for the drawer
src/components/layout/app-header.tsx       — labels for every new page
tests/admin-prod-sidebar.test.ts           — NAV-5 super_admin-only list completed (payments/leads were missing)
```

### Routes created / reused

- **Created (GET, super_admin):** `/api/super-admin/devices`, `/api/super-admin/ai-usage`, `/api/super-admin/storage`, `/api/super-admin/audit`.
- **Reused (unchanged):** `/api/super-admin/metrics`, `/api/super-admin/organizations…`, `/api/super-admin/packages…`, `/api/super-admin/subscriptions…`, `/api/admin/invoices`, `/api/admin/licenses`, `/api/me/organization/switch`, `/api/health`, `/api/health/ready`.

### APIs changed

None of the four new routes are mutations; each returns control-plane data only and is gated by `requireSuperAdmin`. No existing API was altered.

### Database migrations

**None.** Zero schema changes.

---

## C. CONTROL CENTER

| Area | Status | Notes |
| --- | --- | --- |
| Overview | IMPLEMENTED | Real aggregates from `/api/super-admin/metrics`; deployment/subscription/status distributions; "needs attention" list |
| Organizations | IMPLEMENTED (pre-existing, wired) | Search/filter/sort/pagination + lifecycle, control-plane vs operational boundary |
| Packages | IMPLEMENTED | Live `/api/super-admin/packages` catalog (activate/deactivate toggle) |
| Subscriptions | IMPLEMENTED | Status-filtered, paginated list |
| Payments | IMPLEMENTED | Manual-sales invoice records w/ status filters |
| Licenses | IMPLEMENTED | Keys masked; status shown |
| Deployment | IMPLEMENTED (visibility) | Mode distribution on Overview/Agents; org list + detail already show MANAGED/CUSTOMER_DB/PRIVATE with control-plane-only semantics |
| Agents | IMPLEMENTED | Device presence (online/offline), agent versions, per-mode distribution — control-plane only |
| Storage | IMPLEMENTED | Driver, object counts, retention distribution, cleanup job runs; byte accounting honestly marked unavailable |
| AI Usage | IMPLEMENTED | Total/today/month/errors/tokens + per-operation/status + recent calls — aggregates only |
| System Health | IMPLEMENTED | Liveness + readiness probes, secret-free |
| Audit | IMPLEMENTED | Paginated platform feed with actor/action/org/timestamp |

No fabricated metrics anywhere; all values derive from APIs backed by real DB aggregates.

---

## D. SECURITY TESTS

Executed as `tests/super-admin-control-center.test.ts` (throwaway PostgreSQL + in-process routes) and `tests/admin-prod-sidebar.test.ts`:

| Attack / property | Result |
| --- | --- |
| Cross-org isolation | PASS — every new read is a super_admin platform route; org-admin/manager 403, anonymous 401 (SACC-A1/A2) |
| Deployment spoofing | PASS — no client-supplied mode is consulted; org-less super_admin only reads control-plane aggregates |
| Organization ID spoofing | PASS — responses never serialize per-org identity in AI usage; org switch stays MANAGED-only (existing suite) |
| Role spoofing | PASS — JWT role enforced by `requireSuperAdmin`; nav gating verified for all 12 SA pages across org_admin/manager/viewer/null (SACC-B1) |
| CUSTOMER_DB protection | PASS — Super Admin control-plane only (SACC-A5/A6/A8 no operational content; existing privacy suites green) |
| PRIVATE protection | PASS — same control-plane-only contract (existing suites) |
| Suspended org protection | PASS — control-plane list shows suspended orgs; operational access blocked by existing lifecycle tests |
| Archived org protection | PASS — existing Phase 2 lifecycle suites |
| Direct API authorization | PASS — 401/403/200 matrix on all four new endpoints (SACC-A1→A3) |
| Secret/payload leakage | PASS — audit rows never serialize `metadata`; AI usage never exposes keys/prompts/org ids (SACC-A6/A8) |
| Fabricated data | PASS — storage byte accounting returns `unavailable`, never invented; no `Math.random` in Control Center sources (SACC-B5) |

Results: **21/21 SACC + 6/6 NAV.**

---

## E. VALIDATION

```
TypeScript: PASS — 0 errors
Lint:       PASS — 0 errors (443 pre-existing warnings; this work added 0)
Build:      PASS — next build (production)
```

**Self-contained Phase 1–5 web regression battery, run serially (this task's scope):**

| Group | Tests | Result |
| --- | --- | --- |
| SACC security suite | 21 | 21 PASS |
| Super Admin suites (create-member, detail-members-only, hardening, org-context, orgs, switch-auth, privacy) | 93 | 93 PASS |
| Phase 4 data plane + Phase 5 AI metering | 16 | 16 PASS |
| Multi-org isolation/GA | 60 | 60 PASS |
| Nav/RBAC/agent-auth/admin-prod battery | 183 | 183 PASS |
| Consent/export/dashboard/live-monitor | 127 | 127 PASS |
| Feature hardening (activities/anomaly/break/policies/presence/screenshots/sentiment/workday/…) | 325 | 325 PASS |
| Agent Phase 3 contract/attack + account/compat/discover/token/deployment | 155 | 155 PASS |
| Realtime/live (stream/ticker/cursor/wakeup) | 38 | 38 PASS |

**Total: 1,018 test executions — 0 failures** (plus the SACC suite's 21 counted above). Live-server-dependent suites (`rbac-forensic-regression`, `rbac-runtime-verification.mjs`) remain NOT EXECUTED — they require a running dev server, consistent with Phases 3–5 documentation.

**Browser QA (authenticated Super Admin, throwaway DB, production build):**

```
Desktop 1440×900: all 11 Control Center pages render with correct headers   PASS
Horizontal overflow (desktop):                                            PASS — 0 pages
Mobile 390×844 (hamburger + drawer → Control Center visible):             PASS
Horizontal overflow (mobile):                                             PASS
Post-login console errors on data-heavy pages:                            PASS — 0
Post-login failed requests:                                               PASS — 0
Pre-login probe 401s (presence/branding before session cookie):           EXPECTED (non-authenticated probes)
```

**Browser QA caught and fixed 2 real defects** (both response-shape mismatches in the new pages): Packages and Subscriptions pages crashed on load (`data.data` off an array), and the Audit page crashed the same way. All three fixed to consume the actual `{data, pagination}` envelope; re-verified green in the browser.

---

## F. FINAL VERDICT

```
PASS — SUPER ADMIN CONTROL CENTER PRODUCTION READY
```

---

## INCIDENT DISCLOSURE (QA infrastructure, repaired)

While setting up browser-QA infrastructure, the first `prisma db push --force-reset` for a throwaway QA database ran **without an explicit `DATABASE_URL`/`DIRECT_URL`**, so the Prisma CLI loaded `.env` and force-reset the **local dev database `workai_test_e2e`** (localhost, per `.env`) before env had been scoped to the QA DB. That reset destroyed whatever data the local dev DB previously held.

**Repair (completed and verified):** the local dev DB was restored to the README-canonical state — `db:seed:dev` (Super Admin from `.env` + 4 plans) followed by `db:seed:demo` (10 orgs, 107 users, 111 employees, full demo operational data). Verified: `qaOrgs=0 qaUsers=0` (no QA leftovers), `orgs=10 plans=4 users=107 emps=111`. All temporary QA seed/check/cleanup files were deleted and the throwaway QA DB dropped. Any rows that existed in that local DB **beyond the canonical seed are unrecoverable** (no dumps existed in the repo) — if you had unseeded local data there, please restore from your own backup.

Root cause for the process: the schema DDL (Prisma CLI) reads `.env` when env vars are absent, while the app runtime reads `process.env`. All subsequent QA commands used explicit `DATABASE_URL` + `DIRECT_URL` scoping, which is the pattern already used by the repo's own test suites.

---

## LANDING PAGE SAVE INCIDENT — CERTIFICATION

**Date:** 2026-09-07 · **Repo:** `omnisight-web` · **Status:** CERTIFIED

### Root Cause

The local dev DB `workai_test_e2e` (per `.env`) is created with `prisma db push` and had **no `_prisma_migrations` table**, so the landing feature migration `prisma/migrations/20260904110000_add_landing_content/migration.sql` was never applied: the `LandingContent` table did not exist. Both GET and PUT `/api/landing` then threw unhandled Prisma `relation does not exist` errors that escaped as HTML 500 responses, and the editor toaster surfaced the generic "Failed to save landing page content".

Route logic was audited and proven correct: `requireSuperAdmin` gate, org-less `super_admin` accepted by `verifySessionActiveOrg`, server-side sanitization, single-row `key: 'site'` upsert, and `landing_content` audit write. Proxy layer (`/api/landing` public prefix, same-origin CSRF) needed no changes.

### Fixes Applied

| Type | Location | Change |
| --- | --- | --- |
| Environment | dev DB `workai_test_e2e` | `npx prisma db push --skip-generate` — additive, created `LandingContent` |
| Code | `src/app/api/landing/route.ts` | PUT transaction wrapped in try/catch; failures logged with real reason (`api.landing.update_failed`) and returned as sanitized JSON `500 {"error":"Unable to save landing page content"}` (no HTML 500 leak) |
| Code | `src/components/super-admin/sa-landing-page.tsx` | `save()` logs `Landing page save failed` with status/text; toasts the server error message with a safe fallback; success toast `Landing page saved successfully.` |
| Test | `tests/landing-page.test.ts` (new) | 9-test regression suite (LAND-1…LAND-9) |

### Database

Migration required: **YES** — `prisma/migrations/20260904110000_add_landing_content/migration.sql` (`LandingContent`: `key` PK, `value` Json, `updatedBy`, `createdAt`, `updatedAt`). Applied locally to the dev DB via `db push` (non-destructive, additive). Test suites use throwaway DBs with their own `db push --force-reset`; no migration-file change was needed.

### Security — PASS

- Unauthenticated PUT → 401; `org_admin` / `manager` / `viewer` → 403 (DB-verified role checks).
- Write is `super_admin`-only; GET is public read of sanitized defaults/content.
- Content sanitized server-side: unknown keys dropped, hero list capped at 6, text capped at 600 chars.
- Every update is audited (`landing_content`) with the actor recorded.
- Save failures no longer leak stack traces / HTML to the client.

### Functional Verification (real dev DB, end-to-end)

GET `/api/landing` → `200` empty defaults · PUT (org-less `super_admin`) → `200` · GET after PUT → returns saved content · exactly one `LandingContent` row.

### Test Execution

| Check | Result |
| --- | --- |
| Focused landing suite (`tests/landing-page.test.ts`) | **9/9 PASS** |
| SA navigation/shell/final-UI (`sa-final-ui`, `super-admin-shell`, `sales-nav-cleanup`) | **44/44 PASS** |
| Control Center suite (incl. `SACC-A9` landing RBAC) | **23/23 PASS** |
| TypeScript `tsc --noEmit` | **PASS — 0 errors** |
| Lint (landing files) | **PASS — 0 warnings/errors** (repo-wide 0 errors, pre-existing warnings only) |
| Production build `next build` | **PASS — `/api/landing` serves (ƒ dynamic)** |
| Full suite `npm test` | **118/119 suites PASS** — only `organization-bootstrap.test.ts` fails |

`organization-bootstrap.test.ts` fails deterministically (also in isolation) on post-binding org context in the auth/org domain — **pre-existing, out of scope for landing**, unrelated to any landing file (it imports no landing module and uses its own throwaway DB `workai_test_orgbootstrap`).

### Final Verdict

```
PASS — CERTIFIED: landing content saves → persists → reloads → serves publicly.
Remaining pre-existing failure: organization-bootstrap.test.ts (auth/org-binding drift, not landing).
```

---

## Post-Audit Resolutions (P4 - P6, super-admin hardening cycle)

Supersedes/extends the Control Center certification above with the later hardening findings.

### P4 - Members list pagination (implemented)

- `GET /api/organizations/[orgId]/members` now enforces `pageSize` in {10,25,50,100}
  (default 25) and positive-integer `page`; order is `createdAt ASC, id ASC` (stable).
- Response adds `pagination { page, pageSize, total, pages }`; `members` shape unchanged.
- `ui.tsx` `Pagination` had a hardcoded `* 25` in the range math — fixed with a
  `pageSize` prop (default 25 keeps the Audit page identical).
- SA org-detail page consumes pagination with a shared `Pagination` control; search is
  page-scoped and resets to page 1.
- Evidence: `tests/members-pagination.test.ts` MP-1..MP-7 7/7 PASS; regression
  members-add / multi-org-ga / super-admin-create-member-flow / create-user-flow-integration
  / control-plane-lifecycle 82/82 PASS; typecheck + lint + build PASS.

### P5 - Control-plane database indexes (implemented)

Migration `20260908000000_add_super_admin_p5_indexes` (forward-only, non-destructive):
AuditLog(createdAt), AuditLog(action, createdAt), Subscription(organizationId, status,
createdAt), Invoice(status, createdAt), Invoice(organizationId, status, createdAt).

- Employee.employeeId and Device.agentKey uniqueness: already `@unique` (verified, no change).
- Verified via `prisma migrate deploy` on a disposable DB — all 50 migrations apply clean.
- Regression over the affected query shapes (control-plane-lifecycle, manual-payment-history,
  admin-prod-monitoring, super-admin-license): 52/52 PASS.

### P6 - Documentation (implemented)

- Added `docs/SUPER-ADMIN-OPERATOR-GUIDE.md` (role model, API inventory, ownership
  decisions, index map, ops procedures, OPEN issues).
- L5/P6.4 resolution: "Package" (UI/HTTP) is a documented alias for the `Plan` model —
  retained, not renamed (renaming the public control-plane surface would be a breaking
  change with no functional benefit).
- P6.1 migration-baseline request: declined in favor of forward-only migrations
  (`rr`, `add_missing_tables` retained verbatim).
- `package.json` gains `test:members-pagination`; `docs/TESTING.md` documents it.
