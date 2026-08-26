import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { authError, requireSessionOrg } from '@/lib/api';
import { EMPLOYEE_ONLINE_THRESHOLD_MS } from '@/lib/presence';
import { orgDayWindow, safeTimezone } from '@/lib/timezone';
import { sessionDurationSeconds } from '@/lib/breaks/service';
import { log, requestContext } from '@/lib/logger';

// GET /api/break-status/summary
// Organization-scoped summary stats for Break Monitor.
//
// All metrics are deterministic server-side queries over canonical
// BreakSession state + DB aggregation — no "latest N activity rows"
// heuristics, no client-side approximation:
//   - currentlyOnBreak      → open BreakSession rows
//   - activeNow             → employees with activity/presence within the
//                             presence threshold (not on break)
//   - offlineToday          → active employees with NO activity in the
//                             org-local day and no open break
//   - avgBreakTimeToday     → mean duration PER break session (completed and
//                             open) overlapping the org-local day
//   - breakByDepartment     → open breaks grouped by the employee's department
export async function GET(req: NextRequest) {
  try {
    const scope = await requireSessionOrg(req, { allowGlobal: true });
    if (!scope.ok) return authError(scope);
    if (!scope.organizationId) {
      return NextResponse.json({
        totalEmployees: 0, currentlyOnBreak: 0, activeNow: 0, offlineToday: 0,
        avgBreakTimeToday: 0, totalBreakTimeToday: 0, breakCountToday: 0, breakByDepartment: [],
      });
    }
    const orgId = scope.organizationId;

    const org = await db.organization.findUnique({
      where: { id: orgId },
      select: { timezone: true },
    });
    const timezone = safeTimezone(org?.timezone);
    const { dayStart, dayEnd } = orgDayWindow(timezone);
    const now = new Date();
    const activeWindow = new Date(now.getTime() - EMPLOYEE_ONLINE_THRESHOLD_MS);

    // All active employees (bounded by org employee count).
    const allEmployees = await db.employee.findMany({
      where: { status: 'active', organizationId: orgId },
      select: { id: true, departmentId: true, department: { select: { id: true, name: true } } },
    });
    const empIds = allEmployees.map((e) => e.id);
    const totalEmployees = allEmployees.length;

    // Open breaks (canonical state).
    const openSessions = await db.breakSession.findMany({
      where: { organizationId: orgId, endedAt: null, employeeId: { in: empIds } },
      select: { employeeId: true, startedAt: true, endedAt: true },
    });
    const openByEmployee = new Set(openSessions.map((s) => s.employeeId));
    const currentlyOnBreak = openSessions.length;

    // Today's sessions (org-local day) for duration + count.
    const todaySessions = await db.breakSession.findMany({
      where: {
        organizationId: orgId,
        employeeId: { in: empIds },
        startedAt: { lt: new Date(dayEnd.getTime() + 1) },
        OR: [{ endedAt: null }, { endedAt: { gte: dayStart } }],
      },
      select: { employeeId: true, startedAt: true, endedAt: true },
    });

    let totalBreakSeconds = 0;
    for (const s of todaySessions) {
      totalBreakSeconds += sessionDurationSeconds(s, dayStart, dayEnd, now);
    }
    const breakCountToday = todaySessions.length;
    const avgBreakTimeToday =
      breakCountToday > 0 ? Math.round(totalBreakSeconds / breakCountToday / 60) : 0;
    const totalBreakTimeToday = Math.round(totalBreakSeconds / 60);

    // Activity today (org-local day) — DB groupBy, deterministic.
    const activityTodayRows = await db.activity.groupBy({
      by: ['employeeId'],
      where: {
        employeeId: { in: empIds },
        timestamp: { gte: dayStart },
        type: { not: 'idle' },
      },
    });
    const activityToday = new Set(activityTodayRows.map((r) => r.employeeId));

    // Recent activity (presence window) for "active now".
    const recentRows = await db.activity.groupBy({
      by: ['employeeId'],
      where: {
        employeeId: { in: empIds },
        timestamp: { gte: activeWindow },
        type: { not: 'idle' },
      },
    });
    const recentlyActive = new Set(recentRows.map((r) => r.employeeId));

    const freshDevices = await db.device.findMany({
      where: {
        organizationId: orgId,
        employeeId: { in: empIds },
        lastHeartbeat: { gt: activeWindow },
      },
      select: { employeeId: true },
      distinct: ['employeeId'],
    });
    const freshDeviceEmployees = new Set(freshDevices.map((d) => d.employeeId));

    let activeNow = 0;
    let offlineToday = 0;
    for (const emp of allEmployees) {
      if (openByEmployee.has(emp.id)) continue; // on break
      if (recentlyActive.has(emp.id) || freshDeviceEmployees.has(emp.id)) {
        activeNow += 1;
      }
      if (!activityToday.has(emp.id)) {
        offlineToday += 1;
      }
    }

    // Department breakdown of CURRENTLY on-break employees.
    const deptMap = new Map<string, { name: string; total: number; onBreak: number }>();
    for (const emp of allEmployees) {
      const deptId = emp.department?.id || 'none';
      const deptName = emp.department?.name || 'Unassigned';
      const entry = deptMap.get(deptId) || { name: deptName, total: 0, onBreak: 0 };
      entry.total += 1;
      if (openByEmployee.has(emp.id)) entry.onBreak += 1;
      deptMap.set(deptId, entry);
    }
    const breakByDepartment = Array.from(deptMap.values())
      .map((dept) => ({
        departmentName: dept.name,
        onBreak: dept.onBreak,
        total: dept.total,
        percentage: dept.total > 0 ? Math.round((dept.onBreak / dept.total) * 100) : 0,
      }))
      .sort((a, b) => b.percentage - a.percentage);

    return NextResponse.json({
      totalEmployees,
      currentlyOnBreak,
      activeNow,
      offlineToday,
      avgBreakTimeToday,
      totalBreakTimeToday,
      breakCountToday,
      breakByDepartment,
      timezone,
    });
  } catch (error) {
    log.error('api.break-status.summary.', { error: String('Break summary error:') }, requestContext(req));
    return NextResponse.json({ error: 'Failed to fetch break summary' }, { status: 500 });
  }
}
