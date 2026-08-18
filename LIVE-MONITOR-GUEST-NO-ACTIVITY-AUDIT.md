# LIVE-MONITOR-GUEST-NO-ACTIVITY-AUDIT.md

> Read-only forensic audit — no source code, schema, database, or configuration was modified.
> All timestamps are UTC unless noted. Machine timezone: Asia/Dhaka (UTC+6).

---

## 1. Executive Summary

The Live Monitor shows **OFFLINE** and delivers no realtime activity because the realtime
delivery service **`mini-services/live-updates` (socket.io, port 3010) is crashing at
startup and never binds its port**. The crash is caused by a **missing generated Prisma
client** inside the service's own `node_modules` (`@prisma/client did not initialize yet —
please run "prisma generate"`). This is a dev-environment state issue, not a product-code
bug: `npm install` was run inside `mini-services/live-updates` (2026-08-17 17:45 local)
creating a stub `@prisma/client`, but `prisma generate` was never executed there.

The Guest pipeline itself is **healthy end-to-end at the database level**:

- Guest GUEST-87C7BB105277 (device "Rimon") is **online** — heartbeat fresh (7 s old at audit time).
- **Activities ARE flowing to the DB** (27 rows in the last 3 days; last created 22:56:50Z).
- **Screenshots ARE flowing** (one per minute, last captured 22:59:09Z).
- Consent: all 8 consent types granted, bound to currently published policies.
- Agent config: all tracking flags enabled by the server.

The symptom "Guest appears online but has no activity" is therefore an **observability
disconnect**: presence (heartbeat) works, ingestion (DB) works, but the realtime event
stream that paints the Live Monitor is dead. Nothing in the Live Monitor page is fed by an
API snapshot — the live feed is 100% socket-event driven, so a dead service means an empty
stream plus the OFFLINE badge.

AUDIT RESULT: **FAIL** (realtime delivery layer broken).

---

## 2. Exact Symptom

- Live Monitor page shows a red **OFFLINE** badge (WifiOff) and an empty live event stream.
- The guest device appears online elsewhere in the UI (sticky `Device.status='online'`,
  fresh heartbeat on the Devices page) while the Live Monitor shows OFFLINE — contradictory UX.
- No activity events (activity-ping, employee-presence, device-summary) ever arrive in the
  browser session.
- The Event Stats card is DB-backed (`/api/live-monitor/event-stats`) and is NOT affected;
  it can show non-zero counts while the stream is dead.

## 3. Architecture / Data Flow

```
OmniSightAgent (Electron, v1.1.0, desktop-agent/)
  ├─ HeartbeatService ── POST /api/agent/heartbeat ──► Next (3000) ──► Device.lastHeartbeat
  ├─ ActivityCollector ── enqueue ──► ActivityQueue (WLENC1 at-rest encrypted)
  │     └─ QueueUploader (drain) ── POST /api/agent/activity ──► Next (3000) ──► Activity rows
  ├─ ScreenshotCollector ── POST /api/agent/screenshot ──► Screenshot rows + files
  └─ ConsentService ── GET /api/agent/consent (snapshot, fail-closed gate)

Browser (Admin UI)
  └─ websocket-provider (socket.io-client)
        └─ NEXT_PUBLIC_LIVE_UPDATES_URL = http://localhost:3010   ← set by scripts/dev.mjs
              └─ mini-services/live-updates (socket.io, port 3010)
                    ├─ polls DB every 5 s (and on pg_notify wake)
                    ├─ durable poll cursor in SystemSetting 'live_updates.poll_cursor'
                    └─ broadcasts org-room events (activity-ping, presence, device-summary …)
```

The socket service is the ONLY source of realtime events. It never writes to the DB
(poll-cursor persistence excepted) and never fabricates events.

## 4. Live Monitor Status Logic

- `live-monitor-page.tsx:670-675` — `OFFLINE` badge rendered when `!isConnected` from
  `useWebSocket()` (websocket-provider). It does NOT reflect agent/device state.
- `websocket-provider.tsx` candidate URLs: `NEXT_PUBLIC_LIVE_UPDATES_URL`
  (`http://localhost:3010` in dev) → `/?XTransformPort=3010` (Caddy prod path). Both were
  unreachable during the audit (`Test-NetConnection localhost:3010 = False`, `netstat` empty).
