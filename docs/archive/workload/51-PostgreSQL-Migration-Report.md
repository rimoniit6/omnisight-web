# PostgreSQL Migration Report (Phase G)

> Project: WorkLensAI — `E:\Workslens\workai`
> Date: 2026-08-10
> Provider: `prisma` → `postgresql` (single authoritative production database)
> Database: `workai` on `localhost:5432` (PostgreSQL 18.4, local instance)

---

## 1. SQLite → PostgreSQL Status

**MIGRATION COMPLETE — PASS**

- Prisma `datasource` provider changed from `sqlite` to `postgresql` (`prisma/schema.prisma`).
- PostgreSQL is now the **only** supported application database. No runtime fallback to SQLite exists.
- 29 SQLite migration folders archived to `prisma/migrations-sqlite-archive/` (history preserved, nothing deleted).
- A single clean baseline migration `20260810105722_postgresql_initial` was generated and applied.
- **No `prisma db push` in production path** — deployment uses `prisma migrate deploy` (verified below).
- Test suites use dedicated throwaway PostgreSQL databases (`workai_test_*`) via `scripts/pg-test-db.mjs`; `db push` is used **only** as a test-suite convenience inside throwaway DBs, never against `workai` or production.

## 2. Migration Chain

| Step | Command | Result |
|---|---|---|
| Create DB | `CREATE DATABASE workai;` | PASS |
| Switch provider | `prisma/schema.prisma` → `provider = "postgresql"` | PASS |
| Baseline migration | `prisma migrate dev --name postgresql_initial` | PASS |
| Fresh-DB deploy | `prisma migrate deploy` on empty `workai_test_migrate` | **"All migrations have been successfully applied"** |
| Generate client | `prisma generate` | PASS |
| Data import | `node scripts/migrate-sqlite-to-postgres.mjs` | PASS (29 tables, see §3) |
| Post-import verification | `scripts/pg-audit.sql` + `scripts/migration-verify.mjs` | PASS (43 FKs, uniques, indexes, timestamps) |

## 3. Tables & Row Counts (Before/After)

All rows migrated from `db/custom.db` (SQLite) into PostgreSQL `workai`. **Zero FK orphans. Zero defaults required** (all legacy timestamps preserved exactly — epoch-ms numeric values converted correctly, see §8).

| Table | SQLite → PostgreSQL | Verified |
|---|---|---|
| Organization | 2 → 2 | ✅ |
| Employee | 42 → 42 | ✅ |
| Department | 9 → 9 | ✅ |
| Project | 11 → 11 | ✅ |
| ProjectMember | 47 → 47 | ✅ |
| Device | 30 → 30 | ✅ |
| DeviceClaim | 1 → 1 | ✅ (zero-touch claim intact) |
| Consent | 248 → 248 | ✅ |
| ConsentPolicy | 8 → 8 | ✅ |
| ConsentLog | 303 → 303 | ✅ |
| Activity | 2,300 → 2,300 | ✅ (critical monitoring data) |
| Screenshot | 28 → 28 | ✅ |
| AuditLog | 109 → 109 | ✅ |
| AppUser | 4 → 4 | ✅ |
| AgentToken | 0 → 0 | ✅ |
| TimeEntry | 435 → 435 | ✅ |
| + 13 remaining tables | (SystemSetting, MonitoringPolicy, Notification, Alert, SentimentRecord, AiInsight, Report, JobRun, BreakStatus, ProjectRole, EmployeeProject, OrganizationSetting, AgentRegistration…) | ✅ |
| **Total** | **29 tables** | ✅ **ALL PASS** |

## 4. Orphan / FK Validation

- Foreign keys in PostgreSQL: **43** (`pg_constraint contype='f'`, public schema).
- Post-import orphan scan across all child tables: **0 orphans**.
- `ConsentLog` FK is `RESTRICT` (immutable audit trail — verified by `migration-verify.mjs`).

## 5. Unique Constraints & Indexes

Verified present in PostgreSQL:

- `Device.agentKey` unique — one stable device identity per machine.
- `DeviceClaim.deviceId` unique — one claim per device.
- `Consent(employeeId, consentType)` unique + status/org indexes.
- `ConsentPolicy(org, consentType, version)` unique (policy versioning).
- `ProjectMember(projectId, employeeId)` composite unique (no duplicate membership).
- `Organization.slug`, `Employee(employeeId, org)`, `Employee.email` (org-scoped) uniques.
- Indexes on `organizationId`, `employeeId`, `deviceId`, `projectId`, `status`, `timestamp` for high-frequency agent/query paths (per `scripts/pg-audit.sql`).

## 6. Case-Insensitive Search Parity (PostgreSQL compatibility fixes)

SQLite `LIKE` is case-insensitive; PostgreSQL `LIKE` is not. All routes that relied on that behavior were updated to use Prisma `mode: 'insensitive'` (or explicit lower/ILIKE equivalents) so search behavior is preserved:

- `src/app/api/employees/search/route.ts`
- `src/app/api/search/route.ts`
- `src/app/api/projects/route.ts`
- `src/app/api/projects/search/route.ts`
- `src/app/api/sentiment/route.ts`
- `src/app/api/auth/users/route.ts`
- `src/app/api/auth/login/route.ts`
- `src/app/api/projects/[id]/route.ts`

## 7. Raw SQL Audit

- `$queryRaw`/`$executeRaw` usage reviewed: all parameterized, no string interpolation of user input.
- `src/app/api/screenshots/ocr-search/route.ts` uses `$queryRawUnsafe` **with bound parameters only** (no injection vector) — verified syntax is PostgreSQL-safe.
- Migration script binds typed values with explicit casts (`::integer`, `::double precision`, `::boolean`, `($n::timestamptz AT TIME ZONE 'UTC')::timestamp(3)`) to survive Prisma's text-parameter transport.

## 8. Date/Time Audit

- All `DateTime` columns mapped to `timestamp(3)` with UTC semantics.
- Spot-checked round-trip: `Organization.createdAt` = `2026-08-07 20:15:55 UTC` matches SQLite epoch `1786112155122` exactly.
- `Activity.timestamp`, `Device.lastHeartbeat`, consent `expiresAt`, claim `expiresAt` all verified.
- Legacy numeric epoch-ms timestamps (common in the restored SQLite fixture) are converted by `toIso()` in the migration script — **no epoch defaults were needed in the final run** (`migrate --force` run: "defaults needed: 0").

## 9. Zero-Touch Verification (against PostgreSQL)

`tests/zero-touch.test.ts` — **29/29 PASS** against `workai_test_zerotouch` (PostgreSQL):

- ZT-1 discover → pending claim + hashed one-time secret (sha256 hex, ≥40 chars)
- ZT-2 duplicate discover idempotent (same device, same claim, no re-issued secret)
- ZT-5 non-admin approve → 403
- ZT-6 approve binds employee, department-from-employee, projects (ProjectMember)
- ZT-7/8 cross-org employee/project → 404/422
- ZT-9/10 approval NEVER creates/changes consent
- ZT-12 one-active-device-per-employee
- ZT-13/14/15/16/17 auth gating (pending/rejected/revoked/wrong-secret)
- ZT-18 legacy PATH B still works
- ZT-21/22/23/24 consent fail-closed at route level (403, nothing persisted)
- ZT-25/26 server-derived config assignment + reflects admin changes
- **ZT-27 concurrent approval → exactly ONE active device (fixed, see §11)**
- ZT-28 token generation crypto-random; ZT-29 spoof-resistant client IP

## 10. Consent Verification (against PostgreSQL)

`tests/consent.test.ts` — **27/27 PASS** against `workai_test_consent` (PostgreSQL): all 8 consent types grant→active / revoke→closed independently; policy version mismatch fail-closed; expired consent fail-closed; immutable audit trail (RESTRICT); concurrent transition single-winner.

## 11. Concurrency Fix (ZT-27) — PostgreSQL-exposed race

**Root cause:** SQLite's single-writer lock serialized concurrent device approvals; PostgreSQL exposes real read-committed concurrency, so two parallel approvals for the same employee could interleave and leave **two** active devices.

**Fix:** `src/app/api/device-claims/[id]/approve/route.ts` — the approve transaction now takes a per-employee row lock first:

```sql
SELECT id FROM "Employee" WHERE id = $employeeId FOR UPDATE
```

This forces strict ordering: the second transaction waits, then sees the first device as active and deactivates it. Re-verified **ZT-27 PASS** (was 1 fail on PG before the fix).

## 12. Employee CRUD Fix (EMPLOYEE-11/12)

