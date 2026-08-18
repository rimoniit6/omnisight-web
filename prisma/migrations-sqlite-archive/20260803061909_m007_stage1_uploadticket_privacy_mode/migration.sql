-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_UploadTicket" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "deviceId" TEXT NOT NULL,
    "sha256" TEXT NOT NULL,
    "size" INTEGER NOT NULL,
    "chunkSize" INTEGER NOT NULL DEFAULT 262144,
    "totalChunks" INTEGER NOT NULL,
    "privacyMode" BOOLEAN NOT NULL DEFAULT false,
    "receivedBitmap" TEXT,
    "receivedBytes" INTEGER NOT NULL DEFAULT 0,
    "status" TEXT NOT NULL DEFAULT 'open',
    "expiresAt" DATETIME NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "UploadTicket_deviceId_fkey" FOREIGN KEY ("deviceId") REFERENCES "Device" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
INSERT INTO "new_UploadTicket" ("chunkSize", "createdAt", "deviceId", "expiresAt", "id", "receivedBitmap", "receivedBytes", "sha256", "size", "status", "totalChunks", "updatedAt") SELECT "chunkSize", "createdAt", "deviceId", "expiresAt", "id", "receivedBitmap", "receivedBytes", "sha256", "size", "status", "totalChunks", "updatedAt" FROM "UploadTicket";
DROP TABLE "UploadTicket";
ALTER TABLE "new_UploadTicket" RENAME TO "UploadTicket";
CREATE INDEX "UploadTicket_deviceId_status_idx" ON "UploadTicket"("deviceId", "status");
CREATE INDEX "UploadTicket_expiresAt_idx" ON "UploadTicket"("expiresAt");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
