-- Phase 2b — Consent expiry + immutable consent history
--
-- 1. Consent gains an `expiredAt` column set by the background expiration
--    processor (Granted -> Expired). Additive: existing rows keep their data.
-- 2. ConsentLog.consent FK changes from ON DELETE CASCADE to ON DELETE RESTRICT
--    so consent/audit history can never be silently destroyed by deleting the
--    parent Consent row. The API refuses deletion with 409 when logs exist.
--
-- SQLite requires table recreation to add columns / change FK semantics; the
-- RedefineTables pattern below copies all existing rows (no data loss).

-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;

-- AlterTable: Consent (add expiredAt)
CREATE TABLE "new_Consent" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "employeeId" TEXT NOT NULL,
    "consentType" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "grantedAt" DATETIME,
    "revokedAt" DATETIME,
    "expiresAt" DATETIME,
    "expiredAt" DATETIME,
    "ipAddress" TEXT,
    "userAgent" TEXT,
    "consentVersion" TEXT NOT NULL DEFAULT 'v1',
    "policyId" TEXT,
    "notes" TEXT,
    "organizationId" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "Consent_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "Employee" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "Consent_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "Consent_policyId_fkey" FOREIGN KEY ("policyId") REFERENCES "ConsentPolicy" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);
INSERT INTO "new_Consent" ("consentType", "consentVersion", "createdAt", "employeeId", "expiresAt", "grantedAt", "id", "ipAddress", "notes", "organizationId", "policyId", "revokedAt", "status", "updatedAt", "userAgent") SELECT "consentType", "consentVersion", "createdAt", "employeeId", "expiresAt", "grantedAt", "id", "ipAddress", "notes", "organizationId", "policyId", "revokedAt", "status", "updatedAt", "userAgent" FROM "Consent";
DROP TABLE "Consent";
ALTER TABLE "new_Consent" RENAME TO "Consent";
CREATE INDEX "Consent_organizationId_idx" ON "Consent"("organizationId");
CREATE INDEX "Consent_status_idx" ON "Consent"("status");
CREATE INDEX "Consent_policyId_idx" ON "Consent"("policyId");
CREATE UNIQUE INDEX "Consent_employeeId_consentType_key" ON "Consent"("employeeId", "consentType");

-- AlterTable: ConsentLog (immutable FK — RESTRICT instead of CASCADE)
CREATE TABLE "new_ConsentLog" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "consentId" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "performedBy" TEXT,
    "ipAddress" TEXT,
    "organizationId" TEXT NOT NULL,
    "anonymizedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ConsentLog_consentId_fkey" FOREIGN KEY ("consentId") REFERENCES "Consent" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
INSERT INTO "new_ConsentLog" ("action", "anonymizedAt", "consentId", "createdAt", "description", "id", "ipAddress", "organizationId", "performedBy") SELECT "action", "anonymizedAt", "consentId", "createdAt", "description", "id", "ipAddress", "organizationId", "performedBy" FROM "ConsentLog";
DROP TABLE "ConsentLog";
ALTER TABLE "new_ConsentLog" RENAME TO "ConsentLog";
CREATE INDEX "ConsentLog_consentId_idx" ON "ConsentLog"("consentId");
CREATE INDEX "ConsentLog_organizationId_idx" ON "ConsentLog"("organizationId");

PRAGMA foreign_keys=ON;
