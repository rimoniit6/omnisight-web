# WorkLensAI Desktop Agent — Employee Credential Login Flow Diagnostic

**Diagnostic-only investigation. No source modified. No database modified. Nothing committed.**

Date: 2026-08-13

---

## 1. Executive Summary

**Primary root cause:** After the orphaned-device recovery clears the stale claim/token/session, the agent transitions to `UNREGISTERED` and **immediately auto-runs the zero-touch (PATH A) discovery flow** — it never offers the Phase 3 Employee Login screen. Because this deployment has **no organization enrollment code configured**, every anonymous discover returns **422 "Device registration requires an organization enrollment code … or an employee sign-in"**, the agent enters the bounded discovery-retry loop, and the renderer shows the **offline view** ("Device registration required" / "Unable to reach the WorkLensAI server"). The Admin-created AgentAccount credentials (`agentId: 001`, employee `001`) exist and are valid, but the Employee Login screen is **never surfaced** in this state.

**Secondary cause (UI):** The renderer maps the `orphaned` / `validation` error kinds to the **offline view**, which is the one onboarding view that does **not** contain the "Sign in with Agent ID" button (that button exists only on the `onboard-view`). So even though the app *has* a Phase 3 login screen, there is **no reachable control** to get to it from the orphaned/error state — the employee is stuck.

---

## 2. Evidence Summary

| Fact | Evidence |
|---|---|
| Admin-created Phase 3 credentials exist | DB: 1 org (`Bangladesh computer Council`), 1 employee (`001` Rimon Rana, active), **AgentAccount `001` status=active** |
| No device ever registered | DB: `DEVICES 0, CLAIMS 0, TOKENS 0` |
| No enrollment code configured | DB: `ORG SETTINGS []` (no `enrollment_code` OrganizationSetting) |
| Agent is running | 3 × `WorkLensAIAgent.exe` processes |
| Orphan recovery already ran | `%APPDATA%\worklensai-agent\state\` has **no `sec-*.bin` blobs** (claim/token/session cleared); fresh `device-identity.json` (agentKey `4a40e763…`) |
| Agent is looping anonymous discover | Live server log: `POST /api/agent/discover 422` (repeated, current) |
| Prior orphan loop observed | Live server log: `POST /api/agent/authenticate 404` + `heartbeat/activity 401` (stale claim, now stopped) |
| Manual login attempts existed | Older server log: `POST /api/agent/login 401` ×N → `429` (uniform 401 + per-IP rate limit working; likely wrong credentials used) |
| Login endpoint works server-side | `src/app/api/agent/login/route.ts`: AgentAccount verify → AgentSession; uniform 401; org from account |
| Agent login flow exists | `auth-service.ts login()` + `discoverWithSession()`; `renderer.ts` login view; `preload.ts` `login` bridge |
| Server already anticipates employee sign-in | `discover/route.ts` 422 body: *"Device registration requires an organization enrollment code (issued by your administrator) **or an employee sign-in**."* |

---

## 3. Source-Level Flow Diagram

### Actual flow (what happens today)

```text
Admin creates Employee + AgentAccount (agentId 001 / password)   [DB: OK, verified]
        ↓
Employee opens Desktop Agent v1.1.0
        ↓
Electron boot (main.ts) → auth.load()
        ↓
No stored token/claim/session  →  phase = 'unregistered'
        ↓
orchestrator.initialize(): phase === 'unregistered'  →  runFirstRunDiscovery()
        ↓
auth.discoverDevice() — ANONYMOUS zero-touch (PATH A), no enrollment code
        ↓
POST /api/agent/discover  →  422 "requires an organization enrollment code … or an employee sign-in"
        ↓
classifyError(422) → phase='error', errorKind='validation'
        ↓
orchestrator: startDiscoveryRetry() — bounded backoff, keeps re-attempting discover
        ↓
renderer onboardingView():
   errorKind 'validation' (or 'orphaned') → view = 'offline'
        ↓
offline-view: heading "Registration required" / "Device registration required"
   body  "…Please enroll this device again."
   ⚠ NO "Sign in with Agent ID" button on offline-view
        ↓
