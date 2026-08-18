# WorkLensAI — M004 Implementation Report (ActivityEvent Foundation, Stage-1)

> **File:** workload/24-M004-ActivityEvent-Foundation.md · **Date:** 2026-08-02 · **Status:** ✅ COMPLETE
> **Scope:** database-only preparation for the telemetry core. `ActivityLog` → `ActivityEvent` rename with **every record preserved** and **no business endpoints, routes (one compile-compat line), components, or business logic refactored**.

---

## 1. Summary

| Item | Result |
|---|---|
| Model rename | ✅ `ActivityLog` → `ActivityEvent` (physical table kept as `ActivityLog` via `@@map` → **pure-ALTER migration**) |
| New nullable fields | ✅ `seq Int?` · `kind String?` · `payload Json?` · `sessionId String?` · `source String?` · `receivedAt DateTime?` (deviceId already existed) |
| Relation | ✅ `ActivityEvent.deviceId → Device.id` nullable, `onDelete: SetNull` (pre-existing FK, made explicit) |
| Indexes | ✅ `deviceId`, `timestamp`, `kind` — all safe, non-unique. **No `UNIQUE(deviceId, seq)` yet** (Stage-2) |
| Migration | ✅ `20260802152439_m004_activity_event_foundation` — **6 × `ALTER TABLE ADD COLUMN` + 3 × `CREATE INDEX`; zero recreate, zero DROP, zero truncation** |
| Data preserved | ✅ 491 activity rows intact (User 36 · Org 6 · Device 10 · Screenshot 146 · LoginSession 54 · Installation 1) |
| Compatibility | ✅ `src/lib/db.ts` `db.activityLog` delegate alias → 10 API routes + 3 seed scripts compile & run unchanged |
| `prisma validate` / `generate` | ✅ valid / Client v6.19.3 |
| `migrate status` | ✅ 3 migrations, "Database schema is up to date!" |
| `npm run build` | ✅ 35 routes compiled, standalone copied |
| `tsc --noEmit` | ✅ only the 4 pre-existing errors (examples/websocket ×2, markdown.tsx ×2) — **0 new errors** |
| Runtime | ✅ **18/18 endpoint checks** (login/dashboard/activity/analytics/timeline/users/devices + per-user sub-routes) + timeline `kind` discrimination verified |

---

## 2. Files Changed

| File | Change |
|---|---|
| `prisma/schema.prisma` | **MODIFIED** — `model ActivityLog` → `model ActivityEvent` (all 18 old fields kept) + 6 additive nullable fields; `@@map("ActivityLog")`; explicit legacy relation names `"ActivityLog_userId"` / `"ActivityLog_deviceId"` (keep FK constraint names stable → pure ALTER); `@@index([deviceId])`, `@@index([timestamp])`, `@@index([kind])`; `User.activities` / `Device.activities` relation field names kept |
| `src/lib/db.ts` | **MODIFIED** — `db.activityLog` delegate alias → `activityEvent` (deprecated note added) |
| `src/app/api/users/[id]/activity-matrix/route.ts` | **MODIFIED (1 line — required compile-compat fix, see §4)** — moved the `kind: 'activity' as const` literal after the `...a` spread |
| `prisma/migrations/20260802152439_m004_activity_event_foundation/migration.sql` | **NEW** — generated, reviewed, applied |
| `db/custom.db` | migrated (backup: `db/custom.db.bak-m004`) |
| `workload/24-M004-ActivityEvent-Foundation.md` | **NEW** — this report |
| `workload/07-Progress.md` | **APPENDED** — dated entry |

**Not touched:** any other API route, any React component, `prisma/seed*.ts` (no seed changes required), business logic.

---

## 3. Migration Summary

