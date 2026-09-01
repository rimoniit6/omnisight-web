import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';
import {
  generateClaimSecret,
  hashClaimSecret,
} from '@/lib/agent/auth';
import { validateAgentSession } from '@/lib/agent/session';
import { checkRateLimit, RATE_LIMITS, getClientIpFromHeaders } from '@/lib/rate-limit';
import { createOrgNotification } from '@/lib/notifications/service';
import { log } from '@/lib/logger';

// POST /api/agent/discover
// Device discovery: a freshly installed agent identifies its device to the
// backend. The organization is derived SERVER-SIDE — NEVER from the client —
// through one of two EXPLICIT sources:
//   1. An authenticated AgentSession (Phase 3) → the session's organization.
//   2. An already-known device (idempotent re-discover) → the device's org.
//
// Anonymous discovery has been removed. A brand-new
// device without an existing identity or a valid session cannot join an
// organization — the employee MUST authenticate first (Phase 3 login).
//
// Creates a pending DeviceClaim; idempotent for the same device identity (an
// existing device is reused, never duplicated on restart).
//
// CLAIM HISTORY: a device keeps a full claim history. One PENDING claim exists
// at a time. Terminal claims are surfaced as-is during polling (so an admin
// rejection is never silently undone), while these paths issue a FRESH claim:
//   - pending claim expired (lifecycle timeout) → fresh claim + new secret
//   - latest claim CANCELLED (employee "Cancel registration") → fresh claim
//   - latest claim rejected AND the agent explicitly re-registers (reRegister
//     intent after rejection) → fresh claim
// A REVOKED device NEVER re-registers automatically (fail closed — only an
// admin can change its fate).
//
// The claim secret is issued exactly once per claim. Discovery is separate
// from consent: a pending/approved claim grants nothing on its own.
//
// AUTHENTICATED EXISTING-DEVICE HARDENING:
// For a valid AgentSession the session identity is the ONLY authority. An
// existing Device is only reachable when BOTH the device organization and the
// device employee match the session's server-derived identity (rules B/C).
// Any mismatch is indistinguishable from a missing device (404) — no ids,
// claim state, status, or ownership is ever disclosed. An unassigned device
// in the session's organization is bound to the session employee inside the
// device row lock (rule D). Revoked devices fail closed and are NEVER rebound.

/** Sentinel thrown inside the locked transaction → mapped to a concealing 404. */
const DENIED = new Error('DEVICE_ACCESS_DENIED');

