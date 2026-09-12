import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { requireSuperAdmin, apiError, apiSuccess, validatePagination } from '@/lib/api';
import { log, requestContext } from '@/lib/logger';

interface LeadItem {
  id: string;
  title: string;
  message: string;
  type: string;
  priority: string;
  status: string;
  createdAt: string;
  leadId: string;
  name: string;
  email: string;
  company: string | null;
  planInterest: string;
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
  let leads: LeadItem[] = [];
  let leadsTotal = 0;
  if (includeLeads && (type === 'lead_submission' || !type)) {
    const leadsWhere: Record<string, unknown> = { status: 'NEW' };
    if (type === 'lead_submission') {
      // Already filtered by status: 'NEW' above
    }
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
    }));
    leadsTotal = leadsCount;
  }

  // Combine and sort by createdAt descending
  const allItems = [...leads, ...notifications]
    .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
    .slice(0, pageSize) as unknown as Awaited<ReturnType<typeof db.notification.findMany>>;

  const total = leadsTotal + notificationsTotal;
  const unreadCount = await db.notification.count({ where: { status: 'unread' } });

  return apiSuccess({
    data: allItems,
    pagination: { page, pageSize, total, pages: Math.ceil(total / pageSize) },
    unreadCount,
    includesLeads: includeLeads,
  });
}
