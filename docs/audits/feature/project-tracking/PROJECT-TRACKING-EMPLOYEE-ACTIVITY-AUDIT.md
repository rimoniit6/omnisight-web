# PROJECT TRACKING — EMPLOYEE ACTIVITY INTEGRATION AUDIT

**Date:** 2026-08-15 · **Auditor:** automated audit (read-only) · **Environment:** live local stack (app :3000, live-updates :3010, PostgreSQL workai :5432)

**Scope note:** This audit made **zero changes to production code or data**. All queries were read-only; the only side effects were two normal admin logins (audit-logged) used to call the same APIs the UI calls.

---

## 1. Executive Summary

**Rimon is online, his agent is healthy, his activity is flowing into the database and over the WebSocket, and he IS an active member of project "ok" — but Project Tracking will never show his work as project hours, because Project Tracking is a TimeEntry-based module and **nothing in the system converts agent Activity into TimeEntry.**

The observed behavior is **the product's current design, not a bug**:

- Every project metric that would "update" when an employee works — `totalHours`, `billableHours`, `progress`, member `totalHours`/`thisWeekHours`, the Time Log, Analytics, and even project Sentiment — is computed **exclusively from `TimeEntry` rows**.
- `TimeEntry` rows are created **only manually by an admin** (Time Log tab form, or bulk import). There is no automatic activity→time pipeline anywhere: not in the desktop agent, not in `mini-services/live-updates`, not in any background job.
- `Activity` rows carry **no `projectId`** and no project relation, and no code path maps `Activity → Employee → ProjectMember → Project`.
- The live WebSocket delivers `activity-ping` events (with `employeeId`, no `projectId`) and there is **no project/time-entry event type** in the realtime protocol at all.

So: Rimon working ≠ project hours changing. Project hours change only when an admin logs time. If the intended product behavior is *automatic* project time tracking, that is a **MISSING FEATURE** — not a broken pipeline. Sections 14–17 detail exactly what a "minimum correct fix" would look like if that feature is wanted.

---

## 2. Rimon Verification (live DB, 2026-08-15 ~14:27 UTC)

| Item | Value | Verified |
|---|---|---|
| Employee id | `cmssi3spk000cfi5k8uzi0i0v` | ✔ |
| Employee # | `001` | ✔ |
| Name | Rimon Rana (`mdrimonrana@gmail.com`) | ✔ |
| Status | `active`, `agentApproved = true`, `leaveDate = null` | ✔ |
| Organization id | `cmssgkpig0004fi5kbdunw20o` ("Bangladesh computer Council", tz `Asia/Dhaka`) | ✔ |
| Device id | `cmssi4qrw000lfi5kllmey2u3` (name "Rimon") | ✔ |
| Device status / heartbeat | `online`, `lastHeartbeat 2026-08-15T14:27:16Z` (fresh) | ✔ |
| Agent token | valid — `expiresAt 2026-08-16T06:47:54Z`, `lastUsedAt 2026-08-15T14:28:00Z` | ✔ |
| Consent | `activity_tracking: granted` (all 8 consent types granted) | ✔ |
| Project | `cmsstikfp007kfim8cmq58dbh` — "ok", status `active`, `estimatedHours = 200` | ✔ |
| ProjectMember | `cmsstiyeu007nfim8muhmkej4` — role `member`, `hoursPerWeek = 40`, **`leftAt = null`**, joined 2026-08-14 | ✔ |
| Org consistency | employee.org **===** member.org **===** project.org `cmssgkpig0004fi5kbdunw20o` | ✔ |
| Activity | **1,133 rows** (grew to 1,137 during the live test), newest `createdAt 2026-08-15T14:29:23Z` — **streaming live** | ✔ |
| TimeEntry | **0 rows for Rimon · 0 rows org-wide · 0.0 total hours** | ✔ |

Rimon's assignment is also visible through the same API the UI uses: `GET /api/projects` returns project "ok" with `memberCount: 1` and Rimon in `members[]`.

---

## 3. UI Data Sources (what each surface reads)

Project Tracking UI = `src/components/projects/projects-page.tsx` (single page, card/table list + detail dialog with 5 tabs).

