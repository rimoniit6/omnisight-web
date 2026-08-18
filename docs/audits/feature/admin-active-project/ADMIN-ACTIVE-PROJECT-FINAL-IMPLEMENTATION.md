# ADMIN-CONTROLLED ACTIVE TRACKING PROJECT — FINAL IMPLEMENTATION

**Verdict: FUNCTIONAL** ✅

Verified end-to-end with the real running application, real PostgreSQL, real
Chrome, and REAL agent activity through the actual desktop-agent ingestion
pipeline (`POST /api/agent/activity`). No mock data, no fake activity, no
frontend-only calculations, no manual DB manipulation to simulate success.

---

## 1. Audit findings (Phase 1)

Full audit captured in `ADMIN-ACTIVE-PROJECT-AUDIT.md`. Key findings:

- The existing sync engine (`src/lib/project-time/sync.ts`) already handled the
  **0-membership** (skip) and **exactly-1-membership** (attribute) cases and
  **never guessed/split** on 2+ memberships — that case produced no automatic
  time by design.
- The gap this feature closes: an employee with 2+ active memberships has no
  explicit "which project is being worked on" signal. The fix is an
  **Admin-selected active tracking project** stored server-side on the Employee.
- `ProjectMember.leftAt` (soft-removal) is set in exactly two routes:
  `DELETE /api/projects/[id]/members/[memberId]` and
  `PUT /api/employees/[id]/projects` — both became auto-clear points.
- Authorization is `requireAdminOrg` (org-bound admin-or-above) everywhere —
  backend-enforced, never hidden-UI-only.
- Audit uses the existing `AuditLog` model with JSON metadata.

## 2. Architecture decision (Phase 2)

**`Employee.activeTrackingProjectId String?`** (nullable FK → `Project`,
`onDelete: SetNull`) was chosen over a separate table because:

- Naturally 1:1 with the employee — enforces "exactly one active project".
- Server/database-backed — the sync engine reads the authoritative value
  directly; nothing is stored in React/localStorage.
- Org safety is enforced at **two layers**: the write API validates
  `employee.organizationId === project.organizationId` AND active membership
  before persisting; the sync engine re-validates org + membership + project
  status at sync time, so a stale/corrupted value can never attribute
  cross-org.
- `onDelete: SetNull` keeps the FK honest without blocking project deletion.

## 3. Database changes (Phase 2)

Migration `20260815152704_employee_active_tracking_project`:

- `Employee.activeTrackingProjectId String?` + named relation
  `activeTrackingProject Project? @relation("ActiveTrackingProject", ..., onDelete: SetNull)`
  + `@@index([activeTrackingProjectId])`.
- Reverse relation on `Project`: `activeTrackingEmployees Employee[]`.

The `ProjectTimeSync`, `ProjectTimeSyncCursor`, and `TimeEntry.source`
(`MANUAL`/`ACTIVITY_AUTO`) models already existed from the prior
activity→time sync work and were **not** rewritten.

## 4. API changes (Phase 4)

New **`PUT /api/employees/[employeeId]/active-project`**
(`src/app/api/employees/[id]/active-project/route.ts`):

- Body `{ "projectId": "..." }` to set/switch, `{ "projectId": null }` to clear.
- `requireAdminOrg` → 401/403.
- Employee must be in the caller's org → 404 (cross-org concealed).
- Project must be in the SAME org as the employee → 404 (cross-org concealed).
- Project must not be `cancelled` → 409.
- Active membership required (`ProjectMember.leftAt IS NULL`) → 409.
- Idempotent re-set → 200 no-op, no duplicate audit row.
- Change + audit committed in one transaction.

Response (200):
```json
{ "data": { "employeeId": "...", "activeProject": { "id": "...", "name": "..." } | null } }
```

## 5. Admin UI changes (Phase 6 + 18)

**Primary surface: Project Tracking → project detail → Team tab**
(`src/components/projects/projects-page.tsx`), following the existing row-based
card design:

- Each member row shows the admin-selected state, deliberately distinct from
  the presence dot:
  - **● `Active Tracking Project`** (emerald) for the selected project.
  - **○ `Assigned`** (muted) for every other membership.
- Admin-only actions (gated by the existing `canManageProjects`):
  - **`Set as Active`** on non-active rows.
  - **`Clear Active`** on the active row.
- Confirmation dialogs (Phase 8) with the exact copy from the spec:
  - Set: *"Set …'s active tracking project to this project? New activity will
    be attributed to this project. Existing time entries will not be
    changed."* — button **Set Active Project**.
  - Clear: *"Clear …'s active tracking project? New activity will not be
    automatically assigned to a project until another active project is
    selected."* — button **Clear Active Project**.
- `GET /api/projects/[id]/members` now returns `activeTrackingProjectId` and a
  derived `isActiveTracking` per member (one fetch, no second round-trip).
- Time Log already renders the **`Activity Tracking`** badge (sky) vs **Manual**
  badge for entries — unchanged, verified in E2E.

