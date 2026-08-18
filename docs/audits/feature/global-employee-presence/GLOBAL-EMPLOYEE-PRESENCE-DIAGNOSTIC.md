# WorkLensAI — Global Employee Live Presence — Source + Architecture Diagnostic

**Status:** AUDIT COMPLETE — implementation-ready design produced. No source or database was modified.

---

## 1. Executive Summary

| Question | Answer |
|---|---|
| Is there a real "currently connected" signal today? | **YES — `Device.lastHeartbeat`** (bumped by the Desktop Agent every heartbeat: default 60 s, min 10 s, org-configurable). This is the only server-side evidence of a live authenticated agent connection. |
| Does anything *display* that signal as live presence? | **NO.** Nothing derives "online now" from heartbeat freshness. Every existing green dot / online filter is driven by the **sticky `Device.status`** field, which heartbeats set to `online` but **nothing ever reverts** (verified: zero server writes of `status:'offline'` outside seed data). |
| What does the current WS live stream carry? | Device **status *changes*** only. The mini-service poll *sees* every heartbeat (it queries `updatedAt > since`, and heartbeats bump `updatedAt`) but its status-dedup map suppresses heartbeat-only rows — so heartbeat freshness is **never pushed live**. |
| Is the gap a missing primitive? | **No** — the primitive exists. The gap is: (a) no server-side freshness→presence derivation, (b) no live carrier for it, (c) no shared UI component, (d) 20+ surfaces render employee names without presence. |
| Any P0/P1? | **No.** This is an additive feature audit. Existing semantics are intentionally sticky (a device stays "online" as an inventory state) — that is not a bug, but it must not be conflated with presence. |

---

## 2. Presence Primitives — Source of Truth

### 2.1 `POST /api/agent/heartbeat` — `src/app/api/agent/heartbeat/route.ts`

```text
validateAgentToken()            → 401 on missing/invalid/expired/revoked/foreign
db.device.update({
  where: { id: token.deviceId },
  data:  { status: 'online', lastHeartbeat: new Date() },
})
```

- Runs on the authenticated agent's cadence: default **60 s**, min 10 s, server-configurable (`monitoring.heartbeatInterval`, synced from org settings).
- **When does it stop?** (verified in `desktop-agent/src/services/agent-orchestrator.ts`):
  - agent process quits / machine off / network down → no more beats
  - logout, token revoked, consent revoked→auth 401, orphaned (404) → `stopRuntimeSchedulers()` → **no more beats**
  - pause/break → collectors stop but **heartbeat continues** (agent is still connected)
- ⟹ *"lastHeartbeat within window" is exactly the required semantic: evidence the Desktop Agent is currently connected + authenticated.*

### 2.2 `Device` model — `prisma/schema.prisma` (lines 150–167)

```text
status        String   @default("online")   // online, offline, inactive, maintenance, retired
lastHeartbeat DateTime?                     // ← the only real liveness field
updatedAt     DateTime @updatedAt           // bumps on every heartbeat write
employeeId    String?                       // 0..n devices per employee
organizationId String
agentKey      String?  @unique
```

- **Sticky-`online` proof:** `grep "status: 'offline'" src/` → only `src/lib/seed.ts` (3 seed rows). No API route ever reverts `online`; the single-active-device rule rejects the *new* device with 409 (it does not demote the old one). So `status==='online'` means *"was online at some point since registration"*, **not** "connected now".
- **Multi-device:** the schema allows several devices per employee (0..n), so presence must be **per-employee = ANY device fresh**, not "the" device.

### 2.3 Mini-service live stream — `mini-services/live-updates/index.ts`

```text
poll every ~2 s (configurable):
  changedDevices = db.device.findMany({ where: { updatedAt: { gt: since } },
                     include: { employee: { select: { firstName, lastName, organizationId } } } })

  for dev of changedDevices:
    if deviceStatus.get(dev.id) === dev.status: continue   // ← heartbeats suppressed here
    emit 'device-status' { deviceId, deviceName, oldStatus, newStatus, employeeName, timestamp }
```

