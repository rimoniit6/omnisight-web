-- AuditLog.organizationId: Change onDelete behavior from Cascade to SetNull
-- Preserves audit records when an organization is archived or deleted.
-- Audit history must survive org lifecycle changes for compliance.
--
-- NOTE: This migration must be applied against the production database.
-- Run: npx prisma migrate deploy
-- Or manually execute this SQL against the target database.

-- Drop the existing FK constraint (name varies by Prisma version)
ALTER TABLE "AuditLog" DROP CONSTRAINT IF EXISTS "AuditLog_organizationId_fkey";

-- Re-create with SetNull behavior
ALTER TABLE "AuditLog" ADD CONSTRAINT "AuditLog_organizationId_fkey"
  FOREIGN KEY ("organizationId") REFERENCES "Organization"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;
