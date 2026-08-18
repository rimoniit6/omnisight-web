# Workload 74 — Desktop Agent Single-Active-Device Audit

**Phase:** 6 (Audit only — no source code modified)
**Date:** 2026-08-11
**Backend contract under audit:** HTTP 409 `{ "error": "ACTIVE_DEVICE_EXISTS" }` — one employee, one valid active AgentToken; second device gets 409 with zero mutation; existing device never kicked; same-device re-login replaces its own token; no automatic retry after 409; no ping-pong.

---

## 1. Executive Summary

The desktop agent's **transport layer is 409-safe but its state machine is 409-blind**.

The API client correctly preserves HTTP status, body, and error code for 409 (never retried as a transport error, never flattened). However, **no code path in the agent recognizes `ACTIVE_DEVICE_EXISTS` as a distinct, terminal condition**. Both `AuthService.authenticate()` and `AuthService.authenticateDevice()` fall through to a generic `error` phase with `errorKind: 'server'`, which the renderer displays under the heading *"Unable to reach the WorkLensAI server"* — the exact opposite of the truth (the server IS reachable; another device holds the slot).

Worse, several automatic recovery loops **re-attempt authentication after the 409 without any terminal latch**:

1. **`startDiscoveryRetry` (CRITICAL)** — after a 409, the bounded discovery backoff loop continues `discover → approved → authenticateDevice → 409 → error → backoff ×2 → …` **forever** (30 s → 10 min cadence).
2. **Heartbeat 401 recovery (HIGH)** — a running device whose token died while another device took the slot beats heartbeats forever, each 401 triggering `recoverAuth() → recover() → authenticate → 409`. Endless cycle at the heartbeat cadence (≥10 s).
3. **`pollApproval` (MEDIUM)** — performs exactly one extra authenticate attempt after a 409 before its phase guard blocks (bounded, but an unauthorized retry).

**No ping-pong war is possible**: the backend 409 is zero-mutation, and the agent never locally deletes/rotates the winning device's token — the first device is never kicked. This requirement PASSES.

Logout, same-device re-login, server-URL lock-down, IPC/preload security, and employee self-registration restrictions are all solid. Test coverage for the 409 contract is **absent**.

**Overall verdict: FAIL for the ACTIVE_DEVICE_EXISTS contract.** 1 CRITICAL, 2 HIGH, 3 MEDIUM, 3 LOW.

---

## 2. Scope

Read-only audit of `desktop-agent/` (Electron main, preload, renderer, API client, auth service, orchestrator, scheduler, heartbeat, storage) against the Phase 4/5 backend single-active-device contract. No source, schema, test, or API changes made.

---

## 3. Files inspected

| File | Role |
|---|---|
| `desktop-agent/src/auth/auth-service.ts` | Auth state machine, enroll/discover/authenticate/recover/logout |
| `desktop-agent/src/auth/secure-store.ts` | Encrypted persistence (safeStorage/DPAPI) |
| `desktop-agent/src/api/client.ts` | HTTP client, retry policy, error mapping |
| `desktop-agent/src/api/device.ts` | discover / authenticate / login / logout / cancelClaim |
| `desktop-agent/src/api/heartbeat.ts` | heartbeat + anomaly/tamper/break |
| `desktop-agent/src/api/{activity,screenshots,consent,config}.ts` | Data APIs |
| `desktop-agent/src/services/agent-orchestrator.ts` | Lifecycle, approval poll, discovery retry, heartbeat wiring |
| `desktop-agent/src/services/heartbeat-service.ts` | Heartbeat loop + 401 recovery hook |
| `desktop-agent/src/services/{config,consent,update,queue-uploader}.ts` | Support services |
| `desktop-agent/src/scheduler/scheduler.ts` | Central timer registry |
| `desktop-agent/src/main/main.ts` | Composition root, boot watchdog, status push |
| `desktop-agent/src/main/ipc.ts` | IPC channel validation |
| `desktop-agent/src/preload/preload.ts` | contextBridge surface |
| `desktop-agent/src/renderer/renderer.ts` + `index.html` | Read-only status UI |
| `desktop-agent/src/config/server-url.ts` | Server URL resolution |
| `desktop-agent/src/storage/{local-settings,device-identity}.ts` | Settings + machine identity |
| `desktop-agent/src/lib/logger.ts` | Redacting logger |
| `desktop-agent/tests/*.test.ts` (16 files) | Test coverage audit |
| Backend cross-check: `src/app/api/agent/heartbeat/route.ts`, `logout/route.ts` | Failure statuses, credential revocation |

