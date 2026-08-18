'use server';
import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { authError, requireSessionOrg, requireAdminOrg, validatePagination } from '@/lib/api';
import { isAlertStatus, isAlertSeverity } from '@/lib/notifications/constants';

export async function GET(req: NextRequest) {
  try {
    // Tenant isolation: alerts are organization-scoped from the verified
    // session — never from client input. Org-less super_admins get an empty
    // payload (bootstrap state).
    const scope = await requireSessionOrg(req, { allowGlobal: true });
    if (!scope.ok) return authError(scope);
    if (!scope.organizationId) return NextResponse.json({ data: [], total: 0, page: 1, pageSize: 50, totalPages: 0, stats: null });
    const orgId = scope.organizationId;

    const { searchParams } = new URL(req.url);

    // N-3: server-side pagination — malformed/negative/zero/oversized values
    // are a controlled 4xx, never an unbounded table scan or a Prisma error.
    const pagination = validatePagination(searchParams, { defaultPageSize: 50, maxPageSize: 200 });
    if (!pagination.ok) {
      return NextResponse.json({ error: pagination.error }, { status: pagination.status });
    }
    const { page, pageSize, skip } = pagination;

    const status = searchParams.get('status');
    const severity = searchParams.get('severity');
    const search = searchParams.get('search');
    // `type` accepts a comma-separated list of alert types (e.g. the Agent
    // Security page requests `security,device_offline,policy_violation,
    // high_inactivity`). Backward compatible: callers that omit it keep the
    // previous all-types behavior.
    const type = searchParams.get('type');

    const where: Record<string, unknown> = { organizationId: orgId };
    if (status) where.status = status;
    if (severity) where.severity = severity;
    if (search) {
      where.OR = [
        { title: { contains: search } },
        { description: { contains: search } },
      ];
    }
    if (type) {
      const types = type.split(',').map((t) => t.trim()).filter(Boolean);
      if (types.length > 0) where.type = { in: types };
    }

    const [alerts, total] = await Promise.all([
      db.alert.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip,
        take: pageSize,
      }),
      db.alert.count({ where }),
    ]);

    const totalPages = Math.ceil(total / pageSize);

    // DB-backed statistics (N-3): counts + severity distribution computed by
    // the database, never by loading the whole table into the client.
    const [statusAgg, severityAgg] = await Promise.all([
      db.alert.groupBy({
        by: ['status'],
        where: { organizationId: orgId },
        _count: { status: true },
      }),
      db.alert.groupBy({
        by: ['severity'],
        where: { organizationId: orgId },
        _count: { severity: true },
      }),
    ]);
    const byStatus: Record<string, number> = {};
    statusAgg.forEach((s) => { byStatus[s.status] = s._count.status; });
    const bySeverity: Record<string, number> = {};
    severityAgg.forEach((s) => { bySeverity[s.severity] = s._count.severity; });

    return NextResponse.json({
      data: alerts,
      total,
      page,
      pageSize,
      totalPages,
      stats: { byStatus, bySeverity },
    });
  } catch (error) {
    console.error('Alerts GET error:', error);
    return NextResponse.json({ error: 'Failed to fetch alerts' }, { status: 500 });
  }
}

export async function PUT(req: NextRequest) {
  try {
    // Admin-only mutation; the alert must belong to the caller's organization
    // (cross-org alert mutation is rejected with 404 concealment).
    const admin = await requireAdminOrg(req);
    if (!admin.ok) return authError(admin);

    let body: Record<string, unknown>;
    try {
      body = await req.json();
    } catch {
      return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
    }
    const { id, status, severity } = body;
    if (!id || typeof id !== 'string') return NextResponse.json({ error: 'ID is required' }, { status: 400 });

    // N-7: canonical enums only — arbitrary status/severity strings are
    // rejected before they can reach the database.
    if (status !== undefined && !isAlertStatus(status)) {
      return NextResponse.json({ error: 'status must be pending, acknowledged, resolved, or archived' }, { status: 422 });
    }
    if (severity !== undefined && !isAlertSeverity(severity)) {
      return NextResponse.json({ error: 'severity must be info, warning, error, or critical' }, { status: 422 });
    }

    const data: Record<string, string> = {};
    if (status) data.status = status as string;
    if (severity) data.severity = severity as string;

    if (Object.keys(data).length === 0) {
      return NextResponse.json({ error: 'No fields to update' }, { status: 400 });
    }

    // Fetch current state for the audit (previous → new) and to enforce
    // org-scoped 404 concealment.
    const existing = await db.alert.findFirst({
      where: { id, organizationId: admin.organizationId },
      select: { id: true, status: true, severity: true },
    });
    if (!existing) return NextResponse.json({ error: 'Alert not found' }, { status: 404 });

    const alert = await db.alert.update({
      where: { id },
      data,
    });

    // Actor-bound audit of the lifecycle change (previous → new).
    const changed: string[] = [];
    if (data.status && data.status !== existing.status) changed.push(`status: ${existing.status} → ${data.status}`);
    if (data.severity && data.severity !== existing.severity) changed.push(`severity: ${existing.severity} → ${data.severity}`);
    if (changed.length > 0) {
      await db.auditLog.create({
        data: {
          action: 'update',
          resource: 'alert',
          resourceId: alert.id,
          description: `Alert updated: ${changed.join(', ')}`,
          userId: admin.userId,
          organizationId: admin.organizationId,
        },
      });
    }

    return NextResponse.json({ data: alert });
  } catch (error) {
    console.error('Alerts PUT error:', error);
    return NextResponse.json({ error: 'Failed to update alert' }, { status: 500 });
  }
}
