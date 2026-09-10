import { NextRequest } from 'next/server';
import { db } from '@/lib/db';
import { requireSuperAdmin, apiSuccess, apiError, authError } from '@/lib/api';

// GET /api/super-admin/ai-usage — platform-wide AI usage (Phase 5 §19).
// Aggregates ONLY: totals, errors, per-operation and per-status counts, and
// recent calls WITHOUT organization identity. No API key, prompt, response,
// encrypted credential or per-org detail is ever serialized. Token counts are
// summed platform-wide (provider-reported only — never fabricated).
export async function GET(req: NextRequest) {
  try {
    const admin = await requireSuperAdmin(req);
    if (!admin.ok) return authError(admin);

    const now = new Date();
    const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);

    const [total, today, thisMonth, errors, byOperation, byStatus, recent] = await Promise.all([
      db.aiUsage.count(),
      db.aiUsage.count({ where: { createdAt: { gte: todayStart } } }),
      db.aiUsage.count({ where: { createdAt: { gte: monthStart } } }),
      db.aiUsage.count({ where: { status: 'error' } }),
      db.aiUsage.groupBy({ by: ['operation'], _count: { _all: true } }),
      db.aiUsage.groupBy({ by: ['status'], _count: { _all: true } }),
      db.aiUsage.findMany({
        orderBy: { createdAt: 'desc' },
        take: 25,
        select: {
          id: true,
          provider: true,
          model: true,
          operation: true,
          status: true,
          errorCode: true,
          totalTokens: true,
          latencyMs: true,
          createdAt: true,
        },
      }),
    ]);

    const tokens = await db.aiUsage.aggregate({
      _sum: { totalTokens: true, inputTokens: true, outputTokens: true },
    });

    return apiSuccess({
      total,
      today,
      thisMonth,
      errors,
      totalTokens: tokens._sum.totalTokens,
      inputTokens: tokens._sum.inputTokens,
      outputTokens: tokens._sum.outputTokens,
      byOperation: byOperation.map((r) => ({ operation: r.operation, count: r._count._all })),
      byStatus: byStatus.map((r) => ({ status: r.status, count: r._count._all })),
      recent: recent.map((r) => ({
        id: r.id,
        provider: r.provider,
        model: r.model,
        operation: r.operation,
        status: r.status,
        errorCode: r.errorCode,
        totalTokens: r.totalTokens,
        latencyMs: r.latencyMs,
        createdAt: r.createdAt.toISOString(),
      })),
    });
  } catch {
    return apiError('Failed to load AI usage', 500);
  }
}