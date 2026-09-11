import { createHash, randomBytes } from 'crypto';
import type { PrismaClient } from '@prisma/client';
import { db } from '@/lib/db';
import { getPrismaForOrg } from '@/lib/org-db';
import { hashPassword, verifyPassword } from '@/lib/auth';
import { getClientIpFromHeaders } from '@/lib/rate-limit';
import { log } from '@/lib/logger';
import { checkAgentEntitlement } from '@/lib/subscription';


// ─── Device claim secrets ─────────────────────────────────────────────────
// The claim secret is a one-time credential issued at device discovery; only
// its SHA-256 hash is ever stored server-side.

export function hashClaimSecret(secret: string): string {
  return createHash('sha256').update(`wl-claim:${secret}`).digest('hex');
}

/** Constant-time comparison of a candidate secret against the stored hash. */
export function verifyClaimSecret(secret: string, hash: string): boolean {
  const candidate = hashClaimSecret(secret);
  if (candidate.length !== hash.length) return false;
  let diff = 0;
  for (let i = 0; i < candidate.length; i++) {
    diff |= candidate.charCodeAt(i) ^ hash.charCodeAt(i);
  }
  return diff === 0;
}

/** 32 cryptographically-random bytes (base64url) — issued exactly once. */
export function generateClaimSecret(): string {
  return randomBytes(32).toString('base64url');
}

// Verify an agent password against the stored credential.
// Stored values are bcrypt hashes; legacy plaintext values are verified and
// automatically migrated to a bcrypt hash in place.
// `data` is the org data client (see validateAgentToken) — Employee is
// org-owned and COPYs to the org's own DB at activation, so the password
// upgrade must land where the org's rows are authoritative.
export async function verifyAgentPassword(
  employee: { id: string; agentPassword: string | null },
  password: string,
  data: PrismaClient = db
): Promise<boolean> {
  if (!employee.agentPassword) return false;

  // bcrypt hashes always start with $2 (bcryptjs emits $2a/$2b/$2y)
  if (employee.agentPassword.startsWith('$2')) {
    return verifyPassword(password, employee.agentPassword);
  }

  // Legacy plaintext credential: verify, then upgrade to a bcrypt hash.
  if (employee.agentPassword === password) {
    const hashed = await hashPassword(password);
    await data.employee.update({
      where: { id: employee.id },
      data: { agentPassword: hashed },
    });
    return true;
  }

  return false;
}

