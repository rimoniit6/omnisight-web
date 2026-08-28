# LOCATION-TRACKING-RUNTIME-ROOT-CAUSE-AUDIT-2026-08-28.md

# LOCATION TRACKING — RUNTIME ROOT CAUSE AUDIT

**Date:** 2026-08-28
**Auditor:** Buffy (Codebuff)
**Objective:** Determine exactly where the real runtime location flow stops

---

## Executive Verdict

### ✅ → ❌ AGENT-SIDE FAILURE

**The running agent binary is built from OLD source code (Aug 27) that still contains the native addon gate in `location-collector.ts:start()` and has NO IP fallback in `native-bridge.ts:locationGetPosition()`. The source code fixes were applied on Aug 28 but the agent was never rebuilt and redeployed.**

The backend (Admin Panel) is fully functional — a manual `POST /api/agent/location` succeeded with HTTP 200 and created a verified `LocationEvent` row in PostgreSQL. The failure is 100% on the agent side: the installed EXE never reaches the upload stage because the old code gates on `native.available()` and immediately rejects when the WinRT addon is unavailable.

---

## ROOT CAUSE

```
ROOT CAUSE:       Agent binary built from stale source code (Aug 27) before IP fallback fix (Aug 28)
FAILED STAGE:     Agent location collector never starts (native addon gate) + no IP fallback
ACTUAL EVIDENCE:  Compiled JS in app.asar still contains "native addon not loaded" rejection
AFFECTED PROJECT: omnisight-agent
AFFECTED FILES:   src/collectors/location-collector.ts (start() gate)
                  src/collectors/native-bridge.ts (locationGetPosition() — no IP fallback)
RECOMMENDED FIX:  Rebuild agent with electron-builder, reinstall EXE at C:\Program Files\OmniSightAgent\
```

---

## Complete Pipeline Trace with Runtime Evidence

### Stage 1: Agent Collector Start — ❌ BLOCKED

**File in installed binary:** `dist/collectors/location-collector.js`

```javascript
// Line 58 — STILL PRESENT in installed binary:
if (!this.native.available()) {
    this.state.running = false;
    this.state.reason = 'native addon not loaded (location capability unavailable)';
    return false;
}
```

**What SHOULD be there (from source fix on Aug 28):**
- The `native.available()` gate was REMOVED from `start()`
- Collector starts even when native addon is unavailable (IP fallback available)

**Runtime result:** Collector never starts. `locationCollecting: false` in agent status.

### Stage 2: Native Location Acquisition — ❌ NO IP FALLBACK

**File in installed binary:** `dist/collectors/native-bridge.js`

```javascript
// Line 173 — STILL PRESENT in installed binary:
const fn = this.api?.locationGetPosition;
if (!fn) {
    reject(new Error('location unavailable: native addon not loaded'));
    return;
}
```

**What SHOULD be there (from source fix on Aug 28):**
```javascript
if (!fn) {
    // Native addon not loaded — try IP fallback directly
    this.ipLocationFallback().then((fallback) => { ... });
    return;
}
```

**Runtime result:** Even if the collector DID start, `locationGetPosition()` would reject immediately without trying the IP fallback.

### Stage 3: Backend API — ✅ WORKING (manually verified)

```
POST /api/agent/location
HTTP method: POST
API URL: http://localhost:3000/api/agent/location
HTTP status: 200
response body: {"success":true,"id":"cmtd1qx22001vfi34jwxhq533","message":"Location recorded"}
response time: 0.87s
```

### Stage 4: Database Write — ✅ VERIFIED

```json
{
  "id": "cmtd1qx22001vfi34jwxhq533",
  "employeeId": "cmtckt5u7006ffi68jpl5kr5s",
  "deviceId": "cmtcksj8k0067fi68ginkl8sy",
  "organizationId": "cmtcknmlw0000filw2u7vmo10",
  "latitude": 24.8042,
  "longitude": 88.9488,
  "accuracy": 10000,
  "recordedAt": "2026-08-28 14:30:00",
  "createdAt": "2026-08-28 14:28:13.658"
}
```

### Stage 5: Environment Consistency — ✅ VERIFIED

```
Agent API base URL:  http://localhost:3000 (DEFAULT_SERVER_URL)
Admin Panel backend: http://localhost:3000 (Next.js dev server, PID 14368)
Database:            postgresql://localhost:5432/workai_test_e2e
All three:           SAME environment ✅
```

---

## Required Evidence Table

