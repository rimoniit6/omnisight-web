import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';
import {
  generateClaimSecret,
  hashClaimSecret,
  ENROLLMENT_CODE_SETTING_KEY,
  verifyEnrollmentCode,
} from '@/lib/agent/auth';
import { validateAgentSession } from '@/lib/agent/session';
import { checkRateLimit, RATE_LIMITS, getClientIpFromHeaders } from '@/lib/rate-limit';
import { createOrgNotification } from '@/lib/notifications/service';

// POST /api/agent/discover
// Zero-touch bootstrap: a freshly installed agent silently identifies its
// device to the backend. The organization is derived SERVER-SIDE — NEVER from
// the client — through one of three EXPLICIT sources:
//   1. An authenticated AgentSession (Phase 3) → the session's organization.
//   2. An already-known device (idempotent re-discover) → the device's org.
//   3. A brand-new ANONYMOUS device → a per-organization enrollment code
//      (admin-issued, stored only as a hash) presented by the agent. There is
//      NO implicit "first organization" fallback: without a valid code the
//      device is simply not created (422, zero writes).
// Creates a pending DeviceClaim; idempotent for the same device identity (an
// existing device is reused, never duplicated on restart).
//
// CLAIM HISTORY (workload/62): a device keeps a full claim history. One
// PENDING claim exists at a time. Terminal claims are surfaced as-is during
// polling (so an admin rejection is never silently undone), while these paths
// issue a FRESH claim:
//   - pending claim expired (lifecycle timeout) → fresh claim + new secret
//   - latest claim CANCELLED (employee "Cancel registration") → fresh claim
//   - latest claim rejected AND the agent explicitly re-registers (reRegister
//     intent from the zero-touch flow after rejection) → fresh claim
// A REVOKED device NEVER re-registers automatically (fail closed — only an
// admin can change its fate).
//
// The claim secret is issued exactly once per claim. Discovery is separate
// from consent: a pending/approved claim grants nothing on its own.
//
// AUTHENTICATED EXISTING-DEVICE HARDENING (workload/67/68):
// For a valid AgentSession the session identity is the ONLY authority. An
// existing Device is only reachable when BOTH the device organization and the
// device employee match the session's server-derived identity (rules B/C).
// Any mismatch is indistinguishable from a missing device (404) — no ids,
// claim state, status, or ownership is ever disclosed. An unassigned device
// in the session's organization is bound to the session employee inside the
// device row lock (rule D). Revoked devices fail closed and are NEVER rebound.
// Anonymous zero-touch requests carry no identity and keep the legacy flow.

/** Sentinel thrown inside the locked transaction → mapped to a concealing 404. */
const DENIED = new Error('DEVICE_ACCESS_DENIED');

/**
 * Resolve the organization an anonymous new device may enroll into, from an
 * admin-issued enrollment code. Only SHA-256 hashes are stored and compared
 * (constant-time per candidate) — a wrong code never reveals whether an org
 * or code exists. Returns null when the code is absent, malformed, or matches
 * nothing (the caller decides the exact 4xx).
 */
async function resolveOrgFromEnrollmentCode(code: string | null): Promise<{ id: string } | null> {
  if (!code || code.length > 256) return null;
  const settings = await db.organizationSetting.findMany({
    where: { key: ENROLLMENT_CODE_SETTING_KEY },
    select: { organizationId: true, value: true },
  });
  for (const setting of settings) {
    if (verifyEnrollmentCode(code, setting.value)) {
      return db.organization.findUnique({
        where: { id: setting.organizationId },
        select: { id: true },
      });
    }
  }
  return null;
}

