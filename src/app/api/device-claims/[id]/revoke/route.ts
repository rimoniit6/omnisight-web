'use server';
import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { authError, requireAdminOrg } from '@/lib/api';
import { checkRateLimit, RATE_LIMITS, getClientIpFromHeaders } from '@/lib/rate-limit';

// POST /api/device-claims/[id]/revoke
// Revoke a previously approved device (admin-only, org-scoped).
// After revocation:
//   - the device is deactivated (status -> inactive) → validateAgentToken
//     rejects its bound tokens immediately → heartbeat/activity/screenshot
//     uploads all fail closed (B-9)
//   - the claim is marked revoked and unbound from the employee
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const admin = await requireAdminOrg(req);
    if (!admin.ok) return authError(admin);

    const clientIp = getClientIpFromHeaders(req.headers);
    const rl = await checkRateLimit(`device-claim:${clientIp}`, RATE_LIMITS.deviceClaimWrite.limit, RATE_LIMITS.deviceClaimWrite.windowMs);
    if (!rl.allowed) {
      return NextResponse.json(
        { error: `Too many requests. Try again in ${rl.retryAfterSeconds} seconds.` },
        { status: 429 }
      );
    }

    const { id } = await params;
    const body = await req.json();
    const { reason } = body as { reason?: unknown };

    const claim = await db.deviceClaim.findFirst({
      where: { id, organizationId: admin.organizationId },
      include: { device: true },
    });
    if (!claim) {
      return NextResponse.json({ error: 'Device claim not found' }, { status: 404 });
    }
    if (claim.status !== 'approved') {
      return NextResponse.json(
        { error: `Only approved device claims can be revoked (current: "${claim.status}")` },
        { status: 400 }
      );
    }

    const result = await db.$transaction(async (tx) => {
      await tx.deviceClaim.update({
        where: { id: claim.id },
        data: {
          status: 'revoked',
          rejectionReason: typeof reason === 'string' && reason.trim() ? reason.trim().slice(0, 500) : null,
        },
      });

      // Deactivate + unbind the device. Its tokens are now invalid (fail
      // closed) and it can no longer authenticate (claim is revoked).
      await tx.device.update({
        where: { id: claim.deviceId },
        data: { status: 'inactive', employeeId: null },
      });

      await tx.auditLog.create({
        data: {
          action: 'update',
          resource: 'device',
          description: `Zero-touch device "${claim.device.hostname || claim.device.name}" revoked${reason ? ` (${String(reason).slice(0, 200)})` : ''}`,
          resourceId: claim.deviceId,
          userId: admin.userId,
          ipAddress: clientIp,
          organizationId: admin.organizationId,
        },
      });

      return tx.deviceClaim.findUnique({ where: { id: claim.id }, include: { device: true } });
    });

    return NextResponse.json({ success: true, data: result });
  } catch (error) {
    console.error('DeviceClaim revoke error:', error);
    return NextResponse.json({ error: 'Failed to revoke device' }, { status: 500 });
  }
}
