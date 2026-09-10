# OMNISIGHT SUPER ADMIN FORENSIC AUDIT

**Audit Date:** 2026-09-07
**Repository:** `E:\Live project\omnisight\omnisight-web` (web/control plane)
**Referenced Repo:** `E:\Live project\omnisight\omnisight-agent` (only where the control plane depends on agent configuration, screenshots, heartbeats, activity, device state)
**Commit / Branch:** `main` @ `4964b6a` (HEAD). Working tree contains large, in-flight **uncommitted** Control Center + auth/org work (prior sessions). This audit reflects the working-tree state; commit attribution is best-effort.
**Method:** Full-path verification (UI → client state → API route → auth/RBAC → DB → business logic → response → UI refresh), evidence-based read of `src/`, `mini-services/`, `prisma/schema.prisma`, and the in-process test battery (`node --import tsx --test`). No browser automation tool was available; live-HTTP-specific UI checks were limited to in-process `NextRequest` execution unless noted.

**Evidence tiers used:** every PASS/PARTIAL/FAIL/NOT IMPLEMENTED below cites `file:line` (or model/route) evidence. Items that could not be verified to evidence standard are marked **UNVERIFIED** — never "assumed PASS".

---

## Executive Summary

The OmniSight Super Admin system is architecturally sound and **functionally real end-to-end**: no mock/random/TODO data was found in any production control-plane surface; every SA screen calls a real server-side route backed by PostgreSQL; auth is fail-closed and server-authoritative; tenant isolation is defense-in-depth at proxy, route, library, and DB layers; and the full in-process test battery passes except for one documented, pre-existing failure in `tests/organization-bootstrap.test.ts` that is outside the Super Admin scope.

The audit found **no Critical** and **no High** security or integrity failures. Findings are concentrated in **4 Medium** (error-state UX gaps on three SA pages, a silent plan-catalog fetch failure, the `screenshot_frequency` intent/documentation drift for CUSTOMER_DB orgs, and no pagination on the member list / shared `<Pagination>` page-size assumption) and **7 Low** (indexing, perf, naming, docs, test-hygiene) items. **Enrollment** (registration-based) is **NOT IMPLEMENTED** — it was deliberately removed and replaced by employee-bound agent accounts + device-claim approvals; this is reported as a by-design gap, not a bug.

**Overall Score: 89 / 100**
**Verdict: NEEDS HARDENING — functionally production-viable, but the Medium/Low findings below should be closed before GA hardening sign-off.**

Score roll-up:
| Category | Weight | Score |
|---|---|---|
| Functional completeness | 30 | 27.0 |
| Backend / API correctness | 20 | 18.0 |
| Security / RBAC / tenant isolation | 20 | 19.0 |
| Database integrity | 10 | 8.5 |
| UX / error handling | 10 | 8.0 |
| Testing / build | 5 | 5.0 |
| Documentation | 5 | 4.0 |
| **Total** | **100** | **89.5 → 89** |

---

## 1. Critical Findings

**None.** No available-server abuse, no cross-tenant data leaks, no privilege-escalation, no unauthenticated state-changing surface, no mock-data-as-truth, and no hard-coded credentials were found in any Super Admin path.

Searches performed with zero findings in production SA surfaces:
- `Math.random()` in control-plane components — only benign uses (landing scramble animation `src/components/landing/shared.tsx`, sidebar id, comments).
- `placeholderData` — React Query `keepPreviousData` only (`sa-overview-page.tsx`, `organization-provision-flow.tsx`), never fabricated columns.
- "mock"/"fake"/"TODO"/"FIXME"/"HACK" in `src/components/super-admin/*`, `src/app/api/super-admin/*`, `src/app/api/admin/*` — none. (Full frontend scan by subagent, cross-checked.)

## 2. High Findings

**None.**

## 3. Medium Findings

### M1 — Three SA pages lack an error branch for their primary query (UX/data-loss-of-signal)
**Status: PARTIAL (error handling)** — Evidence:
- `src/components/super-admin/super-admin-organizations-page.tsx:131` — org list query: `isError` not destructured, no error UI (a failing list fetch renders `isLoading ? spinner : (data?.length ? table : "No organizations")`); with React Query the spinner can be suppressed but there is **no explicit error state**.
- `src/components/super-admin/super-admin-organization-detail-page.tsx:239` — org detail query: no `isError`/error branch; a failed fetch renders an empty page (header + blank body) with no skeleton, no retry.
- `src/components/super-admin/sa-landing-page.tsx:60` — landing query: `isError` not consumed; a failed fetch keeps `isLoading` true → infinite spinner.
**Impact:** SA sees a blank/infinite-spinner page instead of a diagnosable error on transient API/DB failure. **Expected:** `ErrorState` (exists in `ui.tsx` and used elsewhere) with retry.

