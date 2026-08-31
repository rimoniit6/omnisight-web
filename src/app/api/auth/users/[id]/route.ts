import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { getRequestToken, hashPassword, hasRolePermission, getRoleLabel } from '@/lib/auth';
import { verifySessionToken, revokeAllUserSessions, getUserAgent } from '@/lib/session';
import { log, requestContext } from '@/lib/logger';

/** Role hierarchy levels for C-2 privilege-escalation guard. */
const ROLE_LEVELS: Record<string, number> = {
  super_admin: 50,
  org_admin: 35,
  owner: 35,   // legacy alias
  admin: 35,   // legacy alias
  manager: 20,
  viewer: 10,
};

// ─── GET /api/auth/users/[id] ──────────────────────────────────────────────

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const token = getRequestToken(req);
    if (!token) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const payload = await verifySessionToken(token);
    if (!payload) {
      return NextResponse.json({ error: 'Invalid or expired token' }, { status: 401 });
    }

    if (!hasRolePermission(payload.role, 'admin')) {
      return NextResponse.json({ error: 'Insufficient permissions' }, { status: 403 });
    }

    const { id } = await params;

    // C-1: Non-super-admin must only see users within their own organization.
    const whereClause: Record<string, string> = { id };
    if (payload.role !== 'super_admin' && payload.organizationId) {
      whereClause.organizationId = payload.organizationId;
    }

    const user = await db.appUser.findFirst({
      where: whereClause,
      select: {
        id: true,
        email: true,
        name: true,
        role: true,
        avatar: true,
        isActive: true,
        lastLogin: true,
        createdAt: true,
        updatedAt: true,
        organizationId: true,
      },
    });

    if (!user) {
      return NextResponse.json({ error: 'User not found' }, { status: 404 });
    }

    return NextResponse.json({
      user: {
        ...user,
        roleLabel: getRoleLabel(user.role),
      },
    });
  } catch (error) {
    log.error('api.auth.users.id.', { error: String('Get user error:') }, requestContext(req));
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

// ─── PUT /api/auth/users/[id] ──────────────────────────────────────────────
// Update user (role, active status, password reset)

export async function PUT(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const token = getRequestToken(req);
    if (!token) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const payload = await verifySessionToken(token);
    if (!payload) {
      return NextResponse.json({ error: 'Invalid or expired token' }, { status: 401 });
    }

    if (!hasRolePermission(payload.role, 'admin')) {
      return NextResponse.json({ error: 'Insufficient permissions' }, { status: 403 });
    }

    const { id } = await params;
    const body = await req.json();
    const { name, role, isActive, password } = body as {
      name?: string;
      role?: string;
      isActive?: boolean;
      password?: string;
    };

    // C-1: Non-super-admin can only modify users within their own organization.
    const whereClause: Record<string, string> = { id };
    if (payload.role !== 'super_admin' && payload.organizationId) {
      whereClause.organizationId = payload.organizationId;
    }

    const user = await db.appUser.findFirst({ where: whereClause });
    if (!user) {
      return NextResponse.json({ error: 'User not found' }, { status: 404 });
    }

    // Cannot modify super_admin unless you are super_admin
    if (user.role === 'super_admin' && payload.role !== 'super_admin') {
      return NextResponse.json({ error: 'Cannot modify Super Admin' }, { status: 403 });
    }

    const updateData: Record<string, unknown> = {};

    if (name !== undefined) updateData.name = name;
    if (isActive !== undefined) updateData.isActive = isActive;

    if (role !== undefined) {
      const validRoles = ['org_admin', 'manager', 'viewer'];
      if (!validRoles.includes(role)) {
        return NextResponse.json({ error: 'Invalid role' }, { status: 400 });
      }
      if (role === 'super_admin' && payload.role !== 'super_admin') {
        return NextResponse.json({ error: 'Only Super Admin can assign Super Admin role' }, { status: 403 });
      }
      // C-2: Privilege escalation guard — assigner must have >= target role level.
      const assignerLevel = ROLE_LEVELS[payload.role] ?? 0;
      const targetLevel = ROLE_LEVELS[role] ?? 0;
      if (payload.role !== 'super_admin' && assignerLevel < targetLevel) {
        return NextResponse.json(
          { error: `Insufficient permissions to assign role '${role}' (requires level ${targetLevel}, you have ${assignerLevel})` },
          { status: 403 }
        );
      }
      // C-2: Prevent promoting to a role higher than the user's current role.
      const currentLevel = ROLE_LEVELS[user.role] ?? 0;
      if (payload.role !== 'super_admin' && assignerLevel < currentLevel && assignerLevel < targetLevel) {
        return NextResponse.json(
          { error: `Cannot promote above your own role level` },
          { status: 403 }
        );
      }

      // Spec §26: Last Super Admin protection — prevent demoting the last
      // active Super Admin account.
      if (user.role === 'super_admin' && role !== 'super_admin') {
        const activeSuperAdminCount = await db.appUser.count({
          where: { role: 'super_admin', isActive: true },
        });
        if (activeSuperAdminCount <= 1) {
          return NextResponse.json({ error: 'Cannot demote the last Super Admin' }, { status: 403 });
        }
      }

      updateData.role = role;
    }

    if (password !== undefined) {
      if (password.length < 8) {
        return NextResponse.json({ error: 'Password must be at least 8 characters' }, { status: 400 });
      }
      updateData.password = await hashPassword(password);
    }

    const updated = await db.appUser.update({
      where: { id },
      data: updateData,
    });

    // P1: keep the organization-specific membership role in sync when a
    // non-super-admin changes a user's role within their org. super_admin is a
    // global role and intentionally has no per-org membership.
    if (
      role !== undefined &&
      role !== 'super_admin' &&
      payload.role !== 'super_admin' &&
      payload.organizationId
    ) {
      await db.organizationMembership.upsert({
        where: {
          userId_organizationId: { userId: id, organizationId: payload.organizationId },
        },
        create: { userId: id, organizationId: payload.organizationId, role, status: 'ACTIVE' },
        update: { role },
      });
    }

    // S-04: disabling a user or resetting their password revokes every live
    // session — an already-issued JWT stops working server-side immediately.
    if (updateData.isActive === false || updateData.password !== undefined) {
      await revokeAllUserSessions(id);
    }

    // Audit log (S-08: sanitized User-Agent for incident forensics).
    const changes = Object.keys(updateData).join(', ');
    await db.auditLog.create({
      data: {
        action: 'update',
        resource: 'user',
        resourceId: id,
        description: `User ${payload.email} updated user ${user.email}: ${changes}`,
        userId: payload.userId,
        organizationId: payload.organizationId ?? null,
        userAgent: getUserAgent(req),
      },
    });

    return NextResponse.json({
      user: {
        id: updated.id,
        email: updated.email,
        name: updated.name,
        role: updated.role,
        roleLabel: getRoleLabel(updated.role),
        isActive: updated.isActive,
        lastLogin: updated.lastLogin,
        createdAt: updated.createdAt,
      },
    });
  } catch (error) {
    log.error('api.auth.users.id.', { error: String('Update user error:') }, requestContext(req));
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

// ─── DELETE /api/auth/users/[id] ───────────────────────────────────────────
// Soft delete (deactivate) a user

export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const token = getRequestToken(req);
    if (!token) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const payload = await verifySessionToken(token);
    if (!payload) {
      return NextResponse.json({ error: 'Invalid or expired token' }, { status: 401 });
    }

    if (!hasRolePermission(payload.role, 'super_admin')) {
      return NextResponse.json({ error: 'Only Super Admin can delete users' }, { status: 403 });
    }

    const { id } = await params;

    // Cannot delete yourself
    if (id === payload.userId) {
      return NextResponse.json({ error: 'Cannot delete yourself' }, { status: 400 });
    }

    // C-1: Non-super-admin can only delete users within their own organization.
    const whereClause: Record<string, string> = { id };
    if (payload.role !== 'super_admin' && payload.organizationId) {
      whereClause.organizationId = payload.organizationId;
    }

    const user = await db.appUser.findFirst({ where: whereClause });
    if (!user) {
      return NextResponse.json({ error: 'User not found' }, { status: 404 });
    }

    // Cannot delete super_admin
    if (user.role === 'super_admin') {
      return NextResponse.json({ error: 'Cannot delete Super Admin' }, { status: 403 });
    }

    // Spec §26: Last Super Admin protection — prevent deactivating the last
    // active Super Admin account.
    if (user.role === 'super_admin' || payload.role === 'super_admin') {
      const activeSuperAdminCount = await db.appUser.count({
        where: { role: 'super_admin', isActive: true },
      });
      if (activeSuperAdminCount <= 1) {
        return NextResponse.json({ error: 'Cannot deactivate the last Super Admin' }, { status: 403 });
      }
    }

    await db.appUser.update({
      where: { id },
      data: { isActive: false },
    });

    // S-04: deactivating a user revokes every live session immediately.
    await revokeAllUserSessions(id);

    // Audit log (S-08: sanitized User-Agent for incident forensics).
    await db.auditLog.create({
      data: {
        action: 'delete',
        resource: 'user',
        resourceId: id,
        description: `User ${payload.email} deactivated user ${user.email} (${user.name})`,
        userId: payload.userId,
        organizationId: payload.organizationId ?? null,
        userAgent: getUserAgent(req),
      },
    });

    return NextResponse.json({ message: 'User deactivated successfully' });
  } catch (error) {
    log.error('api.auth.users.id.', { error: String('Delete user error:') }, requestContext(req));
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
