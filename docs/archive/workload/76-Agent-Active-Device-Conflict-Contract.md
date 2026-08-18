# Workload 76 — Agent Active-Device Conflict Contract (Design)

**Phase 7, Step 2 — DESIGN ONLY (no code modified)**
**Date:** 2026-08-11
**Inputs:** workload/75 (STEP 1 implementation audit), workload/74 (Phase 6 desktop audit), backend Phase 4/5 contract (verified).

---

## 1. Scope

Design the Desktop Agent's first-class, terminal semantic handling of the backend `ACTIVE_DEVICE_EXISTS` conflict (HTTP 409). Scope covers: AuthService state representation, orchestrator terminal behavior, retry-scheduler stop-guards, queued-callback protection, renderer UX contract, explicit Try Again recovery, restart behavior, and the STEP 3+ test strategy. **No production code, backend, schema, or test changes in this step.**

## 2. Existing backend contract (authoritative, unchanged)

- One employee may have many registered devices; **only one** may hold a valid active `AgentToken`.
- Second-device authentication while another eligible device is active → `HTTP 409 { "error": "ACTIVE_DEVICE_EXISTS" }`.
- The 409 branch is **zero-mutation**: no kick, no token delete, no new token, no device/claim/ownership change, no DB mutation.
- Same-device re-login: old token replaced, serialized by `acquireActiveSlot()` (Employee `FOR UPDATE`).
- Discovery/registration/approval never create AgentTokens.
- Logout revokes the current credential (AgentSession or AgentToken).

## 3. STEP 1 findings summary (workload/75)

| ID | Finding | Severity |
|---|---|---|
| V1/V6 | `discovery-retry` stop-guard omits `error` phase → discover→authenticate→409 loop forever (30 s→10 min) | CRITICAL |
| V2/V3 | Heartbeat 401 → `recoverAuth()` → recover → authenticate → 409 → repeats every heartbeat (≥10 s) | HIGH |
| V4 | `pollApproval` performs one extra authenticate after 409; zombie 20 s timer remains | MEDIUM |
| V5 | Restart with persisted approved claim → one 409 probe per boot; state never terminal | MEDIUM |
| V7 | Raw `"ACTIVE_DEVICE_EXISTS"` string shown under "Unable to reach the WorkLensAI server"; false "will retry automatically" copy | MEDIUM |

Transport (`ApiClientError(409,'CONFLICT')` + preserved body) is correct; consumers are blind to it.

## 4. Problem statement

The agent has no semantic for "another device holds this employee's active slot." Every path that receives the 409 collapses it into `phase:'error', errorKind:'server'`, which (a) misleads the employee ("server unreachable"), (b) is not terminal, and (c) is re-entered by three schedulers that treat `error` as retryable. Result: unbounded automatic re-authentication against a contract that explicitly forbids it.

## 5. Current failure flow (before change)

```
Device A active (T_A valid)
   ▲                                      ┌──────────────────────────────┐
   │ heartbeat 401 (T_A died)             │ discovery-retry tick          │
   │   → recoverAuth → recover            │   → discoverDevice            │
   │   → authenticateDevice               │     → discover (approved)     │
   │   → 409 → phase 'error' ─────────────┼──→ authenticateDevice → 409   │
   │   → next heartbeat 401 → (repeat)    │   → phase 'error' → backoff×2 │
   └──────────────────────────────────────┴── (repeat forever) ───────────┘
                                          approval-poll tick (one extra attempt, then zombie timer)
```

## 6. Target state machine

Single terminal state — no duplicated states (per design principle):

```
        AUTHENTICATING / recovering (discovering)
                │
                │ HTTP 409 + {error: "ACTIVE_DEVICE_EXISTS"}
                ▼
      active_device_conflict   ← TERMINAL for ALL automatic recovery
                │
                │ only: explicit user "Try Again"
                ▼
        one deliberate authenticate attempt
                │
                ├─ success ──────────────► authenticated (runtime starts)
                ├─ 409 again ────────────► active_device_conflict (again)
                ├─ 401/403 ──────────────► normal error/credentials/authorization handling
                └─ network ──────────────► normal network error handling
```

