import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { requireSuperAdmin, apiError } from '@/lib/api';
import { serializeChangeRequest } from '@/lib/infrastructure';
import { log, requestContext } from '@/lib/logger';

// GET /api/admin/infrastructure-requests/[id]
// Super-Admin detail view of ONE change request (with org + full version
// trail + current infrastructure context). Secrets masked (last-4); never
// decrypted into the response.
export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const admin = await requireSuperAdmin(_req);
    if (!admin.ok) return apiError(admin.status === 401 ? 'Unauthorized' : 'Super admin access required', admin.status);

    const { id } = await params;
    const request = await db.infrastructureChangeRequest.findFirst({
      where: { id },
      include: {
        organization: { select: { id: true, name: true, slug: true, email: true, deploymentMode: true } },
      },
    });
    if (!request) return apiError('Change request not found', 404);

    const siblings = await db.infrastructureChangeRequest.findMany({
      where: { organizationId: request.organizationId, kind: request.kind },
      orderBy: { requestNo: 'desc' },
      select: { id: true, requestNo: true, status: true, createdAt: true },
      take: 20,
    });

    // Current infrastructure context: what the org is currently using.
    const settings = await db.organizationSettings.findUnique({
      where: { organizationId: request.organizationId },
      select: {
        useOwnDb: true, dbHost: true, dbPort: true, dbName: true, dbUser: true, dbSsl: true,
        dbTestStatus: true,
        storageDriver: true, storageUrl: true, storageTestStatus: true,
      },
    });

    // Latest migration for this org+kind (for context on in-flight work).
    const latestMigration = await db.infrastructureMigration.findFirst({
      where: { organizationId: request.organizationId, kind: request.kind },
      orderBy: { createdAt: 'desc' },
      select: { id: true, status: true, recordsDone: true, recordsTotal: true, objectsDone: true, objectsTotal: true, errorMessage: true, activatedAt: true },
    });

    return NextResponse.json({
      data: {
        request: serializeChangeRequest(request),
        organization: {
          id: request.organization.id,
          name: request.organization.name,
          slug: request.organization.slug,
          email: request.organization.email,
          deploymentMode: request.organization.deploymentMode,
        },
        currentInfrastructure: settings ? {
          database: {
            configured: settings.useOwnDb,
            host: settings.dbHost,
            port: settings.dbPort,
            name: settings.dbName,
            user: settings.dbUser,
            ssl: settings.dbSsl,
            testStatus: settings.dbTestStatus,
          },
          storage: {
            driver: settings.storageDriver ?? 'local',
            url: settings.storageUrl,
            testStatus: settings.storageTestStatus,
          },
        } : null,
        latestMigration: latestMigration ? {
          id: latestMigration.id,
          status: latestMigration.status,
          recordsDone: latestMigration.recordsDone,
          recordsTotal: latestMigration.recordsTotal,
          objectsDone: latestMigration.objectsDone,
          objectsTotal: latestMigration.objectsTotal,
          errorMessage: latestMigration.errorMessage,
          activatedAt: latestMigration.activatedAt,
        } : null,
        versionTrail: siblings,
      },
    });
  } catch (error) {
    log.error('api.admin.infrastructure-requests.detail', { error: String(error) }, requestContext(_req));
    return apiError('Failed to load the change request', 500);
  }
}