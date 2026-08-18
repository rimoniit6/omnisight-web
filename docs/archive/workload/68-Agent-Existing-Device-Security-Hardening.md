# Phase 3 Security Hardening — STEP 8: Existing-Device Rediscovery Implementation Report

> **Scope:** Implementation & verification of the authenticated existing-device authorization fix.
> **Date:** 2026-08-11
> **Predecessor:** `workload/67-Agent-Existing-Device-Security-Audit.md` (STEP 1, read-only).
> **Status:** ✅ Complete — 21/21 new security tests pass, backend 281/281, desktop 134/134, admin build green. **No database migration required.**

---

## 1. Root cause

The existing-device branch of `POST /api/agent/discover` resolved the Device globally by `agentKey` and then ran its claim state machine against the **Device row** (`device.organizationId`, `device.employeeId`, latest claim) without verifying that the row's organization and employee match the authenticated AgentSession's server-derived identity. A valid session from Organization A could therefore:

- read the claim/device state of a device owned by another employee or another organization,
- create fresh claims under `device.organizationId` (polluting another tenant's admin queue),
- never have its identity applied to an unassigned device (no Rule-D bind).

Session identity was only used on the **new-device** path.

## 2. Files changed

| File | Change | Diff |
|---|---|---|
| `src/app/api/agent/discover/route.ts` | MODIFIED — authenticated authorization inside the locked transaction | +78 / −21 |
| `tests/agent-existing-device-security.test.ts` | CREATED — AUTH-EXIST-01..25 (21 test cases) | new |
| `workload/67-Agent-Existing-Device-Security-Audit.md` | CREATED (STEP 1 deliverable) | new |
| `workload/68-Agent-Existing-Device-Security-Hardening.md` | CREATED (this report) | new |

**No other file changed.** Login, logout, AgentSession, AgentToken, heartbeat, activity, screenshot, config, consent, claim approve/reject/cancel/revoke, admin UI, renderer, preload, IPC — untouched.

## 3. Authorization rules implemented

Inside the existing `SELECT ... FOR UPDATE` device-row transaction, after a **fresh re-read of the locked row** (TOCTOU guard — never the stale pre-lock snapshot):

| Rule | Condition | Action |
|---|---|---|
| C | `device.organizationId !== session.organizationId` | throw sentinel → uniform **404** `{ error: 'Device not found' }` |
| B | same org, `device.employeeId !== null && device.employeeId !== session.employeeId` | throw sentinel → uniform **404**, never reassign |
| Revoked | latest claim `revoked` (before the bind) | return terminal `revoked` — **never rebound** even though revoke unassigns the device |
| D | same org, `device.employeeId === null` | transactional `device.employeeId = session.employeeId` inside the row lock |
| A | org + employee match | existing state machine continues unchanged |
| E | no valid session | anonymous zero-touch block skipped entirely — legacy flow byte-for-byte |

The request body remains destructured to `deviceKey, hostname, os, osVersion, processor, memory, agentVersion, arch, reRegister` only — `employeeId`, `organizationId`, `userId`, `agentId`, `deviceOwnerId` are **not read at all** (they never were; now guaranteed irrelevant by tests).

## 4. Flow before the fix

```
login → session → discover(key)
  → validateAgentSession ✓
  → device = findFirst(agentKey)          ← GLOBAL, un-scoped
  → existing-device txn:
      FOR UPDATE device
      latest claim → approved/pending/revoked/rejected/fresh
      fresh claim: organizationId = device.organizationId   ← row is authority
  → response leaks deviceId/claimId/status to ANY session holding the key
```

## 5. Flow after the fix

```
login → session → discover(key)
  → validateAgentSession ✓ (employee + org server-derived, live-revalidated)
  → device = findFirst(agentKey)
  → existing-device txn:
      FOR UPDATE device
      locked = re-read device            ← authoritative row under lock
      if authenticated:
        org mismatch            → 404    ← rule C
        employee mismatch       → 404    ← rule B
        latest revoked          → revoked (terminal, no bind)
        employeeId null         → bind to session.employeeId  ← rule D
      latest claim state machine (unchanged) — fresh claims use locked.organizationId
  → responses reflect the locked/bound row
```

## 6. Behavior matrix

| Scenario | Result | Evidence |
|---|---|---|
| Same employee, own device | PASS — idempotent pending/approved reconnect | AUTH-EXIST-01/11 |
| Same org, different employee | **404**, no rebind, no disclosure | AUTH-EXIST-02/16 |
| Different organization | **404**, no claim created, all claims stay in device org | AUTH-EXIST-03/15 |
| Forged `employeeId` in body | ignored — session identity wins | AUTH-EXIST-04 |
| Forged `organizationId` in body | ignored — device stays in session org | AUTH-EXIST-05/24 |
| Revoked device | terminal `revoked`, never rebound, no fresh claim | AUTH-EXIST-06 |
| Disabled employee | session invalid; login 401; ownership untouched | AUTH-EXIST-07 |
| Unassigned device (own org) | bound to session employee transactionally | AUTH-EXIST-08 |
| Anonymous zero-touch | 201 + pending + secret; device stays unassigned until admin approval | AUTH-EXIST-09/10 |
| Rejected claim | stays rejected on poll; explicit reRegister → fresh claim | AUTH-EXIST-12 |
| Cancelled claim | cancel → fresh claim; employee re-bound | AUTH-EXIST-13 |
| Expired claim | closed to `expired`, fresh claim issued | AUTH-EXIST-14 |
| Concurrent rediscovery | one owner / one 404; single pending claim; no conflicting ownership | AUTH-EXIST-17a/17b |
| Denied responses | uniform `{ error: 'Device not found' }` — zero ids/status/names/secret | AUTH-EXIST-18..23 |
| Invalid/expired session | cannot authorize; no bind of unassigned device | AUTH-EXIST-25 |

## 7. Concurrency protection

- Authorization executes **inside** the existing device-row `FOR UPDATE` transaction; the row is re-read after lock acquisition so a stale pre-lock snapshot can never authorize (or bind) incorrectly.
- Two racing authenticated requests for the same unassigned device serialize on the row lock: the loser re-reads the winner's binding and returns 404 (AUTH-EXIST-17b — exercised with real PostgreSQL concurrency).
- Two racing requests from the same employee both see the same single pending claim — no duplicate pending claims (AUTH-EXIST-17a).
- The `FOR UPDATE` guarantee is preserved; nothing was removed or weakened.

## 8. Security verification (STEP 7 scan)

Pattern scan over `discover/route.ts` + `session.ts` + the diff:

| Check | Result |
|---|---|
| Client-controlled `organizationId` | ✅ absent — body never read (tests: EX-05/24) |
| Client-controlled `employeeId` | ✅ absent — body never read (tests: EX-04/24) |
| Cross-org claim creation | ✅ impossible — authz precedes any claim write (tests: EX-03/15) |
| Cross-employee rebind | ✅ impossible — authz precedes any bind (tests: EX-02/16) |
| Password logging | ✅ none in flow |
| Token logging | ✅ raw tokens never logged (session.ts documented invariant) |
| Secret logging | ✅ claim secret only ever returned to the owning agent; never logged |
| Unsafe error responses | ✅ uniform 404 with a fixed body for every denial |
| PII leakage on denial | ✅ zero — AUTH-EXIST-18..23 asserts absence of ids/status/names |
| Session identity server-derived | ✅ `validateAgentSession` output only; body fields ignored |

## 9. Test results

| Suite | Before | After | Result |
|---|---|---|---|
| New `tests/agent-existing-device-security.test.ts` | — | **21/21 PASS** | ✅ |
| Backend full (`npx tsx --test tests/*.test.ts`) | 260/260 | **281/281 PASS** | ✅ |
| Desktop (`npm run test:src`) | 134/134 | **134/134 PASS** | ✅ |
| Admin TypeScript (`npx tsc --noEmit`) | PASS | **PASS** | ✅ |
| Admin production build (`npx next build`) | — | **PASS** | ✅ |
| PostgreSQL (throwaway `workai_test_agexist` + `workai_test_agentauth`) | — | **PASS** | ✅ |

The 21 new test cases cover the full AUTH-EXIST-01..25 matrix (EX-18..23 grouped into one case, EX-17 split into 17a/17b).

## 10. Database

**No Prisma migration required** — verified: `git diff prisma` is empty; the fix is purely application-level authorization using existing `Device.employeeId` / `Device.organizationId` and `AgentSession.employeeId` / `AgentSession.organizationId` columns.

## 11. Residual risks / notes

1. **Enumeration distinguishability (accepted):** with a valid session, an unknown `deviceKey` creates a device (201) while an existing key owned elsewhere returns 404 — a probing agent holding a valid session can distinguish "new key" from "existing key in another tenant/employee" by status code, but gains **no row content**. This is the concealment trade-off mandated by the prompt's 404 requirement.
2. **Legacy PATH B** (`/api/agent/authenticate` + `Employee.agentPassword`): pre-existing, unrelated, unchanged.
3. **Approved + inactive device reconnect:** a device deactivated by the one-active-device rule (replaced by a newer approval) still returns `approved` from discover; its AgentTokens fail closed at `validateAgentToken` (device status check). Pre-existing lifecycle behavior, unchanged by this fix.
4. **Desktop UX on denial:** an authenticated discover 404 (e.g. reused laptop still bound to a departed employee) surfaces as a discover/login error in the agent UI — intended fail-closed; the admin must revoke/unbind the old device before the new employee can register it.
5. **Rate limiter** is in-memory per-process (pre-existing, documented) — unchanged.

## 12. Final acceptance checklist

- [x] Authenticated AgentSession is authoritative
- [x] `organizationId` cannot be overridden by client input
- [x] `employeeId` cannot be overridden by client input
- [x] Cross-org existing-device rediscovery blocked (404)
- [x] Same-org wrong-employee rediscovery blocked (404)
- [x] Same-org unassigned device safely assigned (transactional)
- [x] Own-device reconnect works
- [x] Approved device reconnect works
- [x] Rejected/cancelled/expired claim behavior preserved
- [x] Anonymous zero-touch preserved (device unassigned until admin approval)
- [x] No PII leakage on denied requests
- [x] No password/token/secret leakage
- [x] Concurrency tests pass (real PostgreSQL)
- [x] Backend 281/281
- [x] Desktop 134/134
- [x] Admin tsc PASS
- [x] Admin build PASS
- [x] PostgreSQL verification PASS
- [x] No migration created

---

*STEP 9 — final verdict below. Stopping after this security-hardening phase; Phase 4 not started.*
