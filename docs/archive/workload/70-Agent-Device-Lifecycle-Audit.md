# Phase 5, STEP 1 — Agent Device Lifecycle Audit

> **Type:** READ-ONLY architecture audit. No source code modified.
> **Date:** 2026-08-11
> **Baseline:** Backend 281/281 · Desktop 134/134 · Admin tsc + build PASS

---

## 1. Current lifecycle diagram

```
┌─────────────────────────── REGISTERED ───────────────────────────┐
│                                                                  │
│  (a) Zero-touch discover        (b) Legacy register              │
│  POST /api/agent/discover        POST /api/agent/register        │
│  anonymous + deviceKey           employeeId + password           │
│  → Device created (status        → AgentRegistration pending     │
│    'online', employeeId NULL)    → Device created on auth        │
│  → DeviceClaim PENDING +         (legacy, unchanged)             │
│    one-time secret issued                                        │
│                                                                  │
└──────────────────────────────┬───────────────────────────────────┘
                               │ admin action
                               ▼
┌─────────────────────────── APPROVED ────────────────────────────┐
│  POST /api/device-claims/[id]/approve  (requireAdminOrg)         │
│  tx: Employee FOR UPDATE → claim→approved → Device.employeeId    │
│  bound → device 'online' → employee.agentApproved=true →         │
│  other devices of employee → 'inactive' → audit + notification   │
│                                                                  │
│  NOTE: other devices' AgentTokens are NOT deleted here — they    │
│  fail closed via validateAgentToken's device-status check.       │
└──────────────────────────────┬───────────────────────────────────┘
                               │ agent action (holds claim secret)
                               ▼
┌─────────────────────────── AUTHENTICATED ───────────────────────┐
│  POST /api/agent/authenticate                                   │
│   PATH A: deviceId + deviceSecret (claim must be 'approved')    │
│   PATH B: employeeId + password (legacy, unchanged)             │
│  tx: deleteMany AgentToken(employee) ← SILENT KICK              │
│      other devices online→offline  ← SILENT KICK                │
│      device → online, create 24h device-bound AgentToken        │
└──────────────────────────────┬───────────────────────────────────┘
                               │ heartbeat
                               ▼
┌─────────────────────────── ACTIVE/CONNECTED ────────────────────┐
│  POST /api/agent/heartbeat (Bearer AgentToken, deviceId-bound)  │
│  → device.status = 'online', lastHeartbeat = now                │
│  activity / screenshot / config / consent all require           │
│  validateAgentToken → device must be 'online' | 'offline'       │
└──────────────────────────────┬───────────────────────────────────┘
                               │ logout
                               ▼
┌─────────────────────────── LOGGED OUT ──────────────────────────┐
│  POST /api/agent/logout → deletes the matching                  │
│  AgentSession OR AgentToken → audit 'logout'                    │
│  ✗ Device.status NOT updated — stays 'online' with stale        │
│    lastHeartbeat (no aging job anywhere)                        │
│  ✗ Device / Employee / AgentAccount / DeviceClaim preserved ✓   │
└──────────────────────────────────────────────────────────────────┘
```

## 2. Answers to the ten audit questions

**Q1 — How a device becomes registered.**
Three ways: (a) zero-touch `POST /api/agent/discover` with a stable machine `deviceKey` — creates `Device` (status `online`, no employee) + `DeviceClaim` PENDING, returns a one-time claim secret (only its SHA-256 hash is stored); (b) legacy `POST /api/agent/register` (employeeId+password) — creates a pending `AgentRegistration`; (c) admin manual `POST /api/devices`. Registration is independent of any connection.

**Q2 — How a device becomes approved.**
Admin-only `POST /api/device-claims/[id]/approve` (org-scoped via `requireAdminOrg`, cross-org ids → 404). Transaction: takes `SELECT … FOR UPDATE` on the **Employee** row (serializes concurrent approvals), re-checks the claim is still pending, binds `Device.employeeId`, sets device `online`, sets `Employee.agentApproved=true`, sets the employee's *other* devices to `inactive`, upserts ProjectMembers, audits, notifies.

**Q3 — How a device becomes authenticated.**
`POST /api/agent/authenticate` issues a 24h `AgentToken`:
- PATH A (zero-touch): `deviceId + deviceSecret` — claim must be `approved`, secret constant-time verified, employee active + approved → transactional token issuance.
- PATH B (legacy): `employeeId + password` — unchanged, same transactional pattern.
Additionally `POST /api/agent/login` (AgentAccount) issues a short-lived **AgentSession** — a *login-only* credential that powers the authenticated branch of `discover`; it is deliberately **not** a device credential.

