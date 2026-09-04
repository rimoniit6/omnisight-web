-- Add Lead (marketing / contact-sales) and OrganizationSettings (AI + analytics DB config)
-- Tables use Prisma's default quoted snake_case column names.

CREATE TABLE "Lead" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "company" TEXT,
    "planInterest" TEXT NOT NULL DEFAULT 'Enterprise',
    "message" TEXT,
    "status" TEXT NOT NULL DEFAULT 'NEW',
    "source" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Lead_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "Lead_email_idx" ON "Lead"("email");
CREATE INDEX "Lead_status_idx" ON "Lead"("status");
CREATE INDEX "Lead_createdAt_idx" ON "Lead"("createdAt");

CREATE TABLE "OrganizationSettings" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "aiProvider" TEXT,
    "aiApiKey" TEXT,
    "aiBaseUrl" TEXT,
    "aiModel" TEXT,
    "useOwnDb" BOOLEAN NOT NULL DEFAULT false,
    "dbHost" TEXT,
    "dbPort" INTEGER,
    "dbName" TEXT,
    "dbUser" TEXT,
    "dbPassword" TEXT,
    "dbSsl" BOOLEAN NOT NULL DEFAULT false,
    "aiTestedAt" TIMESTAMP(3),
    "aiTestStatus" TEXT,
    "dbTestedAt" TIMESTAMP(3),
    "dbTestStatus" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "OrganizationSettings_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "OrganizationSettings_organizationId_key" UNIQUE ("organizationId")
);

CREATE INDEX "OrganizationSettings_organizationId_idx" ON "OrganizationSettings"("organizationId");

-- FK: organizationId -> Organization.id (cascade)
ALTER TABLE "OrganizationSettings"
    ADD CONSTRAINT "OrganizationSettings_organizationId_fkey"
    FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
