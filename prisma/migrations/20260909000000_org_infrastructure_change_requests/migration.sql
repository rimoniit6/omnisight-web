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

-- CreateTable: InfrastructureMigration (one per InfrastructureChangeRequest)
CREATE TABLE "InfrastructureMigration" (
    "id" TEXT NOT NULL,
    "requestId" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'queued',
    "recordsTotal" INTEGER NOT NULL DEFAULT 0,
    "recordsDone" INTEGER NOT NULL DEFAULT 0,
    "objectsTotal" INTEGER NOT NULL DEFAULT 0,
    "objectsDone" INTEGER NOT NULL DEFAULT 0,
    "bytesTotal" BIGINT NOT NULL DEFAULT 0,
    "bytesDone" BIGINT NOT NULL DEFAULT 0,
    "tableProgress" TEXT,
    "currentTable" TEXT,
    "verifiedCount" INTEGER,
    "errorStage" TEXT,
    "errorMessage" TEXT,
    "startedAt" TIMESTAMP(3),
    "verifiedAt" TIMESTAMP(3),
    "cutoverAt" TIMESTAMP(3),
    "activatedAt" TIMESTAMP(3),
    "finishedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "InfrastructureMigration_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "InfrastructureMigration_requestId_key" ON "InfrastructureMigration"("requestId");

-- CreateIndex
CREATE INDEX "InfrastructureMigration_organizationId_status_idx" ON "InfrastructureMigration"("organizationId", "status");

-- CreateIndex
CREATE INDEX "InfrastructureMigration_status_createdAt_idx" ON "InfrastructureMigration"("status", "createdAt");

-- AddForeignKey
ALTER TABLE "InfrastructureMigration" ADD CONSTRAINT "InfrastructureMigration_requestId_fkey" FOREIGN KEY ("requestId") REFERENCES "InfrastructureChangeRequest"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InfrastructureMigration" ADD CONSTRAINT "InfrastructureMigration_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;