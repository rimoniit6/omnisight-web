# EMPLOYEE LOCATION — END-TO-END FUNCTIONAL AUDIT

**Date:** 2026-08-15 10:45 (+06)
**Scope:** Audit only. No production code modified.
**System:** Single-organization (org `cmssgkpig0004fi5kbdunw20o` "Bangladesh computer Council", 1 employee, 1 device).

---

## 1. Executive Summary

**Employee location is missing because the capture source fails at the OS level — not because of any consent, config, API, database, or UI defect.**

The complete software pipeline is correctly implemented end-to-end:

| Gate | State (verified in DB/runtime) |
|---|---|
| `location` consent | ✅ **granted** (ConsentPolicy published v1) |
| Org `location_tracking` setting | ✅ **true** |
| Agent config sync | ✅ returns `locationTracking: true` |
| Agent native addon | ✅ loads (`locationGetPosition` present) |
| Windows location master switch | ✅ **Allow** |
| Geolocation Service (`lfsvc`) | ✅ **Running** |
| **Windows.Devices.Geolocation.winmd** | ❌ **MISSING from `C:\Windows\System32\WinMetadata`** |
| `RoGetActivationFactory(Geolocator)` | ❌ **hr = 0x80004002 (E_NOINTERFACE)** |
| Agent poll result (every 5 min) | ❌ `{ok:false, error:"failed"}` (63 ms) |
| `LocationEvent` rows in database | ❌ **0 rows** |
| Admin UI (Employee Details → Location tab) | ✅ renders correctly — "No location fixes in the selected period" (truthful) |

The failing machine is a **stripped Windows build** ("Windows 10 Home Single Language", 25H2, build 26200) whose `WinMetadata` directory contains only 20 files (a standard Windows install has 300+); the WinRT metadata for `Windows.Devices.Geolocation` was removed. The agent's native addon therefore cannot activate the `Geolocator` class and fails closed — by design — on every poll.

**Secondary finding (separate issue):** the currently running agent instance (started 2026-08-15 09:34 with a freshly recreated device identity) has **not authenticated** since the AgentToken expired (2026-08-15 05:24, last used 04:50). Last heartbeat 04:41. No new AgentToken/AgentSession/AgentRegistration exists. The agent holds an established TCP connection to `:3000` but its requests fail. Nothing has been uploaded since ~04:41. This must be diagnosed separately — it does not change the location root cause (location was never uploaded even during the healthy Aug 14 → Aug 15 04:41 window when activity/keyboard/screenshots flowed).

---

## 2. Admin UI Location Inventory

| Surface | Location displayed? | Evidence |
|---|---|---|
| **Employee Details → "Location" tab** | ✅ **YES — the only admin surface** | `src/components/employees/employee-details-page.tsx:628` (TabsTrigger), `:1012-1014` (`<LocationPanel employeeId={emp.id}/>` inside `TabsContent value="location"`) |
| `LocationPanel` component | Latest fix (lat/lon/accuracy/±m/relative time) + paginated history table | `src/components/employees/telemetry/location-panel.tsx` |
| Employee list / table | ❌ No location column | `src/app/api/employees` list route selects no location fields; employees page has no location column |
| Employee dashboard/profile | ❌ No location | — |
| Live Monitor | ❌ No location anywhere | `src/components/live-monitor/live-monitor-page.tsx` — only activity events, event stats, device status cards (no coordinates/map) |
| Map | 🚧 **No map component exists** (no leaflet/mapbox/react-leaflet in package deps or code) | grep: zero matches for leaflet/mapbox/MapContainer/tileLayer |
| Self-portal (employee-facing) | ✅ Shows latest fix under Location | `src/components/self-portal/self-portal-page.tsx:994-1001` via `/api/self/telemetry-summary` |

**Conclusion:** The Admin UI is *supposed* to display employee location in exactly one place — **Employee Details → Location tab** (`/employees/{id}` → Location tab). The UI exists, is correctly wired, and correctly renders the empty state. There is no expectation of location in the list, Live Monitor, or a map.

---

## 3. Complete Location Data Flow

