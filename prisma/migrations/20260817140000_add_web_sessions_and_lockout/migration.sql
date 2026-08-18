-- DropForeignKey
ALTER TABLE "Employee" DROP CONSTRAINT "Employee_guestId_fkey";

-- AlterTable
ALTER TABLE "AuditLog" ADD COLUMN     "userAgent" TEXT;

-- AlterTable
ALTER TABLE "Employee" ADD COLUMN     "failedLoginCount" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "lockedUntil" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "RateLimitCounter" ALTER COLUMN "updatedAt" DROP DEFAULT;

-- CreateTable
CREATE TABLE "UserSession" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "organizationId" TEXT,
    "ipAddress" TEXT,
    "userAgent" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeenAt" TIMESTAMP(3),
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "revokedAt" TIMESTAMP(3),

    CONSTRAINT "UserSession_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "UserSession_userId_idx" ON "UserSession"("userId");

-- CreateIndex
CREATE INDEX "UserSession_userId_revokedAt_idx" ON "UserSession"("userId", "revokedAt");

-- AddForeignKey
ALTER TABLE "UserSession" ADD CONSTRAINT "UserSession_userId_fkey" FOREIGN KEY ("userId") REFERENCES "AppUser"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UserSession" ADD CONSTRAINT "UserSession_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE SET NULL ON UPDATE CASCADE;

