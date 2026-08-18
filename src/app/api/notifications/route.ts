'use server';
import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { authError, requireSessionOrg, requireManagerOrg, validatePagination } from '@/lib/api';
import { createOrgNotification, NotificationValidationError } from '@/lib/notifications/service';
import { validateTitle, validateMessage } from '@/lib/notifications/validation';

export async function GET(req: NextRequest) {
  try {
    // Tenant isolation: notifications are organization-scoped from the verified
    // session — never from client input. Org-less super_admins get an empty
    // payload (bootstrap state).
    const scope = await requireSessionOrg(req, { allowGlobal: true });
    if (!scope.ok) return authError(scope);
    if (!scope.organizationId) {
      return NextResponse.json({
        data: [], total: 0, page: 1, pageSize: 10, totalPages: 0, unreadCount: 0,
        stats: { byType: {}, byPriority: {}, recentCount: 0 },
      });
    }
    const orgId = scope.organizationId;

    const { searchParams } = new URL(req.url);

    // N-1: strict pagination — malformed/negative/zero/oversized values are a
    // controlled 4xx, never a Prisma NaN/negative skip/take (500).
    const pagination = validatePagination(searchParams, { defaultPageSize: 10, maxPageSize: 200 });
    if (!pagination.ok) {
      return NextResponse.json({ error: pagination.error }, { status: pagination.status });
    }
    const { page, pageSize, skip } = pagination;

    const status = searchParams.get('status');
    const typeParam = searchParams.get('type');
    const priority = searchParams.get('priority');
    const search = searchParams.get('search');
    const entityType = searchParams.get('entityType');

    const where: Record<string, unknown> = { organizationId: orgId };
    if (status) where.status = status;
    if (priority) where.priority = priority;
    if (entityType) where.entityType = entityType;
    if (typeParam) {
      const types = typeParam.split(',').map((t) => t.trim()).filter(Boolean);
      if (types.length === 1) {
        where.type = types[0];
      } else if (types.length > 1) {
        where.type = { in: types };
      }
    }
    if (search) {
      where.OR = [
        { title: { contains: search } },
        { message: { contains: search } },
      ];
    }

    const [notifications, total] = await Promise.all([
      db.notification.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip,
        take: pageSize,
      }),
      db.notification.count({ where }),
    ]);

    const unreadCount = await db.notification.count({ where: { status: 'unread', organizationId: orgId } });
    const totalPages = Math.ceil(total / pageSize);

    // Aggregate stats — same org scope
    const twentyFourHoursAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const recentCount = await db.notification.count({
      where: { organizationId: orgId, createdAt: { gte: twentyFourHoursAgo } },
    });

    const typeAgg = await db.notification.groupBy({
      by: ['type'],
      where: { organizationId: orgId },
      _count: { type: true },
    });
    const byType: Record<string, number> = {};
    typeAgg.forEach((t) => { byType[t.type] = t._count.type; });

    const priorityAgg = await db.notification.groupBy({
      by: ['priority'],
      where: { organizationId: orgId },
      _count: { priority: true },
    });
    const byPriority: Record<string, number> = {};
    priorityAgg.forEach((p) => { byPriority[p.priority] = p._count.priority; });

    return NextResponse.json({
      data: notifications,
      total,
      page,
      pageSize,
      totalPages,
      unreadCount,
      stats: { byType, byPriority, recentCount },
    });
  } catch (error) {
    console.error('Notifications GET error:', error);
    return NextResponse.json({ error: 'Failed to fetch notifications' }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  try {
    // N-2: mutations require manager-or-above. The organization (and the audit
    // actor) always come from the verified session — never the request body.
    const manager = await requireManagerOrg(req);
    if (!manager.ok) return authError(manager);
    const orgId = manager.organizationId;

    let body: Record<string, unknown>;
    try {
      body = await req.json();
    } catch {
      return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
    }

    const { title, message, type, priority, actionUrl, entityType, entityId } = body as Record<string, unknown>;

    // Canonical validation (N-2): type/priority against the canonical sets,
    // safe actionUrl, bounded lengths. Never persist arbitrary strings.
    const titleErr = validateTitle(title);
    if (titleErr) return NextResponse.json({ error: titleErr }, { status: 422 });
    const messageErr = validateMessage(message);
    if (messageErr) return NextResponse.json({ error: messageErr }, { status: 422 });

    let notification: { id: string } | null;
    try {
      notification = await db.$transaction((tx) =>
        createOrgNotification(tx, {
          title: title as string,
          message: message as string,
          type: type as string,
          priority: (priority as string) || 'medium',
          actionUrl: actionUrl as string | undefined,
          entityType: entityType as string | undefined,
          entityId: entityId as string | undefined,
          organizationId: orgId,
        })
      );
    } catch (error) {
      if (error instanceof NotificationValidationError) {
        return NextResponse.json({ error: error.message }, { status: 422 });
      }
      throw error;
    }

    if (!notification) {
      // Org disabled this type — not an error, but nothing to show.
      return NextResponse.json({ data: null, skipped: true }, { status: 201 });
    }

    // Audit the creation with the AUTHENTICATED actor (N-2 / actor integrity).
    await db.auditLog.create({
      data: {
        action: 'create',
        resource: 'notification',
        resourceId: notification.id,
        description: `Notification created: ${String(title).slice(0, 100)} (${String(type)})`,
        userId: manager.userId,
        organizationId: orgId,
      },
    });

    return NextResponse.json({ data: notification }, { status: 201 });
  } catch (error) {
    console.error('Notifications POST error:', error);
    return NextResponse.json({ error: 'Failed to create notification' }, { status: 500 });
  }
}

export async function PUT(req: NextRequest) {
  try {
    // Org-bound session required for mutations (cross-org notification
    // updates are rejected).
    const scope = await requireSessionOrg(req);
    if (!scope.ok) return authError(scope);
    if (!scope.organizationId) {
      return NextResponse.json({ error: 'Insufficient permissions' }, { status: 403 });
    }
    const orgId: string = scope.organizationId;

    const body = await req.json();
    const { id, status, markAllRead, archive, archiveSelected } = body;

    // Archive a single notification
    if (archive && id) {
      const existing = await db.notification.findFirst({ where: { id, organizationId: orgId }, select: { id: true } });
      if (!existing) return NextResponse.json({ error: 'Notification not found' }, { status: 404 });
      const notification = await db.notification.update({
        where: { id },
        data: { status: 'archived' },
      });
      return NextResponse.json({ data: notification });
    }

    // Archive multiple notifications
    if (archiveSelected && Array.isArray(archiveSelected)) {
      const result = await db.notification.updateMany({
        where: { id: { in: archiveSelected }, organizationId: orgId },
        data: { status: 'archived' },
      });
      return NextResponse.json({ success: true, archived: result.count });
    }

    if (markAllRead) {
      const now = new Date();
      await db.notification.updateMany({
        where: { status: 'unread', organizationId: orgId },
        data: { status: 'read', readAt: now },
      });
      return NextResponse.json({ success: true });
    }

    if (!id) return NextResponse.json({ error: 'ID is required' }, { status: 400 });

    const existing = await db.notification.findFirst({ where: { id, organizationId: orgId }, select: { id: true } });
    if (!existing) return NextResponse.json({ error: 'Notification not found' }, { status: 404 });

    // Canonical status only (N-7) — arbitrary strings are rejected.
    const newStatus = status || 'read';
    if (newStatus !== 'unread' && newStatus !== 'read' && newStatus !== 'archived') {
      return NextResponse.json({ error: 'status must be unread, read, or archived' }, { status: 422 });
    }

    const updateData: Record<string, unknown> = { status: newStatus };
    if (newStatus === 'read') {
      updateData.readAt = new Date();
    }

    const notification = await db.notification.update({
      where: { id },
      data: updateData,
    });
    return NextResponse.json({ data: notification });
  } catch (error) {
    console.error('Notifications PUT error:', error);
    return NextResponse.json({ error: 'Failed to update notification' }, { status: 500 });
  }
}
