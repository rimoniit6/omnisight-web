# WorkLensAI Desktop Agent — Employee Login Reachability Fix

## Certification Report

Date: 2026-08-13

---

## 1. Root Cause (proven in DESKTOP-AGENT-EMPLOYEE-LOGIN-DIAGNOSTIC.md)

The Desktop Agent automatically started anonymous zero-touch (PATH A) discovery whenever it was unregistered. With no organization enrollment code configured, the server's fail-closed 422 ("organization enrollment code OR employee sign-in required") was classified as a generic validation error, the agent **kept re-attempting anonymous discover forever**, and the renderer mapped the resulting error state to the **offline view — which had no "Sign in with Agent ID" control**. An Admin-created AgentAccount (Phase 3) existed and the `/api/agent/login` endpoint worked, but the Employee Login UI was unreachable.

```text
BEFORE:  UNREGISTERED → discover → 422 → discover → 422 → … (infinite, login never offered)
AFTER:   UNREGISTERED → discover → 422 (sign-in required) → STOP discover retry
         → Employee Login UI → POST /api/agent/login → 200 → discoverWithSession
         → pending → admin approve → device credential → authenticated → heartbeat
```

## 2. Fix

### 2.1 `desktop-agent/src/auth/auth-service.ts`

- New `AuthErrorKind 'login_required'` — a distinct, renderer-visible classification.
- New `isEnrollmentCodeOrSignInRequired(err)` — body-scoped detector: HTTP **422** whose body mentions the server's *"enrollment code"* + *"employee sign-in"* semantics. Any other 422 (or any other body) is **not** treated as sign-in-required.
- `discoverDevice()` catch: on that exact condition, transitions to `phase 'unregistered'`, `errorKind 'login_required'`, clears token/device state, and returns — **no generic error, no auto-retry**. P2-3's 422 fail-closed server behavior is untouched.

### 2.2 `desktop-agent/src/services/agent-orchestrator.ts`

- `runFirstRunDiscovery()`: `login_required` → stay `unregistered`, **do not start the discovery-retry backoff**.
- `startDiscoveryRetry()`: the retry loop's guard now stops immediately when `errorKind === 'login_required'` — a server-confirmed "employee sign-in required" is terminal for the current anonymous attempt. Discovery is still used normally everywhere else (pending/approved/rejected/revoked/conflict flows unchanged).
- Scheduler gating while unregistered (heartbeat/activity/screenshot/anomaly) is unchanged and verified.

### 2.3 `desktop-agent/src/renderer/renderer.ts` + `index.html`

- `onboardingView()`: `errorKind 'login_required'` → **login view** ("Sign in to WorkLensAI"). The login view reuses the existing Phase 3 form (Agent ID + password → `bridge.login` → `POST /api/agent/login`).
- The **offline view** (shown for the confirmed-orphaned 404 case) now carries a **"Sign in with Agent ID"** button bound to the same `bindShowLogin()` handler, so the orphaned state also has a reachable login path.
- Heading logic: `login_required`/`validation` → "Sign in to WorkLensAI"; `orphaned` → "Device registration required"; `credentials` → "Agent authentication failed"; `server` → "Server error"; only genuine transport failure (status 0) shows "Unable to reach the WorkLensAI server".
- Login errors are only surfaced as red errors after a real submit (credentials/network/server); the onboarding guidance is not rendered as an error before the first attempt.
- No secrets are ever rendered; the login path is exactly the existing `login()` → `discoverWithSession()` → pending → approve → device-auth pipeline.

## 3. Security Verification

| Property | Status |
|---|---|
| P2-3 preserved (anonymous discover without code → 422, zero writes) | **YES** |
| First-org fallback restored | **NOT RESTORED** |
| Client `organizationId` trusted | **NO** (server derives org from AgentAccount session / enrollment code) |
| Auto-registration / enrollment bypass | **NO** |
| `validateAgentToken` weakened | **NO** |
| 422 fail-closed server behavior modified | **NO** (server untouched) |
| `/api/agent/login` replaced or bypassed | **NO** (reused exactly) |
| Rate limiting disabled | **NO** (uniform 401 + 429 per-IP verified live) |
| Orphan recovery (404 → clear → unregistered) | **PRESERVED** |
| Credential/secret exposure | **NO** (password only set/restored in DB via the supported reset primitive; never logged; hash restored byte-identical) |

## 4. Tests

### New/extended: `desktop-agent/tests/orphan-recovery.test.ts` (22 tests, all PASS)

- **OR-10 (updated):** anonymous discover 422 sign-in-required → `unregistered` + `errorKind 'login_required'`, no auto-registration, never a client `organizationId`.
- **OR-30:** the same at service level — exactly one anonymous discover, onboarding guidance surfaced.
- **OR-31:** orchestrator boot with `login_required` → **no discovery-retry scheduler**, **no heartbeat/queue/screenshot drain** while unregistered.
- **OR-32:** valid Phase 3 login → `discoverWithSession` pending → server-derived employee, no client org/employee input.
- **OR-33:** invalid credentials → 401 → `credentials` error, login still available, **no auto-retry** (one deliberate attempt).
- **OR-34:** 429 rate limit respected — no immediate retry, message surfaced.
- **OR-35:** full regression — orphan 404 → clear → UNREGISTERED → Employee Login → pending → approve → authenticated; device token ≠ login session.
- **OR-36:** a 422 with any **other** body stays a plain `validation` error (never misread as sign-in-required); P2-3 intact.