No automatic transition exists out of `active_device_conflict`. The user's action is the only exit.

## 7. Dedicated conflict state

- **New `AuthPhase` member** (auth-service.ts:6 union): `'active_device_conflict'` — matches the existing lowercase-snake naming convention (`pending_approval`, `unregistered`, …). Alternative names considered (`conflict`, `device_conflict`) rejected as ambiguous; `ACTIVE_DEVICE_CONFLICT`-style constants are not used for phase values in this codebase.
- **New `AuthErrorKind` member** (auth-service.ts:17): `'conflict'` — the existing trio is `network | credentials | server`; `conflict` is a sibling classification, so the renderer can branch structurally without string matching.
- The three-layer distinction is preserved:
  1. Transport: `ApiClientError.status === 409` (client.ts — unchanged).
  2. Backend semantic: `body.error === 'ACTIVE_DEVICE_EXISTS'` (parsed at the two authenticate call sites).
  3. Desktop semantic: `AuthState.phase === 'active_device_conflict'`, `errorKind === 'conflict'`.

### AuthState shape in conflict (contract)

```
{
  phase: 'active_device_conflict',
  token: null,                    // never a token in a non-authenticated state
  expiresAt: null,
  deviceId: <unchanged>,          // preserved — same-device re-login + Try Again need it
  employeeId: <unchanged|null>,   // preserved
  employeeName: <unchanged|null>,
  zeroTouch: <unchanged>,         // preserved
  sessionOnly: <unchanged>,
  errorKind: 'conflict',          // NEW — never 'server', never 'network'
  lastError: 'Another device is currently connected to this account.',
  // lastError is a FIXED safe string — never the raw backend body, never a route/status
  pendingRegistrationId: <unchanged>
}
```

AuthService methods already return `AuthState` (not thrown errors), so **no new error class or thrown sentinel is required** — the semantic is carried by the state shape itself (keeps API consumers unbroken: `authenticate()`/`authenticateDevice()`/`recover()`/`pollApproval()` signatures unchanged).

## 8. AuthService error contract

In **both** `authenticateDevice()` (auth-service.ts:393–411) and `authenticate()` (auth-service.ts:461–484) catch blocks, add — **before** the 403 branch and **before** `classifyError`:

```
if (apiErr.status === 409 && (apiErr.body as { error?: unknown } | null)?.error === 'ACTIVE_DEVICE_EXISTS') {
  → return conflict AuthState (section 7)
}
```

