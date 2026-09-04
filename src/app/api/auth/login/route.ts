import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { verifyPassword, signJWT, setSessionCookie, jwtLifetimeSeconds } from '@/lib/auth';
import { checkRateLimit, RATE_LIMITS } from '@/lib/rate-limit';
import { getClientIpFromHeaders } from '@/lib/client-ip';
import { log, requestContext } from '@/lib/logger';
import { createUserSession, getUserAgent } from '@/lib/session';
import { resolveActiveMembership, restoreLastActiveOrg } from '@/lib/membership';

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const { email, password } = body as { email?: string; password?: string };

    if (!email || !password) {
      return NextResponse.json(
        { error: 'Email and password are required' },
        { status: 400 }
      );
    }

    // Rate limit: per IP + email AND per email-only — two layers of
    // brute-force protection. The IP+email bucket catches distributed
    // attempts; the email-only bucket catches IP-rotation attacks.
    const clientIp = getClientIpFromHeaders(req.headers);
    const normalizedEmail = String(email).toLowerCase();

    // Layer 1: per-email rate limit (defeats IP rotation)
    const emailRlKey = `login:email:${normalizedEmail}`;
    const emailRl = await checkRateLimit(emailRlKey, RATE_LIMITS.login.limit, RATE_LIMITS.login.windowMs);
    if (!emailRl.allowed) {
      log.warn('auth.login.rate_limited', { email: normalizedEmail, reason: 'email_throttle' }, requestContext(req));
      const res = NextResponse.json(
        { error: 'Too many login attempts. Please try again later.', retryAfter: emailRl.retryAfterSeconds },
        { status: 429 }
      );
      res.headers.set('Retry-After', String(emailRl.retryAfterSeconds));
      return res;
    }

    // Layer 2: per IP+email rate limit (defeats distributed attacks)
    const rlKey = `login:${clientIp}:${normalizedEmail}`;
    const rl = await checkRateLimit(rlKey, RATE_LIMITS.login.limit, RATE_LIMITS.login.windowMs);
    if (!rl.allowed) {
      log.warn('auth.login.rate_limited', { email: normalizedEmail, reason: 'ip_throttle' }, requestContext(req));
      const res = NextResponse.json(
        { error: 'Too many login attempts. Please try again later.', retryAfter: rl.retryAfterSeconds },
        { status: 429 }
      );
      res.headers.set('Retry-After', String(rl.retryAfterSeconds));
      return res;
    }

    // Find user by email. Fast path: exact (lowercased) match uses the
    // unique index. Fallback: case-insensitive lookup for mixed-case emails
    // (PostgreSQL ILIKE via `mode: 'insensitive'`).
    let user = await db.appUser.findFirst({
      where: { email: String(email).toLowerCase(), isActive: true },
    });
    if (!user) {
      user = await db.appUser.findFirst({
        where: { email: { equals: String(email), mode: 'insensitive' }, isActive: true },
      });
    }

    if (!user || !user.password) {
      log.warn('auth.login.failed', { email: String(email).toLowerCase(), reason: 'no_user' }, requestContext(req));
      return NextResponse.json(
        { error: 'Invalid email or password' },
        { status: 401 }
      );
    }

    // Verify password
    const isValid = await verifyPassword(password, user.password);
    if (!isValid) {
      log.warn('auth.login.failed', { email: String(email).toLowerCase(), reason: 'bad_password' }, requestContext(req));
      return NextResponse.json(
        { error: 'Invalid email or password' },
        { status: 401 }
      );
    }

    log.info('auth.login.success', { userId: user.id, email: user.email }, requestContext(req));

    // P1: resolve the effective active organization from the authoritative
    // OrganizationMembership layer (falls back to the deprecated
    // AppUser.organizationId for pre-migration users).
    const resolved = await resolveActiveMembership(user.id, user.organizationId);
    let activeOrgId = resolved?.organizationId ?? user.organizationId ?? null;

    // Membership-less super_admin (global operator): resolveActiveMembership
    // returns null, so without this fallback EVERY login lands org-less and
    // org-scoped surfaces (dashboard, header search, screenshots, …) come up
    // empty until the org is re-picked in the switcher. Restore the org the
    // operator last worked in (server-side session history, re-validated as
    // existing + active) so login context survives re-login.
    if (!activeOrgId && user.role === 'super_admin') {
      activeOrgId = await restoreLastActiveOrg(user.id);
    }
    // Super Admin keeps their platform-level role in the JWT regardless of
    // any OrganizationMembership role.  This matches /api/auth/me behavior
    // and ensures privileged routes (POST /api/organizations) that read the
    // JWT role can verify super_admin authority.
    const effectiveRole = user.role === 'super_admin' ? 'super_admin' : (resolved?.role ?? user.role);

    // Update last login and create audit log
    await db.$transaction(async (tx) => {
      await tx.appUser.update({
        where: { id: user.id },
        data: { lastLogin: new Date() },
      });

      // Create audit log
      await tx.auditLog.create({
        data: {
          action: 'login',
          resource: 'auth',
          resourceId: user.id,
          description: `User ${user.name} (${user.email}) logged in`,
          userId: user.id,
          // Null for org-less super_admin (AuditLog.organizationId is nullable).
          organizationId: activeOrgId,
        },
      });
    });

    // Get organization — derived strictly from the resolved membership (or the
    // legacy field). No findFirst() over all organizations: an org-less user
    // gets no org, never the "first row in the table" (tenant isolation).
    const organization = activeOrgId
      ? await db.organization.findUnique({
          where: { id: activeOrgId },
          select: {
            id: true,
            name: true,
            slug: true,
            email: true,
            phone: true,
            address: true,
            logo: true,
            status: true,
            timezone: true,
            currency: true,
          },
        })
      : null;

    // Server-authoritative session (S-04): one UserSession row per login. The
    // JWT carries the sessionId so logout, force-logout, disable, and password
    // change can revoke it server-side. The row expires in lockstep with the
    // JWT lifetime.
    const { id: sessionId } = await createUserSession({
      userId: user.id,
      organizationId: activeOrgId,
      ipAddress: clientIp,
      userAgent: getUserAgent(req),
      expiresAt: new Date(Date.now() + jwtLifetimeSeconds() * 1000),
    });

    // Sign JWT. activeOrganizationId always corresponds to an ACTIVE membership
    // (or is undefined for a global super_admin). The client can never select
    // an organization it is not a member of.
    const token = await signJWT({
      userId: user.id,
      email: user.email,
      role: effectiveRole,
      organizationId: activeOrgId || undefined,
      activeOrganizationId: activeOrgId || undefined,
      sessionId,
    });

    const roleLabels: Record<string, string> = {
      super_admin: 'Super Admin',
      org_admin: 'Organization Admin',
      admin: 'Admin',
      owner: 'Owner',
      manager: 'Manager',
      viewer: 'Viewer',
    };

    const initials = user.name
      ? user.name
          .split(' ')
          .map((n) => n[0])
          .join('')
          .toUpperCase()
          .slice(0, 2)
      : 'AD';

    const response = NextResponse.json({
      token,
      user: {
        id: user.id,
        name: user.name,
        email: user.email,
        role: effectiveRole,
        roleLabel: roleLabels[effectiveRole] || effectiveRole,
        initials,
        avatar: user.avatar,
        lastLogin: new Date(),
        mustChangePassword: user.mustChangePassword,
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

    // Set httpOnly session cookie so all same-origin API calls are
    // authenticated without JS-accessible tokens. Max-age mirrors the JWT
    // lifetime so the cookie and the session row die together.
    return setSessionCookie(response, token, jwtLifetimeSeconds());
  } catch (error) {
    log.error('auth.login.error', { err: error }, requestContext(req));
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    );
  }
}