- The live event stream (`eventLog`, live feed, filter chips, sound alerts) is fed ONLY by
  socket events; there is no initial API snapshot for the stream. A dead service therefore
  yields an empty stream + OFFLINE badge — exactly the reported symptom.
- Event Stats card: DB-backed aggregate (`/api/live-monitor/event-stats`), org-scoped,
  validated range — independent of the socket service. This card is NOT broken.

## 5. Guest Presence Pipeline

- Presence = `Device.lastHeartbeat` freshness vs `EMPLOYEE_ONLINE_THRESHOLD_MS`
  (default 5 min), `src/lib/presence.ts`. `Device.status` is a sticky write-once value and
  is never used for liveness (both the Devices page and the socket service use heartbeat).
- Guest GUEST-87C7BB105277: `lastHeartbeat = 2026-08-17T22:59:11.062Z` vs
  `db now = 2026-08-18T04:59:18Z` → **7 s old → ONLINE**. Heartbeats land every ~60 s.
- The agent is running: 4× `OmniSightAgent.exe` (PID 1668/13428/13860/14016, started
  10:12:02 local), TCP established to `::1:3000`, website bridge listening on 59706.
- Device `status='online'` is sticky for all guest devices (oldest heartbeat 15-16 h ago on
  archived guests still shows 'online' in raw data) — by design, but a UX trap: the Guests
  page / device list can show "online" while presence has lapsed.
- The socket service's `request-device-summary` handler (which computes live online counts
  from heartbeat freshness) is unreachable because the service is down.

## 6. Activity Collection Pipeline (agent side)

- `ActivityCollector.sample()` (every 10 s) polls the foreground window, keeps one slice per
  contiguous app/window, and flushes a record on window change / idle / internal-process.
- Gate (fail-closed), `decideConsentGate`: collect only when config `appTrackingEnabled` AND
  a **fresh** (≤5 min) consent snapshot AND `activity_tracking === true`.
- Records go to `ActivityQueue` (activity-queue.jsonl, AES-256-GCM at-rest, WLENC1 format).
  `QueueUploader.drain()` → `POST /api/agent/activity`; ack only after server 200; 4xx
  permanent errors drop the batch (except 401 which retains + re-auths).
- **Agent-side gate state at audit time (via live server responses with the agent's own
  token):** `appTrackingEnabled: true`, `websiteTrackingEnabled: true`, `websiteNativeTracking:
  true`, `workingHoursOnly: false`, `timezone: Asia/Dhaka`; consent endpoint returns
  `activity_tracking: true` (and all other types) with `allGranted: true`.
- Local `policy-cache.json` shows `version "0"`, `applications: []` (matches the server's
  own config response — org has no app-policy entries; irrelevant to activity collection).
- **Queue content at audit time: EMPTY** (34-byte WLENC1 blob = magic+IV+tag, zero
  ciphertext), last persisted 22:56:50Z — the instant the last activity row was created
  (ack-after-success). The 10:43/10:50 local writes match enqueue→drain→ack cycles.

## 7. Consent Pipeline

- Guest approval auto-grants `monitoring` + `activity_tracking` (plus screenshot/keystroke/
  usb/webcam/location/email where policies exist), `src/lib/guests.ts` +
  `device-claims/[id]/approve/route.ts` (guest mode). Consent is bound to a specific
  published `ConsentPolicy` version.
- DB state (SELECT): GUEST-87C7BB105277 holds **8 granted consents** (monitoring,
  activity_tracking, screenshot v2, keystroke, usb_monitoring, webcam_access, location,
  email_monitoring) — all bound to currently `published` policies (v1/v2), no revocations,
  no expiry.
- Server enforcement: `/api/agent/activity` calls `hasActiveConsent(employeeId,
  'activity_tracking')` and returns 403 on missing/revoked consent (verified in code;
  the consent endpoint returns granted=true live). Consent is NOT the blocker.

## 8. /api/agent/activity Audit

- Server-authoritative validation (no partial writes): type/category allowlists, duration
  0-86400 s, timestamp not in the future (>5 min skew → 422 whole batch), string length
  caps, 1 MB body cap, ≤100 items, internal-process exclusion, website rows normalized to
  bare domains (privacy), website rows gated on org `website_tracking` (defaults true;
  org has no stored key → resolves true → no 403 here).
- Live probes with an invalid token: `/api/agent/consent`, `/api/agent/config`,
  `/api/agent/activity` all return proper JSON 401s (route graph healthy — no stale `.next`
  pollution; AGENTS.md HTML-404 scenario NOT present).
