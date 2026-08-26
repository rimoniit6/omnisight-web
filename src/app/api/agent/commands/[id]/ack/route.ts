import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { validateAgentToken } from '@/lib/agent/auth';
import { log, requestContext } from '@/lib/logger';

// POST /api/agent/commands/:id/ack
// Device acknowledges (or reports failure of) a DELIVERED command.
//
// SECURITY:
//   - Device-bound: the command's deviceId must equal the token's bound
//     device, and its organization must equal the employee's org — any
//     mismatch is concealed as 404 (never reveals another tenant/device).
//   - Replay-safe: only DELIVERED → ACKNOWLEDGED (or FAILED) is a legal
//     transition, executed as a guarded update. A second ack for the same
//     command is an idempotent success that changes nothing.
//   - A never-delivered (PENDING/EXPIRED/CANCELLED) command cannot be acked.
//   - Every terminal ack is audited.
//   - No shell/process execution exists anywhere in this endpoint.

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const authResult = await validateAgentToken(req);
    if (!authResult.valid || !authResult.employee) {
      return NextResponse.json({ error: authResult.error || 'Authentication failed' }, { status: 401 });
    }
    if (!authResult.deviceId) {
      return NextResponse.json({ error: 'Command ack requires a device-bound token' }, { status: 403 });
    }
    const employee = authResult.employee;
    const deviceId = authResult.deviceId;

    const { id } = await params;

    const body = (await req.json().catch(() => null)) as { result?: unknown; error?: unknown } | null;
    const result = body?.result;
    if (result !== 'acknowledged' && result !== 'failed') {
      return NextResponse.json({ error: 'result must be "acknowledged" or "failed"' }, { status: 422 });
    }
    const errorText =
      typeof body?.error === 'string' && body.error.length > 0
        ? body.error.slice(0, 200)
        : null;

    const command = await db.agentCommand.findUnique({ where: { id } });
    // Conceal foreign / nonexistent commands as 404.
    if (!command || command.deviceId !== deviceId || command.organizationId !== employee.organizationId) {
      return NextResponse.json({ error: 'Command not found' }, { status: 404 });
    }

    if (command.status === 'ACKNOWLEDGED' || command.status === 'FAILED') {
      // Idempotent duplicate ack — return the terminal state unchanged.
      return NextResponse.json({ success: true, status: command.status });
    }
    if (command.status !== 'DELIVERED') {
      return NextResponse.json(
        { error: `Command is ${command.status} — only DELIVERED commands can be acknowledged` },
        { status: 409 }
      );
    }

    const terminalStatus = result === 'acknowledged' ? 'ACKNOWLEDGED' : 'FAILED';
    const updated = await db.$transaction(async (tx) => {
      const claimed = await tx.agentCommand.updateMany({
        where: { id: command.id, deviceId, status: 'DELIVERED' },
        data: { status: terminalStatus, acknowledgedAt: new Date() },
      });
      if (claimed.count === 0) {
        // Lost a race to another ack — idempotent success with the current state.
        const current = await tx.agentCommand.findUnique({ where: { id: command.id }, select: { status: true } });
        return current?.status ?? command.status;
      }
      await tx.auditLog.create({
        data: {
          action: 'update',
          resource: 'device_command',
          resourceId: command.id,
          description: `Agent command ${command.commandType} ${result === 'acknowledged' ? 'acknowledged' : 'failed'}${errorText ? ` (${errorText})` : ''}`,
          userId: null,
          organizationId: command.organizationId,
        },
      });
      return terminalStatus;
    });

    return NextResponse.json({ success: true, status: updated });
  } catch (error) {
    log.error('api.agent.commands.id.ack.', { error: String('Agent command ack error:') }, requestContext(req));
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
