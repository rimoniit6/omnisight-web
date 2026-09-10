import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { requireSuperAdmin, apiError } from '@/lib/api';
import { serializeChangeRequest } from '@/lib/infrastructure';
import { log, requestContext } from '@/lib/logger';

// GET /api/admin/infrastructure-requests/[id]
// Super-Admin detail view of ONE change request (with org + full version
// trail). Secrets masked (last-4); never decrypted into the response.
export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const admin = await requireSuperAdmin(_req);
    if (!admin.ok) return apiError(admin.status === 401 ? 'Unauthorized' : 'Super admin access required', admin.status);

    const { id } = await params;
    const request = await db.infrastructureChangeRequest.findFirst({
      where: { id },
      include: {
        organization: { select: { id: true, name: true, slug: true, email: true } },
      },
    });
    if (!request) return apiError('Change request not found', 404);

    const siblings = await db.infrastructureChangeRequest.findMany({
      where: { organizationId: request.organizationId, kind: request.kind },
      orderBy: { requestNo: 'desc' },
      select: { id: true, requestNo: true, status: true, createdAt: true },
      take: 20,
    });

    return NextResponse.json({
      data: {
        request: serializeChangeRequest(request),
        organization: { id: request.organization.id, name: request.organization.name, slug: request.organization.slug, email: request.organization.email },
        versionTrail: siblings,
      },
    });
  } catch (error) {
    log.error('api.admin.infrastructure-requests.detail', { error: String(error) }, requestContext(_req));
    return apiError('Failed to load the change request', 500);
  }
}