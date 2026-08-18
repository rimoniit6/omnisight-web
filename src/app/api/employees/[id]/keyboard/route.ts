'use server';
import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { authError, requireSessionOrg } from '@/lib/api';
import { parseISO, startOfDay, subDays } from 'date-fns';

// GET /api/employees/[id]/keyboard?from&to&page&pageSize
// Admin telemetry: AGGREGATE keyboard activity for one employee.
//
//   - Employee lookup is org-scoped (foreign ids → 404, never a leak).
//   - Returns ONLY aggregate rows: keystrokeCount + activeTypingSeconds per
//     interval. The payload is a closed set of safe fields — raw key data
//     does not exist in the schema, so it cannot leak here.
//   - `summary` is a DB-side aggregate over the FULL filtered dataset
//     (never the current page): totalKeystrokes, totalActiveTypingSeconds,
//     intervals. `byApplication` and `byDay` are full-dataset aggregates too.
//   - Strict server-side pagination (page ≥ 1, pageSize 1..100).
//   - Manager+ read scope (requireSessionOrg, same as employee activities).

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const MAX_APPLICATIONS = 12;

function isIsoDate(value: string): boolean {
  if (!DATE_RE.test(value)) return false;
  const d = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === value;
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const { searchParams } = new URL(request.url);

  const rawPage = searchParams.get('page');
  const rawPageSize = searchParams.get('pageSize');
  const page = rawPage === null ? 1 : Number(rawPage);
  const pageSize = rawPageSize === null ? 50 : Number(rawPageSize);
  if (
    (rawPage !== null && (!Number.isInteger(page) || page < 1)) ||
    (rawPageSize !== null && (!Number.isInteger(pageSize) || pageSize < 1)) ||
    pageSize > 100
  ) {
    return NextResponse.json(
      { error: 'page must be a positive integer and pageSize must be between 1 and 100' },
      { status: 422 }
    );
  }

  const fromParam = searchParams.get('from');
  const toParam = searchParams.get('to');
  if (fromParam && !isIsoDate(fromParam)) {
    return NextResponse.json({ error: 'Invalid from. Use YYYY-MM-DD.' }, { status: 422 });
  }
  if (toParam && !isIsoDate(toParam)) {
    return NextResponse.json({ error: 'Invalid to. Use YYYY-MM-DD.' }, { status: 422 });
  }

  try {
    const scope = await requireSessionOrg(request, { allowGlobal: true });
    if (!scope.ok) return authError(scope);

    // Org-scoped employee lookup — foreign/nonexistent ids are concealed as 404.
    const employee = await db.employee.findFirst({
      where: { id, ...(scope.organizationId ? { organizationId: scope.organizationId } : {}) },
      select: { id: true },
    });
    if (!employee) {
      return NextResponse.json({ error: 'Employee not found' }, { status: 404 });
    }

    const now = new Date();
    let startDate: Date;
    let endDate: Date;
    if (fromParam && toParam) {
      startDate = startOfDay(parseISO(fromParam));
      endDate = new Date(parseISO(toParam));
      endDate.setHours(23, 59, 59, 999);
    } else if (fromParam) {
      startDate = startOfDay(parseISO(fromParam));
      endDate = now;
    } else {
      startDate = startOfDay(subDays(now, 6));
      endDate = now;
    }

    // KeyboardActivity has no direct organizationId — scope via the employee.
    const where = {
      employeeId: id,
      intervalStart: { gte: startDate },
      intervalEnd: { lte: endDate },
    };

    const [rows, total, summaryAgg, dayAgg, appAgg] = await Promise.all([
      db.keyboardActivity.findMany({
        where,
        orderBy: { intervalStart: 'desc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      db.keyboardActivity.count({ where }),
      db.keyboardActivity.aggregate({
        where,
        _sum: { keystrokeCount: true, activeTypingSeconds: true },
        _count: { id: true },
      }),
      db.keyboardActivity.groupBy({
        by: ['intervalStart'],
        where,
        _sum: { keystrokeCount: true, activeTypingSeconds: true },
      }),
      db.keyboardActivity.groupBy({
        by: ['application'],
        where: { ...where, application: { not: null } },
        _sum: { keystrokeCount: true, activeTypingSeconds: true },
        _count: { application: true },
      }),
    ]);

    // Aggregate per calendar day from intervalStart (server-local day keys).
    const dayMap = new Map<string, { date: string; keystrokes: number; activeTypingSeconds: number }>();
    for (const d of dayAgg) {
      const key = d.intervalStart.toISOString().slice(0, 10);
      const entry = dayMap.get(key) ?? { date: key, keystrokes: 0, activeTypingSeconds: 0 };
      entry.keystrokes += d._sum.keystrokeCount ?? 0;
      entry.activeTypingSeconds += d._sum.activeTypingSeconds ?? 0;
      dayMap.set(key, entry);
    }
    const byDay = [...dayMap.values()].sort((a, b) => a.date.localeCompare(b.date));

    const byApplication = appAgg
      .filter((a) => a.application)
      .map((a) => ({
        application: a.application as string,
        keystrokes: a._sum.keystrokeCount ?? 0,
        activeTypingSeconds: a._sum.activeTypingSeconds ?? 0,
        intervals: a._count.application ?? 0,
      }))
      .sort((a, b) => b.keystrokes - a.keystrokes)
      .slice(0, MAX_APPLICATIONS);

    const totalPages = Math.ceil(total / pageSize);
    return NextResponse.json({
      data: rows.map((r) => ({
        id: r.id,
        intervalStart: r.intervalStart.toISOString(),
        intervalEnd: r.intervalEnd.toISOString(),
        keystrokeCount: r.keystrokeCount,
        activeTypingSeconds: r.activeTypingSeconds,
        application: r.application,
      })),
      total,
      page,
      pageSize,
      totalPages,
      summary: {
        totalKeystrokes: summaryAgg._sum.keystrokeCount ?? 0,
        totalActiveTypingSeconds: summaryAgg._sum.activeTypingSeconds ?? 0,
        intervals: summaryAgg._count.id ?? 0,
      },
      byDay,
      byApplication,
    });
  } catch (error) {
    console.error('Admin keyboard telemetry error:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
