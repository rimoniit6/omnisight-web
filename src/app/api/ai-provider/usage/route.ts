import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { authError, requireSessionOrg } from '@/lib/api';

// GET /api/ai-provider/usage — AI usage statistics derived entirely from the
// database (no mock values). Counts actual AI-generated outputs recorded in
// the system: AI insights, sentiment analyses, and screenshot analyses.
// Tenant isolation: all aggregates are scoped to the caller's organization.
export async function GET(req: NextRequest) {
  try {
    const scope = await requireSessionOrg(req, { allowGlobal: true });
    if (!scope.ok) return authError(scope);
    if (!scope.organizationId) {
      return NextResponse.json({
        today: 0, thisMonth: 0, total: 0,
        dailyBars: [], recentRequests: [],
      });
    }
    const orgId = scope.organizationId;

    const now = new Date();
    const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
    const sevenDaysAgo = new Date(todayStart);
    sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 6);

    // All AI-output rows are the union of these three real tables (org-scoped).
    const [insightCounts, sentimentCounts, screenshotCounts, recentInsights] = await Promise.all([
      db.aiInsight.groupBy({
        by: ['createdAt'],
        _count: { _all: true },
        where: { createdAt: { gte: sevenDaysAgo }, organizationId: orgId },
      }),
      db.sentimentRecord.groupBy({
        by: ['createdAt'],
        _count: { _all: true },
        // Only rows that actually used an AI provider count as AI usage —
        // rules-fallback ('rules') and unmeasured no-data rows ('none') are
        // deterministic output, not AI calls.
        where: { createdAt: { gte: sevenDaysAgo }, employee: { organizationId: orgId }, aiProviderUsed: { notIn: ['rules', 'none'] } },
      }),
      db.screenshot.groupBy({
        by: ['createdAt'],
        _count: { _all: true },
        where: { createdAt: { gte: sevenDaysAgo }, aiAnalysis: { not: null }, organizationId: orgId },
      }),
      db.aiInsight.findMany({
        where: { organizationId: orgId },
        orderBy: { createdAt: 'desc' },
        take: 10,
        select: {
          id: true,
          title: true,
          type: true,
          category: true,
          createdAt: true,
        },
      }),
    ]);

    const dayCounts = new Map<string, number>();
    const dayLabels = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
    for (let i = 0; i < 7; i++) {
      const d = new Date(todayStart);
      d.setDate(d.getDate() - (6 - i));
      dayCounts.set(d.toISOString().split('T')[0], 0);
    }
    const countByDate = (rows: Array<{ createdAt: Date; _count: { _all: number } }>) => {
      for (const r of rows) {
        const key = r.createdAt.toISOString().split('T')[0];
        if (dayCounts.has(key)) dayCounts.set(key, (dayCounts.get(key) ?? 0) + r._count._all);
      }
    };
    countByDate(insightCounts);
    countByDate(sentimentCounts);
    countByDate(screenshotCounts);

    const dailyBars = Array.from(dayCounts.entries()).map(([, count], i) => ({
      day: dayLabels[i % 7],
      count,
    }));

    // Totals via lightweight counts (org-scoped)
    const [totalInsights, totalSentiments, totalScreenshots] = await Promise.all([
      db.aiInsight.count({ where: { organizationId: orgId } }),
      db.sentimentRecord.count({ where: { employee: { organizationId: orgId }, aiProviderUsed: { notIn: ['rules', 'none'] } } }),
      db.screenshot.count({ where: { aiAnalysis: { not: null }, organizationId: orgId } }),
    ]);
    const total = totalInsights + totalSentiments + totalScreenshots;

    const [todayInsights, todaySentiments, todayScreenshots] = await Promise.all([
      db.aiInsight.count({ where: { createdAt: { gte: todayStart }, organizationId: orgId } }),
      db.sentimentRecord.count({ where: { createdAt: { gte: todayStart }, employee: { organizationId: orgId }, aiProviderUsed: { notIn: ['rules', 'none'] } } }),
      db.screenshot.count({ where: { createdAt: { gte: todayStart }, aiAnalysis: { not: null }, organizationId: orgId } }),
    ]);
    const today = todayInsights + todaySentiments + todayScreenshots;

    const [monthInsights, monthSentiments, monthScreenshots] = await Promise.all([
      db.aiInsight.count({ where: { createdAt: { gte: monthStart }, organizationId: orgId } }),
      db.sentimentRecord.count({ where: { createdAt: { gte: monthStart }, employee: { organizationId: orgId }, aiProviderUsed: { notIn: ['rules', 'none'] } } }),
      db.screenshot.count({ where: { createdAt: { gte: monthStart }, aiAnalysis: { not: null }, organizationId: orgId } }),
    ]);
    const thisMonth = monthInsights + monthSentiments + monthScreenshots;

    return NextResponse.json({
      today,
      thisMonth,
      total,
      dailyBars,
      recentRequests: recentInsights.map((r) => ({
        id: r.id,
        model: r.category || r.type,
        title: r.title,
        status: 'success',
        createdAt: r.createdAt,
      })),
    });
  } catch (error) {
    console.error('AI provider usage error:', error);
    return NextResponse.json({ error: 'Failed to fetch AI usage' }, { status: 500 });
  }
}
