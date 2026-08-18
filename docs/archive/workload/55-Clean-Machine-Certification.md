# Clean Machine Certification

Date: 2026-08-10 · Phase G

## Verdict

| Item | Status |
|---|---|
| Clean Windows VM available in this environment | ❌ **NO** |
| Clean-machine test executed | ❌ **NOT EXECUTED** |
| Evidence captured (screenshots/logs) | ❌ **NO** |
| Packaged EXE statically verified (ASAR) | ✅ PASS (Phase E — zero-control renderer confirmed in the shipped artifact) |

**Status: 🔒 BLOCKED — clean Windows VM/machine required**

---

## 1. Requirement

A completely clean Windows machine/VM with **no Node, no Git, no source tree, no previous
WorkLensAI installation, no previous userData, no previous device identity** must run the
full lifecycle:

1. Install `WorkLensAI Agent Setup 1.0.0.exe`
2. SmartScreen behavior recorded (unsigned → expected warning; **blocked until B-03 signing**)
3. Installer signature check
4. Installation completes; Start Menu shortcut created
5. Automatic startup (autoStart default on — verified in code/tests)
6. No crash, no "Starting…" freeze
7. **No Employee ID form, no password form** (zero-control renderer — statically verified)
8. Silent discovery → device appears in Admin as Pending
9. Admin approves with employee + department(auto) + projects
10. Agent auto-authenticates, config syncs, assignment displayed
11. Consent remains separate; collectors obey consent (grant/revoke/403)
12. Close UI → background runtime continues (main-process)
13. Reboot Windows → agent auto-starts, **same device identity** (no duplicate)

## 2. Existing tooling (ready to run)

- `docs/clean-machine-certification.md` — step-by-step runbook
- `scripts/clean-machine-certification.ps1` — evidence-capturing script
- `scripts/zt-b5-e2e.mjs` — backend zero-touch E2E (device-level, runnable against any DB)
- `tests/zero-touch.test.ts` (29/29), `tests/consent.test.ts` (27/27) — API-level lifecycle

## 3. Evidence checklist (to record when executed)

| # | Evidence |
|---|---|
| 1 | VM snapshot/clean-state proof (no Node/Git/previous install) |
| 2 | Installer install log + SmartScreen screenshot |
| 3 | Start Menu shortcut presence |
| 4 | Task Manager/process list showing agent running (no window) |
| 5 | Admin UI screenshot: pending device with hostname/OS/version |
| 6 | Admin approve dialog screenshot (employee, auto department, projects) |
| 7 | Agent status view: employee/department/projects from server |
| 8 | Consent grant/revoke + server 403 proof (logs/API) |
| 9 | Close-window → process still alive |
| 10 | Reboot → auto-start log + unchanged device id (agentKey) |
| 11 | No duplicate Device/DeviceClaim rows (DB query) |

## 4. Acceptance

Clean-machine certification is **mandatory for PRODUCTION READY** (Phase E final rule) and
**cannot be truthfully claimed from this environment**. It is **P1 blocker B-02**; the
runbook and scripts are ready and require only a provisioned Windows VM.