- **Folder:** `prisma/migrations/20260802152439_m004_activity_event_foundation/migration.sql`
- **Generated:** `prisma migrate dev --create-only --name m004_activity_event_foundation` (inspected before applying)
- **Applied:** `prisma migrate dev`
- **What it does (verbatim):**
```sql
ALTER TABLE "ActivityLog" ADD COLUMN "kind" TEXT;
ALTER TABLE "ActivityLog" ADD COLUMN "payload" JSONB;   -- SQLite → NUMERIC affinity, see Risks
ALTER TABLE "ActivityLog" ADD COLUMN "receivedAt" DATETIME;
ALTER TABLE "ActivityLog" ADD COLUMN "seq" INTEGER;
ALTER TABLE "ActivityLog" ADD COLUMN "sessionId" TEXT;
ALTER TABLE "ActivityLog" ADD COLUMN "source" TEXT;
CREATE INDEX "ActivityLog_deviceId_idx" ON "ActivityLog"("deviceId");
CREATE INDEX "ActivityLog_timestamp_idx" ON "ActivityLog"("timestamp");
CREATE INDEX "ActivityLog_kind_idx" ON "ActivityLog"("kind");
```
- **Why pure-ALTER:** `@@map("ActivityLog")` keeps the physical table name, and the explicit legacy relation names keep the FK constraint names (`ActivityLog_userId_fkey`, `ActivityLog_deviceId_fkey`) identical — so Prisma's diff sees only new columns + indexes. No table-recreate, no row copy, no data-loss surface.
- **Rows:** 491 before → **491 after** (verified via `node:sqlite`).

---

## 4. The One Route Line — Required Compile-Compat Fix

The task says "DO NOT modify any API route," but the new `kind` column collides with `src/app/api/users/[id]/activity-matrix/route.ts:102`:

```ts
// BEFORE (broke under tsc + would send kind:null to the UI):
{ kind: 'activity' as const, ...a, timestamp: ... }
// AFTER (kind literal wins over the nullable column):
{ ...a, kind: 'activity' as const, timestamp: ... }
```

- **Why it was unavoidable:** the route spreads a whole activity row after a `kind` literal; the new `kind` column (null on all legacy rows) was overwriting the literal — TypeScript `TS2783` (new error, breaking "Old queries must still compile") **and** runtime `kind: null`.
- **Why it's safe:** the timeline UI only discriminates on `kind === 'screenshot'` (`timeline-page.tsx:145`), and the fix restores the exact pre-migration value (`'activity'`). Verified live: timeline shows `kinds=[activity, screenshot]` correctly for a screenshot-bearing user.
- **If you disagree, revert it:** `git checkout -- "src/app/api/users/[id]/activity-matrix/route.ts"` — but the project will then have 1 new tsc error and the API will return `kind: null` for activity entries.

This is the **only** route touched; it is a behavior-preserving 1-token move, not a refactor, and it is required by the task's own rule "Old queries must still compile after minimal Prisma rename."

---

## 5. Verification

| Command / check | Result |
|---|---|
| `prisma validate` | ✅ valid |
| `npm run db:generate` (prisma generate) | ✅ Client v6.19.3 |
| `prisma migrate dev` | ✅ applied `m004_activity_event_foundation` |
| `prisma migrate status` | ✅ 3 migrations, up to date |
| Row counts | ✅ ActivityLog **491** (unchanged) · User 36 · Org 6 · Device 10 · Screenshot 146 · LoginSession 54 |
| Columns | ✅ 24 (18 legacy + 6 new) all present |
| Indexes | ✅ `kind`/`timestamp`/`deviceId` + PK autoindex |
| `npm run build` | ✅ (route table lists 35, standalone copied) |
| `tsc --noEmit` | ✅ 0 new errors (4 pre-existing untouched) |
| `eslint src/lib/db.ts` | ✅ exit 0 |
| Runtime 18/18 | ✅ login (Admin JWT) · dashboard (kpis + topApps from activityLog) · activity (rows) · analytics · timeline · users · devices (_count.activities) · users/[id] (activities relation) · users/[id]/timeline · activity-matrix · screenshots · devices/[id] (activities include) · ai-summary POST (DB path OK) |
| Timeline `kind` values | ✅ activity entries `'activity'`, screenshot entries `'screenshot'` (compat fix verified) |

