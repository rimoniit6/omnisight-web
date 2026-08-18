import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { authenticateRequest } from '@/lib/api';
import { hasRolePermission } from '@/lib/auth';
import { revokeAllUserSessions, getUserAgent } from '@/lib/session';

// POST /api/auth/users/[id]/revoke-sessions
// Admin+ force-logout: revoke EVERY live session of the target user (S-04).
// The proxy gates /api/auth/users to admin+; the handler enforces it too.
// The target user's already-issued JWTs stop working server-side immediately.
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const auth = await authenticateRequest(req);
    if (!auth) {
      return NextResponse.json({ error: 'Unauthorized. Please sign in.' }, { status: 401 });
    }
    if (!hasRolePermission(auth.role, 'admin')) {
      return NextResponse.json({ error: 'Insufficient permissions' }, { status: 403 });
    }

    const { id } = await params;

    // Tenant isolation: an org-bound admin may only revoke sessions of a user
    // in the SAME organization. Org-less super_admins may revoke any user.
    const target = await db.appUser.findUnique({
      where: { id },
      select: { id: true, organizationId: true },
    });
    if (!target) {
      return NextResponse.json({ error: 'User not found' }, { status: 404 });
    }
    if (auth.organizationId && target.organizationId !== auth.organizationId) {
      return NextResponse.json({ error: 'User not found' }, { status: 404 });
    }

    const revoked = await revokeAllUserSessions(id);

    await db.auditLog.create({
      data: {
        action: 'revoke',
        resource: 'session',
        resourceId: id,
        description: `Admin ${auth.email} revoked all sessions of user ${target.id}`,
        userId: auth.userId,
        organizationId: auth.organizationId ?? target.organizationId ?? null,
        userAgent: getUserAgent(req),
      },
    });

    return NextResponse.json({ success: true, revoked });
  } catch (error) {
    console.error('Revoke user sessions error:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
