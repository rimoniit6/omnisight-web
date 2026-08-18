# 77 — Agent Active-Device Conflict: Implementation

**Status:** IMPLEMENTED (all tests green)
**Initiative:** Active-Device Conflict (Phase 7)
**Based on:** workload/76 — `STEP 2 contract` (approved)
**Scope:** Desktop Agent only (backend `409 ACTIVE_DEVICE_EXISTS` already shipped in Phases 1–2)

---

## What was implemented

### 1. `desktop-agent/src/auth/auth-service.ts`

- **`AuthPhase`** gains `'active_device_conflict'`; **`AuthErrorKind`** gains `'conflict'`.
- **Body-scoped 409 detection** — `isActiveDeviceConflict(err)` (status 409 AND body `error === 'ACTIVE_DEVICE_EXISTS'`). Any other 409, or a 409 without that exact marker, keeps the pre-existing generic classification (verified by tests).
- **Detection wired into all four authenticate paths:**
  - `authenticateDevice()` (zero-touch device credential)
  - `authenticate()` (legacy employee credential)
  - `discoverDevice()` approved branch (V2 fix — previously classified the conflict as a generic `error` and auto-retried)
  - `pollApproval()` approved branch (V4 fix — previously fell into the transient-error branch that re-forced `pending_approval` and kept polling)
- **Terminal latch** — `recover()` returns immediately while in conflict (zero API calls; verified by call-count assertions).
- **`enterActiveDeviceConflict()`** — persists exactly the transition that surfaced the 409: token/expiry nulled, claim/credentials untouched (the first device's state is never affected; verified by a retry-after-free success test over the same store). `lastError` is a fixed renderer-safe copy (`ACTIVE_DEVICE_CONFLICT_MESSAGE`), never the backend body.
- **`retryAfterConflict()`** — the ONLY way out: clears the latch (→ `expired` semantics) then performs exactly ONE deliberate attempt via `recover()`. A repeat 409 re-enters the conflict; any other outcome follows normal recover semantics. Non-conflict callers delegate to plain `recover()` (no behavior change).

### 2. `desktop-agent/src/services/agent-orchestrator.ts`

Every automatic path is conflict-aware — a conflict is terminal and never auto-retried:

- `initialize()` — expired-token branch and first-run branch: conflict → `unregistered`, no timers (the boot probe is the single deliberate attempt; per-restart, since conflict is not persisted).
- `retryConnect()` — now the "Try Again" IPC path: calls `retryAfterConflict`; conflict result stays on the conflict view with no auto-retry; rediscovered conflict handled the same.
- `startDiscoveryRetry()` — pre-tick guard includes conflict (stops the timer, zero calls) and post-call chain stops on conflict.
- `startApprovalPollingIfNeeded()` poll task — unregisters the timer on conflict (zombie-poll fix at the scheduler level).
- `checkApproval()` — conflict → stop polling, no further calls.
- `cancelRegistration()` — rediscovered conflict → never starts auto-retry.
- `recoverAuth()` — entry guard (heartbeat 401 path can never recover through a conflict) plus result-branch handling for mid-run conflicts.
- `recoverIfNeeded()` — conflict added to the no-op guard.

### 3. Renderer (`renderer.ts` + `index.html`)

- New **`conflict-view`** section: fixed copy, no dynamic error text, and a single **"Try again"** button (`btn-conflict-retry`).
- `ViewName`/`VIEW_IDS`/`ONBOARDING_LABELS`/`onboardingView()` gain the conflict view.
- `AgentApiShape` gains `retryConnect` (preload/IPC were already wired from Phase 5).
- `bindTryAgain()` — disables while in flight, renders the resulting status; never fabricates success.
- **Zero-control guard kept intact**: the button id deliberately avoids the forbidden `btn-try-again` (legacy id) — the regression suite confirms no forbidden strings in source or packaged artifacts.

## Verification

| Check | Result |
|---|---|
| `desktop-agent` new conflict suite (`tests/agent-active-device-conflict.test.ts`) | 24/24 pass |
| `desktop-agent` full suite (`npm run test:src`) | 158/158 pass |
| `desktop-agent` build + typecheck (both tsconfigs) | clean |
| Backend regression `npm run test:agent-login` (auth pipeline incl. `ACTIVE_DEVICE_EXISTS`) | 22/22 pass |
| Admin `tsc --noEmit` | clean |
| Admin `next build` | clean |
| ESLint on all touched source files | clean (repo-wide noise is pre-existing `dist/` artifacts + legacy scripts) |

## Contract coverage (workload/76 Part O items)

- Conflict detected in both credential paths + discover + poll (V1/V2/V4 fixes)
- `recover()` latch blocks all automatic recovery (heartbeat, poll, boot watchdog, discovery retry, `recoverAuth`, `recoverIfNeeded`)
- Poll timer unregistered on conflict; queued callbacks are no-ops (guard + registry removal, double-layered)
- Discovery retry stops on conflict; no ping-pong (verified by call-count assertions)
- Try Again = exactly one deliberate attempt; repeat 409 → terminal again; success resumes runtime
- Conflict not persisted — restart makes exactly one boot probe then stops
- No raw backend body crosses the renderer boundary (`getStatusForRenderer` assertion + `ACTIVE_DEVICE_EXISTS` absence check)
- `logout`/`cancelRegistration`/`cancelPending`/legacy 401/403/network behavior unchanged (regression tests)

## Explicitly not in this step (deferred per STEP 2)

- Renderer conflict-view visual QA via live browser (no gstack browse daemon session run)
- Backend admin-side "release device slot" feature (backlog)
- Packaging/electron-builder smoke test
