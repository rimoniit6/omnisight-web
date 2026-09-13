-- Backfill org-scoped screenshot_enabled for every organization.
--
-- Context: the desktop agent resolves screenshot cadence from the SUPER
-- ADMIN-owned Organization.screenshotInterval column (GET /api/agent/config),
-- and the effective frequency is now ZERO when either the plan excludes
-- screenshots or org screenshot_enabled is false. Every org must therefore
-- have an explicit org-scoped screenshot_enabled row so the org toggle, the
-- agent config gate and the upload gate agree.
--
-- Idempotency: ON CONFLICT ("organizationId","key") DO NOTHING preserves any
-- existing value (rows already present — incl. those backfilled by
-- 20260811153544_admin_panel_production_ready — are untouched). Re-running is
-- a no-op. Follows the same 'os_' + md5(orgId + key) id scheme as that
-- migration.

INSERT INTO "OrganizationSetting" ("id", "organizationId", "key", "value", "category", "updatedAt")
SELECT
  ('os_' || md5(o."id" || 'screenshot_enabled'))::text,
  o."id",
  'screenshot_enabled',
  CASE WHEN o."screenshotInterval" = 0 THEN 'false' ELSE 'true' END,
  'monitoring',
  now()
FROM "Organization" o
ON CONFLICT ("organizationId", "key") DO NOTHING;