> ⚠ Do **not** run `prisma db seed` to test the alias write-path — `prisma/seed.ts:12` calls `db.activityLog.deleteMany()` and would wipe the 491 rows this task exists to preserve. The alias write-path is covered because the alias **is** the same delegate object (`db.activityLog === db.activityEvent`).

---

## 6. Risks & Stage-2 Preconditions

1. **`payload Json?` uses SQLite NUMERIC affinity** (Prisma emits `JSONB`). A JSON string that *looks* numeric (e.g. `"123"`) can be coerced to a number on write. Task mandated `Json?`; design doc (18 §5.5) preferred `String?` for SQLite. → Stage-2: prefer object/array payloads, or switch to `String` if payload integrity matters.
2. **Stage-2 must backfill `seq` (and optionally `kind`) before `UNIQUE(deviceId, seq)` + required columns.** Verified state of the 491 legacy rows: `deviceId` **already populated** (0 NULLs — the seed set it), `seq` all NULL, `kind` all NULL. Stage-2: assign per-device monotonic `seq` (e.g. `ROW_NUMBER` over `(deviceId, timestamp)`), optionally map legacy `type` → `kind`, then add the unique index.
3. **Physical table stays `"ActivityLog"`** via `@@map` — deliberate (zero-recreate). Stage-2 must consciously decide: keep the legacy table name forever, or plan a rename to `ActivityEvent` (a table-recreate). Changing the legacy relation names would also force a recreate.
4. **`db.activityLog` alias is deprecated** — Stage-2 should migrate the 10 routes + 3 seeds to `db.activityEvent`, then remove the alias.
5. **`@@index([kind])`** is mostly empty until Stage-2 populates `kind` (SQLite indexes include NULLs) — harmless.
6. **One route line changed** (§4) — the single deviation from "no route changes", required and behavior-preserving; revert instructions provided.

---

## 7. Rollback

```bash
# DB: restore the pre-M004 backup
cp db/custom.db.bak-m004 db/custom.db

# Schema: revert the rename (git checkout restores ActivityLog model)
git checkout -- prisma/schema.prisma

# Revert the compat alias + the one route line
git checkout -- src/lib/db.ts "src/app/api/users/[id]/activity-matrix/route.ts"

# Remove the migration folder (only after reverting schema + DB)
rm -rf prisma/migrations/20260802152439_m004_activity_event_foundation

# Regenerate
npm run db:generate
```

**Data impact of rollback:** zero — the migration was additive (6 nullable columns + 3 indexes); the backup restores the exact pre-M004 file.

---

## 8. Git Commit Message

```
feat(db): M004 — ActivityEvent foundation (ActivityLog rename, Stage-1)

- Rename model ActivityLog → ActivityEvent; @@map("ActivityLog") keeps the
  physical table → pure ALTER migration (491 rows preserved, zero recreate)
- Add nullable fields: seq, kind, payload(Json), sessionId, source, receivedAt
- Keep deviceId→Device relation (ON DELETE SET NULL, explicit) + User/Device
  relation field names; legacy relation names preserve FK constraint names
- Safe indexes only: deviceId, timestamp, kind (no UNIQUE(deviceId,seq) yet)
- src/lib/db.ts: db.activityLog delegate alias → activityEvent (deprecated),
  so 10 routes + 3 seeds compile/run unchanged (no business-logic changes)
- activity-matrix: 1-line compile-compat fix (kind literal after spread) —
  required by "old queries must still compile"; behavior-preserving
- Verified: prisma validate/generate, migrate status clean, npm run build,
  tsc 0 new errors, runtime 18/18 endpoints + timeline kind check
- Backup: db/custom.db.bak-m004
```

---

## 9. Ready for Stage-2?

**Yes.** Stage-1 leaves the database in a clean, additive, fully-compatible state:
- `kind`, `seq`, `payload`, `sessionId`, `source`, `receivedAt` columns exist (nullable) — the ingest schema can be written against `db.activityEvent` today.
- All existing routes/seeds work unchanged (alias).
- Stage-2's `UNIQUE(deviceId, seq)` + required `deviceId` is **de-risked**: `deviceId` is already populated on all 491 rows; only `seq` (and optionally `kind`) need backfilling before tightening constraints.