---

## 4. Architecture observed

```
main.ts (authority)
 ├─ resolveServerUrl()      — WORKLENSAI_SERVER_URL → DEFAULT_SERVER_URL (localhost:3000)
 ├─ ApiClient               — baseUrl fixed; retries 4xx never (429 excepted); onError NOT wired
 ├─ AuthService             — AuthPhase machine; tokenProvider feeds client bearer
 ├─ AgentOrchestrator       — initialize → poll/discover/retry schedulers → startRuntime
 ├─ HeartbeatService        — beat() → 401 → orchestrator.recoverAuth()
 ├─ Scheduler               — heartbeat / approval-poll / discovery-retry / config / consent / drains
 ├─ DeviceIdentityStore     — random 32-byte machine key (deviceKey), HMAC-bound
 └─ SafeStorageStore        — agent.token / agent.credentials / agent.claim / agent.session (encrypted)
preload.ts                  — 13 invoke channels + status/auth-required events (contextIsolation ON)
renderer.ts                 — passive status viewer; no inputs except Agent ID login + Cancel registration
```

Two authentication flows exist in the client:
- **PATH A (zero-touch, default):** `discover(deviceKey)` → pending claim → admin approves → `authenticate(deviceId+deviceSecret)` → AgentToken.
- **PATH B (legacy):** `register(employeeId+password)` → admin approves → `authenticate` → AgentToken.
- **PATH C (Phase 3 login):** `login(agentId+password)` → AgentSession → `discoverWithSession(session)` → same pending→approve→authenticate pipeline.

---

## 5. Authentication state machine

Defined in `AuthService.AuthPhase` (auth-service.ts:6–15) plus the orchestrator's `AgentPhase` (agent-orchestrator.ts:14–21). **There is no ACTIVE_DEVICE_EXISTS state.**

| State | Created by | Transitions in | Transitions out | Deterministic? |
|---|---|---|---|---|
| `unregistered` | initial, cancel, logout, load() empty | logout, cancel, initialize error fallback | → `discovering` (initialize/retry/discover) | yes |
| `discovering` | discoverDevice / discoverWithSession / login | any entry point | → pending_approval / authenticated / rejected / revoked / error | yes |
| `pending_approval` | discover pending, 403 pending | poll, restart, retry | → authenticated / rejected / revoked / error / unregistered(cancel) | yes |
| `authenticated` | authenticate success | recover, poll, boot | → expired (load) / unregistered (logout) | yes |
| `expired` | load() with stale token; recover() no creds | boot, heartbeat 401 fallback | → authenticated (recover) / error (recover→409) / pending_approval | yes |
| `rejected` | 403 rejected, discover rejected | poll, authenticate, boot | terminal (restart re-attempts via reRegister only) | yes |
| `revoked` | 403 revoked, discover revoked | poll, authenticate, boot | terminal | yes |
| `cancelled` | (local claim status only, maps to unregistered on load) | — | — | yes |
| `error` | classifyError (any non-403-pending/rejected/revoked) | **all catch paths** | → pending_approval (forced in poll catch), unregistered (orchestrator), **recovered repeatedly by heartbeat/discovery-retry (no latch)** | **no — see findings 1–3** |

Key observation: `error` is a catch-all. The 409, network failures, and server errors all collapse into it, and several schedulers re-drive recovery from `error` without checking *why* it failed.

---

## 6. ACTIVE_DEVICE_EXISTS flow (as implemented)

1. Device B calls `authenticateDevice()`/`authenticate()` (auth-service.ts:374/446).
2. Backend returns **HTTP 409** `{ error: 'ACTIVE_DEVICE_EXISTS' }`.
3. `ApiClient.tryOnce` (client.ts:172–178) throws `ApiClientError(409, 'CONFLICT', 'ACTIVE_DEVICE_EXISTS', body)` — **status and body fully preserved**.
4. Retry policy (client.ts:116–119): 409 is a 4xx → **never retried at transport level**. Good.
5. `DeviceApi.authenticateDevice`/`authenticate` pass `retries: 0` anyway (device.ts:44/87). Good.
6. `AuthService.authenticateDevice` (auth-service.ts:393–411): `status === 403` handled (pending/rejected/revoked); **409 is not checked** → falls to `classifyError` (line 408) → `{ phase: 'error', errorKind: 'server', lastError: 'ACTIVE_DEVICE_EXISTS' }`.
7. Renderer (`onboardingView`, renderer.ts:138–142): `phase === 'error'` → **offline view**, heading *"Unable to reach the WorkLensAI server"*; body text (renderer.ts:211–224) shows the raw string `ACTIVE_DEVICE_EXISTS` because `errorKind !== 'network'`.
8. Depending on the entry path, schedulers may or may not retry (see section 7).