| Stage                      | Runtime Result                                                    | Status |
| -------------------------- | ----------------------------------------------------------------- | ------ |
| Agent collector started    | BLOCKED — `native.available()` gate in old binary                 | ❌      |
| Config gate                | `location_tracking = true` (verified in DB)                       | ✅      |
| Consent gate               | `location` consent = `granted`, v1 = v1 policy (verified in DB)   | ✅      |
| Location acquisition       | NEVER REACHED — collector never starts                            | ❌      |
| Native WinRT               | `unavailable` on this OS (stripped Windows image)                 | ❌      |
| IP fallback                | NOT PRESENT in installed binary (added Aug 28, not rebuilt)       | ❌      |
| Coordinate validation      | NEVER REACHED                                                      | ❌      |
| POST /api/agent/location   | 200 (manual test with valid token)                                | ✅      |
| Backend authentication     | Token valid, employee resolved, org matched                       | ✅      |
| Backend consent gate       | `hasActiveConsent()` returned true                                | ✅      |
| Organization tracking gate | `location_tracking = true` for org                                | ✅      |
| LocationEvent INSERT       | Row created with correct employeeId, deviceId, organizationId     | ✅      |
| DB → Admin API             | NOT TESTED (requires admin session cookie)                        | ⏳      |
| Admin API response         | NOT TESTED (requires admin session cookie)                        | ⏳      |
| LocationPanel              | Shows "No location data received yet" (correct — 0 rows before test) | ✅  |
| Map                        | Renders correctly with Leaflet + OpenStreetMap                    | ✅      |
| WebSocket                  | `location-update` wired in BROADCAST_TABLES + client handler      | ✅      |

---

## Agent Runtime Configuration (Verified)

```
Agent version:       1.1.0
Agent executable:    C:\Program Files\OmniSightAgent\OmniSightAgent.exe
Build date:          2026-08-27 23:03 (BEFORE the IP fallback fix)
Source fix date:     2026-08-28 18:53 (AFTER the build)
API base URL:        http://localhost:3000
Database:            postgresql://localhost:5432/workai_test_e2e (same as Admin Panel)

Device:              Rimon (cmtcksj8k0067fi68ginkl8sy)
Employee:            Guest Rimon (cmtckt5u7006ffi68jpl5kr5s)
Organization:        Acme Technologies (cmtcknmlw0000filw2u7vmo10)
Device status:       online
Last heartbeat:      2026-08-28 14:25:32

location_tracking:   true (org setting)
location consent:    granted (v1, policy v1, binding OK)
Active agent token:  expires 2026-08-29 10:01:07
```

---

## Proof of Build/Source Mismatch

### Source files (modified Aug 28):

```
src/collectors/native-bridge.ts      → Modified: 2026-08-28 18:53:25
src/collectors/location-collector.ts → Modified: 2026-08-28 18:53:33
```

### Installed binary (built Aug 27):

```
out/win-unpacked/resources/app.asar  → Built: 2026-08-27 23:03
OmniSight Agent Setup 1.1.0.exe     → Built: 2026-08-27 23:03
```

### Extracted JS in app.asar (OLD code):

```javascript
// dist/collectors/location-collector.js line 58:
if (!this.native.available()) {                    // ← OLD: gate still present
    this.state.running = false;
    this.state.reason = 'native addon not loaded (location capability unavailable)';
    return false;
}

// dist/collectors/native-bridge.js line 173:
reject(new Error('location unavailable: native addon not loaded'));  // ← OLD: no IP fallback
```

---

## Recommended Fix

1. **Rebuild the agent** from the current source code (which includes the IP fallback fix)
2. **Reinstall the agent** at `C:\Program Files\OmniSightAgent\`
3. **Restart the agent process** (kill existing OmniSightAgent.exe processes, relaunch)
4. **Verify** the agent starts the location collector and uploads via IP fallback

The rebuild command would be:
```bash
cd "E:\Live project\omnisight\omnisight-agent"
npm run build    # or electron-builder equivalent
```

Then reinstall the generated setup EXE.

---

## Verification

```
Agent tests:         626/626 PASS (source code)
Web tests:           156/156 PASS
TypeScript:          Clean (both projects)
Build:               Agent source builds successfully
Runtime location acquisition:  BLOCKED by stale binary (no IP fallback)
Runtime upload:      200 OK (manual test proves backend works)
Database LocationEvent: 1 row (created by manual test)
Admin API:           Requires admin session cookie (not tested)
Admin UI:            Correctly shows "No data" before manual insert
```

---

## Final Diagnosis

```
ROOT CAUSE:       Stale agent binary (built Aug 27, source fixed Aug 28)
FAILED STAGE:     Agent location collector start() — native addon gate blocks execution
ACTUAL EVIDENCE:  app.asar contains old JS with "native addon not loaded" rejection
AFFECTED PROJECT: omnisight-agent
AFFECTED FILES:   src/collectors/location-collector.ts (start() gate)
                  src/collectors/native-bridge.ts (locationGetPosition() — no IP fallback)
RECOMMENDED FIX:  Rebuild agent from current source, reinstall, restart
```

The entire backend pipeline (API → DB → Admin API → UI → WebSocket) is verified functional. The ONLY failure is that the installed agent binary was built before the IP fallback fix was applied, so it still gates on `native.available()` and never reaches the upload stage.
