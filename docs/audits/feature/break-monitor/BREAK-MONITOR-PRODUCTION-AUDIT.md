# Break Monitor / HomeBreak Monitor — Production Audit

**Project:** OmniSight (formerly WorkLensAI) workforce monitoring
**Audit date:** 2026-08-16
**Scope:** Break Monitor, "HomeBreak" Monitor, break/idle monitoring, break status, break statistics, break mode / privacy break mode
**Type:** AUDIT ONLY — zero code/schema/DB/config changes made.

---

## 1. Executive Summary

**HomeBreak Monitor does not exist** anywhere in the repository (zero matches for `HomeBreak`/`homebreak`/`home_break`). The feature that exists is the **Break Monitor** page (`/api/break-status` + `BreakStatusPage`), implemented as a **status display and admin force-toggle** over Activity rows titled `Break Mode Started/Ended [by Admin]`.

Three structural facts define the feature:

1. **There is no dedicated Break model.** Breaks are `Activity` rows (`type='idle'`, `duration=0`, title `Break Mode …`). Break duration is **derived** by pairing Started/Ended timestamps at read time. The canonical source of truth is the Activity table.
2. **The desktop agent has zero break integration.** `POST /api/agent/break` exists but `BreakApi` is never instantiated in the agent; `features.breakModeEnabled` is hardcoded `false` by the server config route; the agent's own idle detection **never emits idle/break rows** (it merely closes the current activity slice). Every break row in the database today comes from the **admin force-toggle**.
3. **"Privacy break mode" does not pause tracking.** The admin Force Start button's dialog promises *"This will pause monitoring for this employee"*, but nothing pauses — the agent never learns of the break. Break Monitor is a status/label surface, not a control.

Additional headline findings:

- **Employee self-service break toggle is documented as implemented but does not exist.** `docs/company-guide/06-activity-monitoring.md`, `17-company-operational-workflow.md`, `20-feature-matrix.md` and `FEATURE-INVENTORY.md` all claim `POST /api/self/break-status` (transactional); the route is absent and the Self Portal has no break UI.
- **`POST /api/agent/break` cannot end a break.** The handler only creates a row when `breakMode === true`; the `false` branch writes nothing, so an agent-side "end break" would leave the employee permanently "on break".
- **Tenant isolation and RBAC are strong.** Every break route derives `organizationId` from the verified session; cross-org employee ids are concealed with 404; the toggle is admin-only; covered by tests (MO-18, MO-22–27, PH-10).
- **Statistics have multiple correctness defects**: a `take: employees × 3` "latest activity" heuristic that can mislabel active employees as offline, a hardcoded 5-minute active window unrelated to the configured `idle_timeout`, server-local-midnight "today" boundaries that ignore `Organization.timezone`, and an `avgBreakTimeToday` that averages per-employee rather than per-session.
- **Break history is destroyed by Activity retention.** Break rows are Activity rows; `activity_retention_days` (default 90) `deleteMany` purges them with no separate break retention.

**Production Readiness Score: 52 / 100** (see §22).

---

## 2. Current Architecture

```
Admin Break Monitor page (src/components/break-status/break-status-page.tsx)
  ├─ GET  /api/break-status            (employee table + status + breakTimeToday)
  ├─ GET  /api/break-status/summary    (stat cards + department bars)
  ├─ POST /api/break-status/[id]/toggle (admin force start/end → Activity + AuditLog)
  └─ GET  /api/audit-logs (pageSize=50) → client-side filter → "Break History (Today)"

Agent (desktop-agent/) — NOT WIRED
  └─ BreakApi (src/api/heartbeat.ts) — never instantiated
       └─ POST /api/agent/break → creates "Break Mode Started" (never "Ended")

Realtime (mini-services/live-updates/index.ts)
  └─ polls Activity rows titled "Break Mode …" (take:5, 5s poll)
       └─ WS 'break-status' → org room → invalidates ['break-status'], ['break-summary'], ['event-stats']

Consumers of break semantics:
  ├─ /api/reports/daily           (breakCount = # of "Started" events; breakActivities list)
  ├─ /api/live-monitor/event-stats (break = count of "Break Mode …" rows in window)
  └─ docs (self/break-status — ROUTE DOES NOT EXIST)
```

