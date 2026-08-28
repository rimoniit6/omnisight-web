-- DropTrigger
DROP TRIGGER IF EXISTS omnisight_notify_agentregistration ON "AgentRegistration";

-- DropIndexes
DROP INDEX IF EXISTS "AgentRegistration_createdAt_idx";
DROP INDEX IF EXISTS "AgentRegistration_status_idx";
DROP INDEX IF EXISTS "AgentRegistration_organizationId_idx";

-- DropForeignKey
ALTER TABLE "AgentRegistration" DROP CONSTRAINT "AgentRegistration_employeeId_fkey";
ALTER TABLE "AgentRegistration" DROP CONSTRAINT "AgentRegistration_organizationId_fkey";

-- DropTable
DROP TABLE "AgentRegistration";
