import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { authError, requireManagerOrg } from '@/lib/api';
import { log, requestContext } from '@/lib/logger';

// GET /api/ai-provider/metering
// Phase 5 per-call AI usage metering, derived from the AiUsage table. Strictly
// tenant-scoped: organizationId always comes from the authenticated session —
// a caller can never read another organization's rows. No secrets, no payloads.
export async function GET(req: NextRequest) {
  try {
    const scope = await requireManagerOrg(req);
    if (!scope.ok) return authError(scope);
    const orgId = scope.organizationId;

    const now = new Date();
    const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);

    const [total, today, thisMonth, errors, byOperation, recent] = await Promise.all([
      db.aiUsage.count({ where: { organizationId: orgId } }),
      db.aiUsage.count({ where: { organizationId: orgId, createdAt: { gte: todayStart } } }),
      db.aiUsage.count({ where: { organizationId: orgId, createdAt: { gte: monthStart } } }),
      db.aiUsage.count({ where: { organizationId: orgId, status: 'error' } }),
      db.aiUsage.groupBy({
        by: ['operation', 'status'],
        where: { organizationId: orgId },
        _count: { _all: true },
      }),
      db.aiUsage.findMany({
        where: { organizationId: orgId },
        orderBy: { createdAt: 'desc' },
        take: 50,
        select: {
          id: true,
          provider: true,
          model: true,
          operation: true,
          status: true,
          errorCode: true,
          inputTokens: true,
          outputTokens: true,
          totalTokens: true,
          latencyMs: true,
          createdAt: true,
        },
      }),
    ]);

    return NextResponse.json({
      total,
      today,
      thisMonth,
      errors,
      byOperation: byOperation.map((r) => ({
        operation: r.operation,
        status: r.status,
        count: r._count._all,
      })),
      recent: recent.map((r) => ({
        id: r.id,
        provider: r.provider,
        model: r.model,
        operation: r.operation,
        status: r.status,
        errorCode: r.errorCode,
        inputTokens: r.inputTokens,
        outputTokens: r.outputTokens,
        totalTokens: r.totalTokens,
        latencyMs: r.latencyMs,
        createdAt: r.createdAt.toISOString(),
      })),
    });
  } catch {
    log.error('api.ai-provider.metering.error', { reason: 'AI metering read failed' }, requestContext(req));
    return NextResponse.json({ error: 'Failed to fetch AI usage metering' }, { status: 500 });
  }
}