- Activity rows ARE being created: 27 rows in the last 3 days for guest employees; latest
  `createdAt 2026-08-17T22:56:50.770Z` (minutes before audit), latest `timestamp
  22:51:31Z`. Batch flush cadence explains gaps: the "opencode" window slice stayed open
  22:31-22:51Z (stable window = no new rows until it closes).
- Screenshot pipeline independently proves agent uploads work end-to-end: rows every minute
  through 22:59:09Z.

## 9. Database Evidence (all SELECT-only)

| Item | Value |
|---|---|
| `SystemSetting.live_updates.poll_cursor` | `"2026-08-17T13:09:24.628Z"`, updatedAt `2026-08-17T07:09:24.633Z` — **stale ~21 h; service has not completed a poll round since** |
| Latest guest heartbeat | `2026-08-17T22:59:11.062Z` (7 s old at audit) → ONLINE |
| Latest activity row | `2026-08-17T22:56:50.770Z` created (type application, "opencode - OmniSight - Visual Studio Code") |
| Latest screenshot | `2026-08-17T22:59:09.540Z` captured |
| Activity rows (3 d, all guests) | 27 |
| Guest consents | 8 × granted, policy-bound, published policies |
| AgentAccount for guests | none (not a blocker — check is account-exists-then-active) |
| AgentToken (active guest) | valid until `2026-08-18T12:38:23Z`, device `online`, employee `active`, `agentApproved` |
| BreakSession | no open breaks (break-gate not the blocker) |
| Org monitoring keys | `website_native_tracking=true`, `keystroke_logging_enabled=true`, `webcam_capture_enabled=true`, `location_tracking=true`, `screenshot_frequency=1`, `working_hours_only=false`, `agent_server_url=http://localhost:3000`; `website_tracking`/`app_tracking` unset → defaults true |

## 10. Realtime / WebSocket / SSE Audit

- Port 3010: **NOT listening** (`Test-NetConnection` False; `netstat -ano` has no `:3010`).
- bun process PID 16412 `bun --hot mini-services/live-updates/index.ts` (parent = dev.mjs
  node PID 9256, started 2026-08-18 10:14:45 local) is alive **but parked**: `bun --hot`
  keeps the process in a restart-wait loop after the module crashes at import.
- **Root cause, reproduced:** running the service as dev.mjs does:
  `bun mini-services/live-updates/index.ts` → exits 1 immediately:
  ```
  error: @prisma/client did not initialize yet. Please run "prisma generate" and try to import it again.
      at new PrismaClient (E:\Workslens\OmniSight\mini-services\live-updates\node_modules\.prisma\client\default.js:43:15)
      at E:\Workslens\OmniSight\mini-services\live-updates\index.ts:71:12
  ```
- Why: `mini-services/live-updates/node_modules/@prisma/client` was installed
  (2026-08-17 17:45-17:47 local) but its generated output under
  `node_modules/.prisma/client` contains only the ~2 KB "did not initialize yet" stub —
  `prisma generate` was never run in that directory (its own package.json defines
  `"generate": "prisma generate --schema ../../prisma/schema.prisma"`). Bun resolves the
  LOCAL `@prisma/client` (it shadows the root node_modules), so the service dies at
  `new PrismaClient()` (index.ts:71) before `assertPollModels`, before `listen()`.
- The root `node_modules/@prisma/client` is fully generated (verified: it enumerates all
  models including agentBuild/policyViolation/timeEntry/anomaly/alert/guest/usbEvent/
  appListEntry) — the Next app (port 3000) is unaffected. Yesterday the service ran fine
  because the local node_modules did not exist yet (cursor persisted 2026-08-17 07:09:24Z).
- Secondary anomaly (environmental, non-causal today): cursor VALUE (`13:09:24.628Z`) is
  exactly +6 h from its DB `updatedAt` (`07:09:24.633Z`). A local process cannot produce
  this skew; consistent with a WSL/Docker clock-drift artifact from yesterday's session.
  After the service is fixed, the stale cursor will simply catch up (at-least-once,
  dedupe-by-id design).

## 11. Real Guest Reproduction (runtime evidence)

1. Agent running (4 processes, 10:12:02 local), connected to `::1:3000`; bridge :59706 up.
2. `POST /api/agent/heartbeat` with real token → device `lastHeartbeat` advances every ~60 s
   (observed 22:38:10Z → 22:51:10Z → 22:59:11Z).
