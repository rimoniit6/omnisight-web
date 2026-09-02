-- CreateTable
CREATE TABLE "PlatformBranding" (
    "id" TEXT NOT NULL,
    "brandName" TEXT NOT NULL DEFAULT 'OmniSight',
    "logoUrl" TEXT,
    "faviconUrl" TEXT,
    "primaryColor" TEXT,
    "browserTitle" TEXT,
    "tagline" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "updatedBy" TEXT,

    CONSTRAINT "PlatformBranding_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OrganizationBranding" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "brandName" TEXT,
    "logoUrl" TEXT,
    "faviconUrl" TEXT,
    "primaryColor" TEXT,
    "browserTitle" TEXT,
    "tagline" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "updatedBy" TEXT,

    CONSTRAINT "OrganizationBranding_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "OrganizationBranding_organizationId_key" ON "OrganizationBranding"("organizationId");

-- CreateIndex
CREATE INDEX "OrganizationBranding_organizationId_idx" ON "OrganizationBranding"("organizationId");

-- AddForeignKey
ALTER TABLE "OrganizationBranding" ADD CONSTRAINT "OrganizationBranding_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