- The poll **already reads** heartbeat-bumped rows every cycle — the data needed for presence is already on the wire from the DB to the mini-service.
- What's missing: a freshness comparison (`lastHeartbeat` vs threshold) and a per-employee presence event. Note `lastHeartbeat` is **not currently selected** in the poll (`select` includes employee but the query returns full Device rows — `lastHeartbeat` is available in `dev`).
- Live Monitor frontend consumes `device-status` in `src/components/providers/websocket-provider.tsx` and invalidates `['devices']`-scoped queries; a `presence` event would follow the identical pattern.

### 2.4 Existing "online" consumers (all sticky — do not reuse for presence)

| Surface | Field used | Verdict |
|---|---|---|
| `src/app/api/employees/route.ts` `deviceStatus=online` filter (line 190) | `devices.some({ status: 'online' })` | sticky |
| `src/components/devices/device-table.tsx` green pulse dot (line 79) | `dev.status === 'online'` | sticky |
| `src/components/devices/devices-page.tsx` pulsing dots (lines 318, 335) | `status === 'online'` | sticky |
| `src/components/devices/device-table.tsx` `getOfflineMessage` ("Went offline X min ago") | **freshness-based** but only rendered when `status==='offline'` (≈ never in prod) | dead code path |
| `src/components/devices/device-table.tsx` "last heartbeat … ago" column | `lastHeartbeat` relative time | freshness but **static row value**, refreshed only on query refetch — never pushed |
| `src/app/api/break-status/…` | latest activity title | break state, not presence |
| Dashboard "online devices" KPI / device summary | `db.device.count({ status: 'online' })` (mini-service line 201) | sticky |

---

## 3. Semantic Gap (what the requirement needs vs. what exists)

```text
REQUIRED:  "Evidence exists that this employee is currently connected/online."
           = server-observed recent authenticated agent connection.

MUST NOT mean:
  ✗ employee account is active          (status='active' — unrelated)
  ✗ employee has a device               (device rows persist forever)
  ✗ active sometime today               (sticky status / daily activity)
  ✗ employee's browser page is open     (admin Web UI ≠ agent presence)
  ✗ Device.status === 'online'          (sticky — never reverted)

CORRECT primitive (exists, unused for display):
  Device.lastHeartbeat within a freshness window  →  ONLINE
  else                                            →  OFFLINE (grey)
```

---

## 4. Employee-Name Render Surfaces (integration points)

20+ surfaces render employee names; a `PresenceDot` component + shared hook can cover all of them:

| # | Component | Where the name appears |
|---|---|---|
| 1 | `employees/employee-table.tsx` | avatar + name (lines 254–261, 361–367) |
| 2 | `employees/employee-details-page.tsx` | header (391–401), devices list (1008) |
| 3 | `employees/employee-detail-drawer.tsx` | title (229–235) |
| 4 | `employees/employee-statistics.tsx` | row name (225) |
| 5 | `employees/employee-performance-profile.tsx` | header (226–235), devices (613–631) |
| 6 | `consent/consent-page.tsx` | rows + dialog (458–461, 1030–1033, 1158) |
| 7 | `sentiment/sentiment-page.tsx` | cards + detail (954, 1086–1100) |
| 8 | `projects/projects-page.tsx` | members (1075, 1616–1621, 1738) |
| 9 | `break-status/break-status-page.tsx` | rows (576–581) |
| 10 | `anomalies/anomalies-page.tsx` | cards (260, 405) |
| 11 | `screenshots/screenshots-page.tsx` | rows + dialog (755–760, 1147–1152, 1223–1228) |
| 12 | `activities/activity-timeline.tsx` | rows (103–107) |
| 13 | `dashboard/top-employees.tsx` | rows (70–74) |
| 14 | `dashboard/activity-feed.tsx` | rows (97–103) |
| 15 | `live-monitor/live-monitor-page.tsx` | device rows (407–436) |
| 16 | `organization/recent-hires.tsx` | rows (82–92) |
| 17 | `organization/organization-page.tsx` | roster (311–321) |
| 18 | `departments/department-table.tsx` | manager (54) |
| 19 | `policies/policies-page.tsx` | event employee (478) |
| 20 | `agent-approvals/agent-approvals-page.tsx` | claims/registrations (439, 940, 1078, 1132) |
| 21 | `projects/project-sentiment-tab.tsx` | rows (324–329) |

