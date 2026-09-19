import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { requireActiveSessionOrg, authError } from '@/lib/api';
import {
  MONITORING_KEYS,
  validateMonitoringValue,
  coerceMonitoringValue,
} from '@/lib/jobs/settings';
import type { MonitoringKey } from '@/lib/jobs/settings';
import { getOrganizationDeploymentMode } from '@/lib/deployment-mode';
import { log, requestContext } from '@/lib/logger';

// Org-scoped agent monitoring configuration. Values are persisted in the
// OrganizationSetting table (one row per org + key) and consumed by
// GET /api/agent/config — which the desktop agent syncs and applies to its
// scheduler at runtime (no agent restart required).
//
// S-1 / MON-1: there is NO fallback to the global SystemSetting. Every key is
// validated against the typed MONITORING_KEYS registry in src/lib/jobs/settings
// — booleans (true/false), whole numbers within the configured range, and
// 24-hour HH:MM times. Unknown keys are rejected outright.
//
// Screenshot cadence moved to the super-admin-owned Organization.screenshotInterval
// column (Prompt 3, item 1A). The legacy org-scoped `screenshot_frequency` key is
// therefore HIDDEN from the org-facing GET and only writable by a super admin in
// PUT — org admins can no longer misread a cadence that the agent config no
// longer honors. The key stays in MONITORING_KEYS so resolveOrgMonitoring and
// its stored rows remain valid, but org consumers never see it.
//
// The current cadence is exposed as `screenshotInterval` (the SUPER ADMIN-owned
// Organization column) with a `writable` flag derived from deployment mode:
//   - MANAGED          → read-only for org admins (cadence is centrally managed)
//   - CUSTOMER_DB      → org admins may write the column via this route
// Super admins may always write it (they also have the dedicated
// /api/admin/organizations/[orgId]/settings surface).

/** Monitoring keys an org admin may read/configure. `screenshot_frequency` is super-admin-only. */
const ORG_SETTABLE_KEYS = (Object.keys(MONITORING_KEYS) as MonitoringKey[]).filter(
  (k) => k !== 'screenshot_frequency'
);

/** Interval bounds for the Organization.screenshotInterval column (0 = disabled). */
const INTERVAL_MIN = 0;
const INTERVAL_MAX = 1440; // 24 hours
const INTERVAL_DEFAULT = 5; // matches the Prisma column default

function parseInterval(value: unknown): number | null {
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isSafeInteger(n) || n < INTERVAL_MIN || n > INTERVAL_MAX) return null;
  return n;
}

// GET /api/settings/monitoring — current monitoring configuration for the org
// with validation metadata (type, default, min/max) so the UI renders the
// right control without duplicating any validation rules.
// Manager+ (defense-in-depth: monitoring config reveals agent scheduling behavior).
export async function GET(req: NextRequest) {
  try {
    const scope = await requireActiveSessionOrg(req, { minRole: 'manager' });
    if (!scope.ok) {
      return authError(scope);
    }

    const orgId = scope.organizationId!;

    const rows = await db.organizationSetting.findMany({
      where: { organizationId: orgId, key: { in: Object.keys(MONITORING_KEYS) } },
      select: { key: true, value: true },
    });
    const stored = new Map(rows.map((r) => [r.key, r.value]));

    const settings = ORG_SETTABLE_KEYS.map((key) => {
      const def = MONITORING_KEYS[key];
      const raw = stored.get(key);
      const validated = raw !== undefined ? validateMonitoringValue(key, raw) : null;
      return {
        key,
        value: validated?.ok ? coerceMonitoringValue(key, validated.value) : def.default,
        type: def.type,
        default: def.default,
        // Numeric bounds only exist for `number` keys.
        min: 'min' in def ? def.min : undefined,
        max: 'max' in def ? def.max : undefined,
      };
    });

    // Screenshot cadence, derived from the SUPER ADMIN-OWNED Organization
    // column. `writable` follows deployment mode: MANAGED is centrally managed
    // (read-only for org admins); CUSTOMER_DB org admins may set it.
    const mode = await getOrganizationDeploymentMode(orgId);
    const intervalOrg = await db.organization.findUnique({
      where: { id: orgId },
      select: { screenshotInterval: true },
    });

    return NextResponse.json({
      data: settings,
      screenshotInterval: {
        key: 'screenshotInterval',
        value: intervalOrg?.screenshotInterval ?? INTERVAL_DEFAULT,
        type: 'number',
        default: INTERVAL_DEFAULT,
        min: INTERVAL_MIN,
        max: INTERVAL_MAX,
        writable: scope.role === 'super_admin' || mode !== 'MANAGED',
        deploymentMode: mode,
      },
    });
  } catch (error) {
    log.error('api.settings.monitoring.', { error: String('Monitoring settings GET error:') }, requestContext(req));
    return NextResponse.json({ error: 'Failed to fetch monitoring settings' }, { status: 500 });
  }
}