// Validates an agent bearer token and returns the employee + device info
// Used by all protected agent API routes
export async function validateAgentToken(req: Request): Promise<{
  valid: boolean;
  employee?: { id: string; employeeId: string; firstName: string; lastName: string; organizationId: string };
  deviceId?: string;
  /** Org data client for COPIED (org-owned) tables — see boundary note. */
  orgData?: PrismaClient;
  error?: string;
}> {
  try {
    const authHeader = req.headers.get('authorization');
    if (!authHeader?.startsWith('Bearer ')) {
      return { valid: false, error: 'Missing or invalid Authorization header' };
    }

    const token = authHeader.substring(7);
    if (!token || token.length < 20) {
      return { valid: false, error: 'Invalid token format' };
    }

    const agentToken = await db.agentToken.findUnique({
      where: { token },
      select: { id: true, employeeId: true, deviceId: true, organizationId: true, expiresAt: true },
    });

    if (!agentToken) {
      log.warn('agent.auth.invalid_token', { ip: getClientIp(req) });
      return { valid: false, error: 'Invalid token' };
    }

    if (new Date(agentToken.expiresAt) < new Date()) {
      // Clean up expired token (control plane — stays platform-side)
      await db.agentToken.delete({ where: { id: agentToken.id } });
      log.warn('agent.auth.expired_token', { employeeId: agentToken.employeeId.slice(0, 12), ip: getClientIp(req) });
      return { valid: false, error: 'Token expired' };
    }

    // ── ORG DATA BOUNDARY ─────────────────────────────────────────────────
    // AgentToken / AgentAccount / Organization stay PLATFORM-side (control
    // plane — deliberately never copied), but Employee and Device are org-owned
    // and COPY to the org's own database at activation. After a cutover the org
    // DB is their authoritative home, so every org-scoped read/write below (and
    // the caller's org-scoped writes) resolves through this client. For an org
    // that never opted in, `orgData === db` — unchanged behavior.
    const orgData = (await getPrismaForOrg(agentToken.organizationId)).client;

    const employee = await orgData.employee.findUnique({
      where: { id: agentToken.employeeId },
      select: {
        id: true,
        employeeId: true,
        firstName: true,
        lastName: true,
        organizationId: true,
        status: true,
        agentApproved: true,
      },
    });

    if (!employee) {
      log.warn('agent.auth.invalid_token', { ip: getClientIp(req) });
      return { valid: false, error: 'Invalid token' };
    }

    if (!employee.agentApproved) {
      log.warn('agent.auth.not_approved', { employeeId: employee.employeeId, ip: getClientIp(req) });
      return { valid: false, error: 'Employee not approved by admin' };
    }

    if (employee.status !== 'active') {
      log.warn('agent.auth.inactive', { employeeId: employee.employeeId, ip: getClientIp(req) });
      return { valid: false, error: 'Employee is not active' };
    }

    // AgentAccount status check — a disabled AgentAccount must fail closed
    // even with a valid token (admin can disable an account mid-session).
    const agentAccount = await db.agentAccount.findUnique({
      where: { employeeId: employee.id },
      select: { status: true },
    });
    if (agentAccount && agentAccount.status !== 'active') {
      log.warn('agent.auth.account_disabled', { employeeId: employee.employeeId, ip: getClientIp(req) });
      return { valid: false, error: 'Agent account is disabled' };
    }

    // Device-bound token: the device itself must still be active. Deactivating
    // or revoking a device (status -> inactive) immediately invalidates its
    // tokens — fail closed without waiting for the 24h expiry. This is what
    // stops heartbeat/activity/screenshot for a revoked device.
    if (agentToken.deviceId) {
      const device = await orgData.device.findUnique({
        where: { id: agentToken.deviceId },
        select: { status: true },
      });
      if (!device || (device.status !== 'online' && device.status !== 'offline')) {
        log.warn('agent.auth.device_inactive', { employeeId: employee.employeeId, ip: getClientIp(req) });
        return { valid: false, error: 'Device is not active' };
      }
    }

    // Organization pause check: a paused/archived org must not
    // allow agent operations. Fail closed.
    const org = await db.organization.findUnique({
      where: { id: employee.organizationId },
      select: { status: true },
    });
    if (!org || org.status !== 'active') {
      log.warn('agent.auth.org_not_active', { employeeId: employee.employeeId, ip: getClientIp(req) });
      return { valid: false, error: 'Organization is not active' };
    }

    // Cross-org integrity: verify the token's organization matches the employee's.
    // organizationId is NOT NULL (schema enforced) — always present.
    if (agentToken.organizationId !== employee.organizationId) {
      log.warn('agent.auth.org_mismatch', { employeeId: employee.employeeId, ip: getClientIp(req) });
      return { valid: false, error: 'Token organization mismatch' };
    }

    // ── Subscription entitlement enforcement (PRD §46) ───────────────────────
    // The server is authoritative for subscription state. The Agent must NOT
    // operate when the subscription is PAUSED, EXPIRED, CANCELLED, or PENDING.
    // Trial organizations are treated as having full access.
    const entitlement = await checkAgentEntitlement(employee.organizationId);
    if (!entitlement.allowed) {
      log.warn('agent.auth.subscription_denied', {
        employeeId: employee.employeeId,
        subscriptionStatus: entitlement.subscriptionStatus,
        reason: entitlement.reason,
        ip: getClientIp(req),
      });
      return { valid: false, error: entitlement.reason ?? 'Subscription not active' };
    }

    // Update lastUsedAt (control plane — stays platform-side)
    await db.agentToken.update({
      where: { id: agentToken.id },
      data: { lastUsedAt: new Date() },
    });

    return {
      valid: true,
      employee: {
        id: employee.id,
        employeeId: employee.employeeId,
        firstName: employee.firstName,
        lastName: employee.lastName,
        organizationId: employee.organizationId,
      },
      deviceId: agentToken.deviceId ?? undefined,
      orgData,
    };
  } catch (error) {
    log.error('agent.auth.error', { err: error, ip: getClientIp(req) });
    return { valid: false, error: 'Internal error' };
  }
}

// Generate a secure random token.
// ALWAYS cryptographically random (randomBytes) — there is no fallback to
// Math.random(), which would make agent tokens predictable if it ever ran.
export function generateToken(length: number = 64): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  const bytes = randomBytes(length);
  return Array.from(bytes, (byte) => chars[byte % chars.length]).join('');
}

// Helper to get client IP from request.
// Delegates to the shared spoof-resistant resolver (rightmost x-forwarded-for
// entry — a trusted proxy appends the real IP last — then x-real-ip, then
// cf-connecting-ip) so audit/device IPs can never diverge from the rate
// limiter's convention. Never trust the leftmost entry for audit purposes.
export function getClientIp(req: Request): string {
  return getClientIpFromHeaders(req.headers);
}
