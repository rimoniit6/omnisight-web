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
    "ocrStatus" TEXT NOT NULL DEFAULT 'none',
    "ocrQueuedAt" DATETIME,
    "ocrLockedAt" DATETIME,
    "ocrAttempts" INTEGER NOT NULL DEFAULT 0,
    "ocrRetryable" BOOLEAN NOT NULL DEFAULT true,
    "ocrLanguage" TEXT NOT NULL DEFAULT 'eng',
    "ocrEngine" TEXT,
    "ocrEngineVersion" TEXT,
    "ocrDuration" INTEGER,
    "ocrProcessedAt" DATETIME,
    "ocrFailure" TEXT,
    "ocrFailureDetail" TEXT,
    CONSTRAINT "Screenshot_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "Screenshot_deviceId_fkey" FOREIGN KEY ("deviceId") REFERENCES "Device" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "Screenshot_uploadId_fkey" FOREIGN KEY ("uploadId") REFERENCES "UploadTicket" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "Screenshot_dedupRef_fkey" FOREIGN KEY ("dedupRef") REFERENCES "Screenshot" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "Screenshot_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "LoginSession" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);
INSERT INTO "new_Screenshot" ("aiSummary", "blurSensitive", "compression", "createdAt", "dedupRef", "deviceId", "flagged", "format", "height", "id", "monitorId", "multiMonitor", "ocrConfidence", "ocrKeywords", "ocrText", "privacyMode", "productivity", "reason", "sensitiveDataDetected", "sessionId", "sha256", "size", "storagePath", "timestamp", "uploadId", "userId", "watermark", "width") SELECT "aiSummary", "blurSensitive", "compression", "createdAt", "dedupRef", "deviceId", "flagged", "format", "height", "id", "monitorId", "multiMonitor", "ocrConfidence", "ocrKeywords", "ocrText", "privacyMode", "productivity", "reason", "sensitiveDataDetected", "sessionId", "sha256", "size", "storagePath", "timestamp", "uploadId", "userId", "watermark", "width" FROM "Screenshot";
DROP TABLE "Screenshot";
ALTER TABLE "new_Screenshot" RENAME TO "Screenshot";
CREATE UNIQUE INDEX "Screenshot_uploadId_key" ON "Screenshot"("uploadId");
CREATE INDEX "Screenshot_userId_timestamp_idx" ON "Screenshot"("userId", "timestamp" DESC);
CREATE INDEX "Screenshot_deviceId_timestamp_idx" ON "Screenshot"("deviceId", "timestamp" DESC);
CREATE INDEX "Screenshot_flagged_idx" ON "Screenshot"("flagged");
CREATE INDEX "Screenshot_sensitiveDataDetected_idx" ON "Screenshot"("sensitiveDataDetected");
CREATE INDEX "Screenshot_ocrStatus_ocrQueuedAt_idx" ON "Screenshot"("ocrStatus", "ocrQueuedAt");
CREATE INDEX "Screenshot_ocrConfidence_idx" ON "Screenshot"("ocrConfidence");
CREATE UNIQUE INDEX "Screenshot_sha256_key" ON "Screenshot"("sha256");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
