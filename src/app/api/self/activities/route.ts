import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { getScopedEmployee } from '@/lib/self-guard';
import { validatePagination } from '@/lib/api';
import { NON_INTERNAL_AGENT_ACTIVITY_FILTER } from '@/lib/agent-process';
import { log, requestContext } from '@/lib/logger';

// GET /api/self/activities?employeeId=xxx&type=&category=&dateFrom=&dateTo=&page=&pageSize=
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

    const type = searchParams.get('type');
    const category = searchParams.get('category');
    const dateFrom = searchParams.get('dateFrom');
    const dateTo = searchParams.get('dateTo');

    const pagination = validatePagination(searchParams, { defaultPageSize: 20, maxPageSize: 200 });
    if (!pagination.ok) {
      return NextResponse.json({ error: pagination.error }, { status: pagination.status });
    }
    const { page, pageSize, skip } = pagination;

    if (dateFrom && Number.isNaN(new Date(dateFrom).getTime())) {
      return NextResponse.json({ error: 'Invalid dateFrom' }, { status: 422 });
    }
    if (dateTo && Number.isNaN(new Date(dateTo).getTime())) {
      return NextResponse.json({ error: 'Invalid dateTo' }, { status: 422 });
    }

    // Build where clause. Internal agent processes are excluded at the query
    // layer (case-insensitive NOT filter).
    const where: Record<string, unknown> = { employeeId: scoped.id, ...NON_INTERNAL_AGENT_ACTIVITY_FILTER };
    if (type) where.type = type;
    if (category) where.category = category;
    if (dateFrom || dateTo) {
      const ts: Record<string, unknown> = {};
      if (dateFrom) ts.gte = new Date(dateFrom);
      if (dateTo) ts.lte = new Date(dateTo);
      where.timestamp = ts;
    }

    // Fetch paginated activities with device info
    const [activities, total] = await Promise.all([
      db.activity.findMany({
        where,
        include: {
          device: { select: { id: true, name: true, hostname: true } },
        },
        orderBy: { timestamp: 'desc' },
        skip,
        take: pageSize,
      }),
      db.activity.count({ where }),
    ]);

    // Aggregate stats: total duration and by-category breakdown
    const aggregateWhere: Record<string, unknown> = { employeeId: scoped.id, ...NON_INTERNAL_AGENT_ACTIVITY_FILTER };
    if (type) aggregateWhere.type = type;
    if (dateFrom || dateTo) {
      const ts: Record<string, unknown> = {};
      if (dateFrom) ts.gte = new Date(dateFrom);
      if (dateTo) ts.lte = new Date(dateTo);
      aggregateWhere.timestamp = ts;
    }

    const aggregateActivities = await db.activity.findMany({
      where: aggregateWhere,
      select: { duration: true, category: true },
    });

    const totalDuration = aggregateActivities.reduce((sum, a) => sum + a.duration, 0);

    const categoryBreakdown = aggregateActivities.reduce<Record<string, { count: number; duration: number }>>(
      (acc, a) => {
        const cat = a.category || 'uncategorized';
        if (!acc[cat]) acc[cat] = { count: 0, duration: 0 };
        acc[cat].count += 1;
        acc[cat].duration += a.duration;
        return acc;
      },
      {}
    );

    const totalPages = Math.ceil(total / pageSize);

    return NextResponse.json({
      data: activities,
      total,
      page,
      pageSize,
      totalPages,
      aggregate: {
        totalDuration,
        totalHours: +(totalDuration / 3600).toFixed(2),
        categoryBreakdown: Object.entries(categoryBreakdown).map(([category, stats]) => ({
          category,
          count: stats.count,
          duration: stats.duration,
          hours: +(stats.duration / 3600).toFixed(2),
        })),
      },
    });
  } catch (error) {
    log.error('api.self.activities.', { error: String('Self Activities GET error:') }, requestContext(req));
    return NextResponse.json({ error: 'Failed to fetch activities' }, { status: 500 });
  }
}
