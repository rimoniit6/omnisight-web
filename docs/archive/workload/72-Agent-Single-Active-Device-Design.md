# Phase 5, STEP 3 — Single-Active-Device Design

> **Type:** DESIGN ONLY. No source code, Prisma schema, migrations, tests, or UI modified.
> **Date:** 2026-08-11
> **Inputs:** `workload/71-Agent-Database-Device-Lifecycle-Audit.md` (STEP 2) · live verification of every route and lib file listed in §26 · `prisma/schema.prisma` · desktop-agent sources
> **Scope:** Final technical design for *"multiple registered devices per employee, exactly one valid active AgentToken per employee"*.

---

## 1. Executive Summary

The system must allow an employee (e.g. Rimon) to have **multiple registered devices** (PC-01, Laptop-01, Laptop-02) while enforcing **exactly one valid active AgentToken** per employee at any moment.

The design enforces this **entirely in the application layer** with the **Employee row lock** (`SELECT … FOR UPDATE`) — the exact pattern already proven in production by `device-claims/[id]/approve/route.ts:122`. Under that lock, `POST /api/agent/authenticate` inspects the employee's existing **valid** AgentTokens (expiry-aware, device-eligible) and:

- **Another device holds a valid token** → `HTTP 409 { "error": "ACTIVE_DEVICE_EXISTS" }`, **no mutation, no kick** (rollback).
- **The same device holds the token** → old token deleted, fresh token issued (re-login works).
- **No valid token** → fresh token issued.

**No migration is required** (verified in STEP 2 §19 and re-verified in §25). `AgentToken.employeeId/deviceId/expiresAt` already carry all authentication authority; `Device.status`/`DeviceClaim.status` remain separate planes (connection health / registration).

The design additionally: adds the missing `Organization.status` check to `validateAgentToken`, hardens PATH A authenticate (AgentAccount.status + Device.status + Organization.status), makes logout transition the device to `offline`, adds a history-preserving **admin disconnect** endpoint, derives the admin "Active" indicator from token presence (never `Device.status`), and adds a terminal **ACTIVE_DEVICE_EXISTS** desktop phase with **no automatic retry** — eliminating the STEP 1 ping-pong kick war.

---

## 2. Product Rules

| # | Rule | Guaranteed by |
|---|---|---|
| P1 | Employee may have **many registered devices** | Registration plane (Device + DeviceClaim) untouched by activation |
| P2 | At any moment **at most one valid active AgentToken** per employee | Employee row lock + in-tx valid-token predicate |
| P3 | Second-device login ⇒ **HTTP 409 ACTIVE_DEVICE_EXISTS** | Conflict branch throws before any mutation; transaction rolls back |
| P4 | Existing active device is **never silently kicked** | The 409 branch deletes nothing; `deleteMany({employeeId})` is removed |
| P5 | Same-device re-login works (token replaced) | Same-device branch deletes only that device's token, then re-issues |
| P6 | Logout releases the active slot | Logout deletes the token (slot free); another device may then log in |
| P7 | Admin disconnect releases the active slot | New `POST /api/devices/[id]/disconnect` deletes the device's tokens |
| P8 | Registration, claims, activities, screenshots survive logout/disconnect | Neither operation touches those rows |
| P9 | Zero-touch anonymous discovery is unchanged | 409 logic lives only in `authenticate`; `discover` is untouched |
| P10 | No ping-pong kick war | 409 + terminal desktop phase + no auto-retry into conflict |

**Valid example:**

```
PC-01      → ACTIVE        (holds the employee's sole valid AgentToken)
Laptop-01  → REGISTERED / INACTIVE
Laptop-02  → REGISTERED / INACTIVE
```

**Invalid example:**

```
PC-01      → ACTIVE
Laptop-01  → ACTIVE        ← impossible: second authenticate returns 409
```

---

## 3. Current Architecture (verified)

- **`POST /api/agent/authenticate`** (`src/app/api/agent/authenticate/route.ts`) has two paths:
  - **PATH A** (`authenticateDevice`, lines 193–311): zero-touch — `deviceId + deviceSecret` against an **approved** `DeviceClaim`; employee derived from `claim.device.employeeId`; transaction at 254–300.
  - **PATH B** (lines 26–189): legacy — `employeeId + password` via `verifyAgentPassword`; transaction at 86–175; find-or-create Device by `(employeeId, hostname)`.
  - **Both transactions run `agentToken.deleteMany({ employeeId })` (lines 87 / 255) — the silent kick — with NO Employee row lock.** Two concurrent logins can both pass the pre-checks and both commit (STEP 1 race R1 confirmed).
- **`validateAgentToken`** (`src/lib/agent/auth.ts:61–164`) checks: token exists → not expired (deletes on sight) → `agentApproved` → `employee.status === 'active'` → `AgentAccount.status === 'active'` → `device.status ∈ {online, offline}` → `lastUsedAt` update. **Missing: `Organization.status` and device↔employee ownership consistency.**
- **`POST /api/agent/logout`** (`logout/route.ts:36–91`) deletes the exact AgentSession **or** AgentToken and audits. **Never transitions `Device.status`** → stale `online` forever (STEP 2 §3, §11).
- **`POST /api/agent/heartbeat`** (`heartbeat/route.ts`) token-validated; sets `status='online'`, `lastHeartbeat`. Health display only.
- **`POST /api/agent/login`** (`login/route.ts`) verifies AgentAccount credentials + employee/org status; issues an **AgentSession** (login-only, 24h, no FK). Does **not** issue device tokens — unchanged by this design.
- **`DELETE /api/devices/[id]`** (`devices/[id]/route.ts:82–103`) — org-scoped admin delete; **cascades DeviceClaims, Activities, Screenshots** (STEP 2 §14). Unsuitable as a normal disconnect.
- **`POST /api/device-claims/[id]/approve`** — the only existing `Employee … FOR UPDATE` transaction (line 122); deactivates the employee's other devices at approval time. **Reused as the concurrency template.**
- **Admin UI** (`src/components/devices/*`) — table shows name/hostname/OS/assigned/status/last-heartbeat + Edit/Delete; `handleDelete` in `devices-page.tsx:105` calls `DELETE` without confirmation or cascade warning.
- **Desktop agent** — `auth-service.ts` phases: `unregistered | discovering | pending_approval | rejected | revoked | authenticated | expired | cancelled | error`; `recover()` re-authenticates with stored claim secret or password on every 401. A 409 today is classified as generic `error` → `offline` view → auto-discovery retry loop (ping-pong vector).
- **Schema facts (STEP 2 §2):** `AgentToken.deviceId` is a **plain scalar** (no FK, no cascade — orphan-safe); **no uniqueness** on `employeeId`/`deviceId`; all statuses are free strings; `AuditLog.metadata` is a nullable JSON string (safe event detail); indexes `AgentToken@@index([employeeId])`, `AuditLog@@index([organizationId, createdAt])`, `Device@@index([organizationId])`.

