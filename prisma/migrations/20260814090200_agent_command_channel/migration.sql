-- Phase 4 — narrowly-scoped server → agent command channel.
-- Commands are device-bound + org-scoped, allowlisted, expiring, and move
-- PENDING → DELIVERED → ACKNOWLEDGED (atomic delivery prevents replay).

-- CreateTable
CREATE TABLE "AgentCommand" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "deviceId" TEXT NOT NULL,
    "commandType" TEXT NOT NULL,
    "payload" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "deliveredAt" TIMESTAMP(3),
    "acknowledgedAt" TIMESTAMP(3),

    CONSTRAINT "AgentCommand_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "AgentCommand_deviceId_status_idx" ON "AgentCommand"("deviceId", "status");

-- CreateIndex
CREATE INDEX "AgentCommand_organizationId_status_idx" ON "AgentCommand"("organizationId", "status");

-- CreateIndex
CREATE INDEX "AgentCommand_status_expiresAt_idx" ON "AgentCommand"("status", "expiresAt");

-- AddForeignKey
ALTER TABLE "AgentCommand" ADD CONSTRAINT "AgentCommand_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AgentCommand" ADD CONSTRAINT "AgentCommand_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "Employee"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AgentCommand" ADD CONSTRAINT "AgentCommand_deviceId_fkey" FOREIGN KEY ("deviceId") REFERENCES "Device"("id") ON DELETE CASCADE ON UPDATE CASCADE;
