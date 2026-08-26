import { NextRequest, NextResponse } from 'next/server';
import { validateAgentToken } from '@/lib/agent/auth';
import { startBreak, endBreak } from '@/lib/breaks/service';
import { log, requestContext } from '@/lib/logger';

// POST /api/agent/break
// Agent notifies the server when the employee takes a break (breaks pause
// monitoring) or ends one. Break state is SERVER-AUTHORITATIVE — identity
// (employee, org, device) is derived exclusively from the authenticated agent
// token; client-supplied identity is never accepted.
//
// Idempotency:
//   breakMode=true  while a break is already active -> 200 with the existing
//                   session (action "already_active", no duplicate).
//   breakMode=false with no active break           -> 200 no-op
//                   (action "no_active_break").
// Concurrency: the DB-level single-active-break index resolves simultaneous
// starts to one session; the loser returns the winner's session.
//
// Response contract:
//   { success, breakMode, action, startedAt, endedAt, message }
export async function POST(req: NextRequest) {
  try {
    const authResult = await validateAgentToken(req);
    if (!authResult.valid) {
      return NextResponse.json({ error: authResult.error }, { status: 401 });
    }

    const body = await req.json().catch(() => ({}));
    const { breakMode } = body as { breakMode?: unknown };

    if (typeof breakMode !== 'boolean') {
      return NextResponse.json({ error: 'breakMode must be boolean' }, { status: 400 });
    }

    const employeeId = authResult.employee!.id;
    const organizationId = authResult.employee!.organizationId;
    const deviceId = authResult.deviceId || null;

    if (breakMode) {
      const result = await startBreak({
        organizationId,
        employeeId,
        deviceId,
        source: 'agent',
        actor: deviceId,
      });
      return NextResponse.json({
        success: true,
        breakMode: true,
        action: result.action,
        startedAt: result.session.startedAt.toISOString(),
        endedAt: null,
        message:
          result.action === 'already_active'
            ? 'Break mode already active.'
            : 'Break mode activated. Tracking paused.',
      });
    }

    const result = await endBreak({
      employeeId,
      deviceId,
      source: 'agent',
      actor: deviceId,
    });
    return NextResponse.json({
      success: true,
      breakMode: false,
      action: result.action,
      startedAt: null,
      endedAt: result.session?.endedAt ? result.session.endedAt.toISOString() : null,
      message:
        result.action === 'no_active_break'
          ? 'No active break to end. Tracking continues.'
          : 'Break mode deactivated. Tracking resumed.',
    });
  } catch (error) {
    log.error('api.agent.break.', { error: String('Agent break error:') }, requestContext(req));
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
