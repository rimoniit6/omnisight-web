# M008 Stage-2 Implementation Report

## Overview

M008 Stage-2 (analytics runtime layer) provides the orchestration infrastructure for background analytics jobs: a persistent job queue, scheduler, in-process cache, worker health monitoring, and retention cleanup. All built additive to the existing M008 Stage-1 rollup engine and alert evaluation engine.

## Architecture

```
┌─────────────────────────────────────────────────┐
│                 Next.js Instrumentation          │
│  (src/instrumentation.ts)                       │
│  └─ startRollupWorker()  [Stage-1]              │
│  └─ startAlertsWorker()  [Stage-2]              │
│  └─ initWorkerHealth()    [Stage-2]             │
│  └─ startAnalyticsScheduler() [Stage-2]         │
└─────────────────────────────────────────────────┘
            │
            ▼
┌─────────────────────────────────────────────────┐
│          Analytics Scheduler                     │
│  (src/lib/analytics/scheduler.ts)               │
│  └─ crash recovery → stale detection             │
│  └─ dequeueDueJobs() → claimJob() → executeJob() │
│  └─ executeJob() dispatches by jobType:          │
│    • incremental_rollup → runRollup()           │
│    • rebuild           → runRollup()            │
│    • alert_evaluation  → runAlertEvaluation()   │
│    • retention_cleanup → runRetentionBatch()    │
│    • stale_repair      → runRollup()            │
│    • daily_summary     → runRollup()            │
│  └─ cache invalidation after each job            │
│  └─ health recording (success/failure)         │
└─────────────────────────────────────────────────┘
            │
            ▼
┌─────────────────────────────────────────────────┐
│          Analytics Queue                        │
│  (src/lib/analytics/queue.ts)                   │
│  Uses AnalyticsJob table (additive columns):    │
│  • retryCount Int @default(0)                   │
│  • durationMs Int?                              │
│  • payload String?                              │
│  • fromDate → scheduled run time (pending)     │
│  • startedAt → claim time (running)             │
│  • finishedAt → completion time                 │
│  Exponential backoff: [0, 5s, 15s, 60s, 300s]  │
└─────────────────────────────────────────────────┘
            │
            ▼
┌─────────────────────────────────────────────────┐
│          Analytics Cache                        │
│  (src/lib/analytics/cache.ts)                   │
│  • In-process TTL cache (default 30s)           │
│  • Tag-based invalidation                       │
│  • Stale-while-revalidate support               │
│  • LRU eviction (default max 500 entries)      │
│  • Full metrics: hits, misses, evictions, etc. │
└─────────────────────────────────────────────────┘
            │
            ▼
┌─────────────────────────────────────────────────┐
│          Health Monitoring                      │
│  (src/lib/analytics/health.ts)                  │
│  • Per-worker tracking: running, lastExec,      │
│    duration, success/failure counts, nextRun    │
│  • Stuck detection (2× interval threshold)      │
│  • 4 registered workers: rollup, alerts,        │
│    scheduler, retention                         │
└─────────────────────────────────────────────────┘
            │
            ▼
┌─────────────────────────────────────────────────┐
│          Retention Worker                       │
│  (src/lib/analytics/retention.ts)               │
│  • ActivityEvent (90d default)                  │
│  • Screenshot (365d default)                    │
│  • DeviceHealthSnapshot (90d default)           │
│  • AnalyticsJob logs (30d default)              │
│  • UploadTicket expired/aborted (24h default)   │
│  • Batch delete (1000 rows/transaction)         │
│  • Resumable (loops until no more rows)          │
└─────────────────────────────────────────────────┘
```

## 14 Alert Types

All 14 alert types are now supported with full evaluation in `evaluateRule()`:

| # | Type | Trigger |
|---|------|---------|
| 1 | DeviceOffline | lastSeen older than offline threshold |
| 2 | MissingHeartbeat | Online device with no heartbeat for N min |
| 3 | HighIdle | Activity idle streak >= threshold |
| 4 | HighCpu | Health snapshot CPU >= threshold |
| 5 | LowMemory | Health snapshot RAM >= threshold |
| 6 | LowDisk | Health snapshot disk free below threshold |
| 7 | RepeatedOcrFailures | N OCR failures in window |
| 8 | ScreenshotUploadFailures | N expired/aborted upload tickets in window |
| 9 | AgentVersionOutdated | semverLt(installed, required) |
| 10 | HealthDegraded | N simultaneous health issues |
| 11 | LowProductivity | productivity score below threshold for N consecutive days |
| 12 | ScreenshotFailure | N screenshot capture failures (ocrFailure) in window |
| 13 | RepeatedCrashes | N crash events in window |
| 14 | PolicyMismatch | device.domainJoined doesn't match policy expectation |

## Admin API Endpoints

All 7 admin endpoints secured with `requireSuperAdmin` (Super Admin only):

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/admin/analytics/jobs` | Job history with filtering (status, jobType, limit, offset) |
| GET | `/api/admin/analytics/alerts` | Alerts list with filtering (status, type, deviceId, limit, offset) |
| GET | `/api/admin/analytics/workers` | Worker health + stuck detection |
| GET | `/api/admin/analytics/cache` | Cache stats (size, hits, misses, evictions, utilization) |
| POST | `/api/admin/analytics/cache` | Clear cache (full or by tag) |
| POST | `/api/admin/analytics/retry` | Retry failed jobs (by jobId, jobType, or all) |
| POST | `/api/admin/analytics/alerts/{id}/resolve` | Resolve an alert (idempotent, 404 if not found) |

## Cache Integration

Three dashboard/analytics routes now use the `cached()` helper:

| Route | TTL | Cache Tags |
|-------|-----|------------|
| `/api/dashboard` | 30s | `dashboard:{org}`, `range:{range}` |
| `/api/analytics` | 30s | `analytics:{org}`, `range:{range}` |
| `/api/timeline` | 15s | `timeline:{org}` |

Cache invalidation happens automatically after each scheduler job:
- After `rebuild` or `incremental_rollup`: `invalidateAfterRebuild()` (full clear)
- After `alert_evaluation`: `invalidateTags(['alerts:open', 'live:status'])`
- After `retention_cleanup`: no invalidation needed (old data removed from DB)

## Database Migration

`prisma/migrations/20260803180000_m008_stage2_analytics_queue/migration.sql`:
- `ALTER TABLE "AnalyticsJob" ADD COLUMN "retryCount" INTEGER NOT NULL DEFAULT 0`
- `ALTER TABLE "AnalyticsJob" ADD COLUMN "durationMs" INTEGER`
- `ALTER TABLE "AnalyticsJob" ADD COLUMN "payload" TEXT`
- `CREATE INDEX "AnalyticsJob_jobType_status_idx" ON "AnalyticsJob"("jobType", "status")`
- `CREATE INDEX "AnalyticsJob_status_fromDate_idx" ON "AnalyticsJob"("status", "fromDate")`

## Verification

- `npx tsc --noEmit` — passes for all new files (6 pre-existing errors in websockets/examples, alerts rules routes, admin markdown)
- `npx next build` — builds successfully
- `npx eslint` — no lint errors in new files
- `scripts/verify-m008-stage2.mjs` — comprehensive verification script (12-section coverage)

## Key Design Decisions

1. **Reuse AnalyticsJob table** — No new queue table. The existing `AnalyticsJob` model was extended additively with `retryCount`, `durationMs`, and `payload` columns.
2. **Singleton scheduler** — Module-level guard prevents double-scheduling; `claimJob()` uses atomic `updateMany` with status filter to prevent overlapping execution.
3. **Crash-safe** — `detectAndResetStaleJobs()` runs at startup and each cycle; `lastRunAt` only advances on full cycle completion.
4. **Schema compliance** — All 14 alert types evaluate against persisted telemetry only; no fabricated data. New rules use existing schema fields (`domainJoined`, `ocrFailure`, `kind: 'crash'`).
5. **RBAC** — All admin endpoints use `requireSuperAdmin()` which throws a `Response` (403), caught by `analyticsRoute` wrapper.
6. **Cache safety** — Auth resolves before cache lookup, so auth denials are never cached. Cache keys include user/org context for isolation.