**Result:** the contract's *"clear actionable state"* requirement is not met (misleading "server unreachable" heading + raw API error string), and — worse — automatic retry is NOT suppressed.

---

## 7. Auto-retry analysis (highest priority)

### 7.1 Flow diagram — Device A active, Device B attempts login

```
A active (token T_A valid)
   │
B authenticate ──► 409 ACTIVE_DEVICE_EXISTS (zero mutation; T_A untouched)
   │
   ├─ PATH i: boot (initialize, expired→recover)     → phase error; NO scheduler started → 1 attempt per boot
   ├─ PATH ii: discovery-retry loop active           → discover→approved→auth→409 → error → backoff×2 → FOREVER   [CRITICAL]
   ├─ PATH iii: approval-poll active                 → pollApproval → auth → 409 → error → guard blocks → 1 extra attempt
   ├─ PATH iv: heartbeat 401 → recoverAuth (A's own) → 409 → error → next heartbeat 401 → 409 → FOREVER           [HIGH]
   └─ PATH v: retryConnect (IPC; no UI button)       → error branch → startDiscoveryRetry → enters PATH ii (FOREVER)
A: unaffected — token never deleted/rotated locally, never kicked server-side.
```

### 7.2 CRITICAL — Discovery-retry loop never terminates after 409

- `agent-orchestrator.ts:396–434` `startDiscoveryRetry()`: the stop-guard at line 402–406 lists `authenticated | pending_approval | rejected | revoked` — **`error` is missing**.
- Cycle: `discoverDevice()` (auth-service.ts:299–317, approved branch) → `authenticateDevice()` → 409 → `phase:'error'` → back to the guard → not in stop list → backoff grows 30 s → 10 min → `discoverDevice()` again… **forever**.
- Every cycle makes a real server round trip (`discover` + `authenticate`). This directly violates *"The desktop agent MUST NOT automatically retry authentication after ACTIVE_DEVICE_EXISTS."*
- Reproduction: first run with server unreachable → discovery-retry starts → server returns → admin approves the claim while **another device is already active** → 409 → loop never stops. Same via `retryConnect` error branch (line 381–386) and `cancelRegistration` error branch (line 337).

### 7.3 HIGH — Heartbeat 401 recovery re-authenticates after 409 forever

- `heartbeat-service.ts:51–54`: any heartbeat 401 → `orchestrator.recoverAuth()` (main.ts:103–105).
- `recoverAuth()` (agent-orchestrator.ts:475–496) → `auth.recover()` (auth-service.ts:509–531) → `authenticateDevice()` → **409 → error**; `recoverAuth` falls to `onAuthRequired('Authentication expired')`.
- The heartbeat scheduler keeps running (runtime is never stopped). Every subsequent heartbeat with the still-invalid token returns 401 → `recoverAuth` → 409. **Endless automatic re-authentication at heartbeat cadence (config-driven, floor 10 s).**
- Reproduction: Device A running; A's token expires (24 h); Device B (sitting in error) restarts and successfully takes the slot (no valid token existed); A's next heartbeat is 401 → A enters an endless 401→409 loop. A also *cannot* silently reconnect even after B frees the slot… it actually can: the moment B logs out, A's recover succeeds — so the loop is self-healing but noisy and contract-violating.

### 7.4 MEDIUM — pollApproval performs one extra authenticate after 409

- `pollApproval()` (auth-service.ts:539–611): approved → `authenticateDevice()` → 409 → error; the poll guard at line 540 blocks all subsequent ticks (phase ≠ pending_approval/expired). Bounded — one unauthorized retry per 409, then the state sticks as `error`. (The catch at 595–601 re-forces `pending_approval` only for thrown *discover* errors, i.e. network; a 409 thrown by discover cannot occur — discover never returns 409.)

