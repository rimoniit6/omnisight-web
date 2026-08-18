# Phase 0 — Employee Agent Authentication + Multi-Device + Single Active Device: Architecture Audit

> **Scope:** READ-ONLY audit. No code was modified.
> **Date:** 2026-08-10
> **Objective:** Establish the exact current-state architecture so Phases 1–14 can be planned against verified facts, not assumptions.

---

## 1. Executive Summary

WorkLensAI already contains **most of the machinery** the master prompt requires. The genuinely missing pieces are concentrated in four areas:

| # | Capability | Current state | Phase that builds it |
|---|-----------|---------------|----------------------|
| 1 | **AgentAccount credentials** (agentId, passwordHash, status, lastLogin, lockout) | ❌ Only `Employee.agentPassword` (bcrypt) + `Employee.agentApproved` boolean exist; no dedicated account row, no lockout, no reset UI | Phase 1–2 |
| 2 | **Dedicated agent login endpoint** (`POST /api/agent/login`) | ❌ Doesn't exist. Legacy PATH B `/api/agent/authenticate` (employeeId+password) conflates login + device registration + token issuance in one transaction | Phase 3 |
| 3 | **Authenticated device discovery** (login session → claim) | ❌ `/api/agent/discover` is anonymous (deviceKey only); org is derived as "first org" — no employee identity at discovery | Phase 4 |
| 4 | **Server-side logout / token revocation** | ❌ Desktop `logout()` only clears the local secure store; no server call revokes the `AgentToken` | Phase 7 |
| 5 | **One-active-device-per-employee** | ✅ Strong: transactional `FOR UPDATE` employee lock in approve; `deleteMany` tokens + offline other devices in authenticate; ZT-27 concurrent test | Phase 6 (re-certify + 10-concurrent test) |
| 6 | **Multi-device history** | ✅ `DeviceClaim` is already 1:N per device (Phase 62 migration), statuses incl. `cancelled`; rejected/cancelled/expired re-request works | Phase 5 (verify only) |
| 7 | **Stable device identity** | ✅ `DeviceIdentityStore` (random 32-byte id persisted in userData, machine-key binding) — survives restart/logout/update, not uninstall | Phase 5 (document) |
| 8 | **Employee login UI** | ⚠️ Deliberately REMOVED in earlier zero-control phases — the renderer has no input at all today | Phase 8 (careful re-add) |

**Key conflict to resolve before Phase 1:** earlier zero-control phases (44, 62) *removed* employee ID/password input as a security measure. The master prompt now *requires* an employee login-once flow. These can coexist: a **minimal login screen** (agentId + password) followed by the existing zero-control status UI. The login screen must remain the **only** employee input surface, and must not expose configuration/consent/device controls.

---

## 2. Verified Current Architecture

### 2.1 Database (PostgreSQL, provider = "postgresql")

```
Organization 1 ── N Employee ── 1 Department
                   │
                   ├── agentPassword (String?, bcrypt; legacy plaintext auto-upgraded)
                   ├── agentApproved (Boolean @default(false))
                   ├── N Device (agentKey @unique, status, employeeId?)
                   │        └── N DeviceClaim (1:N history; pending/approved/rejected/
                   │                            revoked/expired/cancelled; cancelledAt,
                   │                            cancellationReason, cancelledByDeviceId)
                   ├── N AgentToken (token @unique, employeeId, deviceId?, 24h expiresAt)
                   ├── N AgentRegistration (legacy PATH B pending approvals)
                   └── N Consent / ConsentLog / ProjectMember / Activity / Screenshot ...
AppUser (JWT admins: super_admin/owner/admin/manager/viewer; organizationId nullable)
```

- **No `AgentAccount` model exists.** Credentials live on `Employee.agentPassword`.
- `Employee.employeeId` is globally unique and is the agent's login identifier in PATH B.
- `DeviceClaim` has no `employeeId` bound at discovery — it is bound only at approval.
- `AgentToken` has no `kind` column; a token is both "session" and "device credential" today.

