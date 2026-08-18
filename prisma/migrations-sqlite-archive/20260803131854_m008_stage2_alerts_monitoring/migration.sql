/*
  Warnings:

  - Added the required column `updatedAt` to the `Alert` table without a default value. This is not possible if the table is not empty.

*/
-- CreateTable
CREATE TABLE "AlertRule" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "type" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "severity" TEXT NOT NULL DEFAULT 'Medium',
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "config" TEXT NOT NULL DEFAULT '{}',
    "organizationId" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "AlertEvent" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "alertId" TEXT NOT NULL,
    "fromStatus" TEXT,
    "toStatus" TEXT NOT NULL,
    "actor" TEXT NOT NULL DEFAULT 'system',
    "note" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "AlertEvent_alertId_fkey" FOREIGN KEY ("alertId") REFERENCES "Alert" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "NotificationQueue" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "alertId" TEXT,
    "organizationId" TEXT,
    "kind" TEXT NOT NULL DEFAULT 'alert',
    "payload" TEXT NOT NULL,
    "priority" TEXT NOT NULL DEFAULT 'normal',
    "retryCount" INTEGER NOT NULL DEFAULT 0,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "processedAt" DATETIME
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
    "updatedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Alert_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "Alert_deviceId_fkey" FOREIGN KEY ("deviceId") REFERENCES "Device" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "Alert_ruleId_fkey" FOREIGN KEY ("ruleId") REFERENCES "AlertRule" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);
INSERT INTO "new_Alert" ("createdAt", "id", "message", "severity", "status", "timestamp", "type", "userId") SELECT "createdAt", "id", "message", "severity", "status", "timestamp", "type", "userId" FROM "Alert";
-- Existing legacy Alert rows: updatedAt = createdAt (safe backfill for the
-- additive-only column).
DROP TABLE "Alert";
ALTER TABLE "new_Alert" RENAME TO "Alert";
CREATE INDEX "Alert_organizationId_status_idx" ON "Alert"("organizationId", "status");
CREATE INDEX "Alert_deviceId_status_idx" ON "Alert"("deviceId", "status");
CREATE INDEX "Alert_type_status_idx" ON "Alert"("type", "status");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;

-- CreateIndex
CREATE INDEX "AlertRule_type_enabled_idx" ON "AlertRule"("type", "enabled");

-- CreateIndex
CREATE INDEX "AlertRule_organizationId_enabled_idx" ON "AlertRule"("organizationId", "enabled");

-- CreateIndex
CREATE INDEX "AlertEvent_alertId_createdAt_idx" ON "AlertEvent"("alertId", "createdAt");

-- CreateIndex
CREATE INDEX "NotificationQueue_status_priority_idx" ON "NotificationQueue"("status", "priority");

-- CreateIndex
CREATE INDEX "NotificationQueue_createdAt_idx" ON "NotificationQueue"("createdAt");

-- CreateIndex
CREATE INDEX "NotificationQueue_organizationId_status_idx" ON "NotificationQueue"("organizationId", "status");
