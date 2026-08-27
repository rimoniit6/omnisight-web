import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { signJWT, getRequestToken, getRoleLabel, setSessionCookie, jwtLifetimeSeconds } from '@/lib/auth';
import { verifySessionToken, extendSessionExpiry } from '@/lib/session';
import { log, requestContext } from '@/lib/logger';

/**
 * POST /api/auth/refresh-token
 * Refresh an existing JWT token (sliding expiration).
 *
 * Requires a valid, non-expired token with an active server-side session.
 *
 * ROLE RESOLUTION (P0/P1 FIX): OrganizationMembership is the authoritative
 * source for the organization-specific role. AppUser.role is NEVER used as
 * the source of the active organization's role. The membership role is
 * verified from the database on every refresh to prevent privilege
 * persistence after a role downgrade.
 *
 * SUPER ADMIN SPECIAL CASE: Super Admin is a platform-level role and does NOT
 * require an OrganizationMembership to operate. If the user is super_admin
 * with no membership, the super_admin role is preserved.
 */
export async function POST(req: NextRequest) {
  try {
    const token = getRequestToken(req);
    if (!token) {
      return NextResponse.json({ error: 'No token provided' }, { status: 401 });
    }

    // verifySessionToken = JWT + server-side session re-check (S-04): a
    // revoked session cannot refresh itself into a new token.
    const payload = await verifySessionToken(token);
    if (!payload) {
      return NextResponse.json({ error: 'Invalid or expired token' }, { status: 401 });
    }

    // Verify user still exists and is active
    const user = await db.appUser.findUnique({
      where: { id: payload.userId },
      select: { id: true, email: true, name: true, role: true, avatar: true, isActive: true, lastLogin: true, organizationId: true },
    });

    if (!user || !user.isActive) {
      return NextResponse.json({ error: 'User not found or inactive' }, { status: 401 });
    }

    // ── ROLE RESOLUTION FROM MEMBERSHIP (authoritative) ──────────────────
    // The activeOrganizationId comes from the JWT (set by login or switch).
    // We must verify the user has an ACTIVE membership for that org and
    // resolve the role from the membership, NOT from AppUser.role.
    const activeOrgId = payload.activeOrganizationId || user.organizationId || undefined;
    let effectiveRole = user.role; // fallback for org-less super_admin

    if (activeOrgId && user.role !== 'super_admin') {
      // Verify ACTIVE membership for the active organization
      const membership = await db.organizationMembership.findUnique({
        where: {
          userId_organizationId: { userId: user.id, organizationId: activeOrgId },
        },
        select: { role: true, status: true },
      });

      if (!membership || membership.status !== 'ACTIVE') {
        // No active membership for this org — reject the refresh.
        // The user must switch to an org they have an active membership in.
        return NextResponse.json(
          { error: 'No active membership for this organization' },
          { status: 403 }
        );
      }

      // Verify the organization itself is active
      const org = await db.organization.findUnique({
        where: { id: activeOrgId },
        select: { status: true },
      });

      if (!org || org.status !== 'active') {
        return NextResponse.json(
          { error: 'Organization is not active' },
          { status: 403 }
        );
      }

      // Use the membership role — NOT AppUser.role
      effectiveRole = membership.role;
    }

    // ── ISSUE REFRESHED TOKEN ────────────────────────────────────────────
    // The SAME sessionId is carried forward (a refresh is not a new session),
    // and the session row's expiry slides in lockstep so the row and the JWT
    // never disagree.
    const sessionId = payload.sessionId;
    if (sessionId) {
      await extendSessionExpiry(sessionId, new Date(Date.now() + jwtLifetimeSeconds() * 1000));
    }

    const newToken = await signJWT({
      userId: user.id,
      email: user.email,
      role: effectiveRole,
      organizationId: activeOrgId,
      activeOrganizationId: activeOrgId,
      sessionId,
    });

    const initials = user.name
      ? user.name.split(' ').map(n => n[0]).join('').toUpperCase().slice(0, 2)
      : 'AD';

    return setSessionCookie(
      NextResponse.json({
        token: newToken,
        user: {
          id: user.id,
          name: user.name,
          email: user.email,
          role: effectiveRole,
          roleLabel: getRoleLabel(effectiveRole),
          initials,
          avatar: user.avatar,
          lastLogin: user.lastLogin,
        },
      }),
      newToken,
      jwtLifetimeSeconds()
    );
  } catch (err) {
    log.error('api.auth.refresh-token.', { error: String(err) }, requestContext(req));
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