**Source-of-truth chain:** Admin clicks Force Break → `POST /api/break-status/[id]/toggle` → `db.$transaction` creates one `Activity` row (title `Break Mode Started/Ended by Admin`) + one `AuditLog` row → UI invalidates React Query keys → live-updates polls the new Activity row → broadcasts `break-status` → clients invalidate. Duration is never stored; it is recomputed by pairing Started/Ended timestamps in `break-status/route.ts`, `break-status/summary/route.ts`.

---

## 3. UI Inventory

| Item | Location | Status |
|---|---|---|
| Break Monitor page | `src/components/break-status/break-status-page.tsx` | Exists |
| HomeBreak Monitor | — | **Does not exist** (0 matches) |
| Nav entry | `app-sidebar.tsx`, `mobile-sidebar.tsx`, `app-header.tsx`, `command-palette.tsx` (`page: 'break-status'`) | Exists |
| Page route | `src/app/page.tsx` → `pageComponents['break-status']` (dynamic, `ssr:false`) | Exists |
| RBAC (nav) | `src/lib/navigation.ts` — `'break-status': 'viewer'` | Viewer can open page |
| RBAC (mutation) | route-level `requireAdminOrg` | Admin-only toggle |
| Loading state | `TableSkeleton` + `StatCard isLoading` | Present |
| Empty state | `EmptyState` ("No employees found" / "No break status data available") | Present |
| Error state | **None** — fetch failure falls through to the empty-state row (§16) | **Missing** |
| Retry | React Query retry (default) + manual Refresh button | Present |
| Statistics | 4 stat cards (On Break, Active Now, Avg Break Today, Offline Today) + Department bars | Real server data, no `Math.random()`/fake data found |
| Employee list | Table: employee, department, device, status badge, last activity, break time today | Real |
| Filters | Status select (all/breaking/active/offline) + debounced search (name/ID) | Present |
| Department filter | **Not supported** | — |
| Pagination UI | **None** — UI hardcodes `pageSize=50`, sends no `page`; >50 employees unreachable | **Missing** |
| Actions | Force Break / End Break buttons + confirm dialog | Present (viewer sees them, gets 403 on click) |
| Break History | Collapsible panel labeled "Today", sourced from `/api/audit-logs` filtered client-side | Misleading (see F-07) |
| Auto-refresh | Toggle; 30s `refetchInterval` on all three queries | Present |

**Button/toggle trace (admin Force Break):** dialog confirm → `fetch POST /api/break-status/{id}/toggle` → `requireAdminOrg` (403 viewer/manager, 401 anonymous) → employee `findFirst` org-scoped (404 cross-org) → `$transaction` Activity + AuditLog → invalidates `['break-status']`, `['break-summary']`, `['break-history']` → realtime broadcast via live-updates poll. Every stage exists; **no rate limit** (F-16) and **no double-click guard on the dialog action** (F-04).

---

## 4. API Inventory

| Method & Route | File | Auth | RBAC | Org scope | Notes |
|---|---|---|---|---|---|
| `GET /api/break-status` | `src/app/api/break-status/route.ts` | session/bearer | any authenticated | session org (`requireSessionOrg`, `allowGlobal`) | employees + status + `breakTimeToday`; **client-side pagination** (F-11); **unvalidated page/pageSize** (F-11); **`take: N×3` latest-activity heuristic** (F-05) |
| `GET /api/break-status/summary` | `src/app/api/break-status/summary/route.ts` | session/bearer | any authenticated | session org | stat cards; same `N×3` heuristic; `offlineToday` semantics (F-12); avg per-employee (F-17) |
| `POST /api/break-status/[id]/toggle` | `src/app/api/break-status/[id]/toggle/route.ts` | session/bearer | **admin+** (`requireAdminOrg`) | session org; employee `findFirst { id, organizationId }` → 404 concealment | creates Activity + AuditLog in `$transaction`; **double-toggle race** (F-04); **audit actor missing** (F-09); **no consent check** (F-10); no rate limit (F-16) |
| `POST /api/agent/break` | `src/app/api/agent/break/route.ts` | agent token | agent | from token | **`breakMode:false` writes nothing** (F-01); no audit log; no dedupe; never called by agent (F-18) |