| Surface | Displayed data | Source | Real-time? |
|---|---|---|---|
| Project cards / list | name, status, priority, deadline, `totalHours`, progress bar, member avatars | `GET /api/projects` → `timeEntry` aggregate (`hoursMap`) + `ProjectMember` | No (refetch only on mutation/focus) |
| Stats bar | totalHours, dailyAverageHours, uniqueMembers, overdue | `GET /api/projects` `stats` → `timeEntry`/`projectMember`/`project` aggregates | No |
| Detail — Overview | totalHours, billableHours, progress, deadline | `GET /api/projects/[id]` → `timeEntry` aggregates | No |
| Detail — Team | member avatars, **live presence dot (`<PresenceDot/>`)**, role, `totalHours`, `hoursPerWeek` target | presence dot → WebSocket presence store (LIVE); hours → `timeEntry` groupBy | **Presence: YES** · hours: No |
| Detail — Time Log | paginated entries + aggregates | `GET /api/projects/[id]/time-entries` → `timeEntry` | No |
| Detail — Analytics | category/member/daily breakdown, billable | client-side `useMemo` over the **time-entries list** | No |
| Detail — Sentiment | per-employee scores from "time entries logged to this project" (explicit UI copy) | `GET /api/projects/[id]/sentiment` → `SentimentRecord` derived from `timeEntry` | No |

**Answers to the Phase 1 questions:**
1. **What changes when an assigned employee works?** Nothing on its own. Only the Team-tab presence dot reflects "working right now" (device heartbeat), and it does so live.
2. **Does the UI show online status?** Yes — only via `PresenceDot` in the Team tab. Live activity / current working time / last activity: **no**. Accumulated hours / time entries / progress: yes, but sourced from `TimeEntry` only.
3. **Values expected to update automatically:** presence (live), everything else only after a mutation (add/edit/delete time entry, member, project).
4. **Values requiring an explicit TimeEntry:** total hours, billable hours, progress, member hours, this-week hours, time log, analytics, sentiment. **All of them.**

There is no `actualCost` surface: `formatCurrency` exists in helpers but no cost is computed anywhere (only `budgetType` badges and `hourlyRate` fields exist).

---

## 4. Activity Pipeline (verified live)

```
Desktop agent (Rimon, device cmssi4qrw000lfi5kllmey2u3)
  → POST /api/agent/activity            (src/app/api/agent/activity/route.ts)
      · validateAgentToken → AgentToken cmssu0kvkf0001fiz8lvsa92ho (valid)
      · consent check (activity_tracking granted)
      · type/category allowlist + domain-only normalization
  → db.activity.createMany (Activity rows, employeeId=cmssi3…, deviceId=cmssi4…)
  → mini-services/live-updates polls every 5s  (mini-services/live-updates/index.ts)
  → Socket.IO 'activity-ping'  (org room org:cmssgkpig0004fi5kbdunw20o)
  → websocket-provider (src/components/providers/websocket-provider.tsx)
  → invalidates ['dashboard','activities','activities-daily','event-stats',
                 'employee-details',empId,'employee-activities',empId]
```

**Live evidence:** during a 45-second observation, Rimon produced **2 new Activity rows (1,135 → 1,137)** and the WebSocket delivered **2 real `activity-ping` events** to an authenticated client in his org's room. The pipeline is healthy end-to-end.

---

## 5. Project Tracking Pipeline (source of truth)

Project hours are aggregated **entirely from `TimeEntry`** in every consumer:

- `GET /api/projects` — `timeEntry.groupBy({ by:['projectId'] })` → `totalHours`; `stats.totalHours`/`dailyAverageHours` = org-wide `timeEntry` sums; sort by hours uses the same map. (list route, ~line 160)
- `GET /api/projects/[id]` — `timeEntry.aggregate(_sum.hours)` → `totalHours`; `billable` filter → `billableHours`; `progress = totalHours / estimatedHours`; `timeEntry.groupBy(employeeId)` → per-member `totalHours`. (detail route)
- `GET /api/projects/[id]/members` — `timeEntry.groupBy(employeeId)` → `totalHours`, and week-window groupBy → `thisWeekHours`.
- `GET /api/projects/[id]/time-entries` — direct `timeEntry` reads + aggregates.
- Sentiment (`/api/projects/[id]/sentiment`, `/analyze`) — project-scoped records derived from that project's `timeEntry` data (schema comment + UI copy confirm).
- `Project` itself stores `estimatedHours` only — **no stored `actualHours`/`progress`/`actualCost` columns**; all are computed on read from TimeEntry.

