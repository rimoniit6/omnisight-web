import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { signJWT, getRequestToken, getRoleLabel, setSessionCookie, jwtLifetimeSeconds } from '@/lib/auth';
import { verifySessionToken, extendSessionExpiry } from '@/lib/session';

/**
 * POST /api/auth/refresh-token
 * Refresh an existing JWT token (sliding expiration)
 * Requires a valid, non-expired token
 */
export async function POST(req: NextRequest) {
  try {
    const token = getRequestToken(req);
    if (!token) {
      return NextResponse.json({ error: 'No token provided' }, { status: 401 });
    }

    // verifySessionToken = JWT + server-side session re-check (S-04): a
    // revoked session cannot refresh itself into a new token.
    const payload = await verifySessionToken(token);
    if (!payload) {
      return NextResponse.json({ error: 'Invalid or expired token' }, { status: 401 });
    }

    // Verify user still exists and is active
    const user = await db.appUser.findUnique({
      where: { id: payload.userId },
    });

    if (!user || !user.isActive) {
      return NextResponse.json({ error: 'User not found or inactive' }, { status: 401 });
    }

    // Issue new token — the SAME sessionId is carried forward (a refresh is
    // not a new session), and the session row's expiry slides in lockstep so
    // the row and the JWT never disagree.
    const sessionId = payload.sessionId;
    if (sessionId) {
      await extendSessionExpiry(sessionId, new Date(Date.now() + jwtLifetimeSeconds() * 1000));
    }
    const newToken = await signJWT({
      userId: user.id,
      email: user.email,
      role: user.role,
      organizationId: user.organizationId || undefined,
      sessionId,
    });

    const initials = user.name
      ? user.name.split(' ').map(n => n[0]).join('').toUpperCase().slice(0, 2)
      : 'AD';

    return setSessionCookie(
      NextResponse.json({
        token: newToken,
        user: {
          id: user.id,
          name: user.name,
          email: user.email,
          role: user.role,
          roleLabel: getRoleLabel(user.role),
          initials,
          avatar: user.avatar,
          lastLogin: user.lastLogin,
        },
      }),
      newToken,
      jwtLifetimeSeconds()
    );
  } catch (error) {
    console.error('Token refresh error:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
