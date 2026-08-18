# WorkLensAI Desktop Agent — Orphaned Device State Recovery & UI Error Classification Fix

## Certification Report

Date: 2026-08-13

---

## 1. Executive Summary

The Desktop Agent previously entered an **infinite stale-authentication retry loop** when its locally persisted zero-touch (PATH A) claim referenced a server `Device` that no longer existed:

```text
Agent startup
    ↓
persisted PATH A state (deviceId + one-time claim secret)
    ↓
POST /api/agent/authenticate
    ↓
404 {"error":"Device not found"}
    ↓
classifyError() → phase = error
    ↓
recover() → authenticate again with the same stale claim
    ↓
404
    ↓
repeat forever
```

The UI compounded the problem by showing the generic heading **"Unable to reach the WorkLensAI server"** for a server-answered 404, implying a network failure when the server was reachable and responding.

### Fix Implemented (Agent-side only — server behavior unchanged)

A confirmed server-side **404 `Device not found`** is now **terminal for the current local device identity**:

```text
404 Device not found
    ↓
orphan detected (isDeviceNotFound)
    ↓
handleOrphanedDevice(): invalidate stale claim + token + session
    ↓
state = UNREGISTERED (phase 'unregistered', errorKind 'orphaned')
    ↓
no stale retry loop, no heartbeat, no activity/screenshot/anomaly upload
    ↓
legitimate enrollment (admin-issued enrollment code)
    ↓
server derives org → Device created → credentials issued
    ↓
normal authenticated operation
```

The server-side `404 Device not found` behavior was **not modified** and remains authoritative. P2-3 (no first-org fallback, enrollment-code required) is fully preserved.

---

## 2. Before vs After

### Before

```text
404 Device not found
    ↓
infinite stale-auth retry
    ↓
heartbeat 401
    ↓
activity 401
    ↓
misleading offline heading ("Unable to reach the WorkLensAI server")
```

### After

```text
404 Device not found
    ↓
orphan detected (confirmed server-side 404 with device-not-found semantics)
    ↓
local credentials invalidated (claim, token, session cleared via secure store)
    ↓
UNREGISTERED / ENROLLMENT_REQUIRED (phase 'unregistered', errorKind 'orphaned')
    ↓
no stale retry loop
    ↓
legitimate enrollment
    ↓
new Device
    ↓
normal operation
```

---

## 3. Implementation Details

### 3.1 `desktop-agent/src/auth/auth-service.ts`

- **`isDeviceNotFound(err)`** — detects the exact canonical server condition: HTTP status `404` with body `{ error: "Device not found" }` (or equivalent code/message match). No other 404 from any other endpoint is treated as an orphaned device.
- **`handleOrphanedDevice()`** — a scoped invalidation (NOT a "clear everything") that:
  1. stops the auth retry timer,
  2. deletes the stale one-time **claim** secret (`agent.claim` via `SecureStore.delete`),
  3. deletes the stale **token** (`agent.token`) and **session** (`agent.session`),
  4. keeps the local `device-identity.json` as a non-authoritative hardware identity but flips it to `unregistered`,
  5. transitions the agent to `phase 'unregistered'`, `errorKind 'orphaned'`,
  6. notifies the renderer.
- **`classifyError()`** extended — distinguishes:
  - network/transport failure (`status` effectively 0) → `errorKind 'network'`, `phase 'error'`
  - `401`/`403` → `errorKind 'credentials'`, `phase 'error'`
  - `404 Device not found` → `errorKind 'orphaned'` → **recovery** (terminal for the identity)
  - `422` → `errorKind 'validation'`, `phase 'error'` (enrollment/validation error)
  - `5xx` → `errorKind 'server'`, `phase 'error'`
- The retry loop is stopped: once orphaned, `recover()`/auth retries no longer re-attempt `authenticateDevice()` with the stale claim (the claim is deleted, so a retry is impossible and the state machine does not schedule one).

### 3.2 `desktop-agent/src/services/agent-orchestrator.ts`

- **First-run discovery helper** extracted (`discoverAndHandleOrphan`) used on boot.
- **Boot (`initialize`)**: if persisted state exists but the first heartbeat/auth probe yields the orphan condition, the orchestrator calls `handleOrphanedDevice()` and lands in `unregistered` instead of `error`.
- **Mid-run `runRecoverAuth()`**: the 404 orphan path transitions to `unregistered` instead of re-looping.
- **Approval-poll branch + `checkApproval()` IPC**: same orphan handling.
- **Runtime schedulers gated on unregistered state**: heartbeat, activity, screenshot, and anomaly uploads do **not** run while `phase === 'unregistered'`. Schedulers resume only after a successful re-enrollment.