All surfaces already receive `employee.id` (or `device.employee` with org) — the key needed to join a presence map.

---

## 5. Implementation-Ready Design (no code written — this is the proposal)

### 5.1 Presence definition (server-authoritative)

```text
employee ONLINE  ⇔  ∃ device d : d.organizationId = sessionOrg ∧ d.employeeId = empId
                         ∧ d.lastHeartbeat ≥ now − PRESENCE_WINDOW
```

- `PRESENCE_WINDOW` = **5 minutes** (2.5× the default 60 s heartbeat cadence + skew, absorbs jitter/delayed beats; configurable constant). A beat that arrives every ≤60 s keeps the window warm continuously.
- Multi-device: ANY fresh device → online (agent may run on more than one machine).
- Revocation/expiry/logout: the agent stops heartbeating (`stopRuntimeSchedulers`), so the dot decays to grey within the window with **zero extra server work** — no revocation hook needed.
- Pause/break: heartbeat continues ⟹ dot stays on. This matches the requirement ("connected/online"), and the existing break UI already communicates break state separately.

### 5.2 Live carrier (reuse the existing mini-service + WS)

In `mini-services/live-updates/index.ts`, extend the existing poll:

1. Keep `db.device.findMany({ where: { updatedAt: { gt: since } }, … })` (heartbeats already appear here).
2. Compute per-returned-device `online = dev.lastHeartbeat ≥ now − PRESENCE_WINDOW`.
3. Maintain a per-**employee** presence map (`employeeId → boolean`, warmed on boot like `deviceStatus` at line 450).
4. Emit **only on transition** (same pattern as the device-status dedup map):

```text
emit 'presence' { employeeId, employeeName, online, organizationId, timestamp }
```

- Org scoping is inherited: the emit targets `io.to(\`org:${emp.organizationId}\`)`, exactly like `device-status`.
- Add `lastHeartbeat: true` to the Device select if the query is ever narrowed (currently full rows are fetched, so `lastHeartbeat` is already present).
- **Do not** change the existing `device-status` semantics — sticky inventory status stays as-is; presence is a separate event type.

### 5.3 Snapshot API (page loads / non-WS clients)

