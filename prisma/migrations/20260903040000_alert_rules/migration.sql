-- Phase 5 — AlertRule + AlertRuleFiring (additive, org-scoped)
-- Admin-configurable server-side alert rules evaluated by the lease-guarded
-- alert-rule job. Each rule is one STRUCTURED condition (never code) over
-- real telemetry; a firing creates an Alert (+ Notification for higher
-- severities) through the shared notification service and records the
-- (rule, entity) firing so cooldown dedupes repeats. AlertRuleFiring's unique
-- (ruleId, entityType, entityId) is the DB-enforced cooldown boundary — a
-- replayed or concurrent evaluation cannot double-fire for the same entity.
-- No existing data is modified.

CREATE TABLE "AlertRule" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "conditionType" TEXT NOT NULL,
    "params" TEXT NOT NULL,
    "severity" TEXT NOT NULL DEFAULT 'warning',
    "cooldownMinutes" INTEGER NOT NULL DEFAULT 60,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "AlertRule_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "AlertRuleFiring" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "ruleId" TEXT NOT NULL,
    "entityType" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "lastFiredAt" TIMESTAMP(3) NOT NULL,
    "alertId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "AlertRuleFiring_pkey" PRIMARY KEY ("id")
);

-- Indexes for the org-scoped rule load and the job's enabled-rule lookup.
CREATE INDEX "AlertRule_organizationId_idx" ON "AlertRule"("organizationId");
CREATE INDEX "AlertRule_organizationId_enabled_idx" ON "AlertRule"("organizationId", "enabled");

-- Firing lookups per org / per rule + the cooldown unique boundary.
CREATE UNIQUE INDEX "AlertRuleFiring_ruleId_entityType_entityId_key" ON "AlertRuleFiring"("ruleId", "entityType", "entityId");
CREATE INDEX "AlertRuleFiring_organizationId_idx" ON "AlertRuleFiring"("organizationId");
CREATE INDEX "AlertRuleFiring_ruleId_idx" ON "AlertRuleFiring"("ruleId");

ALTER TABLE "AlertRule" ADD CONSTRAINT "AlertRule_organizationId_fkey"
    FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "AlertRuleFiring" ADD CONSTRAINT "AlertRuleFiring_organizationId_fkey"
    FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "AlertRuleFiring" ADD CONSTRAINT "AlertRuleFiring_ruleId_fkey"
    FOREIGN KEY ("ruleId") REFERENCES "AlertRule"("id") ON DELETE CASCADE ON UPDATE CASCADE;
