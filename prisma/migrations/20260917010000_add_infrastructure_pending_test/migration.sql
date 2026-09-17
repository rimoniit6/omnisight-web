-- OmniSight — org-scoped PENDING connection-test evidence.
--
-- Persist the result of a successful PROPOSED-config connection test that has
-- no open change request yet (the Test-Connection-BEFORE-submit flow), so the
-- evidence is never silently discarded. The submit routes bind it to the newly
-- created InfrastructureChangeRequest only when the server-recomputed config
-- fingerprint matches and the evidence is still fresh. Non-secret metadata only.

CREATE TABLE "InfrastructurePendingTest" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "lastTestStatus" TEXT,
    "lastTestMessage" TEXT,
    "lastTestedAt" TIMESTAMP(3),
    "lastTestConfigFingerprint" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "InfrastructurePendingTest_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "InfrastructurePendingTest_organizationId_kind_key"
    ON "InfrastructurePendingTest"("organizationId", "kind");

CREATE INDEX "InfrastructurePendingTest_organizationId_idx"
    ON "InfrastructurePendingTest"("organizationId");

ALTER TABLE "InfrastructurePendingTest"
    ADD CONSTRAINT "InfrastructurePendingTest_organizationId_fkey"
    FOREIGN KEY ("organizationId") REFERENCES "Organization"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
