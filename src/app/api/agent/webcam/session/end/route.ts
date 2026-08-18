import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { validateAgentToken } from '@/lib/agent/auth';
import { clearSession } from '@/lib/webcam-relay';

// POST /api/agent/webcam/session/end
// The agent terminates an on-demand webcam session (command, timeout,
// disconnect, consent revocation, config disable, error, shutdown).
//
// SECURITY:
//   - Device-bound + org-scoped: only the session OWNING device may end it
//     (foreign sessions are concealed as 404).
//   - Idempotent: ending an already-ended session is a successful no-op.
//   - Relay frames for the session are dropped immediately (never persisted).
//   - Terminal states are audited.

const END_REASONS = new Set(['command', 'timeout', 'disconnect', 'consent_revoked', 'config_disabled', 'error', 'shutdown']);

export async function POST(req: NextRequest) {
  try {
    const authResult = await validateAgentToken(req);
    if (!authResult.valid || !authResult.employee || !authResult.deviceId) {
      return NextResponse.json({ error: authResult.error || 'Authentication failed' }, { status: 401 });
    }
    const employee = authResult.employee;
    const deviceId = authResult.deviceId;

    const body = (await req.json().catch(() => null)) as { sessionId?: unknown; endedReason?: unknown } | null;
    if (!body || typeof body !== 'object') {
      return NextResponse.json({ error: 'Invalid body' }, { status: 400 });
    }
    const sessionId = body.sessionId;
    const endedReason = body.endedReason;
    if (typeof sessionId !== 'string' || sessionId.length === 0 || sessionId.length > 128) {
      return NextResponse.json({ error: 'sessionId is required' }, { status: 422 });
    }
    if (typeof endedReason !== 'string' || !END_REASONS.has(endedReason)) {
      return NextResponse.json({ error: `endedReason must be one of: ${[...END_REASONS].join(', ')}` }, { status: 422 });
    }

    const session = await db.webcamSession.findUnique({ where: { sessionId } });
    if (!session || session.deviceId !== deviceId || session.organizationId !== employee.organizationId) {
      return NextResponse.json({ error: 'Session not found' }, { status: 404 });
    }

    if (session.status === 'ended' || session.status === 'failed') {
      return NextResponse.json({ success: true, sessionId, status: session.status }); // idempotent
    }

    await db.$transaction(async (tx) => {
      await tx.webcamSession.updateMany({
        where: { sessionId, status: 'active' },
        data: { status: endedReason === 'error' ? 'failed' : 'ended', endedAt: new Date(), endedReason },
      });
      await tx.auditLog.create({
        data: {
          action: 'update',
          resource: 'webcam_session',
          resourceId: session.id,
          description: `Webcam session ${sessionId} ended (${endedReason})`,
          userId: null,
          organizationId: session.organizationId,
        },
      });
    });

    // Drop relayed frames immediately — nothing survives the session.
    clearSession(sessionId);

    return NextResponse.json({ success: true, sessionId, status: endedReason === 'error' ? 'failed' : 'ended' });
  } catch (error) {
    console.error('Agent webcam session end error:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
