# Workload 75 — Agent Active-Device Conflict Implementation Audit

**Phase 7, Step 1 — AUDIT ONLY (no code modified)**
**Date:** 2026-08-11
**Purpose:** Implementation-focused audit of every path that can receive `ACTIVE_DEVICE_EXISTS`, convert it, and (incorrectly) retry it — the basis for Steps 2–10.

---

## 1. Current error representation

**Client side** (desktop-agent/src/api/client.ts:11–31):

```
class ApiClientError extends Error {
  status: number        // HTTP status (0 = network, 409 for conflict)
  code: string          // 'CONFLICT' for 409 (client.ts:196)
  body: unknown         // full parsed JSON body — { error: 'ACTIVE_DEVICE_EXISTS' } preserved
  message: string       // json.error ?? json.message ?? `HTTP ${status}` (client.ts:173–177)
}
```

**Auth layer** (desktop-agent/src/auth/auth-service.ts:17):

```
AuthErrorKind = 'network' | 'credentials' | 'server'
```

**State representation** (auth-service.ts:6–15):

```
AuthPhase = 'unregistered' | 'discovering' | 'pending_approval' | 'rejected'
          | 'revoked' | 'authenticated' | 'expired' | 'cancelled' | 'error'
```

There is **no dedicated conflict state**. A 409 currently collapses into the generic `error` phase with `errorKind: 'server'`.

**Orchestrator** (desktop-agent/src/services/agent-orchestrator.ts:14–21):

```
AgentPhase = 'unregistered' | 'pending_approval' | 'starting' | 'running' | 'paused' | 'stopped' | 'error'
```

Orchestrator phase is a runtime-lifestyle view; the auth phase drives it.

---

## 2. Where HTTP 409 is received

| Call site | File:Line | Retries | Notes |
|---|---|---|---|
| `ApiClient.request()` | client.ts:96–128 | 4xx never retried (except 429) | 409 surfaces as `ApiClientError(409,'CONFLICT',…)` |
| `DeviceApi.authenticate()` (PATH B) | api/device.ts:85–88 | `retries: 0` | |
| `DeviceApi.authenticateDevice()` (PATH A) | api/device.ts:42–45 | `retries: 0` | |
| `DeviceApi.cancelClaim()` | api/device.ts:53–59 | `retries: 0` | 409 here = claim no longer pending — **different semantic**, correctly handled idempotently (auth-service.ts:667–683) |

The **authenticate endpoints are the only place ACTIVE_DEVICE_EXISTS can arrive** (backend: POST /api/agent/authenticate via `acquireActiveSlot`).

## 3. Where the response body `{error:"ACTIVE_DEVICE_EXISTS"}` is parsed

- **Parsed (as raw text):** `client.ts:173–177` — `json.error` becomes `ApiClientError.message`; full `json` is preserved in `.body`.
- **Never structurally consumed:** no code reads `body.error === 'ACTIVE_DEVICE_EXISTS'` or `status === 409` to branch behavior. The body is only inspected for 403 responses (auth-service.ts:396–407, 464–479), where `body.status ∈ {pending,rejected,revoked}` is used.
- **Leak path:** the raw string `"ACTIVE_DEVICE_EXISTS"` is shown verbatim in the renderer offline view because `classifyError` copies `apiErr.message` into `lastError` (auth-service.ts:499) and the renderer displays `lastError` when `errorKind !== 'network'` (renderer.ts:214–224).

## 4. How errors are converted into AuthService error types

`classifyError(err, employeeId)` (auth-service.ts:488–502):

```
status === 0         → errorKind 'network'
status === 401|404   → errorKind 'credentials'
otherwise            → errorKind 'server'      ← 409 lands here
always               → phase: 'error', token: null, expiresAt: null
                       lastError: apiErr.message ('ACTIVE_DEVICE_EXISTS')
```

Callers that map to typed states **before** classifyError:
- `authenticateDevice()` (auth-service.ts:393–411): only `status === 403` (+ `body.status` pending/rejected/revoked). **409 → classifyError.**
- `authenticate()` (auth-service.ts:461–484): same — 403 pending/rejected only. **409 → classifyError.**
- `login()` (auth-service.ts:197–201): no status branching; 409 impossible on /login.
- `pollApproval()` / `discoverDevice()`: catch paths → classifyError (discover never returns 409).

## 5. Orchestrator phase representation

- `AgentOrchestrator.phase` — lifecycle (`stopped→unregistered→pending_approval→starting→running…`).
- `AuthService.state.phase` — auth machine; the orchestrator branches on it (initialize: 186–235; recoverAuth: 481–495; retryConnect: 356–386; checkApproval: 288–298; approval-poll task: 450–462; discovery-retry run: 400–427).
- Renderer sees `status.auth.phase` (scrubbed projection, agent-orchestrator.ts:164–171) + `status.phase`.

## 6. All retry schedulers

