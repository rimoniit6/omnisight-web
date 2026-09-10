-- Org-scoped storage fields on OrganizationSettings (Org Data Infrastructure vertical).
ALTER TABLE "OrganizationSettings" ADD COLUMN     "storageDriver" TEXT,
ADD COLUMN     "storageKey" TEXT,
ADD COLUMN     "storageTestStatus" TEXT,
ADD COLUMN     "storageTestedAt" TIMESTAMP(3),
ADD COLUMN     "storageUrl" TEXT;

-- Part 18 change-request state machine (draft/submitted/approved/applied/active + rejected/cancelled/superseded).
CREATE TABLE "InfrastructureChangeRequest" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "requestNo" INTEGER NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'draft',
    "configJson" TEXT NOT NULL,
    "dbPasswordEncrypted" TEXT,
    "storageKeyEncrypted" TEXT,
    "lastTestStatus" TEXT,
    "lastTestMessage" TEXT,
    "lastTestedAt" TIMESTAMP(3),
    "requestedById" TEXT NOT NULL,
    "requestedByEmail" TEXT NOT NULL,
    "requestedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "approvedById" TEXT,
    "approvedByEmail" TEXT,
    "approvedAt" TIMESTAMP(3),
    "approvalNote" TEXT,
    "rejectedById" TEXT,
    "rejectedByEmail" TEXT,
    "rejectedAt" TIMESTAMP(3),
    "rejectionReason" TEXT,
    "cancelledById" TEXT,
    "cancelledByEmail" TEXT,
    "cancelledAt" TIMESTAMP(3),
    "cancellationReason" TEXT,
"supersededByRequestNo" INTEGER,
"supersededAt" TIMESTAMP(3),
    "migratedAt" TIMESTAMP(3),
    "appliedAt" TIMESTAMP(3),
    "activatedAt" TIMESTAMP(3),
    "errorMessage" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "InfrastructureChangeRequest_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "InfrastructureChangeRequest_organizationId_kind_status_idx" ON "InfrastructureChangeRequest"("organizationId", "kind", "status");

-- CreateIndex
CREATE INDEX "InfrastructureChangeRequest_status_idx" ON "InfrastructureChangeRequest"("status");

-- CreateIndex
CREATE INDEX "InfrastructureChangeRequest_createdAt_idx" ON "InfrastructureChangeRequest"("createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "InfrastructureChangeRequest_organizationId_kind_requestNo_key" ON "InfrastructureChangeRequest"("organizationId", "kind", "requestNo");

-- AddForeignKey
ALTER TABLE "InfrastructureChangeRequest" ADD CONSTRAINT "InfrastructureChangeRequest_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;