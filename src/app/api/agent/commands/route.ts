import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { validateAgentToken } from '@/lib/agent/auth';

// GET /api/agent/commands
// Secure server → agent command poll.
//
// SECURITY MODEL:
//   - The authenticated device receives ONLY its OWN commands (deviceId must
//     equal the token's bound device) — organization/employee isolation is
//     enforced by the device binding + the org derived from the token.
//   - Only ALLOWLISTED command types are ever returned (initially
//     webcam.start / webcam.stop — nothing else is executable).
//   - Commands must be unexpired; stale PENDING commands are transitioned to
//     EXPIRED opportunistically on each poll.
//   - Delivery is ATOMIC and replay-safe: a candidate is claimed with an
//     updateMany guarded by status='PENDING', so a command is returned to
//     exactly ONE poll and can never be fetched (or executed) twice.
//   - The endpoint performs NO command execution of any kind.

export const AGENT_COMMAND_ALLOWLIST = ['webcam.start', 'webcam.stop'] as const;

const MAX_COMMANDS_PER_POLL = 5;

export async function GET(req: NextRequest) {
  try {
    const authResult = await validateAgentToken(req);
    if (!authResult.valid || !authResult.employee) {
      return NextResponse.json({ error: authResult.error || 'Authentication failed' }, { status: 401 });
    }
    // Commands are device-bound — an unbound agent has no commands.
    if (!authResult.deviceId) {
      return NextResponse.json({ data: [] });
    }
    const deviceId = authResult.deviceId;

    // Opportunistic cleanup: expire overdue PENDING commands.
    await db.agentCommand.updateMany({
      where: { status: 'PENDING', expiresAt: { lte: new Date() } },
      data: { status: 'EXPIRED' },
    });

    // Candidates: this device's allowlisted, unexpired, still-PENDING commands.
    const candidates = await db.agentCommand.findMany({
      where: {
        deviceId,
        status: 'PENDING',
        expiresAt: { gt: new Date() },
        commandType: { in: [...AGENT_COMMAND_ALLOWLIST] },
      },
      select: { id: true },
      orderBy: { createdAt: 'asc' },
      take: MAX_COMMANDS_PER_POLL,
    });
    if (candidates.length === 0) {
      return NextResponse.json({ data: [] });
    }

    // Atomic claim — only the winner of the guarded update is returned.
    const now = new Date();
    const claimed = await db.agentCommand.updateMany({
      where: {
        id: { in: candidates.map((c) => c.id) },
        deviceId,
        status: 'PENDING',
        expiresAt: { gt: now },
        commandType: { in: [...AGENT_COMMAND_ALLOWLIST] },
      },
      data: { status: 'DELIVERED', deliveredAt: now },
    });

    if (claimed.count === 0) {
      return NextResponse.json({ data: [] }); // another poll won the race
    }

    const delivered = await db.agentCommand.findMany({
      where: {
        id: { in: candidates.map((c) => c.id) },
        deviceId,
        status: 'DELIVERED',
        deliveredAt: { not: null },
      },
      select: {
        id: true,
        commandType: true,
        payload: true,
        createdAt: true,
        expiresAt: true,
      },
      orderBy: { createdAt: 'asc' },
      take: MAX_COMMANDS_PER_POLL,
    });

    return NextResponse.json({
      data: delivered.map((c) => ({
        id: c.id,
        commandType: c.commandType,
        payload: safePayload(c.payload),
        createdAt: c.createdAt.toISOString(),
        expiresAt: c.expiresAt.toISOString(),
      })),
    });
  } catch (error) {
    console.error('Agent commands GET error:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

/** Payload is stored as JSON text; never trust it blindly. */
function safePayload(raw: string | null): Record<string, unknown> {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}
