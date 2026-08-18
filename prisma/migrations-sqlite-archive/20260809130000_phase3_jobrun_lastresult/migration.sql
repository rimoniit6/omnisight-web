-- Phase 3: job observability — record a JSON summary of affected counts on
-- the last completed run.
--
-- NOTE: the JobRun table was historically db-push managed and is NOT created
-- by any earlier migration (the `_ok` snapshot predates it). On a fresh
-- `migrate deploy` the table may not exist yet, so create it if missing —
-- idempotent and safe on databases that already have it. The column is added
-- separately so fresh databases (table created here) and pre-existing
-- databases both converge on the final schema without duplicate-column
-- collisions.

CREATE TABLE IF NOT EXISTS "JobRun" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "job" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'idle',
    "startedAt" DATETIME,
    "finishedAt" DATETIME,
    "lastRunAt" DATETIME,
    "lastDurationMs" INTEGER,
    "lastError" TEXT,
    "leaseExpiresAt" DATETIME
);

-- The unique index on `job` may already exist on db-push-managed databases.
CREATE UNIQUE INDEX IF NOT EXISTS "JobRun_job_key" ON "JobRun"("job");

-- Additive column (no-op safe on databases that never ran this before).
ALTER TABLE "JobRun" ADD COLUMN "lastResult" TEXT;
