# OMNISIGHT — Guest Join → `/api/agent/discover` 422 Debug Report

**Date:** 2026-08-17
**Reporter:** Debug agent (per the 12-phase procedure)
**Status:** **RESOLVED** — root cause proven, minor validation bug fixed, GUEST-01..09 regression suite added, and the live Desktop Agent "Join as Guest" flow verified end-to-end against the running backend (10/10 PASS).

---

## Symptom

Clicking **"Join as Guest"** in the Desktop Agent produces a server-side

```
POST /api/agent/discover 422 in 18ms
```

The request reaches the API and is answered **by the route handler** (the proxy passes every `/api/agent/*` path through untouched). The agent's UI falls back to the Employee Login view — no pending device appears in **Agent Approvals**.

## Actual Request (what the agent sends)

The renderer's **"Join as Guest"** button (`desktop-agent/src/renderer/renderer.ts` → `bindJoinGuest`) only triggers a main-process IPC call — it never sees or sends the enrollment code.

```
renderer.ts bindJoinGuest()
  → ipcRenderer.invoke('agent:join-guest')                     (preload.ts)
  → main/ipc.ts 'agent:join-guest'
  → services/agent-orchestrator.ts joinAsGuest()               → runFirstRunDiscovery()
  → auth/auth-service.ts discoverDevice(info)
  → api/device.ts discover({ ...info, reRegister: true,
                             enrollmentCode: enrollmentCodeFor(info) })
  → POST /api/agent/discover
```

The HTTP body the agent constructs (`DeviceInfo` from the native host + stable machine `deviceKey`):

```jsonc
{
  "deviceKey":     "<16-char+ stable machine identity>",   // never a secret
  "hostname":      "<machine name>",
  "os":            "Windows 11",
  "osVersion":     "10.0.26100",
  "processor":     "x64",
  "memory":        "16 GB",
  "agentVersion":  "1.1.0",
  "arch":          "x64",
  "reRegister":    true,
  "enrollmentCode": "<present ONLY when provisioned — see below>"
}
```

`enrollmentCodeFor()` (`auth-service.ts`) resolves the code in this order:

1. an explicit `info.enrollmentCode` (never set by the UI — tests / future provisioning only),
2. the runtime env `WL_ENROLLMENT_CODE`,
3. the build-time baked `AGENT_CONFIG.enrollmentCode` (`src/config/agent-config.ts`, patched by `scripts/build-prod.mjs` from `AGENT_ENROLLMENT_CODE`).

**The running build has none of the three.** Verified: `desktop-agent/dist/config/agent-config.js` ships

```js
exports.AGENT_CONFIG = { serverUrl: null, enrollmentCode: null, agentVersion: '1.1.0' };
```

and no `WL_ENROLLMENT_CODE` is set. So the agent actually sends **no `enrollmentCode` field** (or `undefined`).

## API Expected Contract (`src/app/api/agent/discover/route.ts`)

| Aspect | Contract |
|---|---|
| Method | `POST` |
| Auth | **None required at the route** — optional `AgentSession` bearer (`validateAgentSession`). The proxy lets all `/api/agent/*` through (agent routes self-authenticate). |
| Required | `deviceKey` (string, 16–128), `hostname` (non-empty string ≤128) |
| Optional | `os`, `osVersion`, `processor`, `memory`, `agentVersion`, `arch`, `reRegister`, `enrollmentCode` |
| Org derivation | **SERVER-SIDE only** — ① authenticated session org, ② existing device's org, ③ NEW anonymous device → valid org **enrollment code** (SHA-256 hash compared). **No client `organizationId`, no "first org" fallback.** |
| 422 conditions | Anonymous + brand-new device + no valid enrollment code → `422` (zero rows written). |
| Success | `201` pending claim + one-time `secret` (new device), or idempotent `200` for known devices. |

The two 422 messages (both reproduced live):

| Body sent | Response |
|---|---|
| no `enrollmentCode` | `422 {"error":"Device registration requires an organization enrollment code (issued by your administrator) or an employee sign-in."}` |
| wrong `enrollmentCode` | `422 {"error":"Invalid enrollment code."}` |

