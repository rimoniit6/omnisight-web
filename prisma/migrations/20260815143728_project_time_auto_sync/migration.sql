-- AlterTable
ALTER TABLE "TimeEntry" ADD COLUMN     "source" TEXT NOT NULL DEFAULT 'MANUAL';

-- CreateTable
CREATE TABLE "ProjectTimeSync" (
    "id" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "date" TIMESTAMP(3) NOT NULL,
    "seconds" INTEGER NOT NULL,
    "lastActivityAt" TIMESTAMP(3),
    "organizationId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ProjectTimeSync_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProjectTimeSyncCursor" (
    "id" TEXT NOT NULL,
    "lastProcessedAt" TIMESTAMP(3) NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ProjectTimeSyncCursor_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ProjectTimeSync_organizationId_idx" ON "ProjectTimeSync"("organizationId");

-- CreateIndex
CREATE INDEX "ProjectTimeSync_date_idx" ON "ProjectTimeSync"("date");

-- CreateIndex
CREATE INDEX "ProjectTimeSync_createdAt_idx" ON "ProjectTimeSync"("createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "ProjectTimeSync_employeeId_projectId_date_key" ON "ProjectTimeSync"("employeeId", "projectId", "date");

-- CreateIndex
CREATE INDEX "TimeEntry_source_createdAt_idx" ON "TimeEntry"("source", "createdAt");

-- AddForeignKey
ALTER TABLE "ProjectTimeSync" ADD CONSTRAINT "ProjectTimeSync_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "Employee"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProjectTimeSync" ADD CONSTRAINT "ProjectTimeSync_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProjectTimeSync" ADD CONSTRAINT "ProjectTimeSync_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
