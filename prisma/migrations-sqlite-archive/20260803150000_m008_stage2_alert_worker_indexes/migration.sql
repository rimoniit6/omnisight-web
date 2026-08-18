-- M008 Stage-2 — Alert evaluation-worker watermark indexes (additive-only).
-- Every worker watermark query (telemetry since the last evaluated cycle) is
-- now a pure index range scan — never a full-table scan (mission §Performance).
CREATE INDEX "DeviceHealthSnapshot_ts_idx" ON "DeviceHealthSnapshot"("ts");
CREATE INDEX "ActivityEvent_receivedAt_idx" ON "ActivityEvent"("receivedAt");
CREATE INDEX "Screenshot_ocrProcessedAt_idx" ON "Screenshot"("ocrProcessedAt");
CREATE INDEX "UploadTicket_updatedAt_idx" ON "UploadTicket"("updatedAt");
