import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { getRequestToken, verifyPassword, hashPassword } from '@/lib/auth';
import { verifySessionToken, revokeAllUserSessions, getUserAgent } from '@/lib/session';

/**
 * POST /api/auth/change-password
 * Change password for the currently authenticated user
 */
export async function POST(req: NextRequest) {
  try {
    const token = getRequestToken(req);
    if (!token) {
      return NextResponse.json({ error: 'No token provided' }, { status: 401 });
    }

    // verifySessionToken (S-04): a revoked session cannot change passwords.
    const payload = await verifySessionToken(token);
    if (!payload) {
      return NextResponse.json({ error: 'Invalid or expired token' }, { status: 401 });
    }

    const body = await req.json();
    const { currentPassword, newPassword } = body as {
      currentPassword?: string;
      newPassword?: string;
    };

    if (!currentPassword || !newPassword) {
      return NextResponse.json(
        { error: 'Current password and new password are required' },
        { status: 400 }
      );
    }

    // Validate new password strength
    if (newPassword.length < 8) {
      return NextResponse.json(
        { error: 'Password must be at least 8 characters' },
        { status: 400 }
      );
    }

    const hasUpper = /[A-Z]/.test(newPassword);
    const hasLower = /[a-z]/.test(newPassword);
    const hasDigit = /\d/.test(newPassword);
    const hasSpecial = /[^A-Za-z0-9]/.test(newPassword);

    if (!(hasUpper && hasLower && hasDigit && hasSpecial)) {
      return NextResponse.json(
        { error: 'Password must include uppercase, lowercase, digit, and special character' },
        { status: 400 }
      );
    }

    // Get user with password
    const user = await db.appUser.findUnique({
      where: { id: payload.userId },
      select: { id: true, password: true, email: true, name: true },
    });

    if (!user || !user.password) {
      return NextResponse.json({ error: 'User not found' }, { status: 404 });
    }

    // Verify current password
    const isValid = await verifyPassword(currentPassword, user.password);
    if (!isValid) {
      return NextResponse.json(
        { error: 'Current password is incorrect' },
        { status: 401 }
      );
    }

    // Hash and save new password
    const hashedNewPassword = await hashPassword(newPassword);
    await db.$transaction(async (tx) => {
      await tx.appUser.update({
        where: { id: user.id },
        data: { password: hashedNewPassword },
      });

      // Audit log (S-08: sanitized User-Agent for incident forensics).
      await tx.auditLog.create({
        data: {
          action: 'update',
          resource: 'auth',
          resourceId: user.id,
          description: `User ${user.name} (${user.email}) changed their password`,
          userId: user.id,
          organizationId: payload.organizationId ?? null,
          userAgent: getUserAgent(req),
        },
      });
    });

    // Credential change invalidates every OTHER session (S-04): the current
    // one survives so the user is not locked out mid-flow; all other browsers
    // are forced to re-authenticate. Documented + regression-tested behavior.
    if (payload.sessionId) {
      await revokeAllUserSessions(user.id, { exceptSessionId: payload.sessionId });
    }

    return NextResponse.json({ message: 'Password changed successfully' });
  } catch (error) {
    console.error('Change password error:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
