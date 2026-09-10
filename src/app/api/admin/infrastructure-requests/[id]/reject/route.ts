import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { requireDbVerifiedRole, apiError } from '@/lib/api';
import { log, requestContext } from '@/lib/logger';
import { serializeChangeRequest, canTransition } from '@/lib/infrastructure';
import { cancelQueuedMigration } from '@/lib/migration/runner';

// POST /api/admin/infrastructure-requests/[id]/reject
// Super Admin rejects a SUBMITTED change request. Note travels to the org.
// Only submitted → rejected is allowed (a request already approved but stuck
// in a failed migration must be CANCELLED by the org, not silently rejected).
// Any QUEUED migration for the request is cancelled with it (a migration that
// is already running cannot be safely rejected — the transition gate above
// ensures only 'submitted' requests reach this point, and a submitted request
// never has a running migration).
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const admin = await requireDbVerifiedRole(req, { requireSuperAdmin: true });
    if (!admin.ok) {
      return apiError(admin.status === 401 ? 'Unauthorized' : 'Super admin access required', admin.status);
    }

    const { id } = await params;
    const body = (await req.json().catch(() => ({}))) as { reason?: string };
    const reason = typeof body.reason === 'string' ? body.reason.slice(0, 500) : undefined;
    if (!reason) return apiError('A rejection reason is required', 422);

    const changeRequest = await db.infrastructureChangeRequest.findUnique({ where: { id } });
    if (!changeRequest) return apiError('Change request not found', 404);
    if (!canTransition(changeRequest.status, 'rejected')) {
      return apiError(`Change request #${changeRequest.requestNo} is '${changeRequest.status}' and cannot be rejected`, 409);
    }

    const rejected = await db.infrastructureChangeRequest.update({
      where: { id },
      data: {
        status: 'rejected',
        rejectedById: admin.userId,
        rejectedByEmail: admin.email,
        rejectedAt: new Date(),
        rejectionReason: reason,
      },
      include: { organization: { select: { name: true, slug: true } } },
    });

    // The rejected request's queued migration must never run.
    await cancelQueuedMigration(id, `Request #${rejected.requestNo} rejected: ${reason.slice(0, 200)}`);

    await db.auditLog.create({
      data: {
        action: 'infrastructure_request_reject',
        resource: 'infrastructure-request',
        resourceId: id,
        description: `${admin.email} rejected request #${rejected.requestNo} (${rejected.kind}): ${reason}`,
        userId: admin.userId,
        organizationId: rejected.organizationId,
      },
    });

    log.info('api.admin.infrastructure-requests.reject', { requestId: id, kind: rejected.kind, requestNo: rejected.requestNo, orgId: rejected.organizationId }, requestContext(req));

    return NextResponse.json({
      data: { request: { ...serializeChangeRequest(rejected), organization: { name: rejected.organization.name, slug: rejected.organization.slug } } },
    });
  } catch (error) {
    log.error('api.admin.infrastructure-requests.reject', { error: String(error) }, requestContext(req));
    return apiError('Failed to reject the change request', 500);
  }
}