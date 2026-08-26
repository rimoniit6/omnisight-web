import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { getRequestToken } from '@/lib/auth';
import { verifySessionToken } from '@/lib/session';
import { log, requestContext } from '@/lib/logger';

export async function GET(req: NextRequest) {
  try {
    const token = getRequestToken(req);

    if (!token) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    // verifySessionToken (S-04): a revoked session is rejected even when its
    // JWT signature is still valid.
    const payload = await verifySessionToken(token);
    if (!payload) {
      return NextResponse.json({ error: 'Invalid or expired token' }, { status: 401 });
    }

    const adminUser = await db.appUser.findUnique({
      where: { id: payload.userId },
    });

    if (!adminUser || !adminUser.isActive) {
      return NextResponse.json({ error: 'User not found or inactive' }, { status: 401 });
    }

    const organization = adminUser.organizationId
      ? await db.organization.findUnique({
          where: { id: adminUser.organizationId },
        })
      : null;

    const initials = adminUser.name
      ? adminUser.name.split(' ').map(n => n[0]).join('').toUpperCase().slice(0, 2)
      : 'AD';

    const roleLabels: Record<string, string> = {
      super_admin: 'Super Admin',
      admin: 'Admin',
      owner: 'Owner',
      manager: 'Manager',
      viewer: 'Viewer',
    };

    return NextResponse.json({
      user: {
        id: adminUser.id,
        name: adminUser.name,
        email: adminUser.email,
        role: adminUser.role,
        roleLabel: roleLabels[adminUser.role] || adminUser.role,
        initials,
        avatar: adminUser.avatar,
        lastLogin: adminUser.lastLogin,
      },
      organization: organization
        ? {
            id: organization.id,
            name: organization.name,
            slug: organization.slug,
            email: organization.email,
            phone: organization.phone,
            address: organization.address,
            logo: organization.logo,
            status: organization.status,
            timezone: organization.timezone,
            currency: organization.currency,
          }
        : null,
    });
  } catch (error) {
    log.error('api.auth.me.', { error: String('Auth/me error:') }, requestContext(req));
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