| Scheduler | Registered in | Interval | Purpose |
|---|---|---|---|
| `approval-poll` | agent-orchestrator.ts:444–465 | 20 s fixed | Poll claim status while `pending_approval` |
| `discovery-retry` | agent-orchestrator.ts:396–434 | 30 s → 10 min backoff | Auto re-discover while server unreachable at first run |
| `heartbeat` | agent-orchestrator.ts:581–588 | config (≥10 s, default 60 s) | Beat; on 401 → `recoverAuth()` |
| `config-refresh` | agent-orchestrator.ts:532–541 | 10 min | Re-register heartbeat/screenshot intervals |
| `consent-refresh`, `activity-sample`, `queue-drain`, `screenshot-drain` | agent-orchestrator.ts:542–567 | 60 s / 10 s / 20 s / 15 s | Data-plane (no auth calls) |

**Schedulers that can call authenticate: approval-poll (via pollApproval), discovery-retry (via discoverDevice→authenticateDevice), heartbeat (via recoverAuth→recover→authenticate*).**

## 7. All recovery paths

| Path | Entry | Sequence |
|---|---|---|
| `recover()` | auth-service.ts:509–531 | claim secret → `authenticateDevice`; claim `pending_approval` → `pollApproval`; creds → `authenticate`; none → `expired` |
| `recoverAuth()` | agent-orchestrator.ts:475–496 | recover → authenticated→running / revoked/rejected→unregistered+onAuthRequired / else→onAuthRequired |
| `recoverIfNeeded()` | agent-orchestrator.ts:624–631 | after successful heartbeat; if not authenticated → recover |
| `initialize()` | agent-orchestrator.ts:182–237 | load → authenticated→startRuntime; expired→recover; pending→poll; rejected/revoked→unregistered; error→unregistered; unregistered→discoverDevice (+discovery-retry on failure) |
| `retryConnect()` | agent-orchestrator.ts:354–388 | recover → …; error branch → `startDiscoveryRetry()` |
| `checkApproval()` | agent-orchestrator.ts:287–299 | one pollApproval pass |
| `cancelRegistration()` | agent-orchestrator.ts:315–347 | cancel → auto re-discover; error branch → `startDiscoveryRetry()` |

## 8. All places capable of calling authenticate automatically

| Caller | File:Line | Trigger | Survives 409? |
|---|---|---|---|
| `recover()` | auth-service.ts:521 / 530 | heartbeat 401 (recoverAuth), boot expired, retryConnect | **YES — no latch** |
| `pollApproval()` | auth-service.ts:553 | approval-poll tick (20 s), recover, checkApproval | **YES — one extra attempt (guard latches phase≠pending_approval/expired after)** |
| `discoverDevice()` approved branch | auth-service.ts:308 / 317 | discovery-retry tick, initialize first-run, cancelRegistration, retryConnect | **YES — infinite (loop finding)** |
| `enroll()` → already_approved | auth-service.ts:424 | manual enroll (PATH B) | n/a — user-initiated |
| IPC `agent:enroll` / `agent:authenticate` / `agent:login` | ipc.ts:35–65 | manual renderer action | user-initiated — acceptable |

## 9. All places capable of calling discover automatically

| Caller | File:Line | Trigger | Survives 409? |
|---|---|---|---|
| `discoverDevice()` | auth-service.ts:279 | initialize first-run, discovery-retry, cancelRegistration, retryConnect, reRegister | **YES — drives the §8 loop** |
| `pollApproval()` | auth-service.ts:550 | approval-poll tick | YES (via discover→approved→authenticate) |
| `discoverWithSession()` | auth-service.ts:218 | orchestrator.login | user-initiated login |

## 10. All heartbeat recovery paths

- `HeartbeatService.beat()` (heartbeat-service.ts:34–57): 401 → `onAuthError()` → `orchestrator.recoverAuth()` (main.ts:103–105). **Any other status (403/404/5xx/network) → logged failure only, no recovery.**
- Heartbeat run (agent-orchestrator.ts:586): `beat().then(ok => ok ? recoverIfNeeded() : undefined)` — a *successful* beat while `phase !== 'authenticated'` also calls `recover()`.
- **Both paths call authenticate with no conflict latch → the 401→409→heartbeat→401 loop is real.**

## 11. Approval polling behavior

- Guard (auth-service.ts:540): only polls when `phase === 'pending_approval' | 'expired'`.
- Tick (agent-orchestrator.ts:449–463): `pollApproval` → authenticated→onAuthenticated; rejected/revoked→unregistered+stop+onAuthRequired; **error (incl. 409) → no branch action — poll continues**, but `pollApproval`'s own guard then blocks re-entry (phase becomes `error`), so **exactly one extra authenticate attempt occurs after a 409, then the 20 s tick becomes a no-op forever** (timer remains registered — a zombie no-op timer; AD-C23 relevant).