### 2.2 Backend agent API surface (verified routes)

| Route | Auth | Behavior |
|---|---|---|
| `POST /api/agent/discover` | None (anonymous deviceKey) | Creates/reuses Device + pending claim; `reRegister` intent for re-request; revoked fails closed; org = first org |
| `POST /api/agent/register` | None (employeeId+password) | Legacy PATH B pending registration via `AgentRegistration` |
| `POST /api/agent/authenticate` | None (deviceId+secret **or** employeeId+password) | Issues 24h `AgentToken`; transactionally deletes all other tokens + offline other devices (one-active rule) |
| `GET /api/agent/config` | `validateAgentToken` (bearer) | Server-derived monitoring config + assignment (dept/projects) |
| `GET /api/agent/heartbeat` | bearer | Keeps device online (rate-limited per token) |
| `POST /api/agent/activity` | bearer + consent | Activity upload, consent-gated server-side |
| `POST /api/agent/screenshot` | bearer + consent | Screenshot upload (5 MB, strict raster MIME + magic bytes) |
| `GET /api/agent/consent` | bearer | 8-type consent state snapshot |
| `POST /api/device-claims/[id]/cancel` | claim secret (device-bound) | PENDING→CANCELLED; idempotent; approved→409 |
| `POST /api/device-claims/[id]/approve` | admin JWT + org | Transactional bind, project assignment, `FOR UPDATE` employee lock, one-active-device rule |
| `POST /api/device-claims/[id]/reject` / `revoke` | admin JWT + org | Lifecycle transitions |

**No `/api/agent/login` exists.** No logout route exists. No agent-account admin routes exist.

### 2.3 One-active-device enforcement (verified — already strong)

- **Approve route:** `SELECT ... FROM "Employee" WHERE id = ... FOR UPDATE`, re-check claim pending, `updateMany` other online/offline devices → `inactive`, activate new device, set `agentApproved=true`. ZT-27 proves exactly one active under concurrent approvals.
- **Authenticate route (both paths):** `deleteMany` all `AgentToken`s for the employee, `updateMany` other online devices → `offline`, then create the new token. So **whoever authenticates last owns the active session** — this matches the master prompt's "Device B becomes active, Device A is immediately invalidated."
- **`validateAgentToken`:** rejects when bound device is not `online|offline` → a deactivated device's token fails closed immediately.

### 2.4 Desktop agent (verified)

- **`AuthService`** phases: `unregistered | discovering | pending_approval | rejected | revoked | authenticated | expired | cancelled | error`. Zero-touch is the default path; legacy `enroll/authenticate` remain in code but **no renderer UI invokes them**.
- **`AgentOrchestrator`**: initialize → discover (zero-touch) → approval poll (20s) → startRuntime (config/consent sync, heartbeat, collectors). Discovery retry with bounded backoff (30s→10min) for offline first-run.
- **`cancelRegistration()`** → server cancel → auto re-discover → new pending claim (Phase 62).
- **`logout()`** exists but **only clears local secure store** (`KEY_TOKEN/KEY_CRED/KEY_CLAIM`) — no server token revocation, no device state change. This is the Phase 7 gap.
- **`DeviceIdentityStore`**: random 32-byte hex id persisted under userData with a machine-key HMAC binding (clone detection). Survives restart/logout/update; regenerates on uninstall (fresh-install semantics).
- **Renderer (`index.html` + `renderer.ts`)**: zero-control read-only views (onboard/pending/rejected/revoked/offline/status). The only employee control is **Cancel registration**. No login form, no logout button, no input of any kind.
- **CSP**: `default-src 'none'; script-src 'self'; connect-src 'none'` — renderer cannot make network calls (all via IPC). No secrets in renderer.

### 2.5 Admin UI (verified)

