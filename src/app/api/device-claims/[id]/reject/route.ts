'use server';
import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { authError, requireAdminOrg } from '@/lib/api';
import { checkRateLimit, RATE_LIMITS, getClientIpFromHeaders } from '@/lib/rate-limit';
import { log, requestContext } from '@/lib/logger';

// POST /api/device-claims/[id]/reject
// Reject a pending zero-touch device claim (admin-only, org-scoped).
// Rejected devices stay recorded for audit/history but can never
// authenticate, collect data, or receive an AgentToken.
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
    if (claim.status !== 'pending') {
      return NextResponse.json(
        { error: `Device claim is already "${claim.status}"` },
        { status: 400 }
      );
    }

    const result = await db.$transaction(async (tx) => {
      await tx.deviceClaim.update({
        where: { id: claim.id },
        data: {
          status: 'rejected',
          rejectedAt: new Date(),
          rejectionReason: typeof reason === 'string' && reason.trim() ? reason.trim().slice(0, 500) : null,
        },
      });

      // Keep the device recorded but deactivated — it must never become active.
      await tx.device.update({
        where: { id: claim.deviceId },
        data: { status: 'inactive', employeeId: null },
      });

      await tx.auditLog.create({
        data: {
          action: 'update',
          resource: 'device',
          description: `Zero-touch device "${claim.device.hostname || claim.device.name}" rejected${reason ? ` (${String(reason).slice(0, 200)})` : ''}`,
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
    log.error('api.device-claims.id.reject.', { error: String('DeviceClaim reject error:') }, requestContext(req));
    return NextResponse.json({ error: 'Failed to reject device' }, { status: 500 });
  }
}
