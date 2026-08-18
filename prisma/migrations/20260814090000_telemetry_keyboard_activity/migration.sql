-- Phase 2 — aggregate keyboard activity telemetry.
-- Stores ONLY per-interval counts and typing duration. No raw-key storage
-- exists anywhere in the schema by design.

-- CreateTable
CREATE TABLE "KeyboardActivity" (
    "id" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "deviceId" TEXT,
    "intervalStart" TIMESTAMP(3) NOT NULL,
    "intervalEnd" TIMESTAMP(3) NOT NULL,
    "keystrokeCount" INTEGER NOT NULL,
    "activeTypingSeconds" INTEGER NOT NULL,
    "application" TEXT,
    "organizationId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "KeyboardActivity_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "KeyboardActivity_employeeId_intervalStart_idx" ON "KeyboardActivity"("employeeId", "intervalStart");

-- CreateIndex
CREATE INDEX "KeyboardActivity_deviceId_intervalStart_idx" ON "KeyboardActivity"("deviceId", "intervalStart");

-- CreateIndex
CREATE INDEX "KeyboardActivity_organizationId_idx" ON "KeyboardActivity"("organizationId");

-- CreateIndex
CREATE INDEX "KeyboardActivity_createdAt_idx" ON "KeyboardActivity"("createdAt");

-- AddForeignKey
ALTER TABLE "KeyboardActivity" ADD CONSTRAINT "KeyboardActivity_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "Employee"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "KeyboardActivity" ADD CONSTRAINT "KeyboardActivity_deviceId_fkey" FOREIGN KEY ("deviceId") REFERENCES "Device"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "KeyboardActivity" ADD CONSTRAINT "KeyboardActivity_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
