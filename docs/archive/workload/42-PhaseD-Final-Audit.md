# PHASE D — FINAL PRODUCTION HARDENING + ZERO-TOUCH CERTIFICATION — SYSTEM AUDIT

Scope: `E:\Workslens\workai` (Admin Web App) + `E:\Workslens\workai\desktop-agent` (Desktop Agent)
Date: 2026-08-10
Method: static verification of the actual current code (no assumptions from prior reports) + live test-suite evidence. Browser/clean-machine live click-through was NOT re-executed in this pass (see §Phase 10 and 43).

---

## PART 1 — FINAL SYSTEM AUDIT (Phase 1 of the brief)

| # | Area | Verdict | Evidence (file:line / suite) |
|---|------|---------|------------------------------|
| 1 | Admin Web Application | ✅ PASS | Single app in `src/`. Device-claims admin UI: `src/components/agent-approvals/agent-approvals-page.tsx` (Zero-Touch Devices tab). No duplicate admin app. |
| 2 | Desktop Employee Agent | ✅ PASS | Single agent in `desktop-agent/`. No duplicate agent implementation. |
| 3 | Prisma schema | ✅ PASS | `prisma/schema.prisma`: `DeviceClaim`, `Device.agentKey` (unique), `AgentToken`, `Consent`, `ConsentPolicy`, `ProjectMember` all present with FKs + indexes. |
| 4 | Migrations | ✅ PASS | Phase C report §3: all 28 migrations apply on a fresh DB; additive-only on existing DBs (verified in Phase C, 2026-08-10). |
| 5 | DeviceClaim | ✅ PASS | `DeviceClaim` model: org-scoped (`organizationId`), unique `deviceId`, `claimSecretHash` (never plaintext), `status`, `employeeId`, `approvedBy/At`, `expiresAt`, indexes on `organizationId/status/employeeId`. Route-level expiry checks: `discover` (expired→fresh claim) and `approve` (expired→422). |
| 6 | Device.agentKey | ✅ PASS | Unique stable machine identity from the agent (`device-identity.ts`, 32 random bytes, HMAC-bound to machine key). `discover` reuses by `agentKey` — device never recreated on restart. |
| 7 | Agent authentication | ✅ PASS | `src/app/api/agent/authenticate/route.ts`: PATH A (deviceId+secret) + PATH B (employeeId+password). Constant-time claim-secret verify (`src/lib/agent/auth.ts` `verifyClaimSecret`). Rate limited per IP (20/min). One token/employee transactionally. |
| 8 | Zero-touch discovery | ✅ PASS | `discover/route.ts`: org derived SERVER-side (first org — single-tenant default, never client-supplied), 400 on bad payloads, idempotent, one-time secret, audit + notification. |
| 9 | Zero-touch approval | ✅ PASS | `device-claims/[id]/approve/route.ts`: admin-only (`requireAdminOrg`), org-scoped 404 concealment, employee must exist in org (422), projects validated in-org + assignable status (422), transactional bind, ONE ACTIVE DEVICE PER EMPLOYEE, audit + notification. |
| 10 | Device revoke/deactivation | ✅ PASS | `revoke/route.ts`: claim→revoked, device→inactive + unbound, tokens fail closed immediately via `validateAgentToken` device-status check. Verified: ZT-16. |
| 11 | Employee assignment | ✅ PASS | Required at approval; employee resolved inside admin org only. ZT-6/7. |
| 12 | Department assignment | ✅ PASS | Derived from `Employee.departmentId` — never client-supplied. UI shows "auto from employee". ZT-6, ZT-25. |
| 13 | Project assignment | ✅ PASS | Multi-select via existing `ProjectMember` model (upsert, `leftAt` reactivation). Cross-org project → 422. ZT-6/8. |
| 14 | Consent Management | ✅ PASS | `src/lib/consent.ts`: 8 types, versioned policies, audited state machine (`applyConsentTransition`), batched `getConsentState`. Approval never creates consent (ZT-9). |
| 15 | Activity collection | ✅ PASS | `activity-collector.ts` gated by `decideConsentGate`; server re-enforces `hasActiveConsent('activity_tracking')` → 403. ZT-21/22. |
| 16 | Screenshot collection | ✅ PASS | `screenshot-collector.ts` gated; bounded spool; server 403 without consent; size/type validated. ZT-23. |
| 17 | Heartbeat | ✅ PASS | `heartbeat/route.ts` validates token (incl. device status) then updates `lastHeartbeat/status/ipAddress`. Proxy rate limit 600/min per token. |
| 18 | Agent config synchronization | ✅ PASS | `config/route.ts` returns org monitoring config + **server-derived assignment** (employee name, department, active projects only). ZT-25/26. |
| 19 | Agent offline/retry behavior | ✅ PASS | `ApiClient` bounded retries (2) + exponential backoff + jitter; heartbeat 401→`recoverAuth`; approval poll every 20 s (no tight loop); boot watchdog. Desktop tests: "server unavailable during poll keeps pending", "discovery failure classifies network". |
| 20 | Secure credential storage | ✅ PASS | `SafeStorageStore` (Electron safeStorage / Windows DPAPI), files `0o600`, hashed filenames, never plaintext. Claim secret stored encrypted; token encrypted. |
| 21 | IPC security | ✅ PASS | `ipc.ts` sender guard (`file://` only), input validation on every channel, no filesystem/token exposure. `preload.ts` narrow `contextBridge` surface. |
| 22 | Renderer security | ✅ PASS | `contextIsolation: true`, `nodeIntegration: false`, `sandbox: true`, `webSecurity: true`, CSP (`default-src 'none'; script-src 'self'; … connect-src 'none'`), navigation blocked, `window.open` denied, no top-level import/export (renderer tests), no `agentApi` collision (renderer tests). |
| 23 | Installer/package | ✅ PASS* | `electron-builder.yml` NSIS x64; Phase C verified installer build/install/launch on this machine. **Clean-machine clause NOT VERIFIED.** Unsigned installer (blocker, see 43). |
| 24 | Auto-start | ⚠️ WARNING | Uses `app.setLoginItemSettings({ openAtLogin })` (login-item, not a Windows Service). Default is **off** (`SETTINGS_DEFAULTS.autoStart = false`) — the agent must be started once to enable it. Runs only in the user session (not before login). See Release Blocker RB-3. |
| 25 | Native addon | ✅ PASS* | `native-bridge.ts` loads from packaged `resources/native/worklens_capture.node`, dev path, or bundling fallback; fails closed when absent. Prebuilt addon packaged (Phase C). `rebuild-native` script malformed (RB-4). |
| 26 | Audit logging | ✅ PASS | discover/approve/reject/revoke/authenticate/heartbeat all write `auditLog` with org scope, IP, resource. Consent transitions write immutable `ConsentLog`. |
| 27 | Rate limiting | ✅ PASS | `src/lib/rate-limit.ts` + `src/proxy.ts`: discover (20/min/IP+key), authenticate (20/min/IP), approve/reject/revoke (30/min/IP), heartbeat (600/min/token), agent writes (120/min/token), login (10/5min/IP+email). In-memory (single-instance) — documented. |
| 28 | Organization isolation | ✅ PASS | All agent/admin routes resolve org from the authenticated token/session, never a client field. Cross-org claim/employee/project actions → 404/422. ZT-7/8/20. |
| 29 | RBAC | ✅ PASS | `src/proxy.ts` ROLE_RULES (admin+/manager+ prefixes) + `requireAdminOrg`/`requireSessionOrg` in every device-claim / agent-registration route. ZT-5. |
| 30 | Existing legacy registration flow | ✅ PASS | `/api/agent/register` + PATH B retained as fallback; renderer hides the form behind "Connect an existing account" (explicitly legacy). ZT-18. |

