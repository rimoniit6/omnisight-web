import { NextRequest, NextResponse } from 'next/server';
import { verifyJWT, getRequestToken, clearSessionCookie } from '@/lib/auth';
import { db } from '@/lib/db';
import { revokeSession, getUserAgent } from '@/lib/session';
import { log, requestContext } from '@/lib/logger';

export async function POST(req: NextRequest) {
  try {
    const token = getRequestToken(req);
    if (!token) {
      // Still clear the cookie so a stale session can't linger
      return clearSessionCookie(
        NextResponse.json({ message: 'Logged out' }, { status: 401 })
      );
    }

    const payload = await verifyJWT(token);
    if (!payload) {
      return clearSessionCookie(
        NextResponse.json(
          { error: 'Invalid or expired token' },
          { status: 401 }
        )
      );
    }

    // Server-authoritative revocation (S-04): kill the session row so the
    // already-issued JWT stops working immediately — not merely "cookie
    // cleared". Idempotent (a second logout is a no-op).
    if (payload.sessionId) {
      await revokeSession(payload.sessionId);
    }

    // Create audit log (S-08: capture the sanitized User-Agent for forensics).
    await db.auditLog.create({
      data: {
        action: 'logout',
        resource: 'auth',
        resourceId: payload.userId,
        description: `User ${payload.email} logged out`,
        userId: payload.userId,
        organizationId: payload.organizationId ?? null,
        userAgent: getUserAgent(req),
      },
    });

    return clearSessionCookie(
      NextResponse.json({ message: 'Logged out successfully' })
    );
  } catch (error) {
    log.error('api.auth.logout.', { error: String('Logout error:') }, requestContext(req));
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    );
  }
}
