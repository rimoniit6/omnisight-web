# LIVE-MONITOR-ACTIVITY-SECOND-AUDIT.md

> POST-FIX forensic audit of the Activity realtime pipeline.
> READ-ONLY — no source, schema, database, or configuration was modified.
> All timestamps UTC unless noted. Machine timezone: Asia/Dhaka (UTC+6).

---

# Executive Summary

The previous root cause was NOT fixed. The claimed fix ("Prisma client was generated")
was never actually applied:

- `mini-services/live-updates/node_modules/.prisma/client` still contains the 9-file
  **ungenerated stub** (2076-byte `default.js` throwing `@prisma/client did not
  initialize yet`), with file timestamps unchanged since **2026-08-17 05:45:55 PM local**
  (the npm install) — no `runtime/` directory, nothing regenerated.
- A fresh reproduction run exits 1 with the identical error at `index.ts:71:12`.
- **Port 3010 is still NOT listening** (netstat empty, Test-NetConnection False) after the
  11:20:58 AM dev-stack restart.
- The bun process (PID 4296) is alive **only because `bun --hot` parks a crashed module**
  waiting for file changes — process alive ≠ service running.

Everything the audit verified downstream of the service — the activity query semantics,
the real Guest activity row, the event transformation, the socket event-name contract,
the browser listeners, the frontend filters, the organization room, the pg_notify
triggers — is **correct**. The pipeline is broken at exactly ONE hop: the live-updates
service cannot initialize its Prisma client, so it never starts, never binds port 3010,
never polls, never emits, and the browser can never connect.

The Guest IS online (heartbeat 24 s fresh at audit time), activities ARE created in the
DB (latest 2026-08-18T05:29:51.571Z — minutes before the audit), screenshots ARE uploaded
— none of which reaches the Live Monitor because every Live Monitor event is a socket
event from the dead service.

AUDIT RESULT: **FAIL** — realtime Activity delivery remains broken; previous fix not applied.

---

# Previous Fix Verification

| Claim | Verified Reality |
|---|---|
| "Prisma client was generated" | **FALSE.** `mini-services/live-updates/node_modules/.prisma/client/` = 9 files, all 2076–3989 bytes, LastWriteTime **2026-08-17 05:45–05:47 PM** (install time). `default.js` line 43 still `throw new Error('@prisma/client did not initialize yet...')`. No `runtime/` directory (a generated client always has one). |
| "Dev stack was restarted" | TRUE — `npm run dev` → dev.mjs (PID 3936) → `bun --hot mini-services/live-updates/index.ts` (PID 4296) at **2026-08-18 11:20:58 AM** local (05:20:58Z). |
| "Live Updates service is expected to be running" | **FALSE.** PID 4296 is parked on a crash; `netstat -ano` shows no `:3010`; `Test-NetConnection localhost:3010` = False. |
| Reproduction (fresh) | `bun mini-services/live-updates/index.ts` → **exit code 1**: `error: @prisma/client did not initialize yet. Please run "prisma generate" and try to import it again. at new PrismaClient (…mini-services\live-updates\node_modules\.prisma\client\default.js:43:15) at …live-updates\index.ts:71:12` — identical to the pre-fix failure. |

Why the fix attempt failed: `npm run generate` (or deleting the local node_modules) was
never executed in `mini-services/live-updates`; regenerating the ROOT client (if that is
what was done) does not touch the local copy, and bun resolves the local stub first.

---

# Current Architecture

```
OmniSightAgent (4× OmniSightAgent.exe, 10:12:02 AM) ──► Next (port 3000) ──► PostgreSQL workai
   ├─ heartbeat  ──► Device.lastHeartbeat (24 s fresh)                    [WORKS]
   ├─ activity   ──► Activity rows (latest 05:29:51Z)                     [WORKS]
   └─ screenshot ──► Screenshot rows + files (every ~60 s)                [WORKS]

Browser (Admin UI)
   └─ websocket-provider → http://localhost:3010 (NEXT_PUBLIC_LIVE_UPDATES_URL)
        └─ mini-services/live-updates (socket.io)  ←── polls DB every 5 s / pg_notify wake
                └─ broadcasts: activity-ping, new-screenshot, employee-presence, …
```

