-- LM-6: indexes for the live-updates mini-service polling queries.
-- The poll runs every 5s and filters/orders by createdAt (and updatedAt for
-- devices) since a cursor; these indexes keep those scans bounded as the
-- tables grow. Non-destructive — index creation only, no data changes.
CREATE INDEX "Activity_createdAt_idx" ON "Activity"("createdAt");
CREATE INDEX "AgentRegistration_createdAt_idx" ON "AgentRegistration"("createdAt");
CREATE INDEX "Device_updatedAt_idx" ON "Device"("updatedAt");
CREATE INDEX "Notification_createdAt_idx" ON "Notification"("createdAt");
CREATE INDEX "Screenshot_createdAt_idx" ON "Screenshot"("createdAt");
CREATE INDEX "UsbEvent_createdAt_idx" ON "UsbEvent"("createdAt");
