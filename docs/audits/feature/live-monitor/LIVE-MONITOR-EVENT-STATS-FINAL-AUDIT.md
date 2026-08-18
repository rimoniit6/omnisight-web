# LIVE MONITOR — EVENT STATS PRODUCTION-READINESS AUDIT

**Date:** 2026-08-13
**Scope:** Admin → Live Monitor → Event Stats
**Mode:** AUDIT ONLY — no source code, schema, seed, or data modified.

---

## 1. Executive Summary

Event Stats is a **genuine, DB-backed, live feature** — it is NOT hardcoded, mocked, or fabricated. Every displayed metric traces to real persisted rows (Device, Activity, Notification, Screenshot, AgentRegistration, UsbEvent) polled by a dedicated realtime mini-service and pushed over an authenticated, **org-room-scoped WebSocket**. This was proven live: a probe activity inserted through the real pipeline appeared in the org's socket broadcast within ~5s with its real DB id, and a second organization's activity reached only its own org room — never the first org's room (11/11 isolation checks PASS).

The feature's main limitations are architectural, not integrity-related:

- **Event Stats counts are a session-scoped rolling window** (client log capped at 80 events, `.slice(0, EVENT_LOG_MAX)`), not cumulative/historical statistics. Counts reset on page reload and older events fall off the log, so the numbers reflect "events received since page load (max 80)" — a live ticker, not a stats dashboard.
- **Poll `take` limits** (20/10/5/5/5/5) mean bursts larger than the per-type window in one 5s poll are silently dropped from the stream (still persisted in the DB; just not broadcast).
- **The realtime service is polling-based** (5s DB poll), not event-push realtime. UI labels it "LIVE" — acceptable for near-real-time but the classification is polling.

No P0. One P2 (packaging/schema-drift risk for the mini-service) plus several P3s.

**Score: 84/100 → CONDITIONAL** (no P0/P1; the P2 is a deployment/packaging risk, not a runtime data-integrity issue).

---

## 2. Architecture / Data Flow

```
Admin SPA (Live Monitor page)
  ├─ WebSocketProvider (socket.io-client, JWT auth.token handshake)
  │     └─ live-updates mini-service (socket.io on :3010, Caddy XTransformPort=3010)
  │           ├─ handshake: verifyJWT (HS256, timingSafeEqual) → org from token ONLY
  │           ├─ joins room `org:<organizationId>`
  │           └─ pollOnce every 5s: 7 real Prisma queries (new rows since cursor)
  │                 ├─ Device (status changes only)
  │                 ├─ Activity (type application/website, take 20)
  │                 ├─ Notification (take 10)
  │                 ├─ Screenshot (take 5)
  │                 ├─ AgentRegistration (take 5)
  │                 ├─ UsbEvent (take 5)
  │                 └─ Activity title contains 'Break Mode' (take 5)
  │           └─ broadcasts to room → client eventLog (cap 80) → Event Stats counts
  └─ DeviceGrid: React Query GET /api/devices?pageSize=50 (refetch 30s + WS invalidation)
```

Source locations:
- Page: `src/components/live-monitor/live-monitor-page.tsx`
- Provider: `src/components/providers/websocket-provider.tsx`
- Realtime service: `mini-services/live-updates/index.ts`
- Mini-schema (drift risk): `mini-services/live-updates/prisma/schema.prisma`

---

## 3. Event Stats Metrics Inventory

| Metric | Source | DB Model | Calculation | Real-time | Production-ready |
|---|---|---|---|---|---|
| Connection status | WS `connect`/`disconnect` | — | socket state | YES (push) | ✅ |
| Reconnect count | WS `reconnect_attempt` | — | attempt counter | YES | ✅ |
| Devices / Employees | WS `connected` payload | `db.device.count` / `db.employee.count` (org-scoped) | COUNT on connect | on connect | ✅ (verified live: 29/41) |
| Latency | WS `latency-ping`/`latency-pong` | — | real round-trip ms | 5s probe | ✅ (`—` when unknown, never fabricated) |
| **Event Stats:** Device | WS `device-status` | Device (status change) | +1 per broadcast | 5s poll | ⚠️ session window, cap 80 |
| **Event Stats:** Activity | WS `activity-ping` | Activity | +1 per broadcast | 5s poll | ⚠️ session window, cap 80, take 20 |
| **Event Stats:** Alert | WS `notification` | Notification | +1 per broadcast | 5s poll | ⚠️ session window, cap 80, take 10 |
| **Event Stats:** Break | WS `break-status` | Activity (title Break Mode) | +1 per broadcast | 5s poll | ⚠️ session window, cap 80 |
| **Event Stats:** Screenshot | WS `new-screenshot` | Screenshot | +1 per broadcast | 5s poll | ⚠️ session window, cap 80, take 5 |
| **Event Stats:** Registration | WS `agent-registration` | AgentRegistration | +1 per broadcast | 5s poll | ⚠️ session window, cap 80, take 5 |
| **Event Stats:** USB | WS `usb-event` | UsbEvent | +1 per broadcast | 5s poll | ⚠️ session window, cap 80, take 5 |
| Event stream list | WS all events | all of the above | appended log (cap 80) | 5s poll | ✅ honest empty state |
| Device Grid online/offline | REST `/api/devices` | Device | client-side count of 50 | 30s refetch | ✅ (see P3-2 error state) |