**Security posture (verified by code + tests):**
- `organizationId` is derived exclusively from the verified JWT (`requireSessionOrg`/`requireAdminOrg`). No break route accepts a client-supplied `organizationId`/`employeeId`/`deviceId` for scoping. ✔
- Cross-org employee in toggle → 404, no rows written (tested MO-26). ✔
- Unauthenticated toggle → 401 (MO-22); viewer → 403 (MO-23); manager → 403 (MO-24); admin → 200 (MO-25); nonexistent id → 404 (MO-27). ✔
- Proxy (`src/proxy.ts`) requires a valid token for all `/api/*` and adds CSRF origin checks for state-changing methods; break routes are not in the proxy RBAC list (route-level RBAC covers them). ✔
- **Gap:** toggle is not rate-limited (no entry in `RATE_RULES`). (F-16)

---

## 5. Database Inventory

**No dedicated Break model.** Breaks are `Activity` rows — classification **B/D combination**: derived from Activity events (titles `Break Mode Started`, `Break Mode Started by Admin`, `Break Mode Ended`, `Break Mode Ended by Admin`), initiated only by admin/agent API (never by the agent in practice).

`Activity` (relevant fields): `type` (`'idle'`), `title`, `duration Int` (**always 0 for break rows**), `employeeId` (required, FK cascade), `deviceId` (nullable, FK cascade), `timestamp`, `createdAt`. Indexes: `[employeeId]`, `[deviceId]`, `[timestamp]`, `[employeeId, timestamp]`, `[employeeId, category]`, `[category, timestamp]`, `[createdAt]`. **No index on `title`** — all four break-title queries (`title in […]` / `contains 'Break Mode'`) scan.

`AuditLog` (toggle audit): `action`, `resource`, `resourceId`, `description`, `userId?`, `ipAddress?`, `metadata?`, `organizationId?`. The toggle route writes **no `userId`/`ipAddress`/`metadata`** (F-09).

Integrity observations:
- **End-before-start:** a lone `Ended` row is silently ignored by the pairing loop (no negative duration), but **no invariant prevents it**; there is no DB-level pairing, so an Ended row can be orphaned by retention deleting its Started row (F-08).
- **Duplicate starts:** possible via concurrent toggles (F-04) or a direct `breakMode:true` replay — nothing enforces at-most-one-open break per employee.
- **Stale open breaks:** a Started row with no matching Ended persists forever; the status logic treats the *latest activity title* as authoritative, so any newer activity (e.g. an application row uploaded while "on break") silently flips `isOnBreak` to false (see F-05 note).
- **Unbounded queries:** `employees` `findMany` has no `take`; `breakActivities` fetches the full day with no `take` (F-11).

---

## 6. Break Semantics

Actual (traced) semantics — **no invention**:

1. **What starts a break?** Only an admin clicking "Force Break" (creates `Break Mode Started by Admin`). The agent endpoint exists but is never called.
2. **What ends a break?** Only an admin clicking "End Break" (creates `Break Mode Ended by Admin`). The agent's `breakMode:false` path writes nothing (F-01).
3. **Can an employee manually start a break?** **No** — the documented `POST /api/self/break-status` does not exist (F-03).
4. **Can an admin start/end a break?** Yes — the only working path.
5. **Is break automatic?** **No.**
6. **Is break based on idle time?** **No.** Agent idle detection (`idleDetectionEnabled`/`idleTimeoutMinutes`) only closes the current activity slice; it never creates break rows and never affects break status. The Break Monitor "active" window is a hardcoded 5 minutes unrelated to the org's `idle_timeout` (F-12).
7. **What idle threshold is used?** For break purposes: none. `idle_timeout` (default 5 min, 1–120) exists only for the agent's internal idle classification, which produces no break data.
8–12. **Does keyboard/mouse/window/screen activity or heartbeat end a break?** **No.** Break state is pure admin-event state; a new application activity while "on break" does not end it — but it *does* become the employee's "latest activity", which flips the *displayed* `isOnBreak` to false in the status route (title-of-latest check), so the displayed state and the stored events can diverge (F-05).
13–14. **Agent disconnect / device offline?** No effect on break state. The device attribution only hides the device (fresh-heartbeat filter); the employee stays "On Break" per the latest title.
15–18. **Agent restart / network outage / machine sleep / wake?** No effect — no resume/end logic exists. A break left active before a shutdown stays active on the server indefinitely. This is consistent with an admin-controlled model, but is **undocumented** and unhandled for stale sessions (F-19).
19. **Across midnight?** Break *duration* for "today" only pairs events whose `timestamp >= server-local todayStart`; a break started yesterday is excluded from today's minutes while still shown as "On Break" (status reads the unbounded latest activity) → **breakTimeToday = 0 for an employee on break since yesterday** (F-06/F-12).
20. **Timezone change?** Day boundaries use `new Date().setHours(0,0,0,0)` (server-local). `Organization.timezone` (default `Asia/Dhaka`) is ignored by break-status/summary (F-06). The daily report labels the org-local day but queries server-local midnight — the two can disagree.

