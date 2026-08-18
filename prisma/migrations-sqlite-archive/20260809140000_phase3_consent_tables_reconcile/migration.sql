-- Phase 3: consent-schema reconciliation for fresh databases.
--
-- ConsentPolicy and OrganizationSetting were introduced in the consent
-- management work but were db-push managed (never captured in a migration):
-- the `_ok` snapshot predates them and no migration created them. On a fresh
-- `migrate deploy` the Consent.policyId FK therefore references a table that
-- does not exist and SQLite rejects runtime writes to Consent.
--
-- These CREATE TABLE IF NOT EXISTS statements are idempotent: databases that
-- already have the tables (db-push managed / phase-2 demo DB) are untouched.

-- ==================== Consent Policy (Versioned) ====================

CREATE TABLE IF NOT EXISTS "ConsentPolicy" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "organizationId" TEXT NOT NULL,
    "consentType" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "version" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'draft',
    "effectiveAt" DATETIME,
    "publishedAt" DATETIME,
    "publishedBy" TEXT,
    "createdBy" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "ConsentPolicy_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE UNIQUE INDEX IF NOT EXISTS "ConsentPolicy_organizationId_consentType_version_key" ON "ConsentPolicy"("organizationId", "consentType", "version");
CREATE INDEX IF NOT EXISTS "ConsentPolicy_organizationId_consentType_status_idx" ON "ConsentPolicy"("organizationId", "consentType", "status");

-- ==================== Organization Settings (Key-Value, Org-Scoped) ====================

CREATE TABLE IF NOT EXISTS "OrganizationSetting" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "organizationId" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "value" TEXT NOT NULL,
    "category" TEXT,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "OrganizationSetting_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE UNIQUE INDEX IF NOT EXISTS "OrganizationSetting_organizationId_key_key" ON "OrganizationSetting"("organizationId", "key");
CREATE INDEX IF NOT EXISTS "OrganizationSetting_organizationId_idx" ON "OrganizationSetting"("organizationId");
