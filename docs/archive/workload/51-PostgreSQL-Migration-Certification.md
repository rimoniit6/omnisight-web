# PostgreSQL Migration Certification

Date: 2026-08-10 · Phase G

## Verdict

| Item | Status |
|---|---|
| SQLite-specific behavior audit | ✅ PASS |
| Migration compatibility audit | ✅ PASS |
| Migration plan produced | ✅ PASS |
| Live migration executed on fresh PostgreSQL | 🔒 **BLOCKED — no PostgreSQL server/Docker in this environment** |
| Data migration (SQLite → PG) executed | 🔒 **BLOCKED** |
| Post-migration E2E (zero-touch/consent) on PG | 🔒 **BLOCKED** |

---

## 1. SQLite-specific behavior audit

| Area | Finding |
|---|---|
| Provider | `prisma/schema.prisma:9` — `provider = "sqlite"` |
| Active DB | `db/custom.db` (SQLite file, 2,048,000 bytes) |
| Migrations | 29 migrations; **10 contain `PRAGMA` statements** (table-rebuild pattern: `PRAGMA foreign_keys=OFF`, `defer_foreign_keys`, `AUTOINCREMENT`-style `CREATE TABLE` rebuilds) — these are **SQLite-only SQL and would fail on PostgreSQL** |
| Raw SQL in app | ✅ None — all persistence is Prisma client calls (audited: no `$queryRaw`/`$executeRaw` in `src/`) |
| ID strategy | `String @id @default(cuid())` everywhere — portable to PG `TEXT` with no `AUTOINCREMENT`/`SERIAL` dependence |
| DateTime defaults | `@default(now())` — portable |
| JSON fields | Stored as `String` (JSON-encoded) — portable (no `Json` PG type dependency) |
| Transactions | Prisma `$transaction` interactive + array forms — portable |
| Concurrency | SQLite single-writer; PG multi-writer — an improvement, no code change needed |
| Unique constraints | `Device.agentKey @unique`, `DeviceClaim.deviceId @unique`, `ProjectMember @@unique([projectId, employeeId])`, `Consent @@unique([employeeId, consentType])` — portable |
| Indexes | `@@index` on org/employee/device/project/time paths — portable |
| Seed | `src/lib/seed.ts` — pure Prisma calls, portable |
| Test DB config | Tests use `file:…custom.db` URLs; must be repointed to a PG test database after migration |

## 2. Migration compatibility audit

- The existing **29 SQLite migrations cannot be replayed on PostgreSQL** (PRAGMA syntax).
- Safe strategy: **baseline + fresh migration**, NOT `prisma db push`:
  1. Freeze the current SQLite schema as the source of truth.
  2. Flip `datasource.provider` to `postgresql` + set `DATABASE_URL=postgresql://…`.
  3. `prisma migrate diff --from-empty --to-schema-datamodel prisma/schema.prisma --script` → create `prisma/migrations/0_init_postgres/migration.sql` (deterministic baseline).
  4. `npx prisma migrate deploy` against the fresh PG (creates all tables/indexes/constraints).
  5. Data migration: export SQLite (`node:sqlite` dump or Prisma read) → transform (same schema shape) → import to PG. All CUIDs preserved → relationships intact.
  6. Re-point `src/lib/db.ts`, seed script, and tests to PG.
- Constraints preserved: `Device.agentKey` uniqueness, `DeviceClaim.deviceId` uniqueness, org FK cascade rules, consent `(employeeId, consentType)` uniqueness, `ProjectMember (projectId, employeeId)` uniqueness — all carry over 1:1.
- Zero-touch behavior: `discover` looks up `device.agentKey` (unique index) and creates pending `DeviceClaim` in a transaction — unchanged on PG.

## 3. Required change list (release-blocking work item)

| # | Change | File |
|---|---|---|
| PG-1 | `provider = "sqlite"` → `provider = "postgresql"` | `prisma/schema.prisma` |
| PG-2 | Baseline migration `0_init_postgres` via `prisma migrate diff` | `prisma/migrations/` |
| PG-3 | `DATABASE_URL=postgresql://user:pass@host:5432/worklens` | `.env.production.example` |
| PG-4 | Connection pooling note (PgBouncer optional, single-instance OK) | deployment docs |
| PG-5 | Repoint tests to a PG test DB (or CI service container) | test config |

## 4. Verification checklist (to run on provisioned PG)

1. Fresh PostgreSQL DB
2. `npx prisma migrate deploy` → all tables created (deterministic)
3. `npm run db:seed` (or import) → org/employees/devices present
4. Admin login works
5. Zero-touch discover → pending DeviceClaim
6. Admin approve → device online, employee/project assignment
7. Agent authenticate → AgentToken issued
8. Consent grant/revoke → collector + 403 behavior
9. Activity + screenshot uploads
10. Device revoke → tokens rejected
11. Restart/reconnect → same device identity
12. Backup (pg_dump) → restore into a second DB → verified

## 5. Conclusion

**The PostgreSQL migration is code-planned and audit-safe but has NOT been executed** because no PostgreSQL server or container runtime is available in this environment (`pg_isready`, `psql`, `docker` all absent). This remains **P1 release blocker B-01**. The plan above is deterministic and additive; no schema redesign is required.