**Phase 4 answer — what does Project Tracking read?** `E. TimeEntry records` for every hours/progress/cost-family metric, plus `F. ProjectMember` for membership lists and role/hoursPerWeek, plus `A. Activity` nowhere at all. Not B, C, D (except the presence dot, which is `Device.lastHeartbeat` freshness — not "project time"), not G, not H.

---

## 6. Activity → Project Mapping

**`Activity` has NO `projectId` column and no project relation** (schema: only `employeeId`, `deviceId`). The only conceptual chain is:

```
Activity.employeeId → Employee.id → ProjectMember.employeeId → ProjectMember.projectId → Project
```

This chain exists structurally but **no code anywhere traverses it** — no query, no job, no service joins Activity to projects. Verdict: **"Employee activity is not currently project-scoped."** Nothing needs to be "broken" for this to be true; it is simply not implemented.

---

## 7. Activity → TimeEntry Mapping

**There is no Activity→TimeEntry conversion anywhere in the repository.**

Every `db.timeEntry.create*` call site in the whole repo:

| Location | How created |
|---|---|
| `src/app/api/projects/[id]/time-entries/route.ts` (POST) | **Manual** — admin-only (`requireAdminOrg`), validates employee is an **active** member (`leftAt: null`, same org), writes one entry from form input |
| `src/app/api/import/[type]/route.ts` | **Manual bulk import** (admin CSV/JSON import) |
| `tests/*.test.ts` (projects, projects-tracking, project-sentiment, hardening) | Test fixtures only |

Nothing in `desktop-agent/` and nothing in `mini-services/` touches `timeEntry`. There is **no work-session engine, no background job, no scheduler** converting activity into project time. (`work_session` is merely an `Activity.type` label for agent telemetry — it has no project awareness.)

---

## 8. Real Runtime Test (live, 2026-08-15 14:29 UTC)

Observed over one complete poll cycle (45 s, 5 s poll interval), while Rimon was actively working:

| Metric | Before (T0) | After (T1, +45 s) | Changed? |
|---|---|---|---|
| Rimon Activity rows | 1,135 | **1,137 (+2)** | ✔ grew |
| Newest activity | 14:29:03Z | 14:29:23Z | ✔ advanced |
| TimeEntry rows (project "ok") | 0 | **0** | ✘ unchanged |
| Project total hours | 0.0 | 0.0 | ✘ unchanged |
| Project progress | 0% | 0% | ✘ unchanged |
| WebSocket events captured | — | `activity-ping` × 2, `connected` × 1; **project events × 0** | — |

This is **Case B** from the audit's outcome matrix: *Activity increases + TimeEntry unchanged → Project Tracking is manual-only and no automatic time-tracking pipeline exists.*

---

## 9. API Verification (live, authenticated as super admin — same calls the UI makes)

| Endpoint | Observed response (excerpt) |
|---|---|
| `GET /api/projects` | `data[0].{id:cmsstikfp…, totalHours:0, memberCount:1, members:[Rimon]}` · `stats.{totalHours:0, dailyAverageHours:0, uniqueMembers:1}` |
| `GET /api/projects/cmsstikfp007kfim8cmq58dbh` | `totalHours:0, billableHours:0, progress:0, estimatedHours:200, timeEntries:[]` · member Rimon `totalHours:0, leftAt:null` |
| `GET /api/projects/…/members` | 1 member (Rimon), `totalHours:0, thisWeekHours:0` |
| `GET /api/projects/…/time-entries` | `data:[], total:0, aggregates.totalHours:0` |

API responses are **correct and consistent** with the database: there are simply no TimeEntry rows to aggregate. Not stale, not wrong-scoped, not mis-aggregated — empty.

---

## 10. Database Verification (live PostgreSQL)

- `Activity` for Rimon: 1,133+ rows, streaming — **agent ingestion works**.
- `TimeEntry`: **0 rows org-wide** (not just for Rimon). The project literally has zero logged hours in the source of truth.
- `ProjectMember`: exactly one, Rimon, `leftAt = null`, org matches.
- No `Activity.projectId` exists (schema), no join table, no derived column.

---