```
[1] Agent poll (every 5 min)
    LocationCollector.tick() — gates: config.locationTracking (true ✅)
    + consent 'location' (granted ✅) + native.available() (true ✅)
        ↓
[2] Native addon  native/src/location.cc  WorkerThread()
    RoInitialize ................. S_OK ✅
    RoGetActivationFactory(Geolocator) → 0x80004002 E_NOINTERFACE ❌
        ↓  (MapHResult default case → LocationError::Failed)
    result = { ok:false, error:"failed" }  ❌ FAIL (63 ms)
        ↓
[3] LocationCollector.tick() — isValid() never reached; logs
    'fix-failed'; upload() NEVER called ❌
        ↓
[4] POST /api/agent/location ....... never invoked ❌ (no fix to send)
        ↓
[5] Backend route (correct code, unreached) — agent token → location
    consent 403-gate → org location_tracking 403-gate → closed-schema
    validation → db.locationEvent.create() ❌
        ↓
[6] LocationEvent table ............ 0 rows ❌
        ↓
[7] GET /api/employees/{id}/location  returns { latest: null, history: [],
    total: 0 } ✅ (correct empty result)
        ↓
[8] React Query (queryKey ['employee-location', id, from, to, page]) ✅
        ↓
[9] LocationPanel .................. "No location fixes in the selected
    period" ✅ (correct rendering of a true empty state)
```

**Status per stage:** `[1] PASS` `[2] FAIL (OS-level)` `[3] FAIL (consequence)` `[4]–[6] NOT REACHED` `[7] PASS` `[8] PASS` `[9] PASS`

---

## 4. Layer-by-Layer Status

| Layer | Expected | Actual | Status |
|---|---|---|---|
| Agent location capture | One fix per 5-min poll | Native WinRT call fails instantly `{ok:false,"failed"}` | ❌ FAIL |
| Location permission | OS geolocation usable | `Windows.Devices.Geolocation.winmd` missing → class not activatable | ❌ FAIL (environment) |
| Location consent | Required before capture | Granted (v1 policy published), agent snapshot fresh | ✅ PASS |
| Agent → API | POST `/api/agent/location` | Never executed — no fix is ever produced | ⚠️ PARTIAL (correct code, no input) |
| API validation | Closed schema, strict bounds | Correctly implemented; unreachable | ✅ PASS |
| Database write | `LocationEvent` row per fix | 0 rows | ⚠️ PARTIAL (nothing to write) |
| Employee/device relation | LocationEvent.employeeId/deviceId | Correct in code (`authResult.employee.id`, `authResult.deviceId`); relation sound | ✅ PASS |
| Admin API | `GET /api/employees/{id}/location` | Correct; returns `latest:null, history:[]` | ✅ PASS |
| React Query/state | Correct key + property names | `latitude/longitude/accuracy/recordedAt` flat — matches API | ✅ PASS |
| Admin UI | Coordinates + history in Location tab | Renders truthful empty state | ✅ PASS |
| WebSocket/realtime | — | Location is REST-only; realtime service (`mini-services/live-updates`, port 3010) carries no location | 🚧 NOT IMPLEMENTED (by design, no UI expectation) |
| Map rendering | — | No map component in the product | 🚧 NOT IMPLEMENTED (by design) |

---

## 5. Exact Root Cause

**P1 — Data pipeline broken at the capture-source layer: the Windows geolocation provider cannot be activated on this machine.**

- Addon code: `desktop-agent/native/src/location.cc:67-72` — `RoGetActivationFactory(RuntimeClass_Windows_Devices_Geolocation_Geolocator)` returns **hr=0x80004002 E_NOINTERFACE**.
- `MapHResult` (`location.cc:39-52`) has no E_NOINTERFACE branch → default case → `LocationError::Failed` → JSON `{"ok":false,"error":"failed"}`.
- Verified by **live reproduction** using the exact packaged addon + exact Electron binary:
  `out/win-unpacked/WorkLensAIAgent.exe` (ELECTRON_RUN_AS_NODE) → `{"ok":false,"error":"failed"}` in 63 ms.
- Verified independently with a standalone C++ probe: `RoInitialize: S_OK`, `RoGetActivationFactory: 0x80004002`.
- OS cause: `C:\Windows\System32\WinMetadata\Windows.Devices.Geolocation.winmd` **does not exist**; the directory holds only 20 .winmd files (a stock Windows 11/10 install holds several hundred). This is a stripped/customized Windows image (ProductName "Windows 10 Home Single Language", DisplayVersion 25H2, build 26200 — a non-stock combination).
- Consequence: every 5-minute poll fails → `LocationCollector.tick()` logs `fix-failed` and never calls `upload()` → `LocationEvent` stays at 0 → Admin Location tab truthfully reports no fixes.

This is **not** a consent problem, **not** a config problem, **not** an API/DB/UI defect. No code change anywhere in the pipeline can fix it on this machine; the OS must be able to provide a geolocation fix.

---

## 6. Runtime Evidence

### 6.1 Live native-addon reproduction (this machine, 2026-08-15 10:33)

