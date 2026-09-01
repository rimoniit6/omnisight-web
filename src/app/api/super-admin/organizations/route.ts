import { NextRequest } from 'next/server';
import { db as prisma } from '@/lib/db';
import { requireSuperAdmin, requireDbVerifiedRole, apiError, apiSuccess, authError, parseJsonBody, BodyParseError } from '@/lib/api';

/**
 * GET /api/super-admin/organizations
 *
 * List organizations with server-side search, pagination, and status filter.
 * Super Admin only.
 *
 * Query params:
 *   ?search=       — search by name or slug (case-insensitive)
 *   ?status=       — filter by status (active, suspended, archived)
 *   ?page=         — page number (default: 1)
 *   ?pageSize=     — results per page (default: 20, max: 200)
 */
export async function GET(req: NextRequest) {
  const adminResult = await requireSuperAdmin(req);
  if (!adminResult.ok) return authError(adminResult);

  const url = new URL(req.url);
  const search = url.searchParams.get('search') || '';
  const status = url.searchParams.get('status') || '';
  const page = Math.max(1, parseInt(url.searchParams.get('page') || '1', 10));
  const pageSize = Math.min(200, Math.max(1, parseInt(url.searchParams.get('pageSize') || '20', 10)));
  const skip = (page - 1) * pageSize;

  // Build where clause
  const where: Record<string, unknown> = {};
  if (search) {
    where.OR = [
      { name: { contains: search, mode: 'insensitive' } },
      { slug: { contains: search, mode: 'insensitive' } },
    ];
  }
  if (status && ['active', 'suspended', 'archived'].includes(status)) {
    where.status = status;
  }

  const [organizations, total] = await Promise.all([
    prisma.organization.findMany({
      where,
      select: {
        id: true,
        name: true,
        slug: true,
        status: true,
        createdAt: true,
        updatedAt: true,
        _count: {
          select: {
            employees: true,
            devices: true,
            memberships: true,
          },
        },
      },
      orderBy: { createdAt: 'desc' },
      skip,
      take: pageSize,
    }),
    prisma.organization.count({ where }),
  ]);

  return apiSuccess({
    data: organizations.map((o: typeof organizations[number]) => ({
      ...o,
      memberCount: o._count.memberships,
      employeeCount: o._count.employees,
      deviceCount: o._count.devices,
      _count: undefined,
    })),
    pagination: {
      page,
      pageSize,
      total,
      pages: Math.ceil(total / pageSize),
    },
  });
}

/**
 * POST /api/super-admin/organizations
 *
 * Create a new organization. Super Admin only.
 * Body: { name: string, slug?: string, email?: string, timezone?: string }
 */
export async function POST(req: NextRequest) {
  // P2/P3 #11: DB-verified role for org creation (privileged mutation).
  const adminResult = await requireDbVerifiedRole(req, { requireSuperAdmin: true });
  if (!adminResult.ok) return authError(adminResult);
  const admin = adminResult;

  let body: Record<string, unknown>;
  try {
    body = await parseJsonBody(req);
  } catch (e) {
    if (e instanceof BodyParseError) return apiError('Invalid request body', 400);
    return apiError('Invalid request body', 400);
  }

  const name = body.name as string | undefined;
  if (!name || typeof name !== 'string' || name.trim().length < 2) {
    return apiError('Organization name is required (min 2 characters)', 422);
  }

  // Generate slug from name if not provided
  const slug = (body.slug as string || name)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');

  // Check slug uniqueness
  const existing = await prisma.organization.findUnique({ where: { slug } });
  if (existing) {
    return apiError('An organization with that slug already exists', 409);
  }

  const organization = await prisma.organization.create({
    data: {
      name: name.trim(),
      slug,
      email: (body.email as string) || null,
      timezone: (body.timezone as string) || 'Asia/Dhaka',
      status: 'active',
    },
    select: { id: true, name: true, slug: true, status: true, createdAt: true },
  });

  // P1-01: Super Admin uses platform-level authority, NOT per-org membership.
  // Do NOT create an OrganizationMembership for the Super Admin — they manage
  // organizations through requireSuperAdmin() / requireDbVerifiedRole(), not
  // through org-scoped membership. This prevents ambiguity between
  // platform-level authority and organization membership.

  // Audit log
  await prisma.auditLog.create({
    data: {
      action: 'create',
      resource: 'organization',
      resourceId: organization.id,
      description: `Organization "${organization.name}" created`,
      userId: admin.userId,
      organizationId: organization.id,
    },
  });

  return apiSuccess(organization, 201);
}