export async function POST(req: NextRequest) {
  try {
    // A malformed/non-JSON body is a client error (400) — never a 500. The
    // agent always sends JSON; anything else is a broken or hostile caller.
    let body: unknown;
    try {
      body = await req.json();
    } catch {
      return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
    }
    const { deviceKey, hostname, os, osVersion, processor, memory, agentVersion, arch, reRegister, enrollmentCode } = body as {
      deviceKey?: unknown;
      hostname?: unknown;
      os?: unknown;
      osVersion?: unknown;
      processor?: unknown;
      memory?: unknown;
      agentVersion?: unknown;
      arch?: unknown;
      reRegister?: unknown;
      enrollmentCode?: unknown;
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
    const rl = await checkRateLimit(
      `agent-discover:${clientIp}:${deviceKey.slice(0, 16)}`,
      RATE_LIMITS.agentDiscover.limit,
      RATE_LIMITS.agentDiscover.windowMs
    );
    if (!rl.allowed) {
      return NextResponse.json(
        { error: `Too many discovery attempts. Try again in ${rl.retryAfterSeconds} seconds.` },
        { status: 429 }
      );
    }

    // ── AUTHENTICATED DISCOVERY (Phase 3) ──────────────────────────────────
    // If the request carries a valid AgentSession (issued by POST
    // /api/agent/login), derive the employee and organization from the
    // authenticated session — never from client input. This is the PATH C
    // flow: Agent login → discover device → PENDING claim.
    //
    // If no (valid) session is present, fall back to the anonymous zero-touch
    // flow (device-bound claim secret). A device-bound AgentToken is NOT
    // required here — the session powers ONLY discover; heartbeat/activity/
    // screenshot still require a device-bound token after admin approval.
    const authResult = await validateAgentSession(req);
    const authenticatedEmployee = authResult.valid ? authResult.employee! : null;

    // Idempotent: reuse an existing Device for this identity — the device is
    // NEVER recreated on restart.
    const device = await db.device.findFirst({ where: { agentKey: deviceKey } });

    // ── ORGANIZATION RESOLUTION (server-derived, explicit only) ────────────
    // Never the client: no organizationId in the body/query is ever accepted.
    // 1) Authenticated session → the session's org (Phase 3 login flow).
    // 2) Known device → its existing org (re-discover of an enrolled device).
    // 3) NEW anonymous device → a valid admin-issued enrollment code. Without
    //    one the server CANNOT determine a tenant, so nothing is created.
    let org: { id: string } | null = null;
    if (authenticatedEmployee) {
      org = await db.organization.findUnique({ where: { id: authenticatedEmployee.organizationId } });
    } else if (device) {
      org = await db.organization.findUnique({ where: { id: device.organizationId } });
    } else {
      org = await resolveOrgFromEnrollmentCode(
        typeof enrollmentCode === 'string' && enrollmentCode.length > 0 ? enrollmentCode : null
      );
      if (!org) {
        const missing = enrollmentCode === undefined || enrollmentCode === null || enrollmentCode === '';
        return NextResponse.json(
          {
            error: missing
              ? 'Device registration requires an organization enrollment code (issued by your administrator) or an employee sign-in.'
              : 'Invalid enrollment code.',
          },
          { status: 422 }
        );
      }
    }

    if (!org) {
      return NextResponse.json(
        { error: 'No organization is configured on this server' },
        { status: 503 }
      );
    }

    if (!device) {
      // First sight: create the pending Device + claim atomically.
      // If the discover is authenticated (Phase 3 Agent login flow), link the
      // device to the employee immediately. Otherwise leave it unlinked for
      // the admin to assign during approval (anonymous zero-touch flow).
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
              : `Zero-touch device discovered: "${hostname}" (${typeof os === 'string' ? os : 'Unknown OS'}) awaiting admin approval`,
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
      // The AgentSession is the ONLY identity authority. A client-supplied
      // deviceKey (or any body field) can never override session identity: a
      // device owned by another organization or another employee is
      // indistinguishable from a non-existent device (uniform 404 — nothing
      // leaks: no ids, no status, no claim state, no ownership).
      if (authenticatedEmployee) {
        // Rule C — different organization: deny before any state is read.
        if (locked.organizationId !== authenticatedEmployee.organizationId) {
          throw DENIED;
        }
        // Rule B — same org, different employee: deny; never reassign.
        if (locked.employeeId !== null && locked.employeeId !== authenticatedEmployee.id) {
          throw DENIED;
        }
        // Revoked devices fail closed and are NEVER rebound: admin revocation
        // unassigns the device (employeeId → null), so the unassigned-device
        // bind below must not silently resurrect it.
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

      // 1) Approved → device is usable; return state (no new secret). A working
      //    agent holds its one-time secret locally and NEVER re-registers. An
      //    agent that explicitly re-registers (reRegister — fresh install or
      //    lost/never-stored claim secret) falls through to a FRESH pending
      //    claim below: the one-time secret is issued exactly once and can
      //    never be re-issued for an approved claim.
      //
      //    The fall-through is gated on the device holding NO valid AgentToken:
      //    a live token proves the device is working, so replaying reRegister
      //    (possible by anyone who holds the client-supplied agentKey) must
      //    never kill its credential or force an admin re-approval. Genuine
      //    credential loss still recovers — either immediately (no token) or
      //    once the 24h token expires (wiped userData within the token's life).
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
      // 2) Active pending (not expired) → idempotent; no new secret. Even with
      //    reRegister intent, an unexpired pending claim is returned as-is
      //    (avoids duplicate pending claims from racing retries).
      if (latest && latest.status === 'pending' && (!latest.expiresAt || latest.expiresAt > now)) {
        return { kind: 'pending' as const, claim: latest, device: locked };
      }
      // 3) Revoked → terminal, fail closed. A revoked device must NOT silently
      //    re-register (even with reRegister intent); only an admin can change
      //    its fate.
      if (latest && latest.status === 'revoked') {
        return { kind: 'revoked' as const, claim: latest, device: locked };
      }
      // 4) Rejected while merely polling → surface the rejection so the agent
      //    transitions to the REJECTED state and stops polling. A rejected
      //    device re-registers ONLY on an explicit reRegister request.
      if (latest && latest.status === 'rejected' && !wantsFreshClaim) {
        return { kind: 'rejected' as const, claim: latest, device: locked };
      }
      // 5) Pending but expired → close it, then issue a FRESH claim.
      //    Cancelled (employee cancel → re-request) → FRESH claim.
      //    Rejected + explicit reRegister → FRESH claim.
      //    Approved + explicit reRegister (fresh install / lost credential) →
      //    FRESH claim. The old approved claim is closed ('expired') so its
      //    one-time secret can no longer authenticate; the new secret requires
      //    a fresh admin approval — the secure credential-recovery path.
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
            description: `Zero-touch device "${hostname}" re-registered after employee cancellation (new pending claim ${claim.id})`,
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
            description: `Zero-touch device "${hostname}" re-registered after rejection (new pending claim ${claim.id})`,
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
            description: `Zero-touch device "${hostname}" re-registered after expiry (new pending claim ${claim.id})`,
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
    // Authorization denial inside the locked transaction — uniform concealing
    // 404. Same shape for cross-org, cross-employee, and deleted devices.
    if (error === DENIED) {
      return NextResponse.json({ error: 'Device not found' }, { status: 404 });
    }
    console.error('Agent discover error:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
