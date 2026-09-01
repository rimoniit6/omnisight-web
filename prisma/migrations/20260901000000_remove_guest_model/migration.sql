-- OmniSight — Remove Guest Model (guest removal)
-- 
-- This migration drops the obsolete Guest table and removes the
-- Employee.guestId column. The Employee.type field remains (values: "employee" only).
--
-- Safety notes:
--   - Guest lifecycle data (PENDING/ACTIVE/REVOKED/etc.) is audit-logged
--     in AuditLog and is NOT affected by this migration.
--   - Employee rows that were previously type='guest' retain their
--     Employee.type value for backward compatibility with existing data.
--   - Device and Organization relations to Guest are cleaned up by
--     the CASCADE delete on the Guest table.
--
-- Pre-migration: verify no active Guest records exist.
-- Post-migration: Employee.type='guest' rows remain but are no longer
--     managed by the Guest lifecycle.

-- Step 1: Drop Guest-specific indexes (if they exist)
DROP INDEX IF EXISTS "Guest_organizationId_idx";
DROP INDEX IF EXISTS "Guest_organizationId_status_idx";
DROP INDEX IF EXISTS "Guest_deviceId_idx";
DROP INDEX IF EXISTS "Guest_status_idx";
DROP INDEX IF EXISTS "Guest_createdAt_idx";

-- Step 2: Drop the Guest table (CASCADE removes FK constraints)
DROP TABLE IF EXISTS "Guest";

-- Step 3: Remove the Employee.guestId column
ALTER TABLE "Employee" DROP COLUMN IF EXISTS "guestId";
