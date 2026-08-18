// OmniSight — Server-authoritative web sessions (S-04).
//
// Web authentication historically used a pure stateless JWT (default 7d): the
// token stayed cryptographically valid until expiry even after logout, so a
// stolen admin JWT could not be revoked server-side. This module adds one
// UserSession row per successful login; the JWT carries `sessionId` and every
// authenticated request re-validates the row, giving the system:
//
//   - normal logout        → revoke the session row
//   - force logout all     → revoke all rows for the user (or an admin for
//                            another user)
//   - account disable      → sessions revoked at disable time; `/me` also
//                            checks isActive
//   - password change      → all OTHER sessions revoked (current survives)
//   - session expiration   → the row expires in lockstep with the JWT
//   - revoked-token reject → isWebSessionActive() fails closed on missing,
//                            revoked, expired, or unreadable rows
//
// Backward compatibility: a signed JWT WITHOUT a sessionId claim (minted
// before this feature) is still accepted until its natural expiry — the server
// never mints such tokens going forward, so the residual window is bounded by
// JWT_EXPIRES_IN.

import { db } from '@/lib/db';
import { verifyJWT, type JWTPayload } from '@/lib/auth';

/** Default web-session lifetime — kept in lockstep with the default JWT. */
export const WEB_SESSION_LIFETIME_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Sanitize a User-Agent for storage: strip control characters (no log/DB
 * injection through a header) and bound the length (200 chars is plenty of
 * forensics context — never store an unbounded client string).
 */
export function sanitizeUserAgent(ua: string | null | undefined): string | null {
  if (!ua) return null;
  const cleaned = ua.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 200);
  return cleaned || null;
}

/** Read the raw User-Agent header from a request, sanitized. */
export function getUserAgent(req: Request): string | null {
  return sanitizeUserAgent(req.headers.get('user-agent'));
}

/**
 * Create a session row for a successful web login. Returns the session id the
 * JWT must carry.
 */
export async function createUserSession(input: {
  userId: string;
  organizationId?: string | null;
  ipAddress?: string | null;
  userAgent?: string | null;
  expiresAt?: Date;
}): Promise<{ id: string }> {
  const session = await db.userSession.create({
    data: {
      userId: input.userId,
      organizationId: input.organizationId ?? null,
      ipAddress: input.ipAddress ?? null,
      userAgent: sanitizeUserAgent(input.userAgent ?? null),
      expiresAt: input.expiresAt ?? new Date(Date.now() + WEB_SESSION_LIFETIME_MS),
      lastSeenAt: new Date(),
    },
    select: { id: true },
  });
  return { id: session.id };
}

/**
 * True when the session row exists, is not revoked, and has not expired.
 * FAILS CLOSED on any store error: an unavailable DB must never silently keep
 * a possibly-revoked session alive.
 */
export async function isWebSessionActive(sessionId: string, now = Date.now()): Promise<boolean> {
  try {
    const session = await db.userSession.findUnique({
      where: { id: sessionId },
      select: { revokedAt: true, expiresAt: true },
    });
    if (!session) return false;
    if (session.revokedAt !== null) return false;
    return session.expiresAt.getTime() >= now;
  } catch {
    return false;
  }
}

/**
 * Verify a web JWT and its server-side session. Tokens without a sessionId
 * claim are accepted (legacy stateless tokens); tokens WITH one are rejected
 * when the row is missing, revoked, or expired.
 */
export async function verifySessionToken(token: string): Promise<JWTPayload | null> {
  const payload = await verifyJWT(token);
  if (!payload) return null;
  if (!payload.sessionId) return payload;
  const active = await isWebSessionActive(payload.sessionId);
  return active ? payload : null;
}

/** Revoke a single session (idempotent — no-op when already revoked). */
export async function revokeSession(sessionId: string): Promise<void> {
  await db.userSession.updateMany({
    where: { id: sessionId, revokedAt: null },
    data: { revokedAt: new Date() },
  });
}

/**
 * Revoke every session for a user, optionally keeping one (e.g. the session
 * that just changed its own password). Returns the number revoked.
 */
export async function revokeAllUserSessions(
  userId: string,
  opts: { exceptSessionId?: string } = {}
): Promise<number> {
  const result = await db.userSession.updateMany({
    where: {
      userId,
      revokedAt: null,
      ...(opts.exceptSessionId ? { id: { not: opts.exceptSessionId } } : {}),
    },
    data: { revokedAt: new Date() },
  });
  return result.count;
}

/** Sliding refresh: extend the session row in lockstep with a refreshed JWT. */
export async function extendSessionExpiry(sessionId: string, expiresAt: Date): Promise<void> {
  await db.userSession.updateMany({
    where: { id: sessionId, revokedAt: null },
    data: { expiresAt, lastSeenAt: new Date() },
  });
}