EMPLOYEE LOGIN SCREEN NEVER SURFACED  →  dead end
```

### Expected flow (what should happen)

```text
Admin creates Employee + AgentAccount
        ↓
Employee opens Desktop Agent
        ↓
No valid device / unregistered
        ↓
Employee Login screen (Agent ID + password)  ←  MUST BE REACHABLE
        ↓
POST /api/agent/login  →  AgentSession (server derives employee + org)
        ↓
discoverWithSession (authenticated discover)  →  Device bound to employee's org
        ↓
Pending claim → admin approval → device credential
        ↓
Authenticated → heartbeat/activity/collectors
        ↓
Normal operation
```

### Divergence point

```text
START → UNREGISTERED
        ├── (current)  → auto zero-touch discover → 422 → offline view, no login button → STUCK
        └── (expected) → surface Employee Login when anonymous enrollment is not available
```

---

## 4. Exact Error Flow (runtime-verified)

```text
[agent boot 16:08:46Z]  auth.load() → unregistered (no blobs in state/)
        ↓
[16:08:46Z+]  POST /api/agent/discover → 422   (live log, repeated: 422, 422, 422…)
        ↓
auth phase 'error' / errorKind 'validation' → orchestrator unregistered + discovery-retry backoff
        ↓
renderer: 'offline' view → "Registration required" + "Unable to reach the WorkLensAI server" heading
```

(The heading "Unable to reach the WorkLensAI server" is the `ONBOARDING_LABELS.offline` default overridden by `errorKind` — the body text *"This device is no longer registered with the WorkLensAI server. Please enroll this device again."* comes from the orphan recovery path. Both are accurate about *the device being gone* but the heading implies a network problem, which is a **UI wording/classification issue** — the server is reachable and answering 422.)

---

## 5. Source Locations

| Component | File | Function | Finding |
|---|---|---|---|
| UI renderer | `src/renderer/renderer.ts` | `onboardingView()` | `errorKind === 'orphaned'` and `'validation'` route to `'offline'` view; login only when `loginRequested` (button clicked) |
| UI renderer | `src/renderer/renderer.ts` | `bindShowLogin()` | "Sign in with Agent ID" button exists **only on `onboard-view`** (`index.html`) |
| UI HTML | `src/renderer/index.html` | `offline-view` | **No login button / no login link** in the offline/orphaned/validation views |
| Auth service | `src/auth/auth-service.ts` | `handleOrphanedDevice()` | Clears token/claim/session, sets `phase:'unregistered'`, `errorKind:'orphaned'` |
| Auth service | `src/auth/auth-service.ts` | `discoverDevice()` / `classifyError()` | 422 → `errorKind:'validation'`, `phase:'error'` |
| Orchestrator | `src/services/agent-orchestrator.ts` | `initialize()` / `runFirstRunDiscovery()` | `unregistered` → **auto anonymous zero-touch discover**; 422 → `startDiscoveryRetry()` |
| Orchestrator | `src/services/agent-orchestrator.ts` | `startDiscoveryRetry()` | Bounded backoff re-discover loop (30s→10min) — keeps the 422 loop alive |
| API (server) | `src/app/api/agent/login/route.ts` | `POST` | Phase 3 login: AgentAccount verify → AgentSession; uniform 401; works |
| API (server) | `src/app/api/agent/discover/route.ts` | `POST` | 422 when anonymous + no valid enrollment code; message explicitly offers "employee sign-in" alternative |
| Device API | `src/api/device.ts` | `discover`, `discoverWithSession`, `login` | Both paths implemented |
| Preload/IPC | `src/preload/preload.ts`, `src/main/ipc.ts` | `login` | Phase 3 login bridge exists and works |

---

## 6. Identity Comparison

```text
Local device:    agentKey 4a40e763… (fresh, created 16:08:46Z), NO stored claim/token/session
DB device:       none (DEVICES = 0)
Token device:    n/a
Employee:        EMP-001 (Rimon Rana, active) — has ACTIVE AgentAccount (agentId: 001)
Organization:    Bangladesh computer Council (active)
Enrollment code: none configured (ORG SETTINGS = [])
```

---

## 7. Authentication Modes (documented from source)

| Path | Start | UI trigger | Credentials | API | Org resolution | Status |
|---|---|---|---|---|---|---|
| PATH A zero-touch (default) | anonymous discover | auto (silent) | enrollment code (env/MDM) or device claim secret | `/api/agent/discover`, `/api/agent/authenticate` | enrollment code → org (server-side); no code → 422 | **BLOCKED here (no code)** |
| PATH B legacy | employeeId + agentPassword | old UI flow | employee `agentPassword` | `/api/agent/register`, `/api/agent/authenticate` | employee's org | kept for back-compat |
| **Phase 3 AgentAccount** | Agent ID + password | **"Sign in with Agent ID" button (onboard-view only)** | Admin-created AgentAccount | `/api/agent/login` → session → `discoverWithSession` | AgentAccount → Employee → org (server-side) | **Implemented + tested, but UI-unreachable from orphaned/error state** |

---

## 8. Admin-Created Credential Type

**Proven:** the Admin panel creates a dedicated `AgentAccount` row (`src/app/api/employees/[id]/agent-account/route.ts` → `createAgentAccount`, bcrypt-hashed password, `agentId` + reset-password route). The DB shows employee `001` has an **active AgentAccount `001`**. This corresponds to the **Phase 3 login flow** (`POST /api/agent/login`), not PATH A/PATH B. The server-side login endpoint works (uniform 401 on bad credentials; 429 rate limit observed live).

**Conclusion:** The Admin-generated credentials expect the agent to show the **Employee Login screen** — and the agent never does, because the orphaned/error state routes to the offline view which has no login control.

---

## 9. Root Cause Answers

| Question | Answer |
|---|---|
| Why Employee Login is not shown | After orphan recovery → `UNREGISTERED`, the orchestrator auto-runs anonymous zero-touch discover; with no enrollment code it 422s forever, and the renderer maps `orphaned`/`validation` to the offline view which has **no login button**. The login view is only reachable via "Sign in with Agent ID" on the `onboard-view` (first-run discovery view), which is never shown in the orphaned/error state. |
| Did orphan recovery cause/regress this? | **YES (contributing)** — `handleOrphanedDevice()` correctly clears stale state, but the orchestrator's post-recovery path (`runFirstRunDiscovery`) immediately re-runs anonymous discover instead of surfacing the employee-login alternative. The recovery itself is correct; the **post-recovery UI/flow choice** is the regression surface. |
| Is P2-3 affected? | **NO** — P2-3 (no first-org fallback, enrollment code required) is preserved and correct. The 422 is the *intended* fail-closed behavior. The gap is that the *alternative employee-sign-in path* the server explicitly offers is never surfaced by the agent UI. |
| Server-side changes required? | **NO** — the server is behaving correctly (422 without a code; login endpoint works; rate limits work). Fix is agent-side. |
| Current authentication mode | PATH A zero-touch (auto), failing 422 (no enrollment code) |
| Expected authentication mode | Phase 3 AgentAccount login (Admin created AgentAccount `001`) |
| Login endpoint | `POST /api/agent/login` (agentId + password) |
| Current Agent state | `unregistered` (auth phase `error`, errorKind `validation`, discovery-retry backoff) |
| Exact state transition causing the problem | `unregistered` → `runFirstRunDiscovery()` → anonymous discover → **422** → `errorKind 'validation'` → renderer `'offline'` view (no login control) → discovery-retry loop |
| Whether orphan recovery caused/regressed this | Contributing (post-recovery flow), not the security recovery itself |
| Whether P2-3 is affected | No — P2-3 preserved |
| Whether server-side changes are required | No |
| UI error classification correct? | No — heading "Unable to reach the WorkLensAI server" is wrong for a server-answered 422/404 (server IS reachable). The offline view also lacks the login control. |

---

## 10. Classification

```text
Primary root cause:    F. Enrollment/registration incomplete
                       (agent auto-runs anonymous zero-touch without an enrollment
                       code and never offers the Phase 3 Employee Login screen)
