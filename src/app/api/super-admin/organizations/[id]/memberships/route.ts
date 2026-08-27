import { NextRequest } from 'next/server';
import { db as prisma } from '@/lib/db';
import { requireDbVerifiedRole, apiError, apiSuccess, authError, parseJsonBody, BodyParseError, validatePagination } from '@/lib/api';

/**
 * GET /api/super-admin/organizations/[id]/memberships
 *
 * View memberships for any organization. Super Admin only.
 * No membership required — platform-level authority.
 */
export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const adminResult = await requireDbVerifiedRole(req, { requireSuperAdmin: true });
  if (!adminResult.ok) return authError(adminResult);

  const { id } = await params;

  const org = await prisma.organization.findUnique({ where: { id }, select: { id: true } });
  if (!org) return apiError('Organization not found', 404);

  const { searchParams } = new URL(req.url);
  const pagination = validatePagination(searchParams, { defaultPageSize: 20, maxPageSize: 200 });
  if (!pagination.ok) return apiError(pagination.error, pagination.status);

  const where: Record<string, unknown> = { organizationId: id };

  const [memberships, total] = await Promise.all([
    prisma.organizationMembership.findMany({
      where,
      include: {
        user: {
          select: { id: true, email: true, name: true, avatar: true, isActive: true, lastLogin: true },
        },
      },
      orderBy: { createdAt: 'desc' },
      skip: pagination.skip,
      take: pagination.pageSize,
    }),
    prisma.organizationMembership.count({ where }),
  ]);

  return apiSuccess({
    memberships,
    pagination: {
      page: pagination.page,
      pageSize: pagination.pageSize,
      total,
      pages: Math.ceil(total / pagination.pageSize),
    },
  });
}

/**
 * POST /api/super-admin/organizations/[id]/memberships
 *
 * Add a user to an organization. Super Admin only (DB-verified).
 * Body: { userId: string, role: string }
 */
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const adminResult = await requireDbVerifiedRole(req, { requireSuperAdmin: true });
  if (!adminResult.ok) return authError(adminResult);
  const admin = adminResult;

  const { id } = await params;

  const org = await prisma.organization.findUnique({ where: { id }, select: { id: true, status: true } });
  if (!org) return apiError('Organization not found', 404);

  let body: Record<string, unknown>;
  try {
    body = await parseJsonBody(req);
  } catch (e) {
    if (e instanceof BodyParseError) return apiError('Invalid request body', 400);
    return apiError('Invalid request body', 400);
  }

  const userId = body.userId as string | undefined;
  const role = body.role as string | undefined;

  if (!userId || typeof userId !== 'string') return apiError('userId is required', 422);
  if (!role || !['owner', 'org_admin', 'admin', 'manager', 'viewer'].includes(role)) {
    return apiError('Invalid role. Must be: owner, org_admin, admin, manager, or viewer', 422);
  }

  // Verify user exists
  const user = await prisma.appUser.findUnique({ where: { id: userId }, select: { id: true, email: true } });
  if (!user) return apiError('User not found', 404);

  // Upsert membership (idempotent)
  const membership = await prisma.organizationMembership.upsert({
    where: {
      userId_organizationId: { userId, organizationId: id },
    },
    create: { userId, organizationId: id, role, status: 'ACTIVE' },
    update: { role, status: 'ACTIVE' },
    include: {
      user: { select: { id: true, email: true, name: true } },
    },
  });

  // Audit log
  await prisma.auditLog.create({
    data: {
      action: 'create',
      resource: 'membership',
      resourceId: membership.id,
      description: `Super Admin added ${user.email} to organization with role ${role}`,
      userId: admin.userId,
      organizationId: id,
    },
  });

  return apiSuccess({ membership }, 201);
}
