-- AgentSession: short-lived, LOGIN-ONLY credential for the Agent EXE (Phase 3).
--
-- ADDITIVE ONLY: nothing existing is altered. The device-bound AgentToken +
-- validateAgentToken() path (zero-touch / PATH A authenticate) stays untouched.
--
-- Security property: an AgentSession is NOT a device credential and is valid
-- ONLY for the authenticated branch of POST /api/agent/discover (and logout).
-- Heartbeat / activity / screenshot / config still require a device-bound
-- AgentToken issued AFTER an admin approves the DeviceClaim. This prevents a
-- login token from granting pre-approval device access.
--
-- Ephemeral by design: no FK constraints, so deleting an Employee/AgentAccount
-- does not cascade into (or block on) an expiring session row.

CREATE TABLE "AgentSession" (
    "id"             TEXT NOT NULL,
    "token"          TEXT NOT NULL,
    "employeeId"     TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "ipAddress"      TEXT,
    "expiresAt"      TIMESTAMP(3) NOT NULL,
    "lastUsedAt"     TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AgentSession_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "AgentSession_token_key" ON "AgentSession"("token");
CREATE INDEX "AgentSession_employeeId_idx" ON "AgentSession"("employeeId");
CREATE INDEX "AgentSession_expiresAt_idx" ON "AgentSession"("expiresAt");