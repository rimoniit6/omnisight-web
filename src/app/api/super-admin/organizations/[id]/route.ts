import { NextRequest } from 'next/server';
import { db as prisma } from '@/lib/db';
import { requireDbVerifiedRole, requireSuperAdmin, apiError, apiSuccess, authError, parseJsonBody, BodyParseError } from '@/lib/api';
import { isDeploymentMode, validateDeploymentModeChange, type DeploymentMode } from '@/lib/deployment-mode';

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
      deploymentMode: true,
      deploymentModeUnresolved: true,
      trialEndsAt: true,
      createdAt: true,
      updatedAt: true,
      subscription: {
        select: {
          id: true,
          status: true,
          startDate: true,
          endDate: true,
          trialEndDate: true,
          notes: true,
          plan: {
            select: { id: true, name: true, priceMonthly: true, priceYearly: true, currency: true, maxDevices: true, retentionDays: true },
          },
        },
      },
      licenseKey: {
        select: { id: true, isActive: true, isRevoked: true, validFrom: true, validUntil: true, revokedAt: true, revokedReason: true, lastVerifiedAt: true },
      },
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
 * Control-plane mutations. Super Admin only (DB-verified).
 * Body: {
 *   status?: 'pending' | 'active' | 'suspended' | 'archived',
 *   deploymentMode?: 'MANAGED' | 'CUSTOMER_DB' | 'PRIVATE',
 *   confirmDataResidency?: boolean  // required for CUSTOMER_DB/PRIVATE -> MANAGED
 * }
 *
 * Deployment-mode changes are validated server-side
 * (validateDeploymentModeChange): CUSTOMER_DB targets are rejected until a
 * customer primary-database mechanism exists, and no automatic data migration
 * is ever performed (Phase 2 §22-23).
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
  const deploymentMode = body.deploymentMode as string | undefined;
  const confirmDataResidency = body.confirmDataResidency === true;

  if (status !== undefined && !['pending', 'active', 'suspended', 'archived'].includes(status)) {
    return apiError('Invalid status. Must be: pending, active, suspended, or archived', 422);
  }
  if (deploymentMode !== undefined && !isDeploymentMode(deploymentMode)) {
    return apiError('Invalid deploymentMode. Must be: MANAGED, CUSTOMER_DB, or PRIVATE', 422);
  }
  if (status === undefined && deploymentMode === undefined) {
    return apiError('Nothing to update. Provide status and/or deploymentMode', 422);
  }

  const organization = await prisma.organization.findUnique({ where: { id } });
  if (!organization) {
    return apiError('Organization not found', 404);
  }
  const currentMode = organization.deploymentMode as DeploymentMode;

  // Validate mode change BEFORE touching anything (fail closed, no fallback).
  if (deploymentMode !== undefined && deploymentMode !== currentMode) {
    const check = validateDeploymentModeChange(currentMode, deploymentMode, { confirmDataResidency });
    if (!check.ok) {
      return apiError(check.message, 422);
    }
  }

  const data: Record<string, unknown> = {};
  if (status !== undefined && status !== organization.status) data.status = status;
  if (deploymentMode !== undefined && deploymentMode !== currentMode) {
    data.deploymentMode = deploymentMode;
    // A human explicitly resolved the mode — clear the backfill flag.
    data.deploymentModeUnresolved = false;
  }
  if (Object.keys(data).length === 0) {
    return apiSuccess({ message: 'No changes', organization });
  }

  const updated = await prisma.organization.update({
    where: { id },
    data,
    select: { id: true, name: true, slug: true, status: true, deploymentMode: true, deploymentModeUnresolved: true, updatedAt: true },
  });

  // Audit log (control-plane event — never contains operational data).
  const changes: string[] = [];
  if (data.status !== undefined) changes.push(`status ${organization.status} -> ${data.status}`);
  if (data.deploymentMode !== undefined) changes.push(`deploymentMode ${currentMode} -> ${data.deploymentMode}`);
  await prisma.auditLog.create({
    data: {
      action: 'update',
      resource: 'organization',
      resourceId: id,
      description: `Organization "${organization.name}" updated: ${changes.join('; ')}`,
      userId: admin.userId,
      organizationId: id,
    },
  });

  return apiSuccess(updated);
}