3. Activity rows created at 22:56:50Z; screenshots at :59:09Z — ingestion works.
4. Browser socket to `http://localhost:3010` — connection refused; `isConnected=false` →
   OFFLINE badge; no events ever delivered. (This is the ONLY failing hop.)

## 12. Failure Matrix

| # | Layer | Component | Verdict | Evidence |
|---|---|---|---|---|
| F-1 | Realtime | live-updates Prisma client | **FAIL (root cause)** | ungenerated stub in `mini-services/live-updates/node_modules`; crash reproduced at `index.ts:71` |
| F-2 | Realtime | socket.io listen on 3010 | FAIL (downstream of F-1) | netstat empty; TCP test False |
| F-3 | Realtime | poll cursor advance | FAIL (downstream of F-1) | SystemSetting updatedAt 2026-08-17T07:09:24Z (~21 h stale) |
| F-4 | UI | OFFLINE badge | Correct behavior (downstream) | `!isConnected` with dead endpoint |
| F-5 | UI | Live event stream | Empty (downstream) | 100% socket-fed, no API fallback |
| F-6 | Agent | Heartbeat | PASS | lastHeartbeat 7 s old |
| F-7 | Agent | Activity collect/queue/upload | PASS | rows created 22:56:50Z; queue acked-empty |
| F-8 | Agent | Screenshot upload | PASS | rows each minute to 22:59:09Z |
| F-9 | Consent | server state | PASS | 8/8 granted, policies published |
| F-10 | Agent config | monitoring flags | PASS | appTracking/websiteTracking/… = true |
| F-11 | Ingestion | /api/agent/activity | PASS | 200s, validation intact, 403/422 paths verified |
| F-12 | Presence | online semantics | PASS | heartbeat freshness correct; sticky status cosmetic |

## 13. Root Cause

**P0 — `mini-services/live-updates` resolves a broken local `@prisma/client`:**
`npm install` in that directory (2026-08-17 17:45 local) created `node_modules/@prisma/client`
whose generated output is missing (`prisma generate` was never run there). Bun shadows the
root client, so `new PrismaClient()` (index.ts:71) throws on every boot; `bun --hot` parks
the crashed process (PID 16412 alive since 10:14:45), port 3010 never opens, the durable
poll cursor never advances, and the Live Monitor has no realtime channel.

There is **no bug in product code** — the fix is a dev-environment correction
(`npm run generate` in `mini-services/live-updates`, or removing that local node_modules).

## 14. Evidence

- `Get-CimInstance Win32_Process` PID 16412 → `bun --hot mini-services/live-updates/index.ts`.
- `netstat -ano | Select-String ":3010"` → empty; `Test-NetConnection 127.0.0.1:3010` → False.
- `bun mini-services/live-updates/index.ts` → exact `@prisma/client did not initialize yet`
  crash at `index.ts:71` (reproduction run, no side effects, exits 1).
- `mini-services/live-updates/node_modules/.prisma/client/*` = 2076-byte stubs, LastWriteTime
  2026-08-17 05:45-05:47 PM local (install time, no generate).
- Root `node_modules/@prisma/client` loaded in node → full delegate list (organization…
  breakSession, all models present) — proves only the local copy is broken.
- Live HTTP probes (read-only): `/api/health` 200 JSON; `/api/agent/{consent,config,activity}`
  with invalid token → JSON 401s (route graph healthy); consent/config with the guest's real
  token → allGranted=true, tracking enabled.
- DB SELECTs: heartbeat ages, consents vs policies, activities, screenshots, tokens,
  settings, breaks, AgentAccount, cursor row (see §9).

## 15. Security Impact

- **No security regression found.** Consent enforcement is intact and server-authoritative
  (403 verified in code + live state); activity ingestion validation is strict (422 whole
  batch, allowlists, length caps, future-timestamp rejection); queue at-rest encryption
  (AES-256-GCM) and fail-closed gating verified; org-room isolation code path reviewed;
  JWT + session revocation (UserSession check) intact.
- The failure is availability-only (realtime delivery), not confidentiality/integrity.
- Minor hardening note: `mini-services/live-updates/node_modules` shadowing a dependency
  with a broken artifact is exactly the class of environment drift that a boot-time
  self-check (`assertPollModels` already exists, but the import crash happens before it)
  is meant to catch — recommend a module-load smoke test in CI/dev startup.

