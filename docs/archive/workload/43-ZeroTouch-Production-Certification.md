# PHASE D — ZERO-TOUCH PRODUCTION CERTIFICATION

Scope: `E:\Workslens\workai` (Admin Web App) + `E:\Workslens\workai\desktop-agent` (Desktop Agent)
Date: 2026-08-10
Supersedes: `workload/41-PhaseC-ReleaseGate-Report.md` (verdict updated)
Audit report: `workload/42-PhaseD-Final-Audit.md`

---

## 1. Architecture Final State

**One Admin Web App** (`src/`) — the only control plane.
**One Desktop Employee Agent** (`desktop-agent/`) — Electron main-process runtime (discovery, auth, heartbeat, config/consent sync, collectors, queue, scheduler) with a renderer that never holds secrets.
**One Consent system** — `Consent` / `ConsentPolicy` / `ConsentLog` + `src/lib/consent.ts` (audited state machine, policy versioning, batched enforcement).
**One identity system** — `Device.agentKey` (unique, stable) + persistent encrypted local identity (`device-identity.ts`, HMAC machine-binding).

Data relationships (source of truth, existing schema):
```
Device → Employee → Department
Employee → ProjectMember → Project
Device → DeviceClaim (zero-touch, org-scoped)
Employee → Consent (8 independent types) → ConsentPolicy
```

---

## 2. Admin Control-Plane Verification — ✅ PASS

Verified against the actual code (`agent-approvals-page.tsx` + device-claims/approve/reject/revoke routes + `tests/zero-touch.test.ts`):

| Capability | Status |
|---|---|
| See pending devices with hostname / OS / agent version / device ID / discovery time | ✅ |
| Select employee (server-side searchable combobox, active only) | ✅ |
| Department automatically derived from Employee | ✅ (UI: "auto from employee"; server: `Employee.departmentId`) |
| Select one or more assignable Projects | ✅ (active/on_hold only; completed/cancelled rejected 422) |
| Approve & Activate (transactional; one active device per employee) | ✅ |
| Reject with reason | ✅ |
| Revoke/deactivate (device inactive, tokens fail closed, claim revoked) | ✅ |
| See online/offline + last heartbeat | ✅ (device.status / lastHeartbeat) |
| See assigned employee / department / projects | ✅ |
| Control consent (separate Consent page; never granted by approval) | ✅ |
| Audit history | ✅ (auditLog rows for discover/approve/reject/revoke/auth) |

No fabricated values — every field originates from `GET /api/device-claims` / `GET /api/projects` (DB-backed).

---

## 3. Desktop Agent Verification — ✅ PASS

- Zero-touch default path: orchestrator first-run → `discoverDevice` (no employee input).
- Approval polling: 20 s `approval-poll` job → auto-authenticates without restart.
- Heartbeat, config sync (10 min), consent sync (60 s), activity sample (10 s), queue drain (20 s), screenshot capture (server cadence) all main-process (run with the window closed).
- Offline: bounded retries + backoff; boot watchdog; no crash; no tight loop.
- Identity: 32-byte random `deviceKey`, HMAC-bound to machine key, survives restarts; copied identity files are detected and regenerated.
- Secrets: safeStorage/DPAPI encrypted, `0o600` files, never logged, never sent to renderer.
- Renderer: sandboxed, CSP `default-src 'none'`, no navigation, no token access.
- Tests: **105/105 pass** (zero-touch, onboarding, renderer security, scheduler, queue, update).

---

## 4. Zero-Touch Golden Path — ✅ PASS (automated evidence)

`discover → pending claim → admin approve (employee/dept/projects) → 20 s poll → PATH A auth → AgentToken → config sync → heartbeat → consent sync → gated collectors`.

- Backend E2E: 28/28 (including new ZT-27/28 hardening regressions).
- Phase C live E2E against the packaged EXE: 14/14 — including **zero consent rows after approval**.
- Employee input: **zero** (no Employee ID, no password, no button).

---

## 5. Device Lifecycle — ✅ PASS

FIRST RUN → pending ✅ · APPROVE → active/authenticated ✅ · REJECT → cannot authenticate ✅ · REVOKE → inactive, token/heartbeat/uploads rejected, collectors stop ✅ · RESTART → identity preserved, no duplicates ✅ · RE-DISCOVER → same device, same claim, no new secret ✅ · EXPIRED claim → cannot authenticate; fresh claim issued ✅ · ONE DEVICE PER EMPLOYEE enforced transactionally ✅.

