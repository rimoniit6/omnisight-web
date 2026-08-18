-- WorkLensAI — Policy Management hardening
--
-- 1. AppListEntry: stronger identity fields (publisher / sha256 / path),
--    DB-safe duplicate protection (unique active entry per org/app/listType),
--    and the [organizationId, isActive] active-policy lookup index.
-- 2. UsbEvent: device identity fields (vid/pid/manufacturer/deviceClass/
--    driveLetter) + a DB-level unique dedupe key for concurrent agent reports.
-- 3. PolicyViolation: new model persisting agent-side enforcement events
--    (blocked applications), deduplicated at the DB level.

-- ── Pre-step: dedupe legacy AppListEntry duplicates ────────────────────────
-- The new unique index allows at most ONE ACTIVE row per (org, appName,
-- listType). Any legacy duplicates (possible via the old app-level race) are
-- soft-deactivated here, keeping the earliest-created row active. Soft-
-- deleted (inactive) rows are excluded from the constraint, so a previously
-- removed app can be re-added.
UPDATE "AppListEntry" SET "isActive" = false
WHERE id IN (
  SELECT id FROM (
    SELECT
      id,
      row_number() OVER (
        PARTITION BY "organizationId", "appName", "listType", "isActive"
        ORDER BY "createdAt" ASC, "id" ASC
      ) AS rn
    FROM "AppListEntry"
    WHERE "isActive" = true
  ) ranked
  WHERE ranked.rn > 1
);

-- AlterTable
ALTER TABLE "AppListEntry" ADD COLUMN     "path" TEXT,
ADD COLUMN     "publisher" TEXT,
ADD COLUMN     "sha256" TEXT;

-- AlterTable
ALTER TABLE "UsbEvent" ADD COLUMN     "dedupeKey" TEXT,
ADD COLUMN     "deviceClass" TEXT,
ADD COLUMN     "driveLetter" TEXT,
ADD COLUMN     "manufacturer" TEXT,
ADD COLUMN     "pid" TEXT,
ADD COLUMN     "vid" TEXT;

-- CreateTable
CREATE TABLE "PolicyViolation" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "employeeId" TEXT,
    "deviceId" TEXT,
    "policyId" TEXT NOT NULL,
    "executableName" TEXT NOT NULL,
    "processPath" TEXT,
    "action" TEXT NOT NULL,
    "severity" TEXT NOT NULL,
    "metadata" JSONB,
    "dedupeKey" TEXT NOT NULL,
    "occurredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PolicyViolation_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "PolicyViolation_dedupeKey_key" ON "PolicyViolation"("dedupeKey");

-- CreateIndex
CREATE INDEX "PolicyViolation_organizationId_createdAt_idx" ON "PolicyViolation"("organizationId", "createdAt");

-- CreateIndex
CREATE INDEX "PolicyViolation_policyId_idx" ON "PolicyViolation"("policyId");

-- CreateIndex
CREATE INDEX "PolicyViolation_deviceId_idx" ON "PolicyViolation"("deviceId");

-- CreateIndex
CREATE INDEX "PolicyViolation_employeeId_idx" ON "PolicyViolation"("employeeId");

-- CreateIndex
CREATE INDEX "AppListEntry_organizationId_isActive_idx" ON "AppListEntry"("organizationId", "isActive");

-- CreateIndex
CREATE UNIQUE INDEX "AppListEntry_organizationId_appName_listType_isActive_key" ON "AppListEntry"("organizationId", "appName", "listType", "isActive");

-- CreateIndex
CREATE UNIQUE INDEX "UsbEvent_dedupeKey_key" ON "UsbEvent"("dedupeKey");
