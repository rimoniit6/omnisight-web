import { NextRequest } from 'next/server';
import { db } from '@/lib/db';
import { requireSuperAdmin, apiSuccess, apiError, authError } from '@/lib/api';

// GET /api/super-admin/devices — platform Agent overview (Phase 5 §22).
// CONTROL-PLANE METADATA ONLY: device identity, presence freshness and agent
// version counts. Never exposes employee activity, screenshots, location or
// any operational tenant content. Organizations appear only as control-plane
// identity (name/slug/mode/status) with a device count.
const ONLINE_WINDOW_MS = 5 * 60 * 1000;

export async function GET(req: NextRequest) {
  try {
    const admin = await requireSuperAdmin(req);
    if (!admin.ok) return authError(admin);

    const now = Date.now();
    const [devices, orgsWithDevices] = await Promise.all([
      db.device.findMany({
        select: {
          id: true,
          name: true,
          status: true,
          lastHeartbeat: true,
          osVersion: true,
          agentVersion: true,
          organizationId: true,
          organization: { select: { id: true, name: true, slug: true, deploymentMode: true, status: true } },
        },
        orderBy: { lastHeartbeat: 'desc' },
        take: 200,
      }),
      db.device.groupBy({ by: ['organizationId'], _count: { id: true } }),
    ]);

    let online = 0;
    let offline = 0;
    const versions = new Map<string, number>();
    const byMode = new Map<string, number>();
    for (const d of devices) {
      const fresh = d.lastHeartbeat ? now - d.lastHeartbeat.getTime() <= ONLINE_WINDOW_MS : false;
      if (fresh) online += 1;
      else offline += 1;
      const v = d.agentVersion || d.osVersion || 'unknown';
      versions.set(v, (versions.get(v) ?? 0) + 1);
      const mode = d.organization?.deploymentMode ?? 'UNKNOWN';
      byMode.set(mode, (byMode.get(mode) ?? 0) + 1);
    }

    const orgRows = orgsWithDevices.map((r) => ({
      organizationId: r.organizationId,
      deviceCount: r._count.id,
    }));

    return apiSuccess({
      total: devices.length,
      online,
      offline,
      organizationsWithAgents: orgRows.length,
      byDeploymentMode: Object.fromEntries(byMode),
      versions: Array.from(versions.entries())
        .map(([version, count]) => ({ version, count }))
        .sort((a, b) => b.count - a.count),
      organizations: orgRows,
    });
  } catch {
    return apiError('Failed to load agent overview', 500);
  }
}