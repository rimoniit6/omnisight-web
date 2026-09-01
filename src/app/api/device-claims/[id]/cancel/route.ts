'use server';
import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { verifyClaimSecret } from '@/lib/agent/auth';
import { checkRateLimit, RATE_LIMITS, getClientIpFromHeaders } from '@/lib/rate-limit';
import { log, requestContext } from '@/lib/logger';

// POST /api/device-claims/[id]/cancel
//
// Employee-initiated cancellation of a PENDING device registration — the
// ONLY employee-side control in the zero-control agent. Semantics:
//
//   - Authenticated with the device's own claim secret (the one-time
//     credential issued at discovery). An arbitrary employee/device can never
//     cancel someone else's claim — possession of the secret for THIS device
//     is required, and the deviceKey must match the claim's device.
//   - PENDING → CANCELLED (auditable state transition; the claim row is NEVER
//     deleted — history is preserved with cancelledAt + cancellationReason).
//   - Already CANCELLED → idempotent success (200).
//   - APPROVED / REJECTED / REVOKED / EXPIRED → 409 conflict (never silently
//     cancel an approved active device).
//
// After cancellation the agent automatically issues a NEW discovery, which
// creates a FRESH pending claim (see /api/agent/discover).
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const body = await req.json();
    const { deviceKey, secret } = body as { deviceKey?: unknown; secret?: unknown };

    if (typeof deviceKey !== 'string' || deviceKey.length === 0) {
      return NextResponse.json({ error: 'Missing deviceKey' }, { status: 400 });
    }
    if (typeof secret !== 'string' || secret.length === 0) {
      return NextResponse.json({ error: 'Missing claim secret' }, { status: 400 });
    }

    const clientIp = getClientIpFromHeaders(req.headers);
    const rl = await checkRateLimit(
      `agent-claim-cancel:${clientIp}:${deviceKey.slice(0, 16)}`,
      RATE_LIMITS.agentDiscover.limit,
      RATE_LIMITS.agentDiscover.windowMs
    );
    if (!rl.allowed) {
      return NextResponse.json(
        { error: `Too many attempts. Try again in ${rl.retryAfterSeconds} seconds.` },
        { status: 429 }
      );
    }

    const claim = await db.deviceClaim.findUnique({
      where: { id },
      include: { device: true },
    });
    // Claim id + deviceKey are both required — a wrong id is indistinguishable
    // from a missing one (404 concealment, same policy as approve/reject).
    if (!claim || claim.device.agentKey !== deviceKey) {
      return NextResponse.json({ error: 'Device claim not found' }, { status: 404 });
    }

    // Constant-time claim-secret verification: only the device that received
    // the one-time secret can cancel ITS OWN pending registration.
    if (!verifyClaimSecret(secret, claim.claimSecretHash)) {
      return NextResponse.json({ error: 'Invalid claim secret' }, { status: 401 });
    }

    // Idempotent: already cancelled by this device → success without re-mutating.
    if (claim.status === 'cancelled') {
      return NextResponse.json({
        success: true,
        data: {
          id: claim.id,
          status: 'cancelled',
          cancelledAt: claim.cancelledAt,
          cancellationReason: claim.cancellationReason,
        },
      });
    }

    if (claim.status !== 'pending') {
      return NextResponse.json(
        { error: `Only pending registrations can be cancelled (current: "${claim.status}")` },
        { status: 409 }
      );
    }

    const result = await db.$transaction(async (tx) => {
      // Guarded transition: if a concurrent approve/reject landed between the
      // pre-check and now, do NOT overwrite the newer state.
      const cancelled = await tx.deviceClaim.updateMany({
        where: { id: claim.id, status: 'pending' },
        data: {
          status: 'cancelled',
          cancelledAt: new Date(),
          cancellationReason: 'employee_agent',
          cancelledByDeviceId: claim.deviceId,
        },
      });
      if (cancelled.count !== 1) {
        throw new Error('CLAIM_NOT_PENDING_ANYMORE');
      }

      // The device stays inactive and unbound — it must never become active
      // from a cancelled registration.
      await tx.device.update({
        where: { id: claim.deviceId },
        data: { status: 'inactive', employeeId: null },
      });

      // Audit: cancellation is an auditable state transition (never a delete).
      await tx.auditLog.create({
        data: {
          action: 'update',
          resource: 'device',
          description: `Device "${claim.device.hostname || claim.device.name}" registration cancelled by the device (employee_agent)`,
          resourceId: claim.deviceId,
          ipAddress: clientIp,
          organizationId: claim.organizationId,
        },
      });

      return tx.deviceClaim.findUnique({ where: { id: claim.id } });
    });

    return NextResponse.json({ success: true, data: result });
  } catch (error) {
    if (error instanceof Error && error.message === 'CLAIM_NOT_PENDING_ANYMORE') {
      return NextResponse.json(
        { error: 'This registration is no longer pending. Refresh and try again.' },
        { status: 409 }
      );
    }
    log.error('api.device-claims.id.cancel.', { error: String('DeviceClaim cancel error:') }, requestContext(req));
    return NextResponse.json({ error: 'Failed to cancel device registration' }, { status: 500 });
  }
}
