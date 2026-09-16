-- OmniSight — Remove the legacy `PRIVATE` deployment-mode value (Phase 2).
--
-- Final contract: DeploymentMode = MANAGED | CUSTOMER_DB. `PRIVATE` ceases to
-- exist as a database enum value.
--
-- SAFETY POLICY (approved):
--   * NO silent conversion. If any row still carries 'PRIVATE' in any
--     deployment-mode column, this migration FAILS with an explicit error and
--     changes nothing — an explicit conversion policy must be approved first.
--   * Historical migrations are untouched; this is a single forward migration.
--
-- PostgreSQL NOTE (verified against the project's actual server, 15.19):
--   `ALTER TYPE ... DROP VALUE` is NOT supported by this server build (syntax
--   error), so the enum value is removed with the standard transactional
--   type-swap below. The whole migration runs inside Prisma's migration
--   transaction (default atomic), so any failure rolls back completely.
--
-- `deploymentModeUnresolved` already exists on Organization (added by
-- 20260904020000_add_deployment_mode) but is deliberately NOT written here:
-- zero PRIVATE rows are expected, and no reinterpretation policy is approved.

-- ── 1. Guard: fail loudly if any PRIVATE deployment-mode row exists ────────
DO $$
DECLARE
  org_private            integer;
  sub_private            integer;
  plan_pricing_private   integer;
  offer_private          integer;
  purchase_req_private   integer;
BEGIN
  SELECT count(*) INTO org_private          FROM "Organization"    WHERE "deploymentMode" = 'PRIVATE';
  SELECT count(*) INTO sub_private          FROM "Subscription"    WHERE "deploymentModeSnapshot" = 'PRIVATE';
  SELECT count(*) INTO plan_pricing_private FROM "PlanPricing"     WHERE "deploymentMode" = 'PRIVATE';
  SELECT count(*) INTO offer_private        FROM "Offer"           WHERE "deploymentMode" = 'PRIVATE';
  SELECT count(*) INTO purchase_req_private FROM "PurchaseRequest" WHERE "deploymentMode" = 'PRIVATE';

  IF org_private > 0 OR sub_private > 0 OR plan_pricing_private > 0
     OR offer_private > 0 OR purchase_req_private > 0 THEN
    RAISE EXCEPTION
      'PRIVATE deployment-mode rows still exist (Organization=%, Subscription.deploymentModeSnapshot=%, PlanPricing=%, Offer=%, PurchaseRequest=%). An explicit conversion policy must be approved before removing the PRIVATE enum value — migration aborted, nothing changed.',
      org_private, sub_private, plan_pricing_private, offer_private, purchase_req_private;
  END IF;
END $$;

-- ── 2. Type swap: rebuild the enum with exactly MANAGED | CUSTOMER_DB ──────
-- Column DEFAULTs (e.g. 'MANAGED') are stored as literals of the OLD enum
-- type and cannot be cast automatically between two DISTINCT enum types
-- (verified live: PG error 42804). Drop them before the column type change
-- and re-add identical defaults afterwards.
ALTER TABLE "Offer"           ALTER COLUMN "deploymentMode"         DROP DEFAULT;
ALTER TABLE "Organization"    ALTER COLUMN "deploymentMode"         DROP DEFAULT;
ALTER TABLE "PlanPricing"     ALTER COLUMN "deploymentMode"         DROP DEFAULT;
ALTER TABLE "PurchaseRequest" ALTER COLUMN "deploymentMode"         DROP DEFAULT;
ALTER TABLE "Subscription"    ALTER COLUMN "deploymentModeSnapshot" DROP DEFAULT;

ALTER TYPE "DeploymentMode" RENAME TO "DeploymentMode_old";
CREATE TYPE "DeploymentMode" AS ENUM ('MANAGED', 'CUSTOMER_DB');

ALTER TABLE "Offer"           ALTER COLUMN "deploymentMode"         TYPE "DeploymentMode" USING "deploymentMode"::text::"DeploymentMode";
ALTER TABLE "Organization"    ALTER COLUMN "deploymentMode"         TYPE "DeploymentMode" USING "deploymentMode"::text::"DeploymentMode";
ALTER TABLE "PlanPricing"     ALTER COLUMN "deploymentMode"         TYPE "DeploymentMode" USING "deploymentMode"::text::"DeploymentMode";
ALTER TABLE "PurchaseRequest" ALTER COLUMN "deploymentMode"         TYPE "DeploymentMode" USING "deploymentMode"::text::"DeploymentMode";
ALTER TABLE "Subscription"    ALTER COLUMN "deploymentModeSnapshot" TYPE "DeploymentMode" USING "deploymentModeSnapshot"::text::"DeploymentMode";

-- Restore the schema-defined defaults verbatim (Prisma schema parity).
ALTER TABLE "Organization"    ALTER COLUMN "deploymentMode"         SET DEFAULT 'MANAGED';

DROP TYPE "DeploymentMode_old";
