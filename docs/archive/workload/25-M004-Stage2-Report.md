# M004 Stage-2 — ActivityEvent Telemetry Identity (Backfill + Idempotency Ring)

**Status:** ✅ Complete · **Date:** 2026-08-02 · **DB:** SQLite (`db/custom.db`)
**Scope:** Database-only. No API route, no UI, no analytics algorithm, no business logic modified.

---

## 1. Files changed

| File | Change |
|---|---|
| `prisma/schema.prisma` | Added `@@unique([deviceId, seq])` to `ActivityEvent`; refreshed Stage-2 field comments (comment-only — no data-model change) |
| `prisma/migrations/20260802160000_m004_stage2_telemetry_identity/migration.sql` | **NEW** — backfill `seq` (per-device ROW_NUMBER), map legacy `type` → `kind`, set `source='legacy'`, `receivedAt=timestamp`, then `CREATE UNIQUE INDEX "ActivityLog_deviceId_seq_key"` |
| `db/custom.db` | migrated; backup at `db/custom.db.bak-m004s2` (pre-Stage-2) |
| `workload/25-M004-Stage2-Report.md` + `workload/07-Progress.md` | this report + progress entry |

**No other files touched.** Routes/seeds/components untouched — `db.activityLog` alias (Stage-1) still carries all old queries.

---

## 2. Migration summary

`20260802160000_m004_stage2_telemetry_identity` — applied via `prisma migrate deploy` (the environment is non-interactive, so `prisma migrate dev` refuses to run; `migrate diff` confirmed the only schema delta is the unique index, then the backfill SQL was authored manually ahead of the index).

Order of operations inside the single migration (atomic — any failure rolls back the whole migration):

1. **`seq` backfill** — `ROW_NUMBER() OVER (PARTITION BY "deviceId" ORDER BY "timestamp", rowid)` via correlated subquery; guarded by `WHERE seq IS NULL` (idempotent, fresh-DB safe: no-op on empty table).
2. **`kind` backfill** — normalized from legacy `type`:
   | Legacy `type` | `kind` | Rows |
   |---|---|---|
   | `App` | `app` | 381 |
   | `Website` | `website` | 110 |
   | `Idle` | `idle` | 0 |
   | `Screenshot` | `system` | 0 |
   | `System` | `system` | 0 |
   | *(anything else)* | `unknown` | 0 |
3. **`source`** — `'legacy'` for all migrated rows.
4. **`receivedAt`** — copied from `timestamp` (closest available approximation of server ingest time for legacy rows).
5. **`payload`** — left `NULL`. **No fabricated JSON.**
6. **`CREATE UNIQUE INDEX "ActivityLog_deviceId_seq_key"`** — created **after** the backfill so any duplicate `(deviceId, seq)` would fail loudly and abort (rollback) the migration. Zero violations.

---

## 3. Backfill summary

Verified post-migration (direct SQLite query):

| Check | Result |
|---|---|
| Total rows | **491** (unchanged — no loss, no truncation) |
| `deviceId` NULL | **0** (all reference a valid Device; 0 orphans — verified in Stage-1, no device rows deleted since) |
| `seq` NULL | **0** |
| `kind` NULL | **0** — `app` 381 / `website` 110 |
| `source` ≠ `legacy` | **0** |
| `receivedAt` NULL / ≠ `timestamp` | **0** / **0** |
| `payload` non-NULL | **0** |
| seq strictly `1..N` per device | **PASS** (monotonic per device, no gaps/dups) |
| `UNIQUE(deviceId, seq)` violations | **0** |
| Index present | `ActivityLog_deviceId_seq_key` + Stage-1 indexes intact |
| Migrations applied | 0001_init, m003_identity, m004_activity_event_foundation, **m004_stage2_telemetry_identity** |

---

## 4. Verification

- `prisma validate` ✅ · `prisma generate` ✅ · `migrate status` **up to date** (4 migrations) ✅
- `npm run build` ✅ (standalone copied) · `tsc` **0 new errors** (only the 4 pre-existing in untouched example/UI files) ✅
- **Runtime battery 21/21** (fresh `next dev`, admin JWT):
  - login · dashboard (`kpis`, `trend` from activityLog, `topApps` from activityLog) · activity · analytics (`totalActivities=480`) · users · devices · timeline · `devices/[id]` (activities count) · `users/[id]/timeline` (stats) · `activity-matrix` · unauthenticated → 401