---

## 4. Target Architecture

```
              ┌─────────────────────────────────────────────────────────┐
              │  POST /api/agent/authenticate (PATH A + PATH B share)   │
              │                                                         │
              │  pre-checks (outside tx):                               │
              │    credentials (claim secret / password)                │
              │    claim approved (A) · device bound (A)                │
              │    employee exists + active + approved                  │
              │    AgentAccount exists + active          ← NEW          │
              │    Device.status ∈ {online, offline}     ← NEW (A)      │
              │    Organization.status === 'active'      ← NEW          │
              │                                                         │
              │  db.$transaction(async tx => {                          │
              │    SELECT "Employee" … FOR UPDATE        ← LOCK         │
              │    re-check employee/account/org (in-tx)                │
              │    resolve device (A: claim-bound / B: find-or-create)  │
              │    validTokens = agentToken.findMany({                  │
              │        employeeId, expiresAt > now,                     │
              │        device eligible (online|offline, owned) })       │
              │    any on ANOTHER device  → throw → 409, ROLLBACK       │
              │    same device            → delete own token, re-issue  │
              │    none                   → issue fresh token           │
              │    device online · audit login                           │
              │  })                                                     │
              └─────────────────────────────────────────────────────────┘

  logout  → lock employee · delete token · device 'offline' · audit      (idempotent)
  disconnect → lock employee · delete device tokens · device 'offline'   (idempotent)
             · audit · preserves Device/DeviceClaim/Activity/Screenshot
  validateAgentToken → + Organization.status · + device ownership match  (fail closed)
  heartbeat → connection health ONLY (never authorization authority)
```

**Lock point:** the `Employee` row — a single serialization point shared by authenticate, logout, admin disconnect (and already by approve). Every competing writer passes through it, so cross-route races collapse to a deterministic order.

**Key invariant change:** `deleteMany({ employeeId })` is **removed** from authenticate. No login ever deletes a token it did not itself just replace.

---

## 5. Device State Model

`Device.status` is the **operational/display state**, never the authentication authority.

| Status | Meaning | Authentication effect |
|---|---|---|
| `online` | Valid token beat recently (or just authenticated) | Eligible — token may validate |
| `offline` | Last logout / admin disconnect / login-marked | Eligible — token may validate, device may re-login |
| `inactive` | Admin revoked / approve-deactivated | **Ineligible** — tokens fail closed; PATH A pre-check rejects |
| `maintenance` / `retired` | Operational states (free string, existing) | Ineligible — fail closed |

Rules:

- `online` ≠ active. A device can be `online` with **no** valid token (stale after logout) — it must not block another device.
- `offline` keeps the device re-login-eligible; `inactive` does not (existing `validateAgentToken` device check, auth.ts:137).
- **Active indicator** = *"this device holds the employee's sole valid AgentToken"* (computed from tokens, §15). `Device.status` never proves active authentication.

## 6. Authentication State Model

```
ACTIVE       — employee has exactly one valid AgentToken, bound to THIS device
INACTIVE     — registered, but another device holds the valid token (or none exists)
NONE         — no valid token for the employee at all
```

An employee has exactly one of these **at the token level**; the ACTIVE device is the one whose id matches `validToken.deviceId`. Every other registered device is INACTIVE regardless of its `Device.status`.

## 7. Registration State Model

Unchanged from the current verified lifecycle (`DeviceClaim.status` plane):

```
pending → approved | rejected | expired | cancelled | revoked
```

