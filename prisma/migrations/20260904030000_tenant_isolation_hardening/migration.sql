-- Phase 1 Step 10: tenant isolation hardening.
--
-- 1. Activity.organizationId: direct tenant ownership (previously join-only
--    through Employee). Backfilled from Employee.organizationId. FAILS LOUDLY
--    if any Activity row cannot be attributed (no silent NULL ownership).
-- 2. FK enforcement for previously FK-less tenant columns: AppListEntry,
--    UsbEvent, PolicyViolation, ConsentLog -> Organization. Orphan rows (if
--    any) abort the migration loudly instead of being silently dropped.

-- --- 1a. Add Activity.organizationId as nullable for backfill ---
ALTER TABLE "Activity" ADD COLUMN "organizationId" TEXT;

-- --- 1b. Backfill from Employee ---
UPDATE "Activity" a
SET "organizationId" = e."organizationId"
FROM "Employee" e
WHERE a."employeeId" = e."id" AND a."organizationId" IS NULL;

-- --- 1c. Fail loudly on unattributable rows (no silent NULL ownership) ---
DO $$
DECLARE
  orphan_count INTEGER;
BEGIN
  SELECT COUNT(*) INTO orphan_count FROM "Activity" WHERE "organizationId" IS NULL;
  IF orphan_count > 0 THEN
    RAISE EXCEPTION 'Migration blocked: % Activity row(s) have no attributable organization (employee missing). Resolve manually before migrating.', orphan_count;
  END IF;
END $$;

-- --- 1d. Enforce NOT NULL + FK + indexes ---
ALTER TABLE "Activity" ALTER COLUMN "organizationId" SET NOT NULL;
ALTER TABLE "Activity" ADD CONSTRAINT "Activity_organizationId_fkey"
  FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
CREATE INDEX IF NOT EXISTS "Activity_organizationId_idx" ON "Activity"("organizationId");
CREATE INDEX IF NOT EXISTS "Activity_organizationId_timestamp_idx" ON "Activity"("organizationId", "timestamp");
CREATE INDEX IF NOT EXISTS "Activity_organizationId_createdAt_idx" ON "Activity"("organizationId", "createdAt");

-- --- 2a. AppListEntry -> Organization (column already NOT NULL) ---
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'AppListEntry_organizationId_fkey'
  ) THEN
    ALTER TABLE "AppListEntry" ADD CONSTRAINT "AppListEntry_organizationId_fkey"
      FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;

-- --- 2b. UsbEvent -> Organization / Employee / Device ---
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'UsbEvent_organizationId_fkey') THEN
    ALTER TABLE "UsbEvent" ADD CONSTRAINT "UsbEvent_organizationId_fkey"
      FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'UsbEvent_employeeId_fkey') THEN
    ALTER TABLE "UsbEvent" ADD CONSTRAINT "UsbEvent_employeeId_fkey"
      FOREIGN KEY ("employeeId") REFERENCES "Employee"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'UsbEvent_deviceId_fkey') THEN
    ALTER TABLE "UsbEvent" ADD CONSTRAINT "UsbEvent_deviceId_fkey"
      FOREIGN KEY ("deviceId") REFERENCES "Device"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END $$;

-- --- 2c. PolicyViolation -> Organization / Employee / Device ---
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'PolicyViolation_organizationId_fkey') THEN
    ALTER TABLE "PolicyViolation" ADD CONSTRAINT "PolicyViolation_organizationId_fkey"
      FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'PolicyViolation_employeeId_fkey') THEN
    ALTER TABLE "PolicyViolation" ADD CONSTRAINT "PolicyViolation_employeeId_fkey"
      FOREIGN KEY ("employeeId") REFERENCES "Employee"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'PolicyViolation_deviceId_fkey') THEN
    ALTER TABLE "PolicyViolation" ADD CONSTRAINT "PolicyViolation_deviceId_fkey"
      FOREIGN KEY ("deviceId") REFERENCES "Device"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END $$;

-- --- 2d. ConsentLog -> Organization ---
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ConsentLog_organizationId_fkey') THEN
    ALTER TABLE "ConsentLog" ADD CONSTRAINT "ConsentLog_organizationId_fkey"
      FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;
