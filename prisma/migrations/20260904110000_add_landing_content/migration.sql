-- Add LandingContent (Super Admin-managed public landing page copy).
-- Single row keyed by 'site'; value is a JSON document of string overrides.

CREATE TABLE "LandingContent" (
    "key" TEXT NOT NULL,
    "value" JSONB NOT NULL,
    "updatedBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "LandingContent_pkey" PRIMARY KEY ("key")
);
