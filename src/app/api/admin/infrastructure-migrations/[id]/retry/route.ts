import { NextRequest, NextResponse } from 'next/server';
import { requireDbVerifiedRole, apiError } from '@/lib/api';
import { log, requestContext } from '@/lib/logger';
import { retryMigration } from '@/lib/migration/runner';

// POST /api/admin/infrastructure-migrations/[id]/retry
// Super Admin re-queues a FAILED (or stale-cancelled) data migration. The
// server validates the transition (failed → queued only); the copy itself is
// idempotent, so already-copied tables are skipped on the next run.
// SECURITY: DB-verified super_admin role; no secrets in the response.
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const admin = await requireDbVerifiedRole(req, { requireSuperAdmin: true });
    if (!admin.ok) {
      return apiError(admin.status === 401 ? 'Unauthorized' : 'Super admin access required', admin.status);
    }

    const { id } = await params;
    const result = await retryMigration(id, { id: admin.userId, email: admin.email });
    if (!result.ok) {
      return apiError(result.error, result.status);
    }

    log.info('api.admin.infrastructure-migrations.retry', { migrationId: id, admin: admin.email }, requestContext(req));

    return NextResponse.json({
      data: { retried: true, migrationId: id, message: 'The migration was re-queued. Already-copied data is reused — nothing is duplicated.' },
    });
  } catch (error) {
    log.error('api.admin.infrastructure-migrations.retry', { error: String(error) }, requestContext(req));
    return apiError('Failed to retry the migration', 500);
  }
}
