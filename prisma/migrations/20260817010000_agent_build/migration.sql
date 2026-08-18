-- OmniSight — Agent Build records (agent_build)
--
-- One row per build request issued from Settings → Agent Software. Metadata +
-- artifact lifecycle only; NEVER stores the enrollment code plaintext or any
-- secret (the baked configuration lives inside the artifact).

-- CreateTable
CREATE TABLE "AgentBuild" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "serverUrl" TEXT NOT NULL,
    "enrollmentCodeBaked" BOOLEAN NOT NULL DEFAULT false,
    "agentVersion" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "sha256" TEXT,
    "fileName" TEXT,
    "requestedBy" TEXT NOT NULL,
    "error" TEXT,
    "startedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AgentBuild_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "AgentBuild_organizationId_idx" ON "AgentBuild"("organizationId");

-- CreateIndex
CREATE INDEX "AgentBuild_organizationId_createdAt_idx" ON "AgentBuild"("organizationId", "createdAt");

-- CreateIndex
CREATE INDEX "AgentBuild_status_idx" ON "AgentBuild"("status");

-- AddForeignKey
ALTER TABLE "AgentBuild" ADD CONSTRAINT "AgentBuild_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
