-- AgentToken.organizationId: Make NOT NULL
--
-- PRE-MIGRATION CHECKS:
-- 1. Run: node scripts/backfill-agent-token-org.mjs
--    This backfills NULL values from Employee.organizationId and
--    deletes orphaned tokens (Employee has no orgId).
-- 2. Verify zero NULLs: SELECT count(*) FROM "AgentToken" WHERE "organizationId" IS NULL;
--    Must return 0 before applying this migration.
--
-- SAFETY: This migration is irreversible without data loss.
-- Only apply after backfill script confirms zero NULL rows.

-- Remove existing FK constraint (name may vary)
ALTER TABLE "AgentToken" DROP CONSTRAINT IF EXISTS "AgentToken_organizationId_fkey";

-- Add NOT NULL constraint
ALTER TABLE "AgentToken" ALTER COLUMN "organizationId" SET NOT NULL;

-- Re-create FK with Cascade (matches Prisma schema: onDelete: Cascade)
-- organizationId is NOT NULL, so SetNull is impossible — Cascade is correct.
-- Organizations are soft-deleted (status change), not hard-deleted,
-- so this FK only fires on actual Organization row deletion.
ALTER TABLE "AgentToken" ADD CONSTRAINT "AgentToken_organizationId_fkey"
  FOREIGN KEY ("organizationId") REFERENCES "Organization"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

-- Add index for fast org-scoped token lookups (if not already present)
CREATE INDEX IF NOT EXISTS "AgentToken_organizationId_employeeId_idx"
  ON "AgentToken"("organizationId", "employeeId");
