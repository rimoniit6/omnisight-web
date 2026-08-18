import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { authError, requireSessionOrg, validatePagination } from '@/lib/api';
import { orgDayWindow, safeTimezone, zonedDayStart, zonedDayEnd, localDayKey } from '@/lib/timezone';
import { sessionDurationSeconds } from '@/lib/breaks/service';

// GET /api/break-status/history
// Canonical break history from BreakSession rows (NOT audit logs — audit logs
// remain an audit trail only).
//
// Query params:
//   employeeId  optional — restrict to one employee (must belong to the
//               caller's organization; unknown/cross-org → 404)
//   day         optional YYYY-MM-DD — org-local calendar day (default: today
//               in the organization timezone)
//   status      optional all | active | completed (default all)
//   page/pageSize validated via validatePagination
//
// Sessions are returned when they OVERLAP the requested day (a break started
// yesterday that is still running shows today, with duration clamped to the
// day window). Deterministic order: startedAt desc.
export async function GET(req: NextRequest) {
  try {
    const scope = await requireSessionOrg(req, { allowGlobal: true });
    if (!scope.ok) return authError(scope);
    if (!scope.organizationId) {
      return NextResponse.json({ data: [], total: 0, page: 1, pageSize: 20, totalPages: 0, day: null, timezone: 'UTC' });
    }
    const orgId = scope.organizationId;

    const { searchParams } = new URL(req.url);
    const pagination = validatePagination(searchParams, { defaultPageSize: 20, maxPageSize: 100 });
    if (!pagination.ok) {
      return NextResponse.json({ error: pagination.error }, { status: pagination.status });
    }
    const { page, pageSize } = pagination;

    const org = await db.organization.findUnique({
      where: { id: orgId },
      select: { timezone: true },
    });
    const timezone = safeTimezone(org?.timezone);

    const rawDay = searchParams.get('day');
    if (rawDay && !/^\d{4}-\d{2}-\d{2}$/.test(rawDay)) {
      return NextResponse.json({ error: 'day must be a YYYY-MM-DD date' }, { status: 400 });
    }
    const { dayStart, dayEnd } = rawDay
      ? { dayStart: zonedDayStart(rawDay, timezone), dayEnd: zonedDayEnd(rawDay, timezone) }
      : orgDayWindow(timezone);
    const now = new Date();

    // Optional employee filter — org-scoped, concealed with 404.
    const rawEmployee = searchParams.get('employeeId');
    let employeeId: string | undefined;
    if (rawEmployee) {
      const employee = await db.employee.findFirst({
        where: { OR: [{ id: rawEmployee }, { employeeId: rawEmployee }], organizationId: orgId },
        select: { id: true },
      });
      if (!employee) {
        return NextResponse.json({ error: 'Employee not found' }, { status: 404 });
      }
      employeeId = employee.id;
    }

    const statusFilter = searchParams.get('status') || 'all';
    if (!['all', 'active', 'completed'].includes(statusFilter)) {
      return NextResponse.json({ error: "status must be 'all', 'active', or 'completed'" }, { status: 400 });
    }

    const where = {
      organizationId: orgId,
      ...(employeeId ? { employeeId } : {}),
      startedAt: { lt: new Date(dayEnd.getTime() + 1) },
      OR: [{ endedAt: null }, { endedAt: { gte: dayStart } }],
      ...(statusFilter === 'active' ? { endedAt: null } : {}),
      ...(statusFilter === 'completed' ? { endedAt: { not: null } } : {}),
    };

    const [sessions, total] = await Promise.all([
      db.breakSession.findMany({
        where,
        include: {
          employee: {
            select: {
              employeeId: true,
              firstName: true,
              lastName: true,
              department: { select: { name: true } },
            },
          },
        },
        orderBy: { startedAt: 'desc' },
        skip: pagination.skip,
        take: pageSize,
      }),
      db.breakSession.count({ where }),
    ]);

    const data = sessions.map((s) => ({
      id: s.id,
      employeeId: s.employeeId,
      employeeCode: s.employee.employeeId,
      employeeName: `${s.employee.firstName} ${s.employee.lastName}`.trim(),
      department: s.employee.department?.name ?? null,
      source: s.source,
      startedAt: s.startedAt.toISOString(),
      endedAt: s.endedAt ? s.endedAt.toISOString() : null,
      endReason: s.endReason,
      active: s.endedAt === null,
      durationSeconds: Math.round(sessionDurationSeconds(s, dayStart, dayEnd, now)),
    }));

    return NextResponse.json({
      data,
      total,
      page,
      pageSize,
      totalPages: Math.ceil(total / pageSize),
      day: rawDay ?? localDayKey(now, timezone),
      timezone,
    });
  } catch (error) {
    console.error('Break history GET error:', error);
    return NextResponse.json({ error: 'Failed to fetch break history' }, { status: 500 });
  }
}
