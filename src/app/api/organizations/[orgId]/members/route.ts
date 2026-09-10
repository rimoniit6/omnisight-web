import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { getRoleLabel } from '@/lib/auth';
import { requireOrgAdmin, apiError, apiSuccess } from '@/lib/api';
import { isOrgRole, canAssignRole, resolveActorDbRole } from '@/lib/org-members';
import { normalizeEmail } from '@/lib/email';
import { log, requestContext } from '@/lib/logger';

// ─── Helpers ────────────────────────────────────────────────────────────────────

/** Bounded page sizes — an unbounded pageSize can balloon a list response. */
export const ALLOWED_PAGE_SIZES = [10, 25, 50, 100] as const;
export const DEFAULT_PAGE_SIZE = 25;

/** Strict positive-integer parser: leading zeros/plus/whitespace noise → null. */
function parsePositiveInt(raw: string | null): number | null {
  if (raw === null) return null;
  const t = raw.trim();
  if (!/^\d+$/.test(t)) return null;
  const n = Number(t);
  if (!Number.isSafeInteger(n) || n < 1) return null;
  return n;
}

// ─── GET /api/organizations/[orgId]/members ────────────────────────────────────
// List members of an organization. Admin+ within the org, or super_admin.
// Paginated via `page` / `pageSize` (one of 10/25/50/100; default 25) so large
// orgs never ship the whole membership in one payload. Response always carries
// `pagination` metadata: { page, pageSize, total, pages }.
export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ orgId: string }> }
) {
  try {
    const { orgId } = await params;
    const auth = await requireOrgAdmin(req, orgId);
    if (!auth.ok) return apiError('Insufficient permissions', auth.status);

    const sp = req.nextUrl.searchParams;
    const rawPage = sp.get('page');
    const rawPageSize = sp.get('pageSize');

    let pageSize = DEFAULT_PAGE_SIZE;
    if (rawPageSize !== null) {
      const n = parsePositiveInt(rawPageSize);
      if (n === null || !(ALLOWED_PAGE_SIZES as readonly number[]).includes(n)) {
        return apiError('pageSize must be one of 10, 25, 50, 100', 400);
      }
      pageSize = n;
    }

    let page = 1;
    if (rawPage !== null) {
      const n = parsePositiveInt(rawPage);
      if (n === null) return apiError('page must be a positive integer', 400);
      page = n;
    }

    const where = { organizationId: orgId };
    const [total, members] = await Promise.all([
      db.organizationMembership.count({ where }),
      db.organizationMembership.findMany({
        where,
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
        // Stable ordering: createdAt alone can tie on fast consecutive inserts,
        // and an unstable order makes paging duplicate/skip rows.
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
    ]);

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
      pagination: {
        page,
        pageSize,
        total,
        pages: Math.max(1, Math.ceil(total / pageSize)),
      },
    });
  } catch (error) {
    log.error('api.orgs.members.list', { error: String(error) }, requestContext(req));
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

// ─── POST /api/organizations/[orgId]/members ───────────────────────────────────
// Add/invite an existing user to this organization with an org-specific role.
// The user is identified by email. A membership (ACTIVE) is created; the user
// may already belong to other organizations (genuine multi-org).
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ orgId: string }> }
) {
  try {
    const { orgId } = await params;
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
