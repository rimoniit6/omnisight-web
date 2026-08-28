# LOCATION TRACKING VISIBILITY AUDIT — 2026-08-28

**Audit Type:** Read-only, production-grade  
**Repository:** omnisight-web  
**Date:** 2026-08-28  
**Auditor:** Buffy (AI Agent)

---

## 1. Executive Verdict

### ⚠️ PARTIALLY WORKING — backend works, admin presentation incomplete

The Location Tracking system has a **complete backend pipeline** (agent API → DB → admin API → UI component), but **no location data is being collected** because:

1. **`location_tracking` defaults to `false`** in the organization monitoring settings
2. **No admin has ever enabled it** (or it was never explicitly turned on)
3. Even if enabled, **each employee must individually grant `location` consent**

The Admin Panel's Location tab **exists and is functional** — it simply has no data to display because the pipeline is gated behind two disabled-by-default controls.

---

## 2. Actual Architecture

```
Desktop Agent
    ↓ (native Windows geolocation)
    ↓ POST /api/agent/location
    ↓ { latitude, longitude, accuracy, timestamp }
    ↓
Authentication (validateAgentToken)
    ↓
Consent Check: hasActiveConsent(employee, 'location')
    ↓ (403 if not granted)
    ↓
Org Monitoring Check: resolveOrgMonitoring(org).location_tracking
    ↓ (403 if false — DEFAULT)
    ↓
Validation (lat/lng/accuracy/timestamp ranges)
    ↓
DB Write: LocationEvent.create()
    ↓
Admin API: GET /api/employees/[id]/location
    ↓
UI: LocationPanel (employee details → Location tab)
    ↓
Display: Latest coordinates + history table
```

---

## 3. Root Cause

### Primary Root Cause: `location_tracking` defaults to `false`

```typescript
// src/lib/jobs/settings.ts:85
location_tracking: { type: 'boolean', default: false },
```

This is a **fail-closed default** — by design, location tracking is disabled for all new organizations. An admin must explicitly enable it in **Settings → Monitoring → location tracking**.

### Secondary Root Cause: Individual employee consent required

Even with `location_tracking = true`, each employee must grant `location` consent via the Consent page. Without consent, the agent receives a 403 and never sends location data.

### Tertiary Root Cause: No visual map — coordinates only

The Location tab shows raw coordinates in a table. There is no map visualization (no Leaflet, Mapbox, or Google Maps integration). This makes the feature appear "not working" even when data exists.

---

## 4. Evidence

### Prisma Schema (EXISTS ✅)
```sql
model LocationEvent {
  id             String   @id
  employeeId     String
  deviceId       String?
  latitude       Float
  longitude      Float
  accuracy       Float
  recordedAt     DateTime
  organizationId String
  createdAt      DateTime @default(now())
}
```
Migration: `prisma/migrations/20260814090100_telemetry_location_event/migration.sql`

### Agent API (EXISTS ✅)
- **Endpoint:** `POST /api/agent/location`
- **File:** `src/app/api/agent/location/route.ts`
- **Auth:** `validateAgentToken()` (JWT device token)
- **Consent gate:** `hasActiveConsent(employee.id, 'location')`
- **Org gate:** `resolveOrgMonitoring(orgId).location_tracking`
- **Validation:** Strict lat/lng/accuracy/timestamp validation
- **DB write:** `db.locationEvent.create()`

### Admin API (EXISTS ✅)
- **Endpoint:** `GET /api/employees/[id]/location`
- **File:** `src/app/api/employees/[id]/location/route.ts`
- **Auth:** `requireSessionOrg()` (JWT session)
- **Returns:** `{ latest, history, total, page, pageSize, totalPages }`
- **Org scoping:** Employee lookup is org-scoped (foreign IDs → 404)

### UI Component (EXISTS ✅)
- **Component:** `src/components/employees/telemetry/location-panel.tsx`
- **Location tab:** In employee details page (`employee-details-page.tsx:665`)
- **Fetches:** `GET /api/employees/{id}/location?from&to&page&pageSize`
- **Displays:** Latest coordinates + accuracy + timestamp, paginated history table
- **No map library:** Uses only `MapPin` icon from Lucide (no Leaflet/Mapbox/Google Maps)

### Settings UI (EXISTS ⚠️ — unlabeled)
- **File:** `src/components/settings/settings-page.tsx`
- **MONITORING_LABELS** does NOT include `location_tracking`
- **Fallback rendering:** `s.key.replace(/_/g, ' ')` → shows as "location tracking"
- **No helper text:** Unlike `website_tracking` and `usb_monitoring`, location has no explanation

### Consent UI (EXISTS ✅)
- **File:** `src/components/consent/consent-page.tsx:145`
- **Label:** "Location Tracking"
- **Description:** "GPS-based location tracking of company devices"

### Agent Config (EXISTS ✅)
- **File:** `src/app/api/agent/config/route.ts:60`
- **Sends:** `locationTracking: monitoring.location_tracking` to agent