export async function POST(req: NextRequest) {
  const startTime = Date.now();
  const requestId = req.headers.get('x-vercel-id') || req.headers.get('x-request-id') || undefined;
  const ctx = { requestId };

  try {
    log.info('agent-discover.start', { ...ctx });

    // A malformed/non-JSON body is a client error (400) — never a 500. The
    // agent always sends JSON; anything else is a broken or hostile caller.
    let body: unknown;
    try {
      body = await req.json();
    } catch {
      return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
    }
    const { deviceKey, hostname, os, osVersion, processor, memory, agentVersion, arch, reRegister } = body as {
      deviceKey?: unknown;
      hostname?: unknown;
      os?: unknown;
      osVersion?: unknown;
      processor?: unknown;
      memory?: unknown;
      agentVersion?: unknown;
      arch?: unknown;
      reRegister?: unknown;
    };
    // Explicit re-registration intent: sent by the agent ONLY when it is
    // deliberately starting a NEW registration (post-cancel or post-rejection
    // recovery), never while merely polling an existing pending claim.
    const wantsFreshClaim = reRegister === true;

    if (typeof deviceKey !== 'string' || deviceKey.length < 16 || deviceKey.length > 128) {
      return NextResponse.json({ error: 'Missing or invalid deviceKey' }, { status: 400 });
    }
    if (typeof hostname !== 'string' || hostname.length === 0 || hostname.length > 128) {
      return NextResponse.json({ error: 'Missing or invalid hostname' }, { status: 400 });
    }

    // Spoof-resistant client IP (rightmost x-forwarded-for / x-real-ip) —
    // per-IP rate limiting that a rotating client-supplied header can't bypass.
    const clientIp = getClientIpFromHeaders(req.headers);

    log.info('agent-discover.rate-limit:start', { ...ctx });
    const rl = await checkRateLimit(
      `agent-discover:${clientIp}:${deviceKey.slice(0, 16)}`,
      RATE_LIMITS.agentDiscover.limit,
      RATE_LIMITS.agentDiscover.windowMs
    );
    if (!rl.allowed) {
      log.warn('agent-discover.rate-limit:denied', { ...ctx });
      const res = NextResponse.json(
        { error: `Too many discovery attempts. Try again in ${rl.retryAfterSeconds} seconds.` },
        { status: 429 }
      );
      // Standard Retry-After header (seconds) — same convention as proxy.ts
      // rateLimitResponse, so a standards-compliant client can honor it.
      res.headers.set('Retry-After', String(rl.retryAfterSeconds));
      return res;
    }
    log.info('agent-discover.rate-limit:success', { ...ctx });

    // ── AUTHENTICATED DISCOVERY (Phase 3) ──────────────────────────────────
    log.info('agent-discover.session:start', { ...ctx });
    const authResult = await validateAgentSession(req);
    const authenticatedEmployee = authResult.valid ? authResult.employee! : null;
    log.info('agent-discover.session:success', { authenticated: authResult.valid, ...ctx });

    // Idempotent: reuse an existing Device for this identity — the device is
    // NEVER recreated on restart.
    log.info('agent-discover.device-lookup:start', { ...ctx });
    const device = await db.device.findFirst({ where: { agentKey: deviceKey } });
    log.info('agent-discover.device-lookup:success', { deviceFound: !!device, ...ctx });

    // ── ORGANIZATION RESOLUTION (server-derived, explicit only) ────────────
    log.info('agent-discover.org-resolution:start', { ...ctx });
    let org: { id: string } | null = null;
    if (authenticatedEmployee) {
      org = await db.organization.findUnique({ where: { id: authenticatedEmployee.organizationId } });
    } else if (device) {
      org = await db.organization.findUnique({ where: { id: device.organizationId } });
    } else {
      // No session and no existing device — anonymous discovery is not supported.
      // The employee must authenticate first (Phase 3 login).
      log.info('agent-discover.org-resolution:no-identity', { ...ctx });
      return NextResponse.json(
        {
          error: 'Device registration requires an employee sign-in. Please authenticate first.',
          code: 'AUTHENTICATION_REQUIRED',
        },
        { status: 422 }
      );
    }

    if (!org) {
      log.warn('agent-discover.org-resolution:no-org', { ...ctx });
      return NextResponse.json(
        { error: 'No organization is configured on this server' },
        { status: 503 }
      );
    }

    log.info('agent-discover.org-resolution:success', { orgId: org.id, ...ctx });

    if (!device) {
      // First sight: create the pending Device + claim atomically.
      log.info('agent-discover.transaction:start', { flow: 'new-device', ...ctx });
      const created = await db.$transaction(async (tx) => {
        const dev = await tx.device.create({
          data: {
            name: hostname,
            hostname,
            operatingSystem: typeof os === 'string' ? os : null,
            osVersion: typeof osVersion === 'string' ? osVersion : null,
            processor: typeof processor === 'string' ? processor : null,
            memory: typeof memory === 'string' ? memory : null,
            agentVersion: typeof agentVersion === 'string' ? agentVersion : null,
            agentKey: deviceKey,
            status: 'inactive',
            organizationId: org.id,
            // Authenticated discover: bind to the employee immediately.
            employeeId: authenticatedEmployee?.id ?? null,
          },
        });
        const secret = generateClaimSecret();
        const claim = await tx.deviceClaim.create({
          data: {
            organizationId: org.id,
            deviceId: dev.id,
            claimSecretHash: hashClaimSecret(secret),
            status: 'pending',
            expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
          },
        });
        await tx.auditLog.create({
          data: {
            action: 'create',
            resource: 'device',
            resourceId: dev.id,
            description: authenticatedEmployee
              ? `Authenticated device discovered: "${hostname}" employee=${authenticatedEmployee.employeeId} (${typeof os === 'string' ? os : 'Unknown OS'}) awaiting admin approval`
              : `New device discovered: "${hostname}" (${typeof os === 'string' ? os : 'Unknown OS'}) awaiting admin approval`,
            ipAddress: clientIp,
            organizationId: org.id,
          },
        });
        await createOrgNotification(tx, {
          title: 'New Device Discovery',
          message: authenticatedEmployee
            ? `Employee "${authenticatedEmployee.employeeId}" registered device "${hostname}" and is awaiting approval.`
            : `A new device "${hostname}" was discovered and is awaiting approval.`,
          type: 'security',
          priority: 'high',
          status: 'unread',
          employeeId: authenticatedEmployee?.id ?? null,
          organizationId: org.id,
        });
        return { dev, claim, secret };
      });

      log.info('agent-discover.transaction:success', {
        flow: 'new-device',
        deviceId: created.dev.id,
        claimId: created.claim.id,
        durationMs: Date.now() - startTime,
        ...ctx,
      });

      return NextResponse.json(
        {
          success: true,
          deviceId: created.dev.id,
          claimId: created.claim.id,
          secret: created.secret, // issued exactly once, never re-issued
          status: 'pending',
          expiresAt: created.claim.expiresAt?.toISOString() ?? null,
        },
        { status: 201 }
      );
    }

    // Device already known. Serialize per-device so two racing discoveries can
    // never create duplicate PENDING claims (a real risk now that the deviceId
    // unique constraint is gone — the history model allows many claims).
    log.info('agent-discover.transaction:start', { flow: 'existing-device', ...ctx });
    const outcome = await db.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM "Device" WHERE id = ${device.id} FOR UPDATE`;

      // RE-READ under the lock: the pre-transaction row may be stale if a
      // concurrent request modified the device between our lookup and lock
      // acquisition. All authorization and state-machine decisions below use
      // this LOCKED row — never the stale pre-lock snapshot (TOCTOU guard).
      const locked = await tx.device.findUnique({ where: { id: device.id } });
      if (!locked) throw DENIED; // deleted concurrently → conceal as not-found

      // The most recent claim drives the lifecycle.
      const latest = await tx.deviceClaim.findFirst({
        where: { deviceId: locked.id },
        orderBy: { createdAt: 'desc' },
      });
      const now = new Date();

      // ── AUTHENTICATED AUTHORIZATION (rules B/C/D) ────────────────────────
      if (authenticatedEmployee) {
        // Rule C — different organization: deny before any state is read.
        if (locked.organizationId !== authenticatedEmployee.organizationId) {
          throw DENIED;
        }
        // Rule B — same org, different employee: deny; never reassign.
        if (locked.employeeId !== null && locked.employeeId !== authenticatedEmployee.id) {
          throw DENIED;
        }
        // Revoked devices fail closed and are NEVER rebound.
        if (latest && latest.status === 'revoked') {
          return { kind: 'revoked' as const, claim: latest, device: locked };
        }
        // Rule D — unassigned device in the session's org: bind it to the
        // authenticated employee transactionally inside the device row lock.
        if (locked.employeeId === null) {
          locked.employeeId = authenticatedEmployee.id;
          await tx.device.update({
            where: { id: locked.id },
            data: { employeeId: authenticatedEmployee.id },
          });
        }
      }

      // 1) Approved → device is usable; return state (no new secret).
      if (latest && latest.status === 'approved') {
        if (!wantsFreshClaim) {
          return { kind: 'approved' as const, claim: latest, device: locked };
        }
        const validToken = await tx.agentToken.findFirst({
          where: { deviceId: locked.id, expiresAt: { gt: now } },
          select: { id: true },
        });
        if (validToken) {
          return { kind: 'approved' as const, claim: latest, device: locked };
        }
        // No live token → credential-loss recovery: fall through to a FRESH claim.
      }
      // 2) Active pending (not expired) → idempotent; no new secret.
      if (latest && latest.status === 'pending' && (!latest.expiresAt || latest.expiresAt > now)) {
        return { kind: 'pending' as const, claim: latest, device: locked };
      }
      // 3) Revoked → terminal, fail closed.
      if (latest && latest.status === 'revoked') {
        return { kind: 'revoked' as const, claim: latest, device: locked };
      }
      // 4) Rejected while merely polling → surface the rejection.
      if (latest && latest.status === 'rejected' && !wantsFreshClaim) {
        return { kind: 'rejected' as const, claim: latest, device: locked };
      }
      // 5) Pending but expired / cancelled / rejected+reRegister / approved+reRegister → FRESH claim.
      if (latest && (latest.status === 'pending' || (latest.status === 'approved' && wantsFreshClaim))) {
        await tx.deviceClaim.update({
          where: { id: latest.id },
          data: { status: 'expired' },
        });
      }

      const secret = generateClaimSecret();
      const claim = await tx.deviceClaim.create({
        data: {
          organizationId: locked.organizationId,
          deviceId: locked.id,
          claimSecretHash: hashClaimSecret(secret),
          status: 'pending',
          expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
        },
      });

      // If a prior claim was employee-cancelled, note the re-request for audit.
      if (latest && latest.status === 'cancelled') {
        await tx.auditLog.create({
          data: {
            action: 'create',
            resource: 'device',
            resourceId: locked.id,
            description: `Device "${hostname}" re-registered after employee cancellation (new pending claim ${claim.id})`,
            ipAddress: clientIp,
            organizationId: locked.organizationId,
          },
        });
      } else if (latest && latest.status === 'rejected') {
        await tx.auditLog.create({
          data: {
            action: 'create',
            resource: 'device',
            resourceId: locked.id,
            description: `Device "${hostname}" re-registered after rejection (new pending claim ${claim.id})`,
            ipAddress: clientIp,
            organizationId: locked.organizationId,
          },
        });
      } else if (latest && latest.status === 'expired') {
        await tx.auditLog.create({
          data: {
            action: 'create',
            resource: 'device',
            resourceId: locked.id,
            description: `Device "${hostname}" re-registered after expiry (new pending claim ${claim.id})`,
            ipAddress: clientIp,
            organizationId: locked.organizationId,
          },
        });
      } else if (latest && latest.status === 'approved') {
        await tx.auditLog.create({
          data: {
            action: 'create',
            resource: 'device',
            resourceId: locked.id,
            description: `Approved device "${hostname}" re-registered after credential loss (new pending claim ${claim.id})`,
            ipAddress: clientIp,
            organizationId: locked.organizationId,
          },
        });
      }

      return { kind: 'fresh' as const, claim, secret, device: locked };
    });

    log.info('agent-discover.transaction:success', {
      flow: 'existing-device',
      outcome: outcome.kind,
      durationMs: Date.now() - startTime,
      ...ctx,
    });

    if (outcome.kind === 'approved') {
      return NextResponse.json({
        success: true,
        deviceId: outcome.device.id,
        claimId: outcome.claim.id,
        status: 'approved',
        employeeAssigned: outcome.device.employeeId !== null,
      });
    }
    if (outcome.kind === 'revoked') {
      return NextResponse.json({
        success: true,
        deviceId: outcome.device.id,
        claimId: outcome.claim.id,
        status: 'revoked',
        employeeAssigned: false,
      });
    }
    if (outcome.kind === 'rejected') {
      return NextResponse.json({
        success: true,
        deviceId: outcome.device.id,
        claimId: outcome.claim.id,
        status: 'rejected',
        employeeAssigned: false,
      });
    }
    if (outcome.kind === 'pending') {
      return NextResponse.json({
        success: true,
        deviceId: outcome.device.id,
        claimId: outcome.claim.id,
        status: 'pending',
        employeeAssigned: outcome.device.employeeId !== null,
      });
    }

    // fresh — new claim issued with a brand-new one-time secret.
    return NextResponse.json(
      {
        success: true,
        deviceId: outcome.device.id,
        claimId: outcome.claim.id,
        secret: outcome.secret,
        status: 'pending',
        expiresAt: outcome.claim.expiresAt?.toISOString() ?? null,
      },
      { status: 201 }
    );
  } catch (error) {
    const durationMs = Date.now() - startTime;
    // Authorization denial inside the locked transaction — uniform concealing
    // 404. Same shape for cross-org, cross-employee, and deleted devices.
    if (error === DENIED) {
      log.info('agent-discover.denied', { durationMs, ...ctx });
      return NextResponse.json({ error: 'Device not found' }, { status: 404 });
    }
    // Structured error logging: stage, error type, error message, Prisma code.
    // NEVER log: claim secrets, session tokens, authorization
    // headers, or any other sensitive information.
    const prismaCode =
      error && typeof error === 'object' && 'code' in error
        ? (error as { code: string }).code
        : undefined;
    log.error('agent-discover.error', {
      stage: 'unknown',
      errorName: error instanceof Error ? error.name : 'Unknown',
      errorMessage: error instanceof Error ? error.message : String(error),
      prismaCode,
      durationMs,
      ...ctx,
    });
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
