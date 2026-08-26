import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { generateToken, verifyAgentPassword, verifyClaimSecret } from '@/lib/agent/auth';
import {
  acquireActiveSlot,
  ActiveDeviceConflictError,
  EmployeeNotEligibleError,
  DeviceNotEligibleError,
  isDeviceEligible,
} from '@/lib/agent/activation';
import { checkRateLimit, RATE_LIMITS, getClientIpFromHeaders } from '@/lib/rate-limit';
import { AGENT_ACCOUNT } from '@/lib/agent-account';
import { log, requestContext } from '@/lib/logger';

// POST /api/agent/authenticate
// Two authentication paths:
//   PATH A (zero-touch):  deviceId + deviceSecret — approved DeviceClaim credential
//   PATH B (legacy):      employeeId + password
// Both issue the same 24h AgentToken. The token is only ever returned to the
// agent; it never reaches the admin renderer.
//
// SINGLE-ACTIVE-DEVICE RULE (Phase 5): one employee may have many registered
// devices, but only one device may hold a valid active AgentToken. Activation
// is serialized through lib/agent/activation.ts (Employee FOR UPDATE + valid
// eligible AgentToken predicate). A second eligible device → HTTP 409
// ACTIVE_DEVICE_EXISTS with ZERO mutation — the existing device is never
// kicked. Same-device re-login replaces the device's own token.
export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const { employeeId, password, deviceId, deviceSecret, hostname, os, osVersion, processor, memory, macAddress, agentVersion } = body;

    // Spoof-resistant client IP — the brute-force rate limit is per real IP.
    const clientIp = getClientIpFromHeaders(req.headers);

    // Zero-touch path takes precedence when device credentials are supplied.
    // Must be `return await`: a bare `return` would let the 409 rejection
    // escape this try/catch and surface as a 500 instead of the documented
    // ACTIVE_DEVICE_EXISTS contract.
    if (deviceId && deviceSecret) {
      return await authenticateDevice({ req, clientIp, deviceId, deviceSecret, os, osVersion, agentVersion });
    }

    // ── PATH B — legacy employeeId + password ──────────────────────────────
    if (!employeeId || !password) {
      return NextResponse.json(
        { error: 'Missing required fields: employeeId+password or deviceId+deviceSecret' },
        { status: 400 }
      );
    }

    // Rate limit per IP — protects agent credentials from brute force
    const rl = await checkRateLimit(`agent-auth:${clientIp}`, RATE_LIMITS.agentAuthenticate.limit, RATE_LIMITS.agentAuthenticate.windowMs);
    if (!rl.allowed) {
      return NextResponse.json(
        { error: `Too many authentication attempts. Try again in ${rl.retryAfterSeconds} seconds.` },
        { status: 429 }
      );
    }

    const employee = await db.employee.findFirst({
      where: { employeeId },
    });

    // Uniform 401 for every credential failure — an unknown employeeId must be
    // indistinguishable from a wrong password (no account enumeration).
    if (!employee) {
      return NextResponse.json({ error: 'Invalid credentials' }, { status: 401 });
    }

    // Per-employee brute-force lockout (S-03): 5 failed attempts → 15-minute
    // lockout, keyed by EMPLOYEE identity (not IP) so rotating IPs cannot
    // bypass it. The response stays the uniform 401 — a locked account is
    // indistinguishable from a wrong password (no oracle, no enumeration).
    if (employee.lockedUntil && employee.lockedUntil.getTime() > Date.now()) {
      return NextResponse.json({ error: 'Invalid credentials' }, { status: 401 });
    }

    // Verify password (bcrypt with legacy plaintext migration)
    const validPassword = await verifyAgentPassword(employee, password);
    if (!validPassword) {
      // Record the failed attempt on the employee row. The counter is updated
      // even when the employee is not yet approved — credential-guessing
      // attempts are tracked regardless of downstream approval state.
      const failedLoginCount = (employee.failedLoginCount ?? 0) + 1;
      const lockedUntil =
        failedLoginCount >= AGENT_ACCOUNT.MAX_FAILED_LOGINS
          ? new Date(Date.now() + AGENT_ACCOUNT.LOCKOUT_MS)
          : null;
      await db.employee.update({
        where: { id: employee.id },
        data: { failedLoginCount, lockedUntil },
      });
      return NextResponse.json({ error: 'Invalid credentials' }, { status: 401 });
    }

    // Success: clear the failure counter so a legitimate login resets the
    // account's lockout state.
    if (employee.failedLoginCount !== 0 || employee.lockedUntil !== null) {
      await db.employee.update({
        where: { id: employee.id },
        data: { failedLoginCount: 0, lockedUntil: null },
      });
    }

    // Check if approved
    if (!employee.agentApproved) {
      // Check if there's a pending registration
      const pendingReg = await db.agentRegistration.findUnique({
        where: { employeeId: employee.id },
      });
      if (pendingReg && pendingReg.status === 'pending') {
        return NextResponse.json({
          error: 'Registration pending admin approval',
          status: 'pending',
          registrationId: pendingReg.id,
        }, { status: 403 });
      }
      if (pendingReg && pendingReg.status === 'rejected') {
        return NextResponse.json({
          error: `Registration rejected: ${pendingReg.rejectionReason || 'Contact administrator'}`,
          status: 'rejected',
        }, { status: 403 });
      }
      return NextResponse.json({ error: 'Not registered. Use /api/agent/register first.' }, { status: 403 });
    }

    // Check if employee is active
    if (employee.status !== 'active') {
      return NextResponse.json({ error: 'Employee is not active' }, { status: 403 });
    }

    // Pre-check AgentAccount + Organization status (fast fail; the locked
    // transaction re-checks both to close disable races).
    // CRITICAL-01: an ABSENT AgentAccount is NOT a failure for the legacy
    // employeeId+password path (legacy/zero-touch onboarding never creates
    // one). Only a present-but-disabled account fails closed — the same
    // semantics as validateAgentToken()/validateAgentSession().
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

    // All writes below run atomically — a failure mid-way rolls back so no
    // stale tokens, orphan devices, or inconsistent state can persist.
    // Activation is serialized via the shared authority: Employee FOR UPDATE
    // → valid-token predicate → 409 on another device, replace on same device.
    const { device, token, expiresAt } = await db.$transaction(async (tx) => {
      const { device: dev } = await acquireActiveSlot(tx, {
        employeeId: employee.id,
        resolveDevice: async (tx) => {
          // Legacy hostname-based device resolution, inside the tx so a 409
          // rollback leaves no device row behind.
          let dev = await tx.device.findFirst({
            where: { employeeId: employee.id, hostname },
          });
          if (!dev) {
            dev = await tx.device.create({
              data: {
                name: hostname,
                hostname,
                operatingSystem: os || null,
                osVersion: osVersion || null,
                processor: processor || null,
                memory: memory || null,
                ipAddress: clientIp,
                macAddress: macAddress || null,
                agentVersion: agentVersion || null,
                status: 'online',
                lastHeartbeat: new Date(),
                organizationId: employee.organizationId,
                employeeId: employee.id,
              },
            });
          }
          return {
            id: dev.id,
            status: dev.status,
            employeeId: dev.employeeId,
            organizationId: dev.organizationId,
          };
        },
      });

      // Refresh connection metadata on the (now authorized) device. The
      // ResolvedDevice is deliberately narrow (id/status/ownership only), so
      // re-read the full row under the tx for the metadata fields.
      const full = await tx.device.findUniqueOrThrow({ where: { id: dev.id } });
      const updated = await tx.device.update({
        where: { id: dev.id },
        data: {
          operatingSystem: os || full.operatingSystem,
          osVersion: osVersion || full.osVersion,
          processor: processor || full.processor,
          memory: memory || full.memory,
          ipAddress: clientIp,
          macAddress: macAddress || full.macAddress,
          agentVersion: agentVersion || full.agentVersion,
          status: 'online',
          lastHeartbeat: new Date(),
        },
      });

      // Generate token (24 hours expiry)
      const token = generateToken(64);
      const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000);

      await tx.agentToken.create({
        data: {
          token,
          employeeId: employee.id,
          deviceId: dev.id,
          ipAddress: clientIp,
          userAgent: agentVersion ? `WorkLensAgent/${agentVersion}` : null,
          expiresAt,
        },
      });

      // Clean up the registration
      const existingReg = await tx.agentRegistration.findUnique({
        where: { employeeId: employee.id },
      });
      if (existingReg) {
        await tx.agentRegistration.update({
          where: { id: existingReg.id },
          data: { status: 'approved' },
        });
      }

      // Audit log
      await tx.auditLog.create({
        data: {
          action: 'login',
          resource: 'device',
          description: `Agent authenticated: ${employee.firstName} ${employee.lastName} on device "${hostname}"`,
          resourceId: dev.id,
          userId: employee.id,
          ipAddress: clientIp,
          organizationId: employee.organizationId,
        },
      });

      return { device: updated, token, expiresAt };
    });

    return NextResponse.json({
      success: true,
      token,
      expiresAt: expiresAt.toISOString(),
      deviceId: device.id,
      employeeId: employee.employeeId,
      name: `${employee.firstName} ${employee.lastName}`,
      message: 'Authenticated successfully. Use this token in Authorization: Bearer header.',
    });
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
