-- Phase 2: screenshot thumbnail processing (additive).
-- Adds the async processing state machine + derived-artifact columns to the
-- Screenshot table. Existing rows are backfilled to 'uploaded' so the bounded
-- background worker can generate thumbnails for pre-Phase-2 captures too.
-- No existing column is altered, renamed, or dropped; no row is rewritten.

ALTER TABLE "Screenshot" ADD COLUMN "processingStatus" TEXT NOT NULL DEFAULT 'uploaded';
ALTER TABLE "Screenshot" ADD COLUMN "processingAttempts" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "Screenshot" ADD COLUMN "processingError" TEXT;
ALTER TABLE "Screenshot" ADD COLUMN "processedAt" TIMESTAMP(3);
ALTER TABLE "Screenshot" ADD COLUMN "thumbnailPath" TEXT;
ALTER TABLE "Screenshot" ADD COLUMN "thumbnailSize" INTEGER;

-- Worker drain: oldest uploaded-first, bounded take. Highly selective — only
-- rows still awaiting processing are scanned.
CREATE INDEX "Screenshot_processingStatus_capturedAt_idx" ON "Screenshot"("processingStatus", "capturedAt");

-- Per-org status queries (retention observability / stats / future per-org
-- processing controls).
CREATE INDEX "Screenshot_organizationId_processingStatus_idx" ON "Screenshot"("organizationId", "processingStatus");
