# Phase 3 — STEP 1: Agent Authentication Architecture Audit

> **Scope:** READ-ONLY audit. No code was modified.
> **Date:** 2026-08-10
> **Objective:** Determine the exact architecture for `POST /api/agent/login`, token design, discover integration, and logout — building on Phase 1's `AgentAccount` service and Phase 2's Admin management.

---

## 1. Current authentication landscape

The codebase has **three authentication paths** today:

| Path | Route | Credential | Issues status check? | Lockout? | Device binding? | Token |
|---|---|---|---|---|---|---|
| **Zero-touch** (PATH A) | `POST /api/agent/discover` + `POST /api/agent/authenticate` | deviceKey → DeviceClaim secret | ✅ employee status + device status | ❌ (device secret, not account) | ✅ after approval | 24h AgentToken |
| **Legacy PATH B** | `POST /api/agent/authenticate` | `Employee.employeeId` + `Employee.agentPassword` | ❌ only `agentApproved` + employee status — **no AgentAccount** | ❌ | ✅ (conflates login + device creation) | 24h AgentToken |
| **New (Phase 1)** | `verifyAgentCredential()` in `src/lib/agent-account.ts` | `AgentAccount.agentId` + `AgentAccount.passwordHash` | ✅ status, lockout, employee status | ✅ (5 fails → 15 min) | ❌ (pure credential verify) | **Not yet issued** |

**The new login must use the Phase 1 path** — `verifyAgentCredential()` — and NOT reuse the legacy PATH B which still reads `Employee.agentPassword` and has no lockout.

---

## 2. Existing token infrastructure

### AgentToken (Prisma model)

```prisma
model AgentToken {
  id           String   @id @default(cuid())
  token        String   @unique   // 64-char random (randomBytes)
  employeeId   String
  deviceId     String?             // bound after device approval
  ipAddress    String?
  userAgent    String?
  expiresAt    DateTime            // 24h
  lastUsedAt   DateTime @default(now())
  createdAt    DateTime @default(now())
}
```

- `validateAgentToken()` in `src/lib/agent/auth.ts` validates bearer, checks expiry, employee `agentApproved + status active`, **device status (online/offline)**.
- Device status check means a token without a device (null deviceId) or with an inactive device is REJECTED.

### Problem for Phase 3 login

A login token should NOT require device binding. The flow is:

```
Login → session token (NO device yet)
  ↓
Discover → DeviceClaim → pending
  ↓
Approve → 24h AgentToken (device-bound)
```

If we reused `AgentToken` for the login session, `validateAgentToken()` would reject tokens with no deviceId because:
1. Device lookup would fail (null deviceId)
2. Even with deviceId null, the code at line `if (agentToken.deviceId)` would skip the check, but the token design becomes muddy — is it a "login session" or a "device agent token"?

**Recommendation: New `AgentSession` model** — short-lived (10–15 min), no device binding, used only to authenticate the discover call. The existing `AgentToken` stays unchanged for the device-bound phase.

---

## 3. Recommended login architecture

```
┌─────────────────────────────────────────────────────────────────┐
│  POST /api/agent/login                                         │
│  { "agentId": "...", "password": "..." }                        │
├─────────────────────────────────────────────────────────────────┤
│  1. Resolve AgentAccount by agentId                             │
│  2. verifyAgentCredential() — status check, lockout, bcrypt     │
│  3. Resolve Employee from AgentAccount.employeeId               │
│  4. Check Employee.status === 'active'                          │
│  5. Generate AgentSession (10 min, randomBytes 64)              │
│  6. Return { token, expiresAt, employee }                       │
└─────────────────────────────────────────────────────────────────┘
         │
         ▼
┌─────────────────────────────────────────────────────────────────┐
│  POST /api/agent/discover (WITH Authorization: Bearer <session>)│
├─────────────────────────────────────────────────────────────────┤
│  1. Validate AgentSession (exists, not expired)                 │
│  2. Derive employeeId + organizationId FROM session (server)    │
│  3. Create/update Device (via deviceKey)                        │
│  4. Create PENDING DeviceClaim (bound to employee + org)        │
│  5. Return { claimId, deviceId, status: "pending", secret }    │
└─────────────────────────────────────────────────────────────────┘
         │
         ▼
  Admin approves → authenticateDevice → 24h AgentToken (existing)
```

### AgentSession model (new, additive)

```prisma
model AgentSession {
  id              String   @id @default(cuid())
  token           String   @unique    // 64-char random (randomBytes)
  accountId       String              // FK -> AgentAccount
  employeeId      String              // denormalized for fast lookup
  organizationId  String              // denormalized for fast lookup
  ipAddress       String?             // login-time IP
  expiresAt       DateTime            // 10 minutes
  createdAt       DateTime @default(now())

  @@index([employeeId])
}
```

No FK constraints (AgentAccount can be deleted without cascade — sessions expire quickly). Created alongside AgentAccount — we don't cascade delete because sessions are ephemeral (10 min TTL).