**Undefined semantics (reported as findings, not guesses):** what a "break" means for retention, what happens to an active break on consent revocation (F-10), and whether sleep/lock/offline should auto-end a break (F-19).

---

## 7. Idle vs Break Analysis

| State | How it is represented | Distinguishable? |
|---|---|---|
| ACTIVE | latest activity < 5 min old (`fiveMinAgo`) | Yes (badge) |
| IDLE | **Not represented at all.** Agent idle classification emits nothing; no idle rows are produced | **No** |
| BREAK | latest activity title is a "Started" event | Yes (badge) — but title-of-latest check is fragile (F-05) |
| OFFLINE | no row in the `take: N×3` recent window / no activity ever | Partial — heuristic-based (F-05) |
| SLEEP / LOCKED | collapsed into OFFLINE or stale BREAK | **No** |
| OFFLINE vs telemetry gap | A telemetry gap (agent stopped, network down, consent revoked) is indistinguishable from "never active" | **No** |

**False-break risk:** a *telemetry gap does not become a break* — this is correct by design (break requires an admin event). The inverse falsehood exists: **a break does not stop telemetry**, so an employee "on break" can still generate application activities that become their latest activity and flip their displayed status to Active (F-05). Idle ≠ break is correctly maintained in the agent (F-03 idle classification is separate), but the *server* conflates "has any activity" with "active" (`isActive || latest`), so a week-old last activity still renders the Active badge (F-05).

---

## 8. Desktop Agent Trace

Trace: Windows input → native addon (`GetLastInputInfo`, `idleSeconds()`) → `ActivityCollector.sample()` → idle check → **no row emitted** (slice closed) → heartbeat → `/api/agent/heartbeat`.

- `desktop-agent/src/collectors/activity-collector.ts`: `isIdle = m.idleDetectionEnabled && idle >= m.idleTimeoutMinutes * 60` → on idle it calls `flushCurrent()` and emits **nothing**. Monotonic behavior is fine; no fake timers; no break rows.
- `desktop-agent/src/api/heartbeat.ts`: `BreakApi.set(breakMode)` exists; **zero instantiation sites** (verified `new BreakApi` → 0 matches). Config `features.breakModeEnabled` is hardcoded `false` in `src/app/api/agent/config/route.ts` and `desktop-agent/src/services/config-service.ts` DEFAULTS.
- **Conclusion: Break Monitor is server/admin-driven, not agent-driven.** No fake timer pretends to represent real employee breaks — the honesty is in the *absence* of wiring: the agent simply never participates.
- No idle-duration upload, no break collector, no local break state, no sleep/wake break handling. CPU impact of the idle path is negligible (10s poll, single `GetLastInputInfo` call).

---

## 9. Consent / Privacy

- **No dedicated break consent type exists** (`Consent.consentType` enum: `monitoring, screenshot, activity_tracking, keystroke, usb_monitoring, webcam_access, location, email_monitoring`).
- Agent-side: activity collection is gated on `activity_tracking` consent (`decideConsentGate`); server-side uploads re-check `hasActiveConsent(employeeId, 'activity_tracking')` → 403 on revoked/expired/missing (fail-closed). ✔
- **Break telemetry is not consent-gated.** The admin toggle route never checks consent before creating a `Break Mode …` Activity row for the employee (F-10). Server remains authoritative, but break rows are a separate path that bypasses the consent gate. Consent revocation does nothing to an active break (undefined behavior, F-10).
- Granted → accepted: ✔ (agent path). Revoked/expired/pending → rejected for agent *activity* uploads: ✔ (fail-closed). Break toggle under revoked consent: ✘ not enforced.

---

## 10. Break Toggle / "Home Break" Analysis

The only toggle is the **admin force-toggle** (no employee toggle — F-03).