## 11. React Query / Cache Verification

Query keys in `projects-page.tsx`: `['projects', filters…]`, `['project-detail', id]`, `['project-members', id]`, `['project-time-entries', id, filters…]`, `['project-sentiment', id]`, `['employee-projects']`.

- **No `refetchInterval` / `staleTime`** on any project query — not designed to poll.
- Invalidations are **mutation-only** (create/edit/delete time entry, member, project CRUD all call `invalidateQueries`). 
- WebSocket-driven invalidation (`src/lib/ws-invalidation.ts`, `activityPingInvalidation`) touches **only** `['dashboard']`, `['activities']`, `['activities-daily']`, `['event-stats']`, `['employee-details', empId]`, `['employee-activities', empId]` — **never** `['projects']`, `['project-detail']`, `['project-time-entries']`, `['project-members']`, `['employee-projects']`.
- Even a perfect cache (window-focus refetch is on by default) cannot help: **the underlying data never changes**, because no TimeEntry is ever created.

Conclusion: Project Tracking is **not designed to be real-time**. Cache is not the problem.

---

## 12. WebSocket Verification

- The live-updates protocol emits 8 event types: `employee-presence`, `device-status`, `activity-ping`, `notification`, `break-status`, `new-screenshot`, `agent-registration`, `usb-event` — **no `time-entry`, no `project`, no `project-member` events exist** in `mini-services/live-updates/index.ts`.
- The `activity-ping` payload (`mini-services/live-updates/activity-events.ts`) carries `id, employeeId, employeeName, department, activityType, activityTitle, activityUrl, category, duration, timestamp` — **no `projectId`**, and the frontend cannot resolve `activity.employeeId → ProjectMember → project` because nothing in the client is wired to do so.
- Live capture confirmed: only `activity-ping` + `connected` arrived; zero project-related frames.

---

## 13. Security / Organization Scope

- `Activity` is org-scoped only transitively (via `Employee.organizationId`); broadcasts are room-scoped per the employee's org. ✓
- Every TimeEntry write path validates: project belongs to the caller's org, employee is an active member (`leftAt: null`) **and** the same org (`POST /time-entries` returns 403 "Employee is not an active member of this project"). ✓
- Member queries (`/api/projects/[id]`, `/members`) filter `leftAt: null`; removed members get `0` hours. ✓
- Because **no automatic conversion exists**, there is currently zero risk of activity leaking cross-org or post-departure — but that also means there is nothing enforcing it, so any future auto-tracking feature must bake the org + `leftAt` checks in from day one (see §16).

---

## 14. Exact Root Cause

**Project Tracking is a TimeEntry-based module, and agent Activity is never converted into TimeEntry.**

Concretely:

1. All project time/progress/cost-family data is computed **only** from `TimeEntry` rows (list, detail, members, time log, analytics, sentiment).
2. `TimeEntry` is created **only manually** by admins (Time Log form / bulk import) — zero automatic creators exist in the agent, the live-updates service, or any background job.
3. `Activity` has **no projectId** and there is **no Activity→Project or Activity→TimeEntry mapping** anywhere in the codebase.
4. The realtime layer has **no project/time-entry events**, and WebSocket invalidation deliberately does not touch project queries.

Therefore being "online" or "actively working" can never move a project's hours — by construction, not by breakage. The pipeline that *does* exist (agent → Activity → live-updates → activity-ping → Dashboard/Live Monitor/Employee Detail) is fully healthy and verified live.

---

## 15. Is this a bug or expected product behavior?

