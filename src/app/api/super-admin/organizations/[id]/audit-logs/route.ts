import { NextRequest } from 'next/server';
import { db as prisma } from '@/lib/db';
import { requireSuperAdmin, apiError, apiSuccess, authError, validatePagination } from '@/lib/api';

/**
 * GET /api/super-admin/organizations/[id]/audit-logs
 *
 * View audit logs for any organization. Super Admin only.
 * No membership required — platform-level authority.
 */
export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const adminResult = await requireSuperAdmin(req);
  if (!adminResult.ok) return authError(adminResult);

  const { id } = await params;

  const org = await prisma.organization.findUnique({ where: { id }, select: { id: true } });
  if (!org) return apiError('Organization not found', 404);

  const { searchParams } = new URL(req.url);
  const pagination = validatePagination(searchParams, { defaultPageSize: 15, maxPageSize: 100 });
  if (!pagination.ok) return apiError(pagination.error, pagination.status);

  const action = searchParams.get('action') || '';
  const resource = searchParams.get('resource') || '';

  const where: Record<string, unknown> = { organizationId: id };
  if (action) where.action = action;
  if (resource) where.resource = resource;

  const [logs, total] = await Promise.all([
    prisma.auditLog.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      skip: pagination.skip,
      take: pagination.pageSize,
    }),
    prisma.auditLog.count({ where }),
  ]);

  return apiSuccess({
    data: logs,
    pagination: {
      page: pagination.page,
      pageSize: pagination.pageSize,
      total,
      pages: Math.ceil(total / pagination.pageSize),
    },
  });
}
