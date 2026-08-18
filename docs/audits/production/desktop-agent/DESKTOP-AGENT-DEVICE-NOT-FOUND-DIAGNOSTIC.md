# WorkLensAI Desktop Agent — "Device not found" Root-Cause Diagnostic

**Date:** 2026-08-13
**Agent:** v1.1.0 (zero-touch / PATH A, with P2-1 at-rest encryption active)
**Mode:** Diagnostic-only. **No source code modified. No database modified. No local state touched.**

---

## 1. Executive Summary

```
Agent Device Not Found Diagnostic

Status:
ROOT CAUSE IDENTIFIED

Primary Cause:
A — STALE LOCAL AGENT STATE
The agent holds a persisted zero-touch claim credential (deviceId + one-time
secret, DPAPI-encrypted, written 2026-08-12) for a device that NO LONGER
EXISTS in the server database. The current server DB (workai) contains ZERO
Device, DeviceClaim and AgentToken rows. Every re-authentication attempt with
the stale credential returns HTTP 404 "Device not found".

Secondary Cause:
B — MISSING DB DEVICE RECORD (immediate trigger of the 404)
The server-side DeviceClaim lookup in POST /api/agent/authenticate finds no
claim for the stored deviceId (the device/claim/token rows were deleted or the
DB was reset after the agent enrolled), so the route returns
404 {"error":"Device not found"} — the exact string the UI displays.

Contributing (UI): J — UI error classification bug (minor)
The heading "Unable to reach the WorkLensAI server" is shown for ANY auth
"error" phase — including a genuine, server-answered 404. The server IS
reachable; the message is misleading. The body text ("Device not found") is
accurate.
```

