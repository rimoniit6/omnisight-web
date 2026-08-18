# HomeAgent Approvals — Read-Only Audit Report

**Date:** 2026-08-16 · **Scope:** Admin "Agent Approvals" section (sidebar: `agent-approvals`, Security group, `PAGE_MIN_ROLE = admin`)
**Method:** Read-only code review + read-only DB queries. **Zero writes, zero code/DB/config changes.**

> Note: no literal "HomeAgent" string exists in `src/` or `desktop-agent/`. The feature is the **Agent Approvals** admin page with two tabs: **Device Claims** (zero-touch enrollment) and **Agent Registrations** (legacy enrollment).

---

## 1. Executive Summary

The Agent Approvals section is a production-grade, two-path enrollment-approval system:

- **PATH A (zero-touch, default):** the agent silently calls `/api/agent/discover` → server creates a pending `DeviceClaim` and issues a one-time secret → the admin assigns an employee (+ optional projects) and approves → the device authenticates with `deviceId + deviceSecret` → 24h `AgentToken` with silent re-auth.
- **PATH B (legacy):** the employee submits `employeeId + password` via `/api/agent/register` → admin approves the `AgentRegistration` → the agent authenticates with credentials.

The backend is notably well-engineered: org-scoped RBAC with cross-org 404 concealment, rate limits, one-active-device-per-employee enforced in a transaction, claim-secret-authenticated employee cancellation, fail-closed token validation, audit log + notification on every decision, and an exceptional test suite (~200 tests, 32 of them zero-touch-specific). The main weaknesses are **visibility**: no realtime updates (no WebSocket invalidation, no polling), a sidebar badge that ignores pending zero-touch claims, and lazy claim expiry that leaves stale "pending" rows that 422 on approval.

**Weighted score: 83/100 — production-ready core; visibility/realtime gaps.**

---

## 2. Scorecard

| Dimension | Weight | Score | Notes |
|---|---|---|---|
| Functional completeness | 25% | 9.5 | Both paths complete end-to-end, incl. cancel/revoke/reject/expiry |
| Backend correctness & security | 25% | 9.5 | Org-scoping, rate limits, transactions, fail-closed, no P0/P1 found |
| UI/UX | 15% | 7.0 | Clean tabs/dialogs; stale-pending confusion, no search, first-page-only stats |
| Realtime | 8% | 3.0 | No WS invalidation, no polling, badge ignores claims — manual refresh required |
| Test coverage | 17% | 9.5 | ~200 tests incl. concurrency, cross-org, fail-closed, rate limits |
| Documentation | 5% | 5.0 | No dedicated feature docs; good inline comments |
| Performance | 5% | 8.5 | N+1 free; pageSize unclamped on one route; stats page-1 only |
| **Weighted total** | | **83/100** | |

---

## 3. Feature Inventory

| Feature | Path | Where |
|---|---|---|
| Zero-touch discover (creates pending claim + one-time secret) | `POST /api/agent/discover` | `src/app/api/agent/discover/route.ts` |
| Legacy register (creates pending registration) | `POST /api/agent/register` | `src/app/api/agent/register/route.ts` |
| Authenticate PATH A (device secret) / PATH B (employee credentials) | `POST /api/agent/authenticate` | `src/app/api/agent/authenticate/route.ts` |
| List claims (org-scoped, status/page/pageSize, incl. employee+department+projects) | `GET /api/device-claims` | `src/app/api/device-claims/route.ts` |
| Approve claim (bind employee, dept from employee, projects, activate, audit, notify, one-active-device) | `POST /api/device-claims/[id]/approve` | `.../[id]/approve/route.ts` |
| Reject claim (reason + notification) | `POST /api/device-claims/[id]/reject` | `.../[id]/reject/route.ts` |
| Cancel claim (employee-side, claim-secret auth, idempotent) | `POST /api/device-claims/[id]/cancel` | `.../[id]/cancel/route.ts` |
| Revoke claim (approved → revoked, device deactivated) | `POST /api/device-claims/[id]/revoke` | `.../[id]/revoke/route.ts` |
| List registrations (org-scoped, paginated) | `GET /api/agent-registrations` | `src/app/api/agent-registrations/route.ts` |
| Approve registration (creates Device + audit + notification) | `POST /api/agent-registrations/[id]/approve` | `.../[id]/approve/route.ts` |
| Reject registration (reason + notification) | `POST /api/agent-registrations/[id]/reject` | `.../[id]/reject/route.ts` |
| Token validation (expiry, agentApproved, employee/account/org/device status) | `validateAgentToken` | `src/lib/agent/auth.ts:91` |
| Single-active-device rule (FOR UPDATE, 409 `ACTIVE_DEVICE_EXISTS`, zero-mutation) | `src/lib/agent/activation.ts` | `src/lib/agent/activation.ts` |
| Admin UI (tabs, QuickStats, approve/reject/revoke dialogs, employee combobox) | `agent-approvals-page.tsx` (~1173 lines) | `src/components/agent-approvals/agent-approvals-page.tsx` |
| Sidebar pending badge | `showBadge: true` (registrations only) | `src/components/layout/app-sidebar.tsx` |