The socket service is the ONLY source of Live Monitor realtime events (the live feed has
no API fallback). It never writes to the DB except the durable poll cursor.

---

# Live Updates Service Health

| Item | Value |
|---|---|
| SERVICE_PROCESS | `bun --hot mini-services/live-updates/index.ts` (spawned by dev.mjs PID 3936) |
| SERVICE_PID | 4296 (alive since 11:20:58 AM local — parked, not serving) |
| SERVICE_PORT | 3010 — **NOT LISTENING** |
| PRISMA_INITIALIZATION | **FAIL** — ungenerated stub resolved from local node_modules |
| SOCKET_LISTENING | **FAIL** |
| SERVICE_UPTIME | 0 effective (crash at module import; process parked by `bun --hot`) |
| Startup exception | `@prisma/client did not initialize yet` at index.ts:71:12, exit 1 |
| Restart loop | None visible (bun --hot parks silently; no churn) |

---

# Browser Socket Health

- Provider: `src/components/providers/websocket-provider.tsx` — connects only when
  `isAuthenticated`, candidates in order: `NEXT_PUBLIC_LIVE_UPDATES_URL`
  (`http://localhost:3010`, set by dev.mjs) → `/?XTransformPort=3010` → `http://<host>:3010`.
- Runtime probe (socket.io-client → `http://localhost:3010`, websocket transport):
  **`connect_error -> websocket error`** — connection refused.
- `socket.connected = false`; the OFFLINE badge (`live-monitor-page.tsx:670-675`,
  rendered when `!isConnected`) is CORRECT given the dead endpoint.

| Item | Value |
|---|---|
| socket.connected | false |
| socket.id | none |
| connection URL | http://localhost:3010 (refused) |
| transport | websocket (fallback polling also refused) |
| namespace | / (root) |
| connection_error | websocket error |
| disconnect reason | n/a (never connected) |

---

# Socket Authentication

Server middleware (`index.ts:143-186`): token = `auth.token` XOR `worklens_token` cookie →
HS256 JWT verify (JWT_SECRET loaded by bun from root .env — present, 54 chars) → optional
`sessionId` → `UserSession` row must exist, not revoked, not expired (fail closed) →
`organizationId` claim REQUIRED (else `no-organization`) → `socket.data` set → connection
handler joins `org:<organizationId>`.

| Item | Value |
|---|---|
| USER_ID | cmsxa4ddq0001fi4sog20t9po (Super Admin, admin@worklens.ai, isActive, role super_admin) |
| ORG_ID | cmsxb6wpg0004fi80qe2ou44r |
| ROOM_ID | `org:cmsxb6wpg0004fi80qe2ou44r` |
| SOCKET_ID | n/a (service down) |
| AUTH_STATUS | PASS by code+data (JWT carries organizationId per login route; 30+ active UserSession rows, expiry Aug 24–25) |
| ROOM_JOIN_STATUS | n/a (service down) — would join the correct room |

---

# Organization Room

| Entity | organizationId |
|---|---|
| Guest employee (Guest Rimon) | cmsxb6wpg0004fi80qe2ou44r |
| Guest device (Rimon) | cmsxb6wpg0004fi80qe2ou44r |
| Latest Activity row | cmsxb6wpg0004fi80qe2ou44r |
| Latest Screenshot row | cmsxb6wpg0004fi80qe2ou44r |
| Admin (Super Admin) | cmsxb6wpg0004fi80qe2ou44r |
| Socket room target | `org:cmsxb6wpg0004fi80qe2ou44r` |

**All match.** No multi-tenant mapping error. Org: "Bangladesh computer Council",
timezone Asia/Dhaka.

---

# Database Connection Comparison

