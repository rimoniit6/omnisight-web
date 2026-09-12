-- OmniSight — Remove LicenseKey / Self-Hosted / PRIVATE architecture
-- =====================================================================
--
-- WHY
-- ---
-- V1 has exactly two customer-facing service models: MANAGED and CUSTOMER_DB.
-- "Self-Hosted" / "PRIVATE" is NOT a V1 service model. The LicenseKey model
-- existed solely to authorize self-hosted/on-prem installations and was
-- reachable only when BOTH held:
--   * Organization.deploymentMode = 'PRIVATE'   (deprecated), and
--   * Plan.isSelfHosted = true                  (no such plan is created any more).
--
-- License issuance was therefore already unreachable for every MANAGED and
-- CUSTOMER_DB organization. Organization activation is performed by the Super
-- Admin through the subscription + manual-payment flow (Organization.subscriptionId
-- -> Subscription -> Invoice). No license step exists.
--
-- WHAT THIS MIGRATION DOES
-- ------------------------
--   1. Drops the Organization -> LicenseKey foreign key + unique index + column
--      (Organization.licenseKeyId — the "current license" pointer).
--   2. Drops the LicenseKey table (its own indexes and FKs drop with it).
--   3. Drops Plan.isSelfHosted (the plan-level self-hosted marker).
--
-- The Prisma enum value DeploymentMode.PRIVATE is deliberately NOT removed here:
-- dropping an enum value in PostgreSQL requires recreating the type and would
-- fail on any pre-existing organization row with deploymentMode='PRIVATE'. It is
-- retained as documented LEGACY COMPATIBILITY only (no UI option, no valid mode
-- transition, no activation path) and needs its own controlled data migration.
--
-- ⚠️  DATA IMPACT — READ BEFORE DEPLOYING
-- ---------------------------------------
-- This migration DELETES every row in the LicenseKey table. Those rows are
-- legacy self-hosted license grants; they are NOT customer business data
-- (employees, devices, activities, screenshots, projects, payments, invoices
-- and subscriptions are untouched by this migration).
--
-- Because rows MAY exist in a database that once ran the self-hosted model:
--   * The block below prints the row count BEFORE the drop so the deletion is
--     never silent in the deploy output.
--   * Take a backup (`pg_dump`) before deploying if those legacy grants must be
--     retained for audit. Restoring the table later requires a NEW migration —
--     this repository intentionally does not provide an automatic restore.
--   * Inspect the count first with:
--       SELECT count(*) FROM "LicenseKey";
--
-- Nothing else in the schema is modified: Organization, Subscription, Invoice,
-- Plan (except the removed isSelfHosted marker), roles, permissions, devices,
-- agents and all tenant data are preserved.

-- ── Pre-flight: make the row removal visible in the deploy output ──────────
DO $$
DECLARE
  legacy_rows bigint;
BEGIN
  SELECT count(*) INTO legacy_rows FROM "LicenseKey";
  IF legacy_rows > 0 THEN
    RAISE WARNING 'Removing % legacy self-hosted LicenseKey row(s) — back up first if these grants must be retained for audit.', legacy_rows;
  END IF;
END $$;

-- ── 1. Organization.licenseKeyId (current-license pointer) ─────────────────
ALTER TABLE "Organization" DROP CONSTRAINT IF EXISTS "Organization_licenseKeyId_fkey";
DROP INDEX IF EXISTS "Organization_licenseKeyId_key";
ALTER TABLE "Organization" DROP COLUMN IF EXISTS "licenseKeyId";

-- ── 2. LicenseKey table ────────────────────────────────────────────────────
DROP INDEX IF EXISTS "LicenseKey_key_key";
DROP INDEX IF EXISTS "LicenseKey_organizationId_idx";
DROP INDEX IF EXISTS "LicenseKey_planId_idx";
DROP INDEX IF EXISTS "LicenseKey_isActive_idx";
DROP INDEX IF EXISTS "LicenseKey_validUntil_idx";
DROP TABLE IF EXISTS "LicenseKey";

-- ── 3. Plan.isSelfHosted (plan-level self-hosted marker) ───────────────────
ALTER TABLE "Plan" DROP COLUMN IF EXISTS "isSelfHosted";
