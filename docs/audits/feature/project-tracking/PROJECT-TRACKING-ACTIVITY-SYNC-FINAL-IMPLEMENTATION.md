# PROJECT TRACKING — ACTIVITY → PROJECT TIME SYNC — FINAL IMPLEMENTATION

**Status:** ✅ COMPLETE — verified end-to-end in the real browser, real database, and real WebSocket pipeline.

---

## 1. Before / After Architecture

### Before (Model 2 — manual-only)

```
Desktop Agent → Activity rows ───────────────────────────┐ (no projectId, no consumer)
                                                         │
Project Tracking ← TimeEntry ── created ONLY by:         │
  1. Admin manual Time Log POST                          │
  2. Admin bulk-import route                             │
                                                         ▼
              Project hours / progress / cost never move from activity
```

- `Activity` had no `projectId` and no consumer that turned activity into project time.
- Every project metric (totalHours, billableHours, progress, member hours, Time Log, Analytics, even Sentiment) was computed **only from manually-entered `TimeEntry` rows**.
- The live-updates WebSocket emitted 8 event types — none project-related; React Query invalidation never touched project keys.

### After (Model 3 — automatic, additive)

```
Desktop Agent → Activity rows
   │
   ▼
project-time sync engine (new)
   │  org-safe, consent-gated, membership-gated, idempotent
   ▼
ProjectTimeSync aggregate (employee + project + date)
   │  upserted incrementally (seconds only grow)
   ▼
TimeEntry row (source = ACTIVITY_AUTO, hours = seconds/3600)
   │
   ├─► project detail / time-entries / list APIs: manual + auto aggregates
   ├─► live-updates poll (updatedAt) → WS "project-time-update"
   └─► frontend invalidation → Projects UI + Live Monitor update in realtime
```

- **Manual TimeEntry is untouched**: a new `source` field distinguishes `MANUAL` (all existing rows backfilled) from `ACTIVITY_AUTO`. Manual creation routes were not modified.
- One `TimeEntry` row per employee+project+day+source (the existing unique constraint `[projectId, employeeId, date]` is preserved by upserting the auto row per day), backed by a finer-grained `ProjectTimeSync` table that stores per-employee/project/date seconds.

---

## 2. Root Cause (from the prior audit)

Project Tracking is a TimeEntry-based module and **nothing converted agent Activity into TimeEntry**, so an online, working, assigned employee never moved project hours. That is exactly the gap this implementation closes — without replacing the TimeEntry model, without breaking manual logging, and using only real database-backed activity and real membership.

---

## 3. Project Attribution Strategy (safest supported option)

`Activity` carries no projectId, and the desktop agent has no project context today. Per the requirement "do not guess project assignment," the engine attributes activity **only when the employee has exactly one active project membership at the time of the activity**:

- **1 active membership** → activity is attributed to that project (org-checked, `leftAt IS NULL`).
- **0 memberships** → no time.
- **2+ memberships** → **no time** (ambiguous; refused rather than guessed). This is the documented, safest behavior; an explicit per-employee "active project" selector is the clean future extension (see §15 Remaining limitations).

This is enforced *per activity*, using the membership as it existed at the activity's timestamp (via `leftAt` / `joinedAt` window), so an employee who joins a second project mid-day stops auto-attribution rather than splitting time.

---

## 4. Database / Schema Changes

`prisma/schema.prisma` + migration `20260815143728_project_time_auto_sync`:

```prisma
// TimeEntry gains a source discriminator (default MANUAL — existing rows safe)
source  TimeEntrySource @default(MANUAL)

enum TimeEntrySource {
  MANUAL
  ACTIVITY_AUTO
}

// Fine-grained idempotent aggregate: employee + project + date
model ProjectTimeSync {
  id           String   @id @default(cuid())
  employeeId   String
  projectId    String
  date         DateTime @db.Date
  seconds      Int      @default(0)
  createdAt    DateTime @default(now())
  updatedAt    DateTime @updatedAt
  employee     Employee @relation(fields: [employeeId], references: [id], onDelete: Cascade)
  project      Project  @relation(fields: [projectId], references: [id], onDelete: Cascade)
  @@unique([employeeId, projectId, date])
}

// Durable single-row cursor — survives restarts, no full-table rescans
model ProjectTimeSyncCursor {
  id             String   @id @default("global")
  lastProcessedAt DateTime
  updatedAt      DateTime @updatedAt
}
```

