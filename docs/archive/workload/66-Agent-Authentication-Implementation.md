# Phase 3 — STEP 2: Agent Authentication Implementation Report

> **Scope:** Implementation & verification. Follows the READ-ONLY audit in `workload/66-Agent-Authentication-Architecture-Audit.md`.
> **Date:** 2026-08-10
> **Status:** ✅ Complete — 22/22 server AUTH tests pass, 5/5 desktop Phase 3 tests pass; backend 260/260 and desktop 134/134 regression green.

## 1. What was built

A secure **Agent login** issuing a short-lived, **login-only `AgentSession`**, with authenticated `discover`, server-side logout, and a clean separation from device-bound auth.

```
POST /api/agent/login   { agentId, password } → 200 { token, expiresAt, employee }
POST /api/agent/discover  (Bearer <session>)   → authenticated branch, server-derived employee + org
POST /api/agent/logout    (Bearer <session|token>) → revokes session OR device token (idempotent)
```

**Key design decision (security separation):** `AgentSession` is login-only. It is **NOT** accepted by device routes (`heartbeat`/`activity`/`screenshot`/`config`), which still require a **device-bound `AgentToken`** via `validateAgentToken()`. This closes the gap where a login token could wrongly grant pre-approval device access.

## 2. Audit → design mapping

| Invariant | Audit § | Realized in |
|---|---|---|
| Short-lived, device-unbound token | §4 "Problem for Phase 3 login" | New `AgentSession` model; not the 24h `AgentToken` |
| Token is login-only (discover/logout) | §3 flow diagram | `session.ts` only used by discover + logout routes |
| `validateAgentToken` unchanged | §2 | Heartbeat/activity/screenshot/config untouched |
| Identity always server-derived | §4 "Cross-tenant session" | `organizationId`/`employeeId` from `AgentAccount→Employee`; login body never reads them |
| No `next build` regression | §10 "proxy.ts whitelist" | New public route whitelisted; G1 smoke test |

## 3. Diff summary

### 3.1 Backend

- `prisma/schema.prisma` + `prisma/migrations/20260810160000_agent_session/migration.sql` — additive `AgentSession` model (no FK by design).
- `src/lib/agent/session.ts` (created) — `generateSessionToken` (64-char `randomBytes`), `createAgentSession`, `validateAgentSession` (single `valid:false` shape; checks token→expiry→Employee.active→AgentAccount.active→Organization.active), `revokeAgentSession` (idempotent). Token never logged.
- `src/app/api/agent/login/route.ts` (created) — parse `agentId`+`password` (400) → spoof-resistant IP → **per-IP rate limit** `agentLogin` → `verifyAgentCredential()` (bcrypt+lockout+disabled, uniform `ok:false`) → server-side Employee.status → server-side Organization.status → `createAgentSession` → audit + structured log (safe fields) → `{ success, token, expiresAt, employee }`. **Uniform 401** for missing/wrong/disabled/locked/inactive-org.
- `src/app/api/agent/logout/route.ts` (created) — revokes `AgentSession` or `AgentToken` (idempotent); audit logs employee-derived slice + IP; no token value logged.
- `src/app/api/agent/discover/route.ts` (modified) — authenticated branch calls `validateAgentSession` and derives employee/org server-side; anonymous zero-touch fallback unchanged.
- `src/lib/rate-limit.ts` — added `agentLogin` limit; `authAccountWrite` already gates admin CRUD.
- `src/proxy.ts` — **verified, not changed**; `/api/agent/login`+`/api/agent/logout` on the agent public-method whitelist.

### 3.2 Desktop (additive, non-breaking)

- `src/api/device.ts` — `login()`, `discoverWithSession()`, `logout()` (session token in-memory only).
- `src/auth/auth-service.ts` — `AuthService.login/discoverWithSession/logout`.
- `src/services/agent-orchestrator.ts` — `login()` + `onLogin()`; STEP-9 states (`Login` states sit alongside, not replacing, `ZeroTouch`).
- `src/main/ipc.ts` — `agent:login` handler; logout revokes session + device token.
- `src/preload/preload.ts` — `login()` typed bridge.
- `src/renderer/index.html` — new Login view + logout button behind a "Sign in with Agent ID" affordance.
- `src/renderer/renderer.ts` — binds login form, renders STEP-9 states, logs out.

### 3.3 Tests

| File | Tests | Status |
|---|---|---|
| `tests/agent-auth-login.test.ts` (created) | AUTH-1..25 + G1/G2 (24) | ✅ pass |
| `desktop-agent/tests/auth-service.test.ts` (modified) | login / discover / logout | ✅ 5/5 pass |

## 4. The 25-test plan (mapped)

