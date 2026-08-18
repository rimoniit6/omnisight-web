# 78 — Agent Active-Device Conflict: STEP 4 Integration Audit

**Date:** 2026-08-11
**Mode:** AUDIT ONLY — no source, migration, or test files modified
**Inputs:** workload/76 (contract), workload/77 (implementation report), actual current source code (not the reports alone)

---

## 1. Executive Verdict

**APPROVE WITH NOTES — the implementation faithfully realizes the workload/76 contract and closes all five STEP 1 findings (V1/V2/V4/V5/V7). No CRITICAL or HIGH defects found.** The state machine, 409 detection, automatic-retry guards, token safety, and renderer security all verify against actual source (not just reports). Three WARNING-level observations are documented: (a) a boot-time token-revocation race leaves the orchestrator `phase='running'` while auth is in terminal conflict (UI unaffected), (b) the backend 409 contract has zero automated coverage, and (c) minor test-coverage gaps (no explicit `recoverIfNeeded` conflict test, no store-level token assertion on 409). All suites re-run green: desktop 158/158, backend agent-login 22/22, admin tsc + next build, desktop tsc (both configs), ESLint.

## 2. Files inspected

| File | Role |
|---|---|
| `workload/76-Agent-Active-Device-Conflict-Contract.md`, `workload/77-Agent-Active-Device-Conflict-Implementation.md`, `workload/74`, `workload/75` | Contract, implementation report, prior audits |
| `desktop-agent/src/auth/auth-service.ts` | State machine, detection, latch, Try Again |
| `desktop-agent/src/services/agent-orchestrator.ts` | Terminal mapping, retry guards, poll/discovery stop |
| `desktop-agent/src/services/heartbeat-service.ts` | 401 → onAuthError (unchanged) |
| `desktop-agent/src/scheduler/scheduler.ts` | Timer registry |
| `desktop-agent/src/main/main.ts`, `main/ipc.ts`, `preload/preload.ts` | Wiring, IPC surface, bridge |
| `desktop-agent/src/renderer/renderer.ts`, `index.html`, `styles.css` | Conflict view, Try Again |
| `desktop-agent/src/api/client.ts`, `api/device.ts`, `types/api.ts` | Transport, endpoints |
| `desktop-agent/src/lib/logger.ts`, `config/server-url.ts`, `services/update-service.ts` | Logging/observability |
| `desktop-agent/tests/agent-active-device-conflict.test.ts` + 16 existing suites | Test coverage |
| `src/lib/agent/activation.ts`, `src/app/api/agent/{authenticate,login,logout,discover,heartbeat,register}/route.ts`, backend tests | Backend contract |

## 3. Files modified

**NONE by this audit.** Working-tree Phase 7 changes (verified via `git status`/`git diff`): `auth-service.ts`, `agent-orchestrator.ts`, `renderer.ts`, `index.html` modified; `tests/agent-active-device-conflict.test.ts` added. `ipc.ts`, `preload.ts`, `heartbeat-service.ts`, `client.ts`, `server-url.ts`, `scheduler.ts`, `logger.ts`, `secure-store.ts`, storage, and all existing tests are untouched (only `retryConnect`/`agent:retry-connect` pre-existed at HEAD~1 — confirmed via git). Backend route diffs (`authenticate`, `discover`) are the earlier Phase 5 single-active-device work, not Phase 7.

## 4. State-machine verification — PASS

`AuthPhase` (auth-service.ts:6–16) includes `'active_device_conflict'`; `AuthErrorKind` (line 18) includes `'conflict'`.

**Entry paths (all detected via the single body-scoped predicate `isActiveDeviceConflict`, auth-service.ts:66–71):**

1. `authenticateDevice()` catch — line 424
2. `authenticate()` catch — line 495
3. `discoverDevice()` catch (approved→authenticate) — line 393
4. `pollApproval()` catch (approved→authenticate) — line 675

**Exit paths:**