- No destructive changes; no existing data modified by the migration (manual rows get `source = 'MANUAL'` via the column default).
- The TimeEntry unique constraint `[projectId, employeeId, date]` is unchanged — auto time upserts into the same day slot, so manual + auto totals are additive without double counting.

---

## 5. Sync Engine — `src/lib/project-time/sync.ts` (new)

`syncProjectTime(now)` runs in batches and is fully idempotent:

1. **Cursor read** — starts from `ProjectTimeSyncCursor.lastProcessedAt` (initialized on first run to "now", i.e. **no backfill** — only new activity after enabling is tracked, per the backfill policy).
2. **Batch fetch** — `Activity` rows with `timestamp > cursor`, `timestamp <= now`, employee consent active, org memberships resolved, ordered asc, `take: BATCH_SIZE` (500), indexed.
3. **Per-activity resolution**:
   - Resolve employee → org (one query, deduped per batch).
   - Check **activity consent** (`ACTIVITY_TRACKING` granted AND within policy window AND not revoked) — revoked consent ⇒ row skipped; re-granted ⇒ resume on future rows. **No retroactive time**.
   - Resolve **active project memberships** at the activity's timestamp (org match + `leftAt IS NULL` + joined before the activity).
   - Exactly **one** membership ⇒ attribute; else skip.
   - Project status guard: `cancelled`/`archived` ⇒ no automatic time.
4. **Duration** — uses the authoritative `activity.duration` (seconds) when present; otherwise a safe gap-based estimate to the next activity **capped at `MAX_GAP_SECONDS = 300`** (5 min): larger gaps are treated as idle/disconnect and never inflate time.
5. **Aggregate upsert** — `ProjectTimeSync.upsert({ employeeId, projectId, date })` with `seconds: { increment }` (transactional, atomic — concurrent workers cannot double count).
6. **TimeEntry materialization** — one upsert per (employee, project, date) with `source: 'ACTIVITY_AUTO'`, `hours = seconds / 3600` (rounded to 2dp), preserving `billable: true`/`description: 'Automatically tracked from agent activity'`. Idempotent: re-running the same rows changes nothing.
7. **Cursor advance** — `lastProcessedAt` raised to the newest processed row **only after the batch commits** (same watermark discipline as the live-updates cursor; cannot skip, regress, or replay).
8. **No-op fast path** — if the cursor is caught up, one query, no writes, no broadcasts.

Consent, org-isolation, `leftAt`, project-status, and gap rules are all enforced **inside the engine** — the UI cannot bypass them.

---

## 6. Scheduler / Job Integration

- **`src/lib/jobs/run.ts`** — new `runProjectTimeSyncJob` registered in the job runner with a **database lease** (`claimJob`), so multiple web/worker processes never run the sync concurrently. (Also fixed a TOCTOU race in the pre-existing `claimJob` upsert: the row is now created neutral so a second worker cannot steal a `running` lease — verified by the consent test suite.)
- **`src/instrumentation.ts`** — `registerProjectTimeSyncLoop()` runs the engine every **60s** in the Next.js process (alongside the existing consent-expiry loop), with `now()`-parameterized idempotent execution so overlapping runs are safe.

---

## 7. Realtime Update Behavior

- **`mini-services/live-updates/index.ts`** — the poll now also queries `TimeEntry` rows with `source = ACTIVITY_AUTO` changed since the cursor (by `updatedAt`, so the accumulating daily entry re-broadcasts as it grows) and emits a new `project-time-update` event: `{ projectId, employeeId, hours, updatedAt }`.
- **`src/lib/ws-invalidation.ts`** — `projectTimeUpdateInvalidation` invalidates exactly:
  - `['projects']` (list/card totals)
  - `['project-detail', projectId]` (Overview totals, cost, progress)
  - `['project-time-entries', projectId, ...]` (Time Log)
  - `['employee-projects', employeeId]` (member surfaces)