**Q4 — How a device becomes active/connected.**
Valid device-bound `AgentToken` + successful `POST /api/agent/heartbeat` → `Device.status='online'`, `lastHeartbeat` updated. All monitoring APIs (activity, screenshot, config, consent, break, tamper, anomaly) gate on `validateAgentToken`.

**Q5 — How logout affects the device.**
`POST /api/agent/logout` deletes the bearer's `AgentSession` (login-only) or `AgentToken` (device credential), one query each, idempotent, writes an `auditLog` `logout`. **It does not touch `Device.status`** — the device stays `online` with a stale heartbeat until some *other* authenticate/approve run flips it. Nothing ever marks an expired/deleted-token device offline.

**Q6 — How AgentToken is created/revoked.**
Created only inside `authenticate` (both paths) — 24h expiry, `deviceId`-bound, `employeeId`-bound. Revoked by: logout (exact-token delete), expiry cleanup inside `validateAgentToken`, or last-writer-wins `deleteMany({employeeId})` at the *next* authenticate of the same employee. Admin revoke does **not** delete tokens — it deactivates the device and relies on the fail-closed device-status check.

**Q7 — How AgentSession is created/revoked.**
Created at `login` (24h TTL), deleted at logout/expiry. Multiple concurrent sessions per employee are allowed by design — they carry no device authority.

**Q8 — Can two devices of the same employee simultaneously hold valid AgentTokens?**
- **Sequentially: No** — authenticate `deleteMany({employeeId})` leaves one token (last writer wins).
- **Concurrently: YES — RACE.** Neither authenticate path takes a row lock on the Employee (approve does, authenticate does not). Two simultaneous authenticates for the same employee both run `deleteMany` (each deletes nothing yet), both create their own token, both commit → **two valid device-bound tokens exist**, both devices `online`, both heartbeating. `validateAgentToken` is satisfied by either. This is the central defect.
- **Secondary defect (ping-pong):** because authenticate *silently kicks* instead of rejecting, the displaced device's agent auto-recovers (`recover()` → re-authenticate with stored secret → kicks back). Devices A and B can oscillate active status indefinitely.

**Q9 — Is device status alone sufficient to determine "active connection"?**
**No.**
- `online` is set by heartbeat *or* authenticate *or* approve — it survives logout (no update) and token expiry (no aging job).
- `offline` is set only when *another* device authenticates or an approval deactivates others.
- `inactive` means revoked/disabled (validateAgentToken rejects anything not `online|offline`).
- There is no `lastLoginAt` on Device; "active connected" is not represented anywhere except implicitly by "an AgentToken exists and the device is online". Nothing re-derives status from the token table.

**Q10 — Is there already a single-active-device mechanism?**
**Partial, and with the wrong failure semantics for the product requirement:**
- Admin approve deactivates other devices (correct direction, no 409 involved) — but does not delete their tokens (relies on fail-closed check) and can be immediately *undone* by the other device's auto re-auth (R3 below).
- Authenticate enforces "one token per employee" via deleteMany — the **silent kick** model. This directly contradicts the required behavior (Device B must receive `409 ACTIVE_DEVICE_EXISTS`; the employee must logout A first).
- ZT-27 test pins "one active device per employee" at approval time, but there is no test or mechanism for the authenticate-time race.

## 3. Current state transitions (device)

| From | To | Trigger |
|---|---|---|
| (created) | `online` (unassigned) | discover / register |
| `online` (unassigned) | `online` + employeeId | admin approve |
| `online` | `offline` | another device of the employee authenticates |
| `online`/`offline` | `inactive` | admin approve (other devices) / admin revoke |
| `inactive` | — | terminal (must re-register) |
| `online` | `online` (stale) | logout — **no transition occurs** |

Missing: `online` → `offline` on logout; `online` → `offline` on token expiry (aging); `online`/`offline` → `active`-equivalent notion.

## 4. Current authentication flow

```
POST /api/agent/login (AgentAccount)
  → verifyAgentCredential (bcrypt / legacy upgrade / lockout / disabled)
  → employee active? org active?
  → createAgentSession (24h)          ← NOT device-gated (by design)
  → audit login, lastLoginAt updated

POST /api/agent/authenticate
  PATH A: claim approved? secret OK? employee active+approved?
  PATH B: password OK? employee approved+active?
  → $transaction {                      ← NO Employee row lock (RACE)
      deleteMany tokens(employee)       ← silent kick
      updateMany other devices → offline
      device → online
      create 24h AgentToken(deviceId, employeeId)
      audit
    }
```

## 5. Current token lifecycle

```
create:  authenticate PATH A/B → 24h AgentToken (deviceId-bound)
use:     validateAgentToken (exists, not expired, employee approved+active,
         account active, device online|offline) → heartbeat/activity/etc.
expire:  validateAgentToken deletes on sight
revoke:  logout (exact match) | next authenticate (deleteMany, kick)
admin:   approve/revoke do NOT delete tokens — fail closed via device.status
```