### WebSocket/Realtime (NOT IMPLEMENTED ❌)
- No `location` event type in `LiveEventType`
- No `locationInvalidation()` in `ws-invalidation.ts`
- No `LocationEvent` in `BROADCAST_TABLES`
- No location broadcast in `mini-services/live-updates/index.ts`
- Location updates require manual page refresh

### Live Monitor (NOT IMPLEMENTED ❌)
- No location event type in `ALL_EVENT_TYPES`
- No location marker feature
- No location in event stats

### Dashboard (NOT IMPLEMENTED ❌)
- No location data on dashboard page

### Tests (EXISTS ✅)
- `tests/telemetry-backend.test.ts`: LOC-B1 through LOC-B5 (agent upload tests)
- `tests/admin-telemetry-backend.test.ts`: AT-20, AT-21 (admin read tests)
- Both test suites verify consent + monitoring gate + DB persistence + org isolation

---

## 5. Impact

### What Currently Works
| Feature | Status |
|---------|--------|
| LocationEvent Prisma model | ✅ Exists |
| Agent location API endpoint | ✅ Functional |
| Admin location read API | ✅ Functional |
| Employee details Location tab | ✅ Renders |
| Location consent type | ✅ Defined |
| Location monitoring setting | ✅ Exists (defaults false) |
| Agent config sends locationTracking | ✅ Functional |
| Org-scoped queries | ✅ Correct |
| RBAC (requireSessionOrg) | ✅ Enforced |
| Tests for agent + admin APIs | ✅ Pass |

### What Does NOT Work
| Feature | Status |
|---------|--------|
| Location data collection | ❌ Disabled by default (location_tracking = false) |
| Real-time location updates | ❌ No WebSocket event |
| Map visualization | ❌ No map library installed |
| Org-wide location view | ❌ No dashboard/sidebar page |
| Live Monitor location | ❌ Not integrated |
| Settings label for location | ⚠️ Generic fallback ("location tracking") |
| Settings helper text | ❌ Missing (unlike website_tracking, usb_monitoring) |

---

## 6. Security Assessment

| Check | Status | Evidence |
|-------|--------|----------|
| Tenant isolation | ✅ PASS | Employee lookup is org-scoped; foreign IDs → 404 |
| RBAC | ✅ PASS | `requireSessionOrg()` enforces authenticated + org-bound session |
| Consent gate | ✅ PASS | `hasActiveConsent(employee, 'location')` checked before DB write |
| Org monitoring gate | ✅ PASS | `location_tracking` must be explicitly enabled |
| Coordinate validation | ✅ PASS | Lat [-90,90], Lng [-180,180], accuracy [0,1000000] |
| Privacy (no addresses) | ✅ PASS | Closed schema rejects address/reverseGeocoded fields |
| Cross-org leakage | ✅ PASS | No cross-org data returned |
| Rate limiting | ✅ PASS | Agent routes use `agentToken`-keyed rate limit |

---

## 7. Recommended Fix Plan

### P0 — Required for functionality

**1. Enable `location_tracking` by default or add prominent Settings toggle**
- Option A: Change default to `true` (privacy concern — requires consent anyway)
- Option B: Add prominent helper text + confirmation dialog to Settings page
- **Recommended:** Option B — add helper text like website_tracking has

**2. Add `location_tracking` to MONITORING_LABELS with proper label**
```typescript
// src/components/settings/settings-page.tsx
location_tracking: 'Location Tracking',
```

**3. Add helper text for location_tracking in Settings**
```typescript
{...(s.key === 'location_tracking'
  ? {
      helper: 'When enabled (AND the employee grants location consent), the desktop agent periodically reports GPS coordinates. Requires active location consent per employee.',
    }
  : {})}
```

### P1 — Required for production reliability

**4. Add real-time location WebSocket event**
- Add `location` to `LiveEventType`
- Add `LocationEvent` to `BROADCAST_TABLES`
- Add location broadcast in `mini-services/live-updates/index.ts`
- Add `locationInvalidation()` to `ws-invalidation.ts`
- Add location handler in `websocket-provider.tsx`

**5. Add LocationEvent to event stats**
- Add location count in `event-stats/route.ts`

### P2 — UX improvements

**6. Add map visualization to LocationPanel**
- Install Leaflet or similar map library
- Show latest location on a map with marker
- Show history as a trail/route on the map
- Keep the existing table as a secondary view

**7. Add org-wide location view**
- Add a "Location" page or section to the sidebar
- Show all employees' latest locations on a map
- Filter by department, status, etc.

**8. Add location to Live Monitor**
- Add location event type to Live Monitor
- Show location updates in the event stream

### P3 — Future enhancements

**9. Geofencing**
- Define allowed geographic zones
- Alert when employee leaves zone

**10. Location history retention**
- Add retention policy for LocationEvent records
- Auto-delete records older than retention period

---

## 8. Exact Files Expected to Change

