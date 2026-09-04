/*
  OmniSight — Self-hosted license keys (Prompt 4)

  Introduces the LicenseKey model and the Organization.current-license pointer
  (Organization.licenseKeyId). Also back-fills the Organization.lastDataExpiryReminderAt
  column introduced by Prompt 3, which was never captured in a migration.

  Warnings:

  - A unique constraint covering the columns `[licenseKeyId]` on the table
    `Organization` will be added. If there are existing duplicate values, this
    will fail.
*/

-- AlterTable (Prompt 3 back-fill: data-expiry reminder dedup marker)
ALTER TABLE "Organization" ADD COLUMN     "lastDataExpiryReminderAt" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "LicenseKey" (
    "id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "planId" TEXT NOT NULL,
    "validFrom" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "validUntil" TIMESTAMP(3) NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "isRevoked" BOOLEAN NOT NULL DEFAULT false,
    "revokedAt" TIMESTAMP(3),
    "revokedReason" TEXT,
    "lastVerifiedAt" TIMESTAMP(3),
    "verificationCount" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "LicenseKey_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "LicenseKey_key_key" ON "LicenseKey"("key");

-- CreateIndex
CREATE INDEX "LicenseKey_organizationId_idx" ON "LicenseKey"("organizationId");

-- CreateIndex
CREATE INDEX "LicenseKey_planId_idx" ON "LicenseKey"("planId");

-- CreateIndex
CREATE INDEX "LicenseKey_isActive_idx" ON "LicenseKey"("isActive");

-- CreateIndex
CREATE INDEX "LicenseKey_validUntil_idx" ON "LicenseKey"("validUntil");

-- AlterTable (Org -> current license pointer)
ALTER TABLE "Organization" ADD COLUMN     "licenseKeyId" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "Organization_licenseKeyId_key" ON "Organization"("licenseKeyId");

-- AddForeignKey
ALTER TABLE "LicenseKey" ADD CONSTRAINT "LicenseKey_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LicenseKey" ADD CONSTRAINT "LicenseKey_planId_fkey" FOREIGN KEY ("planId") REFERENCES "Plan"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Organization" ADD CONSTRAINT "Organization_licenseKeyId_fkey" FOREIGN KEY ("licenseKeyId") REFERENCES "LicenseKey"("id") ON DELETE SET NULL ON UPDATE CASCADE;
