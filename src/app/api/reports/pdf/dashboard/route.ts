import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { generateDashboardReport } from '@/lib/pdf-generator';
import { format, startOfMonth, endOfMonth, startOfDay, endOfDay } from 'date-fns';
import { authError, authenticateRequest, requireSessionOrg, isValidDate, parseJsonBody, BodyParseError } from '@/lib/api';
import { hasRolePermission as hasRole } from '@/lib/auth';
import { NON_INTERNAL_AGENT_ACTIVITY_FILTER } from '@/lib/agent-process';
import { effectiveLiveStatus } from '@/lib/presence';
import { log, requestContext } from '@/lib/logger';

export async function POST(request: NextRequest) {
  try {
    let body: Record<string, unknown>;
    try {
      body = await parseJsonBody(request);
    } catch (e) {
      if (e instanceof BodyParseError) {
        return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
      }
      throw e;
    }
    const { dateFrom, dateTo } = body as { dateFrom?: string; dateTo?: string };

    // S-3: report generation requires manager-or-above.
    const auth = await authenticateRequest(request);
    if (!auth) return authError({ ok: false, status: 401 });
    if (!hasRole(auth.role, 'manager')) return authError({ ok: false, status: 403 });

    // Authentication + tenant isolation: the report is generated from the
    // caller's org data only (org-less super_admin sees the global view).
    const scope = await requireSessionOrg(request, { allowGlobal: true });
    if (!scope.ok) return authError(scope);

    // Models WITH an organizationId column (employee/device/alert/project/
    // department) are filtered directly; Activity has NO organizationId so it
    // is scoped through the employee relation (see activityOrgFilter below).
    const orgFilter = scope.organizationId ? { organizationId: scope.organizationId } : {};
    const activityOrgFilter = scope.organizationId
      ? { employee: { organizationId: scope.organizationId } }
      : {};

    // Parse date range — default to current month if not provided
    const startDate = dateFrom ? new Date(dateFrom) : startOfMonth(new Date());
    const endDate = dateTo ? new Date(dateTo) : endOfMonth(new Date());
    if (!isValidDate(startDate) || !isValidDate(endDate)) {
      return NextResponse.json(
        { error: 'Invalid date range. Provide valid ISO dates for dateFrom/dateTo.' },
        { status: 422 },
      );
    }

    // ── Parallelize all independent queries ──
    const todayStart = startOfDay(new Date());
    const todayEnd = endOfDay(new Date());
    const activityWhereBase = {
      timestamp: { gte: startDate, lte: endDate },
      ...activityOrgFilter,
      ...NON_INTERNAL_AGENT_ACTIVITY_FILTER,
    };

    const [
      org,
      totalEmployees,
      orgDevices,
      totalAggregate,
      productiveAggregate,
      todayAggregate,
      alertsPending,
      projectsActive,
    ] = await Promise.all([
      // Organization
      scope.organizationId
        ? db.organization.findUnique({ where: { id: scope.organizationId }, select: { name: true } })
        : Promise.resolve(null),
      // Total employees count
      db.employee.count({ where: { status: 'active', ...orgFilter } }),
      // Active devices
      db.device.findMany({ where: orgFilter, select: { status: true, lastHeartbeat: true } }),
      // Total activity duration
      db.activity.aggregate({ where: activityWhereBase, _sum: { duration: true } }),
      // Productive activity duration
      db.activity.aggregate({ where: { ...activityWhereBase, category: 'productive' }, _sum: { duration: true } }),
      // Today's hours
      db.activity.aggregate({
        where: { timestamp: { gte: todayStart, lte: todayEnd }, ...activityOrgFilter, ...NON_INTERNAL_AGENT_ACTIVITY_FILTER },
        _sum: { duration: true },
      }),
      // Pending alerts
      db.alert.count({ where: { status: 'pending', ...orgFilter } }),
      // Active projects
      db.project.count({ where: { status: 'active', ...orgFilter } }),
    ]);

    const activeDevices = orgDevices.filter(
      (d) => effectiveLiveStatus(d.status, d.lastHeartbeat) === 'online'
    ).length;

    const totalDurationAll = totalAggregate._sum.duration || 0;
    const productiveDurationAll = productiveAggregate._sum.duration || 0;
    const avgProductivity =
      totalDurationAll > 0
        ? Math.round((productiveDurationAll / totalDurationAll) * 100)
        : 0;

    const totalHoursToday = parseFloat(
      ((todayAggregate._sum.duration || 0) / 3600).toFixed(1),
    );

    // ── Department breakdown + Top performers via single GROUP BY queries ──
    // Instead of N+1 per-department and per-employee queries, we use two
    // single GROUP BY queries that return all the data we need.

    // Single query: total duration per employee
    const empTotalAgg = await db.activity.groupBy({
      by: ['employeeId'],
      where: activityWhereBase,
      _sum: { duration: true },
    });

    // Single query: productive duration per employee
    const empProductiveAgg = await db.activity.groupBy({
      by: ['employeeId'],
      where: { ...activityWhereBase, category: 'productive' },
      _sum: { duration: true },
    });

    // Build a lookup map for productive durations
    const productiveMap = new Map<string, number>();
    for (const row of empProductiveAgg) {
      productiveMap.set(row.employeeId, row._sum.duration || 0);
    }

    // Fetch active employees with department info (needed for both breakdowns)
    const activeEmployees = await db.employee.findMany({
      where: { status: 'active', ...orgFilter },
      select: { id: true, firstName: true, lastName: true, departmentId: true, department: { select: { name: true } } },
    });

    // Build employee stats lookup
    const empStatsMap = new Map<string, { name: string; department: string; totalDuration: number; productiveDuration: number }>();
    for (const emp of activeEmployees) {
      const totalDur = empTotalAgg.find((r) => r.employeeId === emp.id)?._sum.duration || 0;
      empStatsMap.set(emp.id, {
        name: `${emp.firstName} ${emp.lastName}`,
        department: emp.department?.name || 'N/A',
        totalDuration: totalDur,
        productiveDuration: productiveMap.get(emp.id) || 0,
      });
    }

    // Department breakdown: group employees by departmentId
    const deptMap = new Map<string, { name: string; employeeIds: string[] }>();
    for (const emp of activeEmployees) {
      const deptId = emp.departmentId || 'none';
      const deptName = emp.department?.name || 'Unassigned';
      if (!deptMap.has(deptId)) deptMap.set(deptId, { name: deptName, employeeIds: [] });
      deptMap.get(deptId)!.employeeIds.push(emp.id);
    }

    const departmentBreakdown = Array.from(deptMap.values()).map((dept) => {
      let deptTotal = 0;
      let deptProductive = 0;
      for (const empId of dept.employeeIds) {
        const stats = empStatsMap.get(empId);
        if (stats) {
          deptTotal += stats.totalDuration;
          deptProductive += stats.productiveDuration;
        }
      }
      return {
        name: dept.name,
        employees: dept.employeeIds.length,
        avgProductivity: deptTotal > 0 ? Math.round((deptProductive / deptTotal) * 100) : 0,
        totalHours: parseFloat((deptTotal / 3600).toFixed(1)),
      };
    });

    // Top 5 performers: compute from the pre-fetched data
    const topPerformers = Array.from(empStatsMap.values())
      .map((s) => ({
        name: s.name,
        department: s.department,
        hours: parseFloat((s.totalDuration / 3600).toFixed(1)),
        productivity: s.totalDuration > 0 ? Math.round((s.productiveDuration / s.totalDuration) * 100) : 0,
      }))
      .sort((a, b) => b.productivity - a.productivity)
      .slice(0, 5);

    const top5Performers = topPerformers;

    // ── Device status summary ──
    const devices = await db.device.findMany({
      where: orgFilter,
      select: {
        name: true,
        status: true,
        lastHeartbeat: true,
      },
      take: 50,
    });
    const deviceStatus = devices.map((d) => ({
      device: d.name,
      status: d.status,
      lastHeartbeat: d.lastHeartbeat || new Date(),
    }));

    // ── Recent 10 alerts ──
    const recentAlerts = await db.alert.findMany({
      where: orgFilter,
      orderBy: { createdAt: 'desc' },
      take: 10,
    });

    // ── Active projects ──
    const activeProjects = await db.project.findMany({
      where: { status: 'active', ...orgFilter },
      include: {
        members: { select: { id: true } },
      },
    });

    const activeProjectsData = activeProjects.map((p) => ({
      name: p.name,
      status: p.status,
      progress: 0,
      members: p.members.length,
      deadline: p.deadline || 'N/A',
    }));

    // Generate PDF
    const pdfBuffer = await generateDashboardReport(
      { name: org?.name || 'OmniSight' },
      {
        totalEmployees,
        activeDevices,
        avgProductivity,
        totalHoursToday,
        alertsPending,
        projectsActive,
        departmentBreakdown,
        topPerformers: top5Performers,
        deviceStatus,
        recentAlerts: recentAlerts.map((a) => ({
          id: a.id,
          title: a.title,
          severity: a.severity,
          status: a.status,
          createdAt: a.createdAt,
          description: a.description,
        })),
        activeProjects: activeProjectsData,
      },
      {
        dateRange: { start: startDate, end: endDate },
        organization: org?.name || 'OmniSight',
      },
    );

    const filename = `dashboard-report-${format(new Date(), 'yyyy-MM-dd')}.pdf`;

    return new NextResponse(new Uint8Array(pdfBuffer), {
      headers: {
        'Content-Type': 'application/pdf',
        'Content-Disposition': `attachment; filename="${filename}"`,
      },
    });
  } catch (error) {
    log.error('api.reports.pdf.dashboard.', { error: String('PDF generation error:') }, requestContext(request));
    return NextResponse.json(
      { error: 'Failed to generate report' },
      { status: 500 },
    );
  }
}