\* PASS with a qualification documented in Release Blockers.

---

## PART 2 — ZERO-TOUCH GOLDEN PATH (Phase 2) — ✅ PASS (automated evidence)

Verified journey: fresh launch → `discoverDevice` (no employee input) → pending DeviceClaim → admin approves (employee + dept + projects) → agent's 20 s approval poll detects it → PATH A auth → AgentToken → config sync (employee/department/projects server-derived) → heartbeat → consent sync → only consent-authorized collectors start.

Evidence:
- Backend E2E in `tests/zero-touch.test.ts` (28/28): discover→approve→authenticate→config cycle, revocation, consent independence.
- Desktop agent tests (105/105): "orchestrator end-to-end: discover → pending → approve → auto-auth → connected", "approval detection: poll flips pending→approved→auto-authenticates", "no token ever crosses the renderer boundary".
- Phase C live E2E (`scripts/zt-b5-e2e.mjs`) against the **packaged EXE** + live server: 14/14, including **zero consent rows after approval**.

**Acceptance criteria — all met by the automated evidence:**
- Employee performs zero input ✅ (orchestrator default path is zero-touch discover)
- No restart required after approval ✅ (20 s poll auto-authenticates)
- No manual "Connect" button required ✅ (auto)
- No employee password required ✅ (PATH A device credential)
- No employee account creation from the agent ✅ (admin assigns the employee)
- Admin is the only control point ✅

