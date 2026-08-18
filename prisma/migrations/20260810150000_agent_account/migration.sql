-- AgentAccount: dedicated 1:1 credentials row for the authenticated agent login
-- flow (Phase 1 — Employee Agent Authentication + Multi-Device Registration).
--
-- ADDITIVE ONLY: nothing existing is altered. The legacy Employee.agentPassword
-- column and Employee.agentApproved flag are kept intact for the zero-touch and
-- legacy PATH B flows (never remove working functionality).
--
-- Backfill semantics:
--   - Employee.agentPassword is a bcrypt hash ($2...)  -> copied verbatim (works as-is)
--   - Employee.agentPassword is legacy plaintext       -> copied verbatim; the
--     AgentAccountService.verifyCredential() upgrades it to bcrypt on first
--     successful verify (same in-place pattern as verifyAgentPassword)
--   - Employee.agentPassword is NULL                   -> account created DISABLED
--     with an unguessable placeholder hash (admin must enable + set credentials)

CREATE TABLE "AgentAccount" (
    "id" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "agentId" TEXT NOT NULL,
    "passwordHash" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'active',
    "lastLoginAt" TIMESTAMP(3),
    "failedLoginCount" INTEGER NOT NULL DEFAULT 0,
    "lockedUntil" TIMESTAMP(3),
    "passwordChangedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AgentAccount_pkey" PRIMARY KEY ("id")
);

-- Backfill: one AgentAccount per Employee.
INSERT INTO "AgentAccount" ("id", "employeeId", "agentId", "passwordHash", "status")
SELECT
    'aa_' || e."id",
    e."id",
    e."employeeId",
    COALESCE(e."agentPassword", '$2b$12$tHN15YZg2r9uKeW6c.k4Nusjf4mw2sFmuldY3RrnxwXOTKfgKuYsa'),
    CASE WHEN e."agentPassword" IS NULL THEN 'disabled' ELSE 'active' END
FROM "Employee" e;

-- Uniqueness + FK.
CREATE UNIQUE INDEX "AgentAccount_employeeId_key" ON "AgentAccount"("employeeId");
CREATE UNIQUE INDEX "AgentAccount_agentId_key" ON "AgentAccount"("agentId");
CREATE INDEX "AgentAccount_status_idx" ON "AgentAccount"("status");
ALTER TABLE "AgentAccount" ADD CONSTRAINT "AgentAccount_employeeId_fkey"
    FOREIGN KEY ("employeeId") REFERENCES "Employee"("id") ON DELETE CASCADE ON UPDATE CASCADE;
