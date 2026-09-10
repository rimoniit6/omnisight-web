import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { requireDbVerifiedRole, apiError } from '@/lib/api';
import { log, requestContext } from '@/lib/logger';

// GET /api/admin/infrastructure-migrations?status=queued|failed|...
// Super Admin view of the data-migration queue: one row per approved change
// request's migration, with REAL progress counters and organization names.
// Secrets are never selected, never serialized.
export async function GET(req: NextRequest) {
  try {
    const admin = await requireDbVerifiedRole(req, { requireSuperAdmin: true });
    if (!admin.ok) {
      return apiError(admin.status === 401 ? 'Unauthorized' : 'Super admin access required', admin.status);
    }

    const statusParam = req.nextUrl.searchParams.get('status');
    const allowed = ['queued', 'migrating', 'verifying', 'ready_to_activate', 'activated', 'failed', 'cancelled'];

    const migrations = await db.infrastructureMigration.findMany({
      where: statusParam && allowed.includes(statusParam) ? { status: statusParam } : undefined,
      orderBy: { createdAt: 'desc' },
      take: 100,
      include: {
        organization: { select: { name: true, slug: true } },
        request: { select: { requestNo: true, kind: true, status: true } },
      },
    });

    return NextResponse.json({
      data: {
        migrations: migrations.map((m) => ({
          id: m.id,
          organization: { name: m.organization.name, slug: m.organization.slug },
          kind: m.kind,
          requestNo: m.request.requestNo,
          requestStatus: m.request.status,
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
          startedAt: m.startedAt,
          verifiedAt: m.verifiedAt,
          activatedAt: m.activatedAt,
          finishedAt: m.finishedAt,
          createdAt: m.createdAt,
        })),
      },
    });
  } catch (error) {
    log.error('api.admin.infrastructure-migrations', { error: String(error) }, requestContext(req));
    return apiError('Failed to load migration queue', 500);
  }
}