## 16. Why the Guest Appears Online But Has No Activity

| Observable | Truth |
|---|---|
| Guest shows online | Heartbeat freshness — real (7 s old). Also sticky `Device.status='online'` and `Guest.status='ACTIVE'` in raw rows. |
| No activity in Live Monitor | Realtime stream dead (F-1/F-2). The stream has no API fallback, so an offline socket = empty feed. |
| Activity exists? | YES — 27 rows/3 d, still flowing (22:56:50Z), plus screenshots every minute. Event Stats card (DB-backed) would show it. |
| Consent blocked? | No — 8/8 granted, policies published, live endpoint confirms. |
| Config disabled? | No — all tracking flags true from server. |
| Agent broken? | No — heartbeats, activity, screenshots all reach the DB. |

The "no activity" is a **delivery** symptom, not a **collection** or **consent** symptom.

## 17. Recommended Fix (dev environment — no code change required)

1. `cd mini-services/live-updates && npm run generate` (runs `prisma generate --schema ../../prisma/schema.prisma`), or simply delete `mini-services/live-updates/node_modules` so bun resolves the already-generated root client.
2. Restart the dev stack (stop `dev.mjs`; the bun --hot process will re-crash until step 1 is done).
3. Verify: `Test-NetConnection localhost:3010` = True; console shows `⚡ OmniSight Live Updates WebSocket service on port 3010`; cursor row advances; Live Monitor badge flips LIVE; activity-ping events appear within ≤5 s of a new Activity row.
4. (Optional hardening) add a startup/CI smoke test that imports the service module before boot.

## 18. Regression Tests Required

1. **Service boot test:** run the live-updates entry and assert it reaches `listen()` (fails fast on ungenerated client).
2. **E2E dev-stack test:** `npm run dev` → assert port 3010 listening + `/api/health` JSON.
3. **Live Monitor integration test:** connect socket with a valid session JWT → badge LIVE; insert a real Activity row → `activity-ping` received; `connected` handshake carries org-scoped counts.
4. **Durable cursor test (existing, re-run):** restart service → catches up rows committed during downtime, no duplicates (dedupe-by-id).
5. **Consent fail-closed regression (existing):** revoke `activity_tracking` → collector stops ≤5 min; uploads 403; re-grant → resumes.
6. **Presence transition test (existing):** heartbeat fresher than threshold → ONLINE; stale → OFFLINE event only on transition.

## 19. Production Verification Checklist

- [ ] `prisma generate` artifact present in the deployed service's node_modules (or single shared client).
- [ ] Port 3010 listening; socket handshake with JWT + `worklens_token` cookie both accepted; revoked session disconnected (S-04).
- [ ] Two-org test: events only in the caller's org room.
- [ ] Poll cursor persists across restart; catch-up after downtime; no duplicate client entries.
- [ ] Website rows normalized to domains; full URLs never stored.
- [ ] Consent revocation → 403 on activity/screenshot uploads (fail closed, logged).
- [ ] Device summary / presence counts match heartbeat freshness (not sticky status).

---

AUDIT RESULT: **FAIL** — realtime delivery layer is broken (Live Monitor OFFLINE, no events).

PRIMARY ROOT CAUSE: **Missing generated Prisma client in `mini-services/live-updates/node_modules`** — service crashes at `new PrismaClient()` (`index.ts:71`); `bun --hot` parks the dead process; port 3010 never binds; poll cursor stale ~21 h; Live Monitor socket never connects.

SECONDARY ISSUES: (1) Live Monitor event stream has no API fallback when the socket is down (empty feed + OFFLINE badge only); (2) sticky `Device.status`/`Guest.status` labels can imply liveness; (3) cursor value/updatedAt +6 h skew from yesterday's run (environmental clock artifact, likely WSL/Docker; non-causal); (4) agent logs are stdout-only (no on-disk log file), impeding diagnostics.

FIX REQUIRED: **YES** — run `npm run generate` in `mini-services/live-updates` (or remove its local `node_modules`) and restart the dev stack. No product-code changes needed.

NO CODE CHANGES WERE MADE: **YES** — only SELECT queries, read-only endpoint probes, and a crash-reproduction run of the existing service; no source, schema, seed, DB, or configuration modifications. Temporary helper scripts were created under the OS temp directory and deleted.