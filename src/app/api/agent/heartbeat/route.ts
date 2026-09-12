import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { validateAgentToken, getClientIp } from '@/lib/agent/auth';
import { effectiveLiveStatus } from '@/lib/presence';
import { log, requestContext } from '@/lib/logger';

// POST /api/agent/heartbeat
// Agent sends periodic heartbeat to show it's alive
export async function POST(req: NextRequest) {
  try {
    const authResult = await validateAgentToken(req);
    if (!authResult.valid) {
      return NextResponse.json({ error: authResult.error }, { status: 401 });
    }

    const clientIp = getClientIp(req);

    // ── ORG DATA BOUNDARY ──
    // Device and BreakSession are org-owned (COPY to the org's DB at cutover).
    // After activation their authoritative home is the org DB — resolve once
    // here (validateAgentToken already guarantees a valid org) and route all
    // org-scoped writes/reads through it.
    const orgData = authResult.orgData ?? db;

    // Update device heartbeat
    if (authResult.deviceId) {
      // Read current state BEFORE update to detect online transition.
      const before = await orgData.device.findUnique({
        where: { id: authResult.deviceId },
        select: { status: true, lastHeartbeat: true },
      });

      await orgData.device.update({
        where: { id: authResult.deviceId },
        data: {
          status: 'online',
          lastHeartbeat: new Date(),
          ipAddress: clientIp,
        },
      });

      // Increment activeDeviceCount when a device transitions to online
      // (not-online → online). The sync job corrects drift every ~30 min,
      // but this keeps the Organizations table current between syncs.
      const wasActive = before && effectiveLiveStatus(before.status, before.lastHeartbeat, new Date()) === 'online';
      if (!wasActive) {
        await db.organization.updateMany({
          where: { id: authResult.employee!.organizationId },
          data: { activeDeviceCount: { increment: 1 } },
        });
      }
    }

    // Canonical break state rides on every heartbeat so the agent pauses
    // collectors within ONE heartbeat interval (10–60s) of an admin or
    // self-service break toggle — far faster than the 10-minute config sync.
    const openBreak = await orgData.breakSession.findFirst({
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
    log.error('api.agent.heartbeat.', { error: String('Agent heartbeat error:') }, requestContext(req));
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
