-- M004 Stage-3 — rename the physical table ActivityLog → ActivityEvent.
--
-- Data-preserving: SQLite ALTER TABLE RENAME keeps every row intact and updates
-- references in foreign keys. The four Prisma-managed indexes are recreated
-- under the ActivityEvent naming scheme (SQLite has no ALTER INDEX statement).
-- The primary-key autoindex (sqlite_autoindex_*) follows the table rename
-- automatically. Applied against a fresh backup: db/custom.db.bak-m004s3.

ALTER TABLE "ActivityLog" RENAME TO "ActivityEvent";

DROP INDEX "ActivityLog_deviceId_idx";
CREATE INDEX "ActivityEvent_deviceId_idx" ON "ActivityEvent"("deviceId");

DROP INDEX "ActivityLog_timestamp_idx";
CREATE INDEX "ActivityEvent_timestamp_idx" ON "ActivityEvent"("timestamp");

DROP INDEX "ActivityLog_kind_idx";
CREATE INDEX "ActivityEvent_kind_idx" ON "ActivityEvent"("kind");

DROP INDEX "ActivityLog_deviceId_seq_key";
CREATE UNIQUE INDEX "ActivityEvent_deviceId_seq_key" ON "ActivityEvent"("deviceId", "seq");
