import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { requireSuperAdmin, apiError, apiSuccess, validatePagination, getPrismaForOrg } from '@/lib/api';
import { log, requestContext } from '@/lib/logger';
import type { PrismaClient } from '@prisma/client';

/**
 * ORG DATA BOUNDARY: Notification is an ORG-OWNED table (copied to the org DB
 * at cutover), so for an activated organization the customer DB holds the
 * authoritative copy; platform rows for those orgs are stale. Reads merge
 * both sources (deduped by id — cutover preserves ids, so an id present in
 * both resolves to the org copy) and updates are routed to the org client
 * whenever the row's organization belongs to an activated org.
 * The org enumeration is bounded (same 25-org cap as findDeviceAcrossActivated
 * OrgDbs) and every org client is resolved through getPrismaForOrg's cache.
 */
const MAX_ACTIVATED_ORGS = 25;
const MERGE_SCAN_CAP = 200;

interface OrgClientEntry {
  organizationId: string;
  // Resolved org client (platform `db` when the org never cut over).
  client: PrismaClient;
}

async function listActivatedOrgClients(): Promise<OrgClientEntry[]> {
  const activated = await db.organizationSettings.findMany({
    where: { useOwnDb: true },
    select: { organizationId: true },
    take: MAX_ACTIVATED_ORGS,
  });
  const entries: OrgClientEntry[] = [];
  for (const s of activated) {
    try {
      entries.push({ organizationId: s.organizationId, client: (await getPrismaForOrg(s.organizationId)).client });
    } catch {
      continue; // misconfigured org — skip; its own tenants' views fail closed
    }
  }
  return entries;
}

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

  // Fetch notifications (organization-scoped). Notification is org-owned —
  // merge platform rows with the authoritative copies from activated org DBs
  // (deduped by id, capped on both sides; see listActivatedOrgClients note).
  const notificationsWhere: Record<string, unknown> = {};
  if (type && type !== 'lead_submission') notificationsWhere.type = type;
  if (status) notificationsWhere.status = status;

  const baseSelect = { orderBy: { createdAt: 'desc' as const }, take: MERGE_SCAN_CAP };
  const activatedClients = await listActivatedOrgClients();
  const [platformRows, ...orgRowsByClient] = await Promise.all([
    db.notification.findMany({
      where: notificationsWhere,
      ...baseSelect,
      include: { organization: { select: { id: true, name: true, slug: true } } },
    }),
    ...activatedClients.map((e) =>
      e.client.notification.findMany({ where: notificationsWhere, ...baseSelect }).catch(() => [] as Awaited<ReturnType<typeof db.notification.findMany>>)
    ),
  ]);

  // Dedup by id (org copy wins), then re-apply ordering + merge-level cap.
  // Org rows lack the `organization` relation include (cross-DB), so the org
  // name is re-attached from the activated-org map below.
  type NotifRow = Awaited<ReturnType<typeof db.notification.findMany>>[number];
  const orgNameById = new Map(activatedClients.map((e) => [e.organizationId, e.client]));
  const byId = new Map<string, NotifRow>();
  for (const row of platformRows) byId.set(row.id, row);
  for (const rows of orgRowsByClient) {
    for (const row of rows as NotifRow[]) {
      byId.set(row.id, row); // org copy is authoritative
    }
  }
  const merged = Array.from(byId.values())
    .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
    .slice(0, MERGE_SCAN_CAP);

  // Re-attach the control-plane organization label for org-DB rows (they are
  // merged without the relation include; the platform Organization row is the
  // authoritative label source). Lookup is bounded to the page.
  type OrgLabel = { id: string; name: string; slug: string } | null;
  type NotifWithOrg = NotifRow & { organization: OrgLabel };
  const orgLabelCache = new Map<string, OrgLabel>();
  const pageRows = merged.slice(skip, skip + pageSize);
  const notifications: NotifWithOrg[] = [];
  for (const row of pageRows) {
    const withMaybeOrg = row as NotifRow & { organization?: OrgLabel };
    if (withMaybeOrg.organization !== undefined) {
      notifications.push(withMaybeOrg as NotifWithOrg);
      continue;
    }
    const orgId = row.organizationId;
    let label = orgLabelCache.get(orgId);
    if (label === undefined) {
      const orgRow = await db.organization.findUnique({
        where: { id: orgId },
        select: { id: true, name: true, slug: true },
      });
      label = orgRow ?? null;
      orgLabelCache.set(orgId, label);
    }
    notifications.push(Object.assign({}, row, { organization: label }));
  }
  const notificationsTotal = merged.length;

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

  // It's a notification — update status. Notification is org-owned: route the
  // update to the authoritative org client when the row's org has activated
  // its own DB; otherwise (and as a fallback) update the platform copy.
  const notification = await db.notification.findUnique({ where: { id } });
  if (!notification) return apiError('Not found', 404);

  if (!status) return apiError('status is required for notification updates', 400);
  if (status !== 'unread' && status !== 'read' && status !== 'archived') {
    return apiError('status must be unread, read, or archived', 422);
  }

  const updateData: Record<string, unknown> = { status };
  if (status === 'read') updateData.readAt = new Date();

  let updated;
  let routedToOrg = false;
  if (notification.organizationId) {
    try {
      const orgData = (await getPrismaForOrg(notification.organizationId)).client;
      if (orgData !== db) {
        updated = await orgData.notification.update({ where: { id }, data: updateData });
        routedToOrg = true;
      }
    } catch (e) {
      log.warn('api.super-admin.notifications.org_update_failed', { err: e, notificationId: id });
    }
  }
  if (!routedToOrg) {
    updated = await db.notification.update({ where: { id }, data: updateData });
  }

  return apiSuccess({ data: updated, type: 'notification' });
}
