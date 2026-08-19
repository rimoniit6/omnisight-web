-- Remove the AgentBuild table (web-triggered agent build feature removed).
-- The standalone omnisight-agent build pipeline is unaffected.

-- DropForeignKey
ALTER TABLE "AgentBuild" DROP CONSTRAINT "AgentBuild_organizationId_fkey";

-- DropTable
DROP TABLE "AgentBuild";