---

## PART 3 — ADMIN CONTROL-PLANE (Phase 3) — ✅ PASS

`agent-approvals-page.tsx` (Zero-Touch Devices tab) provides:
1. Pending devices list ✅ 2. Hostname ✅ 3. OS + version ✅ 4. Agent version ✅ 5. Device ID (truncated badge) ✅ 6. Discovery time ✅ 7. Employee selector (searchable server-side combobox) ✅ 8. Department auto-derived from employee ✅ 9. Project multi-select (assignable statuses only) ✅ 10. Approve & Activate ✅ 11. Reject (with reason) ✅ 12. Revoke (with reason) ✅ 13. Online/offline + last heartbeat ✅ 14. Assigned employee/department/projects ✅ 15. Consent NOT granted by approval (explicit UI banner) ✅ 16. Audit history via auditLog rows ✅

Every displayed value originates from `GET /api/device-claims` (DB-backed) or `GET /api/projects`. No fabricated values.

---

## PART 4 — CONSENT FINAL SECURITY AUDIT (Phase 4) — ✅ PASS

See the CONSENT-01…CONSENT-13 matrix in `workload/43-ZeroTouch-Production-Certification.md`. Summary:

- **Approval ≠ Consent** — enforced in code (`approve` route writes no consent rows; ZT-9/10) and proven live (Phase C E2E: 0 consent rows after approval).
- **Server-side enforcement is authoritative** — activity/screenshot uploads re-check `hasActiveConsent` and return 403 before persisting anything (ZT-21/22/23/24).
- **Agent-side gate is an optimization, fail-closed** — `decideConsentGate` requires a fresh snapshot + granted type + config-enabled; stale (5 min) or missing snapshot → stop.
- **Policy-version awareness** — consent bound to an archived/older policy reports NOT granted (v1 consent under v2 policy). Consent suite 26/26.
- **8 consent types independent** — per-type consent rows with `@@unique([employeeId, consentType])`; ZT-24 proves activity consent never implies screenshot.
- **Revoked device** — token fail-closed immediately (device status check in `validateAgentToken`); collectors stop; re-auth 403 (ZT-16).
- **Restart behavior** — claim status persisted on disk (encrypted); revoked/rejected states restore across restarts (desktop tests).

No consent implementation changes were required — no real regression was found.

---

