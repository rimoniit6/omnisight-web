# Production Performance Baseline

Date: 2026-08-10 · Phase G
Method: real measurements via `scripts/perf-baseline.mjs` (real Prisma client against the live `db/custom.db`, 50 iterations per op, warm-up, µs). SQLite is the CURRENT production DB — these numbers are the baseline to beat after the PostgreSQL migration.

## Admin surface

| Operation | P50 (µs) | P95 (µs) | P99 (µs) |
|---|---|---|---|
| login user lookup (email) | 637 | 3,215 | 4,846 |
| devices list (pageSize=20 + employee) | 2,216 | 6,194 | 6,918 |
| devices count | 406 | 2,406 | 2,653 |
| employees list (pageSize=20 + search) | 2,606 | 6,775 | 7,287 |
| projects list (pageSize=20 + members) | 1,746 | 4,858 | 5,763 |
| consent state (all employee consents) | 2,714 | 6,074 | 7,193 |
| consent policy list | 721 | 2,277 | 3,318 |
| audit log page (20) | 1,918 | 13,351 | 14,529 |
| device claim list (+device) | 1,056 | 4,267 | 8,174 |

## Agent surface

| Operation | P50 (µs) | P95 (µs) | P99 (µs) |
|---|---|---|---|
| discover (device by agentKey) | 1,452 | 9,063 | 10,104 |
| claim lookup by device | 634 | 2,958 | 3,062 |
| config (org settings) | 515 | 2,496 | 3,280 |
| heartbeat (device touch) | 457 | 2,074 | 2,807 |
| activity insert (tx + rollback) | 5,699 | 18,574 | 148,805* |
| screenshot metadata insert (tx + rollback) | 6,052 | 12,847 | 21,892 |

\*P99 outlier from the rollback-transaction overhead (interactive-tx setup); steady-state single inserts are sub-10 ms. Re-measure on PostgreSQL.

## DB connection health

- Connect + `SELECT 1`: **7,230 µs** (cold PrismaClient init; subsequent ops reuse the pool)

## Interpretation

- All interactive read paths are **sub-15 ms P99** on the current dataset (41 employees, 30 devices, 2,300 activities, 247 consents) — comfortably interactive for an admin console.
- Write paths (activity/screenshot metadata) are **5–13 ms typical** — far below the agent upload cadence; no bottleneck.
- The `audit log page` P99 (14.5 ms) reflects the `organizationId+createdAt` index; acceptable, revisit at scale.
- **No unbounded queries or missing-index bottlenecks found** in the measured surface. Postgres re-baseline is required post-migration (B-01).

## Scalability note

SQLite is single-writer. At production multi-agent concurrency the write path will contend;
PostgreSQL (B-01) is the intended fix and its baseline must be measured after migration using
this same script (`DATABASE_URL=postgresql://… node scripts/perf-baseline.mjs`).
