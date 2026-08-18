-- Admin Panel Production Readiness (S-1/MON-1 cross-tenant monitoring bleed,
-- MON-2 dead MonitoringPolicy, P3 dead security settings).
--
-- 1. Drop the dead MonitoringPolicy table (proven: dev-seed writer only, 0 live
--    rows, both read sites re-pointed to org-scoped settings).
-- 2. Backfill monitoring configuration from the GLOBAL SystemSetting into the
--    ORG-SCOPED OrganizationSetting for every existing organization, so current
--    values are preserved per-org (ON CONFLICT DO NOTHING).
-- 3. Remove the migrated monitoring keys + dead security settings from
--    SystemSetting. SystemSetting itself remains (global app/AI/branding keys).

-- DropForeignKey
ALTER TABLE "MonitoringPolicy" DROP CONSTRAINT "MonitoringPolicy_organizationId_fkey";

-- DropTable
DROP TABLE "MonitoringPolicy";

-- ── Backfill monitoring keys: SystemSetting → OrganizationSetting (per org) ──
INSERT INTO "OrganizationSetting" ("id", "organizationId", "key", "value", "category", "updatedAt")
SELECT
  ('os_' || md5(o."id" || s.key))::text,
  o."id",
  s.key,
  s."value",
  'monitoring',
  now()
FROM "SystemSetting" s
CROSS JOIN "Organization" o
WHERE s.key IN (
  'heartbeat_interval',
  'screenshot_enabled',
  'screenshot_frequency',
  'screenshot_retention_days',
  'app_tracking',
  'website_tracking',
  'idle_detection',
  'idle_timeout',
  'working_hours_only',
  'work_start_time',
  'work_end_time',
  'ai_anomaly_detection'
)
ON CONFLICT ("organizationId", "key") DO NOTHING;

-- ── Remove migrated monitoring keys from the global SystemSetting ────────────
-- Consumers (GET /api/agent/config, /api/settings/monitoring, anomaly
-- detection) now resolve these ONLY from OrganizationSetting.
DELETE FROM "SystemSetting"
WHERE key IN (
  'heartbeat_interval',
  'screenshot_enabled',
  'screenshot_frequency',
  'screenshot_retention_days',
  'app_tracking',
  'website_tracking',
  'idle_detection',
  'idle_timeout',
  'working_hours_only',
  'work_start_time',
  'work_end_time',
  'ai_anomaly_detection'
);

-- ── Remove dead/cosmetic security settings ──────────────────────────────────
-- No code ever consumed these (2FA is not implemented; admin session lifetime
-- is governed by JWT_EXPIRES_IN; login brute force by the per-IP+email rate
-- limit). Keeping the rows would let the UI falsely present them as active.
DELETE FROM "SystemSetting"
WHERE key IN ('two_factor_auth', 'session_timeout_minutes', 'max_login_attempts');