| File | Change |
|------|--------|
| `src/components/settings/settings-page.tsx` | Add `location_tracking` label + helper text |
| `src/lib/ws-invalidation.ts` | Add `locationInvalidation()` function |
| `src/components/providers/websocket-provider.tsx` | Add `location` event handler |
| `src/components/live-monitor/live-monitor-page.tsx` | Add location event type |
| `mini-services/live-updates/index.ts` | Add LocationEvent poll + broadcast |
| `mini-services/live-updates/notify-triggers.ts` | Add LocationEvent to BROADCAST_TABLES |
| `src/app/api/live-monitor/event-stats/route.ts` | Add location count |
| `src/components/employees/telemetry/location-panel.tsx` | Add map visualization |
| `package.json` | Add map library (Leaflet or similar) |

---

## 9. Test Plan

| Test | Type | Priority |
|------|------|----------|
| Agent uploads location with consent + monitoring enabled → 200, row created | Backend | P0 |
| Agent uploads location without consent → 403 | Backend | P0 |
| Agent uploads location with monitoring disabled → 403 | Backend | P0 |
| Admin reads location for own org employee → 200, coordinates returned | Backend | P0 |
| Admin reads location for other org employee → 404 | Backend | P0 |
| LocationPanel renders latest coordinates | Frontend | P0 |
| LocationPanel renders history table | Frontend | P0 |
| Settings page shows location_tracking toggle with helper text | Frontend | P0 |
| WebSocket broadcasts location event | Backend | P1 |
| Live Monitor shows location events | Frontend | P1 |
| Map renders with latest location marker | Frontend | P2 |
| Map shows history trail | Frontend | P2 |

---

## 10. Final Readiness Score

### **65/100 — Functional with significant gaps**

| Category | Score | Notes |
|----------|-------|-------|
| Schema/DB | 10/10 | Complete, indexed, migrated |
| Agent API | 10/10 | Fully functional with consent + monitoring gates |
| Admin API | 10/10 | Fully functional with org scoping |
| UI Component | 6/10 | Exists but no map, no real-time, generic settings label |
| Settings Integration | 4/10 | Toggle exists but unlabeled, no helper text, defaults false |
| Real-time | 0/10 | No WebSocket event, no live updates |
| Map Visualization | 0/10 | No map library, coordinates-only display |
| Org-wide View | 0/10 | No dashboard or sidebar page |
| Tests | 8/10 | Backend tests exist and pass; no frontend tests |
| Security | 10/10 | Consent, RBAC, org isolation all enforced |

**Explanation:** The backend pipeline is complete and secure. The UI component exists and renders. But the feature is effectively invisible because: (1) it's disabled by default with no prominent enable path, (2) there's no map visualization, (3) there's no real-time updates, and (4) the Settings label is generic.

---

## Final Question Answer

> **Does OmniSight currently have a real end-to-end location tracking system where an agent sends location → backend stores it → Admin Panel retrieves it → Admin can see the employee/device location?**

**PARTIALLY — the backend pipeline is complete and functional, but the feature is gated behind two disabled-by-default controls (`location_tracking` setting + per-employee `location` consent), and the Admin Panel's Location tab shows only raw coordinates without map visualization or real-time updates.**

The exact broken layers are:
1. **Configuration layer:** `location_tracking` defaults to `false` — no data is collected unless an admin explicitly enables it AND each employee grants consent
2. **Presentation layer:** No map visualization — coordinates in a table are hard to interpret
3. **Real-time layer:** No WebSocket event — location updates require manual refresh

---

## ══════════════════════════════════════════════════════════════
## LOCATION TRACKING READINESS
## ══════════════════════════════════════════════════════════════

**Prisma Model:**  
✅ EXISTS — LocationEvent with employeeId, deviceId, lat, lng, accuracy, recordedAt, organizationId

**Agent Location API:**  
✅ EXISTS — POST /api/agent/location with consent + monitoring gates

**Admin Location API:**  
✅ EXISTS — GET /api/employees/[id]/location with org scoping

**UI Component:**  
✅ EXISTS — LocationPanel in employee details → Location tab

**Settings Toggle:**  
⚠️ EXISTS but unlabeled — defaults to false, no helper text

**Consent Type:**  
✅ EXISTS — 'location' consent type defined

**Real-time Updates:**  
❌ NOT IMPLEMENTED — no WebSocket event

**Map Visualization:**  
❌ NOT IMPLEMENTED — coordinates-only table

**Org-wide View:**  
❌ NOT IMPLEMENTED — per-employee only

**Tests:**  
✅ EXIST — agent upload + admin read tests pass

**Security:**  
✅ PASS — consent, RBAC, org isolation enforced

**Final Verdict:**  
⚠️ PARTIALLY WORKING — backend complete, presentation incomplete

**Root Cause:**  
location_tracking defaults to false + no map + no real-time

**Implementation Required:**  
YES — enable setting, add map, add WebSocket event

## ══════════════════════════════════════════════════════════════