### 7.5 Ping-pong analysis — PASS

- A 409 is zero-mutation server-side; the agent never deletes or rotates a locally stored token on 409 (no code touches `agent.token` on conflict).
- A's heartbeat continues to succeed while T_A is valid → A stays connected; B stays in `error`.
- Neither device can "kick" the other; B's retries only ever produce another 409 against A's untouched token. **A ping-pong war is structurally impossible.**

---

## 8. Heartbeat analysis

| Heartbeat outcome | Client handling | Recovery path |
|---|---|---|
| A. 401 (token invalid/revoked) | `consecutiveFailures++`; `onAuthError` → `recoverAuth()` → `recover()` → re-auth | If same device holds slot → success (token replaced). If another device holds slot → **409 → endless loop (Finding 7.3)**. If device revoked → 403 (no status field) → misclassified `pending_approval` (Finding below) → next cycle polls discover → `revoked`. |
| B. 403 | Not special-cased in HeartbeatService (only 401 triggers recovery). Falls to generic failure logging; no re-auth, no state change. | — |
| C. 404 | Same as B — generic failure. | — |
| D. Network error | Generic failure; `lastError` recorded; no re-auth triggered. | Heartbeat keeps retrying on its own cadence. |
| E. Organization disabled / account disabled (backend returns 403) | Same as B — generic failure, no recovery, no terminal state. | — |
| F. Device revoked (token deleted) | 401 → recoverAuth → 403 `Device is not active` → **`pending_approval` (misleading)** → next heartbeat → `pollApproval` → discover → `revoked` (terminal). Converges in ~2 cycles but shows "Waiting for administrator approval" meanwhile (auth-service.ts:405). | — |
| G. Authenticate returns 409 | **No special handling** → `error` phase (Finding 6.1). | Depends on entry path (see 7). |

**Heartbeat can and does indirectly call `authenticate()` in a loop after ACTIVE_DEVICE_EXISTS (7.3).**

---

## 9. Discover / registration analysis

| Requirement | Result |
|---|---|
| discover does NOT create an AgentToken | ✅ PASS — backend creates device + pending claim only; client stores claim secret, never a token |
| registration does NOT bypass single-active-device | ✅ PASS — registration/approval creates no token; tokens only come from `/authenticate`, which enforces the active-slot rule server-side |
| approval does NOT create an AgentToken | ✅ PASS |
| discover does not silently authenticate | ✅ PASS — discover alone never calls authenticate; only the explicit `approved` branch of `discoverDevice()`/`pollApproval()` does |
| discover cannot bypass ACTIVE_DEVICE_EXISTS | ✅ PASS — the approved branch calls the same `/authenticate` and receives the 409 |
| cancel works | ✅ PASS — `cancelRegistration` (auth-service.ts:651) cancels with the claim secret; 409/404 treated idempotently (clears claim, re-discovers); network keeps the claim |
| rejected claim can request again | ✅ PASS — `reRegister()` (auth-service.ts:711) + discover `reRegister:true` |
| expired claim can request again | ✅ PASS — poll surfaces `expired` → clears claim → `discoverDevice` re-registers |
| cancelled claim can request again | ✅ PASS — load() maps cancelled → `unregistered` → fresh discovery |
| existing-device hardening intact | ✅ PASS — discover's authenticated rules B/C/D (employee/org binding) unchanged; session-derived identity only |
| anonymous zero-touch unchanged | ✅ PASS — unauthenticated discover flow intact |
| **BUT: approved-device retry loop** | ❌ FAIL — approved + active-elsewhere → endless retry (Finding 7.2) |

---

## 10. Multiple-device analysis

Employee X: A, B, C registered.

| Step | Backend contract | Client behavior | Status |
|---|---|---|---|
| A active | — | A `authenticated`, runtime running | ✅ |
| B/C registered, inactive | — | B/C hold approved claims + secrets, no token | ✅ |
| B authenticates while A active | 409, zero mutation | B → `error` (misleading UI); **no terminal latch; retry loops per 7.2/7.3** | ❌ partial |
| A remains active | A's token untouched | A keeps beating (token still valid) | ✅ |
| A logs out → B can authenticate | slot free | B restart/recover → succeeds; A's local state cleared, A never auto-reconnects (no credentials) | ✅ |
| C attempts while B active | 409 | Same `error` misclassification as B | ❌ partial |
| A must not auto-reconnect after losing slot | — | A *does* auto-re-attempt every heartbeat when its token dies while B holds the slot (7.3) — **violation** | ❌ |