---

## 4. Functional Status

- All 8 approval routes + 2 agent enrollment flows are implemented and wired end-to-end.
- **Live data (read-only query):** 1 organization, 1 employee, 1 device (`online`), **1 approved DeviceClaim**, **0 AgentRegistrations** → real-world usage is 100% zero-touch; the legacy tab has never been used in production data.

---

## 5. Approval Lifecycle

**DeviceClaim states:** `pending → approved | rejected | revoked | cancelled | expired`

| Transition | Guard | Side effects |
|---|---|---|
| discover → pending | one pending claim per device; revoked devices never re-register | one-time secret issued exactly once |
| approve | admin, org-scoped `findFirst` (cross-org → 404), status must be `pending`, `expiresAt` not passed | employee bound + `agentApproved=true`, dept from employee, ProjectMember rows, device activated, **second device deactivates first**, audit + notification (`entityType: device`) |
| reject | admin, org-scoped, `pending` | `rejected` + reason, notification |
| cancel | employee, claim-secret via `verifyClaimSecret`, `pending` | idempotent on `cancelled`; 409 otherwise |
| revoke | admin, rate-limited, org-scoped, `approved` | device → `inactive`, notification |
| expire | lazy only (checked on approve → 422, and on re-discover → fresh claim) | **no background job** |

**AgentRegistration states:** `pending → approved | rejected | expired`

| Transition | Guard | Side effects |
|---|---|---|
| register → pending | rate-limited, org from employee lookup | uniform 401 on failure |
| approve | admin, org-scoped, `pending` | `agentApproved=true`, **Device created** (`status: 'online'`), audit, notification (**no entityType/entityId**) |
| reject | admin, org-scoped, `pending` | reason + notification |

**Auth:** PATH A (`deviceId + deviceSecret`) or PATH B (`employeeId + password`) → 24h token; 409 `ACTIVE_DEVICE_EXISTS` is terminal (fixed message, never raw body); 404 "Device not found" → orphaned state → local credentials wiped, re-enrollment required; `validateAgentToken` fails closed (expired token deleted, revoked device 401).

---

## 6. API Audit

- ✅ Consistent `requireSessionOrg` (GET, `allowGlobal: true`) / `requireAdminOrg` (POST) pattern; cross-org ids indistinguishable from missing (404).
- ✅ Claim approve is rate-limited (`RATE_LIMITS.deviceClaimWrite`); discover/register/authenticate rate-limited; getClientIp spoof-resistant (rightmost x-forwarded-for).
- ⚠️ `GET /api/agent-registrations` pageSize is **unclamped** (raw `parseInt`); `GET /api/device-claims` clamps to 100. (P3)
- ⚠️ Registration approve/reject are **not rate-limited** (approve is the only admin mutation here without a limit). (P3)
- ✅ Error responses uniform (401/403/404/409/422 with exact `{ error }` bodies the agent matches on).

---

## 7. Database Audit (`prisma/schema.prisma`)

| Model | Key facts |
|---|---|
| `DeviceClaim` | organizationId, deviceId, claimSecretHash, status (plain String: pending/approved/rejected/revoked/expired/cancelled), employeeId?, approvedBy?, approvedAt, rejectedAt, rejectionReason, cancelledAt, cancellationReason, cancelledByDeviceId, expiresAt; relations: Device (Cascade), Employee (SetNull), Organization (Cascade); indexes org/status/employee/device |
| `AgentRegistration` | employeeId @unique, hostname, deviceName?, os/osVersion/processor/memory/ip/mac/agentVersion?, status (plain String), rejectionReason?, organizationId; indexes org/status/createdAt |
| `Device` | status default `'online'` (online/offline/inactive/maintenance/retired), employeeId?, agentKey @unique, lastHeartbeat? |
| `AgentToken` | token @unique, employeeId, deviceId?, expiresAt, lastUsedAt |

- ⚠️ All status fields are untyped strings — no DB-level enum/constraint (codebase-wide convention; enforced only in code). (P3)
- ✅ No schema issues found; indexes cover the query patterns used by the routes.