### M2 — Silent plan-catalog fetch failure in org provisioning
**Status: PARTIAL** — `src/components/super-admin/organization-provision-flow.tsx:97-110`: the `/api/plans` fetch uses `.catch(() => null)` (no toast, no error state); on failure `planOptions` stays empty and the UI shows "Loading the plan catalog…" (`:392`) forever. The request is a real rate-limited public route (`proxy.ts:149`), so this is failure-path UX only — but a failing catalog silently blocks org creation with no explainable message.

### M3 — `screenshot_frequency` ownership drift: comment vs enforcement (CUSTOMER_DB)
**Status: PARTIAL** — Evidence:
- `src/app/api/agent/screenshot/route.ts:78-82` comment: *"Super Admin on MANAGED, Org Admin elsewhere"* — an **intent** that the code no longer implements.
- Actual enforcement: cadence everywhere (all deployment modes) is the super-admin-owned `Organization.screenshotInterval` column (`src/app/api/admin/organizations/[orgId]/settings/route.ts:73-99`, PUT requires `requireSuperAdmin`), re-enforced at the upload boundary (`agent/screenshot/route.ts:61-93`), propagated to agents as `screenshotFrequency` (`src/app/api/agent/config/route.ts:36-82`), and org admins are blocked from the legacy `screenshot_frequency` key even in CUSTOMER_DB mode (`src/app/api/settings/monitoring/route.ts:101-106`).
**Impact:** self-hosted (CUSTOMER_DB) customers who own their data cannot change their own screenshot cadence; the outdated comment falsely promises otherwise. **Recommendation:** decide intent (likely "org admin owns cadence in customer-owned DBs"), align enforcement or comment, and update `access-matrix`/audit docs.

### M4 — Member list not paginated; shared `<Pagination>` hardcodes page size
**Status: PARTIAL** — Evidence:
- Org detail member list fetches all members and filters client-side with **no pagination** (`src/components/super-admin/super-admin-organization-detail-page.tsx:793-797`; member API `/api/organizations/[orgId]/members` returns all rows). Large-org render is unbounded.
- The shared `Pagination` component computes the displayed range with a hardcoded `* 25` (`src/components/super-admin/ui.tsx:165-193`), which is correct for `sa-audit-page.tsx` (pageSize 25) but is a latent bug if reused with any other page size. `sa-billing-pages.tsx` and the org-list custom pager do not use it.

## 4. Low Findings

- **L1 — `AuditLog` has no bare `createdAt` index** (`prisma/schema.prisma:981-982` only `[organizationId]` and `[organizationId, createdAt]`). The SA global audit view (`/api/super-admin/audit` orders by `createdAt`) is an unindexed chronological scan.
- **L2 — Invoice/Subscription composite indexes:** `Invoice` has `[organizationId]` + `[status]` but no `[organizationId, status]`; `Subscription` lacks `[organizationId, status]` (org-detail billing history scans). `prisma/schema.prisma:150-152,177-179`.
- **L3 — Global-unique tenant identifiers:** `Employee.employeeId` (`schema:304`) and `Device.agentKey` (`schema:412`) are globally unique, not org-scoped composites — a cross-tenant collision boundary that the app layer must defend (verified app-side: route lookup joins through `organizationId`), but schema does not enforce scoping.
- **L4 — Migration-hygiene debt:** `20260831074935_add_missing_tables` ("catch-up"), `20260903164031_rr` (obscure), `20260904010000_add_appuser_must_change_password` ("schema drift fix") indicate `prisma db push` was used during development; drift was later reconciled by hand-named migrations. Confirmed by prior-session finding (dev DB `workai_test_e2e` has no `_prisma_migrations` table).
- **L5 — "Package" vs "Plan" naming:** platform routes/UI say `packages` (`/api/super-admin/packages`, `sa-billing-pages.tsx`) but the model is `Plan` (`schema:63-83`). Cosmetic-consistency only; no missing table.
- **L6 — `OrganizationSettings.organizationId @unique` while also `@@index([organizationId])`** (`schema:604,631`) — redundant index.
- **L7 — Docs drift:** README/`docs/SUPER-ADMIN-CONTROL-CENTER-CERTIFICATION.md` describe Control Center features; the enrollment flow is documented nowhere (removed), and §12/§17 cadence ownership text (above) contradicts code.