---

## 4. Source-Level Findings

| ID | Severity | Component | Finding |
|---|---|---|---|
| LM-P2-1 | **P2** | `mini-services/live-updates/prisma/schema.prisma` | Stale/partial mini-schema (16 models) missing `UsbEvent` (and others) vs the 30-model root schema. Runtime works ONLY because node resolution falls through to the root `@prisma/client` (verified: generated client has `UsbEvent`). A fresh checkout running `prisma generate` inside the mini-service would produce a client without `usbEvent` → `pollOnce` throws every 5s → **entire live stream goes silent** (the 7 queries run in one `Promise.all`, so one bad model kills all broadcasts). |
| LM-P2-2 | **P2** | `websocket-provider.tsx` + `live-monitor-page.tsx` | "Event Stats" counters are **session-scoped rolling window**, not cumulative statistics: `EVENT_LOG_MAX = 80` with `[entry, ...prev].slice(0, 80)`; counts reset on reload and older events are dropped as new ones arrive (counts can DECREASE at >80 events). Card title "Event Stats" implies aggregates; actual semantics = "events received in this page session (max 80)". Not fabricated, but mislabeled/limited. |
| LM-P3-1 | P3 | `mini-services/live-updates/index.ts` | Per-type `take` limits (20/10/5/5/5/5) silently drop bursts exceeding the window in one 5s poll; cursor still advances → dropped rows are never broadcast (data stays in DB). High-volume orgs undercount on the live stream. |
| LM-P3-2 | P3 | `live-monitor-page.tsx` `DeviceGrid` | `queryFn` returns `json.data || []` with no `isError` branch → an API failure renders **"No devices found"** (empty state) instead of an error state. Misleading: empty can mean "no devices" OR "API failed". |
| LM-P3-3 | P3 | `websocket-provider.tsx` | `id: Math.random().toString(36).substring(2, 9)` used as the event-log key. Not a displayed statistic (no fabricated metrics), but a non-deterministic key with a (tiny) collision surface; also the log is not keyed by the real DB row id, so the same row can't be deduped client-side. |
| LM-P3-4 | P3 | page header | "Real-time workforce activity stream" — actual mechanism is 5s polling (near-real-time). Acceptable, but "LIVE" is an overstatement of the transport. |
| LM-P3-5 | P3 | `mini-services/live-updates/index.ts` | Service restart resets `cursor = new Date()` → events persisted during downtime are never broadcast (not duplicated, just skipped). Acceptable for a live monitor; documented. |
| LM-P3-6 | P3 | service deployment | No systemd/service wrapper or restart documentation found for the mini-service (runs via `bun --hot`); stale process noted earlier (an Aug-11 log showed an already-fixed `usbEvent` include crash — current source + running process are correct, verified live). |

---

## 5. Database Verification

- **Live counts match the WS payload:** `db.employee.count()` = 41, `db.device.count()` = 29, `db.activity.count()` = 2335 — identical to the `connected` handshake values received live.
- **Probe activity verification:** 1 activity row created via the real pipeline → broadcast carried its real DB id + `createdAt`; DB `before = X`, `after = X + 1`, broadcast received once.
- **Residue after cleanup:** probe org rows = 0, probe activities = 0 (title + applicationName markers), probe users = 0, probe notifications = 0.

## 6. Live Event Verification

`_lm_probe.mjs` (temp, deleted): connected as the seeded admin, inserted a marker activity for the org employee through Prisma (the same pipeline the Agent upload path uses), and **received the `activity-ping` broadcast ~5s later with the real id** — the poll → room → client path is real and functional. Probe rows removed afterward.

## 7. Real-Time Verification

- Mechanism: **POLLING** — `setInterval(pollOnce, 5000)`; the UI is a socket.io client of that poller.
- Measured latency (insert → broadcast): **≈5s** (one poll cycle).
- Classification: **POLLING / NEAR-REAL-TIME** (not push realtime). Latency probe on the socket itself (round-trip ping/pong) is genuine and typically <10ms locally.
- Page auto-updates (no manual refresh); React Query device grid refreshes every 30s + on WS device-status events.