---

## 8. Security / RBAC Audit

- ✅ Org-scoped `findFirst` on every mutation — cross-org approve/reject/revoke is 404, never a hint.
- ✅ One-active-device enforced transactionally (`Employee` FOR UPDATE); 409 body is `{ error: "ACTIVE_DEVICE_EXISTS" }` exactly; zero-mutation on conflict (exhaustively tested, B-02).
- ✅ Client-supplied `employeeId`/`organizationId` ignored everywhere; org derived server-side (session/known device/enrollment-code hash).
- ✅ Enrollment codes stored hashed; claim secrets hashed, issued once; wrong secret → uniform 401; admin JWT ≠ agent session (AUTH-10/11).
- ✅ Approval never grants consent (ZT-9/10) — activity/screenshot uploads still fail closed until consent.
- ⚠️ **P2:** GET routes `allowGlobal: true` → an org-less super admin lists ALL orgs' claims/registrations but can never approve/reject/revoke any (`requireAdminOrg` requires an org-bound session). Inconsistent with MO-10 ("org-less super admin sees EMPTY business data").

---

## 9. UI/UX Audit

- ✅ Two clean tabs with status filters, QuickStats, approve/reject/revoke dialogs with reason, employee combobox (server-side `/api/employees/search`, org-scoped), framer-motion, toasts, invalidate-all after mutations.
- ⚠️ **P2:** Stale pending claims — an expired claim still renders "Pending Assignment"; approving it 422s. No `expired` filter option on either tab (configs exist at page lines 135/144), so expired rows are only visible under "All Status". No expiry time shown on claim cards.
- ⚠️ **P3:** QuickStats derive from the `all-stats` fetch = **first page only** (claims pageSize 20, registrations pageSize 10) → undercounts at scale; list itself is page-1 only with no pagination control.
- ⚠️ **P3:** No search by employee/device name in either tab.
- ✅ Revoke flow present for claims (reason dialog); ⚠️ legacy registrations have **no revoke path** in this section.

---

## 10. Realtime Audit

- ❌ **No realtime.** `ws-invalidation.ts` has no keys for `device-claims` / `agent-registrations`; the page has no `refetchInterval`, no polling, no WS subscription. New pending devices are invisible until a manual refresh or until the admin performs an action.
- ❌ Sidebar badge (`showBadge`) counts only **pending agent-registrations** — pending zero-touch claims never surface in navigation. (P2)
- ✅ Mutations DO invalidate `device-claims`, `agent-registrations`, `employees`, `devices`, `dashboard` — the loop is correct once a refresh happens.

---

## 11. Duplicate / Overlapping Features

| Overlap | Assessment |
|---|---|
| Approved claims ↔ Devices admin page (`/api/devices`) | Same `Device` rows; Devices page is the management surface (status, retire). Keep both — approval ≠ management — but lifecycle actions (deactivate vs revoke) should be reconciled (P3). |
| Employee details page device section | Read-only view of bound devices; no conflict. |
| Live Monitor event feed | May surface enrollment events; no admin action from there — fine. |

## 12. Unnecessary Features

- **Legacy PATH B (registrations tab):** zero production usage (0 rows), fully superseded by zero-touch + Phase 3 AgentAccount login. Keep for compatibility (it is tested and works), but consider a "legacy" banner. **Deprecate, don't remove.**

## 13. Dead / Unused Code

- `expired` status is half-wired: schema + UI configs exist, but no filter option and no expiration job → the state is nearly unreachable and invisible when it occurs.
- `useLiveUpdates` hook (`src/hooks/use-live-updates.ts`) is a legacy re-export of `useWebSocket` — deprecated shim, not dead.
- No dead routes found.

---

## 14. Test Coverage

| Suite | Tests | Covers |
|---|---|---|
| `zero-touch.test.ts` | 32 (ZT-1…32) | discover idempotency, rate limit, approve/reject, cross-org, no-consent-on-approve, one-active-device, PATH A/B auth, fail-closed revoke, token randomness, IP spoofing, reRegister DoS guard, concurrent approval |
| `claim-cancel.test.ts` | 13 (CC-1…13) | self-cancel, idempotency, wrong-secret 401, approved→409, cancelled cannot approve/reject, fresh claim after cancel, P2002 regression |
| `agent-existing-device-security.test.ts` | 21 | rediscovery ownership, forged ids ignored, revoked never rebound, disabled employee fail-closed, uniform 404 |
| `agent-active-device-backend.test.ts` | 13 | 409 semantics, zero-mutation snapshot, concurrency winner, expired-token edge, PATH A/B without AgentAccount, exact 409 body |
| `agent-auth-login.test.ts` | 23 | login, lockout after 5 fails, no-enumeration 401s, session expiry, JWT separation, org derivation, logout revoke |
| `agent-hardening.test.ts` | 26 | payload validation, enrollment-code org binding, token fail-closed, server-derived attribution |
| `device-status.test.ts` | 8 | heartbeat vs lifecycle status logic |
| `multi-org-isolation.test.ts` | 47 | tenant isolation across 25+ surfaces |
| `agent-account*.test.ts`, `super-admin.test.ts` | ~30 | account CRUD, admin approval UI-adjacent flows |

