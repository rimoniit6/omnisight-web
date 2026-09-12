import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { requireSuperAdmin, apiError, apiSuccess, validatePagination } from '@/lib/api';
import { log, requestContext } from '@/lib/logger';

// Unified item shape returned to the frontend — both Notification rows and
// Lead submissions are projected into this shape so the UI can render them
// with one consistent component.
interface UnifiedItem {
  id: string;
  title: string;
  message: string;
  type: string;
  priority: string;
  status: string;
  createdAt: string;
  // Lead-specific fields (null for Notification rows).
  leadId: string | null;
  name: string | null;
  email: string | null;
  company: string | null;
  planInterest: string | null;
  // Notification-specific fields.
  actionUrl: string | null;
  entityType: string | null;
  entityId: string | null;
}

// GET /api/super-admin/notifications — Super Admin notification inbox
// Returns notifications + lead submissions for Super Admin review
export async function GET(req: NextRequest) {
  const authResult = await requireSuperAdmin(req);
  if (!authResult.ok) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const { searchParams } = new URL(req.url);
  const pagination = validatePagination(searchParams, { defaultPageSize: 20, maxPageSize: 100 });
  if (!pagination.ok) return apiError(pagination.error, pagination.status);

  const { page, pageSize, skip } = pagination;
  const type = searchParams.get('type');
  const status = searchParams.get('status');
  const includeLeads = searchParams.get('includeLeads') !== 'false';

  // Fetch notifications (organization-scoped)
  const notificationsWhere: Record<string, unknown> = {};
  if (type && type !== 'lead_submission') notificationsWhere.type = type;
  if (status) notificationsWhere.status = status;

  const [notifications, notificationsTotal] = await Promise.all([
    db.notification.findMany({
      where: notificationsWhere,
      orderBy: { createdAt: 'desc' },
      skip,
      take: pageSize,
      include: {
        organization: {
          select: { id: true, name: true, slug: true },
        },
      },
    }),
    db.notification.count({ where: notificationsWhere }),
  ]);

  // Fetch lead submissions (platform-level business requests)
  let leads: UnifiedItem[] = [];
  let leadsTotal = 0;
  if (includeLeads && (type === 'lead_submission' || !type)) {
    const leadsWhere: Record<string, unknown> = { status: 'NEW' };
    const [leadsData, leadsCount] = await Promise.all([
      db.lead.findMany({
        where: leadsWhere,
        orderBy: { createdAt: 'desc' },
        skip,
        take: pageSize,
      }),
      db.lead.count({ where: leadsWhere }),
    ]);
    leads = leadsData.map((lead) => ({
      id: lead.id,
      title: 'New Lead Submission',
      message: `New ${lead.planInterest} lead from ${lead.name}${lead.company ? ` (${lead.company})` : ''} — ${lead.email}`,
      type: 'lead_submission',
      priority: 'medium',
      status: 'new',
      createdAt: lead.createdAt.toISOString(),
      leadId: lead.id,
      name: lead.name,
      email: lead.email,
      company: lead.company,
      planInterest: lead.planInterest,
      actionUrl: null,
      entityType: null,
      entityId: null,
    }));
    leadsTotal = leadsCount;
  }

  // Combine notifications + leads into a unified shape, then sort by
  // createdAt descending so the most recent item (of either kind) appears first.
  const allItems: UnifiedItem[] = [
    ...leads,
    ...notifications.map((n) => ({
      id: n.id,
      title: n.title,
      message: n.message,
      type: n.type,
      priority: n.priority,
      status: n.status,
      createdAt: n.createdAt.toISOString(),
      leadId: null,
      name: null,
      email: null,
      company: null,
      planInterest: null,
      actionUrl: n.actionUrl,
      entityType: n.organization ? 'organization' : null,
      entityId: n.organization?.id ?? null,
    })),
  ]
    .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
    .slice(0, pageSize);

  const total = leadsTotal + notificationsTotal;
  // Unread count includes both unread notifications AND NEW leads (which are
  // always unread until processed by Super Admin).
  const [notifUnread, leadUnread] = await Promise.all([
    db.notification.count({ where: { status: 'unread' } }),
    includeLeads ? db.lead.count({ where: { status: 'NEW' } }) : 0,
  ]);
  const unreadCount = notifUnread + leadUnread;

  return apiSuccess({
    data: allItems,
    pagination: { page, pageSize, total, pages: Math.ceil(total / pageSize) },
    unreadCount,
    includesLeads: includeLeads,
  });
}

// PUT /api/super-admin/notifications — update notification status OR lead status
// Super Admin can mark notifications as read/archived and update lead lifecycle
// status (NEW -> CONTACTED/CONVERTED/IGNORED).
export async function PUT(req: NextRequest) {
  const authResult = await requireSuperAdmin(req);
  if (!authResult.ok) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return apiError('Invalid JSON body', 400);
  }

  const id = body.id as string | undefined;
  const status = body.status as string | undefined;
  const leadStatus = body.leadStatus as string | undefined;
  const markAllRead = body.markAllRead as boolean | undefined;

  // Mark all notifications as read (and mark NEW leads as CONTACTED)
  if (markAllRead) {
    await Promise.all([
      db.notification.updateMany({
        where: { status: 'unread' },
        data: { status: 'read' },
      }),
      db.lead.updateMany({
        where: { status: 'NEW' },
        data: { status: 'CONTACTED' },
      }),
    ]);
    return apiSuccess({ success: true });
  }

  if (!id) return apiError('ID is required', 400);

  // Determine if this is a lead or a notification by checking both tables
  const lead = await db.lead.findUnique({ where: { id } });
  if (lead) {
    // Update lead status — only allow valid lifecycle transitions
    if (!leadStatus) return apiError('leadStatus is required for lead updates', 400);
    const validLeadStatuses = ['NEW', 'CONTACTED', 'CONVERTED', 'IGNORED'];
    if (!validLeadStatuses.includes(leadStatus)) {
      return apiError(`leadStatus must be one of: ${validLeadStatuses.join(', ')}`, 422);
    }
    const updated = await db.lead.update({
      where: { id },
      data: { status: leadStatus },
    });
    log.info('api.super-admin.lead.update', { leadId: id, newStatus: leadStatus }, requestContext(req));
    return apiSuccess({
      data: {
        id: updated.id,
        status: updated.status,
        name: updated.name,
        email: updated.email,
      },
      type: 'lead',
    });
  }

  // It's a notification — update status
  const notification = await db.notification.findUnique({ where: { id } });
  if (!notification) return apiError('Not found', 404);

  if (!status) return apiError('status is required for notification updates', 400);
  if (status !== 'unread' && status !== 'read' && status !== 'archived') {
    return apiError('status must be unread, read, or archived', 422);
  }

  const updateData: Record<string, unknown> = { status };
  if (status === 'read') updateData.readAt = new Date();

  const updated = await db.notification.update({
    where: { id },
    data: updateData,
  });

  return apiSuccess({ data: updated, type: 'notification' });
}