## 6. Current logout lifecycle

```
POST /api/agent/logout (Bearer)
  agentSession.findUnique(token) → delete (session)
  else agentToken.findUnique(token) → delete (token)
  idempotent (missing token → success, no-op)
  audit 'logout' (safe fields), log.info (employeeId slice + IP)
  ── Device.status untouched · Device/Employee/Account/Claims preserved ──
```

## 7. Existing constraints (good)

- Employee + organization always resolved server-side (`login` / `discover` / `authenticate`); body `employeeId`/`organizationId` never trusted in authenticated flows.
- Uniform 401 on login; uniform 404 for cross-org/cross-employee device lookups.
- `approve` serializes per-employee with `FOR UPDATE`; guarded `updateMany` claim re-check (409 on concurrent reject/revoke).
- Zero-touch anonymous discover unchanged and fully tested (ZT suite).
- Consent, org isolation, RBAC boundaries intact (verified in Phases 3–4).
- Tokens/claims never logged; `passwordHash` stripped at every boundary.

## 8. Missing constraints

1. **No single-active check at token issuance** — authenticate silently kicks instead of returning `409 ACTIVE_DEVICE_EXISTS`.
2. **No employee row lock in authenticate** — concurrent double-activation race (Q8).
3. **Logout does not update device status** — stale `online` after logout/expiry.
4. **No token/status aging** — a dead device stays `online` forever.
5. **No per-device `lastLoginAt`** — admin cannot distinguish Registered/Active/Inactive accurately.
6. **No admin "Disconnect" action** — device table only filters/badges status; `DELETE /api/devices/[id]` exists (risky: full cascade delete of device + claims + activities) and `PUT` allows arbitrary status edits without token revocation.
7. **PATH A authenticate does not check `device.status`** — an `inactive` device re-authenticates if its claim is still `approved` (defense-in-depth gap; today masked because revoke also flips the claim).
8. **Admin approve deactivation can be reverted** by the displaced device's auto re-auth (R3).

## 9. Race-condition risks

| # | Race | Consequence |
|---|---|---|
| R1 | Two devices authenticate concurrently (same employee) | Two valid tokens, both devices online — **violates the core requirement** |
| R2 | Displaced device auto-recovers (recover → re-auth) | A↔B ping-pong; silent-kick war, no deterministic winner |
| R3 | Admin approves device A; device B auto re-auths | Admin's deactivation immediately undone |
| R4 | Logout(A) racing authenticate(B) | Benign today (exact-token delete); must stay correct under new 409 design |
| R5 | Revoke (claim) racing PATH A re-auth | Claim flips `revoked` → PATH A fails closed (already safe) |

## 10. Multi-device risks

- Sequential kick model means the *employee cannot choose* which device is active — last writer wins.
- Recovery logic (`recover()`, `retryConnect()`, poll loops) re-authenticates automatically, so a kicked device *fights back* — no user control.
- Admin visibility is misleading: device table shows `online` badges that outlive actual connectivity; "Pending" claims live in a separate page.

## 11. Recommended implementation (input for STEP 3 design)

1. **Single-active enforcement at token issuance (`authenticate`, both paths):**
   - Take `SELECT … FOR UPDATE` on the Employee row (mirrors `approve`).
   - Inside the transaction, look for an existing **valid** (non-expired) AgentToken of the employee bound to a **different** `deviceId`.
   - If found → return `409 { error: "ACTIVE_DEVICE_EXISTS" }`, safe fields only. Do NOT delete the other token; do NOT touch the other device.
   - If the existing token is bound to the **same** device (re-login) → delete it and issue a fresh token for that device.
   - This makes the outcome deterministic under concurrency (second transaction sees the first committed token → 409) and preserves "same device may re-login".
2. **Keep `AgentSession` login ungated** — it is login-only; the 409 surfaces at the device-activation step where the desktop agent can render `ACTIVE_DEVICE_EXISTS`.
3. **Logout updates the device:** resolve `AgentToken.deviceId`, set `Device.status='offline'` (NOT `inactive` — that would block re-login via validateAgentToken), keep registration + history.
4. **Add `device.status` check to PATH A authenticate** (defense in depth: `inactive`/`retired` devices cannot re-auth even with an approved claim).
5. **Admin "Disconnect Device":** new org-scoped admin endpoint → delete tokens bound to the device, set device `offline`, audit — preserves registration/history; no accidental delete. Restrict/guard `DELETE /api/devices/[id]`.
6. **Admin UI:** show status values as Registered/Pending/Approved/Active/Inactive/Revoked, add Last heartbeat, Last login, Registered date, and an Active indicator derived server-side (existing fields suffice: `status`, `lastHeartbeat`, `registeredAt`, `agentToken` presence).
7. **Desktop:** map `409 ACTIVE_DEVICE_EXISTS` to a distinct state with the exact message "Your account is already active on another device"; never auto-retry into a kick war; Logout stays explicit and server-revoking.
8. **Token authority:** AgentToken (existence + device binding + expiry) is the server-authoritative "active connection" signal. No schema change required.

