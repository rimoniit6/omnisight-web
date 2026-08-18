# 79 — Agent Active-Device Conflict: STEP 5 Final Fix

**Date:** 2026-08-11
**Mode:** IMPLEMENTATION + VERIFICATION (STEP 5 of workload/76)
**Inputs:** workload/76 (contract), workload/77 (implementation report), workload/78 (STEP 4 integration audit — APPROVE WITH NOTES), actual current source

---

## 1. Executive Verdict

**PASS — the final fix is complete and verified.** The STEP 4 audit observation (a) — a boot-time token-revocation race where the orchestrator's `startRuntime()` unconditionally overwrote a fresh `active_device_conflict` with `phase='running'` — is fixed, regression-tested, and covered by a new 12-test backend suite proving the HTTP 409 contract (`{error:'ACTIVE_DEVICE_EXISTS'}`) end-to-end against a real throwaway PostgreSQL database. The new suite caught TWO real server-side defects that were fixed:

1. `POST /api/agent/authenticate` PATH A did `return authenticateDevice(...)` (no `await`) — the 409 rejection escaped the route's try/catch, so a PATH A conflict would have surfaced as HTTP 500 instead of the documented 409. Fixed to `return await`.
2. The test's own `adminToken()` helper passed an un-awaited Promise into `req()` (Bearer `[object Promise]`) — fixed in the suite.

All suites green: desktop 162/162 (158 + 4 B1 regression tests), backend agent-login 22/22, new backend active-device suite 12/12. Admin `tsc --noEmit` + `next build` clean; desktop typecheck (both configs) + ESLint clean (one pre-existing warning, unchanged from STEP 4). No schema migration was added or required. Packaging not run (no dependency changes).

## 2. Scope

STEP 5 of workload/76: implement + verify the final fix for the boot-time conflict overwrite, add automated backend coverage for the 409 contract, run full regression + security scans, produce this report.

- **TASK 1** — B1 boot-time fix in `desktop-agent/src/services/agent-orchestrator.ts`
- **TASK 2/3** — backend automated test suite `tests/agent-active-device-backend.test.ts` (B-01…B-10 + 2 HTTP contract tests)
- **TASK 4/5/6** — B1 regression, successful-startup regression, terminality regression
- **TASK 7** — static security regression searches
- **TASK 8/9** — build + full regression, migration check
- **TASK 10** — final report (this file)

## 3. STOP conditions evaluated — none triggered

| Condition | Status |
|---|---|
| Schema migration needed | NOT TRIGGERED — no migration added; `db push --force-reset` in tests uses throwaway DBs only |
| Two active devices created by the fix | NOT TRIGGERED — the fix only prevents overwriting `active_device_conflict`; no new activation paths |
| New auth mechanism / credential path | NOT TRIGGERED |
| New server URL / connection controls | NOT TRIGGERED |
| Contract deviation | NOT TRIGGERED — 409 body verified exactly `{error:'ACTIVE_DEVICE_EXISTS'}` |
| Security weakening (auto-retry, token clearing, etc.) | NOT TRIGGERED — see §9 |

## 4. STEP 1 — inspection findings (reported before any code change)

Confirmed the B1 root cause at `desktop-agent/src/services/agent-orchestrator.ts` (~lines 618–621, unchanged from the STEP 4 audit):

- `startRuntime()` ran `await heartbeat.beat()` then unconditionally set `this.phase = 'running'`.
- On boot, a revoked/expired token → the first beat gets 401 → `onAuthError` → `recoverAuth()` → `recover()` → the new-device `authenticateDevice()` probe surfaces the 409 → auth enters `active_device_conflict` — then `startRuntime()` **overwrote** the terminal phase with `'running'`.
- The renderer therefore never saw the conflict at boot; UI showed running while the agent held a dead token. Server-side behavior was already correct (no kick, no mutation).

Also confirmed before changes: backend 409 mapping exists (`src/app/api/agent/authenticate/route.ts:229–231`), `acquireActiveSlot` throws `ActiveDeviceConflictError` inside the transaction (`src/lib/agent/activation.ts:190`), and the route's try/catch maps it. Desktop test conventions from `agent-active-device-conflict.test.ts` + backend conventions from `agent-auth-login.test.ts` were used.

## 5. STEP 2 — the fix (TASK 1)

**File:** `desktop-agent/src/services/agent-orchestrator.ts` — `startRuntime()`, after the boot heartbeat:

```ts
if (this.deps.auth.getState().phase === 'active_device_conflict') {
  this.phase = 'unregistered';
  return;
}
```

- The boot probe is still a single deliberate `authenticateDevice()` (the 401 → recoverAuth path); the guard now prevents `'running'` from overwriting the conflict.
- `phase='unregistered'` is the pre-existing terminal mapping the orchestrator uses for conflict mid-run (consistent semantics — renderer receives `auth.phase === 'active_device_conflict'`).
- No retry path added: no discovery-retry, no approval-poll, no automatic re-authentication. The only exit remains the employee's explicit "Try Again" (`retryAfterConflict`).
- No token/credential deletion or replacement; the stored token is untouched by the 409 (asserted by tests).
- Collectors/timers remain registered post-conflict, consistent with accepted mid-run conflict semantics (upload paths are already 401-safe fail-closed).

Smallest safe change: one guard branch; no server-side device changes (the 409 already had zero mutation).

## 6. STEP 3 — B1 desktop regression tests (TASK 4)

**File:** `desktop-agent/tests/agent-active-device-conflict.test.ts` (now 28 tests; 4 added in STEP 3, existing 24 unchanged).

- Extended `buildOrchestrator` with an overrides parameter (inject `heartbeat`).
- New helpers: `seedAuthenticatedStore()` (seeds a valid token + claim + creds), `heartbeatRejecting401(onAuthError)` (real `HeartbeatService` + fake `HeartbeatApi` that rejects the beat with a 401 `ApiClientError`; wired to `orchestrator.recoverAuth()` via the override).

New tests:

1. **B1 boot conflict never reaches `running`** — after `initialize()` with a rejecting heartbeat: auth phase = `active_device_conflict`, orchestrator phase = `unregistered`, exactly `callsBeforeBoot + 1` authenticate probes (the boot probe only — no automatic retry), no discovery-retry / approval-poll timers.
2. **Renderer still receives the conflict; stored token untouched** — `getStatusForRenderer().auth.phase === 'active_device_conflict'`, raw marker never serialized to the renderer, `store.get('agent.token')` identical before/after.
3. **Subsequent heartbeats never re-authenticate in conflict** — `scheduler.runNow('heartbeat')` twice → zero new `authenticateDevice`/`discover`/`authenticate` calls; state stays `active_device_conflict`.
4. **Successful startup still reaches `running`** — healthy heartbeat → phase `running` (regression guard, TASK 5).

## 7. STEP 4 — targeted desktop run (TASK 4/5/6)

`npx tsx --test tests/agent-active-device-conflict.test.ts` → **28/28 PASS** (was 24/24 pre-STEP-3).

## 8. STEP 5/6 — backend suite + targeted run (TASK 2/3)

**New file:** `tests/agent-active-device-backend.test.ts` — 12 tests against a throwaway PostgreSQL DB (`workai_test_agentconflict`; `scripts/pg-test-db.mjs ensure/drop` + `prisma db push --force-reset`; `JWT_SECRET` isolated per suite; per-test unique client IPs to avoid the per-IP brute-force limiter).

| Test | Verifies |
|---|---|
| B-01 | second eligible device → 409 `ACTIVE_DEVICE_EXISTS`; first device token/status/lastHeartbeat untouched; B gets no token |
| B-02 | 409 is zero-mutation: exhaustive snapshot of tokens/devices/claims/employee/audit-count identical before/after |
| B-03 | two concurrent PATH A auths → exactly one 200 + one 409; exactly one valid token, held by the winner |
| B-04 | same-device re-login replaces ONLY its own token row (old row deleted, fresh token); other device untouched |
| B-05 | expired token never blocks another eligible device (200) |
| B-06 | revoked device and deleted device (orphan token) never produce a false 409 (200 both) |
| B-07 | wrong PATH B password stays uniform 401, no token, no device row |
| B-08 | disabled AgentAccount fails closed 403 'Agent account is disabled', never 409 |
| B-09 | inactive employee / suspended org / inactive device all fail closed 403, never 409 |
| B-10 | B's failed 409 attempt cannot mutate A's token row in any field; A's token still passes a real heartbeat (200) |
| HTTP-1 | body is EXACTLY `{error:'ACTIVE_DEVICE_EXISTS'}` (no extra keys) |
| HTTP-2 | an unrelated 409 (claim cancel) carries no `ACTIVE_DEVICE_EXISTS` marker |