---

## 6. Employee / Department / Project Assignment — ✅ PASS

`GET /api/agent/config` returns server-derived assignment on every sync; the agent replaces its snapshot wholesale. Department moves and project removals propagate on the next sync (ZT-26). Completed/cancelled projects are never surfaced (ZT-25). Stale data cannot persist because there is no local assignment store to go stale.

---

## 7. Consent Security Matrix — ✅ PASS (CONSENT-01 … CONSENT-13)

Legend: **E** = Expected (fail-closed default), **A** = Actual, **Verdict** = PASS/FAIL, **Evidence**.

| ID | Scenario | E | A | Verdict | Evidence |
|----|----------|---|---|---------|----------|
| CONSENT-01 | Newly approved device has ZERO implicit consent (approval ≠ consent) | 0 rows, all types inactive | 0 consent rows after approve | ✅ PASS | ZT-9 (all 8 types false), ZT-10; Phase C E2E live count=0 |
| CONSENT-02 | No activity consent → collector does not run | stop | stop (gate: no snapshot/not granted) | ✅ PASS | consent-gate.ts; activity-collector.ts start()/sample() |
| CONSENT-03 | No activity consent → upload returns 403, nothing persisted | 403 | 403, 0 rows | ✅ PASS | ZT-21 |
| CONSENT-04 | No screenshot consent → collector does not run | stop | stop | ✅ PASS | consent-gate.ts; screenshot-collector.ts |
| CONSENT-05 | No screenshot consent → upload returns 403, nothing persisted | 403 | 403, 0 rows | ✅ PASS | ZT-23 |
| CONSENT-06 | Revoke activity consent → agent stops collection | stop ≤ next sync | stop (60 s consent sync + gate re-eval each sample) | ✅ PASS | consent-service detectRevocations; ZT-22 |
| CONSENT-07 | Revoke activity consent → server rejects upload | 403 | 403, 0 new rows | ✅ PASS | ZT-22 |
| CONSENT-08 | Revoke screenshot consent → agent stops + upload 403 | stop + 403 | stop; 403, 0 new rows | ✅ PASS | ZT-23 |
| CONSENT-09 | Re-grant activity → collector resumes after consent sync | collect | collect after refresh | ✅ PASS | consent refresh job → applyCollectorStates; ZT-22 grant leg (200 + persisted) |
| CONSENT-10 | Re-grant screenshot → collector resumes | collect | collect after refresh | ✅ PASS | ZT-23 grant leg (200 + persisted) |
| CONSENT-11 | Policy version mismatch (v1 consent, v2 published) → fail closed | false | not granted; upload 403 | ✅ PASS | getConsentState / hasActiveConsent policy binding; consent.test 26/26 (versioning edge cases) |
| CONSENT-12 | Expired consent → fail closed; restart preserves revoked/granted state | stop / restore | stop; states persisted (claim on disk) and re-synced | ✅ PASS | consent.test (expiry); desktop restart tests |
| CONSENT-13 | All 8 consent types remain independent | per-type | activity consent never implies screenshot (403) | ✅ PASS | ZT-24; `@@unique([employeeId, consentType])` |

**No consent implementation change was required** — every row passed with the existing architecture.

---

## 8. Security Audit — ✅ PASS (2 latent defects fixed this phase)

Verified: org isolation from token/session only; cross-org → 404/422; claim secret hashed + constant-time; discovery/auth rate limited; claim expiry enforced; revoked/expired devices cannot authenticate; 24 h token expiry; renderer cannot reach Node; contextIsolation + nodeIntegration-off + sandbox + CSP + navigation/window-open blocked; IPC sender-guarded; token never reaches renderer.

**Fixed this phase (smallest scope):**
1. `generateToken` — removed the `Math.random()` fallback; always `randomBytes` (predictable-token risk). Regression: ZT-27.
2. `getClientIp` — now reads the rightmost `x-forwarded-for` (or `x-real-ip`) matching the rate-limiter's spoof-resistant convention (was leftmost, client-controlled). Regression: ZT-28.

