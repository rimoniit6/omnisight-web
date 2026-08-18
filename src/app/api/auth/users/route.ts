import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { verifyJWT, getRequestToken, hashPassword, hasRolePermission, getRoleLabel } from '@/lib/auth';

// ─── GET /api/auth/users ───────────────────────────────────────────────────
// List all users (admin+ only)

export async function GET(req: NextRequest) {
  try {
    const token = getRequestToken(req);
    if (!token) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const payload = await verifyJWT(token);
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

    const where: Record<string, unknown> = {};
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
    console.error('List users error:', error);
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

    const payload = await verifyJWT(token);
    if (!payload) {
      return NextResponse.json({ error: 'Invalid or expired token' }, { status: 401 });
    }

    // Only admin+ can create users
    if (!hasRolePermission(payload.role, 'admin')) {
      return NextResponse.json({ error: 'Insufficient permissions' }, { status: 403 });
    }

    const body = await req.json();
    const { email, name, password, role, organizationId } = body as {
      email?: string;
      name?: string;
      password?: string;
      role?: string;
      organizationId?: string;
    };

    if (!email || !name || !password || !role) {
      return NextResponse.json(
        { error: 'Email, name, password, and role are required' },
        { status: 400 }
      );
    }

    const validRoles = ['super_admin', 'owner', 'admin', 'manager', 'viewer'];
    if (!validRoles.includes(role)) {
      return NextResponse.json({ error: `Invalid role. Must be one of: ${validRoles.join(', ')}` }, { status: 400 });
    }

    // Only super_admin can create super_admin users
    if (role === 'super_admin' && payload.role !== 'super_admin') {
      return NextResponse.json({ error: 'Only Super Admin can create Super Admin users' }, { status: 403 });
    }

    // Check password strength
    if (password.length < 8) {
      return NextResponse.json({ error: 'Password must be at least 8 characters' }, { status: 400 });
    }

    // Check if email already exists
    const existing = await db.appUser.findFirst({
      where: { email: { contains: email } },
    });
    const existingUser = existing && existing.email.toLowerCase() === email.toLowerCase();

    if (existingUser) {
      return NextResponse.json({ error: 'Email already exists' }, { status: 409 });
    }

    const hashedPassword = await hashPassword(password);

    const user = await db.$transaction(async (tx) => {
      const created = await tx.appUser.create({
        data: {
          email,
          name,
          password: hashedPassword,
          role,
          organizationId: organizationId || payload.organizationId || null,
          isActive: true,
        },
      });

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
    console.error('Create user error:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
