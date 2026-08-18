-- OmniSight — Guest / Zero-Touch Person Enrollment (guest_enrollment)
--
-- A person-level enrollment created when an admin approves a zero-touch
-- DeviceClaim in GUEST mode (no employee credentials, no AgentAccount). The
-- guest is backed by a synthesized Employee row (Employee.type = 'guest') so
-- ALL existing runtime machinery (AgentToken, AgentSession, Consent,
-- telemetry, config, heartbeat, break) works unchanged.
--
-- 1. New Guest model (org-scoped, lifecycle PENDING/ACTIVE/REJECTED/REVOKED/
--    SUSPENDED, approval audit fields).
-- 2. Employee.type ('employee' | 'guest', default 'employee') + Employee.guestId
--    (1:1 back-link, SetNull on guest deletion).
-- 3. Partial unique indexes (Prisma cannot express partial indexes — same
--    pattern as BreakSession_one_active_per_employee): at most ONE ACTIVE and
--    ONE PENDING guest per device. Guest.employeeId is globally unique so a
--    guest can never be linked to a second employee.

-- CreateTable
CREATE TABLE "Guest" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "deviceId" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "approvedAt" TIMESTAMP(3),
    "approvedBy" TEXT,
    "rejectedAt" TIMESTAMP(3),
    "rejectedBy" TEXT,
    "revokedAt" TIMESTAMP(3),
    "revokedBy" TEXT,
    "suspendedAt" TIMESTAMP(3),
    "suspendedBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Guest_pkey" PRIMARY KEY ("id")
);

-- AlterTable
ALTER TABLE "Employee" ADD COLUMN     "type" TEXT NOT NULL DEFAULT 'employee',
ADD COLUMN     "guestId" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "Guest_employeeId_key" ON "Guest"("employeeId");

-- CreateIndex
CREATE INDEX "Guest_organizationId_idx" ON "Guest"("organizationId");

-- CreateIndex
CREATE INDEX "Guest_organizationId_status_idx" ON "Guest"("organizationId", "status");

-- CreateIndex
CREATE INDEX "Guest_deviceId_idx" ON "Guest"("deviceId");

-- CreateIndex
CREATE INDEX "Guest_status_idx" ON "Guest"("status");

-- CreateIndex
CREATE INDEX "Guest_createdAt_idx" ON "Guest"("createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "Employee_guestId_key" ON "Employee"("guestId");

-- AddForeignKey
ALTER TABLE "Guest" ADD CONSTRAINT "Guest_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Guest" ADD CONSTRAINT "Guest_deviceId_fkey" FOREIGN KEY ("deviceId") REFERENCES "Device"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Guest" ADD CONSTRAINT "Guest_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "Employee"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Employee" ADD CONSTRAINT "Employee_guestId_fkey" FOREIGN KEY ("guestId") REFERENCES "Guest"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- DB-level guarantees Prisma cannot express as partial unique indexes:
--   * at most ONE ACTIVE guest per device
--   * at most ONE PENDING guest per device
-- (rejected/revoked/suspended guests may accumulate as history).
CREATE UNIQUE INDEX "Guest_one_active_per_device" ON "Guest"("deviceId") WHERE "status" = 'ACTIVE';
CREATE UNIQUE INDEX "Guest_one_pending_per_device" ON "Guest"("deviceId") WHERE "status" = 'PENDING';
