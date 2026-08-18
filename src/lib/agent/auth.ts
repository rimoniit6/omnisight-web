import { createHash, randomBytes } from 'crypto';
import { db } from '@/lib/db';
import { hashPassword, verifyPassword } from '@/lib/auth';
import { getClientIpFromHeaders } from '@/lib/rate-limit';
import { log } from '@/lib/logger';
import { verifyAgentCredential, toPublicAccount } from '@/lib/agent-account';

// ─── Device claim secrets (zero-touch discovery) ────────────────────────────
// The claim secret is a one-time credential issued at discovery; only its
// SHA-256 hash is ever stored server-side.

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

// ─── Organization enrollment codes (zero-touch device enrollment) ───────────
// An anonymous agent presents a per-organization enrollment code (issued by an
// org admin) at discovery so the server can bind the device to an EXPLICIT
// tenant. Only the SHA-256 hash is stored (OrganizationSetting
// 'agent_enrollment_code') — never the code itself. A missing or invalid code
// means the server simply cannot determine a tenant and the device is NOT
// created (no implicit "first organization" selection).

export const ENROLLMENT_CODE_SETTING_KEY = 'agent_enrollment_code';

export function hashEnrollmentCode(code: string): string {
  return createHash('sha256').update(`wl-enroll:${code}`).digest('hex');
}

/** Constant-time comparison of a candidate code against the stored hash. */
export function verifyEnrollmentCode(code: string, hash: string): boolean {
  const candidate = hashEnrollmentCode(code);
  if (candidate.length !== hash.length) return false;
  let diff = 0;
  for (let i = 0; i < candidate.length; i++) {
    diff |= candidate.charCodeAt(i) ^ hash.charCodeAt(i);
  }
  return diff === 0;
}

/** 24 cryptographically-random bytes (base64url) — returned exactly once at issue. */
export function generateEnrollmentCode(): string {
  return randomBytes(24).toString('base64url');
}

// Verify an agent password against the stored credential.
// Stored values are bcrypt hashes; legacy plaintext values are verified and
// automatically migrated to a bcrypt hash in place.
export async function verifyAgentPassword(
  employee: { id: string; agentPassword: string | null },
  password: string
): Promise<boolean> {
  if (!employee.agentPassword) return false;

  // bcrypt hashes always start with $2 (bcryptjs emits $2a/$2b/$2y)
  if (employee.agentPassword.startsWith('$2')) {
    return verifyPassword(password, employee.agentPassword);
  }

  // Legacy plaintext credential: verify, then upgrade to a bcrypt hash.
  if (employee.agentPassword === password) {
    const hashed = await hashPassword(password);
    await db.employee.update({
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
      include: {
        employee: {
          select: {
            id: true,
            employeeId: true,
            firstName: true,
            lastName: true,
            organizationId: true,
            status: true,
            agentApproved: true,
          },
        },
      },
    });

    if (!agentToken) {
      log.warn('agent.auth.invalid_token', { ip: getClientIp(req) });
      return { valid: false, error: 'Invalid token' };
    }

    if (new Date(agentToken.expiresAt) < new Date()) {
      // Clean up expired token
      await db.agentToken.delete({ where: { id: agentToken.id } });
      log.warn('agent.auth.expired_token', { employeeId: agentToken.employee.employeeId, ip: getClientIp(req) });
      return { valid: false, error: 'Token expired' };
    }

    if (!agentToken.employee.agentApproved) {
      log.warn('agent.auth.not_approved', { employeeId: agentToken.employee.employeeId, ip: getClientIp(req) });
      return { valid: false, error: 'Employee not approved by admin' };
    }

    if (agentToken.employee.status !== 'active') {
      log.warn('agent.auth.inactive', { employeeId: agentToken.employee.employeeId, ip: getClientIp(req) });
      return { valid: false, error: 'Employee is not active' };
    }

    // AgentAccount status check — a disabled AgentAccount must fail closed
    // even with a valid token (admin can disable an account mid-session).
    const agentAccount = await db.agentAccount.findUnique({
      where: { employeeId: agentToken.employee.id },
      select: { status: true },
    });
    if (agentAccount && agentAccount.status !== 'active') {
      log.warn('agent.auth.account_disabled', { employeeId: agentToken.employee.employeeId, ip: getClientIp(req) });
      return { valid: false, error: 'Agent account is disabled' };
    }

    // Device-bound token: the device itself must still be active. Deactivating
    // or revoking a device (status -> inactive) immediately invalidates its
    // tokens — fail closed without waiting for the 24h expiry. This is what
    // stops heartbeat/activity/screenshot for a revoked device.
    if (agentToken.deviceId) {
      const device = await db.device.findUnique({
        where: { id: agentToken.deviceId },
        select: { status: true },
      });
      if (!device || (device.status !== 'online' && device.status !== 'offline')) {
        log.warn('agent.auth.device_inactive', { employeeId: agentToken.employee.employeeId, ip: getClientIp(req) });
        return { valid: false, error: 'Device is not active' };
      }
    }

    // Update lastUsedAt
    await db.agentToken.update({
      where: { id: agentToken.id },
      data: { lastUsedAt: new Date() },
    });

    return {
      valid: true,
      employee: {
        id: agentToken.employee.id,
        employeeId: agentToken.employee.employeeId,
        firstName: agentToken.employee.firstName,
        lastName: agentToken.employee.lastName,
        organizationId: agentToken.employee.organizationId,
      },
      deviceId: agentToken.deviceId ?? undefined,
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
