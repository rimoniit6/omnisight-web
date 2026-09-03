-- Phase 3 — CategoryRule (additive, org-scoped)
-- Server-authoritative classification rules. When the org enables the
-- `server_classification` monitoring flag, application/website activity rows
-- are re-classified at ingestion: enabled rules first (ordered precedence —
-- lower priority number wins, ties by createdAt/id), then the built-in
-- default heuristic for unmatched rows. No existing data is modified.

CREATE TABLE "CategoryRule" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "matchType" TEXT NOT NULL,
    "pattern" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "priority" INTEGER NOT NULL DEFAULT 100,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "CategoryRule_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "CategoryRule_organizationId_idx" ON "CategoryRule"("organizationId");
CREATE INDEX "CategoryRule_organizationId_enabled_priority_idx" ON "CategoryRule"("organizationId", "enabled", "priority");

ALTER TABLE "CategoryRule" ADD CONSTRAINT "CategoryRule_organizationId_fkey"
    FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;