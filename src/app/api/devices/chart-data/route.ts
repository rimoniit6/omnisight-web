'use server';
import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { authError, requireSessionOrg } from '@/lib/api';
import { effectiveLiveStatus } from '@/lib/presence';
import { log, requestContext } from '@/lib/logger';

export async function GET(req: NextRequest) {
  try {
    const scope = await requireSessionOrg(req, { allowGlobal: true });
    if (!scope.ok) return authError(scope);

    const devices = await db.device.findMany({
      where: scope.organizationId ? { organizationId: scope.organizationId } : {},
      select: { status: true, operatingSystem: true, name: true, lastHeartbeat: true, registeredAt: true },
    });

    // Status counts — online/offline from heartbeat freshness, lifecycle pins
    // verbatim (sticky Device.status is never liveness evidence).
    const statusCounts: Record<string, number> = {};
    devices.forEach((d) => {
      const s = effectiveLiveStatus(d.status, d.lastHeartbeat);
      statusCounts[s] = (statusCounts[s] || 0) + 1;
    });

    // OS distribution
    const osCounts: Record<string, number> = {};
    devices.forEach((d) => {
      if (d.operatingSystem) {
        const label = d.operatingSystem;
        osCounts[label] = (osCounts[label] || 0) + 1;
      }
    });

    const osDistribution = Object.entries(osCounts).map(([name, value]) => ({ name, value }));

    // Uptime stats
    const total = devices.length;
    const online = statusCounts['online'] || 0;
    const offline = statusCounts['offline'] || 0;
    const maintenance = statusCounts['maintenance'] || 0;
    const inactive = statusCounts['inactive'] || 0;
    const uptimePercent = total > 0 ? Math.round((online / total) * 100) : 0;

    // Most reliable device (live with most recent lastHeartbeat)
    const onlineDevices = devices.filter((d) => effectiveLiveStatus(d.status, d.lastHeartbeat) === 'online' && d.lastHeartbeat);
    const mostReliable = onlineDevices.sort((a, b) => {
      const aTime = a.lastHeartbeat!.getTime();
      const bTime = b.lastHeartbeat!.getTime();
      return bTime - aTime;
    })[0] || null;

    const needsAttention = offline + maintenance;

    return NextResponse.json({
      statusCounts: [
        { status: 'Online', count: online, color: '#10b981' },
        { status: 'Offline', count: offline, color: '#f43f5e' },
        { status: 'Maintenance', count: maintenance, color: '#f59e0b' },
        { status: 'Inactive', count: inactive, color: '#94a3b8' },
      ],
      osDistribution,
      uptime: {
        percentage: uptimePercent,
        mostReliableDevice: mostReliable?.name || null,
        needsAttention,
      },
    });
  } catch (error) {
    log.error('api.devices.chart-data.', { error: String('Device chart-data GET error:') }, requestContext(req));
    return NextResponse.json({ error: 'Failed to fetch chart data' }, { status: 500 });
  }
}
