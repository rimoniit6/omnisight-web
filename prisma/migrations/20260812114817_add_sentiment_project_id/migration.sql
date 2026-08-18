-- AlterTable
ALTER TABLE "SentimentRecord" ADD COLUMN     "projectId" TEXT;

-- CreateIndex
CREATE INDEX "SentimentRecord_projectId_idx" ON "SentimentRecord"("projectId");

-- AddForeignKey
ALTER TABLE "SentimentRecord" ADD CONSTRAINT "SentimentRecord_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;
