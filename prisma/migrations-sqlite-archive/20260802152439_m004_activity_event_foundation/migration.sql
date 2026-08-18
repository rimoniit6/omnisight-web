-- AlterTable
ALTER TABLE "ActivityLog" ADD COLUMN "kind" TEXT;
ALTER TABLE "ActivityLog" ADD COLUMN "payload" JSONB;
ALTER TABLE "ActivityLog" ADD COLUMN "receivedAt" DATETIME;
ALTER TABLE "ActivityLog" ADD COLUMN "seq" INTEGER;
ALTER TABLE "ActivityLog" ADD COLUMN "sessionId" TEXT;
ALTER TABLE "ActivityLog" ADD COLUMN "source" TEXT;

-- CreateIndex
CREATE INDEX "ActivityLog_deviceId_idx" ON "ActivityLog"("deviceId");

-- CreateIndex
CREATE INDEX "ActivityLog_timestamp_idx" ON "ActivityLog"("timestamp");

-- CreateIndex
CREATE INDEX "ActivityLog_kind_idx" ON "ActivityLog"("kind");
