-- DropIndex
DROP INDEX "AISummary_scope_scopeId_type_version_idx";

-- CreateTable
CREATE TABLE "AgentCommand" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "deviceId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'queued',
    "priority" INTEGER NOT NULL DEFAULT 0,
    "dedupKey" TEXT,
    "params" TEXT,
    "result" TEXT,
    "error" TEXT,
    "requestedBy" TEXT,
    "retryCount" INTEGER NOT NULL DEFAULT 0,
    "maxRetries" INTEGER NOT NULL DEFAULT 3,
    "queuedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "startedAt" DATETIME,
    "completedAt" DATETIME,
    "timeoutAt" DATETIME,
    "expiresAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "AgentCommand_deviceId_fkey" FOREIGN KEY ("deviceId") REFERENCES "Device" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "AgentPolicy" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "scope" TEXT NOT NULL,
    "scopeId" TEXT,
    "config" TEXT NOT NULL DEFAULT '{}',
    "version" INTEGER NOT NULL DEFAULT 1,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "createdBy" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "AgentRelease" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "version" TEXT NOT NULL,
    "required" BOOLEAN NOT NULL DEFAULT false,
    "channel" TEXT NOT NULL DEFAULT 'stable',
    "notes" TEXT,
    "releasedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "AgentUpdate" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "deviceId" TEXT NOT NULL,
    "fromVersion" TEXT,
    "toVersion" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "error" TEXT,
    "startedAt" DATETIME,
    "completedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "AgentUpdate_deviceId_fkey" FOREIGN KEY ("deviceId") REFERENCES "Device" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "AgentBulkOperation" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "operation" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'queued',
    "targetFilter" TEXT,
    "params" TEXT,
    "results" TEXT,
    "total" INTEGER NOT NULL DEFAULT 0,
    "succeeded" INTEGER NOT NULL DEFAULT 0,
    "failed" INTEGER NOT NULL DEFAULT 0,
    "error" TEXT,
    "requestedBy" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "startedAt" DATETIME,
    "completedAt" DATETIME,
    "updatedAt" DATETIME NOT NULL
);

-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_Alert" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT,
    "deviceId" TEXT,
    "ruleId" TEXT,
    "organizationId" TEXT,
    "type" TEXT NOT NULL,
    "severity" TEXT NOT NULL DEFAULT 'Medium',
    "message" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'Open',
    "value" TEXT,
    "acknowledgedBy" TEXT,
    "acknowledgedAt" DATETIME,
    "resolvedBy" TEXT,
    "resolvedAt" DATETIME,
    "timestamp" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "Alert_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "Alert_deviceId_fkey" FOREIGN KEY ("deviceId") REFERENCES "Device" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "Alert_ruleId_fkey" FOREIGN KEY ("ruleId") REFERENCES "AlertRule" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);
INSERT INTO "new_Alert" ("acknowledgedAt", "acknowledgedBy", "createdAt", "deviceId", "id", "message", "organizationId", "resolvedAt", "resolvedBy", "ruleId", "severity", "status", "timestamp", "type", "updatedAt", "userId", "value") SELECT "acknowledgedAt", "acknowledgedBy", "createdAt", "deviceId", "id", "message", "organizationId", "resolvedAt", "resolvedBy", "ruleId", "severity", "status", "timestamp", "type", "updatedAt", "userId", "value" FROM "Alert";
DROP TABLE "Alert";
ALTER TABLE "new_Alert" RENAME TO "Alert";
CREATE INDEX "Alert_organizationId_status_idx" ON "Alert"("organizationId", "status");
CREATE INDEX "Alert_deviceId_status_idx" ON "Alert"("deviceId", "status");
CREATE INDEX "Alert_type_status_idx" ON "Alert"("type", "status");
CREATE TABLE "new_AlertRule" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "type" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "severity" TEXT NOT NULL DEFAULT 'Medium',
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "config" TEXT NOT NULL DEFAULT '{}',
    "organizationId" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);