| | Next.js app | live-updates service |
|---|---|---|
| Env source | root `.env` | bun auto-loads root `.env` (cwd = repo root; no `.env` inside mini-services — verified absent) |
| DATABASE_URL | `postgresql://postgres:***@localhost:5432/workai` | same value (resolveDbUrl appends `connection_limit=5` only) |
| Host / port / db | localhost:5432 / workai | localhost:5432 / workai |

The service would connect to the **same PostgreSQL database** — proven by config
inspection. The root Prisma client (same one Next uses) successfully reads the guest's
latest Activity row (05:29:51.571Z) — the data IS visible on that connection. The
live-updates failure is NOT a wrong-DB/wrong-datasource issue; it never gets past
`new PrismaClient()` because the local stub shadows the working root client.

---

# Poll Cursor Analysis

| Item | Value |
|---|---|
| Key | `SystemSetting.live_updates.poll_cursor` (row cmsx8pj5p034zfijkpq6icpej) |
| value | `2026-08-17T13:09:24.628Z` — **UNCHANGED** across both audits |
| updatedAt | `2026-08-17T13:09:24.633Z` (was `07:09:24.633Z` in audit 1 — see Secondary Issues) |
| DB now | `2026-08-18T05:30:36.467Z` |
| Latest Activity.createdAt | `2026-08-18T05:29:51.571Z` — cursor is 16 h 21 m BEHIND the newest row |

```
CURSOR_STATE = STALE (not advancing — no poll round has completed since the service
               last ran on Aug 17; value/updatedAt both ~16-22 h old)
```

Not advancing because the service never starts (Phase 1). The cursor would correctly
catch up after restart (at-least-once design, dedupe-by-id on the client).

---

# Exact Activity Query

`index.ts:341-348` (inside `pollOnce`, one of 14 parallel queries):

```ts
db.activity.findMany({
  where: { createdAt: { gt: since }, type: { in: ['application', 'website'] } },
  include: { employee: { select: { id, firstName, lastName, departmentId, organizationId } } },
  orderBy: { createdAt: 'desc' },
  take: 20,
})
```

- Cursor field: **`createdAt`** (`gt: since`, where `since = cursor` — the durable cursor; no ±5 s fudge).
- Tenant filter: **NONE at query level** — org scoping is applied at emit time via
  `employee.organizationId` (each row is emitted only into its own org room). This is a
  deliberate design and is safe (org identity comes from the authenticated room).
- No archived/deleted filter (Activity has none), no consent filter at the poll (consent
  is enforced at ingestion), no internal-process filter at the poll (enforced at ingestion).
- `nextPollCursor` (poll-cursor.ts): `max(now, newest processed)` — never earlier than `now`, so no replays; cursor persisted AFTER the round (at-least-once).

---

# Real Activity Row Match

Real latest row for the currently-online Guest (read-only SELECT, minutes before audit end):

| Field | Value |
|---|---|
| Activity.id | cmsy841xx0024figokik0h7u2 |
| employeeId | cmsxk67m50023fi84tlizyizo (Guest Rimon, status active) |
| deviceId | cmsxk586d001pfi84euhtmobn (Rimon) |
| organizationId | cmsxb6wpg0004fi80qe2ou44r |
| type | application |
| category | productive |
| title | opencode - OmniSight - Visual Studio Code |
| applicationName | Code.exe |
| url | null |
| duration | 10 s |
| timestamp | 2026-08-18T05:29:22.909Z |
| createdAt | 2026-08-18T05:29:51.571Z |

| Condition | Expected | Actual | PASS/FAIL |
|---|---|---|---|
| createdAt > cursor | true | 05:29:51.571Z > 13:09:24.628Z ✓ | PASS |
| type in [application, website] | true | application ✓ | PASS |
| employee relation present | true | included, org set ✓ | PASS |
| organization matches (emit target) | cmsxb6wpg… | cmsxb6wpg… ✓ | PASS |
| device valid | true | device row exists, heartbeat 05:30:12Z ✓ | PASS |
| not archived / no status filter | true | n/a (no such fields) | PASS |
| take 20 (not truncated) | true | newest of all rows ✓ | PASS |