---

## 11. Same-device re-login

- Restart with valid token → `load()` → `authenticated`, no network (auth-service.ts:89–112). ✅
- Restart with expired token + stored claim → `expired` → `recover()` → same device, same claim secret → server replaces its own token → `authenticated`. ✅ (no false 409 — the backend same-device replace path is honored).
- Restart with expired token + stored legacy credentials → `recover()` → `authenticate()` → success. ✅
- No duplicate Device/claim/registration created on re-login: `load()` never calls discover; `recover()` authenticates directly with the stored claim id. ✅

---

## 12. Logout analysis

- `logout()` (auth-service.ts:724–736): server-side revocation via bearer (`/api/agent/logout` — backend revokes AgentSession OR AgentToken, logout/route.ts:36–61) → clears token/credentials/claim/session → `unregistered`.
- Server unreachable → best-effort; local clear always proceeds. ✅
- No automatic re-login after logout: credentials are deleted, so `recover()` finds nothing and returns `expired` without network (test at auth-service.test.ts:223). ✅
- A logs out → B can authenticate (slot freed). ✅
- A does not reconnect after logout (nothing persisted to re-auth with). ✅
- Logout does not delete Device/Claim/registration server-side — correct (credential revocation only).

---

## 13. Restart / persistence analysis

| Item | Behavior |
|---|---|
| What is persisted | `agent.token` (token, expiresAt, deviceId, employee info), `agent.credentials` (employeeId+password), `agent.claim` (deviceId, claimId, secret, status), `agent.session` (login session) — all encrypted (DPAPI/safeStorage); `device-identity.json` (plain, HMAC-bound); `settings.json` (autoStart) |
| Where | `app.getPath('userData')/state` — never desktop ✅ |
| When written | on authenticate/discover/login success; deleted on logout/cancel/reject-expiry |
| After restart | `load()` restores: token valid → authenticated; token expired → `expired`; claim pending → pending_approval (resume polling); claim cancelled → unregistered (fresh discover); claim rejected/revoked → terminal |
| After token expiry | transparent recover → same-device re-auth ✅ |
| After logout | nothing recoverable ✅ |
| **After ACTIVE_DEVICE_EXISTS** | **Nothing records the 409.** The claim stays `approved` + secret persists, so **every restart re-runs the full recovery → 409 again** (deterministic per-boot attempt, not a timer loop, but the 409 is not terminal and persistence actively drives repeated attempts). Combined with 7.2/7.3 the persisted state feeds endless loops. ❌ |

---

## 14. Server URL security — PASS

- Single authoritative resolver `server-url.ts`: `WORKLENSAI_SERVER_URL` env override → `DEFAULT_SERVER_URL`; validated `http(s)`, credentials-in-URL rejected, trailing slashes normalized.
- Renderer: no URL input anywhere; `index.html` CSP `connect-src 'none'`; renderer never receives the URL.
- Preload: no server-url method. IPC: no server-url channel. `agent:get-device` returns only device info (hostname/os/etc — no URL).
- Logging: URL redacted (`redactServerUrl`); packaged EXE never logs the resolved URL; invalid override logs a warning without echoing the value.
- No stale hardcoded URL found in `desktop-agent/src` beyond the documented default.

---

## 15. Employee self-registration audit — PASS

Searched renderer + preload + IPC for register/sign-up/create-account/enroll-org/server fields:
- No account creation, no organization selection, no server input. The only employee controls are the Agent ID/password login (Admin-issued AgentAccount) and "Cancel registration".
- `agent:enroll`/`agent:authenticate` (legacy PATH B) accept employeeId+password — server-side validated against existing Employees only; no creation path exists.
- Identity (employee/org) is always derived server-side from AgentAccount/AgentToken/claim; renderer-supplied identity is never trusted.

---

## 16. IPC / preload security audit — PASS (with notes)

Exposed channels (preload.ts:8–41, ipc.ts:30–133): `agent:get-status`, `get-device`, `enroll`, `authenticate`, `login`, `check-approval`, `cancel-enrollment`, `cancel-registration`, `retry-connect`, `pause`, `resume`, `logout`, `get-settings`, `set-auto-start`; events `agent:status`, `agent:update`, `agent:auth-required`.

