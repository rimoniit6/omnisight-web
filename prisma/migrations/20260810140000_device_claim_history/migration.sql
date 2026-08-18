-- DeviceClaim history: a device may have MANY claims over its lifetime
-- (pending → cancelled → a NEW pending claim on re-request). The previous
-- 1:1 unique(deviceId) made re-registration impossible (P2002 on the fresh
-- claim create), which is the root cause of the "Registering but no PENDING
-- in admin" defect.

-- Drop the 1:1 unique index on DeviceClaim.deviceId.
DROP INDEX "DeviceClaim_deviceId_key";

-- Plain (non-unique) index for the most recent claim lookup per device.
CREATE INDEX "DeviceClaim_deviceId_idx" ON "DeviceClaim"("deviceId");

-- Employee-initiated cancellation audit fields.
ALTER TABLE "DeviceClaim" ADD COLUMN "cancelledAt" TIMESTAMP(3);
ALTER TABLE "DeviceClaim" ADD COLUMN "cancellationReason" TEXT;
ALTER TABLE "DeviceClaim" ADD COLUMN "cancelledByDeviceId" TEXT;

-- FK for cancelledByDeviceId -> Device (SET NULL so device deletion keeps history).
ALTER TABLE "DeviceClaim" ADD CONSTRAINT "DeviceClaim_cancelledByDeviceId_fkey"
  FOREIGN KEY ("cancelledByDeviceId") REFERENCES "Device"("id") ON DELETE SET NULL ON UPDATE CASCADE;