- **Employee dialog** (`employee-dialog.tsx`): creates/edits employee with name/email/employeeId/department/status/joinDate. **No agent credential management whatsoever** — the Admin cannot create, reset, or disable an agent login today.
- **Zero-Touch Devices tab** (`agent-approvals-page.tsx`): approve/reject/revoke + cancelled display + filter/stats. Admin sees PENDING claims and assigns employee + projects.
- **Devices page** (`devices-page.tsx`): device list with status/heartbeat.
- **No "Agent Accounts" management page exists.**

### 2.6 Test inventory (verified present)

- **Backend (10 files):** zero-touch, consent, projects, security, super-admin, organization-bootstrap, multi-org-isolation, screenshots, health, claim-cancel. (205/205 green in Phase 62.)
- **Desktop (15 files):** auth-service, onboarding, zero-touch, zero-control-renderer, renderer-build, server-url, device-identity, consent-gate, consent-lifecycle, scheduler, orchestrator-dynamic-config, queue-uploader, activity-queue, api-client, update-service. (129/129 green in Phase 62.)
- **Missing:** agent-login, multi-device activation, logout/revocation, 10-concurrent activation, admin agent-account CRUD tests.

---

## 3. Reusable Components (do not reinvent)

| Component | Location | Reuse plan |
|---|---|---|
| `verifyPassword` / `hashPassword` (bcryptjs) | `src/lib/auth.ts` | AgentAccount password hashing |
| `generateToken` (randomBytes, no Math.random) | `src/lib/agent/auth.ts` | Login session tokens |
| `validateAgentToken` + device-bound fail-closed | `src/lib/agent/auth.ts` | All authenticated agent routes |
| `hashClaimSecret` / `verifyClaimSecret` / `generateClaimSecret` | `src/lib/agent/auth.ts` | Claim secrets (unchanged) |
| `checkRateLimit` + `RATE_LIMITS` | `src/lib/rate-limit.ts` | Add `agentLogin` limits |
| `requireAdminOrg` / `requireSessionOrg` / `authError` | `src/lib/api.ts` | Admin agent-account routes |
| `db.$transaction` + `SELECT ... FOR UPDATE` pattern | approve route | One-active-device + account lockout |
| `DeviceClaim` 1:N history + cancel fields | schema | Multi-device + re-request (unchanged) |
| `DeviceIdentityStore` + machine binding | desktop storage | Device identity (unchanged) |
| `Scheduler` (named tasks, backoff) | desktop scheduler | Login re-auth / session check |
| `SecureStore` (safeStorage/DPAPI) | desktop storage | Store login session token encrypted |
| Zero-control renderer pattern + IPC/status bridge | desktop | Login view must keep the same bridge shape |

---

## 4. Conflicting Assumptions (must be decided in Phase 1)

