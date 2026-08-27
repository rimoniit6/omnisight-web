import { NextRequest } from 'next/server';
import { db as prisma } from '@/lib/db';
import { requireDbVerifiedRole, requireSuperAdmin, apiError, apiSuccess, authError, parseJsonBody, BodyParseError } from '@/lib/api';

/**
 * GET /api/super-admin/organizations/[id]
 *
 * View detailed organization information. Super Admin only.
 * Returns full org details with counts for employees, devices, members, projects, etc.
 */
export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const adminResult = await requireSuperAdmin(req);
  if (!adminResult.ok) return authError(adminResult);

  const { id } = await params;

  const organization = await prisma.organization.findUnique({
    where: { id },
    select: {
      id: true,
      name: true,
      slug: true,
      email: true,
      phone: true,
      timezone: true,
      language: true,
      currency: true,
      address: true,
      status: true,
      createdAt: true,
      updatedAt: true,
      _count: {
        select: {
          employees: true,
          devices: true,
          memberships: true,
          departments: true,
          projects: true,
          screenshots: true,
          auditLogs: true,
        },
      },
    },
  });

  if (!organization) {
    return apiError('Organization not found', 404);
  }

  return apiSuccess({
    organization: {
      ...organization,
      memberCount: organization._count.memberships,
      employeeCount: organization._count.employees,
      deviceCount: organization._count.devices,
      departmentCount: organization._count.departments,
      projectCount: organization._count.projects,
      screenshotCount: organization._count.screenshots,
      auditLogCount: organization._count.auditLogs,
      _count: undefined,
    },
  });
}

/**
 * PATCH /api/super-admin/organizations/[id]
 *
 * Update organization status (suspend, reactivate, archive). Super Admin only.
 * Body: { status: 'active' | 'suspended' | 'archived' }
 */
export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  // P2/P3 #11: DB-verified role for sensitive org lifecycle mutations.
  const adminResult = await requireDbVerifiedRole(req, { requireSuperAdmin: true });
  if (!adminResult.ok) return authError(adminResult);
  const admin = adminResult;

  const { id } = await params;

  let body: Record<string, unknown>;
  try {
    body = await parseJsonBody(req);
  } catch (e) {
    if (e instanceof BodyParseError) return apiError('Invalid request body', 400);
    return apiError('Invalid request body', 400);
  }

  const status = body.status as string | undefined;
  if (!status || !['active', 'suspended', 'archived'].includes(status)) {
    return apiError('Invalid status. Must be: active, suspended, or archived', 422);
  }

  const organization = await prisma.organization.findUnique({ where: { id } });
  if (!organization) {
    return apiError('Organization not found', 404);
  }

  if (organization.status === status) {
    return apiSuccess({ message: `Organization is already ${status}`, organization });
  }

  const updated = await prisma.organization.update({
    where: { id },
    data: { status },
    select: { id: true, name: true, slug: true, status: true, updatedAt: true },
  });

  // Audit log
  await prisma.auditLog.create({
    data: {
      action: 'update',
      resource: 'organization',
      resourceId: id,
      description: `Organization "${organization.name}" status changed from ${organization.status} to ${status}`,
      userId: admin.userId,
      organizationId: id,
    },
  });

  return apiSuccess(updated);
}