- **`src/components/providers/websocket-provider.tsx`** — handles `project-time-update` and applies that invalidation.
- **`src/app/api/live-monitor/event-stats/route.ts`** + **`src/components/live-monitor/live-monitor-page.tsx`** — new `projectTime` event bucket so Live Monitor displays the new event type (with tests).
- No second WebSocket architecture: everything reuses the existing Socket.IO + provider + React Query pipeline.

---

## 8. API Changes

- **`src/app/api/projects/[id]/route.ts`** — project detail now returns `manualHours` and `autoHours` alongside `totalHours`/`billableHours`, plus `estCost`/`actualCost` and `progress` computed from real DB values (auto time included).
- **`src/app/api/projects/[id]/time-entries/route.ts`** — Time Log lists every entry with its `source` (`MANUAL` | `ACTIVITY_AUTO`) and an `aggregates: { totalHours, manualHours, autoHours }` block.
- `GET /api/projects` (list) unchanged in shape — card totals already flow from the same TimeEntry aggregation and now include auto time automatically.
- The manual Time Log POST/bulk-import routes are **unchanged** (still `source: MANUAL`).

---

## 9. UI Changes — `src/components/projects/projects-page.tsx`

- **Time Log**: each auto row shows a badge **"Activity Tracking"** (with a distinct icon + "Automatically tracked from agent activity" subtitle); manual rows show **"Manual"**. Auto rows are clearly distinguishable from manually-entered records.
- **Overview**: Actual Hours / Actual Cost already render; they now include auto time (real DB values). Manual vs auto hours are exposed in the API for display where useful.
- **Analytics**: new **"Manual vs Activity Tracking"** section — `Manual Xh` / `Activity Tracking Yh` — plus the existing Billable vs Non-Billable breakdown. Member contributions include auto time.
- No redesign — existing sections extended per instructions.

---

## 10. Tests — `tests/project-time-sync.test.ts` (13 tests, all passing)

Coverage of the required scenarios (each uses a fresh org/employee/project/membership and a clean per-test DB wipe):

| # | Scenario | Result |
|---|---|---|
| PTS-1 | Assigned to one project → activity produces project time | ✅ |
| PTS-2 | Not assigned → no project time | ✅ |
| PTS-3 | `leftAt` set → future activity does not count | ✅ |
| PTS-4 | Assigned to two projects → **no ambiguous attribution** | ✅ |
| PTS-5 | Duplicate/re-run sync → idempotent, no duplicate time | ✅ |
| PTS-6 | Manual TimeEntry preserved + auto + manual totals correct | ✅ |
| PTS-7 | Consent revoked → no auto time; re-granted → resumes; no retroactive time | ✅ |
| PTS-8 | Cross-org activity/project → blocked | ✅ |
| PTS-9 | Archived/cancelled project → no auto time | ✅ |
| PTS-10 | Large timestamp gap / idle → capped (no inflation) | ✅ |
| PTS-11 | Concurrent sync workers → no duplicate time (lease + atomic upsert) | ✅ |
| PTS-12 | Cursor discipline → no skips, no replays, no regressions | ✅ |
| PTS-13 | WebSocket `project-time-update` invalidation targets the right keys | ✅ |

Regression suites still passing: `tests/projects.test.ts`, `tests/consent.test.ts`, `tests/ws-invalidation.test.ts`, `tests/live-monitor-event-stats.test.ts`, plus `npx tsc --noEmit` (clean) and ESLint on all changed files.

---

## 11. Real Browser E2E Evidence (no fake data)

Environment: local dev stack (Next.js + live-updates + Postgres) with the real desktop agent feeding real Rimon activity.

