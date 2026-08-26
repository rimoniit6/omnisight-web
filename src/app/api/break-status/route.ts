import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { authError, requireSessionOrg, validatePagination } from '@/lib/api';
import { EMPLOYEE_ONLINE_THRESHOLD_MS, LIFECYCLE_PINNED_STATUSES } from '@/lib/presence';
import { orgDayWindow, safeTimezone } from '@/lib/timezone';
import { log, requestContext } from '@/lib/logger';
import {
  getCurrentBreak,
  sessionDurationSeconds,
} from '@/lib/breaks/service';

// GET /api/break-status
// Returns all employees with their current break/privacy status.
//
// Tenant isolation: organization-scoped from the verified session — never
// from client input. Org-less super_admins get an empty payload.
//
// Deterministic, canonical data (no "latest N activity rows" heuristics):
//   - break state  → open BreakSession rows (single source of truth)
//   - last activity→ DB groupBy (_max timestamp) per employee
//   - active window→ presence threshold (EMPLOYEE_ONLINE_THRESHOLD_MS) or a
//                    fresh device heartbeat
//   - "today"      → Organization.timezone day boundary (orgDayWindow)
// Pagination is validated (page/pageSize → 4xx on garbage) and applied
// server-side.
export async function GET(req: NextRequest) {
  try {
    const scope = await requireSessionOrg(req, { allowGlobal: true });
    if (!scope.ok) return authError(scope);
    if (!scope.organizationId) {
      return NextResponse.json({ data: [], total: 0, page: 1, pageSize: 20, totalPages: 0, currentlyOnBreak: 0 });
    }
    const orgId = scope.organizationId;

    const { searchParams } = new URL(req.url);
    const pagination = validatePagination(searchParams, { defaultPageSize: 20, maxPageSize: 200 });
    if (!pagination.ok) {
      return NextResponse.json({ error: pagination.error }, { status: pagination.status });
    }
    const { page, pageSize } = pagination;
    const statusFilter = searchParams.get('status') || 'all';
    const search = searchParams.get('search') || '';

    const org = await db.organization.findUnique({
      where: { id: orgId },
      select: { timezone: true },
    });
    const timezone = safeTimezone(org?.timezone);
    const { dayStart, dayEnd } = orgDayWindow(timezone);
    const now = new Date();
    const activeWindow = new Date(now.getTime() - EMPLOYEE_ONLINE_THRESHOLD_MS);

    const employeeWhere = {
      organizationId: orgId,
      status: 'active',
      ...(search
        ? {
            OR: [
              { firstName: { contains: search } },
              { lastName: { contains: search } },
              { employeeId: { contains: search } },
            ],
          }
        : {}),
    };

    // Light id pass for correct filter-then-paginate semantics. Bounded by the
    // organization's employee count (NOT by telemetry volume — activity and
    // break lookups below are index-bounded).
    const matchingEmployees = await db.employee.findMany({
      where: employeeWhere,
      select: { id: true, firstName: true, lastName: true, employeeId: true },
      orderBy: { firstName: 'asc' },
    });
    const matchingIds = matchingEmployees.map((e) => e.id);

    // Canonical break state — one query, org-wide.
    const openSessions = await db.breakSession.findMany({
      where: { organizationId: orgId, endedAt: null },
      select: { employeeId: true, startedAt: true },
    });
    const openByEmployee = new Map(openSessions.map((s) => [s.employeeId, s.startedAt]));

    // Today's break sessions (org-local day) for duration math.
    const todaySessions = await db.breakSession.findMany({
      where: {
        organizationId: orgId,
        startedAt: { lt: new Date(dayEnd.getTime() + 1) },
        OR: [{ endedAt: null }, { endedAt: { gte: dayStart } }],
      },
      select: { employeeId: true, startedAt: true, endedAt: true },
    });
    const todayByEmployee = new Map<string, Array<{ startedAt: Date; endedAt: Date | null }>>();
    for (const s of todaySessions) {
      const arr = todayByEmployee.get(s.employeeId) || [];
      arr.push(s);
      todayByEmployee.set(s.employeeId, arr);
    }

    // Fresh-heartbeat presence (devices) — org-wide, bounded by org device count.
    const freshDevices = await db.device.findMany({
      where: {
        organizationId: orgId,
        employeeId: { in: matchingIds },
        status: { notIn: [...LIFECYCLE_PINNED_STATUSES] },
        lastHeartbeat: { gt: activeWindow },
      },
      select: { employeeId: true },
      distinct: ['employeeId'],
    });
    const freshDeviceEmployees = new Set(freshDevices.map((d) => d.employeeId));

    // Last activity per employee — DB groupBy (deterministic, index-assisted).
    // Bounded to the last 90 days; anything older reads as "no recent activity".
    const lastActivityRows = await db.activity.groupBy({
      by: ['employeeId'],
      where: {
        employeeId: { in: matchingIds },
        timestamp: { gte: new Date(now.getTime() - 90 * 24 * 60 * 60 * 1000) },
      },
      _max: { timestamp: true },
    });
    const lastActivityByEmployee = new Map(
      lastActivityRows.map((r) => [r.employeeId, r._max.timestamp])
    );

    // Per-employee status (deterministic).
    type RowStatus = 'breaking' | 'active' | 'offline';
    const statusByEmployee = new Map<string, RowStatus>();
    for (const emp of matchingEmployees) {
      if (openByEmployee.has(emp.id)) {
        statusByEmployee.set(emp.id, 'breaking');
        continue;
      }
      const last = lastActivityByEmployee.get(emp.id);
      const active = (last && last >= activeWindow) || freshDeviceEmployees.has(emp.id);
      statusByEmployee.set(emp.id, active ? 'active' : 'offline');
    }

    // Status filter (applied before pagination, server-side).
    const filtered = matchingEmployees.filter((e) => {
      const s = statusByEmployee.get(e.id);
      if (statusFilter === 'breaking') return s === 'breaking';
      if (statusFilter === 'active') return s === 'active';
      if (statusFilter === 'offline') return s === 'offline';
      return true;
    });

    const total = filtered.length;
    const totalPages = Math.ceil(total / pageSize);
    const pageRows = filtered.slice((page - 1) * pageSize, page * pageSize);
    const pageIds = pageRows.map((e) => e.id);

    // Full page rows (department + live device).
    const employees = await db.employee.findMany({
      where: { id: { in: pageIds } },
      include: {
        department: { select: { id: true, name: true } },
        devices: {
          where: {
            status: { notIn: [...LIFECYCLE_PINNED_STATUSES] },
            lastHeartbeat: { gt: activeWindow },
          },
          select: { id: true, name: true, hostname: true, status: true, lastHeartbeat: true },
          take: 1,
          orderBy: { lastHeartbeat: 'desc' },
        },
      },
    });
    const employeeById = new Map(employees.map((e) => [e.id, e]));

    const data = pageRows.map((row) => {
      const emp = employeeById.get(row.id);
      const breakStart = openByEmployee.get(row.id);
      const sessions = todayByEmployee.get(row.id) || [];
      const breakTimeSeconds = sessions.reduce(
        (sum, s) => sum + sessionDurationSeconds(s, dayStart, dayEnd, now),
        0
      );
      return {
        id: row.id,
        employeeId: row.employeeId,
        firstName: row.firstName,
        lastName: row.lastName,
        avatar: emp?.avatar ?? null,
        designation: emp?.designation ?? null,
        department: emp?.department ?? null,
        device: emp?.devices[0] ?? null,
        status: statusByEmployee.get(row.id),
        isOnBreak: breakStart !== undefined,
        breakStartedAt: breakStart ? breakStart.toISOString() : null,
        lastActivity: lastActivityByEmployee.get(row.id)?.toISOString() ?? null,
        breakTimeToday: Math.round(breakTimeSeconds / 60),
      };
    });

    // Org-wide current-break count (all active employees, not just the page).
    const currentlyOnBreak = openSessions.filter((s) =>
      matchingEmployees.some((e) => e.id === s.employeeId)
    ).length;

    return NextResponse.json({
      data,
      total,
      page,
      pageSize,
      totalPages,
      currentlyOnBreak,
      timezone,
    });
  } catch (error) {
    log.error('api.break-status.', { error: String('Break status GET error:') }, requestContext(req));
    return NextResponse.json({ error: 'Failed to fetch break status' }, { status: 500 });
  }
}