Secondary cause:       J. UI error classification bug
                       (orphaned/validation → offline view which has no
                       "Sign in with Agent ID" button; misleading heading)
Other contributors:    G. P2-3 hardening compatibility regression (partial —
                       the 422 fail-closed is correct, but the agent's
                       post-recovery flow should surface the login alternative)
```

---

## 11. Recommended Fix (NOT implemented — per instructions)

### Fix A (primary): surface Employee Login when anonymous enrollment is unavailable

- **Agent-side renderer/flow:** when the auth phase is `unregistered`/`error` with `errorKind` `orphaned` **or** `validation` (server explicitly says an enrollment code or employee sign-in is required), render the **login view** (or add the "Sign in with Agent ID" button to the offline view). The employee must be able to reach the Phase 3 login screen from the orphaned/registration-required state.
- **Orchestrator:** when discover returns 422 (no enrollment code), do **not** loop anonymous discovery indefinitely; instead stop the retry and present the employee login option (or keep a slow retry but make the login control visible).

### Fix B (secondary): correct the UI wording

- The heading should distinguish "server answered 4xx/5xx" from "network unreachable" (e.g. "Device registration required" instead of "Unable to reach the WorkLensAI server" for 422/404). The body text is already accurate.

### Security implications / constraints

- Must NOT restore first-org fallback.
- Must NOT trust client `organizationId` (server derives org from AgentAccount/enrollment code — keep).
- Must NOT weaken `validateAgentToken` or the 422 fail-closed discover.
- Must NOT auto-register a device without approval.
- Phase 3 login already binds the device to the employee's org via `discoverWithSession` (server-side), so surfacing login is security-neutral and consistent with P2-3.

### Backward compatibility

- Keep PATH A zero-touch as the default for MDM-provisioned deployments (enrollment code via `WL_ENROLLMENT_CODE`).
- Keep PATH B legacy.
- The fix only adds reachability for the existing Phase 3 login screen in the orphaned/validation states.

### Test requirements

- Renderer: orphaned/validation state shows the login control; clicking "Sign in with Agent ID" reaches the login view.
- Auth flow: orphan recovery → login (Phase 3) → `discoverWithSession` → pending → approved → authenticated (already covered at service level in `orphan-recovery.test.ts` OR-14/15; add UI-level assertion).
- Security: no first-org fallback; no client org; 422 still returned for anonymous discover without a code.

---

## 12. Final Output

```text
DESKTOP AGENT EMPLOYEE LOGIN DIAGNOSTIC

