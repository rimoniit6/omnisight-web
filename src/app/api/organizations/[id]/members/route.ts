import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { getRoleLabel } from '@/lib/auth';
import { requireOrgAdmin, apiError, apiSuccess } from '@/lib/api';
import { isOrgRole, canAssignRole, resolveActorDbRole } from '@/lib/org-members';
import { normalizeEmail } from '@/lib/email';
import { log, requestContext } from '@/lib/logger';

// ─── GET /api/organizations/[id]/members ────────────────────────────────────
// List members of an organization. Admin+ within the org, or super_admin.
export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id: orgId } = await params;
    const auth = await requireOrgAdmin(req, orgId);
    if (!auth.ok) return apiError('Insufficient permissions', auth.status);

    const members = await db.organizationMembership.findMany({
      where: { organizationId: orgId },
      include: {
        user: {
          select: {
            id: true,
            email: true,
            name: true,
            avatar: true,
            isActive: true,
          },
        },
      },
      orderBy: { createdAt: 'asc' },
    });

    return apiSuccess({
      members: members.map((m) => ({
        userId: m.user.id,
        email: m.user.email,
        name: m.user.name,
        avatar: m.user.avatar,
        isActive: m.user.isActive,
        role: m.role,
        roleLabel: getRoleLabel(m.role),
        status: m.status,
        createdAt: m.createdAt,
      })),
    });
  } catch (error) {
    log.error('api.orgs.members.list', { error: String(error) }, requestContext(req));
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

// ─── POST /api/organizations/[id]/members ───────────────────────────────────
// Add/invite an existing user to this organization with an org-specific role.
// The user is identified by email. A membership (ACTIVE) is created; the user
// may already belong to other organizations (genuine multi-org).
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id: orgId } = await params;
    const auth = await requireOrgAdmin(req, orgId);
    if (!auth.ok) return apiError('Insufficient permissions', auth.status);

    const body = await req.json().catch(() => ({})) as {
      userId?: string;
      email?: string;
      role?: string;
    };
    const rawRole = body.role;
    const role = typeof rawRole === 'string' ? rawRole.trim().toLowerCase() : (rawRole as string | undefined);

    if (!role) {
      return apiError('role is required', 400);
    }
    if (!isOrgRole(role)) {
      return apiError(`Invalid role. Must be one of: org_admin, manager, viewer`, 400);
    }
    // super_admin is a global role and is never a per-org membership; isOrgRole
    // above already excludes it.

    // Privilege-elevation guard: the actor (DB-verified membership role) may
    // only add a member at or below their own level. Prevents an org admin
    // from creating an owner (or higher) via a crafted request.
    const actorRole = await resolveActorDbRole(req, orgId);
    if (!actorRole || !canAssignRole(actorRole, role)) {
      return apiError(`Insufficient permissions to assign role '${role}'`, 403);
    }

    // Resolve target user — prefer userId (from UI picker), fall back to
    // case-insensitive email lookup for backward compatibility.
    let user: { id: string; email: string } | null = null;

    if (typeof body.userId === 'string' && body.userId.trim().length > 0) {
      user = await db.appUser.findUnique({
        where: { id: body.userId.trim() },
        select: { id: true, email: true },
      });
    } else {
      const email = normalizeEmail(body.email);
      if (!email) {
        return apiError('userId or email is required', 400);
      }
      user = await db.appUser.findFirst({
        where: { email: { equals: email, mode: 'insensitive' } },
        select: { id: true, email: true },
      });
    }

    if (!user) {
      return apiError('No user found. Please search and select an existing user.', 404);
    }

    // Idempotent: upsert on the compound-unique [userId, organizationId].
    const membership = await db.organizationMembership.upsert({
      where: { userId_organizationId: { userId: user.id, organizationId: orgId } },
      create: { userId: user.id, organizationId: orgId, role, status: 'ACTIVE' },
      update: { role, status: 'ACTIVE' },
    });

    await db.auditLog.create({
      data: {
        action: 'create',
        resource: 'membership',
        resourceId: membership.id,
        description: `User ${auth.email} added ${user.email} to organization ${orgId} as ${role}`,
        userId: auth.userId,
        organizationId: orgId,
      },
    });

    return apiSuccess(
      { userId: user.id, email: user.email, role, status: membership.status },
      201
    );
  } catch (error) {
    log.error('api.orgs.members.add', { error: String(error) }, requestContext(req));
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
