import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { validateAgentToken } from '@/lib/agent/auth';
import { hasActiveConsent } from '@/lib/consent';
import { resolveOrgMonitoring } from '@/lib/jobs/settings';
import { log, requestContext } from '@/lib/logger';

// POST /api/agent/webcam/session
// The agent registers the session it opened after executing `webcam.start`.
// METADATA ONLY — no video ever reaches this endpoint or the database.
//
// SECURITY:
//   - validateAgentToken (device-bound) — the command must belong to THIS
//     device and THIS org (foreign commands are concealed as 404).
//   - The command must be allowlisted `webcam.start` and in a deliverable or
//     acknowledged state.
//   - Consent + config are re-verified HERE (server-authoritative): a revoked
//     `webcam_access` consent or a disabled `webcam_capture_enabled` flag
//     rejects the session even if the command was enqueued earlier.
//   - One active session per device at a time.
//   - startedBy is derived from the stored command payload (the admin user id
//     written at enqueue time) — never from the agent request.

const SESSION_ID_RE = /^[a-zA-Z0-9_-]{8,128}$/;

export async function POST(req: NextRequest) {
  try {
    const authResult = await validateAgentToken(req);
    if (!authResult.valid || !authResult.employee || !authResult.deviceId) {
      return NextResponse.json({ error: authResult.error || 'Authentication failed' }, { status: 401 });
    }
    const employee = authResult.employee;
    const deviceId = authResult.deviceId;

    const body = (await req.json().catch(() => null)) as { sessionId?: unknown; commandId?: unknown } | null;
    if (!body || typeof body !== 'object') {
      return NextResponse.json({ error: 'Invalid body' }, { status: 400 });
    }
    const sessionId = body.sessionId;
    const commandId = body.commandId;
    if (typeof sessionId !== 'string' || !SESSION_ID_RE.test(sessionId)) {
      return NextResponse.json({ error: 'sessionId must be 8..128 chars of [a-zA-Z0-9_-]' }, { status: 422 });
    }
    if (typeof commandId !== 'string' || commandId.length === 0 || commandId.length > 64) {
      return NextResponse.json({ error: 'commandId is required' }, { status: 422 });
    }

    // The initiating command must be THIS device's allowlisted webcam.start.
    const command = await db.agentCommand.findUnique({ where: { id: commandId } });
    if (!command || command.deviceId !== deviceId || command.organizationId !== employee.organizationId) {
      return NextResponse.json({ error: 'Command not found' }, { status: 404 });
    }
    if (command.commandType !== 'webcam.start') {
      return NextResponse.json({ error: 'Session may only be started by a webcam.start command' }, { status: 403 });
    }
    if (command.status !== 'DELIVERED' && command.status !== 'ACKNOWLEDGED') {
      return NextResponse.json({ error: `Command is ${command.status} — not deliverable` }, { status: 409 });
    }

    // Server-authoritative gates at session creation.
    if (!(await hasActiveConsent(employee.id, 'webcam_access'))) {
      return NextResponse.json({ error: 'Webcam access requires consent. Consent is not granted or has been revoked.' }, { status: 403 });
    }
    const monitoring = await resolveOrgMonitoring(employee.organizationId);
    if (monitoring.webcam_capture_enabled !== true) {
      return NextResponse.json({ error: 'WEBCAM_CAPTURE_DISABLED' }, { status: 403 });
    }

    // One active session per device.
    const active = await db.webcamSession.findFirst({ where: { deviceId, status: 'active' }, select: { sessionId: true } });
    if (active) {
      return NextResponse.json({ error: 'A webcam session is already active for this device' }, { status: 409 });
    }

    let startedBy = 'admin';
    try {
      const payload = JSON.parse(command.payload) as Record<string, unknown>;
      if (typeof payload.startedBy === 'string' && payload.startedBy.length > 0 && payload.startedBy.length <= 64) {
        startedBy = payload.startedBy;
      }
    } catch {
      /* malformed payload → default 'admin' */
    }

    try {
      const session = await db.webcamSession.create({
        data: {
          sessionId,
          employeeId: employee.id,
          deviceId,
          organizationId: employee.organizationId,
          commandId: command.id,
          status: 'active',
          startedBy,
        },
      });
      return NextResponse.json({ success: true, sessionId: session.sessionId, status: session.status });
    } catch (err) {
      if (err instanceof Error && err.message.includes('sessionId')) {
        return NextResponse.json({ error: 'Session already exists' }, { status: 409 });
      }
      throw err;
    }
  } catch (error) {
    log.error('api.agent.webcam.session.', { error: String('Agent webcam session error:') }, requestContext(req));
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