**Root cause:** `src/app/api/employees/[id]/route.ts` PUT required `firstName`/`lastName`/`email` on every update and used `body.phone ?? null` / `body.designation ?? null` — so partial updates (the UI's status toggle sends `{ status }`; the security suite sends `{ designation }` / `{ departmentId }`) returned **400**, and would silently wipe columns.

**Fix:** partial-update **merge semantics** — only fields present in the body are validated/applied; omitted fields keep existing values; explicit `null` clears the date. Re-verified **security 28/28** (EMPLOYEE-11/12 now PASS).

## 13. Health Endpoint Proxy Fix

`/api/health` and `/api/health/database` are documented public probes but the proxy whitelist matched only the literal path `/api` → **401**. Fixed `src/proxy.ts` to prefix-match `/api/health`. Live-verified: both return 200 with latency against PostgreSQL.

## 14. Test Matrix (all against PostgreSQL)

| Suite | DB | Result |
|---|---|---|
| `tests/zero-touch.test.ts` | workai_test_zerotouch | **29/29 PASS** |
| `tests/consent.test.ts` | workai_test_consent | **27/27 PASS** |
| `tests/projects.test.ts` | workai_test_projects | **17/17 PASS** |
| `tests/security.test.ts` | workai_test_security | **28/28 PASS** |
| Admin `tsc --noEmit` | — | **PASS** |
| Admin `npm run build` | — | **PASS** |
| Desktop `npm run typecheck` | — | **PASS** |
| Desktop `npm run test:src` | — | **111/111 PASS** |
| Desktop `npm run build` | — | **PASS** |
| Fresh-DB `prisma migrate deploy` + `migration-verify.mjs` | workai_test_migrate | **ALL CHECKS PASSED** |

## 15. Live Smoke Test (dev server, PostgreSQL-backed)

Booted `next dev -p 3100` with `DATABASE_URL=postgresql://…@localhost:5432/workai`:

- `POST /api/auth/login` (super admin) → **200, JWT issued**
- `GET /api/dashboard` → **200** — real migrated data (38 employees, 30 devices, 25 online, 17 active alerts, recent activities)
- `GET /api/devices?page=1&pageSize=1` → **200** real device (Rimon, Windows, agent v1.0.0)
- `GET /api/employees?page=1&pageSize=1` → **200** real employee (001 Rimon Rana)
- `GET /api/projects?page=1&pageSize=1` → **200** real project
- `GET /api/health` → **200** `{"status":"ok"}`
- `GET /api/health/database` → **200** `{"status":"ok","latencyMs":105}`
- `POST /api/agent/discover` (zero-touch) → **201** pending claim + 46-char crypto-random secret; rows cleaned up after

## 16. Files Changed

**Schema / migrations**
- `prisma/schema.prisma` — provider `postgresql`
- `prisma/migrations/20260810105722_postgresql_initial/` — new PG baseline (29 tables)
- `prisma/migrations-sqlite-archive/` — 29 SQLite migrations archived (history preserved)

**New scripts**
- `scripts/migrate-sqlite-to-postgres.mjs` — typed, ordered, transactional SQLite→PG import with FK/orphan validation and `--force`
- `scripts/pg-test-db.mjs` — create/drop throwaway PG test databases (`ensure` / `drop`)
- `scripts/pg-audit.sql` — FK/unique/index/timestamp audit
- `scripts/migration-verify.mjs` — rewritten: SQLite PRAGMA checks → PostgreSQL `information_schema` checks

**Application fixes**
- `src/app/api/device-claims/[id]/approve/route.ts` — `FOR UPDATE` employee lock (ZT-27)
- `src/app/api/employees/[id]/route.ts` — partial-update merge semantics (EMPLOYEE-11/12)
- `src/proxy.ts` — public `/api/health*` prefix whitelist
- 8 search routes — `mode: 'insensitive'` PG parity (see §6)

**Test harness**
- `tests/zero-touch.test.ts`, `tests/consent.test.ts`, `tests/projects.test.ts`, `tests/security.test.ts` — throwaway **PostgreSQL** test DBs (`pg-test-db.mjs` ensure/drop), env override `PG_TEST_BASE_URL`
- `tests/employee-db-inspect.ts` — PG URL

**Config / docs**
- `.env` — `DATABASE_URL=postgresql://postgres:***@localhost:5432/workai?schema=public` (gitignored)
- `.env.example` — placeholder PG URL (`postgresql://USER:PASSWORD@HOST:5432/workai?schema=public`)
- `package.json` — DB scripts aligned with PG

## 17. Remaining Risks / Warnings

1. **Local PostgreSQL instance** — the environment uses a local PG 18.4 on `localhost:5432`; a managed/remote production PG is NOT configured. `DATABASE_URL` is a single non-pooled connection URL (no PgBouncer/Supabase pooler) — fine for single-instance; pooling is a deployment-time concern.
2. **`db push` in tests** — used only inside throwaway `workai_test_*` DBs; production path is `prisma migrate deploy`. Documented in the test headers.
3. **Physical screenshot files** — DB rows migrated; the `uploads/screenshots/` files themselves were not part of this DB migration (they live on disk and remain untouched).
4. **AgentToken=0** — no live agent tokens at migration time (expected; tokens are short-lived and re-issued on auth).
5. **Rollback** — archived SQLite migrations + `db/custom.db` retained as the rollback source until the PG migration is independently validated on a real deployment.

## 18. Conclusion

**The project is genuinely PostgreSQL-backed and has been tested end-to-end against PostgreSQL:**
schema (baseline) → data (29 tables, 0 orphans, exact timestamps) → constraints (43 FKs, uniques, indexes) → APIs (search parity) → zero-touch + consent + security + projects (101/101 backend tests) → admin build → desktop agent (111/111) → live smoke (login, dashboard, devices, employees, projects, health, zero-touch discover).

Two genuine defects surfaced by the migration (a PG-only concurrency race and a pre-existing partial-update bug) were root-caused and fixed with regression coverage. **No known SQLite runtime dependency remains in `src/`.**
