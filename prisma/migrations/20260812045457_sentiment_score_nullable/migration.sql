-- DropForeignKey
ALTER TABLE "DeviceClaim" DROP CONSTRAINT "DeviceClaim_cancelledByDeviceId_fkey";

-- AlterTable
ALTER TABLE "AgentAccount" ALTER COLUMN "updatedAt" DROP DEFAULT;

-- AlterTable
ALTER TABLE "SentimentRecord" ALTER COLUMN "score" DROP NOT NULL,
ALTER COLUMN "score" DROP DEFAULT;
