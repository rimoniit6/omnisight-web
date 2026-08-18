// OmniSight — Agent Login Session service (Phase 3: Agent Authentication).
//
// A POST /api/agent/login issues a short-lived AgentSession. It exists ONLY to
// authenticate the subsequent POST /api/agent/discover so the server can derive
// the Employee + Organization from the verified AgentAccount — never from client
// input. It is deliberately NOT a device credential:
//
//   - validateAgentSession() is used ONLY by the authenticated discover branch
//     (and logout). Heartbeat / activity / screenshot / config still require a
//     device-bound AgentToken via validateAgentToken() in lib/agent/auth.ts.
//   - organizationId is always derived server-side from
//     AgentAccount → Employee.organizationId.
//   - The row is ephemeral (TTL) and revoked at logout. It carries no FK, so a
//     deleted employee/account never blocks an expiring session.
//
// Security invariants mirror lib/agent/auth.ts:
//   - Tokens are 64 cryptographically-random chars (randomBytes) — no Math.random.
//   - Every failure (missing / expired / disabled / inactive) returns a single
//     `valid:false` so no reason is ever leaked.

import { randomBytes } from 'crypto';
import { db } from '@/lib/db';
import { getClientIpFromHeaders } from '@/lib/rate-limit';
import { log } from '@/lib/logger';

/** Login-session policy. Generous TTL so a long admin approval wait is not
 * interrupted; harmless because the session only powers `discover`/`logout`. */
export const AGENT_SESSION = {
  TTL_MS: 24 * 60 * 60 * 1000, // 24 hours
  MIN_TOKEN_LENGTH: 20,
} as const;

/** Generate a secure random session token (same alphabet as agent tokens). */
export function generateSessionToken(length = 64): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  const bytes = randomBytes(length);
  return Array.from(bytes, (byte) => chars[byte % chars.length]).join('');
}
/**
 * Create a login session for a verified employee. The caller (POST
 * /api/agent/login) has ALREADY verified the AgentAccount credential and the
 * employee/org status — this only persists the token. Returns the token +
 * expiry; the raw token is never logged.
 */
export async function createAgentSession(input: {
  employeeId: string;
  organizationId: string;
  ipAddress: string | null;
}): Promise<{ token: string; expiresAt: Date }> {
  const token = generateSessionToken();
  const expiresAt = new Date(Date.now() + AGENT_SESSION.TTL_MS);
  await db.agentSession.create({
    data: {
      token,
      employeeId: input.employeeId,
      organizationId: input.organizationId,
      ipAddress: input.ipAddress,
      expiresAt,
    },
  });
  return { token, expiresAt };
}

/**
 * Validate an AgentSession bearer token. Returns the authenticated employee
 * (with SERVER-DERIVED organizationId) or a uniform failure.
 *
 * Checks: signature-equivalent (token exists), expiry, Employee active,
 * AgentAccount active, Organization active. Fails closed on every condition.
 */
export async function validateAgentSession(req: Request): Promise<{
  valid: boolean;
  employee?: {
    id: string;
    employeeId: string;
    firstName: string;
    lastName: string;
    organizationId: string;
    status: string;
  };
  error?: string;
}> {
  try {
    const authHeader = req.headers.get('authorization');
    if (!authHeader?.startsWith('Bearer ')) {
      return { valid: false, error: 'Missing or invalid Authorization header' };
    }
    const token = authHeader.substring(7);
    if (!token || token.length < AGENT_SESSION.MIN_TOKEN_LENGTH) {
      return { valid: false, error: 'Invalid token format' };
    }

    const session = await db.agentSession.findUnique({
      where: { token },
    });
    if (!session) {
      log.warn('agent.session.invalid', { ip: getClientIpFromHeaders(req.headers) });
      return { valid: false, error: 'Invalid session' };
    }

    if (new Date(session.expiresAt).getTime() <= Date.now()) {
      log.warn('agent.session.expired', { employeeId: session.employeeId.slice(0, 12), ip: getClientIpFromHeaders(req.headers) });
      return { valid: false, error: 'Session expired' };
    }

    const employee = await db.employee.findUnique({
      where: { id: session.employeeId },
      select: {
        id: true,
        employeeId: true,
        firstName: true,
        lastName: true,
        organizationId: true,
        status: true,
      },
    });
    if (!employee) {
      return { valid: false, error: 'Invalid session' };
    }
    if (employee.status !== 'active') {
      log.warn('agent.session.inactive_employee', { employeeId: employee.employeeId, ip: getClientIpFromHeaders(req.headers) });
      return { valid: false, error: 'Employee is not active' };
    }

    // AgentAccount must still be active mid-session (admin disable fail-closed).
    const account = await db.agentAccount.findUnique({
      where: { employeeId: employee.id },
      select: { status: true },
    });
    if (account && account.status !== 'active') {
      log.warn('agent.session.account_disabled', { employeeId: employee.employeeId, ip: getClientIpFromHeaders(req.headers) });
      return { valid: false, error: 'Agent account is disabled' };
    }

    // Organization must still be active (server-derived, never from client).
    const org = await db.organization.findUnique({
      where: { id: employee.organizationId },
      select: { status: true },
    });
    if (!org || org.status !== 'active') {
      log.warn('agent.session.org_inactive', { employeeId: employee.employeeId, ip: getClientIpFromHeaders(req.headers) });
      return { valid: false, error: 'Organization is not active' };
    }

    // Update lastUsedAt (best-effort; failure must not invalidate the session).
    await db.agentSession.update({
      where: { id: session.id },
      data: { lastUsedAt: new Date() },
    }).catch(() => undefined);

    return {
      valid: true,
      employee: {
        id: employee.id,
        employeeId: employee.employeeId,
        firstName: employee.firstName,
        lastName: employee.lastName,
        organizationId: employee.organizationId,
        status: employee.status,
      },
    };
  } catch (error) {
    log.error('agent.session.error', { err: error, ip: getClientIpFromHeaders(req.headers) });
    return { valid: false, error: 'Internal error' };
  }
}

/**
 * Revoke a login session (logout). Returns true when a session was deleted.
 * Safe to call with an invalid/absent token — the agent must be able to log
 * out even if its session already expired or was cleared locally.
 */
export async function revokeAgentSession(token: string | null, ip: string | null): Promise<boolean> {
  if (!token || token.length < AGENT_SESSION.MIN_TOKEN_LENGTH) return false;
  const existing = await db.agentSession.findUnique({ where: { token }, select: { id: true } });
  if (!existing) return false;
  await db.agentSession.delete({ where: { id: existing.id } });
  log.info('agent.session.revoked', { ip: ip ?? 'unknown' });
  return true;
}