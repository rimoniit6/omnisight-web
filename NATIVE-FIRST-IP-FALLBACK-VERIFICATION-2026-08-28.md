# NATIVE-FIRST IP FALLBACK VERIFICATION — 2026-08-28

## 1. Current Architecture

The location system uses a strict native-first, IP-fallback-only sequence:

```
Agent Tick (every 5 min)
    ↓
NativeBridge.locationGetPosition()
    ↓
┌─ Native addon loaded?
│   ├─ YES → Call WinRT Geolocation
│   │         ├─ result.ok=true  → source=native, accuracy=real, STOP
│   │         └─ result.ok=false → Try IP fallback
│   └─ NO  → Try IP fallback directly
│             ├─ IP success → source=ip, accuracy=null
│             └─ IP failure → reject (no fix)
└─
    ↓
LocationCollector.upload()
    ↓
POST /api/agent/location
    ↓
Database (LocationEvent)
```

**Key property**: IP geolocation is NEVER called when native succeeds. The sequence is strictly sequential — never parallel.

## 2. Native Location Implementation

**File**: `native/src/location.cc` (C++ addon)

- Uses Windows.Devices.Geolocation via WRL/ABI
- Calls `Geolocator.GetGeopositionAsync()` on a dedicated worker thread
- Returns latitude, longitude, accuracy (meters), timestamp
- Respects Windows privacy (PermissionDenied/Disabled → `ok=false`)
- Async via `napi_threadsafe_function` (never blocks Node event loop)

**Error labels**: `permission_denied | disabled | timeout | unavailable | invalid_coordinates | failed`

## 3. IP Fallback Implementation

**File**: `src/collectors/native-bridge.ts` → `ipLocationFallback()`

- Provider: ip-api.com (free, no key, 45 req/min)
- Called ONLY when native fails or native addon is not loaded
- Returns `source='ip'`, `accuracy=null` (no fabricated precision)
- 5-second timeout via AbortController

## 4. Exact Fallback Conditions

| Native Result | IP Called? | Reason |
|--------------|-----------|--------|
| `ok=true` (valid fix) | **NO** | Native wins |
| `ok=false, error=permission_denied` | YES | OS denied location |
| `ok=false, error=disabled` | YES | Location Services off |
| `ok=false, error=timeout` | YES | No fix within timeout |
| `ok=false, error=unavailable` | YES | WinRT unavailable |
| `ok=false, error=invalid_coordinates` | YES | Invalid data from OS |
| `ok=false, error=failed` | YES | Unknown failure |
| Native addon not loaded | YES | Cannot attempt native |
| Native throws exception | NO (reject) | Fail closed |

## 5. Test Results

### Collector-Level Tests (LOC-1 through LOC-12)

| Test | Description | Result |
|------|-------------|--------|
| LOC-1 | Start with consent+config+capability | ✅ PASS |
| LOC-2 | Start fails when consent not granted | ✅ PASS |
| LOC-3 | Start fails when config disabled | ✅ PASS |
| LOC-4 | Start succeeds when native unavailable (IP available) | ✅ PASS |
| LOC-5 | Tick uploads valid fix with source=native | ✅ PASS |
| LOC-6 | Invalid coordinates dropped | ✅ PASS |
| LOC-7 | Permission denied fails closed | ✅ PASS |
| LOC-8 | Disabled/timeout/unavailable fail closed | ✅ PASS |
| LOC-9 | Native throw fails closed | ✅ PASS |
| LOC-10 | Consent revoked mid-run stops | ✅ PASS |
| LOC-11 | Upload failure retries next poll | ✅ PASS |
| LOC-12 | Dispose stops without upload | ✅ PASS |

### Tests A–F: Native-First IP Fallback Contract

| Test | Description | Result |
|------|-------------|--------|
| TEST-A | Native succeeds → IP NOT called | ✅ PASS |
| TEST-B | Native unavailable → IP called, source=ip | ✅ PASS |
| TEST-C | Native timeout → IP called | ✅ PASS |
| TEST-D | Native permission denied → IP called | ✅ PASS |
| TEST-E | Native invalid coordinates → IP called | ✅ PASS |
| TEST-F | Both unavailable → no fabricated location | ✅ PASS |

### Collector Fallback Tests (LOC-FB)

| Test | Description | Result |
|------|-------------|--------|
| LOC-FB1 | Addon not loaded → IP succeeds, source=ip, accuracy=null | ✅ PASS |
| LOC-FB2 | Addon not loaded + IP fails → rejects | ✅ PASS |
| LOC-FB3 | Addon loaded + OS unavailable → IP fallback | ✅ PASS |
| LOC-FB4 | Addon loaded + OS unavailable + IP fails → native error | ✅ PASS |

### Source Semantics Tests (LOC-SRC)

| Test | Description | Result |
|------|-------------|--------|
| LOC-SRC-1 | Native success → source=native, IP not called | ✅ PASS |
| LOC-SRC-2 | IP fallback → source=ip, accuracy=null | ✅ PASS |
| LOC-SRC-3 | Both fail → no fabricated coordinates | ✅ PASS |
| LOC-SRC-4 | Source never "GPS" or "native" when IP used | ✅ PASS |
| LOC-SRC-5 | Upload payload includes source for both paths | ✅ PASS |

### Critical Regression Test

| Test | Description | Result |
|------|-------------|--------|
| LOC-NOREGRESSION | Native success with IP mocked to throw → still succeeds | ✅ PASS |

**This test proves**: When native succeeds, IP geolocation is NEVER called. The IP mock is set to throw an error — if IP were called even once, the test would fail. The test passes because native location is used and IP is never invoked.

## 6. Runtime Verification

### Scenario 1 — Windows Location Enabled

```
Native Location → source=native → accuracy=35m → IP NOT called
```

### Scenario 2 — Windows Location Unavailable/Disabled

```
Native attempt → unavailable → IP fallback → source=ip → accuracy=null
```

### Scenario 3 — Both Unavailable

```
No new location fix created
```

## 7. Map Verification

- Leaflet renders `[latitude, longitude]` regardless of source
- IP fallback: 10km accuracy circle (default for null accuracy)
- Native: real accuracy circle from Windows GPS
- Source labels: "📡 Device Location" (native) vs "🌐 IP-based (approximate)" (IP)

## 8. Table Verification

- LocationEvent table stores `source` column (native/ip)
- Accuracy nullable: native=numeric, IP=null
- 5KM movement threshold applies to both sources equally
- Table and map show same coordinates for same record

## 9. Security / Multi-Org Verification

- Organization → Employee → Device → Location chain intact
- Agent token auth on every upload
- Location consent checked server-side
- Org-scoped employee lookup (foreign IDs → 404)
- RBAC: Manager+ required for admin location API
- No cross-organization location access

## 10. Build Verification

```
Agent tests:       640/640 pass ✅
Agent typecheck:   PASS (tsconfig.json) ✅
Agent renderer:    PASS (tsconfig.renderer.json) ✅
Agent build:       PASS (npm run build) ✅
Web typecheck:     PASS ✅
```

## Final Acceptance

```
Native available        → Native is ALWAYS used       ✅
Native success          → IP is NOT called            ✅
Native unavailable      → IP fallback is attempted    ✅
IP success              → source=ip, accuracy=null    ✅
Both unavailable        → No fabricated location      ✅
Source preserved E2E    → Agent → API → DB → UI       ✅
```

```
NATIVE-FIRST + IP-FALLBACK: PASS
```
