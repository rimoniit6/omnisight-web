import { NextRequest, NextResponse } from 'next/server';
import { authenticateRequest } from '@/lib/api';
import { revokeAllUserSessions } from '@/lib/session';

// POST /api/auth/sessions/revoke-all
// Force-logout of EVERY session for the authenticated user — including the
// current one (S-04 Test B). After this call the caller's own JWT is dead;
// the client should clear its cookie / discard its token.
export async function POST(req: NextRequest) {
  try {
    const auth = await authenticateRequest(req);
    if (!auth) {
      return NextResponse.json({ error: 'Unauthorized. Please sign in.' }, { status: 401 });
    }

    const revoked = await revokeAllUserSessions(auth.userId);

    return NextResponse.json({ success: true, revoked });
  } catch (error) {
    console.error('Revoke-all sessions error:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
