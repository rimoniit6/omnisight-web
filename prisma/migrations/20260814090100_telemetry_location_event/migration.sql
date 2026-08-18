-- Phase 3 — Windows-native geolocation telemetry.
-- Coordinates + accuracy + timestamp only. Addresses are NEVER stored.

-- CreateTable
CREATE TABLE "LocationEvent" (
    "id" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "deviceId" TEXT,
    "latitude" DOUBLE PRECISION NOT NULL,
    "longitude" DOUBLE PRECISION NOT NULL,
    "accuracy" DOUBLE PRECISION NOT NULL,
    "recordedAt" TIMESTAMP(3) NOT NULL,
    "organizationId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "LocationEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "LocationEvent_employeeId_recordedAt_idx" ON "LocationEvent"("employeeId", "recordedAt");

-- CreateIndex
CREATE INDEX "LocationEvent_deviceId_recordedAt_idx" ON "LocationEvent"("deviceId", "recordedAt");

-- CreateIndex
CREATE INDEX "LocationEvent_organizationId_idx" ON "LocationEvent"("organizationId");

-- AddForeignKey
ALTER TABLE "LocationEvent" ADD CONSTRAINT "LocationEvent_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "Employee"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LocationEvent" ADD CONSTRAINT "LocationEvent_deviceId_fkey" FOREIGN KEY ("deviceId") REFERENCES "Device"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LocationEvent" ADD CONSTRAINT "LocationEvent_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
