-- M004 Stage-2: Telemetry Identity — backfill + UNIQUE(deviceId, seq)
-- Safe one-time backfill (guarded by IS NULL); never truncates, never deletes.

-- 1. seq: monotonic per device (ROW_NUMBER ordered by timestamp, tiebroken by rowid)
UPDATE "ActivityLog"
SET "seq" = (
  SELECT rn FROM (
    SELECT id, ROW_NUMBER() OVER (PARTITION BY "deviceId" ORDER BY "timestamp", rowid) AS rn
    FROM "ActivityLog"
  ) ranked
  WHERE ranked.id = "ActivityLog".id
)
WHERE "seq" IS NULL;

-- 2. kind: normalize legacy type -> canonical values
UPDATE "ActivityLog"
SET "kind" = CASE "type"
  WHEN 'App' THEN 'app'
  WHEN 'Website' THEN 'website'
  WHEN 'Idle' THEN 'idle'
  WHEN 'Screenshot' THEN 'system'
  WHEN 'System' THEN 'system'
  ELSE 'unknown'
END
WHERE "kind" IS NULL;

-- 3. source: mark migrated legacy records
UPDATE "ActivityLog" SET "source" = 'legacy' WHERE "source" IS NULL;

-- 4. receivedAt: authoritative server clock = existing timestamp for legacy rows
UPDATE "ActivityLog" SET "receivedAt" = "timestamp" WHERE "receivedAt" IS NULL;

-- 5. UNIQUE(deviceId, seq) — idempotency ring. Fails loudly if duplicates exist.
CREATE UNIQUE INDEX "ActivityLog_deviceId_seq_key" ON "ActivityLog"("deviceId", "seq");
