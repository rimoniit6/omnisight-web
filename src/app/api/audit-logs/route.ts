'server';
import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { authError, requireSessionOrg, validatePagination } from '@/lib/api';
import { authenticateRequest } from '@/lib/api';
import { hasRolePermission } from '@/lib/auth';
import { log, requestContext } from '@/lib/logger';
import { aggregateActionDistribution } from '@/lib/audit-action-normalizer';

export async function GET(req: NextRequest) {
  try {
    // S-05: audit-log reads are manager+ — the list exposes security telemetry
    // (hostnames, employee codes, IPs, admin emails). The proxy rule matches;
    // the handler enforces it too (never proxy-only).
    const auth = await authenticateRequest(req);
    if (!auth) return authError({ ok: false, status: 401 });
    if (!hasRolePermission(auth.role, 'manager')) return authError({ ok: false, status: 403 });

    // Tenant isolation: audit logs are organization-scoped from the verified
    // session — never from client input. Org-less super_admins get an empty
    // payload (bootstrap state).
    const scope = await requireSessionOrg(req, { allowGlobal: true });
    if (!scope.ok) return authError(scope);
    if (!scope.organizationId) {
      return NextResponse.json({
        data: [], total: 0, page: 1, pageSize: 15, totalPages: 0,
        stats: { total: 0, actionDistribution: {}, mostCommonAction: 'N/A', mostAffectedResource: 'N/A' },
      });
    }
    const orgId = scope.organizationId;

    const { searchParams } = new URL(req.url);
    const action = searchParams.get('action');
    const resource = searchParams.get('resource');
    // P2-2/P3-8: validated pagination (garbage page/pageSize → 422, never
    // NaN → Prisma 500) and stats computed with DB groupBy instead of loading
    // the whole audit-log table.
    const pagination = validatePagination(searchParams, { defaultPageSize: 15, maxPageSize: 100 });
    if (!pagination.ok) {
      return NextResponse.json({ error: pagination.error }, { status: pagination.status });
    }
    const page = pagination.page;
    const pageSize = pagination.pageSize;

    const where: Record<string, unknown> = { organizationId: orgId };
    if (action) where.action = action;
    if (resource) where.resource = resource;

    const [logs, total, actionGroup, resourceGroup] = await Promise.all([
      db.auditLog.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: pagination.skip,
        take: pageSize,
      }),
      db.auditLog.count({ where }),
      db.auditLog.groupBy({ by: ['action'], where, _count: { _all: true } }),
      db.auditLog.groupBy({ by: ['resource'], where, _count: { _all: true } }),
    ]);

    const totalPages = Math.ceil(total / pageSize);

    // Action distribution (aggregated in the DB, then normalized to
    // canonical human-readable categories for the chart).
    const rawActionDist: Record<string, number> = {};
    const resourceDist: Record<string, number> = {};
    for (const g of actionGroup) rawActionDist[g.action] = g._count._all;
    for (const g of resourceGroup) resourceDist[g.resource] = g._count._all;

    // Normalize raw DB actions → canonical chart categories
    const actionDist = aggregateActionDistribution(rawActionDist);

    // Most common action
    const sortedActions = Object.entries(actionDist).sort((a, b) => b[1] - a[1]);
    const mostCommonAction = sortedActions.length > 0
      ? `${sortedActions[0][0]} - ${Math.round((sortedActions[0][1] / total) * 100)}%`
      : 'N/A';

    // Most affected resource
    const sortedResources = Object.entries(resourceDist).sort((a, b) => b[1] - a[1]);
    const mostAffectedResource = sortedResources.length > 0 ? sortedResources[0][0] : 'N/A';

    return NextResponse.json({
      data: logs,
      total,
      page,
      pageSize,
      totalPages,
      stats: {
        total,
        actionDistribution: actionDist,
        mostCommonAction,
        mostAffectedResource,
      },
    });
  } catch (error) {
    log.error('api.audit-logs.', { error: String('AuditLogs GET error:') }, requestContext(req));
    return NextResponse.json({ error: 'Failed to fetch audit logs' }, { status: 500 });
  }
}
