import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { validateAgentToken, getClientIp } from '@/lib/agent/auth';

// POST /api/agent/heartbeat
// Agent sends periodic heartbeat to show it's alive
export async function POST(req: NextRequest) {
  try {
    const authResult = await validateAgentToken(req);
    if (!authResult.valid) {
      return NextResponse.json({ error: authResult.error }, { status: 401 });
    }

    const clientIp = getClientIp(req);

    // Update device heartbeat
    if (authResult.deviceId) {
      await db.device.update({
        where: { id: authResult.deviceId },
        data: {
          status: 'online',
          lastHeartbeat: new Date(),
          ipAddress: clientIp,
        },
      });
    }

    // Canonical break state rides on every heartbeat so the agent pauses
    // collectors within ONE heartbeat interval (10–60s) of an admin or
    // self-service break toggle — far faster than the 10-minute config sync.
    const openBreak = await db.breakSession.findFirst({
      where: { employeeId: authResult.employee!.id, endedAt: null },
      orderBy: { startedAt: 'desc' },
      select: { startedAt: true },
    });
    const breakState = {
      active: openBreak !== null,
      startedAt: openBreak ? openBreak.startedAt.toISOString() : null,
    };

    return NextResponse.json({
      success: true,
      timestamp: new Date().toISOString(),
      message: 'Heartbeat received',
      break: breakState,
    });
  } catch (error) {
    console.error('Agent heartbeat error:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
