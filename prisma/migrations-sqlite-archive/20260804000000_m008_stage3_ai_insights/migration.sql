-- M008 Stage-3 — AI-powered analytics consumption layer (additive-only)

-- AI-generated insights persisted for caching and reproducibility
CREATE TABLE "AISummary" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "scope" TEXT NOT NULL,
    "scopeId" TEXT,
    "insightType" TEXT NOT NULL,
    "modelVersion" TEXT NOT NULL,
    "prompt" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "metrics" TEXT,
    "expiresAt" DATETIME NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

CREATE INDEX "AISummary_scope_scopeId_idx" ON "AISummary"("scope", "scopeId");
CREATE INDEX "AISummary_insightType_idx" ON "AISummary"("insightType");
CREATE INDEX "AISummary_expiresAt_idx" ON "AISummary"("expiresAt");
CREATE UNIQUE INDEX "AISummary_scope_scopeId_type_version_idx" ON "AISummary"("scope", "scopeId", "insightType", "modelVersion");

-- Report scheduling configuration
CREATE TABLE "ReportSchedule" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "title" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "scope" TEXT NOT NULL,
    "scopeId" TEXT,
    "period" TEXT NOT NULL,
    "frequency" TEXT NOT NULL,
    "dayOfWeek" INTEGER,
    "dayOfMonth" INTEGER,
    "hour" INTEGER NOT NULL DEFAULT 7,
    "minute" INTEGER NOT NULL DEFAULT 0,
    "timezone" TEXT NOT NULL DEFAULT 'UTC',
    "range" TEXT,
    "format" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT 1,
    "lastRunAt" DATETIME,
    "lastRunStatus" TEXT,
    "lastRunDurationMs" INTEGER,
    "lastRunError" TEXT,
    "lastReportId" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

CREATE INDEX "ReportSchedule_enabled_period_idx" ON "ReportSchedule"("enabled", "period");
CREATE INDEX "ReportSchedule_lastRunAt_idx" ON "ReportSchedule"("lastRunAt");

-- Audit log for AI regeneration, report generation, and schedule runs
CREATE TABLE "AuditLog" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "actor" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "entityType" TEXT NOT NULL,
    "entityId" TEXT,
    "detail" TEXT,
    "ip" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX "AuditLog_actor_idx" ON "AuditLog"("actor");
CREATE INDEX "AuditLog_action_idx" ON "AuditLog"("action");
CREATE INDEX "AuditLog_entityType_entityId_idx" ON "AuditLog"("entityType", "entityId");
CREATE INDEX "AuditLog_createdAt_idx" ON "AuditLog"("createdAt");