### Gate results

| Gate | Result |
|---|---|
| Desktop Agent tests | **282/282 PASS** (275 baseline + 7 new/changed) |
| Server tests | **524/524 PASS** (no server changes) |
| Browser Extension tests | **7/7 PASS** |
| Agent TypeScript (main + renderer) | **0 errors** |
| Server TypeScript | **0 errors** |
| ESLint (changed files) | **0 errors** (1 pre-existing unused-import warning, untouched) |
| Agent build (`npm run build`) | **PASS** (new UI strings confirmed in `dist/renderer`) |

## 5. Live Verification (real server, real endpoints, real seeded AgentAccount)

Temporary probe (`scripts/_el_live.mts`, deleted) against the running dev server using the **real seeded AgentAccount `001`** (password temporarily set via the supported reset primitive, then **restored byte-identical**):

| Step | Result |
|---|---|
| Anonymous zero-touch discover (no enrollment code) → **422** with sign-in wording | PASS |
| `POST /api/agent/login` (agentId `001`) → **200**, token + expiresAt, server-derived employee | PASS |
| Wrong password → uniform **401** | PASS |
| `POST /api/agent/discover` WITH AgentSession bearer → **201 pending** + one-time secret | PASS |
| DB device `organizationId` === employee's org (server-derived; no client org sent) | PASS |
| DB device bound to employee `001` | PASS |
| Admin approval effect (claim approved, device online, `agentApproved`) | PASS |
| Device-bound `POST /api/agent/authenticate` → **200** + device token | PASS |
| `POST /api/agent/heartbeat` with device token → **200** | PASS |
| **Cleanup:** passwordHash restored (`$2b$12$eq5lX…`), `agentApproved` restored (false), devices 0 / claims 0 / tokens 0 | PASS |

**22/22 PASS, zero DB residue** (verified: 0 devices, 0 claims, 0 tokens after cleanup; AgentAccount hash and employee `agentApproved` byte-identical to the pre-probe snapshot).

Server request sequence captured in the live log: `discover 422 → login 200 → login 401 (wrong pw) → discover 201 → authenticate 200 → heartbeat 200` — exactly the fixed flow, with **no repeated anonymous discover**.

## 6. Request-Loop Verification

- After the 422 sign-in-required response the orchestrator does **not** start `discovery-retry` (unit OR-31 + live log shows the single 422, then the employee login path).
- While `unregistered`/`login_required`: heartbeat, activity, screenshot, and anomaly schedulers are all stopped (OR-31 asserts no scheduler registered; runtime gating unchanged from the orphan-recovery fix).
- Login is user-driven only: one submit → success or explicit error; 401 shows "Invalid credentials"; 429 respects the server rate limit. No client retry loop.

## 7. Files Changed

| File | Change |
|---|---|
| `desktop-agent/src/auth/auth-service.ts` | `login_required` kind, `isEnrollmentCodeOrSignInRequired`, discoverDevice 422 handling |
| `desktop-agent/src/services/agent-orchestrator.ts` | stop discovery retry on `login_required` (boot + retry-loop guard) |
| `desktop-agent/src/renderer/renderer.ts` | login view for `login_required`, offline-view sign-in binding, heading split, login-error scoping |
| `desktop-agent/src/renderer/index.html` | "Sign in with Agent ID" button on the offline view |
| `desktop-agent/tests/orphan-recovery.test.ts` | updated OR-10, new OR-30…OR-36, extended FakeDeviceApi (login/discoverWithSession) |

Server-side files: **none changed**. Schema: **no changes** (no migration).

## 8. Final Output

```text
DESKTOP AGENT EMPLOYEE LOGIN FIX

Source modified:
YES (agent-side only: auth-service, orchestrator, renderer, index.html, tests)

Primary issue fixed:
YES — the server-confirmed "enrollment code OR employee sign-in required" 422
now terminates anonymous discovery retry and surfaces the Employee Login UI,
which drives the existing POST /api/agent/login.

422 discover retry stopped:
YES

Employee Login reachable:
YES (login view for 'login_required'; offline/orphaned view gains the
"Sign in with Agent ID" button)

/api/agent/login:
PASS

Valid credentials:
PASS (live: 200, server-derived employee, session issued)

Invalid credentials:
PASS (live: uniform 401)

Rate limiting:
PASS (429 per-IP enforced server-side; client makes no automatic retry)

Device creation/binding:
PASS (live: device created, bound to employee 001, org = employee's org)

Correct organization:
PASS (server-derived from AgentSession — no client org ever sent)

Heartbeat:
PASS (live: 200 with the device-bound token)

Activity:
PASS (same pipeline as heartbeat; pipeline verified in prior hardening probes;
collectors gated until authenticated)

P2-3 preserved:
YES

First-org fallback:
NOT RESTORED

Security regression:
NONE

Agent tests:
282/282

Server tests:
524/524

Extension tests:
7/7

Live verification:
22/22

Build:
PASS

Final verdict:
PASS
```

## 9. Cleanup

- Temporary probe scripts (`_el_live.mts`, `_el_ctx.mts`, `_el_verify.mts`, `_el_token.mts`, `_el_clean2.mts`) created and **deleted**.
- Live DB restored to its exact pre-probe state: AgentAccount `001` password hash byte-identical, employee `agentApproved` restored, **0 devices / 0 claims / 0 tokens**.
- No probe files on disk. Nothing committed. Server healthy on :3000.
