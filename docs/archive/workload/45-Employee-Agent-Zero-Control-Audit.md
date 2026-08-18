# Employee Agent — Zero-Control Audit

Date: 2026-08-10
Audit chain: Phase D (42/43) → Phase E (44) → this audit (45)

---

## Verdict

| Area | Result |
|------|--------|
| Employee performs ZERO actions | ✅ PASS (UI is read-only; runtime fully automatic) |
| Admin is the only control plane | ✅ PASS (assignment/consent/device lifecycle server-side, admin-only) |
| Old UI removed from packaged EXE | ✅ PASS (root cause fixed + regression-guarded) |
| Background runtime independent of UI | ✅ PASS (main-process runtime; window is a status viewer) |
| Windows startup without interaction | ✅ PASS (autoStart default true; login-item applied at boot) |
| Consent boundary preserved | ✅ PASS (untouched; fail-closed collectors + server 403s) |
| Security (no secrets to renderer) | ✅ PASS (token/secret never crosses IPC) |
| Live verification on packaged EXE | ⚠️ NOT VERIFIED (no Windows VM in this environment; static artifact verified) |

---

## A. Old UI root cause

See `workload/44-Agent-Old-UI-Root-Cause.md`. Two defects: (1) the source renderer exposed a
visible "Connect an existing account" button revealing the legacy Employee ID/Agent Password form
plus numerous employee-facing controls; (2) the previously packaged `app.asar` was stale and
shipped an even older renderer. Both fixed; installer rebuilt.

## B. Files changed

- `desktop-agent/src/renderer/index.html` — zero-control read-only UI (no inputs, no controls).
- `desktop-agent/src/renderer/renderer.ts` — status-viewer only; removed all employee-action bindings.
- `desktop-agent/src/main/main.ts` — no tray Quit; silent 5s status push.
- `desktop-agent/src/services/agent-orchestrator.ts` — bounded auto discovery-retry.
- `desktop-agent/src/storage/local-settings.ts` — autoStart default `true`.
- `desktop-agent/src/auth/auth-service.ts` — stale comment cleanup.
- `desktop-agent/tests/zero-control-renderer.test.ts` — **new** packaged-renderer regression guard.
- `desktop-agent/tests/onboarding.test.ts`, `desktop-agent/tests/local-settings.test.ts` — updated/added tests.
- `desktop-agent/out/WorkLensAI Agent Setup 1.0.0.exe` — rebuilt.

## C. Files intentionally untouched

Legacy backend registration/auth routes, consent system, zero-touch backend, Prisma schema,
DeviceClaim/Device.agentKey, native addon, IPC/preload surface (channels remain but are
unreachable from the zero-control UI).

## D. Build/package verification

- `npm run build` → tsc renderer + tsc main + copy-assets, all clean.
- `npx electron-builder --win nsis` → installer built (unsigned, documented blocker).
- Fresh ASAR extracted and verified: `dist/renderer/index.html` md5 matches `src/`; zero legacy markers; zero-control markers present.
- New regression test `tests/zero-control-renderer.test.ts` scans `dist/` AND the ASAR; fails on any legacy string. **111/111 desktop tests pass.**

## E. Background-runtime verification

- Runtime (discovery, auth, heartbeat, config/consent sync, collectors, queues, scheduler) lives in the Electron **main process** — the renderer window is only a status viewer.
- Window close → hide to tray (existing behavior verified in `main.ts`), process keeps running.
- New: 5s silent status push → UI auto-transitions on approval/consent/assignment changes.
- New: bounded auto discovery-retry (30s → 10min cap, stops on resolution) — no employee Retry needed.
- Renderer receives zero secrets (status projection strips token/expiry; regression-tested).

## F. Windows startup verification

- `autoStart` default is now `true` (zero-control requirement — the employee cannot toggle it).
- `main.ts` applies `app.setLoginItemSettings` at every boot from the settings store.
- Duplicate-instance prevention via `app.requestSingleInstanceLock`.
- Windows Service-grade execution (boot before login, session-independent) remains **not implemented** — login-item only. Documented P2 (carried from Phase E/44).

## G. Zero-touch discovery verification

- First run: identity store generates/reuses a stable machine key (`DeviceIdentityStore`), POST `/api/agent/discover`, server derives org server-side, creates pending DeviceClaim (idempotent on restart). Backend verified by `tests/zero-touch.test.ts` (29/29) and admin `tests/zero-touch.test.ts` + consent suites (56/56 combined).
- Agent-side: `AuthService.discoverDevice` + orchestrator auto-discovery verified in `desktop-agent/tests/onboarding.test.ts` (including the new auto-retry test).
- Device name is hostname-derived from the real machine — never fabricated employee data.

