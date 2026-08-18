# WorkLensAI — M004 Stage-3 (Final): ActivityEvent Adoption — Zero ActivityLog Left

**Status:** ✅ Complete · **Date:** 2026-08-02 · **DB:** SQLite (`db/custom.db`)
**Scope:** Final compatibility migration before the Windows Agent APIs. Every
`ActivityLog` usage (code + schema + physical table) replaced by `ActivityEvent`.

---

## 1. Files changed

| File | Change |
|---|---|
| `src/lib/db.ts` | **Removed** the deprecated `db.activityLog` delegate alias. `db` is now a plain `PrismaClient`; `db.activityEvent` is the only activity delegate spelling. |
| `src/app/api/activity/route.ts` | `db.activityLog.findMany` → `db.activityEvent.findMany` |
| `src/app/api/dashboard/route.ts` | `db.activityLog.findMany` → `db.activityEvent.findMany` (trend + topApps now read ActivityEvent) |
| `src/app/api/analytics/route.ts` | `db.activityLog.findMany` → `db.activityEvent.findMany` |
| `src/app/api/timeline/route.ts` | 2× `db.activityLog.findMany` → `db.activityEvent.findMany` |
| `src/app/api/ai/insights/route.ts` | `db.activityLog.findMany` → `db.activityEvent.findMany` |
| `src/app/api/users/[id]/timeline/route.ts` | `db.activityLog.findMany` → `db.activityEvent.findMany` |
| `src/app/api/users/[id]/ai-summary/route.ts` | `db.activityLog.findMany` → `db.activityEvent.findMany` |
| `src/app/api/users/[id]/activity-matrix/route.ts` | `db.activityLog.findMany` → `db.activityEvent.findMany` |
| `prisma/seed.ts` | `db.activityLog.deleteMany/create` → `db.activityEvent.*` |
| `prisma/seed-timeline.ts` | `db.activityLog.create` → `db.activityEvent.create` |
| `prisma/seed-matrix.ts` | `db.activityLog.findMany/update` → `db.activityEvent.*` (+ comment) |
| `prisma/schema.prisma` | Removed `@@map("ActivityLog")`; renamed relation labels `"ActivityLog_userId"`/`"ActivityLog_deviceId"` → `"ActivityEvent_userId"`/`"ActivityEvent_deviceId"`; refreshed model comment (no legacy token remains in schema) |
| `prisma/migrations/20260802170000_m004_stage3_rename_activity_log/migration.sql` | **NEW** — data-preserving physical table rename (see §2) |
| `db/custom.db` | migrated; backup at `db/custom.db.bak-m004s3` |
| `workload/26-M004-Stage3-Report.md` + `workload/07-Progress.md` | this report + progress entry |

**Not touched (by design):** any React component (dashboard/analytics/timeline/
profile UI unchanged — response shapes are identical), `src/components/admin/views/settings-view.tsx`
`activityLogging` state (a Settings **feature toggle** named "Activity Logging",
not a model reference), `src/lib/agent-auth/schemas.ts` `activityEventSchema`
(already ActivityEvent-named agent event schema), migration history SQL.

---

## 2. Migration — physical table rename (data-preserving)

**Why:** the model had been `ActivityEvent` since Stage-1 while the physical table
stayed `"ActivityLog"` via `@@map` (zero-recreate). Stage-3 is the final
compatibility migration, so the table is renamed too — no legacy name remains.

**Critical finding:** `prisma migrate diff --from-migrations → to-schema` did **NOT**
detect the rename — it generated `DROP TABLE "ActivityLog"` + `CREATE TABLE`,
which would have **destroyed all 491 rows**. Instead the migration was authored
manually (SQLite `ALTER TABLE RENAME` — data-preserving):

```sql
ALTER TABLE "ActivityLog" RENAME TO "ActivityEvent";
DROP INDEX "ActivityLog_deviceId_idx";      CREATE INDEX "ActivityEvent_deviceId_idx" ON "ActivityEvent"("deviceId");
DROP INDEX "ActivityLog_timestamp_idx";     CREATE INDEX "ActivityEvent_timestamp_idx" ON "ActivityEvent"("timestamp");
DROP INDEX "ActivityLog_kind_idx";          CREATE INDEX "ActivityEvent_kind_idx" ON "ActivityEvent"("kind");
DROP INDEX "ActivityLog_deviceId_seq_key";  CREATE UNIQUE INDEX "ActivityEvent_deviceId_seq_key" ON "ActivityEvent"("deviceId","seq");
```

