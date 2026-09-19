-- OmniSight hardening area 4 — rolling anomaly baselines + device-claim reminders
-- Migration ID: 20260919020000_employee_baseline_and_anomaly_grace
-- Run manually via: prisma db execute --file <this> --schema prisma/schema.prisma

-- 1. Employee.anomalyGraceUntil — grace period gate for the anomaly detector.
ALTER TABLE "Employee" ADD COLUMN IF NOT EXISTS "anomalyGraceUntil" TIMESTAMP(3);

-- 2. EmployeeBaseline — persisted per-employee rolling 30-day baseline.
CREATE TABLE IF NOT EXISTS "EmployeeBaseline" (
    "id"                TEXT        NOT NULL,
    "employeeId"        TEXT        NOT NULL,
    "organizationId"    TEXT        NOT NULL,
    "windowStart"       TIMESTAMP(3) NOT NULL,
    "windowEnd"         TIMESTAMP(3) NOT NULL,
    "activityDays"      INTEGER     NOT NULL DEFAULT 0,
    "totalMinutes"      INTEGER     NOT NULL DEFAULT 0,
    "productiveMinutes" INTEGER     NOT NULL DEFAULT 0,
    "productiveRatio"   DOUBLE PRECISION NOT NULL DEFAULT 0,
    "avgDailyMinutes"   DOUBLE PRECISION NOT NULL DEFAULT 0,
    "avgIdleMinutes"    DOUBLE PRECISION NOT NULL DEFAULT 0,
    "offHoursPerDay"    DOUBLE PRECISION NOT NULL DEFAULT 0,
    "appsPerDay"        DOUBLE PRECISION NOT NULL DEFAULT 0,
    "computedAt"        TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "EmployeeBaseline_pkey" PRIMARY KEY ("id")
);

-- 1:1 with Employee (CASCADE — a deleted employee takes its baseline).
ALTER TABLE "EmployeeBaseline" DROP CONSTRAINT IF EXISTS "EmployeeBaseline_employeeId_fkey";
ALTER TABLE "EmployeeBaseline" ADD CONSTRAINT "EmployeeBaseline_employeeId_fkey"
    FOREIGN KEY ("employeeId") REFERENCES "Employee"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "EmployeeBaseline" DROP CONSTRAINT IF EXISTS "EmployeeBaseline_organizationId_fkey";
ALTER TABLE "EmployeeBaseline" ADD CONSTRAINT "EmployeeBaseline_organizationId_fkey"
    FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Tenant isolation + window scans.
CREATE UNIQUE INDEX IF NOT EXISTS "EmployeeBaseline_employeeId_key"
    ON "EmployeeBaseline"("employeeId");
CREATE INDEX IF NOT EXISTS "EmployeeBaseline_organizationId_idx"
    ON "EmployeeBaseline"("organizationId");
CREATE INDEX IF NOT EXISTS "EmployeeBaseline_windowEnd_idx"
    ON "EmployeeBaseline"("windowEnd");

-- 3. DeviceClaim.reminderSentAt — approval-reminder cooldown gate.
ALTER TABLE "DeviceClaim" ADD COLUMN IF NOT EXISTS "reminderSentAt" TIMESTAMP(3);