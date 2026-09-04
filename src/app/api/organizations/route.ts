'use server';
import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { authError, requireSessionOrg } from '@/lib/api';
import { authenticateRequest } from '@/lib/api';
import { signJWT, setSessionCookie, getRequestToken } from '@/lib/auth';
import { verifySessionToken } from '@/lib/session';
import { checkRateLimit, RATE_LIMITS, getClientIpFromHeaders } from '@/lib/rate-limit';
import { log, requestContext } from '@/lib/logger';

// GET /api/organizations
// Lightweight organization list for filter dropdowns (e.g. the Employees
// page). Org-bound sessions only ever see their own organization; org-less
// global super_admins see MANAGED organizations only (Phase 1 Step 8 —
// CUSTOMER_DB / PRIVATE orgs are excluded server-side, matching the
// switcher gating in /api/me/organizations).
export async function GET(req: NextRequest) {
  try {
    const scope = await requireSessionOrg(req, { allowGlobal: true });
    if (!scope.ok) return authError(scope);

    const organizations = await db.organization.findMany({
      where: scope.organizationId
        ? { id: scope.organizationId }
        : { deploymentMode: 'MANAGED' },
      select: { id: true, name: true, slug: true, status: true, deploymentMode: true },
      orderBy: { name: 'asc' },
    });

    return NextResponse.json({ data: organizations });
  } catch (error) {
    log.error('api.organizations.', { error: String('Organizations GET error:') }, requestContext(req));
    return NextResponse.json({ error: 'Failed to fetch organizations' }, { status: 500 });
  }
}

// POST /api/organizations
// Bootstrap organization creation. Deliberately restricted:
//   - super_admin only (org-less global OR org-bound);
//   - an org-less super_admin may create the FIRST organization (zero-org
//     bootstrap state) and is transactionally bound to it — the fresh JWT
//     returned in the response carries the new organization context so the
//     UI continues seamlessly without a re-login.
// Tenant isolation is preserved: the caller's organization context ALWAYS
// comes from the verified session, never from a client-supplied field.
export async function POST(req: NextRequest) {
  try {
    const auth = await authenticateRequest(req);
    if (!auth) {
      return NextResponse.json({ error: 'Unauthorized. Please sign in.' }, { status: 401 });
    }
    if (auth.role !== 'super_admin') {
      return NextResponse.json(
        { error: 'Only the Super Admin can create organizations' },
        { status: 403 }
      );
    }

    // Bootstrap-only: organization creation is the FIRST-organization path for
    // an org-less Super Admin. An org-bound session is already operating inside
    // an organization — creating another here would silently re-bind the
    // caller's context, so it is explicitly rejected (tenant isolation).
    const user = await db.appUser.findUnique({
      where: { id: auth.userId },
      select: { organizationId: true, name: true },
    });
    if (!user) {
      return NextResponse.json({ error: 'Account not found' }, { status: 401 });
    }
    if (user.organizationId) {
      return NextResponse.json(
        { error: 'You are already bound to an organization. Switch via your organization context instead.' },
        { status: 403 }
      );
    }

    const ip = getClientIpFromHeaders(req.headers);
    const rl = await checkRateLimit(`orgCreate:${ip}:${auth.userId}`, RATE_LIMITS.orgCreate.limit, RATE_LIMITS.orgCreate.windowMs);
    if (!rl.allowed) {
      return NextResponse.json(
        { error: `Too many requests. Try again in ${rl.retryAfterSeconds} seconds.` },
        { status: 429 }
      );
    }

    const body = await req.json().catch(() => ({})) as { name?: unknown };
    const rawName = typeof body.name === 'string' ? body.name.trim() : '';
    if (rawName.length < 2 || rawName.length > 100) {
      return NextResponse.json(
        { error: 'Organization name must be between 2 and 100 characters' },
        { status: 400 }
      );
    }

    // Slug: derive server-side from the name (lowercase, alnum + hyphen).
    // Uniqueness is enforced by the schema; on collision we return 409.
    let slug = rawName
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 60);
    if (!slug) slug = `org-${Date.now().toString(36)}`;

    // Duplicate-name check (case-insensitive) — friendly 409 instead of a
    // Prisma unique-constraint 500.
    const existingName = await db.organization.findFirst({
      where: { name: { equals: rawName, mode: 'insensitive' } },
      select: { id: true },
    });
    if (existingName) {
      return NextResponse.json(
        { error: 'An organization with this name already exists' },
        { status: 409 }
      );
    }

    const organization = await db.$transaction(async (tx) => {
      const org = await tx.organization.create({
        data: { name: rawName, slug },
      });

      // Bind the creating Super Admin to the new organization — the org-less
      // bootstrap state transitions to a normal org-scoped session.
      await tx.appUser.update({
        where: { id: auth.userId },
        data: { organizationId: org.id },
      });

      // P1 (unified creation): the creator's OrganizationMembership is the
      // authoritative membership record for this org (org_admin role), so the
      // org-switcher and membership management work for them immediately.
      await tx.organizationMembership.upsert({
        where: {
          userId_organizationId: { userId: auth.userId, organizationId: org.id },
        },
        create: { userId: auth.userId, organizationId: org.id, role: 'org_admin', status: 'ACTIVE' },
        update: { role: 'org_admin', status: 'ACTIVE' },
      });

      await tx.auditLog.create({
        data: {
          action: 'create',
          resource: 'organization',
          resourceId: org.id,
          description: `Super Admin created organization "${rawName}"`,
          userId: auth.userId,
          ipAddress: ip === 'unknown' ? null : ip,
          organizationId: org.id,
        },
      });

      return org;
    });

    // Re-sign the session so the caller's token now carries the new org.
    // Organization identity in every future request derives from this
    // verified token — never from client input. The SAME sessionId is carried
    // forward (S-04) so the re-signed token stays revocable server-side.
    const requestToken = getRequestToken(req);
    const currentPayload = requestToken ? await verifySessionToken(requestToken) : null;
    const token = await signJWT({
      userId: auth.userId,
      email: auth.email,
      role: auth.role,
      organizationId: organization.id,
      activeOrganizationId: organization.id,
      sessionId: currentPayload?.sessionId,
    });

    const response = NextResponse.json(
      {
        data: {
          id: organization.id,
          name: organization.name,
          slug: organization.slug,
          status: organization.status,
          timezone: organization.timezone,
          currency: organization.currency,
        },
        token,
        user: {
          id: auth.userId,
          name: user.name,
          email: auth.email,
          role: auth.role,
          roleLabel: auth.role === 'super_admin' ? 'Super Admin' : auth.role,
          initials: user.name
            ? user.name.split(' ').map((n: string) => n[0]).join('').toUpperCase().slice(0, 2)
            : 'SA',
          avatar: null,
          lastLogin: null,
        },
        organization: {
          id: organization.id,
          name: organization.name,
          slug: organization.slug,
          email: null,
          phone: null,
          address: null,
          logo: null,
          status: organization.status,
          timezone: organization.timezone,
          currency: organization.currency,
        },
      },
      { status: 201 }
    );

    return setSessionCookie(response, token, 7 * 24 * 60 * 60);
  } catch (error) {
    // Concurrent duplicate: a unique-constraint violation on name/slug from a
    // parallel request — map to a clean 409 instead of a generic 500.
    const prismaError = error as { code?: string };
    if (prismaError.code === 'P2002') {
      return NextResponse.json(
        { error: 'An organization with this name already exists' },
        { status: 409 }
      );
    }
    log.error('organizations.create.error', { err: error }, requestContext(req));
    return NextResponse.json({ error: 'Failed to create organization' }, { status: 500 });
  }
}