**Every condition passes.** If the poll ran, this exact row would be fetched, transformed,
and emitted as `activity-ping` into `org:cmsxb6wpg0004fi80qe2ou44r`.

---

# Activity Event Transformation

- Builder: `mini-services/live-updates/activity-events.ts` — `buildActivityPing(a, emp, departmentName)`,
  pure function. Output: `{ id, employeeId, employeeName, department, activityType,
  activityTitle, activityUrl, category, duration, timestamp }` (timestamp =
  `createdAt.toISOString()`). Website URLs re-validated as bare domains (privacy); this row
  is an application row → `activityUrl: null`.
- Discard conditions in the emit loop (`index.ts:612-619`): only `if (!emp) continue`.
  The guest row HAS an employee → would be **transformed and emitted**.
- Status: A. queried — would be; B. transformed — would be; C. discarded — no; D. emitted — NO (poller never runs).

---

# Event Emission

- Code: `index.ts:615-618` — `io.to('org:' + emp.organizationId).emit('activity-ping', buildActivityPing(...))`.
- Payload: bounded, org-scoped, DB-derived (never fabricated).
- For the real activity row:

| Item | Value |
|---|---|
| ACTIVITY_FOUND (DB) | YES — cmsy841xx0024figokik0h7u2 |
| EVENT_CREATED | NO — pollOnce never executes (service never starts) |
| EVENT_EMITTED | NO |
| ROOM | org:cmsxb6wpg0004fi80qe2ou44r |
| ROOM_SOCKET_COUNT | 0 (no server, no sockets) |
| EVENT_NAME | activity-ping |

---

# Browser Event Listener

- `websocket-provider.tsx:366-384` — `socket.on('activity-ping', …)`: sets `lastActivity`,
  adds a `LiveEventLog` entry (type `activity-ping`, title/description/timestamp, priority
  `medium` for unproductive else `low`), invalidates activity queries.
- Registered inside the connection effect (before any event could arrive), single
  registration per socket, no duplicate/cleanup issue.
- Handler would execute correctly; it never receives anything because the socket never
  connects. No stale-closure or filter bug in the provider.

---

# Frontend Filtering

- Live Monitor page (`live-monitor-page.tsx`): filters are **type-only** —
  `activeFilters` initialized with ALL `ALL_EVENT_TYPES` selected (line 562), filter =
  `eventLog.filter(e => activeFilters.has(e.type))` (line 573-575). `activity-ping` is in
  `ALL_EVENT_TYPES` (line 49).
- **No** employee/department/project/guest/status/role exclusion anywhere on this page.
- Device Grid (`/api/devices`, refetch 30 s) uses heartbeat freshness — the Guest device
  renders ONLINE, matching the user's "Guest is ONLINE" observation.
- Event Stats card is DB-backed (`/api/live-monitor/event-stats`) — works independently.

**Conclusion: the Guest is NOT filtered out anywhere in the frontend.**

---

# Screenshot vs Activity Comparison

```
Screenshot:  Agent ──► /api/agent/screenshot ──► Screenshot row (05:30:12.147Z) ──► Screenshots page (API)   WORKS
Activity:    Agent ──► /api/agent/activity   ──► Activity row    (05:29:51.571Z) ──► Activities page (API)    WORKS
Both:        DB row ──► live-updates poll ──► socket event ──► Live Monitor feed                            DEAD
```

- Both pipelines share the identical failing hop: **DB row → live-updates poll**.
- Screenshots appear to "work" only because the Screenshots page is API-backed; the
  Live Monitor `new-screenshot` event is equally dead.
- FIRST DIVERGENCE = **live-updates service startup (Prisma client stub)** — every
  realtime path (activity AND screenshot AND presence AND everything else) stops there.

---

# Real-Time Reproduction Timeline

Real, natural activity from the online Guest (no data inserted by this audit):

