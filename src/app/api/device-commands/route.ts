import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { requireAdminOrg } from '@/lib/api';
import { AGENT_COMMAND_ALLOWLIST } from '@/app/api/agent/commands/route';
import { log, requestContext } from '@/lib/logger';

// POST /api/device-commands
// Admin enqueues a command for a specific device (the minimal contract the
// Agent's command poller consumes; the Admin Panel UI ships in a later phase).
//
// SECURITY:
//   - Admin+ JWT required; the command is created in the admin's organization
//     (never client-supplied).
//   - commandType is allowlisted (webcam.start | webcam.stop) — nothing else
//     can ever be enqueued.
//   - The employee is derived from the DEVICE row (device.employeeId), never
//     from client input; a device without a bound employee is rejected.
//   - payload is opaque, bounded JSON — the agent only acts on commandType and
//     ignores unknown payload fields; nothing here executes anything.
//   - Commands expire (default 2 min) and are device-bound + org-scoped.
//   - Every enqueue is audited.

const DEFAULT_EXPIRES_SECONDS = 120;
const MAX_EXPIRES_SECONDS = 600;
const MAX_PAYLOAD_BYTES = 2048;

export async function POST(req: NextRequest) {
  try {
    const auth = await requireAdminOrg(req);
    if (!auth.ok) {
      return NextResponse.json({ error: auth.status === 401 ? 'Unauthorized. Please sign in.' : 'Insufficient permissions' }, { status: auth.status });
    }

    const body = (await req.json().catch(() => null)) as {
      deviceId?: unknown;
      commandType?: unknown;
      payload?: unknown;
      expiresInSeconds?: unknown;
    } | null;
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      return NextResponse.json({ error: 'Invalid body' }, { status: 400 });
    }

    const deviceId = body.deviceId;
    if (typeof deviceId !== 'string' || deviceId.length === 0 || deviceId.length > 64) {
      return NextResponse.json({ error: 'deviceId is required' }, { status: 422 });
    }
    const commandType = body.commandType;
    if (typeof commandType !== 'string' || !(AGENT_COMMAND_ALLOWLIST as readonly string[]).includes(commandType)) {
      return NextResponse.json(
        { error: `commandType must be one of: ${AGENT_COMMAND_ALLOWLIST.join(', ')}` },
        { status: 422 }
      );
    }

    let payloadText = '{}';
    if (body.payload !== undefined && body.payload !== null) {
      if (typeof body.payload !== 'object' || Array.isArray(body.payload)) {
        return NextResponse.json({ error: 'payload must be a JSON object' }, { status: 422 });
      }
      payloadText = JSON.stringify(body.payload);
      if (payloadText.length > MAX_PAYLOAD_BYTES) {
        return NextResponse.json({ error: `payload must be at most ${MAX_PAYLOAD_BYTES} bytes` }, { status: 422 });
      }
    }

    // webcam.start commands carry the issuer id so the session audit record
    // can attribute who started the camera (server-authoritative — the agent
    // never supplies it).
    if (commandType === 'webcam.start') {
      const merged = payloadText === '{}' ? {} : JSON.parse(payloadText) as Record<string, unknown>;
      merged.startedBy = auth.userId;
      payloadText = JSON.stringify(merged);
    }

    let expiresSeconds = DEFAULT_EXPIRES_SECONDS;
    if (body.expiresInSeconds !== undefined) {
      const raw = body.expiresInSeconds;
      if (typeof raw !== 'number' || !Number.isInteger(raw) || raw < 30 || raw > MAX_EXPIRES_SECONDS) {
        return NextResponse.json({ error: `expiresInSeconds must be an integer 30..${MAX_EXPIRES_SECONDS}` }, { status: 422 });
      }
      expiresSeconds = raw;
    }

    // Device must exist in THIS org and be bound to an employee.
    const device = await db.device.findFirst({
      where: { id: deviceId, organizationId: auth.organizationId },
      select: { id: true, employeeId: true, status: true },
    });
    if (!device) {
      return NextResponse.json({ error: 'Device not found in this organization' }, { status: 404 });
    }
    if (!device.employeeId) {
      return NextResponse.json({ error: 'Device is not bound to an employee' }, { status: 422 });
    }

    const command = await db.$transaction(async (tx) => {
      const created = await tx.agentCommand.create({
        data: {
          organizationId: auth.organizationId,
          employeeId: device.employeeId!,
          deviceId: device.id,
          commandType,
          payload: payloadText,
          status: 'PENDING',
          expiresAt: new Date(Date.now() + expiresSeconds * 1000),
        },
      });
      await tx.auditLog.create({
        data: {
          action: 'create',
          resource: 'device_command',
          resourceId: created.id,
          description: `Command ${commandType} enqueued for device ${device.id} by ${auth.email}`,
          userId: auth.userId,
          organizationId: auth.organizationId,
        },
      });
      return created;
    });

    return NextResponse.json({
      success: true,
      commandId: command.id,
      status: command.status,
      expiresAt: command.expiresAt.toISOString(),
    });
  } catch (error) {
    log.error('api.device-commands.', { error: String('Device command create error:') }, requestContext(req));
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