Click "Force Break" → confirm dialog → `POST /api/break-status/{id}/toggle` → `requireAdminOrg` → org-scoped employee lookup (404 conceal) → read latest activity → `$transaction`(Activity + AuditLog) → invalidate 3 keys → realtime broadcast.

Click "End Break" → same path, `isOnBreak` derived from latest title.

Checked behaviors:
- **Start twice (sequential):** second POST sees latest = "Started" → creates "Ended by Admin" (acts as toggle). No duplicate *open* break from sequential clicks.
- **Start twice (concurrent / double-click):** both reads see "no break" → **two "Started" rows** (F-04, P2). The dialog action button has no in-flight disable (`togglingId` guards only the table row button).
- **End twice:** second POST sees latest = "Ended" → creates "Started by Admin" (re-opens). No 409, no idempotency.
- **End without start:** creates a lone "Ended by Admin" row → ignored by the pairing loop (no negative duration), but pollutes history and inflates the daily report's `breakActivities` list.
- **Start while another break is active:** only possible via the race above.
- **Start after stale break:** breaks never auto-expire (F-19).

**No duplicate-active-break invariant exists at the DB level** (no schema constraint, no server-side guard).

---

## 11. Statistics / Formulas

| Metric | Source | Formula | Assessment |
|---|---|---|---|
| On Break (count) | `break-status` | `status==='breaking'` employees | OK |
| Active Now | `summary` | latest activity < 5 min AND not on break | Hardcoded window ≠ org `idle_timeout` (F-12) |
| Offline Today | `summary` | **no row in `take:N×3` window** | Mislabeled — employees active earlier today are counted neither active nor offline (F-12) |
| Avg Break Today | `summary` | `totalBreakTimeToday / employees-with-breaks` | Per-employee average, not per-session (F-17) |
| Total Break Today | `summary`/`break-status` | sum of paired Started→Ended deltas (open break → now) | Cross-midnight + heuristic defects (F-05/F-06) |
| Break Time (per employee) | `break-status` | paired deltas, minutes, rounded | Open-break from yesterday = 0 (F-06) |
| Department bars | `summary` | onBreak / total per dept | OK |

Formula defects: overlapping intervals impossible (single open-break pairing, but see F-04 duplicates); multiple devices merge into one timeline (device attribution only affects which device shows); no future-timestamp guard needed (rows created server-side `new Date()`); stale open breaks counted as "break until now" indefinitely (F-19); duplicate Started rows lose the first interval (F-04). Retention can delete one side of a pair (F-08).

---

## 12. Reports / Analytics Integration

| Consumer | Break usage | Semantics | Agreement with Break Monitor |
|---|---|---|---|
| Daily Report (`/api/reports/daily`) | `breakCount` = # of "Started" events; `breakActivities` list; break rows (type idle, dur 0) also land in the main activity list | Event count | **Disagrees** — Monitor shows *minutes*, report shows *count*; no break minutes in report (F-15) |
| Live Monitor Event Stats | `break` = count of "Break Mode …" rows in window | Event count | Consistent with report count; unrelated to Monitor minutes |
| Dashboard | none | — | Break absent from dashboard |
| Analytics / AI Insights / Employee Details / Department performance | none (analytics `10-analytics.md` suggests correlating with break status; not implemented) | — | — |
| Self Portal | **none** (docs claim break status visible + toggle; no UI, no route) | — | Docs-vs-reality (F-03) |

Break start/end events also inflate `totalActivities` and per-employee `activities` counts in the daily report (duration 0 ⇒ no time inflation) (F-15).

---

## 13. Realtime

Chain: Activity row created → `mini-services/live-updates` poll (5s) → `db.activity.findMany({ title: { contains: 'Break Mode' }, createdAt > cursor, take: 5 })` → emit `break-status` to `org:{organizationId}` room → `websocket-provider.tsx` handler → `addEventLog` + invalidate `['break-status']`, `['break-summary']`, `['event-stats']`.

Verified:
- **Real producer** exists (DB-polled, no simulated events). ✔
- **Org-room isolation** from verified JWT (`org:${organizationId}`), payload is employee-name + action + timestamp. ✔
- Reconnect handled by socket.io defaults; provider re-subscribes. ✔
- `['break-history']` is **not** invalidated by the WS event (30s poll only). (P3)

Defects:
- **`take: 5` truncation (F-14, P3):** >5 break rows created within one 5s poll window → oldest rows are never broadcast (cursor advances past them).
- Poll cursor uses `nextPollCursor` over processed rows — correct hygiene otherwise.

