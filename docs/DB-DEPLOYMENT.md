# OmniSight — Database Deployment Runbook

Applies Prisma schema migrations to production safely, including the optional
per-organization analytics databases (BYODB).

## 1. What runs where

| Database | What lives in it | Schema owner |
| --- | --- | --- |
| Platform DB (always the cloud Postgres) | organizations, users, plans, subscriptions, settings, DeviceRouting, JobRun, notifications, anomalies | this repo (`prisma/schema.prisma`), via `prisma migrate deploy` |
| Per-org analytics DB (**optional**, `OrganizationSettings.useOwnDb=true`) | high-volume telemetry after cutover (screenshots, activities, locations, workday summaries) | same `prisma/schema.prisma` — must be replayed against each org DSN |

The platform `db` client is always the cloud database; `getPrismaForOrg`
(`src/lib/org-db.ts`) builds a dedicated client from the decrypted org DSN.
Data cutover (copying rows platform → org DB) is a separate, gated workflow
(the infrastructure change-request migration runner, `src/lib/migration/`),
NOT part of `prisma migrate deploy`.

## 2. Core facts about `prisma migrate deploy`

- `npm run db:deploy` → `prisma migrate deploy`.
- `migrate deploy` applies **pending migrations only** and requires **no shadow
  database**. Only `migrate dev` / `migrate reset` need a shadow DB — those are
  dev-only (`npm run db:migrate`, `npm run db:reset`), never run against prod.
- Migrations are recorded in `prisma/migrations/*/migration.sql` and applied in
  lexicographic order (timestamp-prefixed directories). Each applied migration
  rows is recorded in `_prisma_migrations` — deploy is idempotent and skips
  already-applied ones.
- Before deploy, `prisma generate` must reflect the schema in the running app:
  `npm run db:generate` (already wired into CI build).

## 3. Standard automated deploy (docker-compose)

`./scripts/deploy.sh` does exactly this sequence — the `web-migrate` one-shot
service (`docker-compose.production.yml`) runs the migrate container **before**
the new `web`/`live-updates` containers start:

1. Record current SHA; pull new images (`web`, `live-updates`).
2. `docker compose -f docker-compose.production.yml run --rm web-migrate`
   → `npx prisma migrate deploy` against the compose `db` service.
3. `up -d --force-recreate --no-build web live-updates`.
4. Health-gate: poll `/api/health` (200) then check `/api/health/ready`
   (503 until all critical checks pass).
5. On failure, restore the previous image and re-health-gate.

Manual equivalent (already-migrated DB, no compose):

```sh
npm run db:generate   # after pulling the new code
npm run db:deploy     # prisma migrate deploy — no shadow DB needed
./scripts/health-check.sh
```

## 4. Per-organization analytics DBs (BYODB replay)

An org that enabled its own analytics DB must have the SAME schema applied to
its database, or every analytics query on that org fails fast (the platform
fails closed — it never silently falls back to the platform DB for a `useOwnDb`
org, see `src/lib/org-db.ts`).

```sh
# Per org, using the org's analytics DSN (never the platform DATABASE_URL).
DATABASE_URL=postgresql://<org_user>:<org_pass>@<org_host>:<org_port>/<org_db> \
  npx prisma migrate deploy
```

- The org schema is the same `schema.prisma` — add the org DSN as a dedicated
  env var / secret, never overwrite the platform `DATABASE_URL`.
- The **data copy at cutover** is handled by the infrastructure
  change-request migration runner (approved `data_migration` requests →
  copy → verify → `ready_to_activate`), not by a migration. That runner's
  schema rows live on the platform DB (`InfrastructureChangeRequest`), so it is
  automatically covered by the platform deploy above.
- `/api/health/database` samples up to 5 `useOwnDb` orgs with `SELECT 1`
  (`orgDatabases` block) so you can see BYODB reachability at a glance without
  touching credentials.

## 5. Migration safety rules for production

- **Write backward-compatible migrations only.** A prod migration must apply
  while the *previous* release is still serving traffic (deploy.sh migrates
  before the new containers start, but the old containers are still up until
  then). Adding nullable columns, new tables, new indexes: fine. Renaming /
  dropping columns, changing types, tightening nullability: split into an
  additive migration + a later cleanup migration, or use the org infrastructure
  change-request workflow for org-scoped data rewrites.
- New code that reads a column must tolerate the pre-migration schema in the
  same deploy window (additive-only rule makes this trivially true — the column
  does not exist until the migration runs, so new code must not hard-require it
  before the migration; run `db:deploy` in the same deploy, which deploy.sh does).
- Prefer locking/holding DDL for seconds — index builds on large tables should
  use `CONCURRENTLY` in a standalone migration if the platform table is large.
- Never run `db:push:dev`/`db:migrate dev`/`db:reset` against production.
  `db:push:dev` exists for local iteration only.

## 6. Rollback

- **Application rollback is safe and automatic-ish:** `deploy.sh` reinstates the
  previous image on failure; `.deploy/previous` holds the last-good SHA.
- **Database rollback is forward-only:** `migrate deploy` never unapplies a
  migration. If a just-shipped migration is bad, the usual mitigation is a new
  corrective migration (add the column back, rename back, etc.), or a restore
  from the Postgres backup for fresh failures.
- Because migrations are additive by rule, rolling the app back to the previous
  image against the *already-migrated* schema keeps working — the previous code
  is forward-compatible with the extra columns/tables.
- `scripts/rollback.sh` (with `DEPLOY_DIR`) restores a previous image if you
  need the manual path.

## 7. Post-deploy verification

After every deploy run:

```sh
./scripts/health-check.sh          # /api/health + /api/health/ready + /health
curl -sf http://127.0.0.1:3000/api/health
curl -sf http://127.0.0.1:3000/api/health/ready
curl -sf http://127.0.0.1:3000/api/health/database   # check orgDatabases block
```

`/api/health/ready` is now authoritative for "can this instance serve traffic":
it checks `database` (SELECT 1), `deviceRouting` (Device Index table present →
platform migrations applied), `jobs` (JobRun lease table present → scheduler can
make progress), `storage`, and required-config presence. A 503 means take the
instance out of rotation.

Background jobs self-report through the `JobRun` lease table (`status`,
`lastRunAt`, `lastError`, `lastResult`); leases expire after 5 minutes
(`JOB_LEASE_MS`), so a crashed worker is automatically re-claimed and never
double-executed. Run a full pass on demand with `npm run jobs`.

## 8. Backups (out of scope, expected)

Containerized Postgres data lives on the `pgdata` volume (production compose).
Take periodic `pg_dump` snapshots and test restores; this runbook assumes the
DB is not recreated from source. BYODB org databases are owned/managed by the
org — the same backup responsibility applies to their DSN.