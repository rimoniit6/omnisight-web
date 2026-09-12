import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { requireSuperAdmin } from '@/lib/api';
import { log, requestContext } from '@/lib/logger';

// GET /api/super-admin/notifications/count
// Returns unread count for Super Admin including:
// - Unread Notification rows (platform-level, no org scoping)
// - NEW Lead submissions (treated as unread platform notifications)
export async function GET(req: NextRequest) {
  const authResult = await requireSuperAdmin(req);
  if (!authResult.ok) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const [notifUnread, leadUnread] = await Promise.all([
      db.notification.count({ where: { status: 'unread' } }),
      db.lead.count({ where: { status: 'NEW' } }),
    ]);
    const unreadCount = notifUnread + leadUnread;

    return NextResponse.json({ unread: unreadCount, total: unreadCount });
  } catch (error) {
    log.error('api.super-admin.notifications.count', { error: String(error) }, requestContext(req));
    return NextResponse.json({ error: 'Failed to fetch count' }, { status: 500 });
  }
}