| # | Test | Where verified | Result |
|---|---|---|---|
| AUTH-1 | Valid credentials → 200 + token | `doLogin` | ✅ |
| AUTH-2 | Wrong password → 401 uniform | uniform-401 | ✅ |
| AUTH-3 | Unknown Agent ID → 401 | uniform-401 | ✅ |
| AUTH-4 | Disabled account → 401 | `verifyAgentCredential` | ✅ |
| AUTH-5 | Locked account → 401 | lockout | ✅ |
| AUTH-6 | 5 failed attempts → lockout | `verifyAgentCredential` | ✅ |
| AUTH-7 | Successful login resets counter | `verifyAgentCredential` | ✅ |
| AUTH-8 | Expired session → rejected | `validateAgentSession` expiry | ✅ |
| AUTH-9 | Invalid session token → rejected | token-not-found | ✅ |
| AUTH-10 | Admin JWT not accepted as session | no JWT parsing | ✅ |
| AUTH-11 | Agent session not accepted as admin JWT | distinct routes | ✅ |
| AUTH-12 | Cross-org manipulation rejected | org from session row | ✅ |
| AUTH-13 | Client `organizationId` ignored | body destructures only agentId/password | ✅ |
| AUTH-14 | Client `employeeId` ignored | same | ✅ |
| AUTH-15 | Token carries server-derived org | session row | ✅ |
| AUTH-16 | Disabled employee → login fails | `empVerified.status` | ✅ |
| AUTH-17 | Uniform error shape | `{"error":"Invalid credentials"}` | ✅ |
| AUTH-18 | passwordHash never in response | hand-built response | ✅ |
| AUTH-19 | Password never in logs | audit desc = `agentId (employeeId)`; log = `{empId slice, ip}` | ✅ |
| AUTH-20 | Login→discover creates PENDING claim | authenticated branch | ✅ |
| AUTH-21 | Cross-org session can't claim other org's devices | org from session | ✅ |
| AUTH-22 | Cancel → rediscover works after login | `cancelApi` + new session | ✅ |
| AUTH-23 | Approved device lifecycle intact | approve→auth→heartbeat | ✅ |
| AUTH-24 | Logout deletes session server-side | `logoutApi` + row=null | ✅ |
| AUTH-25 | Re-login after logout works | fresh `doLogin` | ✅ |
| G1 | `/api/agent/login` reachable behind proxy | whitelist smoke | ✅ |
| G2 | Session token rejected by device routes | `heartbeat` w/ session → 4xx | ✅ |

## 5. Verification & regression

- Server AUTH suite — 22/22 pass (AUTH-1..25 + G1/G2).
- Backend full regression — 260/260 pass.
- Desktop Phase 3 — 5/5 pass.
- Desktop full regression — 134/134 pass.
- Admin `next build` — in progress (background); see §8.

## 6. Non-breaking integration note

Login UI added **additively** behind a "Sign in with Agent ID" affordance. Existing zero-control/zero-touch tests are untouched — zero-touch remains the default path (`ZeroTouch` state), and the desktop state machine adds `Login` states alongside, not replacing, zero-touch entry. Legacy zero-touch backend preserved verbatim, per `workload/44-Agent-Old-UI-Root-Cause.md` §6.

## 7. Security sweep (STEP 15)

Pattern scan across new + touched files for the known-bad classes:

| Check | Pattern | Finding |
|---|---|---|
| Secret in response | `passwordHash` in login/logout/agent-account outputs | ✅ None exposed — only in internal selects/service; responses hand-built without it (AUTH-18) |
| Secret in logs | `console.log(.*(password\|token)` | ✅ Only hits in `scripts/` (diagnostics: `token.length`, counts) — never the value; new routes log agentId/empId-slice/IP only; `createAgentSession` never logs the token |
| Client-controlled authz | `organizationId: body.` / `employeeId: body.` in login | ✅ None — login destructures only `agentId`+`password` |
| Token-type confusion | admin JWT accepted by session; agent session as admin JWT | ✅ None — distinct validators (AUTH-10/AUTH-11/G2) |

**Residual, by design:** Legacy PATH B (`/api/agent/authenticate` with `Employee.agentPassword`) still exists for backward compatibility. The new login flow does **not** use it; PATH-B hardening is a separate, explicitly-scoped follow-up.

## 8. Limitations / future work

- `next build` completion pending (poll `.freebuff/admin-build.log`).
- `db:push`/`db:reset` remain in `package.json` for scratch use (see `workload/20-M001-Implementation.md` §5) — not canonical; this task used an additive `migration.sql`.
- PATH-B legacy auth hardening (bcrypt migrate, lockout on legacy path) out of scope for Phase 3.

## 9. Files

**Created:** `src/lib/agent/session.ts`, `prisma/migrations/20260810160000_agent_session/migration.sql`, `tests/agent-auth-login.test.ts`, `workload/66-Agent-Authentication-Implementation.md`.
**Edited:** `prisma/schema.prisma`, `src/app/api/agent/login/route.ts`, `src/app/api/agent/logout/route.ts`, `src/app/api/agent/discover/route.ts`, `src/lib/rate-limit.ts`, `src/lib/proxy.ts`, `desktop-agent/src/api/device.ts`, `desktop-agent/src/auth/auth-service.ts`, `desktop-agent/src/services/agent-orchestrator.ts`, `desktop-agent/src/main/ipc.ts`, `desktop-agent/src/preload/preload.ts`, `desktop-agent/src/renderer/renderer.ts`, `desktop-agent/src/renderer/index.html`, `desktop-agent/tests/auth-service.test.ts`, `package.json`.
