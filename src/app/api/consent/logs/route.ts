import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { getSessionOrg, authenticateRequest, validatePagination } from '@/lib/api';
import { hasRolePermission } from '@/lib/auth';
import { log, requestContext } from '@/lib/logger';

// GET /api/consent/logs — Get consent audit logs (scoped to caller's org)
// Manager+ (S-01): consent audit history is privacy-relevant — same gate as
// the list/summary routes, enforced server-side.
export async function GET(req: NextRequest) {
  try {
    const auth = await authenticateRequest(req);
    if (!auth) {
      return NextResponse.json({ error: 'Unauthorized. Please sign in.' }, { status: 401 });
    }
    if (!hasRolePermission(auth.role, 'manager')) {
      return NextResponse.json({ error: 'Insufficient permissions' }, { status: 403 });
    }

    const org = await getSessionOrg(req);
    if (!org) return NextResponse.json({ error: 'No organization found' }, { status: 404 });

    const { searchParams } = new URL(req.url);
    const consentId = searchParams.get('consentId') || '';
    const action = searchParams.get('action') || '';

    const pagination = validatePagination(searchParams, { defaultPageSize: 30, maxPageSize: 200 });
    if (!pagination.ok) {
      return NextResponse.json({ error: pagination.error }, { status: pagination.status });
    }
    const { page, pageSize, skip } = pagination;

    const where: Record<string, unknown> = { organizationId: org.id };
    if (consentId) {
      // Tenant isolation: the referenced consent must belong to the caller's org.
      const consent = await db.consent.findUnique({
        where: { id: consentId, organizationId: org.id },
        select: { id: true },
      });
      if (!consent) {
        return NextResponse.json({ error: 'Consent not found' }, { status: 404 });
      }
      where.consentId = consentId;
    }
    if (action) where.action = action;

    const [logs, total] = await Promise.all([
      db.consentLog.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip,
        take: pageSize,
      }),
      db.consentLog.count({ where }),
    ]);

    return NextResponse.json({ data: logs, total, page, pageSize, totalPages: Math.ceil(total / pageSize) });
  } catch (error) {
    log.error('api.consent.logs.', { error: String('Consent logs GET error:') }, requestContext(req));
    return NextResponse.json({ error: 'Failed to fetch consent logs' }, { status: 500 });
  }
}
