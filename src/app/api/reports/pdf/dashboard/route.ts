import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { generateDashboardReport } from '@/lib/pdf-generator';
import { format, startOfMonth, endOfMonth, startOfDay, endOfDay } from 'date-fns';
import { authError, authenticateRequest, requireSessionOrg, isValidDate, parseJsonBody, BodyParseError } from '@/lib/api';
import { hasRolePermission as hasRole } from '@/lib/auth';
import { NON_INTERNAL_AGENT_ACTIVITY_FILTER } from '@/lib/agent-process';
import { effectiveLiveStatus } from '@/lib/presence';

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

    // Fetch organization
    const org = scope.organizationId
      ? await db.organization.findUnique({ where: { id: scope.organizationId }, select: { name: true } })
      : null;

    // ── Total employees count ──
    const totalEmployees = await db.employee.count({
      where: { status: 'active', ...orgFilter },
    });

    // ── Active devices count (heartbeat freshness, never the sticky column) ──
    const orgDevices = await db.device.findMany({
      where: orgFilter,
      select: { status: true, lastHeartbeat: true },
    });
    const activeDevices = orgDevices.filter(
      (d) => effectiveLiveStatus(d.status, d.lastHeartbeat) === 'online'
    ).length;

    // ── Average productivity: total productive duration / total duration in range ──
    // Scoped via the employee relation — NEVER a direct organizationId filter
    // on Activity (that column does not exist → 500).
    const totalAggregate = await db.activity.aggregate({
      where: { timestamp: { gte: startDate, lte: endDate }, ...activityOrgFilter, ...NON_INTERNAL_AGENT_ACTIVITY_FILTER },
      _sum: { duration: true },
    });

    const productiveAggregate = await db.activity.aggregate({
      where: {
        timestamp: { gte: startDate, lte: endDate },
        category: 'productive',
        ...activityOrgFilter,
        ...NON_INTERNAL_AGENT_ACTIVITY_FILTER,
      },
      _sum: { duration: true },
    });

    const totalDurationAll = totalAggregate._sum.duration || 0;
    const productiveDurationAll = productiveAggregate._sum.duration || 0;
    const avgProductivity =
      totalDurationAll > 0
        ? Math.round((productiveDurationAll / totalDurationAll) * 100)
        : 0;

    // ── Total hours today ──
    const todayStart = startOfDay(new Date());
    const todayEnd = endOfDay(new Date());
    const todayAggregate = await db.activity.aggregate({
      where: { timestamp: { gte: todayStart, lte: todayEnd }, ...activityOrgFilter, ...NON_INTERNAL_AGENT_ACTIVITY_FILTER },
      _sum: { duration: true },
    });
    const totalHoursToday = parseFloat(
      ((todayAggregate._sum.duration || 0) / 3600).toFixed(1),
    );

    // ── Pending alerts count ──
    const alertsPending = await db.alert.count({
      where: { status: 'pending', ...orgFilter },
    });

    // ── Active projects count ──
    const projectsActive = await db.project.count({
      where: { status: 'active', ...orgFilter },
    });

    // ── Department breakdown ──
    const departments = await db.department.findMany({
      where: { status: 'active', ...orgFilter },
      include: {
        employees: {
          where: { status: 'active' },
          select: { id: true },
        },
      },
    });

    const departmentBreakdown = await Promise.all(
      departments.map(async (dept) => {
        const deptEmployeeIds = dept.employees.map((e) => e.id);
        const deptTotalResult = await db.activity.aggregate({
          where: {
            employeeId: { in: deptEmployeeIds },
            timestamp: { gte: startDate, lte: endDate },
            ...NON_INTERNAL_AGENT_ACTIVITY_FILTER,
          },
          _sum: { duration: true },
        });
        const deptProductiveResult = await db.activity.aggregate({
          where: {
            employeeId: { in: deptEmployeeIds },
            category: 'productive',
            timestamp: { gte: startDate, lte: endDate },
            ...NON_INTERNAL_AGENT_ACTIVITY_FILTER,
          },
          _sum: { duration: true },
        });
        const deptTotal = deptTotalResult._sum.duration || 0;
        const deptProductive = deptProductiveResult._sum.duration || 0;
        return {
          name: dept.name,
          employees: dept.employees.length,
          avgProductivity:
            deptTotal > 0
              ? Math.round((deptProductive / deptTotal) * 100)
              : 0,
          totalHours: parseFloat((deptTotal / 3600).toFixed(1)),
        };
      }),
    );

    // ── Top 5 performers by productivity score in date range ──
    const employeesWithActivity = await db.employee.findMany({
      where: { status: 'active', ...orgFilter },
      include: { department: true },
    });

    const topPerformers = await Promise.all(
      employeesWithActivity.map(async (emp) => {
        const empTotalResult = await db.activity.aggregate({
          where: {
            employeeId: emp.id,
            timestamp: { gte: startDate, lte: endDate },
            ...NON_INTERNAL_AGENT_ACTIVITY_FILTER,
          },
          _sum: { duration: true },
        });
        const empProductiveResult = await db.activity.aggregate({
          where: {
            employeeId: emp.id,
            category: 'productive',
            timestamp: { gte: startDate, lte: endDate },
            ...NON_INTERNAL_AGENT_ACTIVITY_FILTER,
          },
          _sum: { duration: true },
        });
        const empTotal = empTotalResult._sum.duration || 0;
        const empProductive = empProductiveResult._sum.duration || 0;
        return {
          name: `${emp.firstName} ${emp.lastName}`,
          department: emp.department?.name || 'N/A',
          hours: parseFloat((empTotal / 3600).toFixed(1)),
          productivity:
            empTotal > 0
              ? Math.round((empProductive / empTotal) * 100)
              : 0,
        };
      }),
    );

    topPerformers.sort((a, b) => b.productivity - a.productivity);
    const top5Performers = topPerformers.slice(0, 5);

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
    console.error('PDF generation error:', error);
    return NextResponse.json(
      { error: 'Failed to generate report' },
      { status: 500 },
    );
  }
}
