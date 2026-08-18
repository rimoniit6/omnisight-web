-- M008 Stage-2 — extend AnalyticsJob for queue scheduling
-- Additive-only: columns added to support job scheduling, retry, and payload.

ALTER TABLE "AnalyticsJob" ADD COLUMN "retryCount" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "AnalyticsJob" ADD COLUMN "durationMs" INTEGER;
ALTER TABLE "AnalyticsJob" ADD COLUMN "payload" TEXT;

-- Indexes for queue scheduling (from schema @@index directives)
CREATE INDEX IF NOT EXISTS "AnalyticsJob_jobType_status_idx" ON "AnalyticsJob"("jobType", "status");
CREATE INDEX IF NOT EXISTS "AnalyticsJob_status_fromDate_idx" ON "AnalyticsJob"("status", "fromDate");