1. **Sync works on real data** — during observation, Rimon's real activity rows (1,154+) produced an `ACTIVITY_AUTO` TimeEntry of **0.09h** on project "ok" (was 0), growing to **0.62h** as activity continued. The sync engine logs `[jobs] project-time sync loop started (interval 60s)`.
2. **Cursor verified** — `ProjectTimeSyncCursor.lastProcessedAt` tracks the newest processed activity; the per-batch advance is post-commit.
3. **WS realtime verified** — live Socket.IO listener received real `project-time-update` events carrying the growing hours (0.16h, …) with `projectId` of project "ok".
4. **API verified** — `GET /api/projects/[id]` returns `manualHours: 0`, `autoHours: 0.62`, `totalHours: 0.62`; Time Log API returns the auto entry with `source: 'ACTIVITY_AUTO'` and aggregates.
5. **Browser (Playwright, real Chromium) verified**:
   - Project card: **"0.5h / 200h est."** (was 0 before the feature).
   - Detail → Time Log: *"Rimon Rana — Automatically tracked from agent activity — 0.5h — **Activity Tracking** — Billable"*.
   - Detail → Analytics: **"Manual vs Activity Tracking — Manual 0h / Activity Tracking 0.5h"**.
   - **Realtime in-browser**: with the Projects page open and no reload/navigation, the card increased **0.5h → 0.6h** purely via the WebSocket invalidation.
   - Browser refresh → values persist (server-backed, not client state).
6. **No duplicate-key warnings** — console clean; `@prisma/client` uniqueness respected by upserts.

DB state at report time: `TimeEntry` rows: 1 auto (0.62h) / 0 manual; `ProjectTimeSync`: 1 aggregate (2,226s); cursor: 15:20:02Z; total activity rows: 1,194.

---

## 12. Performance Findings

- **No full-table scans**: cursor-driven batches (500/run) over `Activity(timestamp)`; one org + one membership query per unique employee per batch (deduped), not per row.
- **No per-event TimeEntry rows**: a single upsert per (employee, project, date) both in `ProjectTimeSync` and in `TimeEntry`.
- **No repeated work**: `ProjectTimeSync.seconds` only increments; re-runs are no-ops; the caught-up fast path is a single indexed query.
- **Bounded broadcasts**: WS events only when auto hours actually change.
- The pre-existing live-updates poll cursor fix (rows committed after the pre-query `now` are re-eligible, not re-broadcast twice) was retained — the new auto-time poll uses the same `nextPollCursor` discipline.

---

## 13. Security / Consent Findings

- **Org isolation**: activity is attributed only to a project whose `organizationId` equals the employee's org; cross-org tests (PTS-8) prove it fails closed.
- **Membership**: `leftAt IS NULL` + joined-before-activity enforced per activity (PTS-3).
- **Consent**: only activities inside a granted, un-revoked `ACTIVITY_TRACKING` consent window count; revoked periods produce **zero** time and no retroactive backfill on re-grant (PTS-7).
- **Project status**: cancelled/archived projects never receive auto time (PTS-9).
- **AgentToken/RBAC**: unchanged — sync runs server-side against the same auth-scoped org model; the admin UI paths preserve their existing guards.
- **Transactions**: aggregate upsert + cursor advance are transactional; the job lease (`claimJob`) plus atomic `seconds: { increment }` make concurrent workers safe (PTS-11).

---

## 14. Remaining Limitations

1. **Multi-project employees**: with 2+ active memberships, activity is intentionally *not* attributed (safe refusal). The natural extension is an explicit per-employee "active project" selection (desktop-agent or settings) — documented, not guessed.
2. **Rounding**: auto hours materialize at 2dp; the sub-cent remainder stays in `ProjectTimeSync.seconds` and is never lost, but the TimeEntry row may trail the raw seconds by <1 min/day.
3. **Backfill**: intentionally not implemented — only activity after first sync enablement is tracked (admin-controlled backfill could reuse the same idempotent engine later).
4. **Day boundary**: auto time is bucketed by UTC date (consistent with existing TimeEntry.date semantics); org-timezone day bucketing would be a follow-up.

---

## 15. Final Score

**P1** — the core feature (real activity → real automatic project time, idempotent, consent- and org-safe, realtime UI) is complete and verified end-to-end. Multi-project attribution (P2) and admin backfill (P2) remain as documented extensions.

## 16. Final Verdict

**FUNCTIONAL** — verified with real employee activity against the real database and real browser: automatic project hours appear, accumulate, refresh via WebSocket without a page reload, persist across refresh, and are clearly labeled "Activity Tracking" vs "Manual" in the Time Log and Analytics.
