-- SentimentRecord integrity + read-performance (audit fixes T2/T4).
--
-- 1) Composite indexes for the read/purge paths:
--      - list/summary date-window filters and the analyze rerun replaceMany
--        filter by (organizationId, periodStart)
--      - latest-per-employee ordering scans (organizationId, createdAt)
--
-- 2) Unique index on (employeeId, projectId, periodStart): one record per
--    employee/project/period window. Reruns replace via deleteMany+create in
--    one transaction, so this only trips on genuinely concurrent writers.
--    NOTE: Postgres treats NULLs as DISTINCT in unique indexes, so
--    employee-level rows (projectId IS NULL) are NOT protected by this
--    constraint — their cross-process safety comes from the JobRun lease
--    claimed by the analyze route (src/lib/jobs/lease.ts).

CREATE INDEX IF NOT EXISTS "SentimentRecord_organizationId_periodStart_idx" ON "SentimentRecord"("organizationId", "periodStart");

CREATE INDEX IF NOT EXISTS "SentimentRecord_organizationId_createdAt_idx" ON "SentimentRecord"("organizationId", "createdAt");

-- Dedupe guard: if historical duplicate windows exist (the previous guard was
-- in-process only), keep the NEWEST row per (employee, project, periodStart)
-- and remove the rest BEFORE creating the unique index. The delete only fires
-- for actual duplicate groups; a clean table is untouched.
DELETE FROM "SentimentRecord" a
USING "SentimentRecord" b
WHERE a."employeeId" = b."employeeId"
  AND a."periodStart" = b."periodStart"
  AND a."projectId" IS NOT DISTINCT FROM b."projectId"
  AND (a."createdAt" < b."createdAt"
       OR (a."createdAt" = b."createdAt" AND a."id" < b."id"));

CREATE UNIQUE INDEX IF NOT EXISTS "SentimentRecord_employeeId_projectId_periodStart_key"
  ON "SentimentRecord"("employeeId", "projectId", "periodStart");