| Stage | Timestamp | Status |
|---|---|---|
| T0 — Activity row created in DB | 2026-08-18T05:29:51.571Z | ✓ observed |
| live-updates sees Activity | — | ✗ NEVER (service down; port 3010 closed) |
| poll cursor advances | — | ✗ unchanged (13:09:24.628Z) |
| event generated | — | ✗ never |
| event emitted to org room | — | ✗ never |
| browser receives | — | ✗ connect_error (probe: `websocket error`) |
| React handler runs | — | ✗ never |
| Live Monitor renders | — | ✗ OFFLINE badge (correct for dead socket) |

Expected latency (design): ≤ 1 s P95 via pg_notify wake, ≤ 5 s via poll.
Actual latency: **never delivered — the pipeline stops at T0**.

---

# Failure Matrix

| Stage | Expected | Actual | Status | Evidence |
|---|---|---|---|---|
| Agent heartbeat | Working | 05:30:12Z, 24 s old | PASS | Device row SELECT |
| Agent activity generation | Working | rows created through 05:29:51Z | PASS | Activity rows SELECT |
| /api/agent/activity | 2xx | rows persist (ingestion OK) | PASS | DB rows + prior route audit |
| Activity DB insert | Row created | cmsy841xx0024figokik0h7u2 | PASS | SELECT |
| Live-updates process | Running | PID 4296 alive but parked | FAIL | CIM process + no listener |
| Port 3010 | Listening | closed | FAIL | netstat, Test-NetConnection |
| Prisma client | Initialized | ungenerated stub | FAIL | stub files, exit-1 repro |
| DB connection | Same DB | config identical (localhost:5432/workai); never established | FAIL* | .env + resolveDbUrl code |
| Poll loop | Running | never starts | FAIL | index.ts:71 crash < start() |
| Poll cursor | Advancing | STALE 16 h+ | FAIL | SystemSetting SELECT |
| Activity query | Finds row | row matches all conditions; query never runs | FAIL* | conditions table (row-side PASS) |
| Activity transformation | Creates event | never runs (builder verified correct) | FAIL* | activity-events.ts |
| Socket room | Correct org | org:cmsxb6wpg0004fi80qe2ou44r (all IDs match) | PASS | org/employee/device/admin SELECTs |
| Event emission | Delivered | never emitted | FAIL* | index.ts:615 (unreachable) |
| Browser socket | Connected | connect_error | FAIL* | socket.io-client probe |
| Event listener | Registered | `activity-ping` registered at provider level | PASS | websocket-provider.tsx:366 |
| Event handler | Executes | never invoked | FAIL* | no event arrives |
| React state | Updated | never | FAIL* | downstream |
| Frontend filter | Allows Guest | type-only filters, all enabled, no guest exclusion | PASS | live-monitor-page.tsx |
| UI render | Visible | OFFLINE badge + empty feed | FAIL* | page code + dead socket |

`*` = downstream of the single primary failure (the service never starts).

---

# Root Cause

**PRIMARY (unchanged, re-proven):** `mini-services/live-updates` resolves
`@prisma/client` from its OWN `node_modules`, which contains an **ungenerated stub**
(npm install on 2026-08-17 17:45 local; `prisma generate` never run there). Bun shadows
the working root client, so `new PrismaClient()` (`index.ts:71`) throws at module load on
every boot. `bun --hot` (dev.mjs spawn style) parks the crashed process (PID 4296) waiting
for file changes — no restart loop, no port, no poll, no cursor advance, no events. The
"fix" reported by the user was **never applied** (stub files byte-identical and same
timestamps; fresh reproduction exits 1 with the identical error).

Classification (Phase 22): **D — Live-updates database connection layer** (its Prisma
client cannot initialize), which prevents stages E–O from executing. There is no product
code bug; the service, query, transformation, room routing, event contract, browser
listeners, and frontend filters are all correct by code and data inspection.

---

# Secondary Issues