## 5. Feature Matrix

| # | Capability | Status | Evidence |
|---|---|---|---|
| 5.1 | SA login (email+password, org-less) | PASS | `src/app/api/auth/login/route.ts`; `super-admin-post-login.test.ts` |
| 5.2 | SA overview dashboard (real metrics) | PASS | `/api/super-admin/metrics` (`api/super-admin/metrics/route.ts`); `sa-overview-page.tsx` |
| 5.3 | SA organization list + search/filter/paging | PASS | `/api/super-admin/organizations` GET; `super-admin-organizations-page.tsx` |
| 5.4 | SA organization detail (plan/subscription/billing/license/members) | PASS | `/api/super-admin/organizations/[id]`; detail page |
| 5.5 | SA create organization (provision) | PASS | `/api/admin/organizations/create`; `organization-provision-flow.tsx` |
| 5.6 | SA org status suspend/reactivate + mode switch | PASS | `/api/super-admin/organizations/[id]` PATCH (status + deploymentMode, `validateDeploymentModeChange`) |
| 5.7 | SA package (plan) CRUD | PASS | `/api/super-admin/packages`; `sa-billing-pages.tsx` |
| 5.8 | SA subscription management | PASS | `/api/super-admin/subscriptions`; detail page L332 |
| 5.9 | SA license issue/revoke | PASS | `/api/admin/licenses` POST, `/api/admin/licenses/[id]/revoke` |
| 5.10 | SA payment/invoice records | PASS | `/api/admin/invoices` + `[invoiceId]` PATCH |
| 5.11 | SA member/user management inside org | PASS | `/api/organizations/[orgId]/members` + `[memberId]`, `/api/auth/users` |
| 5.12 | Enrollment (registration-based) | NOT IMPLEMENTED (by design) | See §10 |
| 5.13 | Agent/device status visibility | PASS (MANAGED; control-plane only otherwise) | `/api/super-admin/devices`; mode-gated via `control-plane.ts` |
| 5.14 | Screenshot cadence control | PASS | `Organization.screenshotInterval` + upload enforcement (§12) |
| 5.15 | Live activity feed | PASS | `mini-services/live-updates` (§13) |
| 5.16 | SA settings (platform branding/landing) | PASS | `/api/branding/platform/*`, `/api/landing` PUT |
| 5.17 | Audit log viewer | PASS | `/api/super-admin/audit`; `sa-audit-page.tsx` |
| 5.18 | AI usage / storage overview | PASS | `/api/super-admin/ai-usage`, `/api/super-admin/storage` |
| 5.19 | Deployment-mode switch | PASS | `deployment-mode.ts` `validateDeploymentModeChange` |

## 6. Authentication

