import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { generateToken, verifyClaimSecret } from '@/lib/agent/auth';
import {
  acquireActiveSlot,
  ActiveDeviceConflictError,
  EmployeeNotEligibleError,
  DeviceNotEligibleError,
  isDeviceEligible,
} from '@/lib/agent/activation';
import { checkRateLimit, RATE_LIMITS, getClientIpFromHeaders } from '@/lib/rate-limit';
import { log, requestContext } from '@/lib/logger';

// POST /api/agent/authenticate
// Zero-touch device credential authentication (deviceId + deviceSecret).
// Issues a 24h AgentToken. The token is only ever returned to the agent;
// it never reaches the admin renderer.
//
// SINGLE-ACTIVE-DEVICE RULE: one employee may have many registered devices,
// but only one device may hold a valid active AgentToken. Activation is
// serialized through lib/agent/activation.ts (Employee FOR UPDATE + valid
// eligible AgentToken predicate). A second eligible device → HTTP 409
// ACTIVE_DEVICE_EXISTS with ZERO mutation — the existing device is never
// kicked. Same-device re-login replaces the device's own token.
export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const { deviceId, deviceSecret, os, osVersion, agentVersion } = body;

    // Spoof-resistant client IP — the brute-force rate limit is per real IP.
    const clientIp = getClientIpFromHeaders(req.headers);

    if (!deviceId || !deviceSecret) {
      return NextResponse.json(
        { error: 'Missing required fields: deviceId + deviceSecret' },
        { status: 400 }
      );
    }

    return await authenticateDevice({ req, clientIp, deviceId, deviceSecret, os, osVersion, agentVersion });
  } catch (error) {
    // Another eligible device holds the employee's active slot. The
    // transaction already rolled back: no token created/deleted, no device
    // state changed, no audit row — the active device is never kicked.
    if (error instanceof ActiveDeviceConflictError) {
      return NextResponse.json({ error: 'ACTIVE_DEVICE_EXISTS' }, { status: 409 });
    }
    if (error instanceof EmployeeNotEligibleError || error instanceof DeviceNotEligibleError) {
      return NextResponse.json({ error: error.message }, { status: 403 });
    }
    log.error('api.agent.authenticate.', { error: String('Agent authenticate error:') }, requestContext(req));
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

/** PATH A — zero-touch device credential authentication. */
async function authenticateDevice(args: {
  req: NextRequest;
  clientIp: string;
  deviceId: string;
  deviceSecret: string;
  os?: unknown;
  osVersion?: unknown;
  agentVersion?: unknown;
}): Promise<NextResponse> {
  const { clientIp, deviceId, deviceSecret } = args;

  // Rate limit per IP — protects device credentials from brute force.
  const rl = await checkRateLimit(`agent-auth:${clientIp}`, RATE_LIMITS.agentAuthenticate.limit, RATE_LIMITS.agentAuthenticate.windowMs);
  if (!rl.allowed) {
    return NextResponse.json(
      { error: `Too many authentication attempts. Try again in ${rl.retryAfterSeconds} seconds.` },
      { status: 429 }
    );
  }    // Latest claim wins (claim-history model): after a credential-loss
    // recovery the old approved claim is closed ('expired') and a fresh claim
    // supersedes it — authentication must evaluate the NEWEST claim, not the
    // first row.
    const claim = await db.deviceClaim.findFirst({
      where: { deviceId },
      orderBy: { createdAt: 'desc' },
      include: { device: true },
    });

  // Unknown/other-tenant claim: conceal existence.
  if (!claim) {
    return NextResponse.json({ error: 'Device not found' }, { status: 404 });
  }

  // Only an APPROVED claim may authenticate. Pending/rejected/revoked fail
  // closed with a machine-readable status the agent surfaces to the employee.
  if (claim.status !== 'approved') {
    const message =
      claim.status === 'pending'
        ? 'Device is pending administrator approval'
        : claim.status === 'rejected'
          ? 'Device registration was not approved. Contact your administrator.'
          : 'Device access has been revoked. Contact your administrator.';
    return NextResponse.json({ error: message, status: claim.status }, { status: 403 });
  }

  if (!verifyClaimSecret(deviceSecret, claim.claimSecretHash)) {
    return NextResponse.json({ error: 'Invalid device secret' }, { status: 401 });
  }

  const device = claim.device;
  if (!device.employeeId) {
    return NextResponse.json({ error: 'Device is not assigned to an employee' }, { status: 403 });
  }

  const employee = await db.employee.findUnique({ where: { id: device.employeeId } });
  if (!employee || employee.status !== 'active') {
    return NextResponse.json({ error: 'Employee is not active' }, { status: 403 });
  }
  if (!employee.agentApproved) {
    return NextResponse.json({ error: 'Employee not approved by admin' }, { status: 403 });
  }
  // Guest fail-closed: a guest-owned device may only authenticate while its
  // Guest enrollment is ACTIVE. Suspended/revoked guests are rejected even if
  // the employee row were somehow left active (defense in depth — suspend and
  // revoke also set employee.status = 'inactive').
  if (employee.type === 'guest') {
    const guest = await db.guest.findFirst({
      where: { deviceId, employeeId: employee.id },
      select: { status: true },
    });
    if (!guest || guest.status !== 'ACTIVE') {
      return NextResponse.json({ error: 'Guest access is not active' }, { status: 403 });
    }
  }

  // Pre-check AgentAccount + Organization + Device status (fast fail; the
  // locked transaction re-checks all three to close disable/revoke races).
  // CRITICAL-01: an ABSENT AgentAccount is NOT a failure for zero-touch PATH
  // A (approved devices never create one). Only a present-but-disabled
  // account fails closed — matching validateAgentToken()/validateAgentSession().
  const account = await db.agentAccount.findUnique({
    where: { employeeId: employee.id },
    select: { status: true },
  });
  if (account && account.status !== 'active') {
    return NextResponse.json({ error: 'Agent account is disabled' }, { status: 403 });
  }
  const org = await db.organization.findUnique({
    where: { id: employee.organizationId },
    select: { status: true },
  });
  if (!org || org.status !== 'active') {
    return NextResponse.json({ error: 'Organization is not active' }, { status: 403 });
  }
  if (!isDeviceEligible(device.status)) {
    return NextResponse.json({ error: 'Device is not active' }, { status: 403 });
  }

  // Same transactional rules as PATH B: one active device per employee, one
  // token per employee, 24h expiry — serialized by the shared activation
  // authority (Employee FOR UPDATE → valid-token predicate → 409 / replace).
  const { device: dev, token, expiresAt } = await db.$transaction(async (tx) => {
    await acquireActiveSlot(tx, {
      employeeId: employee.id,
      resolveDevice: async (tx) => {
        const d = await tx.device.findUnique({ where: { id: claim.deviceId } });
        if (!d) throw new DeviceNotEligibleError('Device is not active');
        return {
          id: d.id,
          status: d.status,
          employeeId: d.employeeId,
          organizationId: d.organizationId,
        };
      },
    });

    await tx.device.update({
      where: { id: device.id },
      data: {
        status: 'online',
        lastHeartbeat: new Date(),
        ipAddress: clientIp,
        operatingSystem: typeof args.os === 'string' ? args.os : device.operatingSystem,
        osVersion: typeof args.osVersion === 'string' ? args.osVersion : device.osVersion,
        agentVersion: typeof args.agentVersion === 'string' ? args.agentVersion : device.agentVersion,
      },
    });

    const token = generateToken(64);
    const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000);
    await tx.agentToken.create({
      data: {
        token,
        employeeId: employee.id,
        organizationId: employee.organizationId,
        deviceId: device.id,
        ipAddress: clientIp,
        userAgent: typeof args.agentVersion === 'string' ? `WorkLensAgent/${args.agentVersion}` : null,
        expiresAt,
      },
    });

    await tx.auditLog.create({
      data: {
        action: 'login',
        resource: 'device',
        description: `Agent authenticated (zero-touch): ${employee.firstName} ${employee.lastName} on device "${device.hostname || device.name}"`,
        resourceId: device.id,
        userId: employee.id,
        ipAddress: clientIp,
        organizationId: employee.organizationId,
      },
    });

    return { device, token, expiresAt };
  });

  return NextResponse.json({
    success: true,
    token,
    expiresAt: expiresAt.toISOString(),
    deviceId: dev.id,
    employeeId: employee.employeeId,
    name: `${employee.firstName} ${employee.lastName}`,
    message: 'Authenticated successfully. Use this token in Authorization: Bearer header.',
  });
}