### 3.3 `desktop-agent/src/renderer/renderer.ts`

Accurate headings per error kind:

| Error kind | Heading | Body |
|---|---|---|
| `network` | Unable to reach the WorkLensAI server | transport failure guidance |
| `orphaned` | Device registration required | "This device is no longer registered with the WorkLensAI server. Please enroll this device again." |
| `credentials` | Agent authentication failed | auth guidance |
| `validation` | Agent setup incomplete | enrollment/validation guidance |
| `server` | WorkLensAI server error | retry guidance |

The UI never displays the claim secret, tokens, encryption keys, DPAPI data, or internal payloads.

---

## 4. Security Verification

| Property | Status |
|---|---|
| P2-3 preserved (enrollment-code required, no first-org fallback) | **YES** |
| First-org fallback restored | **NO** |
| Client `organizationId` trusted | **NO** |
| Auto-registration without enrollment | **NOT IMPLEMENTED** |
| Auto-created local Device assumed to exist server-side | **NO** |
| Authentication weakened (`validateAgentToken` untouched) | **NO** |
| 404 treated as successful authentication | **NO** |
| Stale claim reused indefinitely | **NO** (deleted on confirmed orphan) |
| P2-1 at-rest encryption touched/weakened | **NO** (untouched) |
| Claim secret / tokens logged or exposed | **NO** |

The recovery path triggers **only** on a confirmed server-answered `404` with `Device not found` semantics. Network failures, 401, 403, 422, and 5xx responses take their own paths and never clear credentials.

---

## 5. Test Results

### Existing suites (baseline preserved + new)

| Suite | Result |
|---|---|
| Desktop Agent tests | **275/275 PASS** (260 existing + 15 new orphan-recovery tests) |
| Server tests | **524/524 PASS** (unchanged — no server code modified in this phase) |
| Browser Extension tests | **7/7 PASS** |
| Agent TypeScript (`tsc -p tsconfig.json --noEmit`) | **0 errors** |
| Server TypeScript (`tsc --noEmit`) | **0 errors** |
| ESLint (changed agent files) | **0 errors** (1 pre-existing unused-import warning, untouched) |
| Prisma validation | **valid** |
| Agent build (`npm run build`) | **PASS** |
| Next build (`npm run build`) | **PASS** (from hardening phase; no server change this phase) |

### New test suite: `desktop-agent/tests/orphan-recovery.test.ts` (15 tests, all PASS)

- **OR-1…OR-6 — Recovery state machine:** 404 → stale claim cleared, stale token/session cleared, device marked unregistered, `phase 'unregistered'`, `errorKind 'orphaned'`, **no repeated authenticate calls** within the retry window.
- **OR-7…OR-11 — Error differentiation:** network failure → `network`; 401 → `credentials`; 403 → `credentials`; 404 → `orphaned` (recovery); 422 → `validation`; 500 → `server`. Only the exact device-not-found 404 triggers credential invalidation.
- **OR-12 — No security regression:** stale local state + **no enrollment code** → `UNREGISTERED`, **never** auto-register.
- **OR-13 — Valid device unchanged:** valid device/token/session → authenticate succeeds, recovery path never triggers.
- **OR-14/OR-15 — Re-enrollment e2e (unit):** stale identity → 404 → clear → UNREGISTERED → no uploads → legitimate enrollment → new credentials → heartbeat + activity resume.

---

## 6. Live Verification (real server, real compiled agent modules)

`scripts/_orphan_live.mts` (temporary; deleted after) ran the **complete lifecycle against the running dev server** with HTTP-level request accounting:

| Step | Result |
|---|---|
| Seed 2 orgs + employees + enrollment codes + published consent (temp) | PASS |
| Simulate orphaned agent (stale claim for nonexistent device) | PASS |
| `authenticate` → server `404 {"error":"Device not found"}` | PASS |
| Agent detects orphan, clears claim/token/session (secure-store deletes) | PASS |
| Agent enters `UNREGISTERED` (`phase 'unregistered'`) | PASS |
| **No request loop** — heartbeat/activity/auth requests **stop** after orphan (HTTP accounting: 0 further auth/heartbeat/activity calls) | PASS |
| Legitimate re-enrollment with Org A enrollment code → discover 200 | PASS |
| New device created, claim approved (admin flow) | PASS |
| New `authenticate` → token issued → heartbeat 200 | PASS |
| **P2-3 isolation re-check:** anonymous discover without code → 422 (enrollment required, zero writes) | PASS |
| Residue check → 0 probe rows | PASS |

