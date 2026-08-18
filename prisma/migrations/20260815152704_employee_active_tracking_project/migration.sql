-- AlterTable
ALTER TABLE "Employee" ADD COLUMN     "activeTrackingProjectId" TEXT;

-- CreateIndex
CREATE INDEX "Employee_activeTrackingProjectId_idx" ON "Employee"("activeTrackingProjectId");

-- AddForeignKey
ALTER TABLE "Employee" ADD CONSTRAINT "Employee_activeTrackingProjectId_fkey" FOREIGN KEY ("activeTrackingProjectId") REFERENCES "Project"("id") ON DELETE SET NULL ON UPDATE CASCADE;
