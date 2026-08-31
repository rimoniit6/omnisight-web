import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { getRequestToken, hashPassword, hasRolePermission, getRoleLabel } from '@/lib/auth';
import { verifySessionToken } from '@/lib/session';
import { normalizeEmail } from '@/lib/email';
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

// ─── GET /api/auth/users ───────────────────────────────────────────────────
// List all users (admin+ only)

export async function GET(req: NextRequest) {
  try {
    const token = getRequestToken(req);
    if (!token) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const payload = await verifySessionToken(token);
    if (!payload) {
      return NextResponse.json({ error: 'Invalid or expired token' }, { status: 401 });
    }

    // Only admin+ can list users
    if (!hasRolePermission(payload.role, 'admin')) {
      return NextResponse.json({ error: 'Insufficient permissions' }, { status: 403 });
    }

    const url = new URL(req.url);
    const page = Math.max(1, parseInt(url.searchParams.get('page') || '1', 10));
    const limit = Math.min(50, Math.max(1, parseInt(url.searchParams.get('limit') || '20', 10)));
    const skip = (page - 1) * limit;
    const search = url.searchParams.get('search') || '';
    const roleFilter = url.searchParams.get('role') || '';

    // C-1: Non-super-admin callers are scoped to their own organization.
    const where: Record<string, unknown> = {};
    if (payload.role !== 'super_admin' && payload.organizationId) {
      where.organizationId = payload.organizationId;
    }
    if (roleFilter) where.role = roleFilter;
    if (search) {
      // Case-insensitive email search on PostgreSQL (ILIKE via mode).
      where.email = { contains: search, mode: 'insensitive' };
    }

    const [users, total] = await Promise.all([
      db.appUser.findMany({
        where,
        select: {
          id: true,
          email: true,
          name: true,
          role: true,
          avatar: true,
          isActive: true,
          lastLogin: true,
          createdAt: true,
          organizationId: true,
        },
        orderBy: { createdAt: 'desc' },
        skip,
        take: limit,
      }),
      db.appUser.count({ where }),
    ]);

    // Apply case-insensitive search filter if needed
    const filtered = search
      ? users.filter(u => u.email.toLowerCase().includes(search.toLowerCase()) || u.name.toLowerCase().includes(search.toLowerCase()))
      : users;

    return NextResponse.json({
      users: filtered.map(u => ({
        id: u.id,
        email: u.email,
        name: u.name,
        role: u.role,
        roleLabel: getRoleLabel(u.role),
        avatar: u.avatar,
        isActive: u.isActive,
        lastLogin: u.lastLogin,
        createdAt: u.createdAt,
        organizationId: u.organizationId,
      })),
      pagination: {
        page,
        limit,
        total: search ? filtered.length : total,
        pages: Math.ceil((search ? filtered.length : total) / limit),
      },
    });
  } catch (error) {
    log.error('api.auth.users.', { error: String('List users error:') }, requestContext(req));
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

// ─── POST /api/auth/users ──────────────────────────────────────────────────
// Create a new user (super_admin + admin only)

export async function POST(req: NextRequest) {
  try {
    const token = getRequestToken(req);
    if (!token) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const payload = await verifySessionToken(token);
    if (!payload) {
      return NextResponse.json({ error: 'Invalid or expired token' }, { status: 401 });
    }

    // Only admin+ can create users
    if (!hasRolePermission(payload.role, 'admin')) {
      return NextResponse.json({ error: 'Insufficient permissions' }, { status: 403 });
    }

    const body = await req.json();
    const { name, password, role } = body as {
      email?: string;
      name?: string;
      password?: string;
      role?: string;
    };

    // E-01: Normalize email — trim + lowercase for consistent storage.
    const email = normalizeEmail(body.email);

    if (!email || !name || !password || !role) {
      return NextResponse.json(
        { error: 'Email, name, password, and role are required' },
        { status: 400 }
      );
    }

    // Spec §14: Only org-level roles can be assigned through user creation.
    // super_admin must be provisioned through the bootstrap or a separate
    // protected operation — never through the normal user-creation API.
    const validRoles = ['org_admin', 'manager', 'viewer'];
    if (!validRoles.includes(role)) {
      return NextResponse.json({ error: `Invalid role. Must be one of: ${validRoles.join(', ')}` }, { status: 400 });
    }

    // C-2: Privilege escalation guard — assigner must have >= target role level.
    // Only super_admin can create org_admin users.
    const assignerLevel = ROLE_LEVELS[payload.role] ?? 0;
    const targetLevel = ROLE_LEVELS[role] ?? 0;
    if (payload.role !== 'super_admin' && assignerLevel < targetLevel) {
      return NextResponse.json(
        { error: `Insufficient permissions to assign role '${role}' (requires level ${targetLevel}, you have ${assignerLevel})` },
        { status: 403 }
      );
    }

    // Check password strength
    if (password.length < 8) {
      return NextResponse.json({ error: 'Password must be at least 8 characters' }, { status: 400 });
    }

    // C-1: Determine organization — non-super-admins are forced to their own org.
    const targetOrgId = payload.role === 'super_admin'
      ? (body.organizationId as string | undefined) || payload.organizationId || null
      : payload.organizationId || null;

    // Check if email already exists (case-insensitive).
    const existingUser = await db.appUser.findFirst({
      where: {
        email: { equals: email, mode: 'insensitive' },
      },
    });

    if (existingUser) {
      return NextResponse.json({ error: 'Email already exists' }, { status: 409 });
    }

    const hashedPassword = await hashPassword(password);

    const user = await db.$transaction(async (tx) => {
      // AppUser.role is always "user" for normal accounts. The organization-
      // specific role (org_admin, manager, viewer) belongs to OrganizationMembership,
      // NOT to AppUser.role. Only the bootstrap Super Admin gets role="super_admin".
      const created = await tx.appUser.create({
        data: {
          email: email, // already normalized via normalizeEmail above
          name,
          password: hashedPassword,
          role: 'user',
          organizationId: targetOrgId,
          isActive: true,
        },
      });

      // P1: OrganizationMembership is the authoritative membership layer.
      // All non-super_admin roles create an ACTIVE membership in the target org.
      // The compound-unique [userId, organizationId] constraint prevents
      // duplicate memberships; upsert keeps create idempotent.
      if (targetOrgId) {
        await tx.organizationMembership.upsert({
          where: {
            userId_organizationId: { userId: created.id, organizationId: targetOrgId },
          },
          create: {
            userId: created.id,
            organizationId: targetOrgId,
            role,
            status: 'ACTIVE',
          },
          update: {
            role,
            status: 'ACTIVE',
          },
        });
      }

      // Audit log
      await tx.auditLog.create({
        data: {
          action: 'create',
          resource: 'user',
          resourceId: created.id,
          description: `User ${payload.email} created new user ${name} (${email}) with role ${role}`,
          userId: payload.userId,
          organizationId: payload.organizationId ?? null,
        },
      });

      return created;
    });

    return NextResponse.json({
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
        role: user.role,
        roleLabel: getRoleLabel(user.role),
        isActive: user.isActive,
        createdAt: user.createdAt,
      },
    }, { status: 201 });
  } catch (error) {
    log.error('api.auth.users.', { error: String('Create user error:') }, requestContext(req));
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
