'use server';

import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { format, subMonths, endOfMonth, getDay } from 'date-fns';
import { authError, authenticateRequest, getSessionOrg } from '@/lib/api';
import { hasRolePermission } from '@/lib/auth';
import { excludeInternalAgentActivities } from '@/lib/agent-process';

export async function GET(req: NextRequest) {
  try {
    // WM-03: org analytics are admin-surface data — the UI hides the
    // Organization page below admin, so the handler enforces it too (never
    // proxy-only). Viewer/manager get 403; cross-tenant access is still
    // session-scoped below.
    const auth = await authenticateRequest(req);
    if (!auth) return authError({ ok: false, status: 401 });
    if (!hasRolePermission(auth.role, 'admin')) return authError({ ok: false, status: 403 });

    // Tenant isolation: org identity comes from the authenticated session.
    const sessionOrg = await getSessionOrg(req);
    const org = sessionOrg
      ? await db.organization.findUnique({ where: { id: sessionOrg.id } })
      : null;
    if (!org) {
      return NextResponse.json({ error: 'No organization found' }, { status: 404 });
    }

    // Fetch departments with employee counts and manager info
    const departments = await db.department.findMany({
      where: { organizationId: org.id },
      include: {
        manager: { select: { id: true, firstName: true, lastName: true, avatar: true } },
        _count: { select: { employees: true } },
      },
      orderBy: { name: 'asc' },
    });

    // Get all employees for headcount
    const allEmployees = await db.employee.findMany({
      where: { organizationId: org.id },
      include: { department: { select: { name: true } } },
      orderBy: { joinDate: 'desc' },
    });

    const activeCount = allEmployees.filter(e => e.status === 'active').length;
    const inactiveCount = allEmployees.filter(e => e.status === 'inactive').length;
    const onLeaveCount = allEmployees.filter(e => e.status === 'archived' && e.leaveDate).length;

    // Headcount by month (last 6 months)
    const now = new Date();
    const byMonth: Array<{ month: string; count: number }> = [];
    for (let i = 5; i >= 0; i--) {
      const monthDate = subMonths(now, i);
      const end = endOfMonth(monthDate);
      // Cumulative: all employees who joined up to this month
      const cumulative = allEmployees.filter(e => {
        if (!e.joinDate) return false;
        return new Date(e.joinDate) <= end;
      }).length;
      byMonth.push({
        month: format(monthDate, 'MMM yyyy'),
        count: cumulative,
      });
    }

    // Recent hires (last 5 by joinDate)
    const recentHires = allEmployees
      .filter(e => e.joinDate)
      .sort((a, b) => new Date(b.joinDate!).getTime() - new Date(a.joinDate!).getTime())
      .slice(0, 5)
      .map(e => ({
        id: e.id,
        firstName: e.firstName,
        lastName: e.lastName,
        designation: e.designation || 'Team Member',
        department: e.department?.name || 'Unassigned',
        joinDate: e.joinDate!.toISOString(),
        avatar: e.avatar,
      }));

    // Team Heatmap: avg activity hours per department per day of week.
    // Internal agent processes are excluded at the data layer so the
    // monitoring agent never skews team comparison data. SECURITY: the
    // activity set is ALWAYS scoped to the caller's organization via the
    // employee relation — a global scan here would leak foreign departments.
    const activities = excludeInternalAgentActivities(await db.activity.findMany({
      where: { employee: { organizationId: org.id } },
      include: {
        employee: {
          include: { department: { select: { name: true } } },
        },
      },
    }));

    const heatmapMap: Record<string, Record<number, { totalHours: number; totalProductivity: number; count: number }>> = {};

    for (const activity of activities) {
      const deptName = activity.employee.department?.name || 'Unassigned';
      const dayOfWeek = getDay(new Date(activity.timestamp));
      const hours = activity.duration / 3600;
      const productivity = activity.category === 'productive' ? 1 : activity.category === 'neutral' ? 0.5 : 0;

      if (!heatmapMap[deptName]) {
        heatmapMap[deptName] = {};
      }
      if (!heatmapMap[deptName][dayOfWeek]) {
        heatmapMap[deptName][dayOfWeek] = { totalHours: 0, totalProductivity: 0, count: 0 };
      }
      heatmapMap[deptName][dayOfWeek].totalHours += hours;
      heatmapMap[deptName][dayOfWeek].totalProductivity += productivity;
      heatmapMap[deptName][dayOfWeek].count += 1;
    }

    // Reorder days: Mon-Sun
    const dayOrder = [1, 2, 3, 4, 5, 6, 0]; // Mon=1, Tue=2, ..., Sun=0
    const dayLabels = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

    const deptNames = Object.keys(heatmapMap).sort();
    const teamHeatmap: Array<{
      department: string;
      dayOfWeek: string;
      avgHours: number;
      avgProductivity: number;
    }> = [];

    for (const dept of deptNames) {
      for (const dow of dayOrder) {
        const data = heatmapMap[dept][dow];
        teamHeatmap.push({
          department: dept,
          dayOfWeek: dayLabels[dayOrder.indexOf(dow)],
          avgHours: data ? Math.round((data.totalHours / Math.max(1, data.count)) * 100) / 100 : 0,
          avgProductivity: data ? Math.round((data.totalProductivity / Math.max(1, data.count)) * 100) / 100 : 0,
        });
      }
    }

    // Enhanced departments with activity stats
    const enhancedDepartments = await Promise.all(
      departments.map(async (dept) => {
        const deptEmployees = allEmployees.filter(e => e.departmentId === dept.id);
        const deptEmployeeIds = deptEmployees.map(e => e.id);
        const deptActivities = activities.filter(a => deptEmployeeIds.includes(a.employeeId));

        const activeEmployees = deptEmployees.filter(e => e.status === 'active').length;
        const inactiveEmployees = deptEmployees.filter(e => e.status === 'inactive').length;
        const totalHours = Math.round(deptActivities.reduce((sum, a) => sum + a.duration, 0) / 3600 * 100) / 100;
        const productiveActivities = deptActivities.filter(a => a.category === 'productive');
        const avgProductivity = deptActivities.length > 0
          ? Math.round((productiveActivities.length / deptActivities.length) * 100) / 100
          : 0;

        return {
          id: dept.id,
          name: dept.name,
          description: dept.description,
          status: dept.status,
          managerName: dept.manager ? `${dept.manager.firstName} ${dept.manager.lastName}` : null,
          managerAvatar: dept.manager?.avatar || null,
          employeeCount: dept._count.employees,
          activeCount: activeEmployees,
          inactiveCount: inactiveEmployees,
          avgProductivity,
          totalHours,
        };
      })
    );

    return NextResponse.json({
      organization: {
        id: org.id,
        name: org.name,
        email: org.email,
        phone: org.phone,
        address: org.address,
        timezone: org.timezone,
        status: org.status,
      },
      departments: enhancedDepartments,
      headcount: {
        total: allEmployees.length,
        active: activeCount,
        inactive: inactiveCount,
        onLeave: onLeaveCount,
        byMonth,
      },
      teamHeatmap,
      recentHires,
    });
  } catch (error) {
    console.error('Team data GET error:', error);
    return NextResponse.json({ error: 'Failed to fetch team data' }, { status: 500 });
  }
}