Source modified:
NO

Database modified:
NO

Primary root cause:
The agent auto-runs anonymous zero-touch (PATH A) discovery after orphan
recovery / on first run; with no enrollment code configured the server returns
422 and the agent loops — never surfacing the Phase 3 Employee Login screen for
the Admin-created AgentAccount.

Secondary cause:
Renderer maps 'orphaned'/'validation' error kinds to the offline view, which
has no "Sign in with Agent ID" button; heading implies network failure though
the server answered.

Server reachable:
YES

Failing endpoint:
POST /api/agent/discover (anonymous, no enrollment code) → 422
(Phase 3 POST /api/agent/login works; earlier attempts showed 401/429)

HTTP status:
422

Error code:
(enrollment code required / employee sign-in required)

Device exists in DB:
NO

Local device matches DB:
NO (no DB Device; local identity is a fresh agentKey)

Token matches device:
NO (no tokens; local blobs cleared by orphan recovery)

Employee matches:
YES (EMP-001 active, AgentAccount 001 active)

Organization matches:
YES (single active org; org setting empty — no enrollment code)

Enrollment valid:
NO (no enrollment code configured; anonymous discover correctly 422s)

P2-3 regression:
INCONCLUSIVE — P2-3 fail-closed is correct and preserved; the regression is the
agent's post-recovery flow not offering the employee-sign-in alternative.

UI error classification correct:
NO

Recommended fix:
Surface the Phase 3 Employee Login control in the orphaned/validation states
(login view or button on the offline view) and stop the infinite anonymous
discover-retry loop when the server says an enrollment code or employee
sign-in is required. Fix the heading wording for server-answered 4xx vs
network failure. Agent-side only; keep the server 422, keep P2-3.

Confidence:
HIGH
```

---

## 13. Cleanup

- Temporary diagnostic script `scripts/_eldiag.mts` created and **deleted**.
- No probe data created (DB untouched — verified `DEVICES 0, CLAIMS 0, TOKENS 0`).
- No source files modified. Nothing committed.