---

## 14. Audit Logging

| Event | Audited? | Actor recorded? | Notes |
|---|---|---|---|
| Admin force start/end | ✔ (`AuditLog`, action `update`, resource `employee`, description contains "break mode") | **No userId, no ipAddress, no metadata** (F-09, P2) — `admin.userId`/`email` are available in `requireAdminOrg` result but unused | "Who did it" unanswerable |
| Agent break (if ever wired) | ✘ none | — | F-01 |
| Threshold/setting changes | N/A — no break settings exist | — | — |
| Consent-related break state | ✘ none | — | F-10 |

The actor is never client-supplied (good — the *identity* side is safe), but it is simply **missing** (bad — the *completeness* side fails the audit requirement).

---

## 15. Security / RBAC / IDOR

| Threat | Status |
|---|---|
| Cross-org `employeeId` in toggle | 404 + no rows (tested MO-26) ✔ |
| Cross-org read (status/summary) | Session-org scoped via employee relation (tested MO-18) ✔ |
| Forged `organizationId` | Not accepted anywhere in the break routes (session-derived only) ✔ |
| Forged `deviceId` | Device resolved server-side from employee+org; break rows get `device?.id ?? null` ✔ |
| Viewer/manager mutation | 403 (MO-23/MO-24) ✔ |
| Agent token scope | `validateAgentToken` binds employee/device from token ✔ |
| CSRF | Proxy origin check on non-GET ✔ |
| Rate limiting | **Missing for `/api/break-status`** (F-16, P3) |
| Consent bypass | Toggle ignores consent (F-10, P2) |
| Audit completeness | Actor missing (F-09, P2) |

No IDOR path found. The isolation architecture is the strongest part of this feature.

---

## 16. Performance

- `GET /api/break-status`: `db.employee.findMany` with **no `take`** (all active employees), then **in-memory pagination** (`slice`) after a full fetch (F-11).
- `recentActivities`: `take: empIds.length × 3` — O(N) rows fetched per request; the heuristic breaks under skewed activity (F-05).
- `breakActivities`: full-day fetch, no `take`.
- `summary`: two full org-wide queries (all employees + latest-N activities + full-day breaks) on a 30s poll cadence — repeated aggregate work.
- Queries are index-assisted where possible (`employeeId, timestamp`), but title-filtered break queries (`title in […]`, `contains 'Break Mode'`) have **no title index**.
- Malformed inputs: `page=abc` → `NaN` → `slice(NaN,…)` → empty page (no 500, but no 4xx either — silent wrong response); `pageSize=0` → `totalPages = Infinity`; `page=-1` → nonsensical slice. The project has `validatePagination` (`src/lib/api.ts`) — **not used by break-status** (F-11).

---

## 17. Retention

- Break data is **not persisted separately** — it is Activity data, and `runRetentionForOrg` deletes Activity rows past `activity_retention_days` (default 90, configurable 0=keep) via `deleteMany({ timestamp < cutoff, employee.org })`.
- **Consequence (F-08, P2):** Activity retention silently destroys historical break reporting. There is no separate break retention, so a short `activity_retention_days` erases break history with no way to preserve it.
- **Partial deletion:** an open break whose Started row ages past the cutoff is deleted while the (never-written) End never comes — the employee then shows not-on-break even though the server "ended" nothing; and an Ended row whose Started was purged becomes an orphan event counted in daily report history.
- Audit logs (which power the Break History panel) are **anonymized, never deleted** — but the panel's own date semantics are wrong (F-07).

---

## 18. Error Handling

Distinctions the UI must make vs. what it does:

| Situation | Ideal | Actual |
|---|---|---|
| No break data | Empty state | Empty state ✔ |
| API 500 / network failure | Error state + retry | **Silently renders "No break status data available"** (fetch throws → `statusData` undefined → empty-state row) (F-13, P2) |
| Unauthorized (expired session) | Redirect/401 handling | Falls into the same empty state |
| Agent offline | Distinct indicator | Collapsed into "Offline" badge (no agent vs. never-active indistinguishable, F-12) |
| Consent revoked | Distinct signal | Not surfaced anywhere (F-10) |

