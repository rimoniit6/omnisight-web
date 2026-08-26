'use server';
import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { authError, requireAdminOrg } from '@/lib/api';
import { log, requestContext } from '@/lib/logger';

export async function POST(req: NextRequest) {
  try {
    // Mutation: admin-or-above role required. Notifications are scoped to the
    // caller's organization — cross-org ids are silently ignored.
    const scope = await requireAdminOrg(req);
    if (!scope.ok) return authError(scope);
    const orgId = scope.organizationId;

    let body: Record<string, unknown>;
    try {
      body = await req.json();
    } catch {
      return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
    }
    const { action, ids } = body as { action?: unknown; ids?: unknown };

    if (!action || typeof action !== 'string' || !Array.isArray(ids) || ids.length === 0) {
      return NextResponse.json(
        { error: 'action and non-empty ids array are required' },
        { status: 400 }
      );
    }
    // N-11: bound the batch size — a single request must not enumerate an
    // unbounded id set.
    if (ids.length > 200) {
      return NextResponse.json({ error: 'ids must contain at most 200 entries' }, { status: 422 });
    }
    if (!ids.every((i) => typeof i === 'string')) {
      return NextResponse.json({ error: 'ids must be strings' }, { status: 422 });
    }

    const validActions = ['mark_read', 'archive', 'delete'];
    if (!validActions.includes(action)) {
      return NextResponse.json(
        { error: `Invalid action. Must be one of: ${validActions.join(', ')}` },
        { status: 400 }
      );
    }

    // Only operate on notifications that belong to the caller's org.
    const where = { id: { in: ids }, organizationId: orgId };

    if (action === 'mark_read') {
      const now = new Date();
      const result = await db.notification.updateMany({
        where,
        data: { status: 'read', readAt: now },
      });
      return NextResponse.json({ success: true, affected: result.count });
    }

    if (action === 'archive') {
      const result = await db.notification.updateMany({
        where,
        data: { status: 'archived' },
      });
      return NextResponse.json({ success: true, affected: result.count });
    }

    if (action === 'delete') {
      const result = await db.notification.deleteMany({ where });
      return NextResponse.json({ success: true, affected: result.count });
    }

    return NextResponse.json({ error: 'Unknown action' }, { status: 400 });
  } catch (error) {
    log.error('api.notifications.batch.', { error: String('Notifications batch error:') }, requestContext(req));
    return NextResponse.json({ error: 'Failed to perform batch operation' }, { status: 500 });
  }
}
