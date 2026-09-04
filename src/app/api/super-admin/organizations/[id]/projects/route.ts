import { NextRequest } from 'next/server';
import { db as prisma } from '@/lib/db';
import { apiError, apiSuccess, validatePagination } from '@/lib/api';
import { requireManagedTenantAccess } from '@/lib/control-plane';

/**
 * GET /api/super-admin/organizations/[id]/projects
 *
 * List projects for a MANAGED organization. Super Admin only.
 * Phase 2 privacy: CUSTOMER_DB / PRIVATE organizations are rejected with 403.
 */
export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;

  const org = await prisma.organization.findUnique({ where: { id }, select: { id: true } });
  if (!org) return apiError('Organization not found', 404);

  const access = await requireManagedTenantAccess(req, id);
  if (!access.ok) {
    if (access.status === 401) return apiError('Unauthorized. Please sign in.', 401);
    return apiError(
      access.code === 'TENANT_ACCESS_DENIED_FOR_MODE'
        ? 'Operational data for customer-owned organizations is not accessible from the Super Admin console'
        : 'Tenant access cannot be resolved',
      access.status,
    );
  }

  const { searchParams } = new URL(req.url);
  const pagination = validatePagination(searchParams, { defaultPageSize: 20, maxPageSize: 200 });
  if (!pagination.ok) return apiError(pagination.error, pagination.status);

  const status = searchParams.get('status') || '';
  const search = searchParams.get('search') || '';

  const where: Record<string, unknown> = { organizationId: id };
  if (status && ['active', 'on_hold', 'completed', 'cancelled'].includes(status)) {
    where.status = status;
  }
  if (search) {
    where.OR = [
      { name: { contains: search, mode: 'insensitive' } },
      { description: { contains: search, mode: 'insensitive' } },
    ];
  }

  const [projects, total] = await Promise.all([
    prisma.project.findMany({
      where,
      include: {
        department: { select: { id: true, name: true } },
        _count: { select: { members: true, timeEntries: true } },
      },
      orderBy: { createdAt: 'desc' },
      skip: pagination.skip,
      take: pagination.pageSize,
    }),
    prisma.project.count({ where }),
  ]);

  return apiSuccess({
    projects: projects.map((p) => ({
      ...p,
      memberCount: p._count.members,
      timeEntryCount: p._count.timeEntries,
      _count: undefined,
    })),
    pagination: {
      page: pagination.page,
      pageSize: pagination.pageSize,
      total,
      pages: Math.ceil(total / pagination.pageSize),
    },
  });
}
