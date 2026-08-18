-- M009 Stage-2 — Remote Command Execution, Update Delivery & Policy Synchronization (additive-only)

-- AgentCommand: delivery/result plane (delivered → acknowledged → running → terminal)
ALTER TABLE "AgentCommand" ADD COLUMN "deliveredAt" DATETIME;
ALTER TABLE "AgentCommand" ADD COLUMN "acknowledgedAt" DATETIME;
ALTER TABLE "AgentCommand" ADD COLUMN "deliveryToken" TEXT;
ALTER TABLE "AgentCommand" ADD COLUMN "executionMs" INTEGER;
ALTER TABLE "AgentCommand" ADD COLUMN "stdoutSummary" TEXT;
ALTER TABLE "AgentCommand" ADD COLUMN "stderrSummary" TEXT;
ALTER TABLE "AgentCommand" ADD COLUMN "exitCode" INTEGER;
ALTER TABLE "AgentCommand" ADD COLUMN "metadata" TEXT;
ALTER TABLE "AgentCommand" ADD COLUMN "attachments" TEXT;
ALTER TABLE "AgentCommand" ADD COLUMN "notBefore" DATETIME;

-- CreateIndex
CREATE INDEX "AgentCommand_deliveredAt_idx" ON "AgentCommand"("deliveredAt");

-- AgentRelease: update-manifest fields (manifest only — no binary delivery)
ALTER TABLE "AgentRelease" ADD COLUMN "sha256" TEXT;
ALTER TABLE "AgentRelease" ADD COLUMN "downloadUrl" TEXT;
ALTER TABLE "AgentRelease" ADD COLUMN "signature" TEXT;
ALTER TABLE "AgentRelease" ADD COLUMN "minAgentVersion" TEXT;