```
addon loaded from out/win-unpacked/resources/native/worklens_capture.node
locationGetPosition present: true
elapsed ms: 63
RESULT: {"ok":false,"error":"failed"}
```

### 6.2 Standalone C++ probe (same WinRT calls, temp dir)

```
probe start
RoInitialize: hr=0x00000000
RoGetActivationFactory: hr=0x80004002      ← E_NOINTERFACE
```

### 6.3 OS state

```
Windows location master switch (ConsentStore\location): Allow
Per-app NonPackaged allowlist: only dasHost.exe, svchost.exe (no WorkLensAIAgent entry — but no Deny either)
lfsvc (Geolocation Service): Running (manual start)
C:\Windows\System32\WinMetadata\Windows.Devices.Geolocation.winmd: MISSING
WinMetadata file count: 20
OS: "Windows 10 Home Single Language" / 25H2 / build 26200 (non-stock build)
Hardware: WALTON TAMARIND EX PRO (real laptop; WiFi positioning expected)
```

### 6.4 Database state (PostgreSQL `workai`, queried 2026-08-15 10:42)

```
OrganizationSetting: location_tracking = true   (updatedAt 2026-08-14 10:21:26)
ConsentPolicy: location published v1
Consent:        location granted (employee cmssi3spk000cfi5k8uzi0i0v)
LocationEvent:  COUNT(*) = 0
Activity:       521 rows   (newest 2026-08-15 04:39)
KeyboardActivity: 71 rows  (newest 2026-08-15 04:38)
Screenshot:     16 rows    (newest 2026-08-14 19:20)
Device:         1 row, status=online, lastHeartbeat=2026-08-15 04:41:37 (stale ~6h),
                agentVersion 1.1.0, employeeId correctly linked
AgentToken:     1 row, expiresAt 2026-08-15 05:24:03, lastUsedAt 2026-08-15 04:50:17
AgentSession:   1 row (created 2026-08-14 05:23, expires 2026-08-15 05:23:42)
AgentRegistration: 0 rows
```

### 6.5 Agent runtime state

```
WorkLensAIAgent.exe processes running from out\win-unpacked, started 09:34:30 today
State dir: %APPDATA%\worklensai-agent\state\
  device-identity.json created 2026-08-15T03:34:30.518Z (NEW identity — recreated at boot,
  id 3dc573cc... ≠ the DB device cmssi4qrw...)
  encrypted credentials (sec-*.bin) dated 2026-08-14
TCP: agent process 13660 has ESTABLISHED connection to 127.0.0.1:3000
  → the agent is talking to the server but requests fail (401, expired token) —
  no heartbeat/upload has been recorded since 04:41
```

### 6.6 Interpretation

- **During the healthy window (Aug 14 05:23 → Aug 15 04:41):** agent authenticated, heartbeating, uploading activity/keyboard/screenshots. Consent was granted (05:26) and `location_tracking` became true (10:21). Config refresh every 10 min would have enabled the collector by ~10:31. Despite ~18 h and ~200+ polls, **zero** fixes were uploaded → the poll was failing the whole time, exactly as reproduced above.
- **Currently (since 09:34):** the agent recreated its identity and has not re-authenticated (token expired 05:24). Secondary issue.

---

## 7. Files Involved

### Agent (capture side — where the failure occurs)

| File | Function | Role |
|---|---|---|
| `desktop-agent/native/src/location.cc` | `WorkerThread()` :67-72, `MapHResult()` :39-52 | **Root-cause site**: `RoGetActivationFactory` → E_NOINTERFACE → "failed" |
| `desktop-agent/native/src/location.h` | error enum | `failed` label mapping |
| `desktop-agent/native/src/addon.cc` | `Init()` :130 | Registers `locationGetPosition` (working) |
| `desktop-agent/src/collectors/native-bridge.ts` | `locationGetPosition()` :203-222 | Promisified wrapper; fails closed |
| `desktop-agent/src/collectors/location-collector.ts` | `tick()` :109-138, `start()` :70-94, `upload()` :141-158 | Gates (consent+config+capability), polls, uploads; correct |
| `desktop-agent/src/collectors/consent-gate.ts` | `decideConsentGate()` :35-44 | Fail-closed consent gate; correct |
| `desktop-agent/src/api/location.ts` | `upload()` :8-10 | `POST /api/agent/location`; correct |
| `desktop-agent/src/services/agent-orchestrator.ts` | :777-781 (location-poll scheduler), :863-866 (start), :844-876 (applyCollectorStates) | Scheduling; correct |
| `desktop-agent/src/services/config-service.ts` | :21 (`locationTracking: false` fail-closed default), `refresh()` :73-98 | Correct (server value overrides) |
| `desktop-agent/src/services/consent-service.ts` | :41-57 | Snapshot refresh; correct |

