-- Phase 5 — AI usage metering (additive).
-- One row per org-scoped AI provider call. Tokens are recorded only when the
-- provider reports them; cost is never fabricated. No API keys or payload
-- content are ever stored. Purged by the existing retention job using the
-- ai_insight_retention_days window.

CREATE TABLE "AiUsage" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "operation" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'success',
    "errorCode" TEXT,
    "inputTokens" INTEGER,
    "outputTokens" INTEGER,
    "totalTokens" INTEGER,
    "latencyMs" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AiUsage_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "AiUsage_organizationId_createdAt_idx" ON "AiUsage"("organizationId", "createdAt");
CREATE INDEX "AiUsage_organizationId_operation_createdAt_idx" ON "AiUsage"("organizationId", "operation", "createdAt");
CREATE INDEX "AiUsage_createdAt_idx" ON "AiUsage"("createdAt");

ALTER TABLE "AiUsage" ADD CONSTRAINT "AiUsage_organizationId_fkey"
    FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
