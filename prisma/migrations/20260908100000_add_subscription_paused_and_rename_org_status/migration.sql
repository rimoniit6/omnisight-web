-- AlterEnum: Add PAUSED to SubscriptionStatus
ALTER TYPE "SubscriptionStatus" ADD VALUE 'PAUSED' BEFORE 'EXPIRED';

-- Migrate Organization status: 'suspended' → 'paused'
UPDATE "Organization" SET status = 'paused' WHERE status = 'suspended';
