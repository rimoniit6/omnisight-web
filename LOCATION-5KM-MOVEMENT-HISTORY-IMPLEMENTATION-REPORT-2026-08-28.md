# OmniSight Location Tracking — 5 KM Movement History + Interactive Map: Implementation Report

**Date:** 2026-08-28
**Status:** ✅ COMPLETE (implementation, production build, and pure unit tests verified)
**Runtime DB/integration verification:** ⏳ `npm run test:location` must be executed in an environment with PostgreSQL (no local Postgres was available in the build environment; tests are written and type-check clean).

---

## 1. Current Behaviour vs Requested Behaviour

| | Current | After this change |
|---|---|---|
| History granularity | Every valid agent fix becomes a `LocationEvent` (no movement gate) | Only fixes **≥ 5 km (Haversine)** from the previously *accepted* location become a `LocationEvent` |
| Small moves | Stored as separate rows (history spam) | Suppressed server-side (returned `200 accepted:false`, no row) |
| UI map | Shows latest fix only, no history interaction | Interactive Leaflet map: current point by default, click any history row to fly to that accepted point; "Show Current Location" resets |
| History table | Time + Location + Accuracy | Time + Location + **Distance Moved** (from previous accepted point) + Accuracy + Status (Current/History), clickable rows |
| Accuracy circle | Shown for latest | Shown for current & selected historical point |
| Pagination | default 50 | default **25** (still capped 1..100) |

## 2. Where the 5 KM Filter Lives (server-authoritative)

**`src/lib/location-service.ts` → `recordAgentLocation()`** is the single source of truth. It is called by `POST /api/agent/location`. The Agent keeps sending fixes normally; the **server** decides. This guarantees identical behaviour across all agents and prevents duplicate-upload abuse.

Logic:
- No previous `LocationEvent` for the employee → **always accept** (first fix).
- `distanceKm = calculateDistanceKm(lastAccepted.lat, lastAccepted.lng, fix.lat, fix.lng)`.
- `distanceKm < 5` → return `{ accepted:false, reason:'below_movement_threshold', thresholdKm:5, distanceKm }` (HTTP **200**, NOT an error).
- `distanceKm >= 5` → create `LocationEvent`, return `{ accepted:true, id, distanceKm, first, thresholdKm:5 }`.

Threshold comparison is `>= 5` (never float equality). Inputs are validated (`assertValidCoordinate`) before any distance math.

## 3. Why Not a Separate "History" Table / Batches

`LocationEvent` (in `prisma/schema.prisma`) **is** the location history — one accepted movement = one row. No second table, no batching. History is just `findMany` over `LocationEvent` ordered by `recordedAt desc`, strictly paginated. Simpler, auditable, and avoids dual-write consistency bugs.

## 4. Distance Calculation

**Haversine** in `src/lib/location-distance.ts`: `EARTH_RADIUS_KM = 6371`, great-circle distance, `a` clamped to `[0,1]` to avoid `NaN` at antipodes. `assertValidCoordinate(lat,lng)` throws on out-of-range (lat ∈ [-90,90], lng ∈ [-180,180]). The **same pure function** is reused client-side (panel) and server-side (service) so the "Distance Moved" column and the acceptance gate can never disagree.

## 5. What Constitutes a "Move"

A move is measured **from the last accepted location**, not from the last raw reading. Therefore a device that drifts 1 km, then 1 km, then 1 km (all < 5 km from the baseline) creates **zero** new rows — small movements cannot accumulate to cross the threshold. A single jump of ≥ 5 km from the last accepted point is accepted.

## 6. Agent Behaviour (unchanged / compatible)

- The Agent upload client (`omnisight-agent/src/api/location.ts`) only checks **HTTP status**, not the response body. Returning `200 accepted:false` is therefore fully Agent-compatible — no Agent change required.
- The Agent's `location-collector.ts` (WinRT + IP fallback `ipLocationFallback`, 5-min poll, consent/monitoring gates) is **intentionally left untouched** (audit confirmed intact).

## 7. API Contract (response shape)

`POST /api/agent/location`
- Accepted: `{ success:true, accepted:true, id, first, distanceKm, thresholdKm, message }` (HTTP 200)
- Below threshold: `{ success:false, accepted:false, reason:'below_movement_threshold', thresholdKm, distanceKm, message }` (HTTP 200)
- Consent missing → 403; org tracking disabled → 403; bad/missing token → 401; invalid coordinate → 422.

`GET /api/employees/[id]/location?from&to&page&pageSize`
- Returns `{ latest, history, total, page, pageSize, totalPages }`. `pageSize` default now **25**. Exposes only `latitude/longitude/accuracy/recordedAt` — **no address, no reverse geocoding, no raw device metadata** (none exists in the schema). Employee lookup is **org-scoped** (foreign ids → 404).

## 8. Realtime Deduplication (automatic)