Hardcoded-values search: only `src/lib/seed.ts` dev bootstrap credentials; `.env.example` uses placeholders; no fake/mock consent, assignment, or device values in production paths.

---

## 9. Organization Isolation — ✅ PASS

Every agent/admin route resolves the org from the authenticated identity. Cross-org claim lookup → 404 (concealed); cross-org employee/project assignment → 422; foreign admin sees zero claims. ZT-7/8/20. No client-controlled `organizationId` anywhere in the zero-touch surface.

---

## 10. RBAC — ✅ PASS

`src/proxy.ts` central RBAC + `requireAdminOrg`/`requireSessionOrg` on every admin route. Non-admin approve → 403 (ZT-5). Viewer/manager cannot reach device-claims writes.

---

## 11. Offline Recovery — ✅ PASS

Agent starts with server offline → no crash, no permanent "Starting…", automatic bounded retries, identity preserved, no duplicate devices; recovers on server return; pending→approved resolves within a poll. No infinite tight retry loop (20 s poll, backoff+jitter, exclusive drain jobs).

---

## 12. Packaged EXE Verification — ✅ PASS on this machine / ⚠️ clean-machine NOT VERIFIED

Phase C verified on this machine: NSIS installer builds/installs/launches; native addon packaged; renderer loads (classic script — no CommonJS regression, no `exports/require is not defined`, no `agentApi` redeclaration); zero-touch UI; pending/approved/connected states; server-derived assignment; consent state server-derived. **A fresh-VM run remains unexecuted** — the runbook (`docs/clean-machine-certification.md`) and evidence script (`scripts/clean-machine-certification.ps1`) are ready.

---

## 13. Clean-Machine Result — ❌ NOT VERIFIED

Not executed on a clean Windows VM / second physical PC (no Node, no Git, no source, no prior install). This is the single mandatory gate for PRODUCTION READY.

---

## 14. Test Results (Phase D baseline)

| Suite | Result |
|---|---|
| Backend zero-touch | ✅ 28/28 |
| Backend consent | ✅ 26/26 |
| Backend security | ⚠️ 26/28 — EMPLOYEE-11/12 are pre-existing employee-module failures (verified pre-existing; outside Phase D scope) |
| Desktop agent | ✅ 105/105 |
| Admin TypeScript | ✅ clean |
| Admin production build | ✅ (Phase C clean-room) |

---

## 15. Known Limitations

1. Auto-start is a login-item and **defaults off**; agent runs in the user session, not as a Windows Service (before login / session-independent execution not supported).
2. Rate limiter is in-memory — single-instance deployments only.
3. `rebuild-native` script is malformed; the addon ships prebuilt.
4. Server URL is env-var only (no installer UI).
5. No branded icon.

None of these weaken consent enforcement, tenant isolation, or the zero-touch golden path.

---

## 16. Release Blockers

| ID | Severity | Blocker |
|----|----------|---------|
| RB-1 | **P1** | Clean-machine certification unexecuted (mandatory for PRODUCTION READY) |
| RB-2 | **P1** | Installer unsigned (SmartScreen "unknown publisher"); code-signing certificate required |
| RB-3 | **P2** | Windows Service / before-login startup not implemented; auto-start default off |
| RB-4 | **P2** | Malformed `rebuild-native` script |
| RB-5 | **P2** | Agent server URL config (env-only) |
| RB-6 | **P3** | Default icon |
| RB-7 | **P3** | In-memory rate limiter (multi-instance) |

---

## 17. Final Verdict

> ## PRODUCTION CANDIDATE

Rationale:
- **PRODUCTION READY** is not claimed: clean-machine verification (RB-1) is mandatory and was NOT executed, and the installer is unsigned (RB-2). Per the brief, passing automated tests alone can never earn PRODUCTION READY.
- **NOT READY** is not appropriate: every zero-touch, consent, security, lifecycle, and offline requirement verified in this phase **passed**; the two latent defects found were fixed with regression tests; no product-code regressions were introduced (backend 28/28 + 26/26; desktop 105/105; TypeScript clean).

To reach **PRODUCTION READY**: execute `scripts/clean-machine-certification.ps1` on a clean VM/second PC against a signed installer (or document the unsigned-installer risk acceptance), and confirm the zero-touch golden path end-to-end on that hardware.
