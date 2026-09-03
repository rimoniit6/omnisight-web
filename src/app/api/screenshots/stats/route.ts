import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { authError, requireSessionOrg } from '@/lib/api';
import { log, requestContext } from '@/lib/logger';

// GET /api/screenshots/stats
export async function GET(req: NextRequest) {
  try {
    // Tenant isolation: screenshot stats are organization-scoped from the
    // verified session. Org-less super_admins get an empty payload.
    const scope = await requireSessionOrg(req, { allowGlobal: true });
    if (!scope.ok) return authError(scope);
    if (!scope.organizationId) {
      return NextResponse.json({ total: 0, todayCount: 0, flaggedCount: 0, totalStorage: 0, thumbnailStorage: 0, recentByEmployee: [] });
    }
    const orgId = scope.organizationId;

    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);

    const [total, todayCount, flaggedCount, totalStorage, thumbnailStorage] = await Promise.all([
      db.screenshot.count({ where: { organizationId: orgId } }),
      db.screenshot.count({ where: { organizationId: orgId, capturedAt: { gte: todayStart } } }),
      db.screenshot.count({ where: { organizationId: orgId, flagged: true } }),
      db.screenshot.aggregate({ where: { organizationId: orgId }, _sum: { fileSize: true } }),
      // Phase 2 cost accounting: derived thumbnail bytes (derived from the
      // per-row thumbnailSize column — never a drift-prone counter table).
      db.screenshot.aggregate({ where: { organizationId: orgId }, _sum: { thumbnailSize: true } }),
    ]);

    // Recent screenshots per employee (last 7 days)
    const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
    const recentByEmployee = await db.screenshot.groupBy({
      by: ['employeeId'],
      where: { organizationId: orgId, capturedAt: { gte: sevenDaysAgo } },
      _count: { id: true },
      orderBy: { _count: { id: 'desc' } },
      take: 10,
    });

    return NextResponse.json({
      total,
      todayCount,
      flaggedCount,
      totalStorage: totalStorage._sum.fileSize || 0,
      // Additive: thumbnail bytes (0 when none exist yet) — original bytes are
      // still reported as `totalStorage` so existing consumers are unchanged.
      thumbnailStorage: thumbnailStorage._sum.thumbnailSize || 0,
      recentByEmployee,
    });
  } catch (error) {
    log.error('api.screenshots.stats.', { error: String('Screenshot stats error:') }, requestContext(req));
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
