import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { getRequestToken, getRoleLabel } from '@/lib/auth';
import { verifySessionToken } from '@/lib/session';
import { log, requestContext } from '@/lib/logger';
import { resolveActiveMembership } from '@/lib/membership';

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

    // ── ROLE RESOLUTION FROM MEMBERSHIP (authoritative) ────────────────
    // The previous implementation used AppUser.role (the deprecated legacy
    // global role), which causes all users to potentially display the wrong
    // role in the frontend. OrganizationMembership.role is the source of
    // truth for org-bound users.
    const activeOrgId = payload.activeOrganizationId || adminUser.organizationId || null;
    let effectiveRole = adminUser.role; // fallback for org-less super_admin
    let effectiveOrgId = activeOrgId;

    if (activeOrgId && adminUser.role !== 'super_admin') {
      const membership = await db.organizationMembership.findUnique({
        where: {
          userId_organizationId: { userId: adminUser.id, organizationId: activeOrgId },
        },
        select: { role: true, status: true },
      });

      if (membership && membership.status === 'ACTIVE') {
        effectiveRole = membership.role;
      } else {
        // No active membership for the active org — resolve from any membership
        const resolved = await resolveActiveMembership(adminUser.id, adminUser.organizationId);
        if (resolved) {
          effectiveRole = resolved.role;
          effectiveOrgId = resolved.organizationId;
        } else {
          // Org-bound user with no memberships — deny access
          effectiveOrgId = null;
        }
      }
    }

    // For super_admin, try to resolve membership but keep super_admin role
    if (adminUser.role === 'super_admin' && activeOrgId) {
      const membership = await db.organizationMembership.findUnique({
        where: {
          userId_organizationId: { userId: adminUser.id, organizationId: activeOrgId },
        },
        select: { role: true, status: true },
      });
      // Super admin keeps their platform role regardless of membership
      if (!membership || membership.status !== 'ACTIVE') {
        // No active membership for this org — try to find one
        const resolved = await resolveActiveMembership(adminUser.id, adminUser.organizationId);
        if (resolved) {
          effectiveOrgId = resolved.organizationId;
        } else {
          effectiveOrgId = null;
        }
      }
    }

    const organization = effectiveOrgId
      ? await db.organization.findUnique({
          where: { id: effectiveOrgId },
        })
      : null;

    const initials = adminUser.name
      ? adminUser.name.split(' ').map(n => n[0]).join('').toUpperCase().slice(0, 2)
      : 'AD';

    return NextResponse.json({
      user: {
        id: adminUser.id,
        name: adminUser.name,
        email: adminUser.email,
        role: effectiveRole,
        roleLabel: getRoleLabel(effectiveRole),
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
