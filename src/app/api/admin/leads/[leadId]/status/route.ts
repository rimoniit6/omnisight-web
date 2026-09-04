import { NextRequest } from 'next/server';
import { db } from '@/lib/db';
import {
  requireDbVerifiedRole,
  apiError,
  apiSuccess,
  authError,
  parseJsonBody,
  BodyParseError,
} from '@/lib/api';
import { log, requestContext } from '@/lib/logger';
import { LEAD_STATUSES, isLeadStatus, type LeadStatus } from '@/lib/leads';

// PUT /api/admin/leads/[leadId]/status
// Super Admin: change a lead's status (NEW → CONTACTED/CONVERTED/IGNORED) and
// optionally append a note. The mutation re-verifies the actor's super_admin
// role from the DB (not just the JWT) before applying any change.
//
// Body: { status: LeadStatus, notes?: string }
export async function PUT(
  req: NextRequest,
  { params }: { params: Promise<{ leadId: string }> }
) {
  try {
    const adminResult = await requireDbVerifiedRole(req, { requireSuperAdmin: true });
    if (!adminResult.ok) return authError(adminResult);

    const admin = adminResult;
    const { leadId } = await params;

    let body: Record<string, unknown>;
    try {
      body = await parseJsonBody(req);
    } catch (error) {
      if (error instanceof BodyParseError) return apiError('Invalid JSON body', 400);
      throw error;
    }

    const status = typeof body.status === 'string' ? body.status : '';
    if (!isLeadStatus(status)) {
      return apiError(`Status must be one of: ${LEAD_STATUSES.join(', ')}`, 422);
    }

    const notes =
      typeof body.notes === 'string'
        ? body.notes.trim().slice(0, 4000)
        : (body.notes ?? undefined);

    const existing = await db.lead.findUnique({ where: { id: leadId } });
    if (!existing) return apiError('Lead not found', 404);

    await db.$transaction(async (tx) => {
      await tx.lead.update({
        where: { id: leadId },
        data: {
          status: status as LeadStatus,
          ...(notes !== undefined ? { message: notes } : {}),
        },
      });

      await tx.auditLog.create({
        data: {
          action: 'update',
          resource: 'lead',
          resourceId: leadId,
          description: `Lead "${existing.name}" (${existing.email}) status → ${status}${
            notes ? ' · note added' : ''
          }`,
          userId: admin.userId,
        },
      });
    });

    log.info(
      'api.admin.leads.status',
      {
        leadId,
        status,
        actor: admin.email,
        hasNotes: notes !== undefined && notes !== '',
      },
      requestContext(req)
    );

    return apiSuccess({ success: true, id: leadId, status });
  } catch (error) {
    log.error('api.admin.leads.status', { error: String(error) }, requestContext(req));
    return apiError('Failed to update lead', 500);
  }
}