## Exact 422 Source

- **Not the proxy.** `src/proxy.ts` short-circuits `AGENT_PREFIXES = ['/api/agent/']` to `NextResponse.next()` — body and headers pass through unmodified (and `POST /api/agent/discover` matches no rate rule at the proxy).
- **Not a schema library.** The route uses hand-rolled type checks (no zod).
- **It is the route's deliberate fail-closed branch**, `resolveOrgFromEnrollmentCode()` → `org === null` → the `422` return. The agent hit the **"no code sent"** variant (confirmed by the compiled build above).

## Root Cause

**Classification: provisioning gap (agent build lacks the org enrollment code).** NOT a server validation bug and NOT a contract regression.

- The backend **has** an enrollment code configured for the org (`OrganizationSetting.agent_enrollment_code` exists — queried from the dev DB).
- "Join as Guest" is the zero-touch anonymous discovery; since P2-3 hardening the server **requires** that code for a brand-new anonymous device (fail-closed, no implicit first-org binding — security-tested: `AH-20`).
- The agent correctly sends whatever code it was provisioned with; **none was provisioned** (build-time `AGENT_ENROLLMENT_CODE` not set when the EXE/dist was built, no `WL_ENROLLMENT_CODE` at runtime).
- Git history (commits `bfd47e5`/`24e1d20`/`76d3e0a`) confirms the recent security/hardening passes only added `await` to rate-limit calls, RBAC rules, and `SAFE_EMPLOYEE_SELECT` — **no change to the discover contract or the guest flow**.

**Second, minor, real bug found while probing (fixed):** a malformed / non-JSON body caused `req.json()` to throw and surface as `500 {"error":"Internal server error"}`. A client error must be `400` (GUEST-03).

## Security Impact

None from the 422 itself — it is the intended fail-closed behavior:
- Guest token/code stays hashed at rest (SHA-256, constant-time compare).
- Expired/revoked/rejected guests and claims remain rejected (verified by the new suite).
- Org isolation, replay protection, and server-authoritative identity are all preserved — **no validation was weakened**.
- The only fix to server code tightens an error path (500 → 400), which is strictly safer (a malformed body no longer reaches the generic 500 path and no row can be written from it).

## Fix

1. **Server (`src/app/api/agent/discover/route.ts`):** wrap `await req.json()` — a malformed/non-JSON body now returns `400 {"error":"Invalid JSON body"}` instead of `500`. Verification unchanged: all existing 400/422/429/404 guards untouched.
2. **Provisioning (the actual remediation for the symptom):** the org's enrollment code must reach the agent. Documented paths:
   - **Build time:** `Settings → Agent Software → build` with the org code (or `AGENT_ENROLLMENT_CODE` on the build machine) — bakes it into the EXE via `scripts/build-prod.mjs`.
   - **Runtime:** set `WL_ENROLLMENT_CODE` on the agent machine (MDM / dev).
   - Then "Join as Guest" → `201` pending → admin approves in **Agent Approvals (guest mode)** → guest authenticates via PATH A.
3. **No change to `/api/agent/discover` validation** — the missing-code 422 remains (fail-closed by design; `AH-20` regression test asserts it).

## Regression Tests

New suite **`tests/guest-join-discover.test.ts`** (throwaway PG DB, route-level, mirrors `zero-touch`/`guest-approval-rbac` conventions) — **9/9 pass**:

| ID | Scenario | Result |
|---|---|---|
| GUEST-01 | Valid Join as Guest: anonymous discover (code) → guest approval → PATH A auth → token passes `validateAgentToken`; synthesized `GUEST-*` identity, no AgentAccount, no consent | ✅ |
| GUEST-02 | Missing required field (deviceKey / short key / empty hostname) | 400 ✅ |
| GUEST-03 | Malformed request — invalid JSON → 400 (fix), wrong field types → 400 | ✅ |
| GUEST-04 | Expired claim → approve 422, zero guest rows; re-discover issues fresh claim | ✅ |
| GUEST-05 | Revoked guest → re-auth 403, token invalidated (fail closed) | ✅ |
| GUEST-06 | Invalid claim secret → 401; pending claim → 403 pending | ✅ |
| GUEST-07 | Cross-org: foreign admin approve → 404; org binds via its own code | ✅ |
| GUEST-08 | Replay (`reRegister`) on a live guest device → ignored (stays approved, no fresh claim, no new secret) | ✅ |
| GUEST-09 | Normal agent discover (authenticated AgentSession) unaffected | ✅ |

