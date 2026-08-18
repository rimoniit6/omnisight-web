-- Anomaly Detection hardening (F-14, F-15, F-16)
-- Additive schema changes only — no data transformation, no destructive ops.

-- F-14: DB-safe dedupe. Each auto-detected / agent-reported anomaly carries a
-- deterministic key (org:employee:type:utcDay); the UNIQUE index enforces it
-- under concurrency (a second insert is a P2002 duplicate, never a 500).
-- Postgres unique indexes permit multiple NULLs, so only live dedupe slots
-- contend; resolving a record clears its key so it can re-trigger.
ALTER TABLE "Anomaly" ADD COLUMN     "dedupeKey" TEXT;

-- F-15: the default list query is organization-scoped ordered by createdAt;
-- this composite index serves both the list sort and the live-updates poll
-- cursor (new-anomaly events since the cursor, org-room scoped).
CREATE INDEX "Anomaly_organizationId_createdAt_idx" ON "Anomaly"("organizationId", "createdAt");

-- Live-updates poll cursor (new anomalies since `createdAt`) without an org
-- filter is also used by the WebSocket service.
CREATE INDEX "Anomaly_createdAt_idx" ON "Anomaly"("createdAt");

CREATE UNIQUE INDEX "Anomaly_dedupeKey_key" ON "Anomaly"("dedupeKey");