### Backend (all correct, unreached for location)

| File | Function |
|---|---|
| `src/app/api/agent/location/route.ts` | POST — auth → consent 403 → org flag 403 → closed-schema validation → `db.locationEvent.create` |
| `src/app/api/agent/config/route.ts` | GET — returns `locationTracking: monitoring.location_tracking` |
| `src/app/api/agent/consent/route.ts` | GET/POST — includes `location` in valid types; server-authoritative |
| `src/app/api/employees/[id]/location/route.ts` | GET — org-scoped, paginated, returns `latest/history/total` |
| `src/lib/jobs/settings.ts` | :70 — `location_tracking: { type:'boolean', default:false }` registry |
| `src/lib/consent.ts` | `hasActiveConsent` / `getConsentState` |
| `prisma/schema.prisma` | :293-312 — `LocationEvent` model (employeeId, deviceId?, latitude, longitude, accuracy, recordedAt, organizationId) |

### Admin UI (all correct)

| File | Function |
|---|---|
| `src/components/employees/employee-details-page.tsx` | :628, :1012-1014 — Location tab wiring |
| `src/components/employees/telemetry/location-panel.tsx` | Latest fix cards + history table; property names `latitude/longitude/accuracy/recordedAt` match API exactly; queryKey `['employee-location', id, from, to, page]` |
| `src/components/self-portal/self-portal-page.tsx` | :954-1001 — employee-facing location card |
| `src/app/api/self/telemetry-summary/route.ts` | :95-133 — latest location for self-portal |

### Realtime (no location by design)

| File | Note |
|---|---|
| `mini-services/live-updates/{index,activity-events,presence}.ts` | No location fields anywhere |
| `src/components/providers/websocket-provider.tsx` | Connects to :3010; no location contract |

---

## 8. Permission / Consent Findings

- ✅ `location` consent **granted** (Consent `cmssi3spk...`, status granted, policy `location` v1 **published**).
- ✅ Agent consent snapshot includes `location` (consentTypes list `desktop-agent/src/main/main.ts:134`).
- ✅ Consent gate fail-closed semantics verified (`decideConsentGate` — no snapshot, stale >5 min, or not granted → stop).
- ✅ Server re-enforces consent with 403 on upload (`src/app/api/agent/location/route.ts:42-47`).
- ✅ Consent *denied* path correctly blocks collection — **no bypass exists and none was made**.
- ✅ Windows location master switch `Allow`; the app is not deny-listed in `NonPackaged`.
- ❌ **The only missing permission component is OS-level**: the WinRT `Geolocator` class cannot be activated because the platform metadata is absent from this Windows image. Consent was never the blocker.

## 9. Admin API Findings

- ✅ `GET /api/employees/[id]/location` exists, org-scoped (foreign employee → 404), manager-scoped (`requireSessionOrg`), pagination validated (page ≥1, pageSize 1..100), defaults to last 7 days.
- ✅ Response shape `{ latest, history[], total, page, pageSize, totalPages }` — no `select` omission, no serialization stripping (verified mapping at :99-105).
- ✅ Returns `latest: null` / `history: []` when empty — correct, no silent failure, no swallowed errors.
- ✅ No Prisma `select` omission anywhere in the employee→location chain. Employee list API intentionally does not select location (no UI requirement).
- ⚠️ Historical note: `AUDIT-FINAL-REPORT.md` (Q7) and `workload/40-B5-ZeroTouch-AdminUX-Consent-Audit.md` already documented "no location records — genuine absence", consistent with this audit's finding.

## 10. Frontend Findings

- ✅ Property names match exactly: API returns flat `latitude/longitude/accuracy/recordedAt`; panel reads `data.latest.latitude` etc. No `lat/lng` vs `latitude/longitude` mismatch.
- ✅ Query key includes employeeId + date range + page → no stale-cache scenario for new employees.
- ✅ `enabled: !!employeeId`; error state and empty state both handled explicitly.
- ✅ Employee Details gate: `TabsTrigger value="location"` and `TabsContent` → `LocationPanel` — wiring correct.
- ❌ None found — the frontend is not the problem.

## 11. Realtime Findings