- All channels validated: `guard()` requires `file://` sender (ipc.ts:25–28); credentials validated (length/type, ipc.ts:143–154).
- No channel accepts a deviceId/deviceSecret/token/serverUrl — **no renderer path can fabricate an authenticate call or mutate the server URL**.
- Renderer status is a scrubbed projection (agent-orchestrator.ts:148–180): token, expiresAt, claim secret never cross the bridge (asserted by tests: onboarding.test.ts:227, zero-touch.test.ts:240).
- contextIsolation ON, nodeIntegration OFF, sandbox ON, navigation/window.open blocked (main.ts:124–136).
- Note (LOW): the legacy `agent:authenticate`/`agent:enroll` employeeId+password channels are still exposed though the renderer's `AgentApiShape` doesn't call them — dead surface, no bypass.

---

## 17. API client audit

| API | Credential | Expected failure | Recovery behavior |
|---|---|---|---|
| `discover` | none (deviceKey) | 400/404/429/5xx | transport retry (2); 404→error; 429 retried |
| `discoverWithSession` | AgentSession (explicit header) | 401 | classifyError → credentials error; no auto retry |
| `authenticate` / `authenticateDevice` | employeeId+password / claim secret | **409 ACTIVE_DEVICE_EXISTS** | **misclassified as error/server; NOT terminal; retried by schedulers (7.2/7.3)** ❌ |
| `login` | AgentAccount creds | 401/403 | classifyError → credentials error; no auto retry ✅ |
| `agentLogout` | current bearer (session or token) | 4xx/5xx | 1 transport retry; local clear regardless ✅ |
| `cancelClaim` | claim secret | 409/404 (already resolved) | idempotent: clear claim → re-discover ✅ |
| `heartbeat` | AgentToken | 401 | **recoverAuth → re-auth (409 loop possible, 7.3)** ⚠️ |
| config/consent/activity/screenshot | AgentToken | 401 | no handler wired (`onError` unused in production); silent failure, next poll retries |

- 409 status, code `CONFLICT`, and body are fully preserved by `ApiClientError` (client.ts:11–31, 172–178) — the transport is correct; the **consumer** drops the distinction (auth-service.ts:408).
- AgentSession vs AgentToken are kept in separate stores/keys and used for the correct endpoints (session for discover, token for heartbeat/uploads). ✅
- Logout revokes whichever credential is current (backend handles both). ✅

---

## 18. Security findings

