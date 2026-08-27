import { NextRequest } from 'next/server';
import { db as prisma } from '@/lib/db';
import { requireSuperAdmin, apiError, apiSuccess, authError, validatePagination } from '@/lib/api';
import { effectiveDeviceStatus } from '@/lib/device-status';

/**
 * GET /api/super-admin/organizations/[id]/devices
 *
 * List devices for any organization. Super Admin only.
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
