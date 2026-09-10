import { NextRequest, NextResponse } from 'next/server';
import { requireDbVerifiedRole, apiError } from '@/lib/api';
import { log, requestContext } from '@/lib/logger';
import { reconcileMigrationCounters } from '@/lib/migration/reconcile';

// POST /api/admin/infrastructure-migrations/[id]/reconcile
// Super Admin reconciles the progress counters of a stale `ready_to_activate`
// database migration against the ACTUAL verified destination rows. This is the
// explicit manual twin of the automatic self-heal that runs on the org status
// read — it never fabricates a percentage and never blindly changes status:
//   • complete destination → counters corrected to done === total (100%)
//   • genuinely missing rows → ready state REVOKED to failed so the normal
//     Retry Transfer flow re-copies (activation stays fail-closed)
//   • non-ready / activated / storage migrations → rejected
// SECURITY: DB-verified super_admin role; no secrets in the request or response.
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const admin = await requireDbVerifiedRole(req, { requireSuperAdmin: true });
    if (!admin.ok) {
      return apiError(admin.status === 401 ? 'Unauthorized' : 'Super admin access required', admin.status);
    }

    const { id } = await params;
    const result = await reconcileMigrationCounters(id);
    if (!result.ok) {
      return apiError(result.error, result.status);
    }

    log.info('api.admin.infrastructure-migrations.reconcile', { migrationId: id, outcome: result.status, admin: admin.email }, requestContext(req));

    return NextResponse.json({
      data: {
        reconciled: result.reconciled,
        migrationId: id,
        status: result.status,
        recordsDone: result.recordsDone,
        recordsTotal: result.recordsTotal,
        message: result.reconciled
          ? (result.status === 'ready_to_activate'
              ? 'Counters reconciled to the verified destination: 100% (done === total).'
              : 'The destination no longer holds the expected rows — the ready state was revoked and the migration can be retried.')
          : 'Counters were already consistent — nothing to reconcile.',
      },
    });
  } catch (error) {
    log.error('api.admin.infrastructure-migrations.reconcile', { error: String(error) }, requestContext(req));
    return apiError('Failed to reconcile the migration', 500);
  }
}