Re-run existing related suites — **all green**: `zero-touch` (61 across the 3 suites), `guest-approval-rbac`, `guests`, `agent-hardening` (28).

## Live Verification

Performed against the running backend (`http://localhost:3000`):

- `POST /api/agent/discover` **without** code → `422` "…requires an organization enrollment code…" (the exact logged failure).
- `POST /api/agent/discover` **with an invalid code** → `422` "Invalid enrollment code."
- Malformed JSON body → **`400`** after the fix (was `500`).
- **End-to-end valid guest join — 10/10 PASS** (`scripts/guest-join-e2e.mjs`, drives the agent's **real compiled** `AuthService.discoverDevice`, i.e. exactly what "Join as Guest" runs in the main process, with `WL_ENROLLMENT_CODE` provisioned):
  1. `discoverDevice` → **`pending_approval`** (HTTP 201 — **no 422**) ✅
  2. Admin sees the pending device claim in **Agent Approvals** ✅
  3. Admin approves as **guest mode** → synthesized `GUEST-4E107AC02DC6` identity, `type=guest`, ACTIVE ✅
  4. Agent `pollApproval` → PATH A device-credential auth → token issued ✅
  5. Heartbeat succeeds with the guest token (server log for the same call now reads `POST /api/agent/discover 201`, not 422) ✅
- Cleanup: the diagnostic probe device created during the investigation was removed; the verified ACTIVE guest remains visible in the admin **Guests** page.

## Final Status

| | |
|---|---|
| **ROOT CAUSE** | Running Desktop Agent build has **no org enrollment code provisioned** (baked `AGENT_CONFIG.enrollmentCode = null`; no `WL_ENROLLMENT_CODE`). "Join as Guest" = anonymous zero-touch discovery, which the server **fail-closes (422)** without a valid code — by design, not a regression. |
| **FILE** | `src/app/api/agent/discover/route.ts` (422 branch); `desktop-agent/src/config/agent-config.ts` + `desktop-agent/src/auth/auth-service.ts` (`enrollmentCodeFor`); `desktop-agent/scripts/build-prod.mjs` (bake step) |
| **FUNCTION** | `POST()` → `resolveOrgFromEnrollmentCode()` (server); `AuthService.discoverDevice()` / `enrollmentCodeFor()` (agent) |
| **API** | `POST /api/agent/discover` — requires `deviceKey` + `hostname`; anonymous new device additionally requires a valid org `enrollmentCode` |
| **FIX** | (1) Server: malformed JSON → `400` (was `500`). (2) Provision the org enrollment code into the agent build/runtime — no validation weakened |
| **TESTS** | `tests/guest-join-discover.test.ts` (GUEST-01..09, 9/9 ✅) + existing zero-touch / guests / guest-RBAC / agent-hardening suites ✅ |
| **BUILD** | `tsc --noEmit` ✅ · agent typecheck ✅ · eslint on changed files: 0 errors (1 pre-existing warning) |
| **LIVE GUEST FLOW** | **10/10 PASS** — real compiled `AuthService.discoverDevice` with the org enrollment code → `201 pending` (no 422) → admin guest approval → PATH A auth → heartbeat. Active guest `GUEST-4E107AC02DC6` verified in the admin Guests page. Server log for the valid join now shows `201`, not `422` |
| **FINAL STATUS** | **Resolved.** Root cause = the agent build had no org enrollment code provisioned (fail-closed 422 by design, no security bug). Fix = provision the code (now done for the dev agent via `WL_ENROLLMENT_CODE`) + malformed-JSON → 400 hardening + GUEST-01..09 regression suite. The 422 for a code-less anonymous device remains enforced (AH-20 / GUEST-02/03) |
