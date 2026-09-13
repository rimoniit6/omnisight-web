-- CreateTable
CREATE TABLE "RealtimeScreenshotEvent" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "employeeName" TEXT,
    "appWindow" TEXT,
    "capturedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RealtimeScreenshotEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "RealtimeScreenshotEvent_createdAt_idx" ON "RealtimeScreenshotEvent"("createdAt");

-- CreateIndex
CREATE INDEX "RealtimeScreenshotEvent_organizationId_createdAt_idx" ON "RealtimeScreenshotEvent"("organizationId", "createdAt");
