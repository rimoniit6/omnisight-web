-- Phase 1 Step 2: authoritative organization deployment mode.
-- MANAGED is the default so every pre-existing row keeps current
-- single-database behavior until Step 3 backfill explicitly maps it.
CREATE TYPE "DeploymentMode" AS ENUM ('MANAGED', 'CUSTOMER_DB', 'PRIVATE');

ALTER TABLE "Organization"
  ADD COLUMN "deploymentMode" "DeploymentMode" NOT NULL DEFAULT 'MANAGED',
  ADD COLUMN "deploymentModeUnresolved" BOOLEAN NOT NULL DEFAULT false;

CREATE INDEX "Organization_deploymentMode_idx" ON "Organization"("deploymentMode");
CREATE INDEX "Organization_status_idx" ON "Organization"("status");