1. **Claimed fix not verifiable via git** — `node_modules` is gitignored; the broken
   artifact is invisible to version control, and the working tree shows no changes that
   would regenerate it.
2. **`bun --hot` masks the crash** — the parked process looks "running" (Task Manager),
   while the actual error is only visible in the dev.mjs console; nothing ever binds 3010.
   A boot self-check (`assertPollModels`) exists but is unreachable — the import crash
   happens before `start()`.
3. **Poll cursor clock-skew anomaly persists** — `value` 13:09:24.628Z vs `updatedAt`
   07:09:24.633Z in audit 1; `updatedAt` re-read as 13:09:24.633Z in this audit (row
   re-upserted between audits by a process whose clock read ~+6 h vs UTC — consistent
   with a container/WSL timezone confusion). The 5 ms value↔updatedAt delta pairs across
   both readings. Non-causal for this outage (cursor semantics are UTC-normalized), but
   worth fixing the environment's clock.
4. **No on-disk logging** for the service (stdout/stderr only via dev.mjs prefix) —
   diagnosis relies on console capture.
5. **Live Monitor stream has no API fallback** — when the socket is down the user sees
   only an OFFLINE badge + empty feed, with no indication of why (DB is fine).
6. **Sticky `Device.status='online'` / `Guest.status` labels** can imply liveness in
   list views; presence semantics (heartbeat freshness) are correct everywhere the code
   actually computes them.

---

# Evidence

- `netstat -ano | findstr :3010` → empty; `Test-NetConnection localhost:3010` →
  `TcpTestSucceeded: False`.
- CIM: PID 4296 `bun --hot mini-services/live-updates/index.ts` (parent 3936 dev.mjs),
  started 11:20:58 AM local — alive, no listener.
- Fresh repro `bun mini-services/live-updates/index.ts` → **exit code 1**,
  `@prisma/client did not initialize yet` at `index.ts:71:12` (identical to pre-fix).
- `mini-services/live-updates/node_modules/.prisma/client/*` — 9 stub files (2076 B js),
  LastWriteTime 2026-08-17 05:45–05:47 PM; no `runtime/` dir.
- Root `@prisma/client` (same as Next) — functional (all SELECTs in this audit ran
  through it); the local stub shadows it for bun.
- DB SELECTs (read-only): latest Activity cmsy841xx0024figokik0h7u2 (05:29:51.571Z),
  Screenshot 05:30:12.147Z, Device lastHeartbeat 05:30:12.153Z, SystemSetting cursor
  (13:09:24.628Z / updatedAt 13:09:24.633Z), AppUser admin (org cmsxb6wpg0004fi80qe2ou44r),
  30+ active UserSessions, all 14 `omnisight_notify_*` triggers present in pg_trigger.
- socket.io-client probe → `connect_error -> websocket error`.
- Code: pollOnce query/emit paths, activity-events.ts builder, poll-cursor.ts,
  cursor-store.ts, notify-triggers.ts, websocket-provider listeners, live-monitor-page
  filters, login JWT claims — all reviewed; no contract or filter defect.
- Git: realtime stack last modified in bfd47e5 (Aug 17 14:12Z); no later commits touch
  it; the local node_modules stub is unversioned.

---

# Recommended Fix

1. `cd mini-services/live-updates && npm run generate` (pinned to the authoritative
   `--schema ../../prisma/schema.prisma`), **or** delete
   `mini-services/live-updates/node_modules` so bun resolves the working root client.
2. Touch any file under mini-services (or restart `npm run dev`) to trigger a real
   `bun --hot` reload.
3. Verify: `Test-NetConnection localhost:3010` = True; console shows
   `⚡ OmniSight Live Updates WebSocket service on port 3010` and
   `realtime wake-up listening on pg_notify('omnisight_events')`; cursor row advances;
   Live Monitor badge flips LIVE; the guest's next activity arrives as `activity-ping`
   within ≤ 5 s (≤ 1 s with the notify wake).
