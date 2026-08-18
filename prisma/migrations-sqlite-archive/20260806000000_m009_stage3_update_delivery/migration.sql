-- M009 Stage-3 — Enterprise Update Delivery, Binary Distribution &
-- Operational Reliability (additive-only)

-- ── Device: maintenance-mode denormalised gate (mission §4) ──
ALTER TABLE "Device" ADD COLUMN "maintenanceMode" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "Device" ADD COLUMN "maintenanceUntil" DATETIME;

-- ── AgentRelease: binary distribution metadata (mission §1) ──
ALTER TABLE "AgentRelease" ADD COLUMN "binaryStatus" TEXT NOT NULL DEFAULT 'metadata_only';
ALTER TABLE "AgentRelease" ADD COLUMN "binarySize" INTEGER;
ALTER TABLE "AgentRelease" ADD COLUMN "binaryFileName" TEXT;
ALTER TABLE "AgentRelease" ADD COLUMN "binaryMimeType" TEXT;
ALTER TABLE "AgentRelease" ADD COLUMN "downloadCount" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "AgentRelease" ADD COLUMN "retentionDays" INTEGER NOT NULL DEFAULT 365;
ALTER TABLE "AgentRelease" ADD COLUMN "retentionUntil" DATETIME;

-- ── AgentRollout — staged rollout definitions + progress (mission §2) ──
CREATE TABLE "AgentRollout" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT,
    "releaseVersion" TEXT NOT NULL,
    "scope" TEXT NOT NULL DEFAULT 'global',
    "scopeId" TEXT,
    "percentage" INTEGER NOT NULL DEFAULT 5,
    "status" TEXT NOT NULL DEFAULT 'draft',
    "targetedDevices" INTEGER NOT NULL DEFAULT 0,
    "updatedDevices" INTEGER NOT NULL DEFAULT 0,
    "failedDevices" INTEGER NOT NULL DEFAULT 0,
    "pendingDevices" INTEGER NOT NULL DEFAULT 0,
    "pausedAt" DATETIME,
    "resumedAt" DATETIME,
    "startedAt" DATETIME,
    "completedAt" DATETIME,
    "createdBy" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);
CREATE INDEX "AgentRollout_scope_scopeId_status_idx" ON "AgentRollout"("scope", "scopeId", "status");
CREATE INDEX "AgentRollout_status_percentage_idx" ON "AgentRollout"("status", "percentage");
CREATE INDEX "AgentRollout_releaseVersion_status_idx" ON "AgentRollout"("releaseVersion", "status");

-- ── AgentRolloutDevice — per-device rollout progress (mission §2) ──
CREATE TABLE "AgentRolloutDevice" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "rolloutId" TEXT NOT NULL,
    "deviceId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'targeted',
    "attemptCount" INTEGER NOT NULL DEFAULT 0,
    "error" TEXT,
    "targetedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "startedAt" DATETIME,
    "completedAt" DATETIME,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "AgentRolloutDevice_rolloutId_fkey" FOREIGN KEY ("rolloutId") REFERENCES "AgentRollout" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "AgentRolloutDevice_deviceId_fkey" FOREIGN KEY ("deviceId") REFERENCES "Device" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "AgentRolloutDevice_rolloutId_deviceId_key" ON "AgentRolloutDevice"("rolloutId", "deviceId");
CREATE INDEX "AgentRolloutDevice_rolloutId_status_idx" ON "AgentRolloutDevice"("rolloutId", "status");
CREATE INDEX "AgentRolloutDevice_deviceId_status_idx" ON "AgentRolloutDevice"("deviceId", "status");

-- ── AgentRollback — rollback operations (mission §3) ──
CREATE TABLE "AgentRollback" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "reason" TEXT NOT NULL,
    "initiatedBy" TEXT NOT NULL,
    "scope" TEXT NOT NULL,
    "scopeId" TEXT,
    "fromVersion" TEXT,
    "toVersion" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'queued',
    "affectedDevices" INTEGER NOT NULL DEFAULT 0,
    "succeeded" INTEGER NOT NULL DEFAULT 0,
    "failed" INTEGER NOT NULL DEFAULT 0,
    "error" TEXT,
    "startedAt" DATETIME,
    "completedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX "AgentRollback_scope_scopeId_idx" ON "AgentRollback"("scope", "scopeId");