## H. Admin approval verification

- Admin UI (`agent-approvals-page.tsx`) lists pending device claims from `/api/device-claims`, approves with employee + department(auto) + projects.
- Approve route: admin-only, org-scoped, transactional, one-active-device-per-employee, audit + notification. Verified in Phase D/E audits.
- Agent side: approval-poll every 20s; on approval, auto-authenticates with the device credential; UI transitions automatically via the new 5s status push. Tested in `onboarding.test.ts` ("approval detection").

## I. Employee/Department/Project assignment verification

- Assignment is server-derived: `/api/agent/config` returns employee/department/projects; `ConfigService` stores the snapshot; `getStatusForRenderer()` exposes only `{department: {name}, projects: [{name}]}`.
- Renderer displays "Syncing…" before first sync, "No department assigned" / "No projects assigned" when empty — never fabricated.
- Verified in Phase D audit and `orchestrator-dynamic-config.test.ts`.

## J. Assignment synchronization verification

- `config-refresh` scheduler task (10 min) + heartbeat path re-fetch; admin edits propagate without reinstall/restart.
- Covered by `orchestrator-dynamic-config.test.ts` (admin changes project → agent reflects new value).

## K. Rejection verification

- Reject route: admin-only, org-scoped, sets claim `rejected`, device `inactive`, unbinds employee. Verified in `zero-touch.test.ts`.
- Agent: discover/poll surfaces `rejected` → renderer shows read-only "Registration was not approved". No employee controls. No collectors run (fail-closed auth).

## L. Device revoke verification

- Revoke route: deactivates device + unbinds employee + immediately rejects bound tokens (Phase D verified).
- Agent: heartbeat 401 → `recoverAuth()` → surfaces `revoked`; collectors stop; UI shows "Device access has been disabled". Server rejects protected uploads with 403 (consent tests + zero-touch tests).

## M. Consent 8-type verification

- `tests/consent.test.ts` (27/27) covers all 8 consent types: grant → collector may run; revoke → collector stops; expired/policy-mismatch → fail closed; server upload without consent → 403; re-grant → resume.
- Agent `ConsentService` syncs every 60s + on start; collectors gated by `consent-gate` (fail-closed).
- Approval ≠ consent: approve route never writes consent records (verified in approve route + consent tests).

## N. Server-side 403 verification

- Activity/screenshot upload routes reject with 403 when consent is not granted for that type; device-bound token validity also enforced. Verified by `consent.test.ts` matrix (CONSENT-01..27) and `zero-touch.test.ts` revoke tests.

## O. Security verification

- No token/secret/claim-secret in renderer (status projection + regression test "renderer never holds secrets").
- Renderer sandbox: `contextIsolation: true`, `nodeIntegration: false`, `sandbox: true`, CSP `default-src 'none'`, `will-navigate` blocked, `setWindowOpenHandler` deny (verified in main.ts + renderer-build.test.ts).
- Discover/authenticate rate-limited server-side; IP spoof-resistant (rightmost XFF) — Phase D fix retained.
- Claim secret hashed server-side, constant-time compare (Phase D audit).
- Org isolation: org derived server-side; approve/reject/revoke admin-only + org-scoped; cross-org → 404/422 (security suite).

## P. Fresh EXE verification

- Installer rebuilt and ASAR-verified (see workload/44 §7). 
- ⚠️ **Live launch on a clean Windows machine was NOT performed in this environment** — requires `docs/clean-machine-certification.md` / `scripts/clean-machine-certification.ps1` on a VM. Mandatory before PRODUCTION READY.

## Q. Regression tests

- `tests/zero-control-renderer.test.ts` (new, 5 tests): packaged renderer HTML/JS/ASAR zero-control; required markers present; no secrets in bundle.
- `tests/onboarding.test.ts` (+1): auto discovery-retry with backoff; stops when claim resolves.
- `tests/local-settings.test.ts` (updated): autoStart default true.
- Full desktop suite: **111/111 PASS**. Backend zero-touch + consent: **56/56 PASS**. Admin `tsc --noEmit`: clean.

## R. Remaining blockers

| ID | Sev | Blocker |
|----|-----|---------|
| FB-1 | P1 | Clean-machine certification not executed (mandatory for PRODUCTION READY) |
| FB-2 | P1 | Installer unsigned (SmartScreen "unknown publisher") |
| FB-3 | P1 | PostgreSQL not adopted (SQLite schema) |
| FB-4 | P1 | Live HTTPS + backup/restore execution not verified |
| FB-5 | P2 | Windows Service-grade execution not implemented (login-item only) |
| FB-6 | P2 | Live upgrade test v1→v2 not executed |
| FB-7 | P3 | Default Electron icon; no branded asset |