**Gaps:** no test for legacy approve's missing one-active-device interplay; no UI tests (repo-wide convention); QuickStats/page-1 behavior untested (UI-only).

---

## 15. Critical Findings

**No P0 (data loss / security breach) findings. No P1 (security or functional blocker) findings.**

---

## 16. Findings by Severity

### P2 (should fix)
1. **No realtime / no auto-refresh** — new zero-touch devices require a manual page refresh; sidebar badge ignores pending claims entirely. (10)
2. **Lazy claim expiry** — no job marks claims expired; stale claims stay "Pending Assignment" and 422 on approve; no `expired` filter on either tab. (2, 9)
3. **Org-less super admin can list all orgs but approve none** — unusable global view, contradicts the empty-state convention for super admins. (8)

### P3 (nice to fix)
4. QuickStats + lists use page-1 only (undercount beyond 20/10 rows); no pagination UI.
5. `agent-registrations` GET pageSize unclamped.
6. Registration approve/reject not rate-limited; no one-active-device enforcement at approve time (mitigated by auth-time 409); Device created `online` pre-heartbeat (masked by `effectiveDeviceStatus`).
7. No revoke path for legacy devices; notification from registration approve lacks `entityType/entityId`.
8. Status fields untyped strings; no search; no expiry display; legacy tab lacks deprecation banner.

---

## 17. Recommended Changes (report only — no code changed)

1. **Realtime:** add `device-claims`/`agent-registrations` invalidation keys to `ws-invalidation.ts` (or 30–60s `refetchInterval`); include pending claim count in the sidebar badge.
2. **Expiry:** add a low-frequency job (or lazy check in GET) to flip expired claims; add `expired` filter option + expiry countdown on claim cards; surface the 422 with a clear "claim expired — device must re-register" message.
3. **RBAC:** decide super-admin behavior — either exclude org-less sessions from these lists (consistent with MO-10) or allow global approval with explicit org selection.
4. **Stats:** compute counts server-side (extend GET with `summary` param) instead of page-1 client filtering.
5. **Legacy path:** mark registrations tab as legacy; add revoke for legacy devices or route them through the devices page; add rate limit to approve.
6. **Clamp** `pageSize` on `agent-registrations`.

---

## 18. Final Production Readiness

**VERDICT: PRODUCTION-READY with visibility polish required.**

The zero-touch approval core (what the real deployment uses) is secure, correct, and thoroughly tested. Ship-blocking gaps are limited to admin *visibility* (realtime, stale-pending clarity, super-admin list/action mismatch) rather than correctness or security. No data was modified during this audit.

### Feature disposition table

| Feature | Disposition |
|---|---|
| Zero-touch discover → claim → approve | ✅ **Keep** (core, excellent) |
| One-active-device transaction + 409 | ✅ **Keep** |
| Claim-secret cancel (employee self-service) | ✅ **Keep** |
| Reject/revoke with reasons + notifications + audit | ✅ **Keep** |
| Rate limits, cross-org 404, fail-closed validation | ✅ **Keep** |
| Realtime refresh (missing) | ➕ **Missing — add** |
| Sidebar badge for pending claims (missing) | ➕ **Missing — add** |
| Expiry job + `expired` filter (missing/half-wired) | 🔧 **Fix** |
| Super-admin list/action parity | 🔧 **Fix** |
| QuickStats server-side counts | 🔧 **Fix** |
| Legacy registrations tab | ♻️ **Deprecate (keep working, banner it)** |
| Legacy approve one-active-device + rate limit | 🔧 **Fix** |
| `pageSize` clamp | 🔧 **Fix** |
| Bulk approve / search / pagination UI | ➕ **Missing — optional** |
| Dead code | 🗑️ None found (only `useLiveUpdates` shim) |

---

*Audit performed read-only: code review of 8 routes, 4 schema models, UI page, auth helpers, 9 test suites, and live DB (SELECT-only). No files modified, no records written.*