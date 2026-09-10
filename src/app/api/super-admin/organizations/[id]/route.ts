import { NextRequest, NextResponse } from 'next/server';
import { db as prisma } from '@/lib/db';
import { requireDbVerifiedRole, requireSuperAdmin, apiError, apiSuccess, authError, parseJsonBody, BodyParseError } from '@/lib/api';
import { isDeploymentMode, validateDeploymentModeChange, type DeploymentMode } from '@/lib/deployment-mode';
import { getOrganizationDeleteImpact } from '@/lib/delete-impact';
import { deleteScreenshot, isNotFound } from '@/lib/storage';
import { log, requestContext } from '@/lib/logger';

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
          // Manual payment ledger — the newest invoice on this subscription.
          invoices: {
            orderBy: { createdAt: 'desc' },
            take: 1,
            select: {
              id: true,
              invoiceNumber: true,
              amount: true,
              currency: true,
              status: true,
              paidAt: true,
              paymentMethod: true,
              transactionId: true,
              dueDate: true,
              notes: true,
            },
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
 *   status?: 'pending' | 'active' | 'paused' | 'archived',
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

  if (status !== undefined && !['pending', 'active', 'paused', 'archived'].includes(status)) {
    return apiError('Invalid status. Must be: pending, active, paused, or archived', 422);
  }
  if (deploymentMode !== undefined && (!isDeploymentMode(deploymentMode) || deploymentMode === 'PRIVATE')) {
    return apiError('Invalid deploymentMode. Must be: MANAGED or CUSTOMER_DB', 422);
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

/**
 * DELETE /api/super-admin/organizations/[id]
 *
 * Full tenant deletion (Super Admin only, DB-verified). This is the ONLY
 * route that performs a hard cascade across an entire tenant, so it is
 * deliberately strict:
 *   1. The caller must first review the impact via the GET .../delete-impact
 *      endpoint (same engine, live counts).
 *   2. The DELETE itself REQUIRES `{ confirmed: true }` in the body — anything
 *      else returns 409 with a fresh impact summary (never a fake success).
 *   3. The destination counts are recomputed INSIDE the same transaction, so a
 *      concurrent change between preview and confirm can never be hidden.
 *   4. AppUser accounts and audit-log history intentionally SURVIVE
 *      (memberships cascade; audit rows fall back to organizationId NULL).
 *   5. Screenshot object files are removed best-effort after the DB commit.
 */
export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const adminResult = await requireDbVerifiedRole(req, { requireSuperAdmin: true });
    if (!adminResult.ok) return authError(adminResult);
    const admin = adminResult;

    const { id } = await params;

    const organization = await prisma.organization.findUnique({ where: { id } });
    if (!organization) {
      return apiError('Organization not found', 404);
    }

    let body: Record<string, unknown>;
    try {
      body = await parseJsonBody(req);
    } catch {
      return apiError('A JSON body with confirmed:true is required to delete an organization', 400);
    }

    if (body.confirmed !== true) {
      const impact = await getOrganizationDeleteImpact(id);
      return NextResponse.json(
        {
          error: 'Organization deletion requires explicit confirmation.',
          message: `Sending confirmed:true will PERMANENTLY DELETE ${impact.totalImpacted} rows across ${impact.rows.length} table(s) for "${organization.name}". User accounts and audit history survive.`,
          impact,
        },
        { status: 409 }
      );
    }

    // Snapshot the impact + screenshot artifacts BEFORE the transaction so the
    // returned summary is truthful and the storage cleanup has the paths.
    const impact = await getOrganizationDeleteImpact(id);
    const screenshotArtifacts = await prisma.screenshot.findMany({
      where: { organizationId: id },
      select: { filePath: true, thumbnailPath: true },
    });

    await prisma.$transaction(async (tx) => {
      // Leave no live web/agent session pointing at a deleted tenant.
      await tx.userSession.updateMany({
        where: { OR: [{ organizationId: id }, { activeOrganizationId: id }], revokedAt: null },
        data: { revokedAt: new Date() },
      });

      // Audit the deletion BEFORE removing the row: the audit entry survives
      // with organizationId falling back to NULL (compliance requirement).
      await tx.auditLog.create({
        data: {
          action: 'delete',
          resource: 'organization',
          resourceId: id,
          description: `Organization "${organization.name}" (${organization.slug}) permanently deleted by Super Admin ${admin.email}. Impact: ${impact.totalImpacted} rows across ${impact.rows.length} table(s). Memberships for user accounts and prior audit history are preserved.`,
          userId: admin.userId,
          organizationId: id,
        },
      });

      await tx.organization.delete({ where: { id } });
    });

    // Best-effort storage cleanup for the deleted screenshot rows. Original +
    // thumbnail objects are removed through the active storage driver; a
    // missing object is treated as already deleted.
    let filesRemoved = 0;
    for (const { filePath, thumbnailPath } of screenshotArtifacts) {
      for (const artifactPath of [thumbnailPath, filePath].filter((p): p is string => Boolean(p))) {
        try {
          await deleteScreenshot(id, artifactPath);
          filesRemoved++;
        } catch (error) {
          if (!isNotFound(error)) log.warn('sa.orgs.delete.storage', { error: String(error), organizationId: id });
        }
      }
    }

    log.info('sa.orgs.delete', { organizationId: id, totalImpacted: impact.totalImpacted, filesRemoved });

    return apiSuccess({
      deleted: true,
      organizationId: id,
      impact,
      filesRemoved,
      preserved: {
        appUserAccounts: true,
        auditHistory: true,
      },
    });
  } catch (error) {
    log.error('sa.orgs.delete', { error: String(error) }, requestContext(req));
    return apiError('Failed to delete organization', 500);
  }
}