`'—'` vs `0` is partially handled in stat cards (`value={summary?.currentlyOnBreak ?? '—'}`), but a failed summary fetch and a zero-org render identically. The "0 minutes vs failed" requirement (Phase 16) is **not met**.

---

## 19. Test Coverage

Existing (all pass in-repo, read-only review):
- `tests/multi-org-isolation.test.ts` MO-18 (summary org-scoped), MO-22–27 (toggle 401/403/403/200/404-cross-org/404-nonexistent, no rows on failure).
- `tests/presence-hardening.test.ts` PH-10 (break-status attributes only live devices).
- `tests/live-monitor-event-stats.test.ts` (break counting in event-stats).
- `tests/ws-invalidation.test.ts` (break-status invalidation keys).
- `tests/admin-prod-monitoring.test.ts` (config `breakModeEnabled` shape).

Gaps (Phase 17 checklist):
- Duplicate start / double-click race (F-04) — **untested**
- End-without-start, start-twice-sequential — untested
- Midnight / timezone (F-06) — untested
- Sleep/wake/offline semantics (F-19) — untested
- Malformed `page`/`pageSize` on break-status (F-11) — untested
- Stats formulas (avg, offlineToday, open-break-from-yesterday) — untested
- Retention interaction (F-08) — untested
- Consent interplay (F-10) — untested
- `POST /api/agent/break` end-path (F-01) — untested

No tests were run in this audit (read-only code review; DB tests would require a live dev DB).

---

## 20. Browser Verification

**NOT VERIFIED.** No dev server was running (`curl http://localhost:3000` → connection refused), and per the audit rules I did not start one or touch the database. All UI/UX claims above are static-code evidence only. No temporary test rows were created; nothing to clean up.

---

## 21. Findings Matrix

| ID | Severity | Title | Section |
|---|---|---|---|
| F-01 | **P1** | Agent break "end" writes nothing — employee stuck on break | §4, §6 |
| F-02 | **P1** | "Privacy break mode" does not pause tracking; Break Monitor is status-only | §1, §6, §8 |
| F-03 | **P1** | Employee self-service break toggle documented but route `POST /api/self/break-status` does not exist | §3, §6, §12 |
| F-04 | P2 | Double-toggle race → duplicate Started rows, interval loss | §10, §5 |
| F-05 | P2 | `take: N×3` latest-activity heuristic + `isActive || latest` mislabel status; break/activity state divergence | §4, §7 |
| F-06 | P2 | Server-local midnight "today"; org timezone ignored; daily-report label/window mismatch | §6, §11 |
| F-07 | P2 | "Break History (Today)" is latest-50 audit logs, no date filter; agent breaks never audited | §3, §14 |
| F-08 | P2 | Activity retention silently deletes break history; can orphan Started/Ended pairs | §17 |
| F-09 | P2 | Toggle audit log has no actor (userId/ipAddress/metadata) | §14 |
| F-10 | P2 | Break toggle bypasses consent gate; revocation has no effect on active breaks | §9 |
| F-11 | P2 | Unvalidated page/pageSize; in-memory pagination over unbounded employee fetch; no pagination UI | §4, §16 |
| F-12 | P3 | "Active Now" hardcoded 5-min window ≠ configured `idle_timeout`; `offlineToday` mislabeled | §11 |
| F-13 | P3 | HTTP 500 → empty state; no error/retry UI; viewers see admin buttons they cannot use | §18, §3 |
| F-14 | P3 | Realtime `take: 5` truncation; `break-history` not invalidated by WS | §13 |
| F-15 | P3 | Daily report uses event-count semantics vs Monitor minutes; break events inflate activity counts | §12 |
| F-16 | P3 | No rate limit on break-status routes (toggle unthrottled) | §4, §15 |
| F-17 | P3 | `avgBreakTimeToday` is per-employee, not per-session; ambiguous labeling | §11 |
| F-18 | P3 | `POST /api/agent/break` dead-but-reachable (BreakApi never instantiated; config flag false) | §8 |
| F-19 | P3 | Sleep/lock/offline/disconnect have no defined effect on break state; stale breaks never expire | §6, §7 |

**Not findings (verified correct):** org derivation from session everywhere; 404 cross-org concealment; admin-only toggle; realtime has a real DB producer with org-room isolation; no fake/demo data anywhere in the break feature; idle ≠ break is correctly maintained (the two are simply disconnected).

---

## 22. Production Readiness Score