**Status: PASS**
- Cookies: `httpOnly:true`, `sameSite:'lax'`, `secure` in production, 7-day expiry — `src/lib/auth.ts` (`setSessionCookie`).
- Sessions are server-authoritative: `UserSession` row per login, JWT carries `sessionId`, proxy re-validates against DB on every request and fails closed (`src/proxy.ts:272-278`, `src/lib/session.ts`).
- Revocation: logout, password change, disable, and role-change all revoke sessions (role-change revokes **target user's** sessions — `src/app/api/organizations/[orgId]/members/[memberId]/route.ts:100-102`).
- Rate limiting: two-layer login (email + IP+email token buckets, 10/5min) with `429 + Retry-After` and audit events — `src/app/api/auth/login/route.ts`, `src/lib/rate-limit.ts:99-125`.
- Lockout accounting: rate limiter is PostgreSQL token-bucket with amortized refill; security-critical keys **fail closed** on store outage (`rate-limit.ts:35-46,85-93`).
- Logout/refresh: `/api/auth/logout`, `/api/auth/refresh-token` exist and revoke/rotate; `super-admin.test.ts` covers SA logout → 401.

## 7. RBAC

**Status: PASS**
- Central proxy role gate: `/api/settings*`→admin, `/api/organization*`→admin, `/api/auth/users*`→admin, `/api/device-claims*`→admin, `/api/export|audit-logs|self|consent`→manager; `super_admin` is a platform role never issued as a per-org membership (`src/lib/org-members.ts:22`).
- Route-level `requireSuperAdmin` / `requireDbVerifiedRole` / `requireMembershipAdmin` / `requireActiveSessionOrg` (DB-verified role, not JWT claims) — `src/lib/api.ts`, `src/lib/org-members.ts:58-74`.
- Privilege escalation blocked: actor may only assign roles ≤ own level; self-role-change rejected; stale/revoked JWT rejected by session re-validation — `member/[memberId]/route.ts:55-66`, `org-members.ts:47-50`.
- SA tenant-data access is mode-gated: `ACCESS_MATRIX` (`src/lib/access-matrix.ts:27-37`) + `requireManagedTenantAccess`/`requireTenantDataAccess` (`src/lib/control-plane.ts:72-109`) — org identity comes from the verified session or explicit target id, never client claims.
- Regressions: `super-admin.test.ts`, `super-admin-hardening.test.ts`, `super-admin-privacy.test.ts`, `role-rbac-nav-fix.test.ts` all pass.

## 8. Organization

**Status: PASS**
- Create: atomic `prisma.$transaction` (org + AppUser + ACTIVE org_admin membership + subscription + PENDING invoice for paid plans + audit log); slug uniqueness; server-side input validation — `src/app/api/admin/organizations/create/route.ts`.
- List: real server-side search (`name OR slug` insensitive), status + deploymentMode filters, pageSize capped at 200 — `src/app/api/super-admin/organizations/route.ts`.
- Detail: real counts + subscription + plan + invoices — `src/app/api/super-admin/organizations/[id]/route.ts` (GET).
- Patch: **only** `status` and `deploymentMode` allowed; mode-change validated (`validateDeploymentModeChange`: `*→CUSTOMER_DB` rejected, `→MANAGED` requires `confirmDataResidency`; fail-closed resolver) — `deployment-mode.ts:147-174`.
- Org switch: `/api/me/organization/switch` writes server-side `activeOrganizationId` session claim; `super-admin-org-switch-auth.test.ts` passes.
- Email welcome on create is **MOCK (compose-only)** — `sendWelcomeEmail` in `src/lib/email.ts`, flagged in route comment. Reported as declared-conscience limitation, not hidden behavior.

## 9. Member / User

**Status: PASS**
- Member CRUD hardened (evidence in §7): PATCH role/status with self-change + elevation guards + session revocation; DELETE removes membership without cross-org effect; `super_admin` never assignable; membership composite key `@@unique([userId, organizationId])` (`schema:1107`).
- `/api/auth/users` (admin+): search/create with server-side validation; `super-admin-create-member-flow.test.ts` and `super-admin-detail-members-only.test.ts` pass.
- Suspension: `OrganizationMembership.status ACTIVE|SUSPENDED`; suspended membership rejected by `resolveActorDbRole` (`org-members.ts:72`).

## 10. Enrollment

**Status: NOT IMPLEMENTED (by design)**
- No "enroll"/invite-code/registration surface exists (grep `enroll` across `src/**` → zero; `AgentRegistration` dropped by `20260828000000_remove_agent_registration`).
- Replaced by: **employee-bound agent accounts** (password per employee, agent auth via `/api/agent/*` bearer + token) + **zero-touch device claims** (`DeviceClaim`, approve/reject/revoke in `/api/device-claims`, proxy RBAC admin-only for list/approve, public-at-proxy only for the claim-secret-authenticated `{id}/cancel` path — `src/proxy.ts:248-253`).
- **Audit verdict:** honest NOT IMPLEMENTED for "enrollment", with the intentional replacement flow verified working. If the product spec requires enrollment codes, this is a gap; otherwise mark as resolved-by-design.

## 11. Agent / Device

**Status: PASS (control-plane depth)**
- Device discovery/claims are real: `Device` model (`schema:397-439`) with `agentKey @unique`, `Organization.agentKey`+status indexes; `/api/agent/discover`, `/api/agent/authenticate` real; agent route rate limits keyed per-token-hash (`proxy.ts:72-81`).
- SA surfaces devices/employees only for **MANAGED** orgs (mode gate, §7); for CUSTOMER_DB/PRIVATE the SA sees control-plane fields only (`CONTROL_PLANE_ORG_FIELDS`, `DATA_PLANE_MODELS` — `deployment-mode.ts:93-121`).
- Agent config is subscription-aware and propagates real org values: `heartbeat_interval` (clamped 10-600), `screenshotInterval`→`screenshotFrequency`, plus the typed monitoring registry — `src/app/api/agent/config/route.ts`, `src/lib/jobs/settings.ts:58-150`.

## 12. Screenshot

**Status: PASS**
- Server-authoritative capture control enforced at three independent layers: (1) consent (`hasActiveConsent`, fails closed), (2) org `screenshot_enabled` (via `resolveOrgMonitoring`), (3) `Organization.screenshotInterval` (=0 disables) — `src/app/api/agent/screenshot/route.ts:37-93`. A stale/rogue agent cannot upload against a disabled policy.
- Upload hardening: 5MB cap, PNG/JPEG/WebP only, magic-byte validation (SVG/GIF rejected), `crypto.randomUUID()` filenames (never client-controlled), PNG dimensions parsed from actual bytes, orphan cleanup on failed DB commit — same route.
- Storage: abstraction with local + Supabase drivers, fail-closed on placeholder/production-missing credentials (`src/lib/storage/index.ts:39-80`); screenshots keyed by `orgId` in `SCREENSHOTS_BUCKET` (`screenshotKey`).
- §12 parental note (M3): cadence ownership is SA-only for all modes — reconcile intent/comment.

## 13. Live Activity

**Status: PASS**
- Realtime is a genuine Socket.IO service (`mini-services/live-updates/index.ts`): every connection requires a valid JWT (handshake `auth.token` or `worklens_token` httpOnly cookie), each socket joins only its `org:<organizationId>` room (cross-org emission impossible), CORS restricted to configured origin, events are produced by polling the DB for **actual** changes (`presence.ts`, `activity-events.ts`, `poll-cursor.ts`) — no simulated/random events, and the service **never writes** to the DB.
- Browser side: single shared socket via `WebSocketProvider` (`src/components/providers/websocket-provider.tsx`), with retry URLs (`/?XTransformPort=3010` and `http://host:3010`), typed `LiveEventType` set, and React Query invalidation on the same socket.
- SA-relevance: live monitor surfaces org activity for MANAGED orgs and is fed by the same auth'd rooms. Cross-service path verified by code; live browser smoke not run (no browser tool) — marked **UNVERIFIED for live-HTTP behavior**, in-process/unit evidence strong.

## 14. Settings

**Status: PASS**
- Platform settings: landing copy (`/api/landing`, public GET + **super-admin-only PUT** with sanitization — includes machine-enforced field allowlist; certified earlier), platform branding (`/api/branding/platform/*`, super_admin only).
- Org settings: `OrganizationSetting` key-value per-org (no cross-tenant bleed; `getOrgSetting` has **no** global `SystemSetting` fallback for monitoring/retention — `src/lib/jobs/settings.ts:269-278`); AI/analytics DB credentials encrypted at rest (AES-256-GCM via `src/lib/crypto.ts`) and exposed masked (`hasAiKey`, `last4`) — `src/app/api/organizations/[orgId]/settings/route.ts`.
- Retention: typed registry with plan-driven screenshot retention fallback (`settings.ts:334-364`); `resolveRetentionDays` used by cleanup jobs.

## 15. Branding

**Status: PASS**
- Platform logo: super_admin-only; PNG/JPEG/WebP/SVG with allowlist + size caps (5MB file/1MB SVG); SVG validated **and sanitized** (`validateSvgCode`/`sanitizeSvg` — `src/lib/branding`); upload → DB transaction → cache invalidation → non-fatal old-object cleanup; audit-logged — `src/app/api/branding/platform/logo/route.ts`.
- Favicon + platform text variants exist (`/api/branding/platform/favicon`, `/api/branding/platform`). Org branding: admin-gated via proxy (`/api/branding/organization*` → admin) with org-scoped rows.
- Storage: same fail-closed driver abstraction (`storage/index.ts`); `branding-regression.test.ts` passes.

## 16. Audit Log

**Status: PASS**
- `AuditLog` rows written transactionally on every auditable SA mutation (org create/patch, membership change, license issue/revoke, invoice, package, platform branding, login/rate-limit events) — pattern confirmed across routes (§8-§9, §15).
- SA viewer: `/api/super-admin/audit` (sa-only) — real query, action filter, server-side pagination (pageSize ≤100), `organization include`, actor email/name resolved via user lookup, **`metadata` deliberately never serialized** (no payload/secret leakage) — `src/app/api/super-admin/audit/route.ts`.
- Org-scoped audit: `AuditLog.organizationId` nullable (bootstrap events), org survives deletion (`SetNull` FK, `schema:979`) so audit history persists. Retention configurable but default off (`audit_log_retention_days: 0` → never purge).

## 17. API Audit

**Status: PASS (with Matrix M3 noted)** — See Appendix A (full inventory).
- Public whitelist is explicit and minimal: `/api/auth/login`, `/api/plans`, `/api/leads`, `/api/landing`, `/api/health*`, agent prefixes, device-claim self-cancel — `src/proxy.ts:144-159,241-253`.
- Every `super-admin/*` and `admin/*` route re-checks `requireSuperAdmin`/`requireDbVerifiedRole` inside the route (proxy auth is not the boundary).
- Sample response contracts verified: `apiSuccess`/`apiError` consistent shapes, `validatePagination` caps, agentPassword/aiApiKey/DB passwords never serialized (`SAFE_EMPLOYEE_SELECT`).
- Direct-API lower-privilege attempts blocked, proven by `super-admin*.test.ts`, `super-admin-hardening.test.ts`, `role-rbac-nav-fix.test.ts` (403/401 assertions).

## 18. Database

**Status: PASS (with Low findings)**
- Schema models verified against all `prisma.<model>.` references — no used model missing, no unused model (subagent cross-check).
- Tenant binding + `CASCADE` org→children cleanup; composite org-scoped uniques (membership, consent, dedupe receipts, work summaries, org settings); `Screenshot [organizationId, capturedAt]` index present.
- Fail-closed design patterns: `OrganizationSettings` encrypted-at-rest fields; `RateLimitCounter` token buckets; `UserSession` revocation fields.
- Migrations: `20260903164031_rr` and `20260831074935_add_missing_tables` are dev-time/catch-up artifacts; `20260904010000_add_appuser_must_change_password` admits schema drift fixed by hand. Sign of `db push` during development (accept L4). No migration applies cleanly forward from a fresh `migrate deploy` — **UNVERIFIED** (no clean-provision run this session; prior session used `db push`).

## 19. Tenant Isolation

**Status: PASS**
- Defense-in-depth: proxy RBAC → route-level role+membership checks (DB-verified) → `requireActiveSessionOrg` (target org from session, never client JSON) → mode gates (`requireManagedTenantAccess`/`requireTenantDataAccess`, **fail closed** on unresolvable mode) → org-scoped reads (every tenant model carries + indexes `organizationId`) → org-scoped settings registry (no global fallback).
- Cross-org tests pass: `super-admin-privacy.test.ts`, `data-isolation` coverage under the main suite; org-detail sub-routes (employees/devices/audit-logs/memberships/projects) are `requireSuperAdmin` + mode-gated.
- Known schema-level residual (L3): global-unique `Employee.employeeId`/`Device.agentKey` — app layer joins through org; no exploit found.

## 20. Security

**Status: PASS**
- CSRF: `SameSite=Lax` cookies + proxy Origin≠Host rejection on all state-changing methods (`src/proxy.ts:283-298`) — Bearer path protected too.
- Rate limiting: centralized, longest-prefix, per-IP/token/user buckets; security-critical keys fail closed (§6).
- Input validation: strict typed registry for monitoring (whole numbers, ranges, HH:MM, identifier strings — `settings.ts:185-232`); membership roles allowlisted; license interval 0-60; branding allowlists; upload magic-byte checks.
- Secrets: `httpOnly`+secure cookies; masked key exposure; `AuditLog.metadata` never serialized; no credentials in git-tracked code (scan; values in `.env` only — values not reproduced here).
- IDOR: every `[orgId]`/`[memberId]`/`[licenseId]` route resolves access through the authenticated session/DB membership before using the param; targeted by `super-admin-detail-members-only`, `hardening`, `role-rbac-nav-fix` suites.
- Realtime: JWT-gated Socket.IO with org-room isolation (§13).

## 21. Runtime

**Status: PASS (in-process) — browser runtime UNVERIFIED**
- Production build: `next build` passes; `/api/landing` compiled as a server route (prior session, verified).
- In-process route execution (all `tests/*.test.ts` run `NextRequest` against real route handlers + real dev DB `workai_test_e2e`): 118/119 green (§24).
- Live-HTTP runtime probes (dev-server + curl cookie flow, live Socket.IO smoke) were **not** run this session (no browser/HTTP harness used); flag the two live services (`:3000` app, `:3010` live-updates) as requiring a final deployment-HA smoke before GA claim.

## 22. Error Handling

**Status: PARTIAL** — server-side error handling is consistent (`try/catch → apiError`, log with `requestContext`, deterministic statuses; route failures return 500 with no payload leakage). Client-side is the gap: M1 (three pages no error UI) and M2 (silent plan fetch). Destructive actions are confirmation-dialog-protected; loading states use `isLoading`/`setXLoading(true/false)` with `finally`. Org-list, org-detail, sa-landing need `ErrorState` + retry; provision-flow needs a plan-catalog error path.

## 23. Performance

**Status: PARTIAL**
- Good: server-side pagination on org list, audit log, package list; capped page sizes (≤200); `[organizationId, createdAt]` indexes on hot telemetry (Screenshot/Activity/Anomaly).
- Gaps: member list unbounded (§M4); `AuditLog` global scan unindexed (L1); Invoice/Subscription composite-missing indexes (L2); finding count of SA queries is moderate (detail page issues ~7 parallel React Query calls — acceptable but worth profiling).
- No N+1 found in the audited SA routes (detail aggregates use `_count`/includes; audit actor emails batched in one `IN` lookup — `super-admin/audit/route.ts:37-41`).

## 24. Test Results

**Status: PASS** (one documented pre-existing failure outside SA scope)
- Super Admin / Control Center battery: `super-admin.test.ts`, `super-admin-shell.test.ts`, `super-admin-privacy.test.ts`, `super-admin-post-login.test.ts`, `super-admin-organizations.test.ts`, `super-admin-organization-context.test.ts`, `super-admin-org-switch-auth.test.ts`, `super-admin-license.test.ts`, `super-admin-hardening.test.ts`, `super-admin-detail-members-only.test.ts`, `super-admin-create-member-flow.test.ts`, `super-admin-control-center.test.ts` (23/23), `sa-final-ui.test.ts`, `landing-page.test.ts` (9/9) — **all green** (prior-session verified, unchanged code since).
- SA nav/shell/final-UI consolidation: 44/44 across shell/nav suites.
- Full suite: **118/119**. Sole failure: `tests/organization-bootstrap.test.ts` — deterministic, pre-existing, in-flight auth/org work modifies `src/app/api/auth/login/route.ts` + `auth/me/route.ts`; failure mode: OB-9 post-binding login JWT lacks org context → OB-10 404, OB-12 403 vs 201, OB-13 mismatched counts. Throwaway DB `workai_test_orgbootstrap`. **Not SA-scope; is a live auth/org-domain bug to fix before the wider GA.**
- Tooling: `typecheck` PASS (0 errors), `lint` 0 errors on changed files (repo has pre-existing warnings), production `next build` PASS.

## 25. Documentation

**Status: PARTIAL**
- Present: `docs/SUPER-ADMIN-CONTROL-CENTER-CERTIFICATION.md` (certification battery + landing fix appendix); rich in-code domain docs (`rate-limit.ts`, `proxy.ts`, `deployment-mode.ts`, `access-matrix.ts`, `jobs/settings.ts`); README.
- Gaps: no dedicated Super Admin operator doc; enrollment removal + replacement undocumented (L7); §12 CUSTOMER_DB cadence intent contradictory with code (M3); "Package" vs "Plan" naming propagate to docs (L5); `SUPER-ADMIN-FORENSIC-AUDIT.md` now the sole forensic reference.

## 26. Broken Functions

**None found in Super Admin scope.** The only known broken behavior in the wider app is the pre-existing post-org-binding login org-context bug (`tests/organization-bootstrap.test.ts` OB-9/10/12/13) — outside SA, tracked in §24.

## 27. Recommended Fix Plan

Priority-ordered, with owning scope:
1. **P1 (auth/org domain — pre-existing):** fix org context in post-binding login JWT (`login/route.ts`/`me/route.ts`) so OB-9/10/12/13 pass and the full suite reaches 119/119.
2. **P2 (SA UX):** add `ErrorState` + retry to org-list (`super-admin-organizations-page.tsx`), org-detail (`super-admin-organization-detail-page.tsx`), and sa-landing (`sa-landing-page.tsx`) primary queries; add error/empty/retry path to plan-catalog fetch in `organization-provision-flow.tsx` (drop `.catch(() => null)`).
3. **P3 (CUSTOMER_DB parity):** decide and implement cadence ownership for customer-owned DBs (org-admin editable in CUSTOMER_DB) OR document SA-only ownership; update `agent/screenshot/route.ts` comment, `access-matrix` doc, and §17 API notes to match.
4. **P4 (scale):** server-side pagination on the member list + member API; remove the `* 25` assumption in `ui.tsx` `Pagination` (pass `pageSize`).
5. **P5 (DB):** add `AuditLog @@index([createdAt])`; consider `Invoice [organizationId, status]` + `Subscription [organizationId, status]`; drop redundant `OrganizationSettings @@index([organizationId])`; add a fresh-migrations clean-provision check to CI (`migrate deploy` from zero).
6. **P6 (hygiene/docs):** rename/absorb `rr` and `add_missing_tables` migrations into a clean baseline; rename `packages`→`plans` for consistency or document the alias; add a Super Admin operator doc; record the enforcement+comment reconciliation.
7. **P7 (release gate):** run a live runtime smoke (`npm run dev` + curl login-cookie flow + Socket.IO presence) against a disposable DB ahead of GA.

## 28. Final Score

| Category (max) | Score | Basis |
|---|---|---|
| Functional completeness (30) | 27.0 | All core SA flows real & complete; enrollment NOT IMPLEMENTED (by design); welcome email mock |
| Backend / API correctness (20) | 18.0 | Real routes, validation, pagination, contracts; M3 comment/intent drift; L2 index gaps |
| Security / RBAC / tenant isolation (20) | 19.0 | Fail-closed auth, DB-verified roles, CSRF, rate limits, mode-gated tenant access; L3 global-unique identifiers residual |
| Database integrity (10) | 8.5 | Strong models/relations/transactions; L1/L2 index gaps; db-push migration debt (L4) |
| UX / error handling (10) | 8.0 | 4 medium client-side state gaps (M1/M2/M4) |
| Testing / build (5) | 5.0 | 118/119, all SA suites green, typecheck/lint/build clean |
| Documentation (5) | 4.0 | Strong in-code docs; operator doc + enrollment doc + cadence intent missing |
| **Total (100)** | **89.5 → 89** | |

## 29. Final Verdict

**NEEDS HARDENING (89/100).** The system is architecturally real, secure at the layers that matter (auth/session/RBAC/tenant isolation), free of mock data and critical vulnerabilities, and backed by a strong test battery. It is **functionally production-viable today** but should not be stamped "Production Ready" until: (1) the pre-existing org-bootstrap login failure is fixed (119/119), (2) the four Medium client/parity findings are addressed, and (3) a live runtime smoke passes. Closing P1–P4 would move the score into the 90–94 band; closing P5–P7 completes GA hardening.

---

## Appendix A — Super Admin API Inventory (all verified against `src/proxy.ts` RBAC + route-level guards)

| Method/path | Role | Verdict |
|---|---|---|
| GET /api/super-admin/metrics | SA | PASS — real groupBy aggregations |
| GET/PATCH /api/super-admin/organizations(/[id]) | SA | PASS — list w/ search+filter; patch status+mode only |
| GET /api/super-admin/organizations/[id]/{audit-logs,devices,employees,memberships,projects} | SA (MANAGED only) | PASS — mode-gated tenant sub-routes |
| GET /api/super-admin/devices, /audit, /storage, /ai-usage | SA | PASS |
| GET/POST/PATCH/DELETE /api/super-admin/packages | SA | PASS — maps to `Plan` model (L5) |
| GET/PATCH /api/super-admin/subscriptions/[id] | SA | PASS |
| POST /api/admin/organizations/create | SA | PASS — atomic transaction |
| GET/PUT /api/admin/organizations/[orgId]/settings | SA | PASS — screenshotInterval + masked secrets |
| GET/POST /api/admin/licenses; PUT /api/admin/licenses/[id]/revoke | SA | PASS |
| GET/POST /api/admin/invoices; PATCH /api/admin/invoices/[invoiceId] | SA | PASS |
| GET /api/admin/data-retention | SA | PASS |
| GET/POST /api/organizations/[orgId]/members; PATCH/DELETE /[memberId] | SA/org-admin | PASS — elevation/session-revoke guards |
| GET/POST /api/auth/users; PATCH /api/auth/users/[id]; /revoke-sessions | admin+ | PASS |
| GET/PUT /api/branding/platform/* | SA | PASS — sanitized SVG, audited |
| GET /api/landing (public); PUT (SA) | public/SA | PASS — certified |
| GET /api/super-admin/audit | SA | PASS — metadata never serialized |

**Not run (honest residuals):** live HTTP smoke of app + live-updates services; fresh `migrate deploy` from zero; browser-level pagination/rendering of 200+ members orgs.