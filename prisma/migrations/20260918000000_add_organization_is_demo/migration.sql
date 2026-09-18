-- OmniSight — Demo-First Experience: demo organization marker.
--
-- The demo is a normal MANAGED tenant with fictional deterministic data and a
-- lease-guarded simulator. This column is the authoritative server-side
-- identification for the demo organization:
--   • written ONLY by the idempotent bootstrap (scripts/bootstrap-demo.ts)
--   • never accepted as input by any public/authenticated API
--   • read by server guards (src/lib/demo), job exclusions and the UI banner
--
-- PARTIAL UNIQUE INDEX: at most ONE demo organization may ever exist, so a
-- misconfigured bootstrap can never silently create a second demo tenant
-- (demo uniqueness is a security property — the demo entry route resolves the
-- demo org by this marker and must never be ambiguous).

ALTER TABLE "Organization" ADD COLUMN "isDemo" BOOLEAN NOT NULL DEFAULT false;

CREATE UNIQUE INDEX "Organization_isDemo_key" ON "Organization"("isDemo") WHERE "isDemo" = true;

-- Dotenv environment: PostgreSQL — index names follow Prisma convention.