Seeding uses the REAL pipeline (discover → approve → authenticate) for the slot-holding device, and direct DB for the second eligible device (the approve route deactivates an employee's other active devices, so it cannot produce a two-eligible-devices state by itself).

**Run:** `npx tsx --test tests/agent-active-device-backend.test.ts` → **12/12 PASS**.

### Defects the suite caught (and fixes applied)

1. **Server bug (real, production-impacting):** PATH A conflict escaped the route's catch because of a missing `await` — `return authenticateDevice(...)` at `src/app/api/agent/authenticate/route.ts:36`. A second-device PATH A authentication would have returned HTTP 500 instead of the documented 409. Fixed to `return await authenticateDevice(...)` (one-line, no behavior change beyond restoring the contract). Note retained in a comment to prevent regression.
2. **Suite bug:** `adminToken()` returned the un-awaited `signJWT()` Promise; `req()` stringified it as `Bearer [object Promise]` → every admin action 401'd. Fixed by awaiting at the call site (matches the `agent-auth-login.test.ts` convention).

## 9. STEP 7 — full regression

| Suite | Result |
|---|---|
| Desktop `npm run test:src` (all 22 test files) | **162/162** (158 pre-STEP-3 + 4 B1 tests) |
| Backend `npm run test:agent-login` | **22/22** |
| Backend new active-device suite | **12/12** |

## 10. STEP 8 — static security regression searches (TASK 7)

Searched the desktop codebase for: `ACTIVE_DEVICE_EXISTS`, `authenticate(`, `recoverAuth(`, `recoverIfNeeded(`, `retryConnect`, `deleteToken`, `KEY_TOKEN`, `revoke`, `logout`, `AgentToken.create/delete/deleteMany`.

- `ACTIVE_DEVICE_EXISTS` appears only in `auth-service.ts` (predicate, line 70) + explanatory comments — no new usage.
- `recoverAuth`/`recoverIfNeeded`/`retryConnect` call sites unchanged from STEP 4 audit (no new automatic callers; the new heartbeat path only exists in tests).
- No new `store.delete` of `KEY_TOKEN`, no `logout`/`revoke`/`AgentToken` mutation introduced by the fix. The fix adds exactly one guard branch; everything else is test-only.
- No new network calls, no new credential flows, no weakening of the terminal-conflict latch.

## 11. STEP 9 — build + typecheck (TASK 8)

| Check | Result |
|---|---|
| Admin `npx tsc --noEmit` | PASS (1 suite type error fixed) |
| Admin `npm run build` (next build, Turbopack) | PASS — compiled successfully (pre-existing Edge-runtime warnings only) |
| Desktop `npm run typecheck` (both tsconfigs) | PASS |
| Desktop ESLint on touched files (orchestrator, auth-service, conflict tests) | PASS — 0 errors; 1 pre-existing `DiscoverResponse` unused warning (unchanged from STEP 4) |

## 12. Migration check (TASK 9)

No schema changes in this STEP; no `prisma/migrations` additions. Test DBs are throwaway (`workai_test_agentconflict`, `workai_test_*` debug DBs removed after use; debug test files `zz-debug*.test.ts` deleted).

## 13. Packaging (TASK 10 — NOT RUN)

Not run: no dependency, build-script, or packaging changes were made this STEP. `npm --prefix desktop-agent run package` results (from STEP 4 audit) remain valid.

## 14. Files changed this STEP

| File | Change |
|---|---|
| `desktop-agent/src/services/agent-orchestrator.ts` | B1 fix: post-beat conflict guard in `startRuntime()` |
| `desktop-agent/tests/agent-active-device-conflict.test.ts` | +4 B1 regression tests; `buildOrchestrator` overrides; helpers |
| `src/app/api/agent/authenticate/route.ts` | PATH A `return await authenticateDevice(...)` (409 contract fix) |
| `tests/agent-active-device-backend.test.ts` | NEW — 12 backend tests (B-01…B-10 + 2 HTTP) |
| `tests/zz-debug*.test.ts` | temp debug files — deleted |

## 15. Workflow state

- Todos: STEP 1–9 complete, STEP 10 (this report) complete.
- Prior workflow docs: workload/67–78 unchanged; this report supersedes the STEP 4 "NOTES" items (a)/(b)/(c) — the boot race, backend coverage gap, and recoverIfNeeded/store assertions are all now covered by tests.

## FINAL STATUS

**PASS — all STEP 5 tasks complete. Desktop 162/162, backend 22/22 + 12/12, builds/typechecks clean, security scans clean, no migration. One production-impacting server defect found by the new tests and fixed (`return await` on PATH A).**
