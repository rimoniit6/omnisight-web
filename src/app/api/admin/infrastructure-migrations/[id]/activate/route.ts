import { NextRequest, NextResponse } from 'next/server';
import { requireDbVerifiedRole, apiError } from '@/lib/api';
import { log, requestContext } from '@/lib/logger';
import { activateMigration } from '@/lib/migration/runner';

// POST /api/admin/infrastructure-migrations/[id]/activate
// Super Admin activates the migrated infrastructure for a request whose data
// migration reached ready_to_activate. FAILS CLOSED unless verified:
//   • migration must be 'ready_to_activate' (server-side transition gate)
//   • settings flip + request 'active' + migration 'activated' are atomic
//   • any failure leaves the previous infrastructure active, untouched
// SECURITY: DB-verified super_admin role; no secrets are read into the response.
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const admin = await requireDbVerifiedRole(req, { requireSuperAdmin: true });
    if (!admin.ok) {
      return apiError(admin.status === 401 ? 'Unauthorized' : 'Super admin access required', admin.status);
    }

    const { id } = await params;
    const result = await activateMigration(id, { id: admin.userId, email: admin.email });
    if (!result.ok) {
      return apiError(result.error, result.status);
    }

    log.info('api.admin.infrastructure-migrations.activate', { migrationId: id, admin: admin.email }, requestContext(req));

    return NextResponse.json({
      data: { activated: true, migrationId: id, message: 'The new infrastructure is now active for this organization.' },
    });
  } catch (error) {
    log.error('api.admin.infrastructure-migrations.activate', { error: String(error) }, requestContext(req));
    return apiError('Failed to activate the migrated infrastructure', 500);
  }
}