CREATE INDEX "AgentRollback_status_createdAt_idx" ON "AgentRollback"("status", "createdAt");

-- ── AgentMaintenance — maintenance windows (mission §4) ──
CREATE TABLE "AgentMaintenance" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "deviceId" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "reason" TEXT,
    "initiatedBy" TEXT,
    "suspendCommands" BOOLEAN NOT NULL DEFAULT true,
    "suspendUpdates" BOOLEAN NOT NULL DEFAULT true,
    "suspendScreenshots" BOOLEAN NOT NULL DEFAULT true,
    "suspendOcr" BOOLEAN NOT NULL DEFAULT true,
    "startedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "endsAt" DATETIME,
    "status" TEXT NOT NULL DEFAULT 'active',
    "endedAt" DATETIME,
    "endedBy" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "AgentMaintenance_deviceId_fkey" FOREIGN KEY ("deviceId") REFERENCES "Device" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX "AgentMaintenance_deviceId_status_idx" ON "AgentMaintenance"("deviceId", "status");
CREATE INDEX "AgentMaintenance_status_endsAt_idx" ON "AgentMaintenance"("status", "endsAt");

-- ── AgentDeadLetter — dead-letter queue (mission §5) ──
CREATE TABLE "AgentDeadLetter" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "source" TEXT NOT NULL,
    "sourceId" TEXT NOT NULL,
    "deviceId" TEXT,
    "error" TEXT,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "payload" TEXT,
    "status" TEXT NOT NULL DEFAULT 'queued',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastAttemptAt" DATETIME,
    "processedAt" DATETIME
);
CREATE UNIQUE INDEX "AgentDeadLetter_source_sourceId_key" ON "AgentDeadLetter"("source", "sourceId");
CREATE INDEX "AgentDeadLetter_status_createdAt_idx" ON "AgentDeadLetter"("status", "createdAt");
CREATE INDEX "AgentDeadLetter_deviceId_status_idx" ON "AgentDeadLetter"("deviceId", "status");

-- ── AgentRetryJob — durable retry scheduling (mission §5) ──
CREATE TABLE "AgentRetryJob" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "targetType" TEXT NOT NULL,
    "targetId" TEXT NOT NULL,
    "deviceId" TEXT,
    "attemptCount" INTEGER NOT NULL DEFAULT 0,
    "maxAttempts" INTEGER NOT NULL DEFAULT 3,
    "backoffMs" INTEGER NOT NULL DEFAULT 5000,
    "nextAttemptAt" DATETIME NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'scheduled',
    "error" TEXT,
    "payload" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);
CREATE INDEX "AgentRetryJob_status_nextAttemptAt_idx" ON "AgentRetryJob"("status", "nextAttemptAt");
CREATE INDEX "AgentRetryJob_targetType_targetId_idx" ON "AgentRetryJob"("targetType", "targetId");

-- ── StorageStat — storage utilisation snapshots (mission §7) ──
CREATE TABLE "StorageStat" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "category" TEXT NOT NULL,
    "bytesMb" INTEGER NOT NULL DEFAULT 0,
    "fileCount" INTEGER NOT NULL DEFAULT 0,
    "recordedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX "StorageStat_category_recordedAt_idx" ON "StorageStat"("category", "recordedAt");

-- ── StorageCleanup — storage lifecycle log (mission §7) ──
CREATE TABLE "StorageCleanup" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "action" TEXT NOT NULL,
    "category" TEXT,
    "detail" TEXT,
    "ranBy" TEXT NOT NULL DEFAULT 'worker',
    "ranAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX "StorageCleanup_ranAt_idx" ON "StorageCleanup"("ranAt");