---

## 4. Login API contract

### Request

```
POST /api/agent/login
Content-Type: application/json

{ "agentId": "EMP-001", "password": "Admin!SetPass123" }
```

### Response (200)

```json
{
  "token": "64-char-random-base64",
  "expiresAt": "2026-08-10T12:10:00.000Z",
  "employee": {
    "id": "clx...",
    "name": "Rimon Test"
  }
}
```

### Failure (401, uniform)

```json
{ "error": "Invalid credentials" }
```

### Error cases

| Condition | Status | Notes |
|---|---|---|
| Unknown agentId | 401 | Uniform error, no enumeration |
| Wrong password | 401 | Uniform |
| Disabled account | 401 | Uniform |
| Locked account | 401 | Uniform (client can't distinguish) |
| Inactive employee | 401 | Uniform |
| Inactive organization | 401 | Uniform |
| Rate limit (20/min/IP) | 429 | Separate from credential errors |

---

## 5. Token design

| Property | AgentSession (new) | AgentToken (existing) |
|---|---|---|
| **Purpose** | Authenticate device discover | Authenticate device API calls (heartbeat, activity, screenshot) |
| **Lifetime** | 10 minutes | 24 hours |
| **Device binding** | ❌ No device yet | ✅ Device-bound (deviceId FK) |
| **Storage** | `AgentSession` table | `AgentToken` table |
| **Generation** | `randomBytes(64)`, base64url | `randomBytes(64)`, base64url |
| **Validation** | Check exists, not expired | `validateAgentToken()` — checks token, employee, device status |
| **Issued by** | `POST /api/agent/login` | `POST /api/agent/authenticate` (PATH A/B) |
| **Revoked by** | `POST /api/agent/logout` (delete row) | Device deactivation (automatically by approve/authenticate of another device) |

---

## 6. Discover integration

The existing `POST /api/agent/discover` accepts:
- `Authorization: Bearer <agent_session>` (authenticated path — agentId derived from session)
- OR no auth header (anonymous zero-touch path — deviceKey only, existing behavior)

**Server-side decision tree:**

```
if Authorization header present:
    1. Validate AgentSession (exists, not expired)
    2. Derive employeeId + organizationId from session
    3. Find/reuse Device by deviceKey
    4. Create PENDING DeviceClaim (bound to employee + org)
    5. Return pending claim (same shape as zero-touch)
else:
    1. Zero-touch anonymous discovery (existing flow)
    2. org = first org (single-tenant fallback)
```

**Zero-touch must remain functional** — rule from Phase 0: "DO NOT delete existing working zero-touch functionality without replacing it."

---

## 7. Logout

### Server-side: `POST /api/agent/logout`

- Requires the AgentSession token as Bearer
- Deletes the session row
- If an AgentToken exists for this employee on this device (from a previous approve), it may optionally be deleted too (but the one-active-device rule handles this — approve of another device deactivates)
- Returns `{ "success": true }`

### Desktop agent changes

- Current `AuthService.logout()` clears `KEY_TOKEN`, `KEY_CRED`, `KEY_CLAIM` locally
- **Must add**: call `POST /api/agent/logout` with the session token before clearing
- If no session token (already expired), just clear locally
- After logout: renderer returns to login view

---

## 8. Desktop agent changes required

| Component | Change |
|---|---|
| `auth-service.ts` | Add `agentApi.login()` call → store session token; update `logout()` to call server |
| `api/device.ts` | Add `login(agentId, password)` method → `POST /api/agent/login` |
| `agent-orchestrator.ts` | Add `login()` orchestrator method; `onLogin()` transition |
| `ipc.ts` | Add `agent:login` handler |
| `preload/preload.ts` | Expose `login()` method on bridge |
| `renderer/index.html` | Add login view (agentId + password + Login button); add logout button to status view |
| `renderer/renderer.ts` | Bind login form, handle auth failure states, show logout button |
| `main.ts` | Add `rendererStateName` cases for login states |

**Critical: the login view must be the ONLY employee input** — no sign-up, no register, no organization/employee selection, no server URL.

---

## 9. Auth phase mapping (new phases for renderer)

| Phase | Description |
|---|---|
| `unregistered` | No credentials — show login form |
| `authenticating` | Login in progress (spinner) |
| `authenticated` | Logged in, starting discovery |
| `discovering` | Device discovery in progress |
| `pending_approval` | Device registered, awaiting admin |
| `authenticated_device` | Device approved, connected (existing `authenticated`) |
| `rejected` / `revoked` | Terminal states (existing) |
| `session_expired` | Session token expired, need re-login |
| `error` | Network/credential error (existing) |
| `cancelled` | Claim cancelled, about to re-request |

---

## 10. Security analysis

| Risk | Mitigation |
|---|---|
| **Account enumeration** | Uniform 401 for all failure modes (unknown agentId, wrong password, disabled, locked, inactive employee) — NO 404 |
| **Brute force** | Phase 1 lockout (5 fails → 15 min lock) + rate limit (20/min/IP) |
| **Client-controlled org/employee** | `verifyAgentCredential` resolves employee from AgentAccount — client never supplies org or employeeId |
| **Admin JWT accepted as agent token** | Separate token types (`AgentSession` vs admin JWT) — `validateAgentSession` only accepts Session tokens |
| **Agent session used as admin JWT** | Sessions are in `AgentSession` table, not JWT — no HMAC signature to forge |
| **Expired session reuse** | Server checks `expiresAt` at every request (10 min TTL) |
| **Session token theft** | Random 64 chars via `randomBytes` — no `Math.random` anywhere in auth |
| **Replay** | Bearer token only travels over HTTPS; rate limited per IP |
| **Password exposure** | bcrypt hashed before storage; never in logs, never in responses, never in audit |
| **Cross-tenant session** | OrganizationId derived from `AgentAccount → Employee.organizationId` — never from client |

---

## 11. Files requiring modification (for Steps 2+)

### Backend

| File | Action |
|---|---|
| `prisma/schema.prisma` | **MODIFY** — add `AgentSession` model |
| `prisma/migrations/*/migration.sql` | **CREATE** — additive migration |
| `src/app/api/agent/login/route.ts` | **CREATE** — POST /api/agent/login |
| `src/app/api/agent/logout/route.ts` | **CREATE** — POST /api/agent/logout |
| `src/lib/agent/session.ts` | **CREATE** — AgentSession service (create, validate, revoke) |
| `src/app/api/agent/discover/route.ts` | **MODIFY** — accept Bearer session token; derive employee/org server-side |
| `src/app/api/agent/heartbeat/route.ts` | **VERIFY** — no change needed (uses validateAgentToken) |
| `src/lib/rate-limit.ts` | **MODIFY** — add `agentLogin` limit |
| `src/proxy.ts` | **VERIFY** — `/api/agent/login` must be whitelisted like other agent routes |

### Desktop agent

| File | Action |
|---|---|
| `desktop-agent/src/api/device.ts` | **MODIFY** — add `login()` method |
| `desktop-agent/src/auth/auth-service.ts` | **MODIFY** — add login flow, session token storage, logout with server call |
| `desktop-agent/src/services/agent-orchestrator.ts` | **MODIFY** — add `login()`, `onLogin()`, state transitions |
| `desktop-agent/src/main/ipc.ts` | **MODIFY** — add `agent:login` handler, update logout |
| `desktop-agent/src/preload/preload.ts` | **MODIFY** — add `login()` to bridge |
| `desktop-agent/src/renderer/index.html` | **MODIFY** — add login view + logout button |
| `desktop-agent/src/renderer/renderer.ts` | **MODIFY** — bind login form, show status/logout |
| `desktop-agent/src/config/server-url.ts` | **VERIFY** — no change needed |

### Tests

| File | Action |
|---|---|
| `tests/agent-auth-login.test.ts` | **CREATE** — 25 AUTH-* tests |
| `desktop-agent/tests/auth-service.test.ts` | **MODIFY** — add login/logout tests |

---

## 12. Test plan (25 tests)

| # | Test | Expected |
|---|---|---|
| AUTH-1 | Valid credentials → 200 + token | |
| AUTH-2 | Wrong password → 401 | |
| AUTH-3 | Unknown Agent ID → 401 (same as AUTH-2) | |
| AUTH-4 | Disabled account → 401 | |
| AUTH-5 | Locked account → 401 | |
| AUTH-6 | 5 failed attempts → lockout | |
| AUTH-7 | Successful login resets counter | |
| AUTH-8 | Expired session → rejected | |
| AUTH-9 | Invalid session token → rejected | |
| AUTH-10 | Admin JWT not accepted as agent session | |
| AUTH-11 | Agent session not accepted as admin JWT | |
| AUTH-12 | Cross-org manipulation → rejected (session derives org server-side) | |
| AUTH-13 | Client-supplied organizationId ignored | |
| AUTH-14 | Client-supplied employeeId ignored | |
| AUTH-15 | Token contains server-derived org identity | |
| AUTH-16 | Disabled employee → login fails | |
| AUTH-17 | Uniform error shape for all failures | |
| AUTH-18 | passwordHash never in response | |
| AUTH-19 | Password never in logs | |
| AUTH-20 | Login → discover creates PENDING claim bound to correct employee+org | |
| AUTH-21 | Cross-org session cannot claim devices for another org | |
| AUTH-22 | Cancel → rediscover works after login | |
| AUTH-23 | Approved device lifecycle intact | |
| AUTH-24 | Logout deletes session server-side | |
| AUTH-25 | Login again after logout works | |

---

*STEP 1 complete — STOP per the master prompt. Awaiting approval for STEP 2 (login API implementation).*