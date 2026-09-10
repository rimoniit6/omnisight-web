import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { requireSuperAdmin, apiError } from '@/lib/api';
import { serializeChangeRequest } from '@/lib/infrastructure';
import { log, requestContext } from '@/lib/logger';

// GET /api/admin/infrastructure-requests
// Super-Admin queue for Organization Data Infrastructure change requests.
// Query params: status? (submitted|approved|active|rejected|cancelled|…),
// kind? (DATABASE|STORAGE), orgId?, page? (1-based, default 20 per page).
// Secrets never appear — every row is a serializeChangeRequest view (last-4).
export async function GET(req: NextRequest) {
  try {
    const admin = await requireSuperAdmin(req);
    if (!admin.ok) return apiError(admin.status === 401 ? 'Unauthorized' : 'Super admin access required', admin.status);

    const url = req.nextUrl;
    const status = url.searchParams.get('status');
    const kind = url.searchParams.get('kind');
    const orgId = url.searchParams.get('orgId');
    const page = Math.max(1, Number(url.searchParams.get('page') ?? '1') || 1);
    const take = Math.min(50, Math.max(1, Number(url.searchParams.get('limit') ?? '20') || 20));

    const where: { status?: string; kind?: string; organizationId?: string } = {};
    if (status) where.status = status;
    if (kind === 'DATABASE' || kind === 'STORAGE') where.kind = kind;
    if (orgId) where.organizationId = orgId;

    // Pending queue first (submitted, then approved-with-error), then history.
    const pendingWhere = { ...where, status: { in: ['submitted', 'approved'] as string[] } };
    const [pending, totalPending, recent] = await Promise.all([
      db.infrastructureChangeRequest.findMany({
        where: pendingWhere,
        orderBy: [{ status: 'asc' }, { createdAt: 'desc' }],
        include: { organization: { select: { name: true, slug: true } } },
      }),
      db.infrastructureChangeRequest.count({ where: pendingWhere }),
      db.infrastructureChangeRequest.findMany({
        where: { ...where, status: { notIn: ['submitted', 'approved'] as string[] } },
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * take,
        take,
        include: { organization: { select: { name: true, slug: true } } },
      }),
    ]);

    // Attach the REAL data-migration progress for approved requests (the
    // queue shows migration status instead of implying approval = done).
    const pendingIds = pending.concat(recent).map((r) => r.id);
    const migrations = pendingIds.length
      ? await db.infrastructureMigration.findMany({ where: { requestId: { in: pendingIds } } })
      : [];
    const migrationByRequest = new Map(migrations.map((m) => [m.requestId, m]));
    const migrationView = (m: (typeof migrations)[number]) => ({
      id: m.id,
      status: m.status,
      recordsDone: m.recordsDone,
      recordsTotal: m.recordsTotal,
      objectsDone: m.objectsDone,
      objectsTotal: m.objectsTotal,
      bytesDone: m.bytesDone.toString(),
      bytesTotal: m.bytesTotal.toString(),
      currentTable: m.currentTable,
      errorStage: m.errorStage,
      errorMessage: m.errorMessage,
      verifiedAt: m.verifiedAt,
      activatedAt: m.activatedAt,
    });

    return NextResponse.json({
      data: {
        pending: pending.map((r) => {
          const m = migrationByRequest.get(r.id);
          return {
            ...serializeChangeRequest(r),
            organization: { name: r.organization.name, slug: r.organization.slug },
            migration: m ? migrationView(m) : null,
          };
        }),
        pendingCount: totalPending,
        recent: recent.map((r) => {
          const m = migrationByRequest.get(r.id);
          return {
            ...serializeChangeRequest(r),
            organization: { name: r.organization.name, slug: r.organization.slug },
            migration: m ? migrationView(m) : null,
          };
        }),
        page,
      },
    });
  } catch (error) {
    log.error('api.admin.infrastructure-requests', { error: String(error) }, requestContext(req));
    return apiError('Failed to load infrastructure change requests', 500);
  }
}