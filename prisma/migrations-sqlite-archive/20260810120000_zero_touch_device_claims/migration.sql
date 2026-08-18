-- Phase B — Zero-touch desktop agent discovery
-- Additive only: stable machine identity on Device + DeviceClaim (pending device).

-- Stable machine identity for zero-touch discovery (one per agent install).
ALTER TABLE "Device" ADD COLUMN "agentKey" TEXT;
CREATE UNIQUE INDEX "Device_agentKey_key" ON "Device"("agentKey");

-- A discovered-but-unassigned device awaiting admin approval. Approval binds
-- the device to an employee; it NEVER grants consent (separate boundary).
CREATE TABLE "DeviceClaim" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "organizationId" TEXT NOT NULL,
    "deviceId" TEXT NOT NULL,
    "claimSecretHash" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "employeeId" TEXT,
    "approvedBy" TEXT,
    "approvedAt" DATETIME,
    "rejectedAt" DATETIME,
    "rejectionReason" TEXT,
    "expiresAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "DeviceClaim_deviceId_fkey" FOREIGN KEY ("deviceId") REFERENCES "Device" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "DeviceClaim_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "Employee" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "DeviceClaim_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "DeviceClaim_deviceId_key" ON "DeviceClaim"("deviceId");
CREATE INDEX "DeviceClaim_organizationId_idx" ON "DeviceClaim"("organizationId");
CREATE INDEX "DeviceClaim_status_idx" ON "DeviceClaim"("status");
CREATE INDEX "DeviceClaim_employeeId_idx" ON "DeviceClaim"("employeeId");
