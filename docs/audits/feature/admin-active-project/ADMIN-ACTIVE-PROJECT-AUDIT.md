# ADMIN-CONTROLLED ACTIVE TRACKING PROJECT — AUDIT

## 1. Current attribution logic (src/lib/project-time/sync.ts)

The sync engine (`runProjectTimeSync`) processes real Activity rows in cursor-bounded batches and attributes each one by **active membership count**:

| Active memberships at activity time | Attribution |
|---|---|
| 0 | skipped (`skippedNoMembership`) — no automatic time |
| 1 | attributed to that project (after org check, `leftAt IS NULL`, project not `cancelled`) |
| 2+ | skipped (`skippedAmbiguousMembership`) — **never guessed, never split** |

The engine already: uses agent-reported `Activity.duration`, excludes non-working types, buckets per (employee, project, org-local-day) into `ProjectTimeSync`, rewrites a single `TimeEntry(source=ACTIVITY_AUTO)` per bucket, guards on `activity_tracking` consent at sync time, and advances a transactional `ProjectTimeSyncCursor` (no backfill; first run pins cursor to `now`).

**Gap this feature closes:** the 2+ membership case has no explicit project context, so no automatic time is produced. There is currently **no per-employee notion of "which project is being worked on."**

## 2. Current ProjectMember structure

```prisma
model ProjectMember {
  id             String
  projectId      String
  employeeId     String
  role           String   // lead, member, reviewer, stakeholder
  hoursPerWeek   Float
  joinedAt       DateTime
  leftAt         DateTime?   // null = active membership
  organizationId String
  @@unique([projectId, employeeId])
}
```

Active membership = `leftAt IS NULL`. Soft-removal (setting `leftAt`) happens in exactly **two** API routes:
- `src/app/api/projects/[id]/members/[memberId]/route.ts` (DELETE — Team tab remove)
- `src/app/api/employees/[id]/projects/route.ts` (PUT — employee assignment replacement)

## 3. Where the active-project state should live

**`Employee.activeTrackingProjectId String?`** (nullable FK to `Project`) — chosen over a separate table because:
- It is naturally 1:1 with the employee and matches the "one active tracking project per employee" invariant.
- Server/database-backed (not localStorage / not React state), so the sync engine reads the authoritative value directly.
- Org safety: the write API validates `employee.organizationId === project.organizationId` AND active membership before persisting; the sync engine re-validates at sync time, so a stale value can never attribute cross-org.
- `onDelete: SetNull` on the relation keeps the FK honest without blocking project deletion; archive (`status=cancelled`) is handled by the sync engine's existing archived-project guard plus an explicit clear in the archive route.

## 4. Authorization architecture

- `requireAdminOrg(req)` — org-bound admin-or-above; returns `{ ok, organizationId, userId }` or 401/403. **This is the single gate** for every admin mutation (project members add/remove, project archive, time entry create). The new active-project API will use the same helper — backend-enforced, never hidden-UI-only.
- `requireSessionOrg` for reads; `authError` helper for consistent 401/403 envelopes.
- UI parity: `hasRolePermission(role, 'admin')` already gates Team tab controls via `canManageProjects`.

## 5. Audit logging

`AuditLog` model: `{ action, resource, resourceId, description, userId, organizationId, metadata (JSON) }`. Existing project-member routes write `create`/`update`/`delete` entries. The active-project change will write entries with:
- `action`: `ACTIVE_TRACKING_PROJECT_SET` / `ACTIVE_TRACKING_PROJECT_CHANGED` / `ACTIVE_TRACKING_PROJECT_CLEARED`
- `resource`: `employee_active_project`, `resourceId`: employeeId
- `metadata` JSON: `{ employeeId, projectId, previousProjectId, organizationId, actorId, timestamp }`

No sensitive activity content is logged.

## 6. Where the UI should change

- **Primary surface: Project Tracking → project detail → Team tab** (`src/components/projects/projects-page.tsx`). Each member row currently shows avatar + PresenceDot + name + email/designation + role Select + hours + remove button. The active-tracking indicator + "Set as Active" / "Clear Active" action belongs on these rows (admin-only, matching `canManageProjects`).
- The members API (`GET /api/projects/[id]/members`) must expose each employee's `activeTrackingProjectId` (or a derived `isActiveTracking` flag) so the Team tab can render the state without a second fetch.
- Confirmation dialogs reuse the existing `Dialog`/`DialogFooter` components already imported in the page.

## 7. Realtime / invalidation

Mutations already invalidate: `['project-members', id]`, `['project-detail', id]`, `['project-time-entries', id]`, `['projects']`, `['employee-projects']`. The active-project mutation will do the same (plus the employee's own queries). No new WebSocket system is required — optional `employee-active-project-updated` can ride the existing Socket.IO infra, but React Query invalidation after the mutation is sufficient for the admin UI (the spec permits either).

## 8. Sync engine change (minimal)

In `processBatch`, the employee select adds `activeTrackingProjectId`. Attribution becomes:
1. **Explicit active project set + valid at sync time** (same org, active membership with `leftAt IS NULL`, project not `cancelled`) → attribute there. This resolves the 2+ membership case.
2. Explicit set but **invalid/stale** → fall through to rule 3 (never guess, never attribute to the stale project).
3. **No explicit value** → existing behavior (exactly 1 active membership wins; 0 or 2+ skipped).

The per-activity membership snapshot is already loaded in one query per batch; the active-project validation reuses that same membership list, so there is **no N+1 and no extra query per activity**.

## 9. Stale-active handling (auto-clear points)

- `ProjectMember.leftAt` set in either removal route → clear `Employee.activeTrackingProjectId` in the same transaction when it points at that project.
- Project archived (`status=cancelled` in `DELETE /api/projects/[id]`) → clear the field for every employee pointing at it (defensive; the sync engine also rejects archived projects).
- Employee deactivated / org moved → no new automatic time falls out of the sync engine's org/employee-resolution checks.

## 10. Files to be changed

- `prisma/schema.prisma` — `Employee.activeTrackingProjectId` + named relation; migration.
- `src/app/api/employees/[id]/active-project/route.ts` — **new** PUT endpoint.
- `src/lib/project-time/sync.ts` — explicit-active precedence in attribution.
- `src/app/api/projects/[id]/members/[memberId]/route.ts` — auto-clear on removal (transaction).
- `src/app/api/employees/[id]/projects/route.ts` — auto-clear when a removed membership was active-tracking (transaction).
- `src/app/api/projects/[id]/route.ts` — clear on archive.
- `src/app/api/projects/[id]/members/route.ts` — expose `activeTrackingProjectId` per member.
- `src/components/projects/projects-page.tsx` — Team tab indicator + Set/Clear actions + confirmation dialogs.
- `tests/` — comprehensive suite (24 scenarios).

No changes needed to: desktop agent, consent logic, manual TimeEntry creation, `ProjectTimeSync`/cursor models, or the WebSocket infrastructure.
