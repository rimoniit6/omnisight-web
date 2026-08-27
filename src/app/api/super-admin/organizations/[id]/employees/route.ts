import { NextRequest } from 'next/server';
import { db as prisma } from '@/lib/db';
import { requireSuperAdmin, apiError, apiSuccess, authError, validatePagination } from '@/lib/api';

/**
 * GET /api/super-admin/organizations/[id]/employees
 *
 * List employees for any organization. Super Admin only.
 * No membership required — platform-level authority.
 */
export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const adminResult = await requireSuperAdmin(req);
  if (!adminResult.ok) return authError(adminResult);

  const { id } = await params;

  // Verify organization exists
  const org = await prisma.organization.findUnique({ where: { id }, select: { id: true } });
  if (!org) return apiError('Organization not found', 404);

  const { searchParams } = new URL(req.url);
  const pagination = validatePagination(searchParams, { defaultPageSize: 20, maxPageSize: 200 });
  if (!pagination.ok) return apiError(pagination.error, pagination.status);

  const search = searchParams.get('search') || '';
  const status = searchParams.get('status') || '';

  const where: Record<string, unknown> = { organizationId: id };
  if (status && ['active', 'inactive', 'archived'].includes(status)) {
    where.status = status;
  }
  if (search) {
    where.OR = [
      { firstName: { contains: search, mode: 'insensitive' } },
      { lastName: { contains: search, mode: 'insensitive' } },
      { email: { contains: search, mode: 'insensitive' } },
      { employeeId: { contains: search, mode: 'insensitive' } },
    ];
  }

  const [employees, total] = await Promise.all([
    prisma.employee.findMany({
      where,
      select: {
        id: true,
        employeeId: true,
        firstName: true,
        lastName: true,
        email: true,
        designation: true,
        status: true,
        type: true,
        joinDate: true,
        createdAt: true,
        department: { select: { id: true, name: true } },
        _count: { select: { devices: true } },
      },
      orderBy: { createdAt: 'desc' },
      skip: pagination.skip,
      take: pagination.pageSize,
    }),
    prisma.employee.count({ where }),
  ]);

  return apiSuccess({
    employees: employees.map((e) => ({
      ...e,
      deviceCount: e._count.devices,
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