## PART 5 — SECURITY FINAL AUDIT (Phase 5) — ✅ PASS (2 latent defects fixed)

All 28 checks verified in code. Highlights:

| Check | Result |
|---|---|
| No client-supplied organizationId trusted | ✅ org always from token/session/server context |
| Cross-org device/employee/dept/project access | ✅ 404/422 concealment (ZT-7/8/20) |
| DeviceClaim org-scoped, approval/rejection/revoke admin-only | ✅ `requireAdminOrg` + org-scoped `findFirst` |
| Device secret never logged / never sent to renderer | ✅ logger redacts; renderer never receives token/secret |
| Claim secret hashed server-side + constant-time verify | ✅ sha256 + XOR constant-time compare |
| Discovery/authentication rate limited | ✅ 20/min/IP each |
| Claim expiration enforced | ✅ expire path in discover; approve rejects expired |
| Expired/revoked claims cannot authenticate | ✅ ZT-13/15/16 |
| Token 24 h expiry | ✅ `expiresAt` checked + cleaned in `validateAgentToken` |
| contextIsolation / nodeIntegration / sandbox / CSP | ✅ verified in `main.ts` + `index.html` |
| Navigation / window-open restrictions | ✅ `will-navigate` preventDefault + `setWindowOpenHandler` deny |
| IPC sender validation | ✅ `file://` guard on every handler |
| No auth token exposed to renderer | ✅ renderer gets `getStatusForRenderer()` only (desktop test) |

**Searched for hardcoded secrets/fake data:** seed credentials live only in `src/lib/seed.ts` (dev bootstrap, `admin123` etc. — documented dev seed, not production); `.env.example` uses `REPLACE_WITH_*` placeholders; no hardcoded employee/department/project names in production paths; no `Math.random()`-based production data after the fix below.

### Defects found & fixed (smallest scope, Phase 11)
1. **`generateToken` had a `Math.random()` fallback** — if `crypto.getRandomValues` were ever unavailable, agent tokens would become predictable. Fixed to always use `randomBytes` (`src/lib/agent/auth.ts`). Regression test: ZT-27.
2. **`getClientIp` read the leftmost `x-forwarded-for` entry** (client-controlled) while `getClientIpFromHeaders` (rate-limit) correctly reads the rightmost. Audit/device IPs could be spoofed. Fixed to rightmost + `x-real-ip` precedence, matching the rate-limiter convention. Regression test: ZT-28.

---

## PART 6 — DEVICE LIFECYCLE (Phase 6) — ✅ PASS

- FIRST RUN → discover → pending ✅ (ZT-1)
- APPROVE → active + authenticated ✅ (ZT-6, ZT-14)
- REJECT → rejected, cannot authenticate ✅ (ZT-15)
- REVOKE → inactive, token rejected, heartbeat/uploads rejected (via `validateAgentToken` device check), collectors stop ✅ (ZT-16 + desktop tests)
- RESTART → identity preserved, no duplicate device ✅ (desktop: "device identity persists across restarts"; ZT-2 idempotency)
- RE-DISCOVER → same identity, no duplicate claims ✅ (ZT-2)
- EXPIRED CLAIM → cannot authenticate; fresh discovery re-issues a claim ✅ (discover route)
- ONE DEVICE PER EMPLOYEE ✅ (ZT-12, transactional in approve + both auth paths)

---

## PART 7 — ASSIGNMENT CONSISTENCY (Phase 7) — ✅ PASS

`GET /api/agent/config` derives employee name, department, and **active/on_hold** projects from `Employee → Department` and `ProjectMember → Project` on every sync. Agent replaces its snapshot wholesale (never merges/fabricates). Admin changes (dept move, project removal/soft-remove via `leftAt`) are reflected on next config refresh — ZT-26. Completed/cancelled projects are excluded (ZT-25).

---

## PART 8 — OFFLINE / NETWORK FAILURE (Phase 8) — ✅ PASS

