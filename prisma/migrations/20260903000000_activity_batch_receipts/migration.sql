-- CreateTable
CREATE TABLE "ActivityBatchReceipt" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "batchId" TEXT NOT NULL,
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "rowCount" INTEGER NOT NULL,

    CONSTRAINT "ActivityBatchReceipt_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ActivityBatchReceipt_organizationId_employeeId_batchId_key" ON "ActivityBatchReceipt"("organizationId", "employeeId", "batchId");

-- CreateIndex
CREATE INDEX "ActivityBatchReceipt_organizationId_receivedAt_idx" ON "ActivityBatchReceipt"("organizationId", "receivedAt");

-- CreateIndex
CREATE INDEX "ActivityBatchReceipt_employeeId_idx" ON "ActivityBatchReceipt"("employeeId");

-- CreateIndex
CREATE INDEX "ActivityBatchReceipt_receivedAt_idx" ON "ActivityBatchReceipt"("receivedAt");

-- AddForeignKey
ALTER TABLE "ActivityBatchReceipt" ADD CONSTRAINT "ActivityBatchReceipt_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ActivityBatchReceipt" ADD CONSTRAINT "ActivityBatchReceipt_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "Employee"("id") ON DELETE CASCADE ON UPDATE CASCADE;
