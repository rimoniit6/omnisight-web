import { NextRequest } from 'next/server';
import { db } from '@/lib/db';
import { requireOrgAdmin, apiSuccess, apiError } from '@/lib/api';
import { cancelOpenChangeRequest } from '@/lib/infrastructure';
import { log, requestContext } from '@/lib/logger';

// POST /api/organizations/[orgId]/settings/database/cancel
// Cancel the org's OPEN analytics-DB change request (submitted, or a failed
// approval awaiting retry). Body: { reason? }. Org Admin / Owner only.
export async function POST(req: NextRequest, { params }: { params: Promise<{ orgId: string }> }) {
  const { orgId } = await params;
  const auth = await requireOrgAdmin(req, orgId);
  if (!auth.ok) return apiError('Insufficient permissions', auth.status);

  let body: Record<string, unknown> = {};
  try {
    body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
  } catch {
    body = {};
  }
  const reason = typeof body.reason === 'string' ? body.reason.slice(0, 500) : undefined;

  const outcome = await cancelOpenChangeRequest({ organizationId: orgId, kind: 'DATABASE', actor: { id: auth.userId, email: auth.email }, reason });
  if (!outcome.cancelled) {
    return apiError(outcome.reason, 409);
  }

  await db.auditLog.create({
    data: {
      action: 'infrastructure_request_cancel',
      resource: 'infrastructure-request',
      resourceId: orgId,
      description: `${auth.email} cancelled the pending DATABASE change request${reason ? ` (${reason})` : ''}`,
      userId: auth.userId,
      organizationId: orgId,
    },
  });

  log.info('api.organizations.settings.database.cancel', { orgId }, requestContext(req));
  return apiSuccess({ cancelled: true });
}