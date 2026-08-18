# WorkLensAI — Prisma Schema Migration Plan

> **File:** workload/19-Prisma-Migration-Plan.md · **Version:** 1.0 · **Status:** Approved for implementation planning
> **Authors:** Database Migration Engineering (2026-08-02)
> **Reads:** 18-Telemetry-Database-Design.md (final model), 17-Agent-API-Contract.md (E1–E16), 09-Architecture-Decisions.md (ADR-003 SQLite→Postgres, ADR-025 baseline migration, ADR-018…024), current `prisma/schema.prisma` (19 models)
> **Plan goal:** a safe, reviewable, reversible path from the current 19-model `db push` schema to the final telemetry schema — before v1.0 freezes compatibility.

---

## 0. Executive Summary

- **19 existing models classified** → 10 reuse unchanged, 6 modify, 1 rename, 0 replace, 0 delete, 1 deprecated column. **17 new models** classified by phase (1 = immediate, 2 = Agent MVP, 3 = AI, 4 = enterprise).
- **10-migration sequence (M001–M010)**, each isolated by domain + risk so a failure is contained and reviewable. M001 captures the current schema as the Prisma Migrate baseline (replaces `db push`).
- **Pre-v1, zero production data (demo seed only)** → breaking changes are free now (ADR-025). Options: apply as **10 separate migrations** (recommended — exercises the pipeline, reviewable diffs) or **squash into one `0001_telemetry_v1` baseline** (fastest). Both documented.
- **Critical technical findings:** Prisma does **not** support enums on SQLite → all enums remain `String` + a TypeScript constants module (not Prisma `enum`). **Partial unique index** (`DeviceAssignment` active-window) is not expressible in Prisma → raw-SQL step. **FK cascade policy must be explicit** — telemetry links are `SET NULL`/`RESTRICT`, never cascade (screenshots would vanish when their upload ticket is GC'd).
- **Highest risk:** M004 (ActivityLog→ActivityEvent rename + required `deviceId` + unique `(deviceId, seq)`). **Lowest risk:** M009 (AuditLog — pure additive).
- **Verdict: READY to implement** after two prep steps (backup DB, adopt `prisma migrate dev`).

---

## 1. Current Schema Review (all 19 models, source-verified)

| # | Model | Classification | Notes |
|---|---|---|---|
| 1 | `Organization` | **Reuse unchanged** | `slug` unique kept; no agent impact |
| 2 | `User` | **Modify** | `deviceId` stays as the *current-assignment cursor* (ADR-024); scores stay as cached latest values (superseded by `UserDailySummary`); add explicit `onDelete` semantics |
| 3 | `Device` | **Modify** | +`installationId`, +`hardwareFingerprint`, +`lastHeartbeatAt`, +`lastErrorAt`, +`highWaterMark`, +`capabilities`, +`agentPlatform`/`agentArch`, `status` enum values extended (Pending/Active/Suspended/Retired); **deprecate legacy `deviceId` column** (duplicates `id`) |
| 4 | `ActivityLog` | **Rename → `ActivityEvent`** + modify | +`kind`, +`seq`, +`payload`, +`sessionId`, +`source`; `deviceId` required; `type` replaced by `kind`; add `UNIQUE(deviceId, seq)` |
| 5 | `Screenshot` | **Modify** | +`sha256`, +`storagePath`, +`size`, +`format`, +`width`/`height`, +`monitorId`, +`uploadId`, +`privacyMode`, +`dedupRef`, +`sessionId`; `deviceId` required |
| 6 | `LoginSession` | **Modify** | +`deviceId`, +`seq`, +`kind` |
| 7 | `FileActivity` | **Reuse unchanged** | Phase-3 agent kinds may write it or use `ActivityEvent` kinds (ADR-024) |
| 8 | `MouseStat` | **Reuse unchanged** | — |
| 9 | `KeyboardStat` | **Reuse unchanged** | — |
| 10 | `ClipboardEvent` | **Reuse unchanged** | — |
| 11 | `UsbActivity` | **Reuse unchanged** | — |
| 12 | `NetworkActivity` | **Reuse unchanged** | — |
| 13 | `Alert` | **Modify (minor)** | add `updatedAt` (state mutates: Open→Acknowledged→Resolved); no other change |
| 14 | `AIProvider` | **Reuse unchanged (app-layer)** | schema unchanged; `apiKey` encryption is an app-layer concern (ADR-004), not schema |
| 15 | `SecurityPolicy` | **Reuse unchanged** | DLP engine is Phase 3, schema already fits |
| 16 | `SecurityEvent` | **Modify (minor)** | `policyId` is a dangling string — add the relation field to `SecurityPolicy` OR document as denormalized; add `updatedAt` |
| 17 | `License` | **Reuse unchanged** | offline validation is app-layer (ADR-009) |
| 18 | `Plugin` | **Reuse unchanged** | marketplace runtime is Phase 4 |
| 19 | `Report` | **Reuse unchanged** | `createdBy` stays a string (minor debt, see §7) |

**New model phases** (per task definition: 1 = required immediately, 2 = Agent MVP, 3 = AI, 4 = enterprise):

| Phase | New models | Rationale |
|---|---|---|
| **Phase 1 (immediate)** | `Role`, `Permission`, `UserRole` (RBAC — BL-003 P0) · `Installation` · `AgentCredential` · `DeviceAssignment` | Security (RBAC) and identity/fleet foundation unblock both Sprint-01 hardening and agent register/activate/heartbeat (E1–E3). None of the agent data plane can exist without these. |
| **Phase 2 (Agent MVP)** | `UploadTicket` · `AgentCommand` · `AgentLog` · `AgentError` · `AgentNonce` (in-memory at MVP, table for Postgres) · `AgentUpdate` · `DeviceUpdateHistory` · `AgentPolicy` · `PolicySnapshot` · `DeviceHealthSnapshot` · `UserDailySummary` · `AuditLog` | Everything the agent needs to send data, receive commands/updates/policy, report health, and that analytics/audit require once real telemetry flows. |
| **Phase 3 (AI)** | `AISummary` · `AIConversation` · `AIMessage` | AI persistence (ADR-022) — none of the agent MVP depends on it. |
| **Phase 4 (enterprise)** | *(future only)* `Embedding` (pgvector), `ApiKey` (scoped keys), video/mobile metadata | Not in this design; documented for later additive migrations. |

---

## 2. Migration Sequence (M001–M010)

> **Why isolated migrations (not one blob):** (1) each migration is one domain with one risk class, so a failure is diagnosable and reversible in isolation; (2) Prisma generates a migration per schema diff — applying schema changes in logical steps produces a reviewable history; (3) it exercises the migration pipeline early (ADR-025 requires it anyway for Postgres); (4) squashing is trivial pre-v1 if the team prefers a single baseline (see §2.11).

---

### M001 — Baseline capture (adopt Prisma Migrate)

- **Purpose:** snapshot the **current 19-model schema** as the first migration; establish `prisma/migrations/` + `migration_lock.toml`; switch the workflow from `db push` to `migrate dev`/`migrate deploy`. No schema change — this is the checkpoint.
- **Models affected:** all 19 (as-is).
- **Risk:** LOW — schema identical; only process changes.
- **Rollback:** delete `prisma/migrations/` and revert to `db push`; restore `db/custom.db` backup.
- **Verification:** `prisma migrate status` = clean; `prisma migrate dev --name init` produces `0001_init`; app boots; login works (36 users / 6 orgs / 10 devices intact).

### M002 — RBAC (security, P0 BL-003)

- **Purpose:** add role-based access control tables so `requireRole('Admin')` can be enforced in routes (audit-verified: 0/33 routes enforce RBAC today).
- **Models affected:** +`Role`, +`Permission`, +`UserRole` (join). `User.role` stays as the denormalized quick-check column.
- **Risk:** LOW — pure additive; no existing data touched.
- **Rollback:** drop the 3 tables.
- **Verification:** seed 3 roles (Admin/Manager/Employee) + a few permissions; a route returning `user.role` still works.

### M003 — Identity & fleet foundation (E1–E3)

- **Purpose:** `Installation` + `AgentCredential` + `DeviceAssignment` and `Device` extensions — the identity model agents register/authenticate against (ADR-011, contract §1).
- **Models affected:** +`Installation`, +`AgentCredential`, +`DeviceAssignment`; modify `Device` (add columns; extend `status` values).
- **Risk:** MEDIUM — `Device` is a hot table used by the existing Devices UI; `installationId` FK must be nullable (SQLite `ALTER ADD COLUMN` + FK requires NULL) and backfilled for seeded devices.
- **Rollback:** drop new tables; revert `Device` column additions (Prisma reverses cleanly with `migrate rollback` in dev, or restore backup).
- **Verification:** `Installation` row exists; a device can be created; DeviceAssignment active-window partial unique index exists (raw SQL, ADR-029); Devices UI still renders.

### M004 — Telemetry core: ActivityLog → ActivityEvent (⚠ HIGHEST RISK)

- **Purpose:** the breaking rename + evolution per ADR-018: `kind`/`seq`/`payload`/`sessionId`/`source`, `deviceId` required, `UNIQUE(deviceId, seq)` idempotency ring, `type` column removed. Also extends `LoginSession` (+`deviceId`, `seq`, `kind`).
- **Models affected:** rename+modify `ActivityLog`→`ActivityEvent`; modify `LoginSession`.
- **Risk:** HIGH — (a) Prisma recreates the table for the rename (SQLite has no simple rename-with-alter); (b) making `deviceId` required fails if seeded rows have NULL → **must backfill or reseed before migrating** (zero prod data → reseed is safe, but do it deliberately); (c) `UNIQUE(deviceId, seq)` requires non-null both columns; (d) `timeline`/`activity`/`analytics` API routes reference `ActivityLog` — **code must be updated in the same change-set** (Prisma generate + route updates).
- **Rollback:** restore DB backup + revert schema (dev); on a live system this would be an expand-contract, but pre-v1 it's a clean revert.
- **Verification:** `prisma validate` + `prisma generate` pass; timeline/activity/analytics endpoints return data from the renamed table; duplicate `(deviceId, seq)` insert is rejected; `type` gone, `kind` present.

### M005 — Media pipeline: screenshots + upload tickets (E6, ADR-019)

- **Purpose:** `Screenshot` storage fields (`sha256`, `storagePath`, `size`, `format`, dims, `monitorId`, `uploadId`, `privacyMode`, `dedupRef`, `sessionId`) + `UploadTicket` (chunk bitmap). Enables real image storage (today "no image bytes").
- **Models affected:** modify `Screenshot`; +`UploadTicket`.
- **Risk:** MEDIUM — `Screenshot` FK to `UploadTicket` must be **`SET NULL` on ticket delete** (tickets GC in 24 h, screenshots live 365 d — a cascade would wipe screenshots, the exact bug this plan prevents); `dedupRef` self-FK `SET NULL`.
- **Rollback:** drop `UploadTicket`; revert `Screenshot` columns.
- **Verification:** upload-ticket lifecycle works (initiate → chunk → complete); duplicate `sha256` returns `duplicate: true`; GC of an expired ticket does **not** delete its screenshot row.

### M006 — Command & diagnostics plane (E7–E12, E15)

- **Purpose:** `AgentCommand` (queue + result), `AgentLog`, `AgentError`, `AgentNonce` (replay cache), `AgentUpdate` (release catalog), `DeviceUpdateHistory` (apply log). The control-plane the agent polls on heartbeat.
- **Models affected:** all new (+6 tables).
- **Risk:** LOW — pure additive; no existing table touched. `AgentNonce` is in-memory at MVP (SQLite single instance) — table created for Postgres parity but unused until Phase 3.
- **Rollback:** drop 6 tables.
- **Verification:** command lifecycle (pending→delivered→acked); log/error upload endpoints persist rows; `AgentUpdate` manifest fetch works.

### M007 — Policy & health (E4, E7)

- **Purpose:** `AgentPolicy` (active row) + `PolicySnapshot` (version history, ADR-023) + `DeviceHealthSnapshot` (sampled fleet health, ADR-021).
- **Models affected:** +3 tables.
- **Risk:** LOW — additive; policy payload is JSON text (no SQLite JSON queries needed).
- **Rollback:** drop 3 tables.
- **Verification:** policy version bump appends a snapshot; active row is single; health snapshot sampling cadence respected.

### M008 — Analytics rollup (dashboards/AI backbone, ADR-020)

- **Purpose:** `UserDailySummary` per-user-per-day rollup — dashboards, scores, heatmaps, and AI read this, never raw events.
- **Models affected:** +1 table.
- **Risk:** MEDIUM — `UNIQUE(userId, date)`; `date` is **UTC day** (users have timezones — document the clamping rule to avoid midnight-boundary double-counting); rollup job depends on this table existing before dashboards switch over.
- **Rollback:** drop table; dashboards fall back to raw events (temporarily slower).
- **Verification:** rollup job produces rows; `UNIQUE(userId, date)` upsert is idempotent; dashboard KPI reads from rollup.

### M009 — Audit log (compliance, BL-205)

- **Purpose:** append-only `AuditLog` (actor, action, entity, details, IP, UA, timestamp). Fixes "Audit log (real): 0%" verified gap.
- **Models affected:** +1 table.
- **Risk:** LOW — pure additive; append-only (no updates/deletes in app code).
- **Rollback:** drop table.
- **Verification:** login/admin actions write rows; no UPDATE/DELETE paths exist in code.

### M010 — AI persistence (Phase 3, ADR-022)

- **Purpose:** `AISummary` (deterministic key `UNIQUE(userId, scope, periodStart)`), `AIConversation` + `AIMessage` (chat history). Fixes "AI not persisted" verified gap.
- **Models affected:** +3 tables.
- **Risk:** LOW — additive; no dependency on agent MVP.
- **Rollback:** drop 3 tables.
- **Verification:** summary regeneration on miss; chat history round-trips; deterministic-key uniqueness holds.

---

## 2.11 Squash option (ADR-025)

Because **zero production data exists**, M002–M010 may be squashed into a single `0001_telemetry_v1` baseline migration at delivery. **Recommendation: keep the 10-step sequence during development** (reviewability + pipeline training), and only squash for the final release artifact if the reviewer prefers one file. Never squash on a database that contains buyer data.

---

## 3. Foreign Key & Referential-Action Audit

**Policy: telemetry and audit links are `RESTRICT`/`SET NULL` — never `CASCADE`.** The only `CASCADE` allowed is where a child is meaningless without its parent (control-plane rows bound to a device).

| FK | On device/user delete | Why |
|---|---|---|
| `ActivityEvent.deviceId` / `userId` | `RESTRICT` (soft status instead) | History must survive deactivation (USER-002: "preserve historical activity") |
| `ActivityEvent.sessionId` → `LoginSession` | `SET NULL` | Events outlive a closed session row |
| `Screenshot.uploadId` → `UploadTicket` | **`SET NULL`** | Ticket GC in 24 h; screenshot lives 365 d |
| `Screenshot.dedupRef` → `Screenshot` (self) | `SET NULL` | Retention may purge the twin first |
| `Screenshot.deviceId` / `userId` | `RESTRICT` | same as events |
| `DeviceAssignment.deviceId` / `userId` | `RESTRICT` | audit trail of who used what when |
| `AgentCredential.deviceId` | `CASCADE` | token is meaningless without the device |
| `AgentCommand` / `AgentLog` / `AgentError` / `DeviceHealthSnapshot` / `DeviceUpdateHistory` .deviceId | `CASCADE` | control/diagnostic rows are device-scoped and disposable |
| `LoginSession.deviceId` | `RESTRICT` | sessions referenced by events |
| `UserRole.roleId` / `userId` | `CASCADE` | join table |
| `SecurityEvent.policyId` → `SecurityPolicy` | `SET NULL` | keep event if policy deleted |

**Current-schema debt:** no model declares explicit `onDelete` (Prisma defaults: `Restrict` required / `SetNull` optional). The final schema **must** make every `onDelete` explicit so behavior is not accidental.

---

## 4. Unique Constraint & Index Plan

| Constraint / index | Notes |
|---|---|
| `UNIQUE(ActivityEvent.deviceId, seq)` | The idempotency ring (contract §6). Both columns non-null after M004. |
| `UNIQUE(Screenshot.sha256)` | Global content dedup within retention; privacy-mode rows still carry sha256. |
| `UNIQUE(DeviceAssignment.deviceId, revokedAt)` **partial** `WHERE revokedAt IS NULL` | One active assignment per device. **Prisma cannot express partial unique indexes → raw-SQL step** (SQLite 3.8+ and Postgres both support partial indexes). ADR-029. |
| `UNIQUE(AgentUpdate.version, channel)` | Release catalog key. |
| `UNIQUE(PolicySnapshot.policyVersion)` | Version history key. |
| `UNIQUE(UserDailySummary.userId, date)` | UTC-day clamp rule documented. |
| `UNIQUE(AISummary.userId, scope, periodStart)` | Deterministic regeneration. |
| `UNIQUE(User.email)`, `UNIQUE(Organization.slug)`, `UNIQUE(License.key)`, `UNIQUE(Plugin.slug)` | existing — unchanged. |
| Index `ActivityEvent(userId, timestamp DESC)` | timeline / heatmap. |
| Index `ActivityEvent(deviceId, timestamp DESC)` | per-device reads. |
| Index `ActivityEvent(domain)` | website ranking. |
| Index `ActivityEvent(category, timestamp)` | productivity queries. |
| Index `Screenshot(userId, timestamp DESC)`, `(deviceId, timestamp DESC)`, `(flagged)`, `(sensitiveDataDetected)` | viewer + search + DLP. |
| Index `AgentCommand(deviceId, status)`, `AgentLog(deviceId, ts)`, `AgentError(deviceId, ts)`, `DeviceHealthSnapshot(deviceId, ts)`, `AuditLog(entity, entityId)`, `AuditLog(timestamp DESC)`, `UserDailySummary(date)`, `AIMessage(conversationId, createdAt)` | as per 18-Telemetry-Database-Design §5. |

**SQLite limitation:** Prisma creates indexes from `@@index`/`@@unique` — all fine. Only partial-unique and (later) partitioned tables need raw SQL.

---

## 5. Enum Review

**Finding:** the current schema has **zero Prisma `enum` blocks** — every enumerated value is a `String` (status, role, type, severity, category, action, plan…). Value integrity relies on the app (audit-verified: only 1/33 routes validates).

**Decision (ADR-026):** keep all enums as `String`, and do **not** introduce Prisma `enum` types.

- **Why:** Prisma does **not** support `enum` on the SQLite connector (enums are Postgres/MySQL/Mongo features). Introducing them would break the SQLite MVP (ADR-003) or create a divergent schema between engines.
- **Implementation:** single TypeScript **constants module** (`src/lib/enums.ts`) as the source of truth (mirrors the 22-category matrix already in `seed-matrix.ts`); option to add **raw-SQL CHECK constraints** for critical sets (`kind`, `category`, `severity`, `role`, device `status`) in M003/M004 for DB-level integrity without Prisma enums.
- **Future-proofing:** when PostgreSQL arrives (Phase 3), either keep the strings (parity, recommended) or add native enums via a later additive migration — never block the provider switch on enum conversion.

**Merge/split suggestions:**
- `Device.status` should split semantics: lifecycle (`Pending/Active/Suspended/Retired`) vs connectivity (`Online/Offline`) — keep as one `status` string for UI parity, but store connectivity in `lastHeartbeatAt` (derived). Documented, not split (avoids UI churn).
- `ActivityLog.type` (App/Website/Idle/Screenshot/System) is **replaced by `ActivityEvent.kind`** (app/website/idle/system + additive) — the only real enum "replacement" in this plan.
- `Alert.type`, `SecurityPolicy.type`, `Report.type` stay as strings with distinct value sets (no merge — different domains).

---

## 6. Naming Consistency Review

| Aspect | Current state | Verdict |
|---|---|---|
| Table names | PascalCase singular (`Organization`, `ActivityLog`, `UsbActivity`) | Consistent. `ActivityLog` → `ActivityEvent` (rename). `UsbActivity`/`NetworkActivity` inconsistent abbreviation — leave (no churn). |
| Field names | camelCase everywhere | Consistent. |
| IDs | `id` `@default(cuid())` on all | Consistent. **`Device.deviceId` is a legacy duplicate** → deprecated (M003). |
| createdAt | present on all models | Consistent. |
| updatedAt | present on `Organization`, `User`, `Device`, `AIProvider`, `SecurityPolicy`, `License`, `Plugin`, `Report` — **missing on `Alert`, `SecurityEvent`, all telemetry tables** | Event/telemetry tables are immutable → `updatedAt` correctly absent. **Add to stateful tables**: `Alert`, `SecurityEvent` (status mutates) + new `UploadTicket`, `AgentCommand`, `AgentCredential`, `DeviceAssignment`, `AgentPolicy` (ADR-030). |
| deletedAt | **absent on all** — soft-delete via `status` (`User.status`, `Device.status`) | Consistent. Keep status-based soft-delete; no `deletedAt` needed. |
| timestamp vs createdAt | event tables carry both `timestamp` (event time) + `createdAt` (ingest) | Keep for `ActivityEvent`/`Screenshot` — server time authoritative (contract §3). |
| Relation names | `User.activities`, `Device.screenshots`… | Consistent; review after rename (`activities` → `activityEvents` if desired — code churn, low value, optional). |

---

## 7. Technical Debt in the Current Schema

1. **All-string enums, zero DB-level integrity** — mitigated by constants module + optional CHECK (ADR-026).
2. **`Device.deviceId` duplicates `Device.id`** — deprecated in M003.
3. **`ActivityLog` has no `seq`** → no idempotent ingest possible — fixed by M004.
4. **`Screenshot` cannot store real images** (no `sha256`/`storagePath`/`size`) — verified gap ("we don't store actual image bytes") — fixed by M005.
5. **`LoginSession` has no `deviceId`** → sessions unattributable to machines — fixed by M004.
6. **No `AuditLog` table** — compliance gap (BL-205) — fixed by M009.
7. **No explicit `onDelete` anywhere** — accidental-cascade risk; final schema makes all referential actions explicit (§3).
8. **`SecurityEvent.policyId` is a dangling string** — add relation or document as denormalized (M001/M002 window).
9. **`User` score columns** (`productivity`, `activityScore`, `focusScore`, `riskScore`, `burnoutScore`) denormalized and stale-prone — superseded by `UserDailySummary` (M008); keep as cached "latest" values, never as a source of truth.
10. **`User.deviceId` single-cursor with no history** — fixed by `DeviceAssignment` (M003).
11. **`Report.createdBy` is a string, not FK** — minor; leave (no relation table for "admins" exists pre-RBAC).
12. **No migration history at all** (`db push` workflow) — fixed by M001.
13. **`AIProvider.apiKey` plaintext** — schema OK; encryption is app-layer (ADR-004), out of scope for this plan.

---

## 8. SQLite Limitations (must-know for implementer)

- **No Prisma enums** on SQLite → strings + constants (ADR-026).
- **`ALTER TABLE` is limited** → Prisma uses table-recreate for rename/required-column/type changes (fine pre-v1; lock the DB during migrate on live systems, document for buyers).
- **Adding a NOT NULL column** requires a default; **adding an FK column** must be nullable first (backfill, then tighten) — affects `Device.installationId` (M003) and `ActivityEvent.deviceId` (M004).
- **Partial unique indexes** not expressible in Prisma schema → raw SQL (ADR-029).
- **JSON is TEXT** — no JSON querying through Prisma; `payload`/`rules`/`details` must be read/written whole.
- **Single-writer** — batch ingest serializes; WAL mode + `busy_timeout` (already planned, 18-Telemetry §15).
- **`PRAGMA foreign_keys = ON`** per connection — Prisma enables by default on recent versions; verify in tests.

## 9. Future PostgreSQL Considerations

- **Same Prisma schema**; provider switch via `DATABASE_URL` only (ADR-003).
- **Native enums available** but keep strings for parity (ADR-026) unless a strong reason appears.
- **Monthly partitioning** of `ActivityEvent`/`Screenshot` (raw SQL; Prisma has no partition support) — retention becomes `DROP PARTITION`.
- **`ON CONFLICT (deviceId, seq) DO NOTHING`** replaces `skipDuplicates` at scale.
- **Partial unique index** for `DeviceAssignment` is natively supported (same raw SQL).
- **`pgvector`** `Embedding` table (Phase 3, M-future) + GIN on `payload` if payload queries ever appear (by design they don't).
- **Migration replay:** same history via `migrate deploy`; `prisma migrate diff --from-schema-datasource` to sanity-check parity.

---

## 10. Risk Assessment (consolidated)

| Migration | Risk | Primary risk factor |
|---|---|---|
| M001 Baseline | LOW | process only |
| M002 RBAC | LOW | additive |
| M003 Identity/fleet | MEDIUM | `Device` hot table + nullable FK backfill |
| **M004 Telemetry core** | **HIGH** | rename + required `deviceId` + unique constraint + **API routes must change in the same change-set** |
| M005 Media | MEDIUM | FK direction traps (`uploadId`, `dedupRef` must be SET NULL) |
| M006 Command/diagnostics | LOW | additive |
| M007 Policy/health | LOW | additive |
| M008 Rollup | MEDIUM | UTC-day uniqueness + job dependency |
| M009 Audit | LOW | additive |
| M010 AI | LOW | additive |

**Cross-cutting risks:** (1) route/code coupling — M004 must ship with updated `timeline`/`activity`/`analytics`/`users/[id]` routes; (2) seed data nulls blocking required columns — reseed deliberately before M004; (3) forgetting raw-SQL steps (partial unique index, CHECK constraints) — verify with `prisma migrate diff` after each; (4) post-v1, everything becomes expand-contract — hence do all breaking work now.

---

## 11. Verification Checklist (per migration + final)

- [ ] `prisma validate` passes; `prisma format --check` clean
- [ ] `prisma migrate status` shows no pending/drift after each step
- [ ] `prisma generate` regenerated client; TypeScript compile (`tsc --noEmit`) passes
- [ ] DB file backed up before M001 and before M004 (`cp db/custom.db db/custom.db.bak-<step>`)
- [ ] Seed reruns (`prisma db seed`) with no null-violation errors
- [ ] Login + dashboard smoke test (curl `/api/auth/login` → 200; `/api/dashboard` → data)
- [ ] Per-migration: app boots, affected routes return 200 with real data
- [ ] Idempotency: duplicate `(deviceId, seq)` insert rejected (M004)
- [ ] GC safety: ticket purge does not delete screenshot rows (M005)
- [ ] Partial unique index exists on `DeviceAssignment` (M003, raw SQL)
- [ ] CHECK constraints present for critical enums if opted in (M003/M004)
- [ ] `UserDailySummary` uniqueness holds across UTC-day boundary (M008)
- [ ] No `CASCADE` on telemetry/audit FKs anywhere (§3 audit grep)
- [ ] `git commit` per migration with the matching API-route changes (M004 especially)
- [ ] Final: `prisma migrate deploy` from a clean checkout reproduces the schema on a fresh DB

---

*End of Prisma Migration Plan v1.0*
