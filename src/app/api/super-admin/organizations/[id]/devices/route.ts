import { NextRequest } from 'next/server';
import { db as prisma } from '@/lib/db';
import { apiError, apiSuccess, validatePagination } from '@/lib/api';
import { requireManagedTenantAccess } from '@/lib/control-plane';
import { effectiveDeviceStatus } from '@/lib/device-status';

/**
 * GET /api/super-admin/organizations/[id]/devices
 *
 * List devices for a MANAGED organization. Super Admin only.
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

  const where: Record<string, unknown> = { organizationId: id };
  if (status && ['online', 'offline', 'inactive', 'maintenance', 'retired'].includes(status)) {
    where.status = status;
  }

  const [devices, total] = await Promise.all([
    prisma.device.findMany({
      where,
      include: {
        employee: { select: { id: true, firstName: true, lastName: true, employeeId: true } },
      },
      orderBy: { updatedAt: 'desc' },
      skip: pagination.skip,
      take: pagination.pageSize,
    }),
    prisma.device.count({ where }),
  ]);

  // Apply effective status (heartbeat-based online detection)
  const enriched = devices.map((d) => ({
    ...d,
    status: effectiveDeviceStatus(d.status, d.lastHeartbeat),
  }));

  return apiSuccess({
    devices: enriched,
    pagination: {
      page: pagination.page,
      pageSize: pagination.pageSize,
      total,
      pages: Math.ceil(total / pagination.pageSize),
    },
  });
}