| ID | Severity | Finding |
|---|---|---|
| S1 | INFO | `ApiClient.onError` is implemented but never wired in main.ts — dead capability, currently harmless; future wiring could introduce an unbounded re-auth storm (documented 409-reentry risk). |
| S2 | INFO | Heartbeat `lastError`/consecutiveFailures never surfaced in renderer status — an operator cannot see the heartbeat loop. |
| S3 | INFO | Raw `ACTIVE_DEVICE_EXISTS` string displayed verbatim in the offline view; no localization/guidance. |
| S4 | LOW | Legacy `agent:enroll`/`agent:authenticate` IPC + preload surface remain reachable (renderer doesn't call them); not a bypass (server enforces), but dead attack surface worth removing. |
| S5 | PASS | No hardcoded credentials; no token/password/Authorization logging (logger contract + redact()); identity never renderer-controlled; no duplicate authentication implementations found; no stale legacy auth path inside the orchestrator. |

---

## 19. Test coverage

| Area | Coverage | Status |
|---|---|---|
| login (PATH C) | auth-service.test.ts:335–356, 375–399 | ✅ Covered |
| logout | auth-service.test.ts:223–236, 375–399 | ✅ Covered |
| session persistence / restart | auth-service.test.ts:165–193, 358–373; onboarding.test.ts:243–257 | ✅ Covered |
| token persistence | auth-service.test.ts:165–193; zero-touch.test.ts:116 | ✅ Covered |
| heartbeat scheduler | orchestrator-dynamic-config.test.ts:99–136 (interval/clamp only) | ⚠️ Weak — no failure-path tests |
| heartbeat 401 → recover | zero-touch.test.ts:232–236 (single assertion) | ⚠️ Weak |
| reconnect / recovery | onboarding.test.ts:470–535 | ✅ Covered (non-409) |
| discover / zero-touch | zero-touch.test.ts:77–240; onboarding.test.ts:330–417 | ✅ Covered |
| cancel | auth-service.test.ts:253–324 | ✅ Covered (incl. 409-on-cancel) |
| registration / approval | onboarding.test.ts:83–217 | ✅ Covered |
| **ACTIVE_DEVICE_EXISTS on authenticate** | **none** | ❌ Missing |
| **409 → no retry** | **none** | ❌ Missing |
| **multiple devices** | **none** | ❌ Missing |
| **same-device re-login** | zero-touch.test.ts:116 (restart-after-approval) — partial | ⚠️ Weak |
| **restart after 409** | **none** | ❌ Missing |
| **logout → second device login** | **none** | ❌ Missing |
| transport 409 mapping | api-client.test.ts:67 (generic 4xx) — status preserved | ⚠️ Weak — no body/code assertion for 409 specifically |

---

## 20. Manual scenario matrix

| # | Scenario | Expected | Current implementation | Status |
|---|---|---|---|---|
| 1 | First device login | authenticated + runtime | ✅ | PASS |
| 2 | Second device login while first active | 409, zero mutation | 409 received; body preserved | PASS (transport) |
| 3 | First device remains active | A keeps beating | ✅ | PASS |
| 4 | Second device receives 409 | clear, actionable state | Misclassified `error` → "Unable to reach server" | ❌ FAIL |
| 5 | Second device does not retry | terminal | Retry loops via discovery-retry (7.2) and heartbeat (7.3) | ❌ FAIL |
| 6 | First device logout | offline, slot freed | ✅ | PASS |
| 7 | Second device login after logout | succeeds | ✅ (via restart/recover) | PASS |
| 8 | Same-device re-login | token replaced, no 409 | ✅ | PASS |
| 9 | Expired token | transparent re-auth | ✅ same-device; ⚠️ cross-device churn loops (7.3) | PARTIAL |
| 10 | Revoked device | terminal revoked | Converges after ~2 heartbeat cycles through a misleading `pending_approval` blip (7.2 of §8) | PARTIAL |
| 11 | Disabled employee | auth fails, no retry | 401→credentials error | PASS |
| 12 | Disabled AgentAccount | auth fails, no retry | 401→credentials error | PASS |
| 13 | Disabled organization | auth fails | 403→generic error (no special UI) | PARTIAL |
| 14 | Cancel registration | claim cancelled, re-discover | ✅ | PASS |
| 15 | Re-request registration | fresh claim | ✅ | PASS |
| 16 | Admin approval | pending → auto-auth | ✅ (poll) | PASS |
| 17 | Restart after login | session restored | ✅ | PASS |
| 18 | Restart after 409 | terminal/stable, no infinite loop | Re-attempts once per boot (deterministic) but never terminal; feeds loops once schedulers run | ❌ FAIL |
| 19 | Network failure | offline, retry | ✅ (bounded discovery retry) | PASS |
| 20 | Server unavailable | offline view, auto retry | ✅ | PASS |
| 21 | Multiple registered devices | one active, others inactive | Backend enforces; client misclassifies 409 | PARTIAL |
| 22 | Cross-employee device | denied | Server-side deny (404/403); client generic error | PASS |
| 23 | Cross-organization device | denied | Server-side deny; client generic error | PASS |
| 24 | Anonymous zero-touch | unchanged | ✅ | PASS |

---

## 21. Bugs

1. **CRITICAL** — `startDiscoveryRetry` stop-guard omits `error` phase → endless discover+authenticate after 409 (agent-orchestrator.ts:402–406).
2. **HIGH** — Heartbeat 401 → `recoverAuth` → re-auth → 409 → no latch; repeats every heartbeat forever (heartbeat-service.ts:51–54 + agent-orchestrator.ts:586, 624–631; auth-service.ts:509–531).
3. **MEDIUM** — `pollApproval` makes one unauthorized authenticate attempt after a 409 before its guard latches (auth-service.ts:540).
4. **MEDIUM** — 403-without-status (`Device is not active`, revoked device) maps to `pending_approval` — false "Waiting for admin approval" UI (auth-service.ts:405).
5. **LOW** — Offline view claims "The agent will retry automatically" for non-network errors, which is false on the boot path and true-but-harmful on the scheduler paths (renderer.ts:211–224; index.html:102–109).

---

## 22. Missing functionality

- Dedicated `active_device_conflict` terminal state (AuthPhase + renderer view) with actionable copy ("Another device is active for this employee. Log out on that device or contact your administrator.").
- 409-specific handling in `authenticateDevice()` and `authenticate()` before `classifyError`.
- Retry suppression: any scheduler/entry point that drives `recover()`/`authenticate*` must be stopped when the last failure was a 409 (latch on conflict; clear only on manual action, logout, or backend state change via discover).
- Persistence of the conflict latch (survive restart without re-attempt) or, at minimum, a boot policy that treats a previously-conflicted device as `pending_approval`-like (poll discover only — discover is idempotent and cannot create a token).
- Test suite for the whole 409 contract (see §19).

---

## 23. Recommended fixes (for Phase 7 — NOT applied here)

1. In `AuthService`, add `phase: 'conflict'` (terminal) and detect `ApiClientError.status === 409 && body.error === 'ACTIVE_DEVICE_EXISTS'` in both authenticate paths. Do NOT clear the claim/secret (keeps same-device re-login working).
2. Add `'conflict'` (and `'error'` with a conflict flag) to the stop-guards of `startDiscoveryRetry`, `pollApproval`, and the heartbeat `recoverAuth`/`recoverIfNeeded` paths so **no scheduler re-runs authenticate after a 409**.
3. Optionally schedule a slow, read-only `discover` poll in the conflict state so the device can transition automatically when the slot frees (discover cannot create a token → cannot ping-pong). This replaces "retry authenticate" with "observe server state".
4. Renderer: dedicated conflict view with the actionable message; remove the "will retry automatically" copy for non-network errors.
5. Backend-agnostic fix for revoked-device misclassification: treat 403 with `error` message containing "not active" as revoked/conflict, or (preferred) have the backend include `status:'revoked'` in that 403 body.
6. Map 403 (org/account disabled) to a distinct `errorKind` so the UI does not show "server unreachable".
7. Tests: 409-on-authenticate → `conflict`; no retry after conflict across all three schedulers; restart-after-409; two-device churn; logout-then-second-device.

---

## 24. Production impact

- **Availability:** after the multi-device churn scenario (token expiry while two devices exist), the losing device makes an unbounded stream of `authenticate` (and `discover`) calls — one per heartbeat (≥10 s, default 60 s) plus up to one per 10 min from discovery-retry. Server load is low per device but nonzero and permanent; with many conflicting devices it becomes a standing load generator against `/api/agent/authenticate` (a bcrypt route).
- **UX:** employees see "Unable to reach the WorkLensAI server" + raw `ACTIVE_DEVICE_EXISTS` — misleading and unactionable; support load will increase.
- **Security posture:** no credential leak, no token exposure, no bypass; impact is availability/UX, not confidentiality or integrity.

---

## 25. Final verdict

- **ACTIVE_DEVICE_EXISTS handling: FAIL** — transport is correct; state machine and UI are blind to it; not terminal; retried.
- **Auto-retry protection: FAIL** — two scheduler paths retry authenticate after 409 indefinitely.
- **Ping-pong protection: PASS** — structurally impossible (zero-mutation backend + no local token rotation; first device never kicked).
- **Multiple-device behavior: PARTIAL/FAIL** — backend enforces correctly; agent misclassifies and retries.
- **Logout behavior: PASS** — server revoke + local clear; no reconnect.
- **Restart behavior: PARTIAL/FAIL** — restores state well, but a 409 is not terminal across restarts and feeds retry loops.
- **Server URL protection: PASS** — no employee path to change it; env-override + compiled default only.
- **Employee self-registration: PASS** — no sign-up/org/server controls exist.
- **IPC security: PASS** — narrow, validated channels; no credential/fabrication path.
- **Test coverage: FAIL** — zero tests for the 409 contract.

**Counts:** CRITICAL 1 · HIGH 2 · MEDIUM 3 · LOW 3 · INFO 3.

**Bottom line:** the Phase 5 backend contract is correctly implemented server-side, and the agent's transport handles 409 without retrying it as a network error — but the agent's state machine does not understand ACTIVE_DEVICE_EXISTS, fails to make it terminal, and two automatic recovery paths re-authenticate after it indefinitely. The single-active-device guarantee (no kick, no ping-pong, no silent takeover) holds; the no-retry guarantee does not. Phase 7 must add a terminal conflict state, stop-guard all recovery schedulers on 409, and add the missing tests.

---