`mini-services/live-updates/index.ts` polls `db.locationEvent.findMany({ where: { createdAt: { gt: since } } })` and emits `'location-update'` only when a **new row** exists (it also re-emits on invalidation). Because sub-threshold fixes create **no row**, they emit **nothing** — the live map shows only significant movement, with zero code change to the realtime pipeline.

## 9. UI/UX Behaviour

- **Map**: shows the **current** (latest accepted) location by default, with accuracy circle + popup. Clicking a history row flies the map (`flyTo`) to that accepted point, recolours the circle amber (highlight), and shows its popup. "Show Current Location" returns to the latest accepted point.
- **History table**: columns Time · Location · **Distance Moved** · Accuracy · Status. Rows are clickable; the selected row is highlighted. "Current" badge marks the latest; others are "History".
- **Status banners**: org tracking disabled, consent not granted, no data, and load/error states are all handled.

## 10. Privacy & RBAC

- Only coordinates + accuracy + timestamp + employee/device/org ids are stored. No geocoding, no street addresses, no device fingerprint beyond the existing `deviceId`.
- All reads/writes are org-scoped; manager+ read scope. Auth/consent/monitoring gates in the route are **unchanged and still fail closed**.

## 11. Testing

- **Pure (run here, 8/8 pass):** `tests/location-distance.test.ts` — identical→0, <5 km, ≈5 km, >5 km, boundary validity, no float-equality.
- **DB-backed (written; run in Postgres env via `npm run test:location`):**
  - `tests/location-service.test.ts`: first-accepted (D5), <5 ignored (D6), ≥5 accepted (D7), compares to last *accepted* (D8), accumulation prevented (D9), **concurrent ingestion cannot duplicate the baseline** via `SELECT … FOR UPDATE` (D10), per-employee isolation.
  - `tests/location-route.test.ts`: missing token→401 (D12), missing consent→403 (D13), org tracking disabled→403 (D14), API compatibility (sub-threshold → `200 accepted:false`), GET org-isolation gate.
- **Production build:** `next build` passes (all routes compiled; location routes are dynamic).
- **Regression protected:** existing Agent collection logic and the EXE build pipeline (prior task) are untouched.

## 12–24. Direct Answers to the Task List

- **Moved ≥ 5 km stored, smaller ignored:** ✅ (service-level gate).
- **No new row for sub-threshold:** ✅ (returns 200 `accepted:false`).
- **History from DB (LocationEvent), strict pagination:** ✅ (default 25).
- **Interactive map (current + clickable history, fly-to, accuracy circle):** ✅.
- **Show Current Location button on map:** ✅.
- **Distance Moved column (Haversine, client-reused util):** ✅.
- **Agent-compatible (no Agent change needed):** ✅.
- **RBAC + privacy (org-scoped, coordinates only):** ✅.
- **Realtime only on accepted moves:** ✅ (automatic, no pipeline change).
- **Code quality (lint 0 errors, build, unit tests):** ✅.
- **Server-side enforcement (not UI):** ✅.
- **Concurrency-safe (FOR UPDATE row lock):** ✅.
- **No separate history/batch table:** ✅.

## Files Changed

| File | Change |
|---|---|
| `src/lib/location-distance.ts` | **NEW** — Haversine + coordinate validation (pure). |
| `src/lib/location-service.ts` | **NEW** — `recordAgentLocation()` with 5 km gate + `FOR UPDATE` concurrency lock. |
| `src/app/api/agent/location/route.ts` | Calls the service; new response contract; removed direct `db` create. |
| `src/app/api/employees/[id]/location/route.ts` | Default `pageSize` 25. |
| `src/components/employees/telemetry/location-panel.tsx` | Interactive map + clickable history table + Distance Moved + Show Current Location. |
| `src/components/employees/telemetry/location-map.tsx` | Popup, highlight state, smooth recenter on selected point. |
| `tests/location-distance.test.ts` | **NEW** — pure distance tests (passing). |
| `tests/location-service.test.ts` | **NEW** — DB-backed service tests (run in env). |
| `tests/location-route.test.ts` | **NEW** — route gate + API-compat tests (run in env). |
| `package.json` | `test:location` script. |

## How to Verify in the Target Environment

```bash
# 1) Unit (no DB)
npx tsx --test tests/location-distance.test.ts

# 2) Full suite (needs PostgreSQL; set PG_TEST_BASE_URL if not default)
npm run test:location

# 3) Build
npm run build

# 4) Manual end-to-end (Part 22)
# Start the Agent pointed at the org, enable Location Tracking + grant consent,
# then drive the device >5 km; confirm only the significant moves appear in the
# Admin Panel map/history and realtime updates fire only on accepted moves.
```

**Verdict: ✅ COMPLETE** — implementation, production build, and pure unit tests are verified. Database-backed tests and live Agent→API→DB→Map verification are written and ready; they require a PostgreSQL-capable environment to execute.