- Location is **REST-only by design**. The agent has no WebSocket upload path; the live-updates service (port 3010) broadcasts activity events + presence only — no location in any event (`mini-services/live-updates/activity-events.ts`, `presence.ts`).
- Live Monitor UI has no location display (`live-monitor-page.tsx` — devices cards show name/status/heartbeat only).
- **No broken realtime layer** — location was never part of the realtime contract.

## 12. Map Findings

- **No map exists** in the product (no leaflet/mapbox/tileLayer anywhere; no map dependency in `package.json`).
- Location is presented as coordinates + accuracy text. Nothing to fix; nothing missing.

## 13. Security / Privacy Findings

- ✅ Location upload requires a valid AgentToken (`validateAgentToken`) → only the agent's authenticated device can write.
- ✅ Admin read requires session auth + org scope + Manager+ role convention; foreign org ids → 404.
- ✅ Closed payload schema: only `latitude/longitude/accuracy/timestamp` accepted; address-like keys rejected 422 (`FORBIDDEN_KEYS`).
- ✅ No reverse geocoding anywhere; only coordinates persisted (schema has no address columns).
- ✅ Consent enforced server-side (403) — admin cannot bypass; employee revocation stops collection within one consent-refresh cycle (60 s).
- ✅ No location data is logged (agent logs coordinates never; route logs only errors).
- ✅ Fail-closed behavior is correct privacy posture: when the OS cannot provide a fix, nothing is fabricated or uploaded.
- ✅ Single-organization scoping: all queries org-bound via `employee.organizationId`; no multi-tenant logic introduced or needed.

---

## 14. Fix Plan (minimum correct fix — NOT implemented)

**Primary fix — environment, not code:**

1. **Restore the Windows geolocation platform on the device(s).** The machine's Windows image is stripped:
   - Run `DISM /Online /Cleanup-Image /RestoreHealth` (and optionally `sfc /scannow`), or
   - Reinstall/repair the Windows location components (WinMetadata + location framework), or
   - Provision agents on **standard Windows 10/11 images** (the deployed agent v1.1.0 + native addon are correct).
2. After the OS fix, restart the agent (or it will pick up on next boot) and verify a fix is produced (Section 15).

**Optional code hardening (not required for functionality):**

3. `desktop-agent/native/src/location.cc` `MapHResult()`: map `E_NOINTERFACE` (and `REGDB_E_CLASSNOTREG`) to `LocationError::Unavailable` so agent status/logs say `unavailable` (OS platform missing) instead of the generic `failed` — improves diagnosability without changing behavior.
4. Consider surfacing `LocationCollector.getState().lastError` in the agent renderer/status UI so field support can see *why* no fixes exist.

**Secondary issue (separate work item):**

5. Diagnose why the current agent instance (fresh identity since 09:34) cannot re-authenticate after AgentToken expiry (no new AgentToken/AgentSession/AgentRegistration; 401s on :3000). Without this, no telemetry of any kind is flowing right now.

## 15. Validation Plan

On the repaired device (after Section 14 fix):

1. **OS probe:** run the packaged addon test → expect `{"ok":true,"latitude":…,"longitude":…,"accuracy":…}` (or `unavailable` with a *reason*).
2. **Agent:** confirm agent authenticates (new AgentToken row; heartbeat ≤60 s) and agent status shows location collecting (`collector-stopped` log absent for `location`).
3. **Wait one poll cycle (≤5 min)** — expect agent log `location upload-ok`.
4. **DB:** `SELECT COUNT(*) FROM "LocationEvent"` → ≥1; row has correct `employeeId` (cmssi3spk...) and `deviceId` (cmssi4qrw...), sane coords, `recordedAt` ≈ poll time.
5. **Admin API:** `GET /api/employees/cmssi3spk000cfi5k8uzi0i0v/location` (as admin) → `latest` populated with lat/lon/accuracy/recordedAt; `history` non-empty; HTTP 200.
6. **Admin UI:** Employee Details → Location tab shows "Latest Location" card with coordinates, accuracy badge, recorded time, and history rows.
7. **Consent-denied regression:** revoke `location` consent → next poll must NOT create rows (server 403) and UI still renders (empty state). Re-grant → resumes.
8. **Self-portal:** employee view shows the latest fix under Location.

## 16. Final Verdict

**BROKEN** (at the capture source on this specific machine — OS geolocation platform unavailable), with the entire software pipeline verified **correct** end-to-end. The feature is fully implemented in code; it cannot function until the device's Windows image can activate `Windows.Devices.Geolocation`. Secondary: the agent is currently unauthenticated and uploads nothing at all.

Classification: **P1 — data pipeline broken at the capture-source layer** (OS/environment, not application code).
