import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { authenticateRequest, getSessionOrg, requireManagerOrg, authError } from '@/lib/api';
import { hasRolePermission } from '@/lib/auth';
import {
  MONITORING_KEYS,
  validateMonitoringValue,
  coerceMonitoringValue,
} from '@/lib/jobs/settings';
import type { MonitoringKey } from '@/lib/jobs/settings';
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

/** Monitoring keys an org admin may read/configure. `screenshot_frequency` is super-admin-only. */
const ORG_SETTABLE_KEYS = (Object.keys(MONITORING_KEYS) as MonitoringKey[]).filter(
  (k) => k !== 'screenshot_frequency'
);

// GET /api/settings/monitoring — current monitoring configuration for the org
// with validation metadata (type, default, min/max) so the UI renders the
// right control without duplicating any validation rules.
// Manager+ (defense-in-depth: monitoring config reveals agent scheduling behavior).
export async function GET(req: NextRequest) {
  try {
    const scope = await requireManagerOrg(req);
    if (!scope.ok) {
      return authError(scope);
    }

    const rows = await db.organizationSetting.findMany({
      where: { organizationId: scope.organizationId, key: { in: Object.keys(MONITORING_KEYS) } },
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

    return NextResponse.json({ data: settings });
  } catch (error) {
    log.error('api.settings.monitoring.', { error: String('Monitoring settings GET error:') }, requestContext(req));
    return NextResponse.json({ error: 'Failed to fetch monitoring settings' }, { status: 500 });
  }
}

// PUT /api/settings/monitoring — update one monitoring setting (admin+).
// Validated against the typed registry, tenant-scoped, and audited.
export async function PUT(req: NextRequest) {
  try {
    const auth = await authenticateRequest(req);
    if (!auth) {
      return NextResponse.json({ error: 'Unauthorized. Please sign in.' }, { status: 401 });
    }
    if (!hasRolePermission(auth.role, 'admin')) {
      return NextResponse.json({ error: 'Insufficient permissions' }, { status: 403 });
    }
    const org = await getSessionOrg(req);
    if (!org) return NextResponse.json({ error: 'No organization found' }, { status: 404 });

    const body = await req.json();
    const { key, value } = body as { key?: string; value?: unknown };

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
        where: { organizationId_key: { organizationId: org.id, key } },
        update: { value: validation.value, category: 'monitoring' },
        create: { organizationId: org.id, key, value: validation.value, category: 'monitoring' },
      });
      await tx.auditLog.create({
        data: {
          action: 'configure',
          resource: 'settings',
          resourceId: upserted.id,
          description: `Agent monitoring setting ${key} set to ${validation.value} by ${auth.email}`,
          userId: auth.userId,
          organizationId: org.id,
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