## 12. Renderer states/messages

| auth.phase | View | Heading | Body |
|---|---|---|---|
| authenticated | status | Connected | dashboard |
| pending_approval | pending | Waiting for administrator approval | + Cancel registration |
| rejected | rejected | Registration was not approved | terminal |
| revoked | revoked | Device access has been disabled | terminal |
| error | **offline** (renderer.ts:138–142) | **Unable to reach the WorkLensAI server** | `lastError` when errorKind≠network → **raw "ACTIVE_DEVICE_EXISTS"**; hint claims *"The agent will retry automatically"* (false on boot path, harmful on scheduler paths) |
| unregistered | onboard | Setting up this device… | + "Sign in with Agent ID" |

No conflict view exists. No "Try Again" button exists anywhere (retryConnect IPC is exposed but **no UI invokes it**).

## 13. Restart behavior

- `load()` (auth-service.ts:81–140): token valid→authenticated; token expired→expired; claim approved→**expired** (i.e. next boot → recover → authenticate); claim pending→pending_approval; rejected/revoked→terminal; cancelled→unregistered.
- **The 409 itself is never persisted.** An approved claim + secret survives the 409, so **every restart re-runs recover→authenticate→409** (deterministic per-boot attempt; loops only when schedulers engage — boot path alone does not start discovery-retry, so restart alone = one attempt per boot, not a timer loop).
- initialize() expired-branch fallthrough (agent-orchestrator.ts:203–205) → `phase='unregistered'`, no retry — safe but silent.

## 14. Logout behavior

- `logout()` (auth-service.ts:724–736): best-effort server revocation (backend revokes AgentSession **or** AgentToken, src/app/api/agent/logout/route.ts:36–61) → clears token/credentials/claim/session → `unregistered`. No auto re-login (nothing persisted to re-auth with). **Correct and unaffected by the conflict work.**

## 15. Can any retry survive a 409? — SUMMARY OF VIOLATIONS

| # | Path | After 409 | Severity |
|---|---|---|---|
| V1 | `discovery-retry` run (agent-orchestrator.ts:400–427): stop-guard omits `error` → backoff continues → discover(approved)→authenticateDevice→409 | **Infinite loop** (30 s→10 min) | CRITICAL |
| V2 | heartbeat 401 → `recoverAuth()` → recover → authenticateDevice → 409 → next heartbeat 401 → … | **Infinite loop** (≥10 s) | HIGH |
| V3 | heartbeat OK → `recoverIfNeeded()` → recover → 409 (same loop, different trigger) | Infinite | HIGH (same root) |
| V4 | `pollApproval` → authenticateDevice → 409 → phase error → guard blocks | One extra attempt; zombie 20 s timer remains | MEDIUM |
| V5 | Restart (claim approved persisted) → recover → 409 | One attempt per boot, repeated on every restart; never terminal | MEDIUM |
| V6 | `retryConnect` error branch → `startDiscoveryRetry()` | Joins V1 | CRITICAL (same root) |
| V7 | Renderer: `errorKind:'server'` → raw "ACTIVE_DEVICE_EXISTS" under "Unable to reach server" heading | Misleading UX; false "will retry automatically" claim | MEDIUM |

**Root causes (all in desktop-agent):**
1. No `ACTIVE_DEVICE_EXISTS` detection (auth-service.ts:393–411 / 461–484 don't check 409).
2. No terminal conflict state in `AuthPhase`.
3. Retry stop-guards keyed on phase lists that omit `error` (agent-orchestrator.ts:402–406).
4. `recover()` has no memory of the last failure reason.
5. Renderer has no conflict view / explicit retry control.

---

## Step 1 verdict

Audit complete. The implementation surface for Steps 2–10 is fully mapped above. All fixes land in `desktop-agent/` only (auth-service.ts, agent-orchestrator.ts, renderer.ts + index.html, types/api.ts, preload/IPC surface, new test file). No backend, schema, or backend-test changes are required.

---

**STEP 1 REPORT**
- Files inspected: desktop-agent/src/auth/auth-service.ts, services/agent-orchestrator.ts, services/heartbeat-service.ts, api/client.ts, api/device.ts, types/api.ts, main/main.ts, main/ipc.ts, preload/preload.ts, renderer/renderer.ts, renderer/index.html, scheduler/scheduler.ts, config/server-url.ts, storage/device-identity.ts, auth/secure-store.ts, lib/logger.ts, tests/*.test.ts (16 files), backend cross-check src/app/api/agent/{heartbeat,logout}/route.ts
- Files modified: NONE
- Files created: workload/75-Agent-Active-Device-Conflict-Implementation-Audit.md
- Tests executed: NONE (audit-only step)
- Test results: n/a
- Security impact: NONE (read-only)
- Database impact: NONE
- Regression impact: NONE

STOP AFTER STEP 1 — awaiting approval before STEP 2 (define terminal conflict contract).
