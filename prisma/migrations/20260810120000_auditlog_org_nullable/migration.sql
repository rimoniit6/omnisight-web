-- AuditLog.organizationId → nullable
--
-- The Super Admin bootstrap creates an ORG-LESS super_admin (the supported
-- production state). Auth routes audit logins/logouts/password changes with
-- `organizationId: payload.organizationId || ''` — an empty string violated
-- the NOT NULL FK and returned 500 for org-less accounts. Making the column
-- nullable (and writing `null` instead of `''`) fixes login for the bootstrap
-- account without redesigning the audit model.

ALTER TABLE "AuditLog" ALTER COLUMN "organizationId" DROP NOT NULL;
