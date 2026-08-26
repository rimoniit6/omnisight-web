'use server';
import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { authError, requireSessionOrg } from '@/lib/api';
import { effectiveDeviceStatus } from '@/lib/device-status';
import { log, requestContext } from '@/lib/logger';

export async function GET(req: NextRequest) {
  try {
    const scope = await requireSessionOrg(req, { allowGlobal: true });
    if (!scope.ok) return authError(scope);

    const orgWhere: Record<string, unknown> = scope.organizationId ? { organizationId: scope.organizationId } : {};

    const rows = await db.device.findMany({
      where: orgWhere,
      select: { id: true, status: true, lastHeartbeat: true },
    });

    // Lazy stale-offline: count effective status instead of the stored
    // column, so a device whose agent stopped heartbeating reads as offline.
    // Uses the centralized presence threshold — matches the presence API.
    let online = 0;
    let offline = 0;
    let maintenance = 0;
    for (const d of rows) {
      const effective = effectiveDeviceStatus(d.status, d.lastHeartbeat);
      if (effective === 'online') online += 1;
      else if (effective === 'offline') offline += 1;
      else if (effective === 'maintenance') maintenance += 1;
    }
    const total = rows.length;

    return NextResponse.json({
      total,
      online,
      offline,
      maintenance,
      inactive: total - online - offline - maintenance,
      healthPercent: total > 0 ? Math.round((online / total) * 100) : 0,
    });
  } catch (error) {
    log.error('api.devices.summary.', { error: String('Device summary GET error:') }, requestContext(req));
    return NextResponse.json({ error: 'Failed to fetch device summary' }, { status: 500 });
  }
}