New org-scoped endpoint, e.g. `GET /api/employees/presence` (admin/manager, RBAC via the project's `requireAdminOrg`/role helpers):

```text
auth → session org (NEVER client orgId)
WHERE device.organizationId = sessionOrg AND device.lastHeartbeat ≥ now − PRESENCE_WINDOW
SELECT DISTINCT device.employeeId
→ { onlineEmployeeIds: string[], generatedAt }
```

- Single indexed query (`@@index([organizationId, employeeId])` exists; add `lastHeartbeat` to the index if profiling shows a need — see 5.5).
- Returns IDs only (no payload exposure); each surface joins by `employee.id`.

### 5.4 Client

1. **`PresenceProvider`** (client context, mounted once in the admin layout):
   - holds `Set<employeeId>` of online employees
   - seeds from the snapshot API (React Query, org-scoped cache key)
   - subscribes to WS `presence` events and mutates the set (add/remove)
   - exposes `usePresence(employeeId) → boolean` + `PresenceDot` component
   - keeps `presence` out of the same cache key as device data so nothing cross-contaminates
2. **`<PresenceDot online={…} />`** — 8 px emerald pulse (reuse the exact `animate-ping` markup already used in `device-table.tsx`/`devices-page.tsx`) or muted grey circle when offline; title tooltip "Connected via Desktop Agent" / "Not connected".
3. **Rollout order** (all optional): employees table → employee detail header → consent/sentiment/projects rows → dashboard → remaining surfaces. Each is a one-line wrap of the name.

### 5.5 Edge cases & production notes

| Case | Behavior |
|---|---|
| >80 concurrent agents | Mini-service emit is transition-based, bounded by poll cycle; snapshot is a single COUNT/DISTINCT query — no per-event fan-out growth. |
| Heartbeat cadence ≠ 60 s | `PRESENCE_WINDOW` should be derived from `monitoring.heartbeatInterval` (org setting, read in the mini-service config) — e.g. `max(5 min, 3× interval)`. |
| Timezone | Compare in UTC (`new Date()` vs `lastHeartbeat`); no TZ conversion needed for a pure age check. |
| Clock skew | Heartbeats are server-timestamped on write; window absorbs ±jitter. |
| DB index | `Device` has `@@index([organizationId])` + `@@index([employeeId])`; a composite `@@index([organizationId, lastHeartbeat])` would serve the snapshot; verify with `EXPLAIN` before adding (schema change only if profiling requires it). |
| WS disconnect | Client falls back to the snapshot on reconnect (existing provider reconnect logic); presence set refetches. |
| Agent in approval-pending state | No heartbeat until approved ⟹ dot grey — correct (no authenticated agent connection yet). |
| Audit | Viewing presence is a read; follow the existing pattern — no new audit rows unless the product requires monitoring-access logging (current reports/analytics reads do not audit). |

### 5.6 Files that would change (implementation phase)

```text
mini-services/live-updates/index.ts      — presence derivation + emit (5.2)
src/app/api/employees/presence/route.ts  — new snapshot endpoint (5.3)
src/components/providers/presence-provider.tsx — new client context (5.4)
src/components/providers/websocket-provider.tsx — register 'presence' listener
src/components/ui/presence-dot.tsx       — new shared dot component
src/components/employees/employee-table.tsx (+ other surfaces) — wrap names
tests/presence.test.ts                   — org isolation, window, multi-device, revocation decay
```

No Prisma schema change is strictly required (optional index only); no auth/agent/heartbeat/tenant behavior changes.

---

## 6. Key Source Locations (for the implementation phase)

| Concern | File | Line(s) |
|---|---|---|
| Heartbeat liveness write | `src/app/api/agent/heartbeat/route.ts` | 18–22 |
| Device schema (sticky status + lastHeartbeat) | `prisma/schema.prisma` | 150–167 |
| Mini-service device poll + status dedup | `mini-services/live-updates/index.ts` | 243–320, 450–455 |
| WS device-status consumption | `src/components/providers/websocket-provider.tsx` | device-status handler |
| Employees list `online` filter (sticky) | `src/app/api/employees/route.ts` | 190–194 |
| Sticky-status UI dots (existing pattern to reuse) | `src/components/devices/device-table.tsx` | 36–41, 79–84 |
| Agent heartbeat lifecycle (pause vs stop) | `desktop-agent/src/services/agent-orchestrator.ts` | 625–700, 765–769 |
| Org-scoped RBAC helper for the snapshot route | `src/lib/api.ts` | `requireAdminOrg` / role helpers |

---

## 7. Verification Plan (implementation phase)

1. **Unit:** presence derivation (window boundary, multi-device ANY, org scoping, revocation decay) — throwaway-DB harness as in `tests/live-monitor-event-stats.test.ts`.
2. **Tenant:** ORG A's `presence` endpoint/events never contain ORG B employee IDs (mirror the existing 11/11 isolation pattern).
3. **Live:** run the mini-service + agent with real heartbeats; assert `presence {online:true}` on beat, decay to grey after stopping the agent (> window), reconnect → online.
4. **Gates:** `npx tsc --noEmit`, eslint, `npx prisma validate`, `npx next build`, server + agent + extension suites (baselines: 549 / 282 / 7).

---

## 8. Verdict

```text
Existing real presence signal:     Device.lastHeartbeat  (server-authoritative, live)
Currently displayed anywhere:      NO
Sticky Device.status is a bug:     NO (correct inventory semantics — must not be reused for presence)
Schema change required:            NO (optional composite index only)
Auth/tenant/heartbeat changes:     NONE
Implementation surface:            mini-service event + 1 snapshot API + client provider/dot + surface wraps
Feasibility:                       HIGH — every primitive and pattern already exists in the repo
```
