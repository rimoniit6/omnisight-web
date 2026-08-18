# WorkLensAI — M003 Implementation Report (Installation & Device Identity)

> **File:** workload/21-M003-Implementation.md · **Date:** 2026-08-02 · **Status:** ✅ COMPLETE
> **Scope:** database foundation for Device Identity only — `Installation`, `AgentCredential`, `DeviceAssignment` + `Device` field extensions. **No agent APIs, no auth, no RBAC, no telemetry models.**

---

## 1. Summary

| Item | Result |
|---|---|
| New models | ✅ `Installation`, `AgentCredential`, `DeviceAssignment` |
| Modified models | ✅ `Device` (+8 fields, relation backlinks) · `User` (+`assignments` backlink) |
| Migration | ✅ `20260802143318_m003_identity` (applied via `prisma migrate dev`) |
| Raw SQL additions | ✅ partial unique index (ADR-029) + demo backfill |
| Data preserved | ✅ 36 users / 6 orgs / 10 devices / 491 activity / 146 screenshots intact |
| Data migration | ✅ default `Installation` row created; all 10 existing devices linked to it |
| `prisma validate` / `generate` | ✅ valid / Client v6.19.3 generated |
| `prisma migrate status` | ✅ "Database schema is up to date!" (2 migrations) |
| `npm run build` | ✅ Next.js production build passed (33 API routes, standalone copied) |
| Runtime | ✅ login 200 + JWT · `/api/devices` 200 (10 rows) · `/api/organizations` 200 (6 rows) · `/api/dashboard` 200 |

---

## 2. Schema Changes

### 2.1 New model `Installation` (design §5.1, ADR-011)

| Field | Type | Notes |
|---|---|---|
| `id` | String cuid @id | — |
| `name` | String | install name |
| `joinKeyHash` | String | SHA-256 of join key (never plaintext, contract E1) |
| `joinKeyHint` | String? | last 4 chars for admin "show once" |
| `minAgentVersion` | String @default("0.1.0") | enforced via 426 later |
| `settings` | String? (JSON) | install defaults |
| `createdAt` / `updatedAt` | DateTime | stateful → updatedAt (ADR-030) |
| `devices` | Device[] | backlink |

### 2.2 New model `AgentCredential` (design §5.3, ADR-011/027)

- `tokenHash` **unique** (the only server-side token representation)
- `prevTokenHash` (60 s rotation grace), `issuedAt`, `expiresAt` (default policy 180 d), `rotatedAt`, `revokedAt`, `revokeReason`
- `deviceId` FK → Device with **`onDelete: Cascade`** (token dies with device — ADR-027 device-scoped control rows)
- Index `@@index([deviceId, issuedAt])`

### 2.3 New model `DeviceAssignment` (design §5.4, ADR-024/027/029)

- `deviceId` FK → Device **`onDelete: Restrict`** (audit trail)
- `userId` FK → User **`onDelete: Restrict`**
- `assignedAt`, `revokedAt?` (null = current), `assignedBy?`
- Indexes `(deviceId, revokedAt)`, `(userId, revokedAt)`
- **Partial unique index** `UNIQUE(deviceId) WHERE revokedAt IS NULL` via **raw SQL** (ADR-029 — Prisma cannot express partial indexes; one active assignment per device)

### 2.4 Modified `Device` (design §5.2, ADR-011)

Added: `installationId` (FK → Installation, `onDelete: SetNull`), `hardwareFingerprint`, `lastHeartbeatAt`, `lastErrorAt`, `highWaterMark` Int @default(0), `capabilities` (JSON), `agentPlatform`, `agentArch`. Extended `status` value set (`Online, Offline, Pending, Active, Suspended, Retired`). Legacy `deviceId` column **deprecated but kept** (UI/API compat). Backlinks: `credentials AgentCredential[]`, `assignments DeviceAssignment[]`.

### 2.5 Modified `User`

Added `assignments DeviceAssignment[]` backlink only — no field changes (compat preserved).

---

## 3. Migration Summary

- **Folder:** `prisma/migrations/20260802143318_m003_identity/migration.sql`
- **Generated:** `prisma migrate dev --create-only --name m003_identity` (so raw SQL could be appended, per ADR-029)
- **Applied:** `prisma migrate dev`
- **What Prisma generated:** 3 CREATE TABLEs; `Device` table-recreate (`PRAGMA defer_foreign_keys` + copy + rename — this is how SQLite handles added columns) with all 10 device rows copied verbatim; 4 indexes.
- **Raw SQL appended (hand-written):**
  1. `CREATE UNIQUE INDEX "DeviceAssignment_deviceId_active_idx" ON "DeviceAssignment"("deviceId") WHERE "revokedAt" IS NULL;` — partial unique index (ADR-029)
  2. Demo backfill: INSERT default `Installation` (`inst_demo_default`, demo join key `WL-DEMO-JOINKEY-2026` hashed SHA-256) + `UPDATE Device SET installationId='inst_demo_default' WHERE installationId IS NULL` — links the existing 10 demo devices.

---

## 4. Data Migration Result

