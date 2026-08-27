import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { getRoleLabel } from '@/lib/auth';
import { requireMembershipAdmin, apiError, apiSuccess } from '@/lib/api';
import { log, requestContext } from '@/lib/logger';

const ORG_ROLES = ['owner', 'admin', 'manager', 'viewer'];
const MEMBERSHIP_STATUSES = ['ACTIVE', 'SUSPENDED'];

// ─── PATCH /api/organizations/[id]/members/[memberId] ───────────────────────
// Change an organization-specific role, or suspend/reactivate a membership.
// Uses DB-verified role (P2/P3 #11) for sensitive mutations.
export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string; memberId: string }> }
) {
  try {
    const { id: orgId, memberId } = await params;
    const auth = await requireMembershipAdmin(req, orgId);
    if (!auth.ok) return apiError('Insufficient permissions', auth.status);

    const body = await req.json().catch(() => ({})) as {
      role?: string;
      status?: string;
    };

    const membership = await db.organizationMembership.findUnique({
      where: { userId_organizationId: { userId: memberId, organizationId: orgId } },
      include: { user: { select: { email: true } } },
    });
    if (!membership) {
      return apiError('Membership not found', 404);
    }

    const updateData: { role?: string; status?: string } = {};

    if (body.role !== undefined) {
      if (!ORG_ROLES.includes(body.role)) {
        return apiError(`Invalid role. Must be one of: ${ORG_ROLES.join(', ')}`, 400);
      }
      if (body.role === 'super_admin') {
        return apiError('Cannot assign super_admin as a per-organization role', 400);
      }
      updateData.role = body.role;
    }

    if (body.status !== undefined) {
      if (!MEMBERSHIP_STATUSES.includes(body.status)) {
        return apiError('status must be ACTIVE or SUSPENDED', 400);
      }
      updateData.status = body.status;
    }

    if (Object.keys(updateData).length === 0) {
      return apiError('No valid fields to update (role or status)', 400);
    }

    const updated = await db.organizationMembership.update({
      where: { userId_organizationId: { userId: memberId, organizationId: orgId } },
      data: updateData,
    });

    await db.auditLog.create({
      data: {
        action: 'update',
        resource: 'membership',
        resourceId: membership.id,
        description: `User ${auth.email} updated membership for ${membership.user.email} in ${orgId}: ${JSON.stringify(updateData)}`,
        userId: auth.userId,
        organizationId: orgId,
      },
    });

    return apiSuccess({
      userId: memberId,
      role: updated.role,
      roleLabel: getRoleLabel(updated.role),
      status: updated.status,
    });
  } catch (error) {
    log.error('api.orgs.members.update', { error: String(error) }, requestContext(req));
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

// ─── DELETE /api/organizations/[id]/members/[memberId] ──────────────────────
// Remove a user's membership from this organization. Removing Org A does not
// affect their membership in any other organization.
export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ id: string; memberId: string }> }
) {
  try {
    const { id: orgId, memberId } = await params;
    const auth = await requireMembershipAdmin(req, orgId);
    if (!auth.ok) return apiError('Insufficient permissions', auth.status);

    const membership = await db.organizationMembership.findUnique({
      where: { userId_organizationId: { userId: memberId, organizationId: orgId } },
      include: { user: { select: { email: true } } },
    });
    if (!membership) {
      return apiError('Membership not found', 404);
    }

    await db.organizationMembership.delete({
      where: { userId_organizationId: { userId: memberId, organizationId: orgId } },
    });

    await db.auditLog.create({
      data: {
        action: 'delete',
        resource: 'membership',
        resourceId: membership.id,
        description: `User ${auth.email} removed ${membership.user.email} from organization ${orgId}`,
        userId: auth.userId,
        organizationId: orgId,
      },
    });

    return apiSuccess({ message: 'Membership removed', userId: memberId });
  } catch (error) {
    log.error('api.orgs.members.remove', { error: String(error) }, requestContext(req));
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
