-- CreateTable
CREATE TABLE "Installation" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "joinKeyHash" TEXT NOT NULL,
    "joinKeyHint" TEXT,
    "minAgentVersion" TEXT NOT NULL DEFAULT '0.1.0',
    "settings" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "AgentCredential" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "deviceId" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "prevTokenHash" TEXT,
    "issuedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" DATETIME NOT NULL,
    "rotatedAt" DATETIME,
    "revokedAt" DATETIME,
    "revokeReason" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "AgentCredential_deviceId_fkey" FOREIGN KEY ("deviceId") REFERENCES "Device" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "DeviceAssignment" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "deviceId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "assignedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revokedAt" DATETIME,
    "assignedBy" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "DeviceAssignment_deviceId_fkey" FOREIGN KEY ("deviceId") REFERENCES "Device" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "DeviceAssignment_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
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
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "Device_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "Device_installationId_fkey" FOREIGN KEY ("installationId") REFERENCES "Installation" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);
INSERT INTO "new_Device" ("agentVersion", "cpu", "createdAt", "deviceId", "deviceType", "diskSpace", "domainJoined", "hostname", "id", "ipAddress", "lastSeen", "location", "macAddress", "organizationId", "os", "osVersion", "ram", "status", "updatedAt") SELECT "agentVersion", "cpu", "createdAt", "deviceId", "deviceType", "diskSpace", "domainJoined", "hostname", "id", "ipAddress", "lastSeen", "location", "macAddress", "organizationId", "os", "osVersion", "ram", "status", "updatedAt" FROM "Device";
DROP TABLE "Device";
ALTER TABLE "new_Device" RENAME TO "Device";
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;

-- CreateIndex
CREATE UNIQUE INDEX "AgentCredential_tokenHash_key" ON "AgentCredential"("tokenHash");

-- CreateIndex
CREATE INDEX "AgentCredential_deviceId_issuedAt_idx" ON "AgentCredential"("deviceId", "issuedAt");

-- CreateIndex
CREATE INDEX "DeviceAssignment_deviceId_revokedAt_idx" ON "DeviceAssignment"("deviceId", "revokedAt");

-- CreateIndex
CREATE INDEX "DeviceAssignment_userId_revokedAt_idx" ON "DeviceAssignment"("userId", "revokedAt");

-- Raw SQL (ADR-029): partial unique index — one ACTIVE assignment per device
CREATE UNIQUE INDEX "DeviceAssignment_deviceId_active_idx" ON "DeviceAssignment"("deviceId") WHERE "revokedAt" IS NULL;

-- Demo data backfill (M003): create one default Installation and link existing devices
INSERT INTO "Installation" ("id", "name", "joinKeyHash", "joinKeyHint", "minAgentVersion", "settings", "createdAt", "updatedAt")
SELECT 'inst_demo_default', 'Default Installation', '4b5b09999a997d513f948660b8b7c0571b607f374a415a47d8efeef6583e290e', '290e', '0.1.0', NULL, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
WHERE NOT EXISTS (SELECT 1 FROM "Installation" WHERE "id" = 'inst_demo_default');

UPDATE "Device" SET "installationId" = 'inst_demo_default' WHERE "installationId" IS NULL;