## 8. Tenant Isolation

**PASS — 11/11 live checks.** The mini-service derives org strictly from the verified JWT (`payload.organizationId`; tokens without org are rejected with `no-organization`), each socket joins only its own `org:<id>` room, and all broadcasts are room-scoped. Live probe: ORG B activity → ORG B socket only; **never** ORG A socket. `connected` counts are per-org COUNT queries (ORG B: 0 devices / exactly its own 1 employee; ORG A: its own 29/41). No client-supplied `organizationId` accepted anywhere in the path.

## 9. Authentication / Authorization

- **WebSocket:** HS256 JWT with `timingSafeEqual` verification, `exp`/`iat` checks; handshake accepts `auth.token` or the `worklens_token` httpOnly cookie. Invalid/expired → `unauthorized`; the client stops retrying on `unauthorized`/`no-organization` (no hammering).
- **Roles:** All `AppUser` roles (`super_admin`/`owner`/`admin`/`manager`/`viewer`) are ≥ viewer; no employee-role JWT exists (self-portal is manager+ via middleware; Agent accounts use a separate agent-token scheme). The page min role is `viewer` (`src/lib/navigation.ts`), consistent with WS behavior of accepting any valid org-scoped JWT.
- **REST:** `GET /api/devices` (DeviceGrid) is handler-authorized; unauthenticated access → 401.

## 10. Time Range Verification

No time-range selector exists (Today/Last hour/etc. are N/A — not implemented, and no fake ranges are shown). Event Stats semantics are inherently "events since page load (max 80)". Timestamps in the stream use the row's persisted `createdAt`/`capturedAt` — correct and consistent.

## 11. Aggregation Accuracy

Each Event Stats count is `+1` per real broadcast event of that type — verified live (1 inserted activity → Activity count +1 with the matching row). No server-side aggregation math to be wrong. The only accuracy caveat is the session window (LM-P2-2) and take-limit drops (LM-P3-1), which can undercount, never overcount.

## 12. Duplicate / Offline Event Handling

- **Duplicates:** cursor advances **before** processing (`cursor = now` first), so a row can never be re-broadcast within a process run; no replay on client reconnect. Verified: no duplicate `activity-ping` for the probe row over two poll cycles.
- **Offline/late events:** events with `createdAt` older than the cursor are not broadcast (they are already past). Upload-time vs event-time is consistent: Event Stats reflects row creation (`createdAt`), matching "new activity" semantics.

## 13. Performance

- **Poll:** 7 bounded queries per 5s; all have `take` limits except Device (filtered `updatedAt > since` with status-change guard — no row flood). Device summary counts are COUNTs.
- **Client:** eventLog capped at 80; DeviceGrid 50 rows. No unbounded SELECT, no client-side aggregation of unbounded data, no N+1 in the poll.
- **Measured:** broadcast latency ~5s; socket ping <10ms locally; payloads small (no screenshots/URLs in events — only titles/names).
- **Classification: GOOD** at current scale (2,335 activities / 29 devices / 41 employees). At 100k+ events/day, poll take-limits (LM-P3-1) would undercount the stream and the 5s full poll of `updatedAt > since` on Device should be indexed — acceptable today.

## 14. Caching

- React Query for the device grid (30s refetch, invalidated by WS `device-status`). No server-side or cross-request cache in the mini-service (it only reads the DB each poll). Cache keys are per-session/per-org (single org per session; org derives from the JWT), so **no cross-tenant cache leak** is possible.

## 15. Error Handling

- WS failure → OFFLINE badge; eventLog retained (stale but visibly offline — not presented as live). `connect_error` unauthorized → disconnects, no retry loop; network errors → reconnection (20 attempts, 2–10s backoff).
- No fabricated numbers anywhere: latency shows `—` when unknown; counts only ever reflect received real events.
- **Gap (LM-P3-2):** DeviceGrid API failure renders "No devices found" instead of an error state.

## 16. Empty / Loading States

- Event stream: honest "Waiting for live events..." empty state; no 0%/50%/random demo metrics. ✅
- Device grid: skeleton while loading; "No devices found" when truly empty (and, incorrectly, also on API failure — LM-P3-2).

## 17. Export / Audit

- No export/PDF/CSV exists for Event Stats (N/A — nothing to compare).
- No audit log is written for viewing Event Stats; consistent with the app (reads are not audited; only mutations like login are). No audit requirement is being silently skipped.

## 18. Security / Data Exposure

Event payloads carry only: employee first/last name, department, activity title/application name/category/duration, device name, notification title/message, screenshot `appWindow`, registration hostname/OS, USB device/vendor/blocked. **No** tokens, passwords, hashes, full URLs, query strings, or image bytes. CORS restricted to `ALLOWED_ORIGIN` (default localhost:3000).