- `retryAfterConflict()` (line 601) — the only intentional exit; clears latch → `expired` semantics → exactly one `recover()`.
- `logout()` (line 806) — never blocked; local clear always proceeds.
- `load()` — conflict is never persisted (no store key; `load()` derives phase from token/claim/creds only) → restart re-enters via one boot probe.

**No-mutation on entry:** `enterActiveDeviceConflict()` (546–556) performs zero network calls and zero store writes; only spreads state, nulls token/expiresAt, sets fixed `lastError`. `KEY_TOKEN` is written exclusively by `persistToken()` on success and deleted exclusively by `logout()` (verified by grep: 15 `store.delete` sites, none on the conflict path). Existing AgentToken, claim, credentials, session, Device rows, and employee state are never touched by a 409. **Terminality confirmed** — every automatic caller funnels through `recover()`'s top guard (line 568) or the orchestrator entry guards (§6).

## 5. 409 detection verification — PASS

Every authenticating request audited:

| Request | Conflict detection | Status |
|---|---|---|
| `authenticateDevice` (PATH A) | ✓ line 424 | PASS |
| `authenticate` (PATH B) | ✓ line 495 | PASS |
| `discoverDevice` (approved branch's internal authenticate) | ✓ line 393 | PASS |
| `pollApproval` (approved branch) | ✓ line 675 | PASS |
| `enroll`→register | register route never returns 409 (no `ACTIVE_DEVICE_EXISTS` in route) | N/A |
| `login` (AgentAccount) | login route can never 409 (uniform 401; creates AgentSession only) | N/A |
| `discoverWithSession` | discover route never 409s (400/429/503/201/404/500 only) | N/A |
| heartbeat/config/consent/activity/screenshot | no authenticate; no token creation | N/A |
| transport retry (`client.ts:116–119`) | 409 is 4xx → never retried at transport level | PASS |

Detection is body-scoped and status-gated: 409+other-error → generic `server` (test 3), 409+null body → `server` (test 4), non-409 statuses → existing classification (tests 13–15), a 200 with the marker is impossible (predicate requires `status === 409`), nested `error` fields don't match (top-level `body.error` only), malformed bodies can't match (`body?.error` strict equality). The only backend producer of `ACTIVE_DEVICE_EXISTS` is `src/app/api/agent/authenticate/route.ts:230`; body shape matches exactly.

## 6. Automatic retry verification — PASS

Every timer/retry mechanism enumerated:

| Mechanism | Can run after conflict? | Guard |
|---|---|---|
| `discovery-retry` tick (orchestrator:425–460) | No — pre-tick stop-set includes conflict (428–430); post-`discoverDevice` chain stops (446–450); timer unregistered | Two-layer ✓ |
| `approval-poll` tick (orchestrator:481–500) | No — `pollApproval` phase guard (auth-service:616) + scheduler unregister on conflict | Two-layer ✓ |
| `checkApproval` IPC (orchestrator:295) | No — phase guard | ✓ |
| heartbeat → `recoverAuth` (main.ts:103–105 → orchestrator:513) | No — entry guard line 516 + `recover()` latch | Two-layer ✓ |
| heartbeat-ok → `recoverIfNeeded` (orchestrator:635, 673) | No — guard line 675–676 | ✓ |
| `retryConnect` (user) | Intended — single-shot via `retryAfterConflict` | ✓ |
| `cancelRegistration` rediscovery | User-initiated only; conflict branch stops (346–348) | ✓ |
| boot probe (`initialize` expired branch:188–209) | One `recover()` per boot; conflict mapping 203–206; no timers | ✓ |
| `initialize` first-run (221–243) | Conflict mapping 233–236 | ✓ |
| ApiClient transport retry | 409 never retried | ✓ |
| `main.ts` 5s status timer, `update-service` timer | Read-only, no auth | N/A |

No remaining automatic retry loop exists. Every queued callback that could fire post-conflict re-validates state before acting (the §15 two-layer protection holds).

## 7. Ping-pong verification — PASS (code + tests)

A active, B authenticates → B: 409 → `active_device_conflict`, zero mutation. A's token/device/heartbeat are never touched (backend `acquireActiveSlot` throws before any write; transaction rolls back — `src/lib/agent/activation.ts:188–191`; desktop never issues a mutation on 409). B never auto-retries. B→Try Again while A active: one attempt → 409 → terminal again (test 10 asserts exactly 2 total attempts). A logs out → B→Try Again: `authenticateDevice` succeeds → token persisted → runtime starts (tests 9, 11, 20). No A↔B ping-pong is constructible: every attempt is user-initiated and single-shot; server serializes via Employee `FOR UPDATE`.

## 8. Restart verification — PASS

Conflict is not persisted. Restart sequence: `load()` → approved claim → `expired` → `initialize()` → exactly one `recover()` probe → 409 → `active_device_conflict`, `phase='unregistered'`, no timers (test 17 asserts 2 total `authenticateDevice` calls across boot+restart; `scheduler.getIntervalMs('discovery-retry'|'approval-poll') === null`). If A logged out while B was closed, the probe succeeds → B connects (test 9 pattern). No per-N-second re-auth (only the single probe per boot); no token mutation on the probe failure.

## 9. Heartbeat verification — PASS

- Conflict cannot trigger `recoverAuth()` (entry guard) — 401-driven loop killed.
- `recoverIfNeeded()` short-circuits on conflict.
- Heartbeat never deletes/revokes another device, never creates a token (heartbeat-service.ts:34–57 is read-only w.r.t. auth; backend heartbeat only updates own `lastHeartbeat`).
- Deterministic cases: active device loses connection → heartbeats fail, no auth change; inactive device in conflict → stays terminal; old token expires → 401 → `recoverAuth` → probe → conflict or re-auth; logout from active device → slot freed → B's Try Again succeeds; device revoked/employee disabled → 401/403-classified per existing paths (403 revoked/rejected mapped at auth-service:427–439); conflict state unaffected.
- One **WARNING** (B1): if a boot-time valid token is revoked server-side *before the first beat*, `startRuntime`'s `await heartbeat.beat()` (orchestrator:618) triggers `recoverAuth` → conflict, then line 620 unconditionally sets `phase='running'` — collectors keep sampling into the local queue (uploads 401-fail). UI still shows the conflict view correctly (auth.phase is authoritative). This matches the contract's accepted "running agent keeps beating" stance (§13) but was not explicitly called out for the boot path.

## 10. Renderer / UX verification — PASS

`ViewName`/`VIEW_IDS`/`ONBOARDING_LABELS` include `conflict` (renderer.ts:112–123, 172). `onboardingView()` maps `active_device_conflict` → conflict view before any other branch, so it can never fall through to "Unable to reach the WorkLensAI server" (the offline label) nor to the login view (line 137's `loginRequested` set excludes conflict). Conflict view uses fixed copy only ("Another device is currently connected…", index.html:104–114); renderer re-sets the fixed text (236–247) and clears `conflict-error`. No raw backend body, status, phase name, URL, token, or credentials are rendered — `errorKind 'conflict'` is never shown as text. Transitions verified: conflict→authenticating→success (`render(status)` after `retryConnect` returns authenticated); conflict→conflict (repeat 409); conflict→network error → offline view with auto-retry. `bindTryAgain()` disables the button in flight and never fabricates success (352–369).

## 11. IPC / preload security — PASS

No new IPC channel: `agent:retry-connect` existed at HEAD~1; `retryConnect` reuses it (preload.ts:20). Renderer cannot submit employeeId/deviceId/orgId for discovery or retry (identity is main-derived; `validateCredentials` only gates enroll/authenticate/login inputs, ipc.ts:143–153). No IPC accepts a phase — the renderer cannot force conflict, bypass authentication, or touch tokens/credentials. The only status crossing IPC is `getStatusForRenderer()` (token/expiry stripped, orchestrator:148–180). Main-side `file://` sender guard on every channel (ipc.ts:25–28).

## 12. Token safety — PASS

On 409: existing token not deleted (only `logout` deletes `KEY_TOKEN`), not replaced, no new token created (`persistToken` only on success), no device disconnected (no `device` API call), `Device.status`/`lastHeartbeat` untouched by the client, heartbeat unchanged. `retryAfterConflict()` creates a token only after the server explicitly allows authentication (i.e., `authenticateDevice`/`authenticate` 2xx → `persistToken`). Backend mirrors this: 409 path throws before any write; `replacedTokenIds` only ever deletes the requesting device's own tokens (activation.ts:195–200).

## 13. Device lifecycle verification — PASS

Conflict handling modifies nothing on the server or client: `Device.status`, `lastHeartbeat`, `employeeId`, `organizationId`, `agentKey`, claims, and the active device's token are untouched. A 409 can never make the conflicting device active — activation is granted only by the server issuing a token. The active device remains authoritative until it logs out, its token expires, or its device/employee becomes ineligible.

## 14. Backend contract verification — PASS

Desktop behavior matches the routes: `authenticate` → 409 `{error:'ACTIVE_DEVICE_EXISTS'}` only for "another eligible device owns the slot" (activation.ts predicate: unexpired token + device exists + eligible `online|offline` + same employee + same org); never for invalid credentials (401), revoked device / disabled account / inactive org (403 via `EmployeeNotEligibleError`/`DeviceNotEligibleError`), expired session (401), or network errors (0/5xx). `login`, `discover`, `heartbeat`, `logout` contract shapes match the desktop's `types/api.ts` and `device.ts` call sites.

## 15. Test coverage matrix (AD-C01…C25 vs actual tests)

All 24 tests in `agent-active-device-conflict.test.ts` re-ran and passed (within the 158/158 suite).

| Contract | Test | PASS/FAIL | Evidence |
|---|---|---|---|
| AD-C01 409+marker → conflict, both auth paths | tests 1, 2 | PASS | phase/errorKind/token/lastError asserts |
| AD-C02 dedicated phase, not `error` | tests 1, 2, 5, 6 | PASS | `active_device_conflict` |
| AD-C03 `errorKind 'conflict'`, never 'server' | tests 1, 2, 10 | PASS | asserts |
| AD-C04 renderer-safe status, no raw string | test 19 | PASS | JSON absence of `ACTIVE_DEVICE_EXISTS` |
| AD-C05 discovery-retry stops | test 23 | PASS | timer null + zero further discover calls |
| AD-C06 no auto authenticate after conflict | tests 7, 8, 21, 24 | PASS (partial) | recover/poll/recoverAuth/checkApproval covered; `recoverIfNeeded` NOT directly tested (see G1) |
| AD-C07 heartbeat 401 → recoverAuth no-op | test 21 | PASS | call-count zero |
| AD-C08 poll cannot auth; timer unregistered | test 22 | PASS | timer null + no-op re-run |
| AD-C09 queued callback no-op | tests 7, 8, 22, 23 | PASS | guard + registry removal |
| AD-C10 restart → one probe → terminal | test 17 | PASS | 2 total calls; both timers null |
| AD-C11 Try Again = exactly one attempt | test 20 | PASS | call counts 2→3 |
| AD-C12 repeat 409 → conflict again | test 10 | PASS | |
| AD-C13 slot freed → Try Again succeeds | tests 9, 11, 20 | PASS | authenticated + heartbeat timer |
| AD-C14 first device state untouched | test 9 | PASS (partial) | claim survives + retry succeeds; no direct "Device A" object assert (server-side) |
| AD-C15 conflict never calls revoke/logout/delete | tests 7, 8 | PASS (partial) | zero-call asserts; no dedicated cancel/logout-call spy on transition |
| AD-C16 no AgentToken write on 409 | test 1 | PASS (partial) | state.token null; **no direct store `agent.token` absence assert** (see G2) |
| AD-C17 same-device re-login unchanged | auth-service.test.ts (recover re-auth) | PASS | existing suite unmodified |
| AD-C18 401 → credentials | test 14 | PASS | |
| AD-C19 403 pending/rejected/revoked | test 13 + auth-service.test.ts | PASS | |
| AD-C20 network error unchanged | test 15 | PASS | |
| AD-C21 logout from conflict | test 16 | PASS | unregistered, token null |
| AD-C22 no raw string to renderer | test 19 | PASS | |
| AD-C23 no zombie timers | tests 17, 18, 22, 23 | PASS | `getIntervalMs` null |
| AD-C24 no ping-pong, strictly user-initiated | tests 10, 20 | PASS (partial) | count-based; no timer-driven attempt test exists |
| AD-C25 server-url untouched | server-url.test.ts | PASS | module unmodified |

**Missing tests:**

- G1 `recoverIfNeeded` conflict guard (private, reachable only via the heartbeat job — not exercised)
- G2 store-level `agent.token` absence/identity after 409
- G3 renderer-level UI test for the conflict view (no renderer test harness — `renderer-build`/`zero-control` scan the artifact only)
- G4 double-click/concurrent `retryConnect`
- G5 **backend**: no automated test for the server's 409 `ACTIVE_DEVICE_EXISTS` behavior — `acquireActiveSlot` appears in zero test files; `test:agent-login` (22/22) covers the AgentAccount pipeline but NOT the conflict (report 77's claim "auth pipeline incl. ACTIVE_DEVICE_EXISTS" is inaccurate). The server behavior rests on design/audit docs (workload/70–74), which themselves state backend 409 coverage is absent.

## 16. Static bypass search — PASS

Searched the entire `desktop-agent/src` tree: `setInterval/setTimeout` (9 sites — all watchdog/HTTP/scheduler/update; none authenticate), `authenticate*`/`recoverAuth`/`recoverIfNeeded`/`retryConnect`/`startDiscoveryRetry`/`pollApproval`/`discoverDevice` (every call site traced to a guarded path), `deleteToken` (none), `KEY_TOKEN` (persist-only-on-success, delete-only-on-logout), `logout` (user-initiated). No missed path can reach `authenticate`/`discover` from a conflict. `ACTIVE_DEVICE_EXISTS` appears only in `auth-service.ts:70` (detection) and the test file — never in renderer copy or logs.

## 17. Concurrency analysis — PASS with one LOW residual

- Try Again double-click: renderer disables the button synchronously (renderer.ts:358) — second click cannot fire; IPC-level double-invoke converges (both 409 → conflict; or serialized server success → token last-write-wins, runtime idempotency guard at orchestrator:565).
- Try Again + heartbeat recovery: `recoverAuth` entry guard reads the phase; either it sees conflict (no-op) or a single extra attempt occurs — bounded, converges.
- Try Again + discovery tick: tick pre-guard or post-call chain stops on conflict; no duplicate timers.
- Restart + queued callback: queued callbacks re-validate state (recover/poll guards); boot watchdog (main.ts:252–279) cannot spawn auth.
- Conflict transition while a retry Promise resolves: both attempts are user-initiated single shots; server serializes with `FOR UPDATE`; no duplicate tokens persist (same-device replacement) and no bypass is possible (latch set on every 409).
- **Residual (LOW, matches contract §29):** two *simultaneous* `retryConnect` IPC calls (compromised renderer) each run one attempt — acceptable documented behavior; no automatic component.

## 18. Logging / observability — PASS

No logger call passes password/token/authorization/raw body: conflict events log phase names only (`orchestrator initialize/approval-poll/approval-check` with `authPhase`/`to`), heartbeat logs status + `consecutiveFailures`, boot logs presence/validity, never contents (main.ts:191–206). `redact()` (logger.ts:41–47) additionally scrubs bearer/JWT/password patterns. No raw API body is ever logged; `ApiClientError.message` for conflicts is replaced by the fixed `ACTIVE_DEVICE_CONFLICT_MESSAGE` in state, and the renderer never renders `lastError` for the conflict view.

## 19. Build / regression results (all re-run, actual)

| Check | Command | Result |
|---|---|---|
| Desktop full suite | `npm run test:src` (desktop-agent) | **158/158 PASS** (incl. 24 conflict tests) |
| Backend agent-login | `npm run test:agent-login` | **22/22 PASS** |
| Admin TypeScript | `npx tsc --noEmit` (root) | **PASS (exit 0)** |
| Admin production build | `npm run build` (root) | **PASS** |
| Desktop build | `npm run build` (desktop-agent) | **PASS** |
| Desktop typecheck | `npm run typecheck` (both tsconfigs) | **PASS** |
| ESLint (touched files) | `npx eslint` on 4 files | **PASS — 0 errors** (1 pre-existing unused-import warning in auth-service.ts, untouched by the diff; 6 config-ignore warnings for non-TS files) |
| Desktop `test` (`node --test dist/tests/`) | — | **NOT RUN** (requires a prior `npm run build` output artifact layout; `test:src` is the project's declared runner — reported transparently) |
| electron-builder packaging / live browser QA | — | **NOT RUN** (deferred per report 77) |

## 20. Remaining risks

| Risk | Severity |
|---|---|
| Backend 409 server behavior has no automated test; production behavior relies on design audits (workload/70–74) and one manual verification | MEDIUM |
| Boot-time token-revocation race leaves orchestrator `phase='running'` in conflict; collectors keep sampling locally (uploads blocked) — UI unaffected | WARNING |
| `recoverIfNeeded` conflict guard untested directly | LOW |
| Two concurrent user retries may each run one attempt (documented, converged) | LOW |
| Conflict not persisted — one boot probe per restart by design | LOW (accepted) |
| Detection couples to exact body `{error:'ACTIVE_DEVICE_EXISTS'}` — coordinated contract change required if backend evolves | LOW |

## 21. Bugs found

- **B1 (WARNING)** — `desktop-agent/src/services/agent-orchestrator.ts:618–621` (`startRuntime`): after `await this.deps.heartbeat.beat()`, the code unconditionally sets `this.phase = 'running'`. If the first beat 401s and `recoverAuth` → `recover` → 409 (token revoked server-side between `load()` and first beat), `recoverAuth`'s conflict branch (523–530) sets `phase='unregistered'`, then line 620 overwrites it to `'running'`. Repro: authenticated boot, token revoked, another device active. Expected: orchestrator stays `unregistered`/terminal. Actual: `phase='running'`; collectors keep running; auth remains terminal-conflict; UI correct; no retry loop. Fix: check `auth.getState().phase` after the beat and skip/roll back the `'running'` assignment when `active_device_conflict`.
- **B2 (INFO)** — `desktop-agent/src/main/main.ts:169–180` `rendererStateName()` maps `active_device_conflict` to `'FIRST_RUN'` in boot logs (diagnostic-only; phase names already absent from production logs; no action required).
- No CRITICAL/HIGH bugs found.

## 22. Missing functionality

- None required by the contract is absent. Deferred by design: `[ Sign Out ]` control on the conflict view (contract §16), backend admin "release device slot" feature, live-browser visual QA of the conflict view, electron-builder packaging smoke test.

## 23. Required fixes

- **R1 (recommended, not blocking):** address B1 — guard the `'running'` assignment after the boot beat.
- **R2 (recommended):** add backend tests for the 409 contract (`acquireActiveSlot` → 409 + zero-mutation assertions) so the desktop's terminal handling rests on verified server behavior.
- **R3 (optional):** add a `recoverIfNeeded`-in-conflict test and a store-level `agent.token` non-write assertion on 409.

## 24. Production readiness assessment

**READY TO SHIP for the desktop conflict-handling scope.** The implementation satisfies all 20 acceptance criteria of contract §28; the five STEP 1 findings are closed in code and by tests; security invariants (§22) and the no-mutation invariant (§23) hold. The WARNING-level items (B1, missing backend 409 tests) are recommended follow-ups, not release blockers. Full regression: 158/158 desktop, 22/22 backend agent-login, admin tsc/build, desktop tsc/build, ESLint all pass.

---

**STEP 4 STOP — Awaiting approval before implementation/fix phase.**