- 409 with any **other** body (e.g. cancelClaim's `'Only pending registrations can be cancelled'`) must keep its existing handling — conflict detection is body-scoped, not status-scoped.
- `classifyError` is never reached for the conflict; `errorKind:'server'` is never produced for it.
- No password, token, or response body is copied into state; `lastError` is the fixed safe string.
- All other statuses (401/403/404/429/5xx/network, 409-other) keep current behavior exactly.
- `recover()` (auth-service.ts:509): add a **top-of-function guard** — if `state.phase === 'active_device_conflict'`, return the state unchanged. This is the single choke point that stops every automatic caller (heartbeat, boot, poll, retry) in one place; the ONLY caller allowed past it is the explicit Try Again path, which clears the phase first (see §17).
- `logout()` unchanged and never blocked by conflict (§18).
- `load()` unchanged (no conflict persistence — §14).

## 9. Orchestrator contract

- **No new `AgentPhase` member.** `AgentPhase` is the runtime-lifestyle view; the conflict is expressed by `AuthState.phase`. Orchestrator `phase` for conflict: `'unregistered'` (consistent with how `rejected`/`revoked`/`error` map today) — avoids a duplicate state per the design principle.
- `initialize()`: in the `expired` branch, after `recover()`, add `active_device_conflict` to the terminal mapping: `phase='unregistered'`, **no** `startDiscoveryRetry()`, **no** `startApprovalPollingIfNeeded()`, **no** auth attempt. (Boot probe = exactly one recover() call; its result is terminal.)
- `recoverAuth()` (agent-orchestrator.ts:475): **short-circuit at entry** — if `auth.getState().phase === 'active_device_conflict'`, return immediately (never calls `recover()`; the recover() guard in §8 is the second line of defense).
- `recoverIfNeeded()` (agent-orchestrator.ts:624): same short-circuit.
- `retryConnect()`: conflict falls into its normal `recover()` flow, which the §8 guard permits **only** because the Try Again path clears the phase first (§17). The `error` branch's `startDiscoveryRetry()` must never fire for a conflict (conflict is never `error`).
- `getStatusForRenderer()`: pass `errorKind` through as today (renderer maps `conflict` to the dedicated view).

## 10. Discovery retry behavior

`startDiscoveryRetry()` run body (agent-orchestrator.ts:399–427): add `'active_device_conflict'` to the **stop-guard set** (line 402–406). The run already re-reads current state at its top; after a conflict the next tick (and any already-queued tick) sees the phase and calls `stopDiscoveryRetry()` + exits — no discover call is ever issued from a conflict.

Additionally: because `discoverDevice()`'s `approved` branch can itself transition into conflict (via its internal `authenticateDevice` call), the **stop check must occur AFTER** `discoverDevice()` returns as well — the existing `after === …` chain already does this; add the conflict phase to that chain (`authenticated | pending_approval | rejected | revoked | active_device_conflict` → stop).

## 11. Authentication retry behavior

- All automatic authenticate entry points terminate on conflict through §8's single `recover()` guard + §9's orchestrator short-circuits.
- `pollApproval()`'s guard (auth-service.ts:540) already excludes everything except `pending_approval | expired`; conflict is thus excluded by construction — no authenticate can be issued from a conflict via polling.
- No exponential backoff scheduler may be started from a conflict (V1 loop eliminated).

## 12. Approval polling behavior

- Guard (auth-service.ts:540) unchanged — conflict ∉ {pending_approval, expired} ⇒ the 20 s tick becomes a **no-op** on the next fire.
- The approval-poll timer itself is **unregistered** when entering conflict from any path that owns it: the orchestrator conflict transition calls `stopApprovalPolling()` (V4's zombie timer removed — AD-C23).
- `checkApproval()` and `onPendingApproval()` no-op when phase is not `pending_approval` (existing guards already handle).

## 13. Heartbeat recovery behavior

- `HeartbeatService` is **unchanged** (it only signals `onAuthError` on 401).
- `recoverAuth()` short-circuit (§9) kills the loop at its entry: `heartbeat 401 → recoverAuth → (conflict? return) → no authenticate`.
- `recoverIfNeeded()` (success-path recovery) short-circuits identically.
- Heartbeat continues to beat in a *running* agent; beats are read-only w.r.t. auth (they just succeed/fail with the stale token). No heartbeat path may ever reach `authenticate` while the phase is conflict. (Note: a running agent that loses its token and gets a 409 will also lose its conflict-free heartbeat recovery — the explicit Try Again path is the exit, consistent with the contract.)

## 14. Startup/restart behavior

**Decision: do NOT persist the conflict state.** Rationale: the existing architecture derives `load()` phase from persisted credentials/claim/token only; a conflict is a *server-state outcome*, not local state; adding a new persistence key buys little (the stale-claim case converges anyway) and adds a new failure surface (stale latch, e.g. after the other device logs out). Per the spec: "Do NOT add unnecessary persistence if it is not required."

Restart contract for Device B (received 409, closed, restarted):
1. `load()` → claim approved + secret → `expired` (existing behavior — unchanged).
2. `initialize()` expired branch → **exactly one** `recover()` call → 409 → `active_device_conflict` → terminal.
3. No scheduler started; no further attempt; no loop. (One deterministic probe per boot, then stable — this is a probe, not a retry loop: it is bounded to a single round trip and terminates in the conflict state.)
4. If the other device logged out while B was closed, the probe succeeds and B connects — correct and desirable.
5. If persisted state instead indicates `unregistered`/`pending_approval`/`rejected`/`revoked` — behavior unchanged (no conflict involvement).

## 15. Timer callback protection

Two layers (per spec — clearing timers alone is insufficient for already-queued callbacks):

1. **Timer clearing**: entering conflict unregisters `approval-poll` and `discovery-retry` (via the stop-guards) from every transition site.
2. **In-callback state validation** (defense in depth — a queued callback that already captured its closure re-checks current state):
   - `recover()` top guard (§8) — the universal choke point; every automatic caller funnels here.
   - `recoverAuth()` / `recoverIfNeeded()` entry guards (§9).
   - `pollApproval()` phase guard (§12).
   - `discovery-retry` run re-reads `auth.getState()` at its top and after `discoverDevice()` returns (§10).
   - `heartbeat` beat-then-recover chain is guarded by `recoverIfNeeded`'s entry check.

A queued callback that fires *after* the conflict can therefore never initiate authentication or discovery.

## 16. Renderer state contract

New view `conflict` (renderer.ts `ViewName` + index.html section), selected when `status.auth.phase === 'active_device_conflict'`:

- **Title:** "Another device is connected"
- **Description:** "This employee account already has another active device. Only one device can be connected at a time. Please log out or disconnect the other device before connecting this device."
- **Action:** `[ Try Again ]` button → `bridge.retryConnect()` (already exposed: preload.ts:20 → `agent:retry-connect` → orchestrator.retryConnect). **No new IPC or preload surface required.**
- **Explicitly NOT displayed:** HTTP status, `ACTIVE_DEVICE_EXISTS`, phase names, route names, stack traces, `lastError` raw text. The view uses fixed copy only.
- No registration, account creation, server-URL editing, organization selection, device deletion, or remote device management controls (zero-control posture preserved).
- Optional `[ Sign Out ]`: **not added in this phase** — the renderer exposes no logout control today (zero-control design); Try Again alone satisfies the recovery contract.

## 17. Explicit Try Again flow

1. Employee clicks `[ Try Again ]` (conflict view only).
2. IPC `agent:retry-connect` → `orchestrator.retryConnect()`.
3. `retryConnect()` detects `phase === 'active_device_conflict'` and calls a small explicit-recovery path: clears the conflict phase (transition `active_device_conflict → expired` semantics — i.e., "treat as needing auth") **then** invokes `auth.recover()` exactly once.
4. `recover()` (now allowed through the §8 guard because the phase is no longer conflict) performs **one** deliberate attempt with the stored claim secret (PATH A) or stored credentials (PATH B), or — if nothing is stored — drops to `unregistered` (onboard view).
5. Outcomes, all normal:
   - success → `authenticated` → `onAuthenticated()` → runtime starts.
   - 409 → `active_device_conflict` again (terminal — the loop is a single round trip per click, never automatic).
   - 401 → normal credentials error; 403 → normal pending/rejected/revoked handling; network → normal network error handling.
6. No timers are started by Try Again; no backoff; no recursion. Double-clicks are harmless (the second click finds conflict-or-progress state and no-ops or repeats a single attempt).

## 18. Logout behavior

- `logout()` is **never blocked** by conflict: works from `active_device_conflict` exactly as from any other state (server-side best-effort revocation → local clear of token/credentials/claim/session → `unregistered`).
- After logout from a conflict, the device is clean; next boot runs the normal first-run/zero-touch flow.
- Logout of Device A (active) frees the slot; Device B may then click Try Again and succeed (contract preserved).

## 19. Existing-device behavior

- The active device (A) is never disconnected, kicked, or mutated by B's 409 — enforced by the backend's zero-mutation contract and by the agent never issuing any mutation on a 409 (the conflict path only sets local state). A's token is never touched locally.
- A is unaware of B entirely.

## 20. Same-device behavior

- Unchanged: same-device re-login (token expired + stored claim/creds) is allowed by the backend (slot replacement) and never produces a conflict. The conflict state is only entered on a *409*, which the backend issues only for a *different* eligible device.
- After a genuine conflict, the employee may resolve it on the other device, then Try Again from this device — no false conflict remains (the backend slot is then free).

## 21. Multi-device behavior

- Many devices may stay registered (claims/registrations untouched — conflict does not alter or delete them).
- Only one device holds an active AgentToken at a time (backend-enforced).
- Each losing device lands in `active_device_conflict`; each may Try Again independently; the first to succeed when the slot frees wins; the others go back to conflict. No ping-pong: every attempt is user-initiated and single-shot.

## 22. Security invariants

1. Existing device never silently disconnected — YES (zero-mutation backend + no client mutation on 409).
2. 409 zero-mutation — YES (client conflict path writes only local state; no device/token/claim API calls).
3. No ping-pong — YES (automatic retries impossible; only single user-initiated attempts).
4. No infinite retry — YES (terminal state + §10–15 guards).
5. No credential leakage — conflict state contains no password; credentials stay in the encrypted store only.
6. No token leakage — `token: null` in conflict state; renderer projection already strips tokens.
7. No backend error leakage into UI — renderer uses fixed copy; `lastError` is a fixed safe string; logger never logs the raw body (existing `redact`/log contract maintained).
8. Server URL authoritative — unchanged (server-url.ts untouched; no renderer/IPC surface).
9. Employee cannot modify server URL — unchanged.
10. Employee self-registration absent — unchanged (no new controls added; the conflict view adds only Try Again).

## 23. No-mutation invariant

Entering conflict performs **zero network calls** except the original authenticate request that produced the 409. Specifically the conflict transition: does not call discover, authenticate, cancel, logout, heartbeat, or any write endpoint; does not delete the local claim/credentials (needed for Try Again and same-device re-login); deletes nothing; only sets `AuthState`. (Logout and Try Again are separate explicit user actions, not part of the transition.)

## 24. State transition table

| From | Event | To | Actor | Automatic? |
|---|---|---|---|---|
| any authenticating/recovering path | 409 + `ACTIVE_DEVICE_EXISTS` | `active_device_conflict` | AuthService (both authenticate paths) | — |
| `active_device_conflict` | any timer tick / heartbeat / poll / boot recovery | `active_device_conflict` (no-op) | §10–15 guards | never allowed |
| `active_device_conflict` | Try Again (user) | attempt → `authenticated` / `active_device_conflict` / `error` / `rejected` / `revoked` / `expired` | retryConnect → recover | user-initiated, single-shot |
| `active_device_conflict` | logout (user) | `unregistered` | logout | user-initiated |
| `active_device_conflict` | restart | `expired` → one probe → `active_device_conflict` (or `authenticated` if slot freed) | initialize | single probe per boot, then terminal |
| `active_device_conflict` | success (slot freed, Try Again) | `authenticated` → runtime | recover | user-initiated |
| `active_device_conflict` | 409 again (Try Again) | `active_device_conflict` | recover | user-initiated, terminal again |

No other transitions exist to/from the conflict state.

## 25. Files expected to change in later steps

| File | Change |
|---|---|
| `desktop-agent/src/auth/auth-service.ts` | `AuthPhase` += `'active_device_conflict'`; `AuthErrorKind` += `'conflict'`; 409+body detection in `authenticateDevice()`/`authenticate()`; `recover()` conflict guard; Try Again path (conflict→attempt) in `recover()` |
| `desktop-agent/src/services/agent-orchestrator.ts` | stop-guard updates (discovery-retry stop-set + post-call chain); `recoverAuth()`/`recoverIfNeeded()` entry short-circuits; `initialize()` conflict mapping; `retryConnect()` conflict handling; `stopApprovalPolling()` on conflict entry |
| `desktop-agent/src/renderer/renderer.ts` | `ViewName` += `'conflict'`; phase→view mapping; Try Again button binding; `AgentApiShape` += `retryConnect` |
| `desktop-agent/src/renderer/index.html` | conflict view section + Try Again button |
| `desktop-agent/tests/agent-active-device-conflict.test.ts` | NEW — AD-C01…C25 suite |

Unchanged by design: `heartbeat-service.ts`, `api/client.ts`, `api/device.ts`, `types/api.ts`, `preload.ts`, `ipc.ts`, `main.ts`, `scheduler.ts`, `secure-store.ts`, `server-url.ts`, `storage/*`, `logger.ts`.

## 26. Files that MUST NOT change

- Backend: `src/app/api/agent/**`, `src/lib/agent/activation.ts`, `src/lib/agent/auth.ts`, `src/lib/agent/session.ts`
- Database: `prisma/**`, no migrations
- Backend tests: `tests/**` (root)
- Desktop: all existing `desktop-agent/tests/*.test.ts` (must keep passing unmodified); `heartbeat-service.ts`, `api/*`, `server-url.ts`, `secure-store.ts`, `storage/*`, `scheduler.ts`, `logger.ts`, `preload.ts`, `ipc.ts`, `main.ts` (unless STEP 4 discovers a genuine necessity — then STOP and report per the phase policy)

## 27. Test strategy for STEP 3+

New file `tests/agent-active-device-conflict.test.ts` (node:test + InMemorySecureStore + FakeDeviceApi pattern, mirroring `auth-service.test.ts`):

| ID | Test | Layer |
|---|---|---|
| AD-C01 | 409 + `{error:'ACTIVE_DEVICE_EXISTS'}` parsed into conflict state (both authenticate paths) | AuthService |
| AD-C02 | conflict phase is dedicated, not `error` | AuthService |
| AD-C03 | `errorKind === 'conflict'`, never `'server'` | AuthService |
| AD-C04 | renderer-safe status carries `phase:'active_device_conflict'` + `errorKind:'conflict'`; no raw backend string in `lastError` | Orchestrator |
| AD-C05 | discovery-retry stops after conflict (no further discover calls) | Orchestrator |
| AD-C06 | no automatic authenticate after conflict (any trigger) | Orchestrator |
| AD-C07 | heartbeat 401 → recoverAuth no-ops in conflict (no authenticate call) | Orchestrator |
| AD-C08 | approval-poll cannot authenticate after conflict; timer unregistered | Orchestrator |
| AD-C09 | queued callback firing after conflict no-ops (recover() guard) | AuthService |
| AD-C10 | restart (`load()`+`initialize()`) does one probe → conflict; no loop | Orchestrator |
| AD-C11 | Try Again performs exactly one authenticate call | AuthService+Orchestrator |
| AD-C12 | repeated 409 on Try Again → conflict again | AuthService |
| AD-C13 | slot freed (simulated success) → Try Again succeeds | AuthService |
| AD-C14 | first device state untouched by second device's conflict (no local mutation) | AuthService |
| AD-C15 | conflict never calls revoke/logout/delete APIs | AuthService |
| AD-C16 | no AgentToken write on 409 (no API call issued) | AuthService |
| AD-C17 | same-device re-login still works (expired→recover→success, no conflict) | AuthService |
| AD-C18 | 401 still → credentials error | AuthService |
| AD-C19 | 403 pending/rejected/revoked unchanged | AuthService |
| AD-C20 | network error unchanged (`errorKind:'network'`) | AuthService |
| AD-C21 | logout from conflict works and clears state | AuthService |
| AD-C22 | no raw backend string reaches renderer-facing state | Orchestrator |
| AD-C23 | no duplicate/zombie timers after conflict (`scheduler.getIntervalMs` = null) | Orchestrator |
| AD-C24 | no ping-pong: repeated conflict attempts are strictly user-initiated | Orchestrator |
| AD-C25 | server-url module untouched behavior (existing server-url tests) | — |

Execution gates (STEP 9): desktop full suite (`npm test` equivalents per test runner), new conflict suite, backend regression suite, `npx tsc --noEmit`, admin production build — all must pass with **no existing test weakened or deleted**.

## 28. Acceptance criteria

All of the Phase 7 final checklist, specifically for this design:
1. `ACTIVE_DEVICE_EXISTS` has dedicated semantic handling (body-scoped detection).
2. Dedicated terminal conflict state exists (`active_device_conflict`).
3. Discovery retry stops (guard set + post-call chain).
4. Authentication retry stops (single `recover()` choke point).
5. Heartbeat recovery stops (recoverAuth/recoverIfNeeded entry guards).
6. Approval polling stops (phase guard + timer unregister).
7. Queued callbacks cannot restart auth (in-callback re-validation).
8. Restart cannot create a retry loop (single probe, terminal).
9. Explicit Try Again works (single-shot, all outcomes normal).
10. Existing active device never kicked (no client mutation on 409).
11. 409 causes zero mutation (invariant §23).
12. Same-device re-login unchanged.
13. Multiple devices remain registered.
14. Only one device actively connected (backend-enforced, unchanged).
15. No ping-pong.
16. No infinite retry.
17. Renderer has clear conflict UX (fixed copy, no raw strings).
18. No employee self-registration added.
19. Server URL remains locked.
20. Full test suites + tsc + build pass.

## 29. Residual risks

| Risk | Mitigation | Residual |
|---|---|---|
| A previously queued callback races the conflict transition between the state check and its API call | All auth/discover entry funnels through `recover()`'s guard + orchestrator entry guards; the window is single-statement | LOW |
| One authenticate probe per restart (conflict not persisted) | Bounded to one round trip per boot; converges to terminal conflict; enables free-slot pickup | LOW — accepted by design (documented §14) |
| Pre-existing 403 revoked-device misclassification (`pending_approval` blip, workload/74 §21) | Out of scope for this phase; unchanged | LOW — documented, deferred |
| Try Again double-click racing a heartbeat callback | Guards serialize; second attempt yields 409 → conflict again; no mutation | LOW |
| Conflict detection depends on body shape `{error:'ACTIVE_DEVICE_EXISTS'}` | Matches the authoritative backend contract; any future backend change would need a coordinated contract change | LOW |

## 30. STOP decision

Design is complete and self-consistent with the existing architecture (no new persistence, no new IPC/preload surface, no new AgentPhase, no backend or schema impact). **STOP — do not implement. Await explicit approval for STEP 3.**

---

**STEP 2 REPORT**

- Files inspected: `desktop-agent/src/auth/auth-service.ts`, `services/agent-orchestrator.ts`, `services/heartbeat-service.ts`, `renderer/renderer.ts`, `renderer/index.html`, `api/client.ts`, `api/device.ts`, `types/api.ts`, `main/ipc.ts`, `preload/preload.ts`, `scheduler/scheduler.ts`; artifacts `workload/74`, `workload/75`
- Files modified: NONE
- Files created: `workload/76-Agent-Active-Device-Conflict-Contract.md`
- Tests: NOT RUN — DESIGN ONLY
- Database impact: NONE
- Backend impact: NONE
- Desktop architecture impact: adds `'active_device_conflict'` AuthPhase + `'conflict'` AuthErrorKind; terminal-state handling via a single `recover()` choke point + orchestrator entry guards; no new persistence, no new IPC/preload surface (Try Again reuses existing `agent:retry-connect`), no new AgentPhase; heartbeat-service and transport unchanged
- Security impact: NONE (design only); conflict path performs zero network calls; no raw backend text to renderer; no credential/token leakage
- Key decisions:
  1. Phase name `active_device_conflict` (existing lowercase-snake convention)
  2. New `AuthErrorKind` member `'conflict'` (sibling of network/credentials/server)
  3. Detection is body-scoped: `status===409 && body.error==='ACTIVE_DEVICE_EXISTS'`
  4. Single terminal state — no duplicated states, no new AgentPhase
  5. Conflict NOT persisted — one deterministic boot probe, then terminal (bounded, converges, enables free-slot pickup)
  6. Try Again reuses the existing `retryConnect` IPC — zero new bridge surface
  7. No `[ Sign Out ]` in this phase (renderer has no logout control today; zero-control posture)
  8. `stopApprovalPolling()` + discovery-retry stop-guards on conflict entry; in-callback re-validation as second layer
- Acceptance criteria: 20-item checklist per §28, verified via AD-C01…C25 tests in STEP 9
- STOP: YES

Do NOT start STEP 3. Wait for explicit approval before implementation.
