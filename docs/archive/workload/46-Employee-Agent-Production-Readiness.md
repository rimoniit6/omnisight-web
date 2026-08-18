# Employee Agent — Production Readiness

Date: 2026-08-10
Audit chain: Phase D (42/43) → Phase E (44, 45) → this report (46)

---

## Final Verdict

> **PRODUCTION CANDIDATE**

The zero-control agent is **functionally complete and verified**: the packaged EXE no longer
exposes any employee-facing onboarding/control surface, the runtime is fully automatic, and the
Admin remains the only control plane. The verdict stays at PRODUCTION CANDIDATE — not
PRODUCTION READY — because the mandatory *operational* verifications (clean-machine certification,
code signing, PostgreSQL, live HTTPS, backup/restore execution, Windows Service) have not been
performed in this environment. No critical security or data-loss defect exists; the gap is
verification/operations, not product code.

---

## 1. Architecture final state

```
EMPLOYEE:  run EXE → nothing. (UI = read-only status viewer; autoStart default on)
ADMIN:     pending devices → approve → employee + department(auto) + projects
           → consent grants/revokes → monitor → revoke
BACKEND:   /api/agent/discover|authenticate|config|heartbeat|activity|screenshot|consent
           + admin /api/device-claims/[id]/approve|reject|revoke (admin-only, org-scoped)
AGENT:     main-process runtime (discovery, polling, collectors, queues, scheduler)
           + sandboxed renderer (status only, zero secrets)
```

## 2. Zero-touch golden path — PASS (automated)

discover → pending claim → admin approve+assign → auto-auth (20s poll) → config/consent sync →
collectors gated by consent → heartbeat. Zero employee input. Verified by 29/29 backend zero-touch
tests, 27/27 consent tests, and 111/111 desktop-agent tests.

## 3. Admin control-plane — PASS (automated + code audit)

Pending device list, hostname/OS/version, employee+department+projects assignment, approve/reject/
revoke, consent control, heartbeat/status observability, audit history — all server-backed,
admin-only, org-scoped (verified in Phase D audit and admin routes).

## 4. Desktop agent — PASS (code + tests)

- Zero-control UI ships in the packaged EXE (md5-verified, regression-guarded).
- Background runtime independent of the window (main process).
- Bounded auto discovery-retry (30s→10min) for offline first run.
- 5s silent status push → auto UI transitions (approval/consent/assignment).
- No tray Quit; autoStart default on; single-instance lock.

## 5. Device lifecycle — PASS (automated)

FIRST RUN → discover → pending; APPROVE → active + authenticated; REJECT → rejected, cannot
authenticate; REVOKE → inactive, tokens rejected, uploads 403, collectors stop; RESTART → identity
preserved, no duplicate device/claim; EXPIRED → cannot authenticate, fresh claim issued on
re-discovery; one-active-device-per-employee transactional rule enforced.

## 6. Employee/Department/Project assignment — PASS (automated)

Server-derived via config sync; renderer shows "Syncing…"/"No department assigned"/"No projects
assigned"; admin edits propagate on next sync without reinstall or restart. Verified by
`orchestrator-dynamic-config.test.ts`.

## 7. Consent security matrix — PASS (automated)

All 8 types: approval ≠ consent; no consent → collectors off + server 403; grant → collector runs;
revoke → collector stops + 403; re-grant → resumes; expired/policy-mismatch → fail closed;
revoked device → everything fails closed. 27/27 consent tests.

## 8. Security audit — PASS

No secrets to renderer (projection + regression test); sandbox (contextIsolation, nodeIntegration
off, CSP, navigation blocked); rate-limited discover/authenticate; hashed claim secrets with
constant-time compare; org isolation server-side; no hardcoded secrets in agent/backend.

## 9. Organization isolation / RBAC — PASS

Org derived server-side (never client-supplied); approve/reject/revoke admin-only and org-scoped;
cross-org assignment rejected 422/404; employee/department/projects validated within org
(approve route + security suite).

## 10. Rejected/Revoked lifecycle — PASS (terminal, per backend lifecycle)

Rejection and revocation are **terminal states in the current backend lifecycle**: the approve
route only accepts `pending` claims (rejected/revoked claims cannot be re-approved via the API),
and the discover route returns the existing claim's status without issuing a fresh claim for a
terminal claim. The agent therefore stops polling and shows the read-only terminal view — no
employee controls, no collectors, no uploads. If the backend later gains a re-approval/reset
path, the existing `discover` + `pollApproval` machinery (idempotent, server-authoritative) would
recover on the next poll/restart without further agent changes. Documented as a known limitation,
not a defect.

## 11. Offline recovery — PASS (new)

Auto discovery-retry with bounded exponential backoff; approval polling is 20s; heartbeat failure
spins `recoverAuth()`; no tight loops (backoff 30s→10min). Tested in `onboarding.test.ts`.

## 11. Packaged EXE verification — PASS (static)

Installer rebuilt; fresh ASAR extracted and compared to source (md5 match); zero legacy markers in
packaged renderer; zero-control markers present; regression test scans dist + ASAR.
⚠️ Live launch not executed in this environment.

## 12. Clean-machine result — ❌ NOT VERIFIED

No clean Windows VM was available. `docs/clean-machine-certification.md` and
`scripts/clean-machine-certification.ps1` exist for this purpose. **Mandatory before
PRODUCTION READY.** The user's Phase E final rule is respected: PRODUCTION READY is not claimed
without it.

## 13. Test results (this phase)

| Suite | Result |
|-------|--------|
| Desktop agent (incl. new zero-control renderer + auto-retry tests) | ✅ 111/111 |
| Backend zero-touch | ✅ 29/29 |
| Backend consent | ✅ 27/27 |
| Admin TypeScript `tsc --noEmit` | ✅ clean |
| Agent build + packaging | ✅ clean |
| Packaged ASAR content vs source | ✅ md5 match |

## 14. Known limitations

- Installer unsigned (SmartScreen warning).
- Login-item startup, not Windows Service.
- Renderer shows last-known sync times only (no live telemetry); no admin-visible config/consent sync timestamps.
- Default Electron icon.
- Live-update feed off by default (HTTPS-gated `electron-updater`).

## 15. Release blockers

| ID | Sev | Item |
|----|-----|------|
| FB-1 | P1 | Clean-machine certification not executed |
| FB-2 | P1 | Installer code-signing unavailable |
| FB-3 | P1 | PostgreSQL not adopted (SQLite schema) |
| FB-4 | P1 | Live HTTPS + backup/restore execution unverified |
| FB-5 | P2 | Windows Service-grade execution not implemented |
| FB-6 | P2 | v1→v2 live upgrade test not executed |

## 16. Recommended path to PRODUCTION READY

1. Execute the clean-machine certification (scripts exist) on a fresh Windows VM → record evidence.
2. Sign the installer (EV/OV code-signing cert) → rebuild, re-hash.
3. Adopt PostgreSQL (provider switch + migration regen) and run `prisma migrate deploy` on a fresh PG.
4. Deploy behind Caddy HTTPS, verify TLS + backup/restore execution.
5. (P2) Evaluate a Windows Service wrapper for before-login operation.
