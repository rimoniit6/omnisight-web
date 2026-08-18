-- Phase 5 — on-demand webcam session METADATA only.
-- No video is ever persisted: frames live only in the in-memory relay with a
-- TTL. This table records session lifecycle + audit (who started/stopped and
-- why).

-- CreateTable
CREATE TABLE "WebcamSession" (
    "id" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "deviceId" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "commandId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'active',
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "endedAt" TIMESTAMP(3),
    "startedBy" TEXT NOT NULL,
    "endedReason" TEXT,
    "lastFrameAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "WebcamSession_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "WebcamSession_sessionId_key" ON "WebcamSession"("sessionId");

-- CreateIndex
CREATE INDEX "WebcamSession_organizationId_idx" ON "WebcamSession"("organizationId");

-- CreateIndex
CREATE INDEX "WebcamSession_employeeId_idx" ON "WebcamSession"("employeeId");

-- CreateIndex
CREATE INDEX "WebcamSession_deviceId_idx" ON "WebcamSession"("deviceId");

-- CreateIndex
CREATE INDEX "WebcamSession_deviceId_status_idx" ON "WebcamSession"("deviceId", "status");

-- AddForeignKey
ALTER TABLE "WebcamSession" ADD CONSTRAINT "WebcamSession_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "Employee"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WebcamSession" ADD CONSTRAINT "WebcamSession_deviceId_fkey" FOREIGN KEY ("deviceId") REFERENCES "Device"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WebcamSession" ADD CONSTRAINT "WebcamSession_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