## 12. Exact files that would need modification (STEP 4+)

| File | Change |
|---|---|
| `src/app/api/agent/authenticate/route.ts` | FOR UPDATE, 409 single-active check, PATH A device-status check |
| `src/app/api/agent/logout/route.ts` | mark device `offline` on token logout |
| `src/lib/agent/auth.ts` | helper `findActiveTokenForEmployee` (tx-scoped); PATH A guard reuse |
| `src/app/api/devices/[id]/route.ts` | guard DELETE; add disconnect action (or new `src/app/api/devices/[id]/disconnect/route.ts`) |
| `src/components/devices/devices-page.tsx`, `device-table.tsx`, `device-dialog.tsx` | status labels, Last login, Active indicator, Disconnect action |
| `src/components/agent-approvals/agent-approvals-page.tsx` | status vocabulary alignment (if needed) |
| `desktop-agent/src/api/device.ts` | 409 typing |
| `desktop-agent/src/auth/auth-service.ts` | `active_device_exists` phase + non-retry handling |
| `desktop-agent/src/services/agent-orchestrator.ts` | surface ACTIVE_DEVICE_EXISTS; suppress kick-war recovery |
| `desktop-agent/src/renderer/**` | login screen states for the new phase |
| `tests/agent-single-active-device.test.ts` | NEW — AD-01..AD-28 (STEP 8) |

**Unchanged:** `login` route, `session.ts`, `discover` route, `device-claims/*` approve/reject/cancel/revoke (behavior preserved), consent/config/activity/screenshot routes, `schema.prisma`.

## 13. Is a Prisma migration required?

**No.** The constraint "one active device per employee" is representable entirely with existing columns:
- **Authority:** `AgentToken` (exists + `deviceId` + `expiresAt`) — server-authoritative active signal.
- **Enforcement:** `Employee` row lock (`FOR UPDATE`) at issuance + `Device.status` transitions (`online`/`offline`/`inactive`) + fail-closed `validateAgentToken` device-status check.
- **Admin visibility:** derive "Active" from token presence; `lastHeartbeat`/`registeredAt` already exist. Per-device "Last login" is derivable from `AuditLog` (`action:'login'`, `resource:'device'`, `resourceId=deviceId`), so even that needs no column.

Adding `Device.lastLoginAt` would be *optional convenience only* — not recommended unless STEP 3 finds a compelling reason (schema churn for zero enforcement value).

## 14. Report

```
STEP:   1 — Architecture Audit
STATUS: COMPLETE (read-only)

Files inspected:
  src/app/api/agent/{login,logout,discover,authenticate,heartbeat,register}/route.ts
  src/app/api/device-claims/{route,[id]/approve,[id]/revoke,[id]/cancel,[id]/reject}/route.ts
  src/app/api/devices/{route,[id]/route}
  src/lib/agent/{auth.ts,session.ts} · src/lib/agent-account.ts
  prisma/schema.prisma (Employee, AgentAccount, Device, DeviceClaim, AgentToken, AgentSession)
  desktop-agent/src/auth/auth-service.ts · services/agent-orchestrator.ts
  src/components/devices/{devices-page,device-table,device-dialog}.tsx
  src/components/agent-approvals/agent-approvals-page.tsx

Files modified:   none
Files created:    workload/70-Agent-Device-Lifecycle-Audit.md

Tests:            not run this step (no changes; baseline intact)
Security impact:  none (read-only)

Database impact:  NONE — no migration required
  Existing AgentToken + Device.status + Employee FOR UPDATE can represent
  "many registered devices, max one active" without schema changes.

Regression:       PASS (nothing changed)

Key findings:
  1. Multi-active RACE at authenticate (no employee row lock) — two devices can
     hold valid tokens simultaneously.
  2. Authenticate SILENTLY KICKS instead of returning 409 ACTIVE_DEVICE_EXISTS.
  3. Displaced devices auto-recover → ping-pong war between devices.
  4. Logout does not update Device.status → stale 'online'.
  5. No token/status aging; device status alone cannot determine active connection.
  6. Admin UI lacks Last login / Active indicator / Disconnect action.
  7. No migration required — enforcement via existing models.

Next step:  STEP 2 — Database / Lifecycle Audit (awaiting approval)
```