The server is **reachable** (this diagnostic's live probe and the server log prove it). The failure is a **server-side 404 device lookup**, not a network failure.

---

## 2. Exact Error Flow

```
Agent startup (Electron → orchestrator.initialize)
  ↓ auth.load()                      ← reads local state
  ↓   stored agent.token    → 'authenticated'/'expired'
  ↓   stored agent.claim    → zero-touch PATH A credential (deviceId + secret)
  ↓   stored agent.session  → Phase 3 login session
  ↓ (no legacy agent.credentials blob — zero-touch, not PATH B)
  ↓ token unusable (expired) OR heartbeat 401 (token row gone from DB)
  ↓ recover() → claim.secret present → authenticateDevice(claim.deviceId, claim.secret)
  ↓
POST /api/agent/authenticate { deviceId: <stored>, deviceSecret: <stored> }
  ↓ server: DeviceClaim.findFirst({ where: { deviceId } })  →  NULL
  ↓
HTTP 404  {"error":"Device not found"}          (authenticate route)
  ↓ classifyError: 404 → errorKind='credentials', phase='error', lastError='Device not found'
  ↓
Renderer: phase 'error' → offline view
  ↓ heading  "Unable to reach the WorkLensAI server"   (generic error-phase label)
  ↓ body     "Device not found"                         (server-derived lastError)
  ↓
Auto-retry loop: heartbeat 401 / authenticate 404 repeats (no recovery from stale claim)
```

---

## 3. Source Locations

| Component | File | Function | Finding |
|---|---|---|---|
| UI heading | `desktop-agent/src/renderer/renderer.ts` | `onboardingView()` / `ONBOARDING_LABELS['offline']` | `phase==='error'` → offline view; heading "Unable to reach the WorkLensAI server" is a **generic label**, not a network verdict |
| UI body | `desktop-agent/src/renderer/renderer.ts` | `renderOnboardingView()` (offline branch) | Shows `auth.lastError` when `errorKind !== 'network'` → "Device not found" |
| Agent error classification | `desktop-agent/src/auth/auth-service.ts` | `classifyError()` | `status===404` → `errorKind='credentials'`, `phase='error'`, `lastError=apiErr.message` |
| Agent re-auth | `desktop-agent/src/auth/auth-service.ts` | `recover()` | With stored claim secret → always `authenticateDevice()`; **no stale-claim recovery on 404** |
| Agent re-auth | `desktop-agent/src/auth/auth-service.ts` | `authenticateDevice()` | 404 not mapped to pending/rejected/revoked; falls to `classifyError` → permanent error loop |
| Agent startup | `desktop-agent/src/services/agent-orchestrator.ts` | `initialize()` | 'expired' → `recover()`; 'unregistered' → `discoverDevice()` (only reached when NO claim/cred exists) |
| API | `src/app/api/agent/authenticate/route.ts` | `authenticateDevice()` (PATH A) | `deviceClaim.findFirst({ where: { deviceId } })` → null → **404 "Device not found"** (line ~280) |
| API (alternative) | `src/app/api/agent/discover/route.ts` | `POST` | 404 "Device not found" only for AUTHENTICATED discovers (DENIED: cross-org/employee mismatch) — **not the executing path** |
| DB | `prisma/schema.prisma` | Device / DeviceClaim / AgentToken | Current DB: 0 devices, 0 claims, 0 tokens |

---

## 4. Runtime Evidence

```
HTTP status:     404 (live probe: POST /api/agent/authenticate, unknown deviceId
                 → {"error":"Device not found"})
Error code:      (none — JSON error body, no machine code)
Endpoint:        POST /api/agent/authenticate (PATH A device-credential path)
Request flow:    Agent (local, stale claim) → /api/agent/authenticate → claim
                 lookup miss → 404 → agent classifies 'credentials' error → retry
Server log:      /tmp/next-dev.log tail —
                   POST /api/agent/heartbeat 401
                   POST /api/agent/authenticate 404
                   POST /api/agent/activity 401
                   POST /api/agent/authenticate 404   ← the agent looping right now
DB state:        workai → Device=0, DeviceClaim=0, AgentToken=0;
                 local agentKey 11666fac… has NO device row
Local Agent:     device-identity.json (id 11666fac…, created 2026-08-13 09:45Z);
                 3 DPAPI secure blobs: agent.session (08-11), agent.token (08-12),
                 agent.claim (08-12) — claim + token reference a deleted device;
                 at-rest key + WLENC1-encrypted queue present (P2-1 active)
```

Redaction note: no tokens, secrets, claim secrets, or enrollment codes were printed or decrypted. Only truncated/hashed identifiers and file **presence** were used.

---

## 5. Identity Comparison

```
Local device (agentKey):  11666fac0150…  (device-identity.json)
DB device (by agentKey):  NOT FOUND — server DB has ZERO Device rows
Local claim:              present (DPAPI blob agent.claim, written 08-12)
DB claim (by deviceId):   NOT FOUND — DeviceClaim count = 0
Local token:              present (DPAPI blob agent.token, written 08-12)
DB token:                 NOT FOUND — AgentToken count = 0
Employee:                 UNKNOWN — no device row to join on (nothing to compare)
Organization:             UNKNOWN — no device row to join on
Enrollment:               STALE — claim/secret no longer resolvable server-side
```

Conclusion: **Local device does not match DB** (DB record absent). **Token ↔ device / employee ↔ device / organization ↔ device: not comparable** — the DB has no records at all.

---

## 6. Registration / Enrollment Flow

```
Registration method:   Zero-touch PATH A (claim credential) — no agent.credentials
                       blob exists; agent.session blob indicates a Phase 3 login
                       was also used at some point.
Enrollment state:      Locally complete (claim + secret + token persisted),
                       server-side GONE (deleted/reset after enrollment).
Device creation:       The device was created previously (claim/token written
                       2026-08-12 21:02 local) and its rows no longer exist.
Credential state:      Stored, DPAPI-encrypted, intact locally — but orphaned.
```

The exact deletion mechanism (probe-org cleanup, DB reset, or admin deletion) cannot be determined from available evidence; the current DB is simply empty of all agent records. The local state predates the current DB state.

---

## 7. P2-3 Regression Assessment

```
P2-3 hardening caused this:
NO
```

Why: P2-3 changed **anonymous discover** (removed first-org fallback; enrollment code required). The failing request is **`/api/agent/authenticate`** — a PATH A re-authentication of a stored claim — whose 404 behavior is **pre-existing** (claim lookup miss → 404) and was **not changed** by hardening. The agent never reaches anonymous discover here: `recover()` finds a stored claim secret and goes straight to `authenticateDevice()`. P2-3 is orthogonal to this failure.

The stale-claim-no-recovery gap (`recover()` treats a 404 as a generic 'credentials' error and retries forever instead of clearing the orphaned claim and re-enrolling) is a **pre-existing agent lifecycle limitation**, not a hardening regression. Note that P2-3's removal of the first-org fallback does mean that a *fresh* anonymous re-enrollment now requires an admin-issued enrollment code (`WL_ENROLLMENT_CODE`) — relevant to the recommended fix (§10), but not the cause of the current 404.

---

## 8. UI Error Classification

```
Network failure:      NO — the server responded with a definitive HTTP 404
Server reachable:     YES — live probe + server log both show successful HTTP
                      round-trips from the agent to this server
Device lookup failure:YES — the 404 comes from the DeviceClaim lookup in
                      /api/agent/authenticate
UI message accurate:  NO — the heading "Unable to reach the WorkLensAI server"
                      implies a connectivity problem, but the actual condition is
                      a server-side "device does not exist" answer. The BODY text
                      ("Device not found") is accurate.
```

Classification detail: the renderer treats any `auth.phase === 'error'` as the "offline" view. `classifyError()` maps **both** 404 and 401 to `errorKind='credentials'`, which the renderer deliberately displays verbatim in the body — but the heading stays the generic network-flavored label.

---

## 9. Root Cause

**Primary: STALE LOCAL AGENT STATE (A).** The agent v1.1.0 retains a zero-touch claim credential (deviceId + one-time secret) and an AgentToken for a device whose server-side rows no longer exist. On every startup/recovery it re-authenticates that device and receives `404 Device not found`, and it has no automatic path from that state back to a fresh enrollment (`recover()` prefers the stale claim; nothing clears it on 404).

**Immediate trigger: MISSING DB DEVICE RECORD (B).** The current `workai` DB has zero Device/DeviceClaim/AgentToken rows, so the claim lookup in `/api/agent/authenticate` returns null → 404 → the UI shows "Device not found".

**Contributing: UI misclassification (J).** The "Unable to reach the WorkLensAI server" heading is a generic error-phase label shown for server-answered 4xx responses, implying a network problem that does not exist.

---

## 10. Recommended Fix (NOT IMPLEMENTED — diagnostic only)

### 10.1 What should change

**Agent side (primary):** `AuthService.authenticateDevice()` (or `recover()`) should treat a **404 "Device not found" from PATH A authentication as an orphaned-credential signal**, not a persistent 'credentials' error:
- Clear the stale claim (`store.delete(KEY_CLAIM)` / `KEY_TOKEN`) and transition to `unregistered`, so the orchestrator immediately runs a fresh zero-touch discovery (new device row + new claim) instead of looping on 404.
- This mirrors the existing handling of `expired` claims and keeps the current security posture (no auto-creation of devices against an arbitrary org — a fresh discover still requires the org's enrollment code per P2-3).

**Agent side (supporting):** differentiate the renderer message:
- In `classifyError()` or the renderer's offline branch, distinguish "server answered a definitive 4xx" from "could not reach the server" (`status === 0`), and pick an accurate heading/body (e.g. "Device registration is out of date — reconnecting…" vs. the current network-flavored label). This is a UI-text-only change; it must not weaken the network/offline classification used for retry behavior.

### 10.2 Where

- `desktop-agent/src/auth/auth-service.ts` — `authenticateDevice()` catch block (404 branch), `recover()`.
- `desktop-agent/src/renderer/renderer.ts` — offline-view heading selection.
- No server-route change required: the 404 is correct behavior for an unknown device (it must NOT auto-create or fall back to a first org — that would reintroduce the P2-3 vulnerability).

### 10.3 Security implications
- The fix must NOT weaken device authentication, add auto-registration to an arbitrary tenant, or trust client `organizationId`. A fresh discover must still resolve the org server-side (enrollment code / authenticated session). The proposed 404-handling only clears *local orphaned state* and triggers the existing, org-scoped discover flow — security-neutral.
- The existing 404 concealment semantics on `/api/agent/authenticate` (unknown device indistinguishable from foreign device) must remain untouched.

### 10.4 Backward compatibility
- Any previously working device is unaffected: its claim/secret/token still resolve, so `authenticateDevice` succeeds and the 404 branch never fires.
- Only devices whose server rows were deleted/reset transition from a stuck error loop to a clean re-enrollment. With P2-3 in effect, that re-enrollment requires `WL_ENROLLMENT_CODE` (or a Phase 3 login) — operators should provision it before deploying the fix.

### 10.5 Test requirements
- Regression tests: stored claim + token with **no server DeviceClaim** → `authenticateDevice` 404 → agent transitions to `unregistered` and issues a fresh discover (with enrollment code) rather than staying in 'error'.
- Store-clearing behavior: the orphaned claim/token are deleted only on a confirmed 404, never on network failure (401/timeout must retain data per F-01).
- Renderer: assert the heading for a server-answered 404 differs from a true network failure, with `errorKind` plumbing verified.

---

## Final Output

```
DESKTOP AGENT DEVICE DIAGNOSTIC

Source modified:
NO

Database modified:
NO

Primary root cause:
Stale local agent state — the agent holds a zero-touch claim credential +
token for a device that no longer exists in the server DB (which currently
has zero Device/DeviceClaim/AgentToken rows). Re-auth of the stale deviceId
returns HTTP 404 "Device not found".

Secondary cause:
Missing DB device record (immediate 404 trigger) + UI misclassification
(generic "Unable to reach the WorkLensAI server" heading shown for a
server-answered 404).

Server reachable:
YES

Failing endpoint:
POST /api/agent/authenticate (PATH A device-credential path)

HTTP status:
404

Error code:
(error body) "Device not found"

Device exists in DB:
NO (server DB has 0 devices; local agentKey 11666fac… not found)

Local device matches DB:
NO

Token matches device:
UNKNOWN (local token blob present, written 08-12; no DB token row exists)

Employee matches:
UNKNOWN (no device row to join on)

Organization matches:
UNKNOWN (no device row to join on)

Enrollment valid:
NO (stale — claim/secret unresolvable server-side)

P2-3 regression:
NO (the failing authenticate-404 path is pre-existing and unchanged;
P2-3 affects anonymous discover, which the agent never reaches while the
stale claim exists)

UI error classification correct:
NO (heading implies network failure; server reachable and answered 404;
body text "Device not found" is accurate)

Recommended fix:
Agent-side: on a confirmed 404 from authenticateDevice, clear the orphaned
local claim/token and transition to unregistered so a fresh, org-scoped
zero-touch discovery (enrollment code required) re-enrolls the device —
instead of looping on 404. UI-side: pick an accurate heading for
server-answered 4xx vs. genuine network failure. Do NOT change the server
404, add auto-registration, or restore any first-org fallback.

Confidence:
HIGH
```