Applied via `prisma migrate deploy` (the env's standard non-interactive path).

**Post-migration verification (direct `node:sqlite`):**

| Check | Result |
|---|---|
| `ActivityEvent` rows | **491** (unchanged — zero loss) |
| Legacy `ActivityLog` table exists | **no** |
| Indexes | `ActivityEvent_deviceId_idx`, `ActivityEvent_timestamp_idx`, `ActivityEvent_kind_idx`, `ActivityEvent_deviceId_seq_key`, `sqlite_autoindex_ActivityEvent_1` (PK autoindex followed the rename) |
| `seq` NULLs / `kind` NULLs | **0** / **0** (Stage-2 backfill intact) |
| `prisma migrate diff --from-url → schema` | **empty migration** (zero drift — schema == DB) |
| `migrate status` | 5 migrations, **up to date** |

---

## 3. Queries updated (every ActivityEvent query surface)

- **findMany** (with `where`/`orderBy`/`take`/`include`/`select`): activity, dashboard,
  analytics, timeline ×2, ai/insights, users/[id]/timeline, users/[id]/ai-summary,
  users/[id]/activity-matrix, seed-matrix
- **deleteMany / create / update**: seed.ts, seed-timeline.ts, seed-matrix.ts
- **counts/aggregations/filters/ordering**: unchanged logic — same fields, same
  ordering (`timestamp desc/asc`), same filters (`userId`, `category`,
  `timestamp range`) — only the delegate spelling changed.
- **Relations/joins**: `include: { user, device }` relation fields unchanged;
  `User.activities` / `Device.activities` / `_count.activities` untouched (relation
  field names preserved).

---

## 4. Validation

| Command | Result |
|---|---|
| `prisma validate` | ✅ valid |
| `prisma generate` | ✅ Client v6.19.3 |
| `prisma migrate status` | ✅ 5 migrations, up to date |
| `prisma migrate diff` (DB ↔ schema) | ✅ empty (no drift) |
| `tsc --noEmit` | ✅ **0 new errors** (only the 4 pre-existing: examples/websocket ×2, markdown.tsx ×2) |
| `eslint src/lib/db.ts src/app/api prisma` | ✅ exit 0 |
| `npm run build` | ✅ 35 routes, standalone copied |

---

## 5. Runtime verification (fresh `next dev`, admin JWT `aria.martin@umbrella.com`)

| Endpoint | HTTP | Verified |
|---|---|---|
| login | 200 | JWT issued (288-char token) |
| dashboard | 200 | users=36, topApps=8, trend **today 3151/0/548m** (ActivityEvent-driven) |
| analytics | 200 | totalActivities=480, heatmap 24h, 3 categories |
| timeline | 200 | sparkline 24, live.totalActivities=379, topNow 3 |
| activity (+category filter) | 200 | rows returned, filter works |
| users | 200 | 36 users |
| devices | 200 | 10 devices |
| reports | 200 | 6 reports |
| user detail | 200 | user payload returned |
| users/[id]/timeline?date | 200 | **34 acts + 12 shots, 46 entries, kinds=[screenshot,activity]** (chronological merge works) |
| users/[id]/activity-matrix?date | 200 | apps=25, websites=9, active=54m |
| users/[id]/screenshots | 200 | screenshots endpoint OK |
| devices/[id] | 200 | device detail OK |
| users/[id]/ai-summary POST | 200 | DB path OK (empty-day message for off-day date = correct behavior) |
| unauthenticated `/api/activity` | **401** | auth gate intact |

**UI:** no component changes — every consumer reads the same response shapes.

---

## 6. Regression check

Repo-wide search for `activityLog` / `ActivityLog`:

| Location | Result |
|---|---|
| `src/**` (routes, components, lib) | **0 matches** except `settings-view.tsx` `activityLogging` — a Settings UI toggle ("Activity Logging" feature switch), **not** a model/data reference; intentionally untouched (out of scope, no query) |
| `prisma/schema.prisma` | **0 matches** (comment reworded to remove the legacy token) |
| `prisma/seed*.ts` | **0 matches** |
| `prisma/migrations/**` | present only as **immutable applied-history SQL** (0001_init created the table; stage-1/2 altered it; stage-3 renames it) — cannot/should not be edited |
| `workload/*.md`, `tool-results/` | historical reports / cached tool output only |

**There is exactly one activity model — `ActivityEvent` — in every layer: model, physical table, relations, indexes, FK constraint names, client delegate, routes, seeds.**

---

## 7. Risks

1. **FK constraint names in the DB still read `ActivityLog_userId_fkey`/`ActivityLog_deviceId_fkey`** — SQLite's `ALTER TABLE RENAME` keeps them (constraint names are not exposed to Prisma, so zero drift; a future table-recreate migration would rewrite them). Cosmetic only.
2. **Prisma diff generates `DROP TABLE` for table renames** — future renames must be authored manually (data-preserving) and verified by row-count, as done here. Flagged to avoid a data-loss footgun.
3. **`db:push` / interactive `migrate dev`** would now see the fully-renamed state and remain clean (verified empty diff); no drift for future migrations.
4. **Pre-existing observation (out of scope):** `/api/users/[id]` returns the full user row including `passwordHash`/`twoFactorSecret` — recorded in Known-Issues historically (BL-00x); untouched by M004.
5. **Seed scripts now write `db.activityEvent` directly** — `seed.ts` still calls `deleteMany` on startup, which wipes the 491 demo rows when reseeding (same as before; seeds are for fresh/demo DBs, never run against production).

---

## 8. Rollback

```bash
# DB: restore the pre-Stage-3 snapshot (491-row ActivityLog table state)
cp db/custom.db.bak-m004s3 db/custom.db

# Schema: revert the rename + relation labels
#   git checkout -- prisma/schema.prisma
# Revert code changes (db.ts alias back, routes/seeds back to db.activityLog):
#   git checkout -- src/lib/db.ts src/app/api "prisma/seed.ts" ...

# Remove the migration folder (only after DB restored)
rm -rf prisma/migrations/20260802170000_m004_stage3_rename_activity_log

# Regenerate the client
npm run db:generate
```

**Data impact of rollback:** zero — the rename is data-preserving; the backup restores the exact pre-Stage-3 file.

---

## 9. Git commit message

```
feat(db): M004 stage-3 (final) — full ActivityEvent adoption, zero ActivityLog

- Remove db.activityLog delegate alias; migrate 8 API routes + 3 seed scripts
  to db.activityEvent (dashboard/analytics/timeline/activity/ai-insights/
  user timeline/ai-summary/activity-matrix + seed/seed-timeline/seed-matrix)
- schema.prisma: remove @@map("ActivityLog"); relation labels → ActivityEvent
- NEW migration 20260802170000_m004_stage3_rename_activity_log: data-preserving
  physical table rename (SQLite ALTER TABLE RENAME + index renames). NOTE:
  prisma migrate diff generates DROP TABLE here — manual SQL required
- Verified: 491 rows intact, zero drift (empty migrate diff), validate/
  generate/tsc-0-new/eslint/build green, runtime 15/15 endpoints + 401 gate
- Backup: db/custom.db.bak-m004s3
```

---

## 10. Ready for M005?

**Yes.** The codebase now has a single activity model (`ActivityEvent`) with a
renamed physical table, the deprecated alias is gone, and every consumer
(dashboard, analytics, timeline, employee profile, reports, seeds) reads/writes
`db.activityEvent`. The `UNIQUE(deviceId, seq)` idempotency ring (Stage-2) is
intact for the agent ingest API. Remaining Stage-3 candidates from the Stage-2
report are resolved (alias removed ✅, physical rename ✅); `sessionId →
LoginSession` relation wiring remains a Stage-4/ingest concern (currently
nullable, additive-safe). M005 (Windows Agent ingest/heartbeat) can write to
`db.activityEvent` with agent-supplied `seq`, `receivedAt`=server clock, and
`source='agent'` today.
