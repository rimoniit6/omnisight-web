-- Notification + Alerting production-hardening (N-4/N-6/N-9/N-11):
--   - structured employeeId/deviceId linkage on Notification + Alert
--   - org-level NotificationPreference (N-6)
--   - indexes supporting the alert timeline/stats + linkage queries

-- AlterTable
ALTER TABLE "Alert" ADD COLUMN     "deviceId" TEXT,
ADD COLUMN     "employeeId" TEXT;

-- AlterTable
ALTER TABLE "Notification" ADD COLUMN     "deviceId" TEXT,
ADD COLUMN     "employeeId" TEXT;

-- CreateTable
CREATE TABLE "NotificationPreference" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "notificationType" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "NotificationPreference_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "NotificationPreference_organizationId_idx" ON "NotificationPreference"("organizationId");

-- CreateIndex
CREATE UNIQUE INDEX "NotificationPreference_organizationId_notificationType_key" ON "NotificationPreference"("organizationId", "notificationType");

-- CreateIndex
CREATE INDEX "Alert_organizationId_createdAt_idx" ON "Alert"("organizationId", "createdAt");

-- CreateIndex
CREATE INDEX "Alert_organizationId_status_createdAt_idx" ON "Alert"("organizationId", "status", "createdAt");

-- CreateIndex
CREATE INDEX "Alert_employeeId_idx" ON "Alert"("employeeId");

-- CreateIndex
CREATE INDEX "Alert_deviceId_idx" ON "Alert"("deviceId");

-- CreateIndex
CREATE INDEX "Notification_employeeId_idx" ON "Notification"("employeeId");

-- CreateIndex
CREATE INDEX "Notification_deviceId_idx" ON "Notification"("deviceId");

-- AddForeignKey
ALTER TABLE "NotificationPreference" ADD CONSTRAINT "NotificationPreference_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