4. Optional hardening: add a CI smoke test that imports the service entry module
   (catches the ungenerated-client class of failure before boot); fix the environment
   clock behind the +6 h cursor skew; add on-disk logging.

---

# Regression Tests

1. **Service boot smoke test** — run the live-updates entry; assert it reaches
   `listen()` on 3010 (fails fast on ungenerated client).
2. **E2E dev-stack test** — `npm run dev` → assert 3010 listening + `/api/health` JSON.
3. **Live Monitor integration test** — connect with a session JWT; assert `connected`
   handshake (device/employee counts), badge LIVE, and a real Activity insert produces an
   `activity-ping` within the SLA.
4. **Durable cursor test (re-run existing)** — restart service → catch-up of rows
   committed while down, no duplicates (client dedupe by id).
5. **Notify wake test** — verify pg_notify wakes the poller (< 1 s) and that the 5 s
   poll recovers when the listener is down.
6. **Guest room test** — a guest's activity reaches only `org:<id>` of the guest's org;
   a second org's admin receives nothing.

---

AUDIT RESULT:
- Previous Prisma Fix: FAIL
- Live Updates Service: FAIL
- Port 3010: FAIL
- Browser Socket: FAIL
- Socket Authentication: PASS
- Organization Room: PASS
- Database Connection: FAIL
- Poll Loop: FAIL
- Poll Cursor: FAIL
- Activity Query: FAIL
- Activity Transformation: FAIL
- Socket Emit: FAIL
- Browser Listener: PASS
- Frontend State: FAIL
- Frontend Filter: PASS
- UI Rendering: FAIL

FIRST FAILING HOP:
`mini-services/live-updates` startup — `new PrismaClient()` (`index.ts:71`) throws
`@prisma/client did not initialize yet` because the service's local `node_modules/.prisma/client`
is the ungenerated stub; the process never reaches `listen()` on port 3010. Everything
downstream (poll, cursor, query, transform, emit, browser socket, handler, state, render)
is downstream of this hop.

PRIMARY ROOT CAUSE:
The claimed fix was not applied: `prisma generate` was never run inside
`mini-services/live-updates` (stub files unchanged since the 2026-08-17 17:45 install,
no `runtime/` output), so the live-updates service still crashes at import under
`bun --hot`, port 3010 never binds, and the realtime Activity pipeline
(DB row → poll → activity-ping → Live Monitor) is dead while ingestion, heartbeats,
screenshots, consents, and the DB itself all work.

EVIDENCE:
- Port 3010: netstat empty, Test-NetConnection False; bun PID 4296 alive but parked.
- Fresh repro: exit code 1, identical stub error at index.ts:71:12.
- Stub artifacts: 9 files, 2076-byte default.js, LastWriteTime 2026-08-17 05:45 PM, no runtime/.
- Real guest activity row cmsy841xx0024figokik0h7u2 (created 05:29:51.571Z) satisfies every
  poll-query condition; cursor stale at 13:09:24.628Z.
- Browser probe: connect_error -> websocket error.
- Org/room identity matches (admin = guest = activity = cmsxb6wpg0004fi80qe2ou44r);
  14 pg_notify triggers exist; event-name contract server↔browser fully matched;
  frontend has no guest-exclusion filter.

SECONDARY ISSUES:
1. Fix not applied / unverifiable via git (node_modules gitignored).
2. `bun --hot` masks the crash — parked process looks alive; error only in dev.mjs console.
3. Poll cursor value/updatedAt +6 h clock-skew anomaly (environmental; non-causal).
4. No on-disk service logs.
5. Live Monitor stream lacks an API fallback when the socket is down.
6. Sticky Device/Guest status labels can imply liveness.

FIX SCOPE:
No product code changes required. Environment: run `npm run generate` in
`mini-services/live-updates` (or delete its local `node_modules`) and restart/trigger the
dev stack; optional hardening in `scripts/dev.mjs` (fail loudly when the child exits
non-zero) and a CI boot smoke test.

NO CODE CHANGES MADE:
YES