Registration (Device + DeviceClaim) is **orthogonal** to activation. Approving a new claim for an employee with an active device registers the device; it does **not** delete the active token (the token's device would first have to be deactivated at approval time — existing approve behavior flips the *other* devices to `inactive`, which fail-closes their tokens at next use; that behavior is kept and is consistent: the newly approved device becomes active only when it authenticates, at which point the slot rules apply).

## 8. AgentToken Authority

**Active token definition** (all must hold — the single authority predicate):

1. `AgentToken` row exists;
2. `token.employeeId === employee.id`;
3. `token.deviceId` is set and `=== device.id`;
4. `token.expiresAt > now` (expired tokens never count, never block);
5. `employee.status === 'active'`;
6. `employee.agentApproved === true`;
7. `AgentAccount` exists and `AgentAccount.status === 'active'`;
8. `Device.status ∈ {online, offline}` (device still eligible);
9. `Organization.status === 'active'`;
10. token has not been deleted (deletion **is** revocation in this schema — there is no soft-revoke state);
11. **Additional condition (new):** `device.employeeId === token.employeeId` and `device.organizationId === employee.organizationId` (ownership consistency — a device re-bound to another employee or moved org can never keep authenticating).

This is the predicate used in three places: `validateAgentToken` (use-time), the login in-tx conflict check (issue-time), and the admin Active indicator (display-time). Expiry is the only time-relative clause; a database constraint can never express it (STEP 2 §16), so application enforcement under the row lock is the only correct mechanism.

---

## 9. Login Transaction

Exact transaction (shared by PATH A and PATH B; PATH B resolves the device by `(employeeId, hostname)` find-or-create **inside** the tx so a 409 rollback leaves no device row behind):

```
db.$transaction(async tx => {
  1. await tx.$queryRaw`SELECT id FROM "Employee" WHERE id = ${employeeId} FOR UPDATE`;

  2. const emp = await tx.employee.findUnique({ where: { id: employeeId } });
     // read the LATEST committed row — the lock wait ended after the
     // competing transaction committed, so this re-read observes it.

  3. Verify (fail closed, inside the lock):
     emp.status === 'active'
     emp.agentApproved === true
     AgentAccount.status === 'active'          (account row exists)
     Organization.status === 'active'

  4. Resolve requested device:
     PATH A: claim.deviceId (claim already verified approved + secret before tx)
     PATH B: find-or-create Device by (employeeId, hostname)

  5. Verify device ownership:
     device.employeeId === employeeId
     device.organizationId === emp.organizationId

  6. Verify device status: device.status ∈ {online, offline}
     (rejects inactive/revoked/maintenance/retired devices under the lock)

  7. const validTokens = await tx.agentToken.findMany({
         where: { employeeId,
                  expiresAt: { gt: new Date() } },
         include: { device: { select: { status: true, employeeId: true, organizationId: true } } } });

  8. Ignore expired tokens (done by the > now filter). Also ignore tokens
     whose device is now ineligible (status ∉ {online, offline} or
     ownership mismatch) or whose deviceId is null — such tokens can never
     validate, so they must not block, and never count as "another active device".

  9. const other = validTokens.filter(t => t.deviceId !== requestingDeviceId);
     if (other.length > 0) throw new ActiveDeviceConflictError();
     // → route maps to HTTP 409 { error: 'ACTIVE_DEVICE_EXISTS' }
     // → transaction ROLLS BACK:
     //    no token deleted, no device state changed, no audit row,
     //    PATH B's find-or-create device row is rolled back too.
     //    ZERO persistent mutation in this branch.

  10. if (validTokens.length > 0) {
        // same device re-login: revoke this device's own token(s) only
        await tx.agentToken.deleteMany({
          where: { id: { in: validTokens.map(t => t.id) } } });
      }

  11. const token = generateToken(64);
      await tx.agentToken.create({ token, employeeId, deviceId, ipAddress,
                                   userAgent, expiresAt: now + 24h });

      // device state + audit (existing behavior, inside the same tx)
      device.status = 'online'; lastHeartbeat = now
      audit: action 'login', resource 'device', description with hostname,
             userId employee.id, ipAddress, organizationId

      return { token, expiresAt };
}, { isolationLevel: 'ReadCommitted' })   // Prisma default; FOR UPDATE provides the serialization
```

### Why Employee FOR UPDATE prevents 200 + 200

Device A and Device B logins for the same employee run concurrently:

1. Both reach `SELECT … FOR UPDATE` on the **same** Employee row. PostgreSQL grants the row lock to **one** transaction; the other blocks.
2. Transaction 1 completes under the lock (creates its token) and commits; the lock is released **only at commit** (row locks are held to end of transaction).
3. Transaction 2 acquires the lock on the now-committed row version. Its subsequent reads (statement snapshot taken **after** the lock is acquired, READ COMMITTED) observe transaction 1's token.
4. Transaction 2's predicate sees a valid token on a **different** device → throws → 409, full rollback.

Exactly **one** success is therefore guaranteed: `200 + 409`, never `200 + 200`. The lock is the same primitive already proven by the approve route under real PostgreSQL concurrency (approve/route.ts:112–123); the single difference is that the predicate is the credential-based token check, not a device status flip.

---

## 10. Same-Device Login

Employee: PC-01 active. PC-01 logs in again.

- Old token is **deleted** (hard delete — the schema's only revocation primitive; `logout/route.ts:55` and the expiry cleanup in `auth.ts:102` already delete on sight. A soft state would require a new column/enum — explicitly rejected in §25).
- New token issued with a fresh 24h expiry.
- PC-01 stays active; no other device is touched; **no 409**.
- Device `status='online'`, `lastHeartbeat=now`, login audit (existing behavior).

```
PC-01 token T1 (valid) → re-login → T1 deleted → T2 issued → PC-01 ACTIVE (T2)
```

Concurrent same-device re-logins serialize on the Employee lock; each replaces the previous token; the final state is exactly one valid token. No new token state, no schema change.

## 11. Different-Device Login

Employee: PC-01 active. Laptop-01 attempts login.

```
HTTP 409
{
  "error": "ACTIVE_DEVICE_EXISTS"
}
```

- **PC-01 remains active; its token remains valid.**
- **Laptop-01 receives no token** (rollback — nothing persists; PATH B creates no device row).
- Laptop-01's `Device.status` is not changed (and if no row existed, no row is created).
- No DeviceClaim is deleted; no registration removed; no token deleted.
- The rejected attempt is audited with **safe fields only** (§14).

The 409 response **MUST NOT** include: the active device's hostname/name/id, any token, internal device IDs, IP addresses, timestamps, or metadata. It may carry an optional static message that contains no device information; the desktop renders its own fixed copy (§16). The active device's identity is never disclosed to the requesting device.

## 12. Logout

`POST /api/agent/logout` — AgentToken branch only (AgentSession branch unchanged):

1. Authenticate the bearer token (existing lookup by token value).
2. Open a transaction: `SELECT … FOR UPDATE` on the token's Employee row (if the employee row still exists; orphan token → plain delete, no lock).
3. `agentToken.delete({ id })` — revokes the credential; the active slot is free.
4. Mark the device: `device.status = 'offline'`, `lastHeartbeat = now` (accurate "last seen"; `offline` keeps the device re-login-eligible — `inactive` would wrongly exclude it, STEP 2 §11).
5. `AuditLog` `action:'logout'`, `resource:'agent_account'`, `resourceId: employeeId`, safe description, `ipAddress`, `organizationId` (existing shape).
6. Preserve: Employee, AgentAccount, Device, DeviceClaim, Activities, Screenshots (none are touched).

**Idempotent:** missing/invalid/absent token → `{ success: true }` (existing behavior, lines 24–30, 58–60); repeating logout after the token is gone is a no-op success. A concurrent logout of an already-revoked token simply finds nothing.

```
PC-01 ACTIVE → logout → token deleted, PC-01 'offline', slot free
     → Laptop-01 login → no valid token → Laptop-01 ACTIVE
```

**Why logout takes the employee lock:** §19 CASE 2. Without the lock, a logout racing a login on another device could interleave unpredictably; with the lock both orderings are deterministic (login-first ⇒ Laptop-01 409 then retry; logout-first ⇒ Laptop-01 200).

## 13. Admin Disconnect

New endpoint: **`POST /api/devices/[id]/disconnect`** (not DELETE — §14).

```
POST /api/devices/[id]/disconnect     (admin, org-scoped)
1. requireAdminOrg(req)                    — admin RBAC (existing helper)
2. rate limit: RATE_LIMITS.deviceWrite (30/min/IP)
3. device = device.findFirst({ id, organizationId: admin.organizationId })
     — cross-org id ⇒ 404 (indistinguishable from missing, existing convention)
4. tx:
   a. if device.employeeId: lock that Employee row FOR UPDATE
      (serializes against concurrent login/logout on the same employee)
   b. agentToken.deleteMany({ deviceId: device.id })
      — revokes the active slot IF this device held it
   c. device.update({ status: 'offline', lastHeartbeat: now })
   d. AuditLog: action 'disconnect', resource 'device',
      resourceId device.id, userId admin.userId,
      description "Device disconnected by admin: <hostname/name>",
      ipAddress, organizationId
5. 200 { success: true, data: { id, status: 'offline' } }
```

Guarantees:

- **Idempotent** — deleting already-deleted tokens and re-setting `offline` is a no-op; repeating returns the same success.
- Preserves the Device row, DeviceClaim history, Activities, Screenshots, Employee, AgentAccount — **nothing cascades**.
- Cross-organization device id → **404**; non-admin (viewer) → **403** (existing `requireAdminOrg`/`authError`).
- No arbitrary employee/device reassignment is performed; ownership is never changed.

## 14. Delete vs Disconnect

`DELETE /api/devices/[id]` (current: `devices/[id]/route.ts:82–103`) cascades **DeviceClaims + Activities + Screenshots** (STEP 2 §14). Decision: **keep it as a high-risk permanent deletion operation (option B), never the everyday disconnect.**

| | **DISCONNECT** | **DELETE** |
|---|---|---|
| Semantics | Reversible operational state | Destructive, irreversible data removal |
| Token effect | Delete tokens for the device | Delete tokens for the device (additive hardening; today they orphan) |
| Device row | Preserved (`offline`) | Removed |
| DeviceClaim history | Preserved | Cascade-deleted |
| Activities / Screenshots | Preserved | Cascade-deleted |
| Reversibility | Device may re-login and reactivate | Device must re-register from scratch (fresh claim) |
| RBAC | Admin, org-scoped | Admin, org-scoped **+ UI explicit confirmation with cascade warning** |

Implementation changes to DELETE: (a) delete the device's AgentTokens inside the same transaction as the device delete (hygiene; currently orphaned rows fail closed anyway); (b) admin UI surfaces a confirmation dialog listing what will be destroyed (claims, activities, screenshots, active session) and requiring an explicit confirm; (c) the Devices table presents **Disconnect** as the primary action and keeps **Delete** visually distinct (destructive styling, never adjacent equivalent).

## 15. Heartbeat

Responsibility split (four independent planes):

| Plane | Authority | Field(s) |
|---|---|---|
| Authentication | **AgentToken** (exists + expiry + bindings + statuses) | `AgentToken.*` |
| Connection health | **Heartbeat** | `Device.status='online'`, `Device.lastHeartbeat`, `ipAddress` |
| Operational/display state | **Device.status** | free string, display only |
| Registration/approval history | **DeviceClaim** | `status`, `approvedBy`, timestamps |

- Heartbeat updates `status='online'` + `lastHeartbeat` — it reports "a valid token beat at some point", nothing more.
- **Stale heartbeat does NOT invalidate authentication.** Nothing in the current architecture ties token validity to heartbeat cadence; this design adds no such tie (an offline device whose token is valid keeps a valid token until expiry — correct: a laptop in sleep mode must not be silently logged out).
- **Stale `Device.status='online'` with no valid token must NOT block another device.** The conflict predicate inspects tokens, never status. AD-04/AD-05 exercise this: after logout PC-01 sits `offline`; a stale-`online` device without a token never produces a 409.
- Optional future (out of scope, display-only): a job aging `online → offline` after N missed beats. Not required for correctness, not part of this design.

## 16. Token Validation (validateAgentToken hardening)

New validation order in `src/lib/agent/auth.ts:61–164` — all checks **fail closed**, each returns `{ valid: false, error }` with the existing generic messages (no reason enumeration beyond today's vocabulary, no secrets):

| # | Check | Status today |
|---|---|---|
| 1 | token exists | ✓ (auth.ts:95) |
| 2 | not expired (delete on sight) | ✓ (auth.ts:100) |
| 3 | employee exists | ✓ (implied by FK + select) |
| 4 | employee active | ✓ (auth.ts:112) |
| 5 | employee approved | ✓ (auth.ts:107) |
| 6 | AgentAccount exists + active | ✓ (auth.ts:119–126) |
| 7 | device exists | ✓ (auth.ts:133–136) |
| 8 | device allowed (`online`\|`offline`) | ✓ (auth.ts:137) |
| 9 | **Organization exists + active** | **NEW** (mirrors `validateAgentSession` session.ts:136–143; org-disable must fail closed at token use) |
| 10 | token.deviceId's device is owned by the token's employee **and same org** (`device.employeeId === token.employeeId`, `device.organizationId === employee.organizationId`) | **NEW** (defense-in-depth against a re-bound/reassigned device) |
| 11 | token `employeeId` context matches the server-derived employee context | inherent (token→employee FK); ownership check #10 closes the device-side gap |

`lastUsedAt` update stays best-effort. Errors never expose `passwordHash`, token values, secrets, or organization internals (existing log lines log only employeeId slice + IP; keep that discipline; metadata never written to logs).

## 17. PATH A Authentication Hardening

`authenticateDevice` (`authenticate/route.ts:193–311`) before issuing a token must verify — in addition to the existing claim/secret/employee checks:

- **`AgentAccount.status === 'active'`** (currently absent — a disabled account could mint a fresh token);
- **`Device.status ∈ {online, offline}`** (currently absent — an `inactive`/revoked device with an approved claim could re-auth; closes the STEP 2 §15 gap);
- **`Organization.status === 'active'`** (currently absent at this entry point);
- **Employee row locked** (via the shared transaction, §9);
- **Existing valid token checked** — second device ⇒ 409 (§11);
- The employee/account/org/device statuses are **re-verified inside the locked transaction** so a disable landing mid-flight cannot mint a token (§19 CASE 5/6).

PATH B gains the same in-tx re-checks (AgentAccount + Organization) and the shared conflict logic; its pre-tx device resolution is unchanged (legacy `(employeeId, hostname)` matching preserved — STEP 2 §14).

**No path ever deletes another device's token.** The `deleteMany({ employeeId })` calls (lines 87, 255) are removed in favor of the locked predicate.

## 18. Zero-Touch Compatibility

Anonymous zero-touch flow — **unchanged, byte-for-byte**:

```
discover() → new Device → pending DeviceClaim → admin approval → ownership → AgentToken
```

- The 409 logic exists **only** in `POST /api/agent/authenticate`. `POST /api/agent/discover`, claim issuance, polling, approval, rejection, cancellation, and expiration handling are untouched.
- Anonymous discovery never requires or checks employee/account/org state (it is pre-ownership); authenticated discovery continues to use the AgentSession flow as today.
- Phase 4 existing-device rediscovery protections (cross-employee 404, cross-org 404, revoked-device no-rebind, in-tx ownership lock, concurrency safety) are all preserved — this design adds no new restriction to `discover`.
- Test AD-28 guards the full zero-touch path against regression.

## 19. Concurrency / Race Handling

All races resolve through **server-side transaction ordering on the Employee row**. Exact outcomes:

| CASE | Race | Ordering | Final state |
|---|---|---|---|
| **1** | PC-01 login ‖ Laptop-01 login | Employee lock serializes | **Exactly one 200; other gets 409.** Never 200+200. Loser's tx fully rolled back (no row, no audit mutation). |
| **2** | PC-01 logout ‖ Laptop-01 login | Logout takes the employee lock too | (a) logout commits first → no valid token → Laptop-01 200, PC-01 `offline`; (b) login commits first → Laptop-01 409 (PC-01 token still valid) → PC-01 logout proceeds → slot free → Laptop-01 retry ⇒ 200. Deterministic per order; no corruption. |
| **3** | PC-01 login ‖ admin disconnect(PC-01) | Disconnect takes the employee lock (via device.employeeId) | (a) login first → token exists → disconnect deletes it → no active token, device `offline` (admin wins; reconnect permitted); (b) disconnect first → no valid token → login 200 → PC-01 active. Safe in both orders; admin can re-disconnect. |
| **4** | PC-01 login ‖ claim revoke(PC-01) | Revoke flips claim→`revoked`, device→`inactive` (no employee lock needed — its effect is independent and fail-closed) | (a) revoke first → PATH A pre-check rejects (claim not approved) → 403; (b) login first → token minted, then device `inactive` → token fails closed at validation (auth.ts:137). Revoked device is inert either way. |
| **5** | PC-01 login ‖ AgentAccount disabled | In-tx account re-check under lock | (a) disable first → login aborts before token mint (uniform 401/403, no enumeration); (b) login first → token exists but validation fails closed (account check). Never a usable token from a disabled account. |
| **6** | PC-01 login ‖ Employee disabled | In-tx employee re-check under lock | Same as CASE 5 with `employee.status`; pre-tx and in-tx checks both reject. |

**Design rule:** any writer that frees or acquires the employee's active slot (authenticate, logout, admin disconnect) takes the Employee row lock; readers of the slot (approve's device deactivation, revoke's device flip) keep their existing fail-closed semantics, which are safe in every interleaving.

## 20. Ping-Pong Prevention

**Prohibited behavior** (the current `deleteMany` kick):

```
Device B login → delete Device A token → Device B active        ✗ NEVER
```

**Replacement behavior:**

```
Device B login → 409 ACTIVE_DEVICE_EXISTS → Device A stays active ✗ no kick
```

Enforcement on three layers:

1. **Server:** the conflict branch precedes any write and rolls back; there is no code path that deletes another device's token.
2. **Desktop agent:** a new terminal auth phase `active_device_exists` (§23). `recover()` / `recoverIfNeeded()` / `startDiscoveryRetry()` / `retryConnect()` all check the phase and **stop automatic re-authentication** when it is set. No automatic retry into a 409 — the kick-war's fuel (auto re-login) is removed. Recovery timers are cancelled; only an explicit employee action (button) re-attempts, and the transport-level client never retries 4xx (client.ts:116–118).
3. **Rate limit:** even a manual repeated attempt is bounded by the existing `agentAuthenticate` 20/min/IP limit.

## 21. Audit Logging

Audit events, using existing `AuditLog` capabilities (`action` free string; `metadata` JSON string for machine-readable detail; safe fields only):

| Event | action | resource | resourceId | metadata | Never log |
|---|---|---|---|---|---|
| `agent_login_success` | `login` | `device` | device.id | `{ event: 'agent_login_success' }` | token, password |
| `agent_login_rejected_active_device` | `deny` | `device` | requesting device.id | `{ event: 'agent_login_rejected_active_device' }` | active device's id/hostname, tokens |
| `agent_logout` | `logout` | `agent_account` | employeeId | `{ event: 'agent_logout' }` | token |
| `admin_device_disconnect` | `disconnect` | `device` | device.id | `{ event: 'admin_device_disconnect' }` | — |
| `device_rejected_authentication` (optional, on PATH A 401/403 claim/secret failures) | `deny` | `device` | device.id | `{ event: 'device_rejected_authentication', reason: <generic> }` | secret, claimSecretHash |

Rules:

- **Never** log: passwords, `passwordHash`, AgentToken values, AgentSession tokens, claim secrets/hashes, full bearer headers.
- The 409 audit records the **requesting** device's id (the device that attempted) and employee id — **not** the identity of the device holding the slot (no leak of which device is active through audit trails accessible to device-side flows).
- `description` keeps the existing human-readable format (employee name + requesting device hostname) — hostname of the *requesting* device is already part of the current contract (today's login audits include it; logout audits do not include hostnames at all).
- All audit rows are written inside the same transaction as their action (login audit in the login tx; disconnect audit in the disconnect tx), so an audit never records an action that rolled back.

## 22. Admin UI

`Admin → Devices` (`src/components/devices/*`) — new/changed columns and action:

| Column | Source | Example |
|---|---|---|
| Employee | `device.employee` (existing) | Rimon |
| Device | `device.name` / hostname (existing) | PC-01 |
| Registration status | latest `DeviceClaim.status` for the device (server-computed) | Registered / Pending / Revoked |
| Connection status | `device.status` (existing) | online / offline |
| **Active indicator** | **server-computed from AgentToken predicate** — `true` iff this device holds the employee's sole valid token | ACTIVE / INACTIVE |
| Last login | latest `AuditLog` (`action:'login'`, `resource:'device'`, `resourceId=device.id`) or token `createdAt` when active | 2 hours ago |
| Last heartbeat | `device.lastHeartbeat` (existing) | 5 min ago |
| Registered date | `device.registeredAt` (existing) | Aug 1, 2026 |

Actions:

- **Disconnect Device** — primary action; calls `POST /api/devices/[id]/disconnect`; no cascade; refresh queries.
- **Delete** — visually distinct destructive action behind an explicit confirmation dialog listing the cascade impact (claims, activities, screenshots, active session) with a required confirm; never presented as equivalent to disconnect.
- Status vocabulary in the table badge is updated to show the **Active indicator** next to connection status (e.g. `ACTIVE` badge + `online` sub-badge), so a stale `online` device without a token reads as INACTIVE — the STEP 2 R4 fix.
- RBAC: reuse existing session/admin guards on the API (`requireAdminOrg`); viewers see the list but no Disconnect/Delete actions (client-side hidden + server 403).

## 23. Desktop UX

Exact behavior per state (auth-service phases + renderer views):

| State | Phase / behavior |
|---|---|
| **LOGIN** | Existing login view (`unregistered`/`error` + loginRequested). |
| **LOGGED_IN** | `authenticated` with `sessionOnly` (AgentSession pre-approval) — unchanged. |
| **ACTIVE** | `authenticated` with device token — runtime runs (existing). |
| **LOGOUT** | `logout()` → clears token/credentials/claim/session; `unregistered`; server revokes token + device `offline`. |
| **ACTIVE_DEVICE_EXISTS** | **NEW** `active_device_exists` phase. Set when `authenticate`/`authenticateDevice`/`recover` receives `409 { error: 'ACTIVE_DEVICE_EXISTS' }`. Terminal: **no automatic re-login, no discovery retry, no approval polling; all recovery timers cancelled.** Renderer shows a dedicated view with the exact message: *"Your WorkLensAI account is already active on another device. Log out from that device before connecting this one."* A single manual "Try again" button re-attempts (rate-limited); internal device information is never shown. |
| **DISCONNECTED** | Heartbeat failing / admin disconnected / offline → existing `offline` view (`connected=false`); after admin disconnect the next 401 triggers `recover()` — if the slot is free the device reconnects (documented, §13 CASE 3(b)); if another device took the slot the agent transitions to `active_device_exists` and stops. |
| **PENDING** | `pending_approval` — unchanged (poll continues). |
| **REVOKED** | `revoked` — unchanged (terminal). |
| **ERROR** | `error` (network/5xx) — unchanged (offline view + bounded retry). |

Client-side retry policy: `ApiClient` already never retries 4xx (only network/5xx/429), and `authenticate`/`authenticateDevice` are already `retries: 0` (device.ts:44, 87). The 409 must additionally suppress the **orchestrator-level** automatic recovery (`recoverIfNeeded`, `startDiscoveryRetry`, `retryConnect`, `pollApproval`), which today would re-drive `recover()` and re-hit the endpoint — that is the exact ping-pong mechanism identified in STEP 1.

## 24. Security Model

| Requirement | Mechanism |
|---|---|
| Employee identity server-derived | Unchanged: PATH A via approved claim binding; PATH B via password-authenticated employee; body never selects identity |
| Organization server-derived | Unchanged; added org check at token use (validateAgentToken) and at issue time (both paths) |
| Device ownership server-derived | Claim binding + in-tx ownership re-verification (§9 step 5) + validation-time ownership check (§16 #10) |
| Cross-org isolation | Org-scoped `findFirst` in all device routes (404); disconnect cross-org → 404; token org-consistency check |
| Cross-employee isolation | Employee lock + employee-scoped predicate; claim-bound device; Phase 4 404 rules untouched |
| Forged identity (employeeId/org/deviceId in body) | Body identity fields ignored by both authenticated paths; device comes from claim (A) or authenticated employee (B); device id in the tx comes from server lookup |
| Revoked device rejected | Claim must be `approved` (PATH A pre-check) + `Device.status` must be eligible (new PATH A check + token-use check) |
| Disabled employee/account/org rejected | Pre-tx + in-tx re-checks (§9 step 3) + use-time checks (validation) — all fail closed |
| Expired/ineligible token cannot block | Predicate filters `expiresAt > now` and device eligibility (§9 step 8) |
| No token/password leakage | Response contains only token/expiry/deviceId/employeeId/name (existing contract); 409 body is a fixed error code; audit/log discipline per §21 |
| Rate limiting | Existing `agentAuthenticate` (20/min/IP) on both paths; `deviceWrite` on disconnect |
| Fail-closed validation | Every check in §16 returns invalid on any doubt; generic errors only |

## 25. Migration Decision

**NO MIGRATION REQUIRED.**

Re-verified against this design: no `activeDeviceId`, no new enum, no new unique/partial index, no new relation, no new column. `AgentToken.employeeId/deviceId/expiresAt` + `Employee` row lock express the single-active rule completely; `Device.status`, `DeviceClaim.status`, `AgentAccount.status`, `Employee.status`, `Organization.status` are all free strings already in use. The only new persistence is the `AuditLog` rows for disconnect/deny events, which use existing columns (`action`, `metadata`). A partial-unique-index approach was ruled out in STEP 2 §16 (cannot express the time-relative predicate; Prisma-incompatible; adds no enforcement over the lock).

If a future implementation proves the schema insufficient, STOP and revisit this section before any migration.

## 26. File-by-File Implementation Plan

All file paths verified to exist. Order = dependency order (server first, desktop last).

| # | Path | Function/component | Current behavior | Required change | Security impact | Test impact |
|---|---|---|---|---|---|---|
| 1 | `src/lib/agent/auth.ts` | `validateAgentToken` | 10 checks, no org check, no ownership check | Add `Organization.status === 'active'`; add device-ownership/org-consistency checks (§16 #9–10) | Closes org-disable token-use gap; re-bound device fails closed | AD-17, AD-18, AD-19 |
| 2 | `src/lib/agent/activation.ts` | **NEW** `acquireActiveSlot(tx, {employeeId, deviceId})` + `ActiveDeviceConflictError` + in-tx eligibility re-check helper | — | Lock Employee `FOR UPDATE`; run valid-token predicate (§9); throw conflict / replace same-device / no-op; returns decision | Single serialization point; no kick possible | AD-03, AD-07, AD-08 |
| 3 | `src/app/api/agent/authenticate/route.ts` | `POST` / `authenticateDevice` | `deleteMany({employeeId})` + create; no lock; PATH A lacks account/device/org checks | Replace both tx bodies with `acquireActiveSlot`; add AgentAccount/Device/Organization pre-checks (PATH A) and account/org pre-checks (PATH B); map `ActiveDeviceConflictError` → `409 { error: 'ACTIVE_DEVICE_EXISTS' }`; keep login audit + device `online` | 409 no-kick; disabled account/org/device cannot mint tokens | AD-02…AD-13, AD-15…AD-23 |
| 4 | `src/app/api/agent/logout/route.ts` | `POST` | Deletes token/session; device stays `online` | AgentToken branch: tx with Employee lock + `agentToken.delete` + `device.status='offline'` + `lastHeartbeat=now`; keep idempotency + audit | Frees slot deterministically; honest device state | AD-05, AD-06, AD-09, AD-24 |
| 5 | `src/app/api/devices/[id]/disconnect/route.ts` | **NEW** `POST` | — | Admin-only, org-scoped, rate-limited; tx: employee lock (if bound) → delete device tokens → `offline` → audit `disconnect` (§13) | Revokes active slot without destroying history; 404 cross-org; 403 non-admin | AD-25, AD-26, AD-27, AD-29 |
| 6 | `src/app/api/devices/[id]/route.ts` | `GET` / `DELETE` | GET returns device+activities; DELETE cascades everything | GET: add `active` + `lastLoginAt` computed fields; DELETE: delete device's AgentTokens in the same tx (hygiene) | Delete stays destructive & org-scoped; no behavior change for disconnect | AD-27, AD-29 |
| 7 | `src/app/api/devices/route.ts` | `GET` (list) | device list without token/audit context | Add per-page computed `active` (valid-token predicate) + `lastLoginAt` (latest login audit, bounded query using `@@index([organizationId, createdAt])`) | Display-only; no new auth surface | AD-01, AD-04 |
| 8 | `src/app/api/agent/heartbeat/route.ts` | `POST` | token-validated status update | **No change** (verified: health-only). Optional comment update only | — | AD-09 (indirect) |
| 9 | `src/lib/agent/session.ts` | `validateAgentSession` | Already checks org/account | **No change** | — | — |
| 10 | `src/app/api/agent/login/route.ts` | `POST` | Issues AgentSession | **No change** (device concurrency is not a login concern; verified) | — | — |
| 11 | `src/components/devices/device-table.tsx` | `DeviceTable` | name/OS/assigned/status/heartbeat + Edit/Delete | Add Employee, Registration status, Active indicator, Last login columns; Disconnect action; Delete separated behind confirm with cascade warning; status vocabulary update | UI never treats `online` as active | AD-01, AD-04 (UI-level) |
| 12 | `src/components/devices/devices-page.tsx` | `DevicesPage` | `handleDelete` without confirmation | Wire disconnect handler + confirmation dialogs; invalidate queries on disconnect; render new fields | — | — |
| 13 | `src/components/devices/device-dialog.tsx` | `DeviceDialog` | edit form | Add cascade-warning text for delete; keep edit fields (status/employee reassign stays admin-only as today) | — | — |
| 14 | `desktop-agent/src/types/api.ts` | API types | no 409-specific types | Add `ACTIVE_DEVICE_EXISTS` error typing / phase type | — | AD-30 |
| 15 | `desktop-agent/src/api/device.ts` | `DeviceApi` | `retries: 0` on authenticate paths | Add 409 detection helper (`isActiveDeviceConflict(err)`) | Never auto-retries the conflict | AD-30 |
| 16 | `desktop-agent/src/auth/auth-service.ts` | `AuthService` | 409 → generic `error` phase | New `active_device_exists` phase in `authenticateDevice`, `authenticate`, `recover`; stop auto-recovery from this phase; manual retry entry point | Removes ping-pong fuel | AD-30 |
| 17 | `desktop-agent/src/services/agent-orchestrator.ts` | `AgentOrchestrator` | `recoverIfNeeded`/`startDiscoveryRetry`/`retryConnect` re-drive auth on every 401 | Guard all recovery paths on the `active_device_exists` terminal phase; cancel discovery/approval timers; surface message | No kick-war | AD-30 |
| 18 | `desktop-agent/src/renderer/renderer.ts` | renderer views | views map lacks the conflict state | New `active-device-view` + label + `onboardingView` mapping + "Try again" IPC wiring | Employee-facing message, no device details | AD-30 |
| 19 | `desktop-agent/src/main/ipc.ts` | IPC surface | — | Expose manual retry handler if not already surfaced (verify during implementation) | — | — |
| 20 | `src/lib/rate-limit.ts` | `RATE_LIMITS` | — | **No new limit** (reuse `agentAuthenticate`, `deviceWrite`); optionally add a named alias for clarity | — | — |
| 21 | `src/lib/jobs/run.ts` | job registry | expire_consents + retention_cleanup | **No change**; optional future stale-`online` aging is explicitly out of scope (§15) | — | — |
| 22 | `tests/agent-single-active-device.test.ts` | **NEW** (STEP 4) | — | AD-01…AD-30 suite, throwaway PostgreSQL (§27) | Regression net | all AD |

## 27. Test Plan (for STEP 4)

New suite `tests/agent-single-active-device.test.ts` following the repo convention (node:test + tsx, env set before module imports, `node scripts/pg-test-db.mjs ensure <db>` + `prisma db push --force-reset` on a throwaway DB, e.g. `workai_test_adactive`; run: `npx tsx --test tests/agent-single-active-device.test.ts`).

| ID | Test | Key assertions |
|---|---|---|
| AD-01 | multiple registered devices | 3 devices for one employee; all rows persist; exactly one is Active |
| AD-02 | first device login | 200; token issued; device `online`; Active indicator true |
| AD-03 | second device 409 | Laptop-01 → 409 `{ error: 'ACTIVE_DEVICE_EXISTS' }`; no token returned |
| AD-04 | first device remains active | After AD-03: PC-01 token still validates (heartbeat 200); PC-01 still Active |
| AD-05 | logout releases slot | PC-01 logout 200; no valid token; device `offline` |
| AD-06 | second device login after logout | Laptop-01 → 200; Laptop-01 Active; PC-01 INACTIVE |
| AD-07 | same-device re-login | PC-01 login × 2 → both 200; exactly one valid token; old token value fails 401 |
| AD-08 | concurrent login race | `Promise.all` of PC-01 + Laptop-01 authenticate → exactly one 200 + one 409; DB has exactly one valid token |
| AD-09 | login/logout race | Parallel logout(PC-01) + login(Laptop-01) → deterministic per order; never two tokens; no orphan device rows |
| AD-10 | login/admin-disconnect race | Parallel → final state is either (token deleted, offline) or (token valid, active); never both devices active |
| AD-11 | login/revoke race | Parallel → revoked device never obtains/keeps a usable token (token use fails closed) |
| AD-12 | login/employee-disable race | In-tx re-check: disabled employee can never mint a token; existing token fails at use |
| AD-13 | login/account-disable race | Same for AgentAccount.status |
| AD-14 | expired token ignored | Expired token (forced `expiresAt` past) does not block a new login and never 409s |
| AD-15 | revoked token rejected | Token of a revoked/inactive device fails at validateAgentToken and does not block another device |
| AD-16 | disabled device rejected | PATH A with device `status:'inactive'` → 403; no token minted |
| AD-17 | disabled organization rejected | Org suspended → login 403; existing tokens fail at use |
| AD-18 | cross-employee rejected | Device claim bound to employee A cannot authenticate as employee B (404/403) |
| AD-19 | cross-org rejected | Device in org A cannot authenticate for org B; disconnect by org B admin → 404 |
| AD-20 | forged employeeId ignored | PATH A body `employeeId` tampered → server-derived identity wins |
| AD-21 | forged organizationId ignored | Same for organizationId in body |
| AD-22 | forged deviceId ignored | PATH B deviceId in body ignored; PATH A device comes from claim |
| AD-23 | no token/password leakage | 409 body, error responses, audit rows, logs contain no token/passwordHash/secrets |
| AD-24 | logout idempotency | Logout × 2 → both `{ success: true }`; second is no-op |
| AD-25 | admin disconnect RBAC | Viewer → 403; admin org A on org B device → 404; admin own org → 200 |
| AD-26 | admin disconnect preserves registration | After disconnect: Device row, DeviceClaim rows intact; device `offline`; re-login possible |
| AD-27 | admin disconnect preserves history | Activities + Screenshots rows intact after disconnect (no cascade) |
| AD-28 | zero-touch unchanged | Full discover → claim → approve → authenticate flow passes; pending/rejected/revoked/expired/cancelled behavior unchanged |
| AD-29 | DeviceClaim history preserved | Logout + disconnect keep claim history (approvedBy/approvedAt, timestamps) |
| AD-30 | no ping-pong auto-retry | Desktop unit tests: 409 → `active_device_exists`; `recover()`/`recoverIfNeeded()`/discovery retry do not re-authenticate; only manual retry re-attempts |

## 28. Rollback Strategy

- **No migration** → rollback is a pure code revert; no data-format compatibility risk. Tokens minted by the new code are ordinary 24h AgentTokens (identical shape).
- **Deploy order:** server routes/lib first, desktop agent second. 
  - *Old agent + new server:* agent's transport layer never retries 409; the orchestrator may re-attempt `recover()` on the next heartbeat 401 (~1/min) and keep getting 409 — a benign, bounded retry with **zero server mutation** (no kick war; the active device is never disturbed). Once the new agent ships, the terminal phase ends this.
  - *New agent + old server:* old server never returns 409 (it kicks); the new agent's `active_device_exists` phase simply never triggers. Fully compatible.
- **Feature gate (optional):** if mid-deployment a regression appears, the 409 branch can be toggled off via an env flag (e.g. `AGENT_SINGLE_ACTIVE_DISABLE=1` → revert to legacy kick) without redeploying the agent; document that this reintroduces R1/R2 and is for emergency only.
- **Admin remedy:** any erroneous disconnect is reversible by the device re-logging in (registration preserved); erroneous revoke requires admin re-approval (existing claim lifecycle).

## 29. Risks

| # | Risk | Mitigation |
|---|---|---|
| R1 | Double-activation race (200+200) | Employee `FOR UPDATE` at authenticate (proven pattern, approve route) |
| R2 | Ping-pong kick war | 409 + terminal desktop phase + no auto-retry + transport never retries 4xx |
| R3 | Stale `online` misleads admins | Active indicator from token predicate, not status; optional future aging job |
| R4 | PATH A re-auth of inactive device | New `Device.status` pre-check + in-tx re-check |
| R5 | Disabled account/org minting tokens | Account/org checks at issue time (both paths) + org check at use time |
| R6 | DELETE destroys history | Disconnect is the default op; DELETE gated behind explicit cascade-confirmation |
| R7 | Admin disconnect undone by agent auto-reconnect | Documented behavior (§13 CASE 3(b)); permanence requires Revoke; agent rate-limited |
| R8 | In-tx status re-checks diverge from use-time checks | Single shared predicate in `lib/agent/activation.ts` + `validateAgentToken`; AD-12/13/15 guard both layers |
| R9 | Legacy PATH B hostname reuse interplay | Unchanged matching semantics; single-active still governs token issuance; AD-03 covers hostname-reuse 409 |
| R10 | Concurrency test flakiness on CI | Race tests assert DB final state (exactly one valid token) in addition to status codes |

## 30. Acceptance Criteria

The design is acceptable only if it guarantees:

- [x] Multiple registered devices per employee
- [x] Maximum one valid active AgentToken per employee
- [x] Employee row locking
- [x] Second device receives 409
- [x] Existing device is never silently kicked
- [x] Same-device re-login works
- [x] Logout releases active slot
- [x] Admin disconnect releases active slot
- [x] Device registration survives logout
- [x] Device registration survives disconnect
- [x] DeviceClaim history survives disconnect
- [x] Activities/screenshots survive disconnect
- [x] Cross-org isolation
- [x] Cross-employee isolation
- [x] Forged identity ignored
- [x] Revoked device rejected
- [x] Disabled employee rejected
- [x] Disabled AgentAccount rejected
- [x] Disabled organization rejected
- [x] Expired token cannot block another device
- [x] Heartbeat is not authentication authority
- [x] No ping-pong auto-login
- [x] No token/password logging
- [x] Zero-touch remains unchanged
- [x] No unnecessary Prisma migration
- [x] Race conditions explicitly handled
- [x] Admin has Disconnect operation
- [x] DELETE is not used as normal disconnect

---

```
STEP:   3 — Single-Active-Device Design
STATUS: COMPLETE

Files inspected:
  workload/71-Agent-Database-Device-Lifecycle-Audit.md (STEP 2 report)
  prisma/schema.prisma (Employee, AgentAccount, Device, DeviceClaim, AgentToken,
    AgentSession, AuditLog, Activity, Screenshot, Organization)
  src/app/api/agent/authenticate/route.ts · login/route.ts · logout/route.ts
    · heartbeat/route.ts
  src/app/api/devices/route.ts · devices/[id]/route.ts
  src/app/api/device-claims/[id]/approve/route.ts
  src/lib/agent/auth.ts · src/lib/agent/session.ts · src/lib/api.ts
    · src/lib/rate-limit.ts
  src/components/devices/devices-page.tsx · device-table.tsx · device-dialog.tsx
  desktop-agent/src/auth/auth-service.ts · services/agent-orchestrator.ts
    · api/device.ts · api/client.ts · renderer/renderer.ts · types/api.ts
  tests/agent-existing-device-security.test.ts (test conventions)

Files modified:   none
Files created:    workload/72-Agent-Single-Active-Device-Design.md

Migration:
  NO — existing AgentToken/Employee/Device/Organization columns + Employee row
  lock express "many registered devices, max one valid active token" with no
  schema change (re-verified in §25).

Recommended architecture:
  OPTION A (STEP 2): Employee FOR UPDATE → expiry-aware, device-eligible
  AgentToken predicate → another device ⇒ 409 ACTIVE_DEVICE_EXISTS (full
  rollback, zero mutation, no kick); same device ⇒ delete + re-issue; in-tx
  employee/account/org/device status re-checks. Plus: logout + admin
  disconnect take the same lock and set device 'offline'; validateAgentToken
  gains Organization.status + device-ownership checks; Active indicator
  derived from token presence; terminal desktop ACTIVE_DEVICE_EXISTS phase
  with no auto-retry.

Critical decisions:
  1. Single shared locked predicate helper (lib/agent/activation.ts) used by
     both authenticate paths — one serialization point, no kick path.
  2. Conflict branch precedes ALL writes; PATH B device find-or-create runs
     inside the tx so a 409 rolls back even the device row.
  3. Predicate filters expired AND device-ineligible tokens (revoked/disabled
     device tokens can never block another device, and never trigger 409).
  4. Same-device re-login hard-deletes the old token (deletion is revocation
     in this schema — no new token states, no migration).
  5. Logout and admin disconnect acquire the Employee lock for deterministic
     race ordering; disconnect is POST /api/devices/[id]/disconnect,
     DELETE stays destructive-with-confirmation.
  6. validateAgentToken adds Organization.status and device ownership
     consistency checks (fail closed).
  7. Desktop agent maps 409 to a terminal phase; every auto-recovery path
     (recover/recoverIfNeeded/discovery-retry/retryConnect) is guarded —
     the ping-pong war cannot start.

Implementation files (server → desktop order):
  src/lib/agent/auth.ts · src/lib/agent/activation.ts (NEW) ·
  src/app/api/agent/authenticate/route.ts · src/app/api/agent/logout/route.ts ·
  src/app/api/devices/[id]/disconnect/route.ts (NEW) ·
  src/app/api/devices/[id]/route.ts · src/app/api/devices/route.ts ·
  src/components/devices/{device-table,devices-page,device-dialog}.tsx ·
  desktop-agent/src/types/api.ts · desktop-agent/src/api/device.ts ·
  desktop-agent/src/auth/auth-service.ts ·
  desktop-agent/src/services/agent-orchestrator.ts ·
  desktop-agent/src/renderer/renderer.ts · (desktop-agent/src/main/ipc.ts,
  verify during implementation)

Test plan (STEP 4):
  tests/agent-single-active-device.test.ts — AD-01…AD-30 (see §27),
  node:test + tsx against throwaway PostgreSQL (workai_test_adactive),
  run: npx tsx --test tests/agent-single-active-device.test.ts

Next step:
  STEP 4 — Backend Implementation
```