- No crash, no permanent "Starting…" — renderer paints immediately, boot watchdog bounds init ✅
- Automatic retry with bounded exponential backoff + jitter (ApiClient) ✅
- Device identity preserved ✅
- No duplicate devices on re-connect ✅ (discover idempotent)
- Approval poll is 20 s — **no infinite tight loop** ✅
- Recovery when server returns: heartbeat 401 → `recoverAuth`; pending→approved poll → `onAuthenticated` ✅

---

## PART 9 — PACKAGED EXE VERIFICATION (Phase 9) — ✅ PASS on this machine / ⚠️ clean-machine NOT VERIFIED

Phase C (2026-08-10) verified on this machine: installer builds + launches, native addon packaged beside app, renderer loads, no "Starting…" freeze, zero-touch UI, pending state, approval detection, connected state, server-derived assignment. ASAR checks: renderer is classic script (no CommonJS tokens, no `exports/require` crash, no `agentApi` redeclaration) — enforced by renderer tests.

The **clean-machine** clause (fresh VM, no Node/Git/source/dev tooling) was NOT executed — runbook + evidence script are ready (`scripts/clean-machine-certification.ps1`, `docs/clean-machine-certification.md`).

---

## PART 10 — CLEAN MACHINE CERTIFICATION (Phase 10) — ❌ NOT VERIFIED

Not executed on a clean VM / second physical PC. Mandatory before PRODUCTION READY. See Release Blocker RB-1.

---

## PART 12 — FINAL REGRESSION BASELINE (Phase 12)

| Suite | Result |
|---|---|
| Backend zero-touch | ✅ 28/28 (26 existing + 2 new hardening tests) |
| Backend consent | ✅ 26/26 |
| Backend security | ⚠️ 26/28 — EMPLOYEE-11/12 are **pre-existing employee-module failures** (verified pre-existing in the Projects audit via `git stash`; outside Phase D scope; not caused by this phase) |
| Desktop agent (zero-touch, onboarding, renderer, scheduler, queue, update, consent) | ✅ 105/105 |
| Admin TypeScript | ✅ `tsc --noEmit` clean |
| ESLint (changed files) | ✅ 0 errors (2 pre-existing warnings in the test file) |

No test coverage was reduced.

---

## PART 13 — RELEASE BLOCKERS (Phase 13)

| ID | Severity | Item | Status |
|----|----------|------|--------|
| RB-1 | **P1** | Clean-machine certification (fresh VM / second PC) not executed | Open — blocks PRODUCTION READY |
| RB-2 | **P1** | Installer is **unsigned** — SmartScreen "unknown publisher" | Open — code-signing certificate required |
| RB-3 | **P2** | Agent startup is a login-item, not a Windows Service; auto-start **defaults off**; no before-login/session-independent execution | Documented limitation (architecture decision) |
| RB-4 | **P2** | `npm run rebuild-native` script malformed (`node-gyp@13 rebuild` → `npx node-gyp rebuild --directory native`); addon ships prebuilt | Documented (Phase C) |
| RB-5 | **P2** | Agent server URL is env-var only (`WORKLENSAI_SERVER_URL`, default `localhost:3000`) — no installer/UI configuration | Documented |
| RB-6 | **P3** | Default Electron icon (no branded icon asset) | Cosmetic |
| RB-7 | **P3** | Rate limiter is in-memory (per-process) — replace with a shared store for multi-instance deployments | Documented |

---

## PART 14 — FINAL PRODUCTION DECISION (Phase 14)

> Verdict: **PRODUCTION CANDIDATE** — see `workload/43-ZeroTouch-Production-Certification.md` for the full certification.

Not PRODUCTION READY because RB-1 (clean-machine verification) is mandatory and unexecuted, and RB-2 (unsigned installer) is open. Automated tests pass and the architecture is sound, but per the brief, test-passing alone never earns PRODUCTION READY.
