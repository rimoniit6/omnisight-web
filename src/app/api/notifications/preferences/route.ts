'use server';
import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { authError, requireSessionOrg, requireManagerOrg } from '@/lib/api';
import { NOTIFICATION_TYPE_REGISTRY, isNotificationType } from '@/lib/notifications/constants';
import { log, requestContext } from '@/lib/logger';

// GET /api/notifications/preferences
// Organization-level notification preferences (notifications are org-broadcast,
// not per-recipient — N-6). Returns every canonical type with its effective
// enabled state (absent row = enabled, the product default).
export async function GET(req: NextRequest) {
  try {
    const scope = await requireSessionOrg(req, { allowGlobal: true });
    if (!scope.ok) return authError(scope);
    if (!scope.organizationId) {
      return NextResponse.json({ preferences: [] });
    }
    const orgId = scope.organizationId;

    const rows = await db.notificationPreference.findMany({
      where: { organizationId: orgId },
      select: { notificationType: true, enabled: true },
    });
    const byType = new Map(rows.map((r) => [r.notificationType, r.enabled]));

    const preferences = NOTIFICATION_TYPE_REGISTRY.map((t) => ({
      notificationType: t.value,
      label: t.label,
      active: t.active,
      enabled: byType.get(t.value) ?? true, // absent = enabled
    }));

    return NextResponse.json({ preferences });
  } catch (error) {
    log.error('api.notifications.preferences.', { error: String('Notification preferences GET error:') }, requestContext(req));
    return NextResponse.json({ error: 'Failed to fetch preferences' }, { status: 500 });
  }
}

// PUT /api/notifications/preferences
// Manager+ can enable/disable a canonical notification type org-wide. The
// change is honored by every producer via createOrgNotification().
export async function PUT(req: NextRequest) {
  try {
    const manager = await requireManagerOrg(req);
    if (!manager.ok) return authError(manager);

    let body: Record<string, unknown>;
    try {
      body = await req.json();
    } catch {
      return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
    }
    const { notificationType, enabled } = body;

    if (!isNotificationType(notificationType)) {
      return NextResponse.json({ error: 'notificationType must be a supported notification type' }, { status: 422 });
    }
    if (typeof enabled !== 'boolean') {
      return NextResponse.json({ error: 'enabled must be a boolean' }, { status: 422 });
    }

    await db.notificationPreference.upsert({
      where: {
        organizationId_notificationType: {
          organizationId: manager.organizationId,
          notificationType: notificationType,
        },
      },
      create: {
        organizationId: manager.organizationId,
        notificationType: notificationType,
        enabled,
      },
      update: { enabled },
    });

    return NextResponse.json({ success: true, notificationType, enabled });
  } catch (error) {
    log.error('api.notifications.preferences.', { error: String('Notification preferences PUT error:') }, requestContext(req));
    return NextResponse.json({ error: 'Failed to update preference' }, { status: 500 });
  }
}