**Classification: EXPECTED BEHAVIOR** (the code implements **MODEL 2** from the audit's Phase 12 taxonomy — *employee works → agent activity only → Project Tracking unchanged → admin manually creates TimeEntry → hours/progress update*).

The product's own UI documents this model explicitly — e.g. the Sentiment tab copy: *"Derived only from time entries logged to this project — never from the employee's other projects or general activity."*

**Caveat:** if the product intent is automatic project time tracking (Model 1/3), then the correct classification is **MISSING FEATURE** — the automatic activity→time pipeline simply does not exist yet. It is **not** a bug, a configuration issue, or a runtime/infrastructure issue: every moving part that exists works correctly.

---

## 16. Minimum Correct Fix (implementation plan only — NOT executed)

If automatic project time tracking is desired, the minimal coherent change set is:

1. **New aggregation service** (extend `mini-services/live-updates` or add a scheduled job in `src/lib/jobs/`, e.g. `project-time-sync`, reusing the existing JobRun lease pattern):
   - Periodically aggregate `Activity` durations per employee per day (`groupBy employeeId` over `timestamp`, excluding `idle`/`screenshot`/`work_session` double-counting — decide which types count).
   - For each employee/day, resolve **active** memberships (`ProjectMember` with `leftAt = null`) and **org-match** (`project.organizationId === employee.organizationId === member.organizationId`).
   - Convert activity seconds → `TimeEntry.hours` (daily, one per project-member-day, `upsert`-style), only when there is exactly one active membership (ambiguous multi-project → skip or split by config; never guess).
   - Guard: never write for `leftAt != null` memberships; never cross org.
2. **WebSocket invalidation:** add project-aware invalidation — emit a `time-entry` (or reuse `notification`) event, and extend `src/lib/ws-invalidation.ts` so time-entry changes invalidate `['projects']`, `['project-detail', id]`, `['project-time-entries', id]`, `['project-members', id]`, `['employee-projects']`.
3. **Optional UI:** show a "current session / today's tracked time" indicator on the Team tab to make the automatic tracking visible.

Exact files: `mini-services/live-updates/index.ts` (or `src/lib/jobs/*` + `src/lib/jobs/cli.ts`), `src/lib/ws-invalidation.ts`, `src/components/providers/websocket-provider.tsx`, `src/components/projects/projects-page.tsx`, plus a Prisma migration only if a schema change (e.g. `Activity.projectId` or a sync bookkeeping table) is chosen.

If instead the product stays on Model 2 (manual), **no code changes are required** — the current behavior is correct.

---

## 17. Validation Plan

1. Confirm Rimon still streaming: `Activity` count increases each minute while his agent runs. (Done during audit; re-verify after any change.)
2. Seed a manual TimeEntry via the Time Log tab for Rimon on project "ok" → verify `GET /api/projects/[id]` shows `totalHours > 0` and `progress > 0` and the card updates (validates the read/aggregation path works).
3. (If auto-tracking implemented) Wait one sync interval with Rimon active → verify a `TimeEntry` row appears with correct `projectId/employeeId/organizationId`, hours ≈ activity sum, and the project UI updates without manual action.
4. Remove/`leftAt` a membership → verify no further time accrues for that member.
5. Cross-org test: an employee in another org must never appear in this org's project hours.
6. Run `npm run typecheck` (or repo equivalent) + the existing `tests/projects*.test.ts` suites after any code change.

---

## 18. Final Verdict

**Project Tracking is working exactly as designed: it tracks manually-logged time, not agent activity.** Rimon's live activity is real, correctly collected, and correctly broadcast — it simply is not (and was never wired to be) the source of project hours.

- If manual time logging is the intended model → **EXPECTED BEHAVIOR, no action required.**
- If automatic time tracking is the intended model → **MISSING FEATURE**; implement §16, which is a well-scoped, org-safe, leftAt-guarded activity→TimeEntry sync + realtime invalidation.

---

### Acceptance criteria

- [x] Rimon's real employee record verified
- [x] Rimon's real project membership verified (`leftAt = null`, org match)
- [x] Rimon's real-time activity verified (1,135 → 1,137 live)
- [x] Activity DB rows verified (1,133+; newest 14:29:23Z)
- [x] TimeEntry DB rows verified (**0 org-wide**)
- [x] Project aggregation source identified (`TimeEntry` everywhere)
- [x] Activity → Project relationship verified (**none exists** — no projectId, no mapping)
- [x] Activity → TimeEntry relationship verified (**none exists** — manual creation only)
- [x] API responses compared before/after (unchanged: 0h / 0% while activity grew)
- [x] React Query/cache checked (mutation-only invalidation; no polling; WS never targets projects)
- [x] WebSocket checked (no project/time-entry events; activity-ping has no projectId)
- [x] Organization isolation checked (writes org + leftAt-guarded; no auto-path exists)
- [x] Exact root cause identified (§14)
- [x] **No production code modified**
- [x] Clear distinction made: **EXPECTED BEHAVIOR (Model 2)** · auto-tracking would be a **MISSING FEATURE**