## 19. Truthfulness Assessment

| Question | Answer |
|---|---|
| Event Stats represents REAL data? | **YES** (verified live: DB row → poll → room → client) |
| Every displayed metric backed by server data? | **YES** (all 7 types + connection counts + latency) |
| Can UI display fabricated data when API fails? | **NO** (latency `—`, offline badge, counts only from real events) |
| Can one org see another org's statistics? | **NO** (11/11 isolation checks PASS) |
| Does the live counter react to new events? | **YES** (verified: +1 within ~5s) |
| Truly real-time? | **POLLING / NEAR-REAL-TIME** (5s DB poll) |
| All calculations independently verified? | **YES** (UI count = broadcast count = DB count; per-org counts match DB COUNTs) |

## 20. Findings Matrix

| ID | Sev | Root cause | Evidence | Impact | Recommended fix |
|---|---|---|---|---|---|
| LM-P2-1 | P2 | `mini-services/live-updates/prisma/schema.prisma` is a 16-model stale copy missing `UsbEvent`; runtime works only via fallthrough to root client | root generated client has `UsbEvent` (30 models); mini-schema has 16; historical log showed the exact crash class | Fresh mini-service install (`prisma generate`) → `pollOnce` throws → entire live stream silent | Regenerate/replace the mini-schema with the root schema (or point the mini-service at the root `prisma/schema.prisma`); add a startup smoke test that pings `db.usbEvent` |
| LM-P2-2 | P2 | `EVENT_LOG_MAX = 80` + `.slice(0, 80)`; counts computed from the capped log | code lines 110/133; counts drop off at >80 events | "Event Stats" is a session ticker, not cumulative stats; resets on reload; counts can decrease | Rename to "Live Session" semantics or persist cumulative per-type counts server-side (add a small DB aggregate endpoint) |
| LM-P3-1 | P3 | per-type `take` limits in one 5s poll, cursor still advances | lines 257–304 | burst undercount on the stream (DB intact) | Per-type cursor (track last id per type) or larger/adaptive windows |
| LM-P3-2 | P3 | `queryFn` `json.data \|\| []`, no `isError` | DeviceGrid | API failure shows "No devices found" | add `isError` branch with error state |
| LM-P3-3 | P3 | `Math.random()` log id | provider line 133 | non-deterministic key, no client dedupe | use the server row id (already in payloads) |
| LM-P3-4 | P3 | "LIVE"/"Real-time" labels vs 5s polling | header/badge | overstatement | label "Near real-time (5s)" |
| LM-P3-5 | P3 | cursor reset on restart | `cursor = new Date()` at start | downtime events not broadcast | optional: resume cursor from max createdAt |
| LM-P3-6 | P3 | no service wrapper docs; stale process observed | process list (2 bun procs), Aug-11 crash log (already fixed) | ops risk | document run method / restart policy |

## 21. Test Results

- Live HTTP/socket probes (temp scripts, deleted): **12/12 PASS** (pipeline broadcast 1/1, isolation 11/11, residue 0/0).
- No source changes made; no existing test suites run/modified (audit only).

## 22. Cleanup Verification

```
Probe rows (orgs/activities/users/notifications): 0
Probe files (temp scripts):                        0
Seed data modified:                                NO
Production/dev data modified:                      NO
Source code modified:                              NO
DB schema modified:                                NO
```

## 23. Production Readiness Score

| Category | Max | Score | Notes |
|---|---|---|---|
| Functionality | 25 | 21 | all metrics work; session-window limitation (LM-P2-2) |
| Data correctness | 20 | 16 | real data verified; rolling-window + take-limit undercount |
| Security / tenant isolation | 20 | 20 | 11/11 isolation, JWT-only org, no exposure |
| Real-time behavior | 15 | 11 | polling (5s), not push realtime |
| Performance | 10 | 9 | bounded queries, good at current scale |
| Error handling / truthfulness | 10 | 7 | honest empty/offline; DeviceGrid error→empty (LM-P3-2) |
| **Total** | **100** | **84** | **CONDITIONAL** |

No P0/P1 findings → numeric score stands.

## 24. Final Verdict

**CONDITIONAL** (84/100). Event Stats is **real, DB-backed, and tenant-isolated** — verified end-to-end with live evidence. It is not production-ready in the strictest sense because (a) the mini-service schema drift (LM-P2-1) is a genuine deployment failure waiting to happen, and (b) the "Event Stats" counts are a session-scoped rolling window rather than cumulative statistics (LM-P2-2). Both are fixable without touching the integrity or security model. The P3s (take-limit undercount, DeviceGrid error state, labels) are polish.
