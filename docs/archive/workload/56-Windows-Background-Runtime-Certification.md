# Windows Background Runtime Certification

Date: 2026-08-10 · Phase G

## Verdict

| Item | Status |
|---|---|
| Runtime lives in the Electron main process (not renderer) | ✅ PASS (code-verified, Phase E) |
| UI is a passive status viewer only | ✅ PASS (zero-control renderer, regression-guarded) |
| Window close → hide, process continues | ✅ PASS (`main.ts` `close` → `preventDefault` + `hide`) |
| Login-item auto-start (default on) | ✅ PASS (code + tests) |
| Single-instance lock (no duplicate process) | ✅ PASS (`app.requestSingleInstanceLock`) |
| Silent 5s status push (no restart needed) | ✅ PASS (Phase E) |
| Bounded auto discovery-retry (offline self-heal) | ✅ PASS (Phase E test) |
| Windows Service-grade execution (before login) | ⚠️ **NOT REQUIRED for current product** (documented decision) |
| Reboot/logout login runtime continuity | ⚠️ **NOT VERIFIED live** (needs clean machine, B-02) |

---

## 1. Architecture decision: Windows Service vs session runtime

**Decision: keep the session (login-item) runtime. Do NOT introduce a Windows Service.**

Rationale (per Phase G Part 7 rules — "Do NOT automatically introduce a Windows Service if the
current architecture already satisfies the product requirement"):

1. **The product is a per-user-session monitoring agent.** It monitors the signed-in employee's
   desktop (activity, screenshots with consent). There is nothing meaningful to monitor before a
   user session exists — a pre-login service would run with no user context.
2. **All mandatory runtime functions are main-process** (discovery, auth, heartbeat, config/
   consent sync, collectors, queues, scheduler) and verified independent of the window.
3. **The employee's requirement is zero interaction**, satisfied: auto-start on login, window
   hidden by default to tray, runtime continues when the window closes.
4. A Windows Service would duplicate the runtime or require split-process orchestration,
   violating "do not move renderer logic into the service / do not duplicate the agent runtime".
5. **Documented residual gap:** between logout and the next login the agent is not running. This
   is acceptable for the current product (no data is expected during that window; the offline
   queue + backoff handle the resume). If a future requirement mandates 24/7 pre-login presence,
   a service wrapper (electron-windows-service or node-windows) around the **same** main-process
   runtime is the migration path — UI stays a separate viewer.

## 2. Verified runtime continuity mechanisms

| Mechanism | Evidence |
|---|---|
| `window-all-closed` → keep running (tray) | `main.ts` |
| Window close → hide, not quit | `main.ts` (`isQuitting` guard) |
| No tray Quit item (no easy employee exit) | `main.ts` (Phase E) |
| Heartbeat/approval-poll/config/consent schedulers in main process | `agent-orchestrator.ts` |
| Auto-start applied at every boot from settings | `main.ts` + `local-settings.ts` (default true) |
| Duplicate-process prevention | `app.requestSingleInstanceLock` |
| Crash recovery (job failures never kill the agent) | `scheduler.ts` (per-job error capture) |
| Offline recovery (bounded backoff) | `startDiscoveryRetry` (30s→10min) |

## 3. Not verified live

- Reboot → auto-start continuity (needs clean machine, B-02)
- Logout/login behavior on a real Windows host
- Long-running stability (covered by the upcoming pilot, B-pilot)

## 4. Conclusion

**Background runtime requirement is satisfied by the current session-runtime architecture.**
A Windows Service is deliberately NOT introduced (documented decision above). Live machine
verification remains part of the clean-machine certification (B-02).