| Check | Before | After |
|---|---|---|
| User rows | 36 | **36** ✅ |
| Organization rows | 6 | **6** ✅ |
| Device rows | 10 | **10** ✅ (all copied through table-recreate) |
| Admin users | 1 | **1** ✅ |
| ActivityLog rows | 491 | **491** ✅ |
| Screenshot rows | 146 | **146** ✅ |
| Installation rows | 0 | **1** (`inst_demo_default`) |
| Devices linked to Installation | 0 | **10** ✅ |
| AgentCredential rows | — | 0 (empty, ready for agent enrollment) |
| DeviceAssignment rows | — | 0 (empty, ready for admin assignment) |
| New Device columns present | — | 8/8 ✅ |
| Partial unique index present | — | ✅ |
| Migrations applied | 1 | **2** ✅ |

---

## 5. Verification

| Command | Result |
|---|---|
| `prisma validate` | ✅ "The schema at prisma\schema.prisma is valid" |
| `npm run db:generate` | ✅ Generated Prisma Client (v6.19.3) |
| `prisma migrate dev` | ✅ Applied `20260802143318_m003_identity`; "database is now in sync" |
| `prisma migrate status` | ✅ 2 migrations; "Database schema is up to date!" |
| `npm run build` | ✅ Compiled; route table lists 33 API routes; "Copied standalone assets" |
| Runtime: login | ✅ HTTP 200, valid Admin JWT (288 chars) |
| Runtime: `/api/devices` (authed) | ✅ HTTP 200, **10 rows returned** |
| Runtime: `/api/organizations` (authed) | ✅ HTTP 200, **6 rows returned** |
| Runtime: `/api/dashboard` (authed) | ✅ HTTP 200 |

> Note: unauthenticated requests correctly return 401 (middleware requires JWT) — verified expected behavior.

---

## 6. Known Limitations

1. `AgentCredential` and `DeviceAssignment` tables are empty — they are filled by future agent-registration (E1/E2) and admin-assignment features, which are **out of scope** for M003.
2. Demo `Installation` uses a placeholder join key hash (`WL-DEMO-JOINKEY-2026`). Real join-key rotation is a future admin feature; the hash-at-rest pattern is already correct.
3. `Device.status` remains a free `String` (no Prisma enum — SQLite limitation, ADR-026); CHECK constraints were **not** added (optional per plan; value set documented in schema comment).
4. Legacy `Device.deviceId` column is deprecated but retained for backward compatibility; removal is a future (post-v1-safe) cleanup.
5. `installationId` is nullable by design (SQLite `ALTER`/FK constraints; also allows devices to be registered to an installation later).
6. **⚠ Raw partial index fragility (reviewer note):** `DeviceAssignment_deviceId_active_idx` is hand-written SQL that Prisma does not manage. **Any future migration that recreates the `DeviceAssignment` table (every SQLite column-add triggers a table-recreate) will silently drop this index.** Every future `DeviceAssignment` migration must re-apply the raw SQL partial index (ADR-029).
7. **Demo backfill is dev-DB-only (reviewer note):** the backfill runs inside the migration, so fresh clones running `migrate deploy` + `db seed` will create devices *after* the migration, leaving them with NULL `installationId`. Future seed files must create the default `Installation` and link devices (or agent registration E1 handles linking).
8. **Non-cuid demo id:** `inst_demo_default` is not a cuid — acceptable for demo, but any future input validation assuming cuid format must allow it or the demo row should be reseeded with a cuid.

## 6a. Partial Unique Index — Empirical Verification

| Step | Result |
|---|---|
| Insert 1st active assignment | ✅ OK |
| Insert 2nd active assignment (same device, not revoked) | ✅ **REJECTED** — `UNIQUE constraint failed: DeviceAssignment.deviceId` |
| Revoke 1st, insert new active assignment | ✅ OK (window semantics correct) |
| Cleanup test rows | ✅ 0 rows remaining (DB state restored) |

---

## 7. Rollback

```bash
# Restore DB to pre-M003 state (removes all 3 tables + Device changes + backfill)
cp db/custom.db.bak-m001 db/custom.db   # or the pre-M003 backup

# Revert schema manually (git checkout prisma/schema.prisma)
git checkout -- prisma/schema.prisma

# Optionally delete the migration folder (only if reverting schema too)
rm -rf prisma/migrations/20260802143318_m003_identity

# Regenerate client
npm run db:generate
```

No destructive SQL ran against business data — the migration was additive (new tables) + non-destructive (table-recreate preserves rows).

---

## 8. Next Implementation (M004 — Telemetry core)

- Rename `ActivityLog` → `ActivityEvent` (+ `kind`, `seq`, `payload`, `sessionId`, `source`; `deviceId` required; `UNIQUE(deviceId, seq)` idempotency ring)
- Extend `LoginSession` (+ `deviceId`, `seq`, `kind`)
- ⚠ HIGHEST RISK migration — must ship together with updated `timeline`/`activity`/`analytics`/`users/[id]` API routes in the same change-set.
- M004 is **not** started; M003 was this task's only scope.
