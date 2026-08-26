import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { getScopedEmployee } from '@/lib/self-guard';
import { log, requestContext } from '@/lib/logger';

// GET /api/self/devices?employeeId=xxx
// Manager+ role (enforced by middleware); employee scoped to caller's org.
export async function GET(req: NextRequest) {
  try {
    const { searchParams } = new URL(req.url);
    const employeeId = searchParams.get('employeeId');

    if (!employeeId) {
      return NextResponse.json({ error: 'employeeId is required' }, { status: 400 });
    }

    // Tenant-scoped lookup: employee must belong to the caller's org
    const { employee: scoped, error: scopeError } = await getScopedEmployee(req, employeeId);
    if (scopeError || !scoped) {
      return NextResponse.json({ error: scopeError || 'Employee not found' }, { status: 404 });
    }

    // Fetch all devices for this employee
    const devices = await db.device.findMany({
      where: { employeeId: scoped.id },
      select: {
        id: true,
        name: true,
        hostname: true,
        operatingSystem: true,
        osVersion: true,
        agentVersion: true,
        status: true,
        lastHeartbeat: true,
        registeredAt: true,
        updatedAt: true,
      },
      orderBy: { registeredAt: 'desc' },
    });

    // Get latest activity timestamp per device in a single grouped query
    // (was N+1: one findFirst per device).
    const deviceIds = devices.map((d) => d.id);
    const latestByDevice = deviceIds.length > 0
      ? await db.activity.groupBy({
          by: ['deviceId'],
          where: { deviceId: { in: deviceIds } },
          _max: { timestamp: true },
        })
      : [];
    const activityMap = new Map<string, Date | null>();
    for (const group of latestByDevice) {
      if (group.deviceId) activityMap.set(group.deviceId, group._max.timestamp);
    }

    const devicesWithLatest = devices.map((d) => ({
      ...d,
      latestActivityTimestamp: activityMap.get(d.id) || null,
    }));

    return NextResponse.json({
      data: devicesWithLatest,
      total: devicesWithLatest.length,
    });
  } catch (error) {
    log.error('api.self.devices.', { error: String('Self Devices GET error:') }, requestContext(req));
    return NextResponse.json({ error: 'Failed to fetch devices' }, { status: 500 });
  }
}