**Phase 7 (employee-centric control): intentionally skipped.** The spec says to
prefer **ONE authoritative Admin control** and avoid duplicate surfaces; the
Team tab is that single surface. The employee detail page was left untouched.

## 6. Project attribution changes (Phase 9 + 13)

New attribution order in the sync engine:

1. **Explicit `activeTrackingProjectId` set + valid at sync time** (found in
   the ACTIVE membership list, same org, project not `cancelled`) → attribute
   there. This resolves the 2+ membership case without guessing.
2. Explicit set but **stale/invalid** (membership removed/leftAt set, org
   mismatch, project gone/cancelled) → **skip — never guess, never fall back**
   to another project. Silently re-attributing behind the admin's back would be
   a guess (spec rule 5).
3. **No explicit value** → existing behavior unchanged: exactly 1 active
   membership wins; 0 or 2+ skipped.

Switching (Phase 13): only `activeTrackingProjectId` changes. Previous
ACTIVITY_AUTO TimeEntries are **never rewritten or reassigned** — history stays
on the project it was originally attributed to (proven by E2E step 21b: the
"ok" entry was byte-for-byte frozen across two sync windows after the switch).

## 7. Sync engine changes (`src/lib/project-time/sync.ts`)

Minimal, surgical edits only (engine otherwise untouched):

- Employee batch select now also loads `status` + `activeTrackingProjectId`
  (same single batched query — no N+1).
- New attribution branch above, using the already-loaded membership list.
- New guard: **deactivated/archived employee → no new automatic project time**
  (`skippedEmployeeInactive`), satisfying Phase 10 Case C.
- New result counters for observability: `skippedStaleActiveProject`,
  `skippedEmployeeInactive` (mirrored in `src/lib/jobs/run.ts` empty result).

## 8. Security / RBAC (Phase 4 + 23)

- Backend-enforced everywhere via `requireAdminOrg`; the UI merely hides
  controls for parity. A crafted request is rejected server-side.
- Cross-org employee/project IDs → **404** (concealed, never leaks existence).
- Non-member / soft-removed member / cancelled project → **409**.
- Covered in tests: non-admin (manager/viewer) 403, cross-org project 404,
  non-member 409, soft-removed 409, cancelled 409, invalid payload 400,
  unknown employee 404, cross-org isolation at sync time.

## 9. Consent behavior (Phase 16)

Unchanged and re-verified: setting an active project **never grants or
bypasses** `activity_tracking` consent. The sync engine still fails closed when
consent is revoked; restoring consent resumes tracking; the denied period is
never backfilled (cursor semantics unchanged). Test AP-21 proves this with an
explicit active project set.

## 10. Stale-project handling (Phase 10 + 11)

| Case | Handling |
|---|---|
| A. Member removed (`leftAt` set via `DELETE /projects/[id]/members/[memberId]`) | **Auto-clears** `activeTrackingProjectId` in the same transaction |
| A2. Membership dropped via `PUT /employees/[id]/projects` assignment replacement | **Auto-clears** in the same transaction |
| B. Project archived (`DELETE /projects/[id]`) | **Auto-clears** the field for every employee pointing at it (transaction) |
| C. Employee deactivated | Sync engine skips (`skippedEmployeeInactive`) |
| D. Employee moves org | No org-move feature exists; sync-time org re-validation blocks any cross-org attribution (defense-in-depth test AP-25) |

Even when auto-clear is missed, the sync engine independently rejects a stale
selection (`skippedStaleActiveProject`) — never guesses.

## 11. Realtime behavior (Phase 14)

- The mutation invalidates only the relevant queries:
  `['project-members', id]`, `['project-detail', id]`, `['projects']`,
  `['employee-projects']` — no global invalidation.
- New ACTIVITY_AUTO entries already broadcast over the existing Socket.IO
  infra as `project-time-update` (pre-existing `mini-services/live-updates`),
  which invalidates the project queries — the E2E showed the Time Log updating
  **without a page reload**.
- No new WebSocket system was created (spec permits React Query invalidation
  alone; no `employee-active-project-updated` event was added since the same
  browser that mutates also invalidates).

## 12. Automated test results (Phase 19)

**`tests/active-project.test.ts` — 25/25 pass** (throwaway DB
`workai_test_active_project`):

- API: set (200+audit SET), clear (CLEARED), switch (CHANGED with
  previousProjectId), non-admin 403, cross-org 404, non-member 409,
  soft-removed 409, cancelled 409, invalid payload 400, idempotent re-set no-op.
- Members GET exposes `isActiveTracking`.
- Stale handling: member removal clears (transaction), archive clears all,
  assignment replacement clears.
- Sync: one-membership fallback, multi-membership no explicit → no time,
  multi + explicit → only selected, switch keeps history, stale explicit never
  guesses, cancelled explicit blocked, consent revoked/restored, deactivated
  employee, manual entry untouched, idempotency, cross-org isolation.

**Existing suites re-run green** (see §16).

## 13. Real browser E2E (Phase 20) — **31/31 passed**