- `UNIQUE(deviceId, seq)` zero violations — verified above.

---

## 5. Risks

1. **`deviceId` remains nullable — intentional.** The Devices UI hard-deletes devices (`devices-view.tsx` → `api/devices/[id]` DELETE → `db.device.delete`). The FK is `ON DELETE SET NULL`, so a `NOT NULL deviceId` would force `RESTRICT` and **break device deletion for every device with events**. Task escape hatch applied: all rows are backfilled, but the constraint change would regress a live feature — documented rather than forced.
2. **`seq` ordering semantics** — assigned by `timestamp, rowid` ("first-seen" order), not true agent-emitted order. Fine for legacy rows; **Stage-3 ingest must use agent-supplied `seq`** per workload/17 contract (monotonic per device).
3. **`Screenshot → system` mapping is a latent branch** — 0 such legacy rows exist today; if screenshots-as-activity ever appear, reconsider `unknown`. No current data affected.
4. **Don't run `prisma db seed`** — `seed.ts:12` calls `db.activityLog.deleteMany()`, wiping the 491 rows (seeds also don't set `seq`, which is fine for fresh seeds).
5. **Manual migration workflow** — because `migrate dev` is blocked non-interactively, the migration was authored via `migrate diff` + manual SQL and applied via `migrate deploy`. Fresh-DB replay is safe (backfill no-ops on empty tables). Future devs should follow the same path in this environment.

---

## 6. Rollback

```bash
# Restore pre-Stage-2 database snapshot
cp db/custom.db.bak-m004s2 db/custom.db

# Remove the migration folder (only after DB restored)
rm -rf prisma/migrations/20260802160000_m004_stage2_telemetry_identity

# Revert the schema line
#   prisma/schema.prisma: remove  @@unique([deviceId, seq])
```

(`prisma migrate resolve --rolled-back` is not needed for a manual-apply workflow; restoring the snapshot + deleting the folder is the clean revert here. A safer non-destructive alternative: keep the DB, drop the index via a new migration.)

---

## 7. Git commit message

```
feat(db): M004 stage-2 telemetry identity — backfill + UNIQUE(deviceId,seq)

- ActivityEvent: @@unique([deviceId, seq]) idempotency ring (per design §5.5)
- migration 20260802160000_m004_stage2_telemetry_identity:
  - seq = ROW_NUMBER per device (monotonic 1..N, verified)
  - kind normalized from legacy type (App→app 381, Website→website 110)
  - source='legacy', receivedAt=timestamp, payload stays NULL
  - unique index created AFTER backfill; 0 violations, aborts on dupes
- deviceId stays nullable: Devices UI hard-deletes devices (SET NULL FK),
  NOT NULL would regress device deletion (documented escape hatch)
- verified: validate/generate/migrate-status/build/tsc 0-new/runtime 21/21
- backup: db/custom.db.bak-m004s2
```

---

## 8. Ready for M004 Stage-3?

**Yes.** The idempotency ring `UNIQUE(deviceId, seq)` is live and verified; all 491 legacy rows are backfilled (deviceId 100%, seq monotonic, kind/source/receivedAt populated, payload NULL). Stage-3 (agent ingest API) can now write to `db.activityEvent` with:
- `deviceId` + agent-supplied `seq` → idempotent upsert/insert (violations rejected by the unique index)
- `kind` `app|website|idle|system` (additive kinds allowed without schema change)
- `receivedAt` = server clock at ingest (authoritative, distinct from agent `timestamp`)
- `source` = `'agent'`

Remaining Stage-3 candidates: wire `sessionId` → `LoginSession` relation (currently nullable, comment says Stage-3), decide on the physical `ActivityLog` → `ActivityEvent` table rename (currently `@@map("ActivityLog")`, deliberately deferred), and migrate routes/seeds off the deprecated `db.activityLog` alias.
