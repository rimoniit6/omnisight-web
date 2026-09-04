import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { requireSuperAdmin, apiError } from '@/lib/api';
import { log, requestContext } from '@/lib/logger';

// PUT /api/admin/licenses/[licenseId]/revoke — revoke a license key.
// Body: { reason? } (optional short string; never echoes the key itself).
// A revoked key can no longer validate; if it is the org's current license,
// the org's active pointer is cleared so a subsequent validation fails.
export async function PUT(
  req: NextRequest,
  { params }: { params: Promise<{ licenseId: string }> }
) {
  try {
    const admin = await requireSuperAdmin(req);
    if (!admin.ok) return apiError(admin.status === 401 ? 'Unauthorized' : 'Super admin access required', admin.status);

    const { licenseId } = await params;
    const body = (await req.json().catch(() => ({}))) as { reason?: unknown };
    const reason = typeof body.reason === 'string' && body.reason.trim() ? body.reason.trim().slice(0, 500) : null;

    const license = await db.licenseKey.findUnique({
      where: { id: licenseId },
      select: { id: true, key: true, isRevoked: true, organizationId: true, organization: { select: { name: true } } },
    });
    if (!license) return apiError('License key not found', 404);
    if (license.isRevoked) return apiError('License key is already revoked', 409);

    await db.$transaction(async (tx) => {
      await tx.licenseKey.update({
        where: { id: licenseId },
        data: { isRevoked: true, isActive: false, revokedAt: new Date(), revokedReason: reason },
      });

      // If this was the org's current license, clear the pointer so the
      // self-hosted instance's next validation attempt fails.
      await tx.organization.updateMany({
        where: { licenseKeyId: licenseId },
        data: { licenseKeyId: null },
      });

      await tx.auditLog.create({
        data: {
          action: 'revoke',
          resource: 'license_key',
          resourceId: licenseId,
          description: `Super admin (${admin.email}) revoked license key for org "${license.organization.name}"${reason ? ` (${reason})` : ''}`,
          userId: admin.userId,
          organizationId: license.organizationId,
        },
      });
    });

    return NextResponse.json({ success: true, revoked: true });
  } catch (error) {
    log.error('api.admin.licenses.revoke', { error: String(error) }, requestContext(req));
    return apiError('Failed to revoke license key', 500);
  }
}