| Category | Max | Score | Rationale |
|---|---|---|---|
| Functional completeness | 20 | 10 | Page works; no self-service, no pagination, history mislabeled, error states missing |
| Break semantics correctness | 15 | 5 | Admin-event-only; "pause tracking" promise false; end-path broken; stale/open-break semantics undefined |
| Security & RBAC | 15 | 11 | Strong IDOR/RBAC; consent bypass + missing audit actor + no rate limit |
| Multi-tenant isolation | 10 | 9 | Session-derived org, 404 concealment, tested |
| Agent integration | 10 | 2 | Zero wiring; endpoint dead-but-reachable |
| Statistics correctness | 10 | 5 | Real data but heuristic/midnight/avg defects |
| Realtime | 5 | 3 | Real producer + invalidation; take:5 truncation, history not invalidated |
| Database | 5 | 2 | No dedicated model; retention destroys break history; no title index |
| Performance | 5 | 2 | Unbounded employee fetch, in-memory pagination, repeated aggregates |
| Testing | 5 | 3 | Good isolation/auth tests; many semantics gaps untested |
| **Total** | **100** | **52** | |

---

## 23. Recommended Fix Priority

**P1 (release blockers)**
1. F-01 — `POST /api/agent/break`: record `Break Mode Ended` on `breakMode:false` (or remove the endpoint).
2. F-02 — Decide the product contract: either wire the agent to receive break state (config flag / command channel) and actually pause collectors, or relabel the feature as admin-driven status display and remove the "pauses monitoring" language.
3. F-03 — Either implement `POST /api/self/break-status` (+ self-portal UI + consent gate) or correct the four docs that claim it exists.

**P2**
4. F-04 — Serialize the toggle (transactional read-latest + guard, or a `breakSession` open-state check).
5. F-05 — Replace the `N×3` heuristic with per-employee latest-activity queries or a `breakSession`-style state; fix `isActive || latest`.
6. F-06 — Use `Organization.timezone` day boundaries (the codebase already has `localDayKey`/`zonedDayStart` used by event-stats).
7. F-07 — Server-side break history query with a real date filter and an audit row for every break mutation.
8. F-08 — Separate break retention or exempt break rows from Activity deletion; document the interaction.
9. F-09 — Record `userId`/`ipAddress`/`metadata` on toggle audit rows.
10. F-10 — Gate toggle + break reporting on `activity_tracking` (or a new `break` consent type); define revocation behavior for active breaks.
11. F-11 — Use `validatePagination`, DB-level pagination, and add pagination controls; cap `pageSize`.
12. F-13 — Distinguish error/empty/unauthorized states in the UI.

**P3**
13. F-12, F-14, F-15, F-16, F-17, F-18, F-19 — as described in §21.

---

## 24. Final Verdict

**NOT PRODUCTION-READY for the feature as documented.** The Break Monitor page is a functioning admin-status surface with strong tenant isolation, but three P1 defects block it: (a) the documented employee self-service break toggle does not exist, (b) the agent "break" contract is broken (end writes nothing) and never wired, and (c) the feature's core promise — break mode pauses tracking — is not delivered by any component. Statistics are real but carry correctness defects; break history is destroyed by Activity retention; the audit trail is missing its actor. The security posture (isolation, RBAC, CSRF) is the feature's strongest area and needs no structural change.

---

## 25. Verification Status

| Item | Status |
|---|---|
| Code tracing (server, UI, agent, realtime, schema) | ✅ Static-code verified |
| Multi-org / RBAC behavior | ✅ Verified by existing tests (MO-18, MO-22–27, PH-10) — not re-run |
| Browser verification | ❌ **NOT VERIFIED** (no dev server running; none started per audit rules) |
| Live DB probes | ⛔ Not performed (audit-only; would require running server + writes) |
| Fake/demo data check | ✅ None found in the break feature |
| HomeBreak Monitor existence | ✅ Confirmed absent |

---

## 26. Change Safety

- **Zero source modifications** were made during this audit.
- **Zero schema / migration / DB / config / env changes.**
- **Zero dependencies installed; zero seeds or resets.**
- No test rows created; nothing to clean up.
- All working-tree changes present at audit start (the in-progress OmniSight rebrand) were left untouched.
- Read-only verification only: `code_search`/`glob`/`read_files`, one `curl` health probe against `localhost:3000` (connection refused, no side effects).