INSERT INTO "new_AlertRule" ("config", "createdAt", "description", "enabled", "id", "name", "organizationId", "severity", "type", "updatedAt") SELECT "config", "createdAt", "description", "enabled", "id", "name", "organizationId", "severity", "type", "updatedAt" FROM "AlertRule";
DROP TABLE "AlertRule";
ALTER TABLE "new_AlertRule" RENAME TO "AlertRule";
CREATE INDEX "AlertRule_type_enabled_idx" ON "AlertRule"("type", "enabled");
CREATE INDEX "AlertRule_organizationId_enabled_idx" ON "AlertRule"("organizationId", "enabled");
CREATE TABLE "new_Device" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "deviceId" TEXT,
    "hostname" TEXT NOT NULL,
    "os" TEXT NOT NULL DEFAULT 'Windows 11',
    "osVersion" TEXT,
    "cpu" TEXT,
    "ram" INTEGER,
    "diskSpace" INTEGER,
    "ipAddress" TEXT,
    "macAddress" TEXT,
    "agentVersion" TEXT NOT NULL DEFAULT '1.0.3',
    "status" TEXT NOT NULL DEFAULT 'Online',
    "lastSeen" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "location" TEXT,
    "domainJoined" BOOLEAN NOT NULL DEFAULT true,
    "deviceType" TEXT NOT NULL DEFAULT 'Corporate',
    "organizationId" TEXT,
    "installationId" TEXT,
    "hardwareFingerprint" TEXT,
    "lastHeartbeatAt" DATETIME,
    "lastErrorAt" DATETIME,
    "highWaterMark" INTEGER NOT NULL DEFAULT 0,
    "capabilities" TEXT,
    "agentPlatform" TEXT,
    "agentArch" TEXT,
    "effectivePolicy" TEXT,
    "effectivePolicyVersion" INTEGER NOT NULL DEFAULT 0,
    "updateStatus" TEXT NOT NULL DEFAULT 'up_to_date',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "Device_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "Device_installationId_fkey" FOREIGN KEY ("installationId") REFERENCES "Installation" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);
INSERT INTO "new_Device" ("agentArch", "agentPlatform", "agentVersion", "capabilities", "cpu", "createdAt", "deviceId", "deviceType", "diskSpace", "domainJoined", "hardwareFingerprint", "highWaterMark", "hostname", "id", "installationId", "ipAddress", "lastErrorAt", "lastHeartbeatAt", "lastSeen", "location", "macAddress", "organizationId", "os", "osVersion", "ram", "status", "updatedAt") SELECT "agentArch", "agentPlatform", "agentVersion", "capabilities", "cpu", "createdAt", "deviceId", "deviceType", "diskSpace", "domainJoined", "hardwareFingerprint", "highWaterMark", "hostname", "id", "installationId", "ipAddress", "lastErrorAt", "lastHeartbeatAt", "lastSeen", "location", "macAddress", "organizationId", "os", "osVersion", "ram", "status", "updatedAt" FROM "Device";
DROP TABLE "Device";
ALTER TABLE "new_Device" RENAME TO "Device";
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;

-- CreateIndex
CREATE INDEX "AgentCommand_deviceId_status_idx" ON "AgentCommand"("deviceId", "status");

-- CreateIndex
CREATE INDEX "AgentCommand_status_priority_queuedAt_idx" ON "AgentCommand"("status", "priority", "queuedAt");

-- CreateIndex
CREATE INDEX "AgentCommand_dedupKey_status_idx" ON "AgentCommand"("dedupKey", "status");

-- CreateIndex
CREATE INDEX "AgentCommand_expiresAt_idx" ON "AgentCommand"("expiresAt");

-- CreateIndex
CREATE INDEX "AgentPolicy_scope_scopeId_idx" ON "AgentPolicy"("scope", "scopeId");

-- CreateIndex
CREATE INDEX "AgentPolicy_scope_enabled_idx" ON "AgentPolicy"("scope", "enabled");

-- CreateIndex
CREATE UNIQUE INDEX "AgentRelease_version_key" ON "AgentRelease"("version");

-- CreateIndex
CREATE INDEX "AgentUpdate_deviceId_status_idx" ON "AgentUpdate"("deviceId", "status");

-- CreateIndex
CREATE INDEX "AgentUpdate_status_idx" ON "AgentUpdate"("status");

-- CreateIndex
CREATE INDEX "AgentBulkOperation_status_createdAt_idx" ON "AgentBulkOperation"("status", "createdAt");

-- CreateIndex
CREATE INDEX "AISummary_scope_scopeId_insightType_modelVersion_idx" ON "AISummary"("scope", "scopeId", "insightType", "modelVersion");