// PUT /api/settings/monitoring — update one monitoring setting (org_admin+).
// Validated against the typed registry, tenant-scoped, and audited.
export async function PUT(req: NextRequest) {
  try {
    const auth = await requireActiveSessionOrg(req, { minRole: 'org_admin' });
    if (!auth.ok) {
      return authError(auth);
    }

    const body = await req.json();
    const { key, value } = body as { key?: string; value?: unknown };

    // organizationId is guaranteed non-null here because minRole was specified.
    const orgId = auth.organizationId!;

    // Screenshot cadence special case: writes the SUPER ADMIN-owned
    // Organization.screenshotInterval column. Org admins may write it ONLY on
    // non-MANAGED deployment modes (CUSTOMER_DB self-managed plans);
    // on MANAGED plans the cadence is centrally managed (super-admin only).
    if (key === 'screenshotInterval') {
      if (auth.role !== 'super_admin') {
        const intervalMode = await getOrganizationDeploymentMode(orgId);
        if (intervalMode === 'MANAGED') {
          return NextResponse.json(
            {
              error:
                'Screenshot cadence is centrally managed on this plan; it is read-only for your role.',
            },
            { status: 403 }
          );
        }
      }

      const interval = parseInterval(value);
      if (interval === null) {
        return NextResponse.json(
          { error: `screenshotInterval must be a whole number between ${INTERVAL_MIN} and ${INTERVAL_MAX} minutes (0 = disabled)` },
          { status: 422 }
        );
      }

      await db.$transaction(async (tx) => {
        await tx.organization.update({
          where: { id: orgId },
          data: { screenshotInterval: interval },
        });
        await tx.auditLog.create({
          data: {
            action: 'configure',
            resource: 'organization',
            resourceId: orgId,
            description: `Screenshot interval set to ${interval} minute(s) by ${auth.email}`,
            userId: auth.userId,
            organizationId: orgId,
          },
        });
      });

      return NextResponse.json({ data: { key: 'screenshotInterval', value: interval } });
    }

    if (!key || !(key in MONITORING_KEYS)) {
      return NextResponse.json(
        { error: `Invalid monitoring key. Valid: ${Object.keys(MONITORING_KEYS).join(', ')}` },
        { status: 400 }
      );
    }

    // Prompt 3 / item 1A: screenshot cadence is now owned by the super-admin-
    // set Organization.screenshotInterval column. Block org admins from writing
    // the legacy org-scoped key (defense-in-depth; super admins alone may
    // update it for backward-compat rows).
    if (key === 'screenshot_frequency' && auth.role !== 'super_admin') {
      return NextResponse.json(
        { error: 'Screenshot cadence is managed by the super admin; this key is read-only for your role.' },
        { status: 403 }
      );
    }

    // Central typed validation: booleans, whole numbers in range, HH:MM times.
    const validation = validateMonitoringValue(key as MonitoringKey, value);
    if (!validation.ok) {
      return NextResponse.json({ error: validation.error }, { status: 422 });
    }

    const setting = await db.$transaction(async (tx) => {
      const upserted = await tx.organizationSetting.upsert({
        where: { organizationId_key: { organizationId: orgId, key } },
        update: { value: validation.value, category: 'monitoring' },
        create: { organizationId: orgId, key, value: validation.value, category: 'monitoring' },
      });
      await tx.auditLog.create({
        data: {
          action: 'configure',
          resource: 'settings',
          resourceId: upserted.id,
          description: `Agent monitoring setting ${key} set to ${validation.value} by ${auth.email}`,
          userId: auth.userId,
          organizationId: orgId,
        },
      });
      return upserted;
    });

    return NextResponse.json({ data: { key, value: validation.value }, setting });
  } catch (error) {
    log.error('api.settings.monitoring.', { error: String('Monitoring settings PUT error:') }, requestContext(req));
    return NextResponse.json({ error: 'Failed to update monitoring setting' }, { status: 500 });
  }
}