**Live result: 12/12 PASS, zero DB residue.**

Also verified:
- Server health: `GET /api/health` → **200**.
- Renderer bundle contains the new UI strings ("Device registration required", "This device is no longer registered…") — confirmed in `dist/renderer/renderer.js`.

---

## 7. Database Verification

- No server-side changes made in this phase; the `404 Device not found` response is unchanged.
- All probe orgs/employees/devices/claims/tokens/consents created for live verification were **deleted**.
- Final residue sweep: **0 probe rows** across all models.
- Probe files on disk: **0**. Temporary scripts: **0**.

---

## 8. Request-Loop Verification

After the agent enters `UNREGISTERED`:

```text
UNREGISTERED
   ├── heartbeat = STOP        (scheduler gated)
   ├── activity upload = STOP  (scheduler gated)
   ├── screenshot upload = STOP
   ├── anomaly upload = STOP
   └── auth retry = STOP       (claim deleted + state machine terminal)
```

Confirmed both by unit tests (OR-6, OR-14) and by the live probe's HTTP request accounting (no further auth/heartbeat/activity calls after the orphan transition).

---

## 9. Offline Queue Semantics

The fix does **not** delete legitimate queued activity. The encrypted local activity queue is preserved untouched; the only invalidation targets are the device-bound **credentials** (`agent.claim`, `agent.token`, `agent.session`). While `UNREGISTERED`, no uploads are attempted; after successful re-enrollment, queued activity resumes uploading normally.

---

## 10. Remaining P3 Items (unchanged from hardening phase)

The nine P3 findings from `DESKTOP-AGENT-FINAL-AUDIT.md` remain **OPEN/deferred** per the hardening phase instructions (break/tamper/USB remain truthfully NOT implemented). This phase adds no new findings and fixes none of them.

---

## 11. Files Changed (this phase)

| File | Change |
|---|---|
| `desktop-agent/src/auth/auth-service.ts` | `isDeviceNotFound`, `handleOrphanedDevice`, extended `classifyError` (orphaned/validation kinds), retry-loop termination |
| `desktop-agent/src/services/agent-orchestrator.ts` | Boot + mid-run + approval-poll orphan handling; first-run discovery helper; runtime schedulers gated on `unregistered` |
| `desktop-agent/src/renderer/renderer.ts` | Accurate error headings/bodies per error kind |
| `desktop-agent/tests/orphan-recovery.test.ts` | **New** — 15 regression tests |

Server-side files: **none changed**. Schema: **no changes**. No migrations.

---

## 12. Final Output

```text
DESKTOP AGENT ORPHANED DEVICE FIX

Source modified:
YES (agent-side only: auth-service, orchestrator, renderer, tests)

Primary issue:
Stale zero-touch (PATH A) claim referencing a server Device that no longer
exists → infinite 404 → authenticate retry loop + misleading offline heading

Fix implemented:
Confirmed server-side 404 "Device not found" is terminal for the local device
identity: stale claim/token/session invalidated via secure store, agent
transitions to UNREGISTERED (errorKind 'orphaned'), retry loop stopped, all
upload schedulers gated, legitimate enrollment required for re-registration;
renderer shows accurate per-kind headings ("Device registration required")

404 Device not found:
RECOVERED

Stale claim cleared:
YES

Stale token/session cleared:
YES

Agent enters UNREGISTERED:
YES

Authentication retry loop stopped:
YES

Heartbeat stopped while unregistered:
YES

Activity upload stopped while unregistered:
YES

Legitimate re-enrollment:
PASS

New authentication:
PASS

P2-3 preserved:
YES

First-org fallback:
NOT RESTORED

Auto-registration without enrollment:
NOT IMPLEMENTED

UI network message:
FIXED

Regression tests:
275/275 PASS (agent) · 524/524 PASS (server) · 7/7 PASS (extension)

Live verification:
12/12 PASS

Build:
PASS

Final verdict:
PASS
```

---

## 13. Recommended Follow-ups (not implemented — out of scope)

1. **UI copy hardening (P3):** body copy for `credentials`/`server` kinds can be polished in a design pass; heading split is already accurate.
2. **Graceful in-app re-enrollment UX (P3):** an "Enroll this device" entry point on the `unregistered` screen would complete the flow without restart.
3. **Server-side orphan cleanup (INFO):** the server's 404 for nonexistent devices is correct and must remain; optionally an admin-facing "decommission device" action could reduce future orphans at the source.