`scripts/active-project-e2e.mjs` against the running dev server + real DB +
real Chrome + real agent token:

1. ✅ Admin login → Project Tracking → project **"ok"** → Team tab
2. ✅ Rimon Rana (001) confirmed assigned
3. ✅ **Set "ok" as Active Tracking Project** via UI (Set as Active →
   confirmation dialog → Set Active Project)
4. ✅ UI shows **● Active Tracking Project** indicator
5. ✅ DB `activeTrackingProjectId = ok`
6. ✅ **Real agent activity** (`POST /api/agent/activity`, real token) accepted
7. ✅ Sync loop absorbed it → **ACTIVITY_AUTO** TimeEntry on "ok",
   hours increased (+0.03h from the 90s marker)
8. ✅ Time Log shows **Activity Tracking** source **without reload**
9. ✅ Second project created + Rimon assigned → **active project unchanged**
10. ✅ **Switch** to second project via UI → DB + indicator update
11. ✅ New real activity → **only** the second project (0.03h); "ok" count
    stayed 1 and its hours stayed **frozen across two 25s windows** (even the
    live agent's real activity went to the new project)
12. ✅ Browser refresh → active project **persists** (DB-backed + UI indicator)
13. ✅ **Remove** Rimon from active project → `activeTrackingProjectId` **auto-cleared**
14. ✅ Activity after removal → removed project receives **no new** auto time
15. ✅ Cleanup: test project/members/activities removed, active project
    restored to `null`

The two `PUT /api/employees/…/active-project` calls both returned **200**.

## 14. PostgreSQL verification (Phase 21)

Post-E2E direct checks on the real `workai` database:

- `Employee.activeTrackingProjectId` = `null` (restored original state).
- `ProjectMember`: Rimon → "ok" intact, `leftAt IS NULL`, same org.
- `TimeEntry(source=ACTIVITY_AUTO)`: exactly **one** aggregated row for
  Rimon/"ok" — `groupBy` shows count 1 per (employee, project, date, source)
  bucket → **no duplicates**.
- `ProjectTimeSync`: single (employee, project, date) bucket, accumulating.
- `ProjectTimeSyncCursor` advancing (last processed 15:53:43Z).
- Zero leftover test projects / marker activities.
- 6 `AuditLog` rows with `resource='employee_active_project'` (real audit
  trail from the E2E runs).

## 15. Performance findings (Phase 22)

- The active-project value rides the **same single batched employee query**
  per sync batch (one `WHERE id IN (...)`) — no per-activity query, no N+1.
- Attribution reuses the already-loaded membership list; no extra project
  queries per activity.
- `@@index([activeTrackingProjectId])` on Employee and the existing
  `ProjectMember` indexes cover the archive/removal auto-clears
  (`updateMany ... WHERE activeTrackingProjectId = X`).
- Sync still bounded (batch size 500, ≤20 batches/run, 60s cadence — unchanged).

## 16. Regression results (Phase 24)

| Check | Result |
|---|---|
| `npx tsc --noEmit` | ✅ 0 errors |
| ESLint (all changed files incl. UI + E2E script) | ✅ 0 errors |
| `tests/active-project.test.ts` (new) | ✅ 25/25 |
| `tests/project-time-sync.test.ts` | ✅ 13/13 |
| `tests/projects.test.ts` + `projects-tracking.test.ts` | ✅ 28/28 |
| `tests/hardening.test.ts` + `security.test.ts` | ✅ 52/52 |
| `tests/consent.test.ts` + `multi-org-isolation.test.ts` | ✅ 75/75 |
| `tests/ws-invalidation.test.ts` + `live-updates-cursor.test.ts` + `project-sentiment.test.ts` | ✅ 23/23 |
| Desktop Agent | not affected — agent has only a read-only project-name projection and no write path that could override the server-side active project (Phase 15 verified) |
| Real browser E2E | ✅ 31/31 |

## 17. Remaining limitations

- The Time Log "Activity Tracking" badge and project card hours are driven by
  the pre-existing sync/WS pipeline; the active-project feature itself only
  changes **where** activity is attributed, not the aggregation mechanics.
- Phase 7 (employee-detail active-project control) was intentionally **not**
  added to preserve a single authoritative Admin control, per the spec.
- A stale explicit selection is *rejected* at sync time (never guessed), so an
  admin must re-select after a membership change; the auto-clear paths
  (`DELETE` member, assignment replacement, archive) already prevent most
  stale states from surviving.
- The live-updates service shows 4× `401` console entries in dev from the
  socket.io polling handshake — pre-existing and unrelated to this feature
  (the two active-project API calls both returned 200).

---

**Final verdict: FUNCTIONAL.** Admin selects Rimon → Project OK as Active
Tracking Project → Rimon produces real Desktop Agent activity → activity is
synchronized → ACTIVITY_AUTO TimeEntry created/aggregated → Project OK hours
increase → WebSocket update reaches the Admin browser → UI updates without
refresh → database persistence survives refresh. All verified with the real
stack.
