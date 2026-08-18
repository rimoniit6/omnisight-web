/*
  Warnings:

  - Made the column `deviceId` on table `Screenshot` required. This step will fail if there are existing NULL values in that column.

*/
-- CreateTable
CREATE TABLE "UploadTicket" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "deviceId" TEXT NOT NULL,
    "sha256" TEXT NOT NULL,
    "size" INTEGER NOT NULL,
    "chunkSize" INTEGER NOT NULL DEFAULT 262144,
    "totalChunks" INTEGER NOT NULL,
    "receivedBitmap" TEXT,
    "receivedBytes" INTEGER NOT NULL DEFAULT 0,
    "status" TEXT NOT NULL DEFAULT 'open',
    "expiresAt" DATETIME NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "UploadTicket_deviceId_fkey" FOREIGN KEY ("deviceId") REFERENCES "Device" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_Screenshot" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT,
    "deviceId" TEXT NOT NULL,
    "ocrText" TEXT,
    "ocrKeywords" TEXT,
    "ocrConfidence" INTEGER NOT NULL DEFAULT 0,
    "sensitiveDataDetected" BOOLEAN NOT NULL DEFAULT false,
    "aiSummary" TEXT,
    "productivity" INTEGER NOT NULL DEFAULT 0,
    "flagged" BOOLEAN NOT NULL DEFAULT false,
    "reason" TEXT,
    "multiMonitor" BOOLEAN NOT NULL DEFAULT false,
    "blurSensitive" BOOLEAN NOT NULL DEFAULT true,
    "watermark" BOOLEAN NOT NULL DEFAULT true,
    "compression" TEXT NOT NULL DEFAULT 'WebP',
    "sha256" TEXT,
    "storagePath" TEXT,
    "size" INTEGER,
    "format" TEXT NOT NULL DEFAULT 'WebP',
    "width" INTEGER,
    "height" INTEGER,
    "monitorId" INTEGER NOT NULL DEFAULT 0,
    "uploadId" TEXT,
    "privacyMode" BOOLEAN NOT NULL DEFAULT false,
    "dedupRef" TEXT,
    "sessionId" TEXT,
    "timestamp" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Screenshot_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "Screenshot_deviceId_fkey" FOREIGN KEY ("deviceId") REFERENCES "Device" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "Screenshot_uploadId_fkey" FOREIGN KEY ("uploadId") REFERENCES "UploadTicket" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "Screenshot_dedupRef_fkey" FOREIGN KEY ("dedupRef") REFERENCES "Screenshot" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "Screenshot_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "LoginSession" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);
INSERT INTO "new_Screenshot" ("aiSummary", "blurSensitive", "compression", "createdAt", "deviceId", "flagged", "id", "multiMonitor", "ocrConfidence", "ocrKeywords", "ocrText", "productivity", "reason", "sensitiveDataDetected", "timestamp", "userId", "watermark") SELECT "aiSummary", "blurSensitive", "compression", "createdAt", "deviceId", "flagged", "id", "multiMonitor", "ocrConfidence", "ocrKeywords", "ocrText", "productivity", "reason", "sensitiveDataDetected", "timestamp", "userId", "watermark" FROM "Screenshot";
DROP TABLE "Screenshot";
ALTER TABLE "new_Screenshot" RENAME TO "Screenshot";
CREATE UNIQUE INDEX "Screenshot_uploadId_key" ON "Screenshot"("uploadId");
CREATE INDEX "Screenshot_userId_timestamp_idx" ON "Screenshot"("userId", "timestamp" DESC);
CREATE INDEX "Screenshot_deviceId_timestamp_idx" ON "Screenshot"("deviceId", "timestamp" DESC);
CREATE INDEX "Screenshot_flagged_idx" ON "Screenshot"("flagged");
CREATE INDEX "Screenshot_sensitiveDataDetected_idx" ON "Screenshot"("sensitiveDataDetected");
CREATE UNIQUE INDEX "Screenshot_sha256_key" ON "Screenshot"("sha256");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;

-- CreateIndex
CREATE INDEX "UploadTicket_deviceId_status_idx" ON "UploadTicket"("deviceId", "status");

-- CreateIndex
CREATE INDEX "UploadTicket_expiresAt_idx" ON "UploadTicket"("expiresAt");