1. **Login vs zero-control (HIGH).** Phases 44/62 removed employee credentials as a security hardening. The master prompt requires login-once. Resolution: add a **login screen as the single employee input surface**; after login the agent is zero-control. Zero-touch (PATH A) stays as a parallel flow for the existing deployment model — the master prompt forbids deleting it.
2. **`agentApproved` vs account status.** `Employee.agentApproved` (boolean) is used by `validateAgentToken`. A new `AgentAccount.status` must map cleanly. Recommendation: keep `agentApproved` as the derived "employee has been approved for agent use" flag, and add explicit `AgentAccount.status` (active/disabled) that `validateAgentToken` also checks. Decide precedence (disabled account ⇒ 403 even if approved).
3. **Legacy PATH B (`/api/agent/register` + `authenticate(employeeId+password)`)** conflicts with the new "login once, then device approval" model because it auto-binds a device at authenticate time. Recommendation: keep PATH B for backward compatibility (rule: don't delete working features), but the new login flow uses `/api/agent/login` → authenticated discovery → DeviceClaim → approval → device-secret authentication. Both models coexist; tests must cover both.
4. **Org derivation in discover.** Today discover uses "first org" (single-tenant default). In the new flow, the org must come from the **verified login session** (`AgentAccount → Employee.organizationId`). This makes the authenticated path inherently multi-tenant-safe. Zero-touch keeps the first-org fallback.

---

## 5. Database Changes Required (Phase 1)

**New model — `AgentAccount` (1:1 with Employee):**

```prisma
model AgentAccount {
  id                 String    @id @default(cuid())
  employeeId         String    @unique   // 1:1 with Employee
  agentId            String    @unique   // login username (defaults to Employee.employeeId)
  passwordHash       String              // bcrypt — never plaintext
  status             String    @default("active") // active, disabled
  lastLoginAt        DateTime?
  failedLoginCount   Int       @default(0)
  lockedUntil        DateTime?           // brute-force lockout
  passwordChangedAt  DateTime?
  createdAt          DateTime  @default(now())
  updatedAt          DateTime  @updatedAt
  employee           Employee  @relation(fields: [employeeId], references: [id], onDelete: Cascade)
}
```

**Optional/considered (decide in Phase 1, no schema change yet):**
- `AgentToken.kind` (`login` short-lived session vs `device` 24h) — or a separate `AgentSession` table with a short TTL (e.g. 10 min) used to authorize discovery. Cleaner: separate short-lived `AgentSession` to avoid mutating the proven `AgentToken` contract.
- No change to `DeviceClaim` (history already supports multi-device).
- No change to `Device.agentKey @unique` (identity uniqueness already correct).

**Migration risk (medium):** backfilling `AgentAccount` for existing employees with `agentPassword` — bcrypt hashes can be copied directly; legacy plaintext must be run through `hashPassword` (or left for first login via the existing legacy-upgrade path in `verifyAgentPassword`). Accounts for employees with no `agentPassword` get `status = disabled` (admin must enable + set credentials). This is an additive migration — safe to roll forward; no data loss.

---

## 6. Security Risks / Requirements for the New Flow

| Risk | Current state | Required in new flow |
|---|---|---|
| Brute-force on agent login | Only per-IP rate limit (20/min) | Per-account `failedLoginCount` + `lockedUntil` (e.g. 5 fails → 15 min lock), **plus** per-IP limit; constant-time verify; uniform 401 (no "employee not found" 404/403 enumeration — PATH B currently leaks 404) |
| Session fixation / replay | Tokens random, 24h | Login sessions short-lived (≤10 min), single-use for discovery, replaced by device secret after approval |
| Logout invalidation | ❌ none server-side | New `POST /api/agent/logout` revokes login session + device token, marks device offline/inactive, stops collectors client-side |
| Cross-device takeover | One-active rule exists | Re-verify in login flow: activating Device B must revoke Device A's token server-side (current `deleteMany` handles it — keep) |
| Client-supplied identity | Discover ignores employeeId/org | Authenticated discover must derive employeeId + org **only** from the verified session |
| Token exposure | Renderer never holds secrets | Login session token must also stay in main process only |
| `Math.random` | ✅ never used in auth | Keep `randomBytes` only |
| Account enumeration | PATH B returns 404 for unknown employee | New login returns identical 401/403 for all failure modes |

---

## 7. Migration Risks

1. **Backfill `AgentAccount` from `Employee.agentPassword`** — additive; safe. Must handle bcrypt vs legacy plaintext and NULL passwords (disabled accounts).
2. **Do NOT remove `Employee.agentPassword`/`agentApproved`** — PATH B and zero-touch depend on them; removing would break working flows. Keep both models in parallel; `AgentAccount` becomes the primary for the new login flow.
3. **No `db push`** — all changes via `prisma migrate deploy` (established production rule).
4. **No data loss** — the migration is additive-only; verify row counts before/after (already 29-table baseline).

---

## 8. Exact Implementation Sequence (map to master phases)

| Phase | Work | Reuses |
|---|---|---|
| **1** AgentAccount model | New Prisma model + additive migration + backfill + `AgentAccountService` (create/enable/disable/reset password/hash) + tests | `hashPassword`, `randomBytes` |
| **2** Admin credential flow | New `/api/agent-accounts` CRUD (admin+org-scoped) + Employee dialog "Agent Account" section (create/reset/disable/last-login, show temp password once, never hashes) + audit + tests | `requireAdminOrg`, `AuditLog` |
| **3** `POST /api/agent/login` | agentId+password → short-lived `AgentSession` (or token); lockout + rate limit + uniform 401; tests | `verifyPassword`, `checkRateLimit` |
| **4** Authenticated discover | Extend `/api/agent/discover` to accept a login session (derive employeeId/org server-side; ignore client fields); zero-touch unchanged; claim bound to employee at creation; tests | existing discover + claim model |
| **5** Multi-device identity | Audit-only: verify 1:N history, `agentKey` uniqueness, identity survival matrix; document reinstall policy; no schema change expected | existing |
| **6** One active device | Re-certify existing rule in the login flow; add **10-concurrent activation** test; confirm Device-B-revokes-A server-side; tests | `FOR UPDATE` pattern |
| **7** Logout | `POST /api/agent/logout` (revoke session + token, device → inactive/offline); desktop `AuthService.logout()` calls it; collectors stop; identity preserved; tests | `validateAgentToken`-adjacent cleanup |
| **8** Agent UI | Login view (agentId+password) + logout button (authenticated only) + "session ended / another device connected" view; keep zero-control after login; zero-control renderer test updated | existing bridge + status stream |
| **9** Admin device mgmt | Devices page: per-employee device list, status/last-heartbeat/approval columns, disconnect/reconnect/revoke actions w/ confirm; RBAC + audit | existing devices/claims APIs |
| **10** Assignment flow | Verify config route already derives dept/projects server-side (✅ it does); no change expected beyond tests | `GET /api/agent/config` |
| **11** Reconnect resilience | Login session persistence (encrypted), restart re-auth, offline retry, no duplicate claims; tests | Scheduler + SecureStore |
| **12** Security audit | Full malicious-scenario matrix incl. cross-employee device access, session replay, lockout bypass | — |
| **13** Full regression | All 10 backend + 15 desktop suites + new suites + tsc + build + migrate deploy | — |
| **14** Clean-machine cert | Installer → login → discover → approve → connected → consent → logout → second machine → takeover → restart → offline recovery | — |

---

## 9. Verified Facts That Constrain the Plan

- Backend baseline: **205/205 tests green** (incl. claim-cancel 13/13). Desktop: **129/129 green**. Admin `tsc` + build green. Migration `20260810140000_device_claim_history` applied.
- `DeviceClaim` is **already 1:N** — the master prompt's "multiple devices historically, re-request after reject/cancel/expired" is already satisfied and tested (CC-1…CC-13).
- One-active-device is **already transactional** — the new work is extending the flow + stronger concurrency evidence, not building the rule from scratch.
- Zero-touch discover is anonymous by design; the new authenticated path adds a login requirement **without removing** zero-touch.
- Renderer CSP forbids network access; the login form will send credentials via IPC → main process → API (secrets never in renderer DOM beyond the submitted form).

---

## 10. Summary of Gaps (the actual Phase 1–14 work)

1. **New:** `AgentAccount` model + migration + service (P1).
2. **New:** Admin agent-account management UI + API (P2).
3. **New:** `POST /api/agent/login` + session + lockout (P3).
4. **Modified:** authenticated discovery (P4) — zero-touch preserved.
5. **New:** `POST /api/agent/logout` + server-side revocation (P7).
6. **Modified:** desktop renderer login + logout + session-ended views (P8).
7. **Modified:** devices page per-employee management (P9).
8. **Verify/re-certify:** multi-device (P5), one-active (P6), assignment (P10), resilience (P11).
9. **New tests:** login, logout, multi-device, 10-concurrent, admin account CRUD, security matrix (P3/P6/P7/P12/P13).

**Nothing in the existing architecture needs to be torn down.** The plan is additive and parallel to the proven zero-touch + one-active-device machinery.

---

*Phase 0 complete. STOP per master-prompt instruction — awaiting approval to proceed to Phase 1 (AgentAccount model + migration).*
