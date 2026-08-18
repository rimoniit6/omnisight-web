'use server';
import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { authError, requireManagerOrg, isValidDate, parseJsonBody, BodyParseError } from '@/lib/api';
import { parseBoundedRange } from '@/lib/export';
import { excludeInternalAgentActivities } from '@/lib/agent-process';
import { effectiveLiveStatus } from '@/lib/presence';

type ReportType = 'productivity' | 'attendance' | 'activity' | 'department' | 'device' | 'employee';

// WM-02: cap the materialized activity window for every report computation.
// Ranges are already bounded to 90 days at the boundary (parseBoundedRange);
// this cap additionally bounds per-employee/per-org row counts so generation
// can never load the whole table into memory. The response carries a
// `truncated` flag when the cap was hit.
const REPORT_SCAN_CAP = 50_000;

export async function POST(req: NextRequest) {
  try {
    // S-3: report generation requires manager-or-above.
    const scope = await requireManagerOrg(req);
    if (!scope.ok) return authError(scope);
    const orgId = scope.organizationId;

    let body: Record<string, unknown>;
    try {
      body = await parseJsonBody(req);
    } catch (e) {
      if (e instanceof BodyParseError) {
        return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
      }
      throw e;
    }
    const {
      type,
      employeeId,
      departmentId,
      periodStart,
      periodEnd,
    } = body as {
      type: ReportType;
      employeeId?: string;
      departmentId?: string;
      periodStart?: string;
      periodEnd?: string;
    };

    if (!type) {
      return NextResponse.json({ error: 'Report type is required' }, { status: 400 });
    }

    const startDate = periodStart ? new Date(periodStart) : new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
    const endDate = periodEnd ? new Date(periodEnd) : new Date();
    if (!isValidDate(startDate) || !isValidDate(endDate)) {
      return NextResponse.json({ error: 'Invalid period. Provide valid ISO dates for periodStart/periodEnd.' }, { status: 422 });
    }

    // WM-02 / WM-04: inverted ranges and windows wider than 90 days are
    // rejected up front — generation must never materialize the whole table.
    const bounded = parseBoundedRange(
      periodStart ? new Date(periodStart).toISOString() : '',
      periodEnd ? new Date(periodEnd).toISOString() : ''
    );
    if (bounded.error) {
      return NextResponse.json({ error: bounded.error.message }, { status: bounded.error.status });
    }

    // Compute report data based on type
    let reportData: Record<string, unknown>;
    let title: string;

    switch (type) {
      case 'productivity': {
        const result = await computeProductivityReport(orgId, startDate, endDate);
        reportData = result;
        title = `Productivity Report — ${formatDateRange(startDate, endDate)}`;
        break;
      }
      case 'attendance': {
        const result = await computeAttendanceReport(orgId, startDate, endDate);
        reportData = result;
        title = `Attendance Report — ${formatDateRange(startDate, endDate)}`;
        break;
      }
      case 'activity': {
        const result = await computeActivityReport(orgId, startDate, endDate);
        reportData = result;
        title = `Activity Report — ${formatDateRange(startDate, endDate)}`;
        break;
      }
      case 'department': {
        if (!departmentId) {
          return NextResponse.json({ error: 'Department ID is required for department reports' }, { status: 400 });
        }
        const dept = await db.department.findUnique({ where: { id: departmentId, organizationId: orgId }, select: { name: true } });
        if (!dept) {
          return NextResponse.json({ error: 'Department not found in your organization' }, { status: 404 });
        }
        const result = await computeDepartmentReport(orgId, departmentId, startDate, endDate);
        reportData = result;
        title = `${dept?.name || 'Department'} Report — ${formatDateRange(startDate, endDate)}`;
        break;
      }
      case 'device': {
        const result = await computeDeviceReport(orgId, startDate, endDate);
        reportData = result;
        title = `Device Usage Report — ${formatDateRange(startDate, endDate)}`;
        break;
      }
      case 'employee': {
        if (!employeeId) {
          return NextResponse.json({ error: 'Employee ID is required for employee reports' }, { status: 400 });
        }
        // Tenant isolation: the employee must belong to the caller's org — a
        // foreign employeeId is concealed with 404 and creates NOTHING (no
        // report, no title with a foreign employee's name).
        const emp = await db.employee.findFirst({
          where: { id: employeeId, organizationId: orgId },
          select: { firstName: true, lastName: true },
        });
        if (!emp) {
          return NextResponse.json({ error: 'Employee not found in your organization' }, { status: 404 });
        }
        const result = await computeEmployeeReport(orgId, employeeId, startDate, endDate);
        reportData = result;
        title = `${emp.firstName} ${emp.lastName} Performance Report — ${formatDateRange(startDate, endDate)}`;
        break;
      }
      default:
        return NextResponse.json({ error: `Unknown report type: ${type}` }, { status: 400 });
    }

    // Persist the report and audit the generation in ONE transaction: actor =
    // verified session user, org = verified session org.
    const { report } = await db.$transaction(async (tx) => {
      const created = await tx.report.create({
        data: {
          title,
          type,
          format: 'csv',
          status: 'generated',
          organizationId: orgId,
          periodStart: startDate,
          periodEnd: endDate,
          data: JSON.stringify(reportData),
          generatedBy: scope.userId,
        },
      });
      await tx.auditLog.create({
        data: {
          action: 'create',
          resource: 'report',
          resourceId: created.id,
          description: `${type} report "${title}" generated by ${scope.email}`,
          userId: scope.userId,
          organizationId: orgId,
        },
      });
      return { report: created };
    });

    return NextResponse.json({ data: report }, { status: 201 });
  } catch (error) {
    console.error('Report generate error:', error);
    return NextResponse.json({ error: 'Failed to generate report' }, { status: 500 });
  }
}

function formatDateRange(start: Date, end: Date): string {
  const fmt = (d: Date) => d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
  return `${fmt(start)} to ${fmt(end)}`;
}

// ==================== Productivity Report ====================
async function computeProductivityReport(orgId: string, startDate: Date, endDate: Date) {
  // Internal agent processes are excluded at the data layer (lib/agent-process.ts)
  // so the monitoring agent never counts as employee application usage.    // WM-02: cap the materialized window to the most recent REPORT_SCAN_CAP
    // rows (the response carries a `truncated` flag). A range wider than the
    // cap never loads the whole table.
    const activities = excludeInternalAgentActivities(await db.activity.findMany({
    where: { employee: { organizationId: orgId }, timestamp: { gte: startDate, lte: endDate } },
    include: { employee: { select: { id: true, firstName: true, lastName: true, departmentId: true } } },
    orderBy: { timestamp: 'desc' },
    take: REPORT_SCAN_CAP,
  }));
  const truncated = activities.length === REPORT_SCAN_CAP;

  const totalDuration = activities.reduce((s, a) => s + a.duration, 0);
  const productive = activities.filter(a => a.category === 'productive').reduce((s, a) => s + a.duration, 0);
  const neutral = activities.filter(a => a.category === 'neutral').reduce((s, a) => s + a.duration, 0);
  const unproductive = activities.filter(a => a.category === 'unproductive').reduce((s, a) => s + a.duration, 0);
  const productivityScore = totalDuration > 0 ? Math.round((productive / totalDuration) * 100) : 0;

  // Department breakdown — WM-05: batch the department lookup into ONE query
  // (the previous per-activity findUnique was N+1).
  const deptIds = Array.from(new Set(activities.map((a) => a.employee.departmentId).filter(Boolean) as string[]));
  const deptRows = deptIds.length > 0
    ? await db.department.findMany({ where: { id: { in: deptIds } }, select: { id: true, name: true } })
    : [];
  const deptNameMap = new Map(deptRows.map((d) => [d.id, d.name]));
  const deptMap = new Map<string, { name: string; duration: number; productive: number; count: number }>();
  for (const a of activities) {
    const deptKey = a.employee.departmentId || 'unassigned';
    if (!deptMap.has(deptKey)) {
      deptMap.set(deptKey, { name: deptNameMap.get(deptKey) || 'Unassigned', duration: 0, productive: 0, count: 0 });
    }
    const d = deptMap.get(deptKey)!;
    d.duration += a.duration;
    if (a.category === 'productive') d.productive += a.duration;
    d.count += 1;
  }
  const departmentBreakdown = Array.from(deptMap.entries()).map(([id, d]) => ({
    departmentId: id,
    departmentName: d.name,
    totalHours: Math.round(d.duration / 3600 * 10) / 10,
    productiveHours: Math.round(d.productive / 3600 * 10) / 10,
    productivityScore: d.duration > 0 ? Math.round((d.productive / d.duration) * 100) : 0,
    activityCount: d.count,
  }));

  // Daily trend
  const dayMap = new Map<string, { date: string; duration: number; productive: number; count: number }>();
  for (const a of activities) {
    const day = a.timestamp.toISOString().split('T')[0];
    if (!dayMap.has(day)) dayMap.set(day, { date: day, duration: 0, productive: 0, count: 0 });
    const d = dayMap.get(day)!;
    d.duration += a.duration;
    if (a.category === 'productive') d.productive += a.duration;
    d.count += 1;
  }
  const dailyTrend = Array.from(dayMap.values()).sort((a, b) => a.date.localeCompare(b.date)).map(d => ({
    date: d.date,
    totalHours: Math.round(d.duration / 3600 * 10) / 10,
    productiveHours: Math.round(d.productive / 3600 * 10) / 10,
    productivityScore: d.duration > 0 ? Math.round((d.productive / d.duration) * 100) : 0,
    activityCount: d.count,
  }));

  return {
    summary: {
      totalHours: Math.round(totalDuration / 3600 * 10) / 10,
      productiveHours: Math.round(productive / 3600 * 10) / 10,
      neutralHours: Math.round(neutral / 3600 * 10) / 10,
      unproductiveHours: Math.round(unproductive / 3600 * 10) / 10,
      productivityScore,
      totalActivities: activities.length,
      periodDays: Math.max(1, Math.ceil((endDate.getTime() - startDate.getTime()) / (1000 * 60 * 60 * 24))),
    },
    departmentBreakdown,
    dailyTrend,
    truncated,
  };
}

// ==================== Attendance Report ====================
async function computeAttendanceReport(orgId: string, startDate: Date, endDate: Date) {
  const employees = await db.employee.findMany({
    where: { organizationId: orgId, status: { not: 'archived' } },
    include: {
      department: { select: { name: true } },
      activities: {
        where: { timestamp: { gte: startDate, lte: endDate } },
        select: { timestamp: true, duration: true, applicationName: true },
        orderBy: { timestamp: 'desc' },
        take: REPORT_SCAN_CAP,
      },
    },
  });

  const employeeData = employees.map(e => {
    const empActs = excludeInternalAgentActivities(e.activities);
    const activeDays = new Set(empActs.map(a => a.timestamp.toISOString().split('T')[0])).size;
    const totalDuration = empActs.reduce((s, a) => s + a.duration, 0);
    const periodDays = Math.max(1, Math.ceil((endDate.getTime() - startDate.getTime()) / (1000 * 60 * 60 * 24)));
    const avgDailyHours = activeDays > 0 ? Math.round((totalDuration / 3600 / activeDays) * 10) / 10 : 0;
    const attendanceRate = Math.round((activeDays / periodDays) * 100);
    const firstActivity = empActs[0]?.timestamp?.toISOString() || null;
    const lastActivity = empActs[empActs.length - 1]?.timestamp?.toISOString() || null;

    return {
      employeeId: e.id,
      employeeCode: e.employeeId,
      name: `${e.firstName} ${e.lastName}`,
      department: e.department?.name || 'Unassigned',
      status: e.status,
      activeDays,
      totalHours: Math.round(totalDuration / 3600 * 10) / 10,
      avgDailyHours,
      attendanceRate,
      firstActivity,
      lastActivity,
    };
  });

  const truncated = employees.some((e) => e.activities.length === REPORT_SCAN_CAP);
  const totalEmployees = employees.length;
  const avgAttendance = totalEmployees > 0 ? Math.round(employeeData.reduce((s, e) => s + e.attendanceRate, 0) / totalEmployees) : 0;
  const avgDailyHours = totalEmployees > 0 ? Math.round(employeeData.reduce((s, e) => s + e.avgDailyHours, 0) / totalEmployees * 10) / 10 : 0;

  return {
    summary: {
      totalEmployees,
      avgAttendanceRate: avgAttendance,
      avgDailyHours,
      periodDays: Math.max(1, Math.ceil((endDate.getTime() - startDate.getTime()) / (1000 * 60 * 60 * 24))),
    },
    employees: employeeData,
    truncated,
  };
}

// ==================== Activity Report ====================
async function computeActivityReport(orgId: string, startDate: Date, endDate: Date) {
  const activities = excludeInternalAgentActivities(await db.activity.findMany({
    where: { employee: { organizationId: orgId }, timestamp: { gte: startDate, lte: endDate } },
    orderBy: { timestamp: 'desc' },
    take: REPORT_SCAN_CAP,
  }));
  const truncated = activities.length === REPORT_SCAN_CAP;

  const totalDuration = activities.reduce((s, a) => s + a.duration, 0);

  // Category distribution
  const categoryMap = new Map<string, number>();
  for (const a of activities) {
    const cat = a.category || 'uncategorized';
    categoryMap.set(cat, (categoryMap.get(cat) || 0) + a.duration);
  }
  const categoryDistribution = Array.from(categoryMap.entries()).map(([category, duration]) => ({
    category,
    hours: Math.round(duration / 3600 * 10) / 10,
    percentage: totalDuration > 0 ? Math.round((duration / totalDuration) * 100) : 0,
  }));

  // Application breakdown
  const appMap = new Map<string, number>();
  for (const a of activities) {
    if (a.applicationName) {
      appMap.set(a.applicationName, (appMap.get(a.applicationName) || 0) + a.duration);
    }
  }
  const topApplications = Array.from(appMap.entries())
    .map(([name, duration]) => ({
      name,
      hours: Math.round(duration / 3600 * 10) / 10,
      percentage: totalDuration > 0 ? Math.round((duration / totalDuration) * 100) : 0,
    }))
    .sort((a, b) => b.hours - a.hours)
    .slice(0, 20);

  // Website breakdown
  const webMap = new Map<string, number>();
  for (const a of activities) {
    // Website rows store DOMAIN-ONLY values (privacy-first: full URLs are
    // stripped at ingestion — see lib/domain.ts). A bare domain fails the
    // URL parser, so we normalize defensively and fall back to the stored
    // value, which is already a bare domain.
    if (a.url) {
      try {
        const hostname = new URL(a.url).hostname.replace(/^www\./, '');
        webMap.set(hostname, (webMap.get(hostname) || 0) + a.duration);
      } catch {
        webMap.set(a.url, (webMap.get(a.url) || 0) + a.duration);
      }
    }
  }
  const topWebsites = Array.from(webMap.entries())
    .map(([name, duration]) => ({
      name,
      hours: Math.round(duration / 3600 * 10) / 10,
      percentage: totalDuration > 0 ? Math.round((duration / totalDuration) * 100) : 0,
    }))
    .sort((a, b) => b.hours - a.hours)
    .slice(0, 20);

  return {
    summary: {
      totalActivities: activities.length,
      totalHours: Math.round(totalDuration / 3600 * 10) / 10,
      uniqueApps: appMap.size,
      uniqueWebsites: webMap.size,
    },
    categoryDistribution,
    topApplications,
    topWebsites,
    truncated,
  };
}

// ==================== Department Report ====================
async function computeDepartmentReport(orgId: string, departmentId: string, startDate: Date, endDate: Date) {
  const dept = await db.department.findUnique({
    where: { id: departmentId, organizationId: orgId },
    include: {
      employees: {
        where: { status: { not: 'archived' } },
        include: {
          activities: {
            where: { timestamp: { gte: startDate, lte: endDate } },
            select: { timestamp: true, duration: true, category: true, applicationName: true, type: true },
            orderBy: { timestamp: 'desc' },
            take: REPORT_SCAN_CAP,
          },
        },
      },
      manager: { select: { firstName: true, lastName: true } },
    },
  });

  if (!dept) return { error: 'Department not found' };

  const truncated = dept.employees.some((e) => e.activities.length === REPORT_SCAN_CAP);
  const allActivities = dept.employees.flatMap(e => excludeInternalAgentActivities(e.activities));
  const totalDuration = allActivities.reduce((s, a) => s + a.duration, 0);
  const productive = allActivities.filter(a => a.category === 'productive').reduce((s, a) => s + a.duration, 0);
  const productivityScore = totalDuration > 0 ? Math.round((productive / totalDuration) * 100) : 0;

  const employeeStats = dept.employees.map(e => {
    const empActs = excludeInternalAgentActivities(e.activities);
    const dur = empActs.reduce((s, a) => s + a.duration, 0);
    const prod = empActs.filter(a => a.category === 'productive').reduce((s, a) => s + a.duration, 0);
    const activeDays = new Set(empActs.map(a => a.timestamp.toISOString().split('T')[0])).size;
    return {
      employeeId: e.id,
      name: `${e.firstName} ${e.lastName}`,
      totalHours: Math.round(dur / 3600 * 10) / 10,
      productiveHours: Math.round(prod / 3600 * 10) / 10,
      productivityScore: dur > 0 ? Math.round((prod / dur) * 100) : 0,
      activeDays,
      avgDailyHours: activeDays > 0 ? Math.round((dur / 3600 / activeDays) * 10) / 10 : 0,
    };
  }).sort((a, b) => b.productivityScore - a.productivityScore);

  return {
    departmentName: dept.name,
    manager: dept.manager ? `${dept.manager.firstName} ${dept.manager.lastName}` : null,
    employeeCount: dept.employees.length,
    summary: {
      totalHours: Math.round(totalDuration / 3600 * 10) / 10,
      productiveHours: Math.round(productive / 3600 * 10) / 10,
      productivityScore,
      totalActivities: allActivities.length,
    },
    employees: employeeStats,
    truncated,
  };
}

// ==================== Device Report ====================
async function computeDeviceReport(orgId: string, _startDate: Date, _endDate: Date) {
  const devices = await db.device.findMany({
    where: { organizationId: orgId },
    include: {
      employee: { select: { firstName: true, lastName: true, employeeId: true } },
      activities: {
        where: { timestamp: { gte: _startDate, lte: _endDate } },
        select: { duration: true, timestamp: true },
        orderBy: { timestamp: 'desc' },
        take: REPORT_SCAN_CAP,
      },
    },
  });

  // Sticky Device.status is never liveness evidence — derive effective status.
  const effective = (d: { status: string; lastHeartbeat: Date | null }) => effectiveLiveStatus(d.status, d.lastHeartbeat);
  const onlineCount = devices.filter(d => effective(d) === 'online').length;
  const offlineCount = devices.filter(d => effective(d) === 'offline').length;
  const truncated = devices.some((d) => d.activities.length === REPORT_SCAN_CAP);
  const totalActivity = devices.reduce((s, d) => s + d.activities.reduce((as, a) => as + a.duration, 0), 0);

  const deviceStats = devices.map(d => {
    const dur = d.activities.reduce((s, a) => s + a.duration, 0);
    return {
      deviceId: d.id,
      name: d.name,
      hostname: d.hostname || '',
      operatingSystem: d.operatingSystem || '',
      status: effective(d),
      assignedTo: d.employee ? `${d.employee.firstName} ${d.employee.lastName}` : 'Unassigned',
      totalHours: Math.round(dur / 3600 * 10) / 10,
      activityCount: d.activities.length,
      lastHeartbeat: d.lastHeartbeat?.toISOString() || null,
      onlineRatio: d.activities.length > 0 ? Math.min(100, Math.round((d.activities.length / Math.max(1, devices.reduce((s, dd) => s + dd.activities.length, 0) / devices.length)) * 100)) : 0,
    };
  });

  return {
    summary: {
      totalDevices: devices.length,
      onlineCount,
      offlineCount,
      onlineRatio: devices.length > 0 ? Math.round((onlineCount / devices.length) * 100) : 0,
      totalActivityHours: Math.round(totalActivity / 3600 * 10) / 10,
    },
    devices: deviceStats,
    truncated,
  };
}

// ==================== Employee Report ====================
async function computeEmployeeReport(orgId: string, employeeId: string, startDate: Date, endDate: Date) {
  const employee = await db.employee.findUnique({
    where: { id: employeeId, organizationId: orgId },
    include: {
      department: { select: { name: true } },
      activities: {
        where: { timestamp: { gte: startDate, lte: endDate } },
        select: { timestamp: true, duration: true, category: true, applicationName: true, url: true, type: true },
        orderBy: { timestamp: 'desc' },
        take: REPORT_SCAN_CAP,
      },
    },
  });

  if (!employee) return { error: 'Employee not found' };

  const truncated = employee.activities.length === REPORT_SCAN_CAP;
  const empActs = excludeInternalAgentActivities(employee.activities);
  const totalDuration = empActs.reduce((s, a) => s + a.duration, 0);
  const productive = empActs.filter(a => a.category === 'productive').reduce((s, a) => s + a.duration, 0);
  const neutral = empActs.filter(a => a.category === 'neutral').reduce((s, a) => s + a.duration, 0);
  const unproductive = empActs.filter(a => a.category === 'unproductive').reduce((s, a) => s + a.duration, 0);
  const productivityScore = totalDuration > 0 ? Math.round((productive / totalDuration) * 100) : 0;
  const activeDays = new Set(empActs.map(a => a.timestamp.toISOString().split('T')[0])).size;

  // Top apps
  const appMap = new Map<string, number>();
  for (const a of empActs) {
    if (a.applicationName) appMap.set(a.applicationName, (appMap.get(a.applicationName) || 0) + a.duration);
  }
  const topApps = Array.from(appMap.entries())
    .map(([name, duration]) => ({ name, hours: Math.round(duration / 3600 * 10) / 10, percentage: totalDuration > 0 ? Math.round((duration / totalDuration) * 100) : 0 }))
    .sort((a, b) => b.hours - a.hours)
    .slice(0, 10);

  // Category distribution
  const catMap = new Map<string, number>();
  for (const a of empActs) {
    const cat = a.category || 'uncategorized';
    catMap.set(cat, (catMap.get(cat) || 0) + a.duration);
  }
  const categoryDistribution = Array.from(catMap.entries()).map(([category, duration]) => ({
    category,
    hours: Math.round(duration / 3600 * 10) / 10,
    percentage: totalDuration > 0 ? Math.round((duration / totalDuration) * 100) : 0,
  }));

  return {
    employeeName: `${employee.firstName} ${employee.lastName}`,
    department: employee.department?.name || 'Unassigned',
    summary: {
      totalHours: Math.round(totalDuration / 3600 * 10) / 10,
      productiveHours: Math.round(productive / 3600 * 10) / 10,
      neutralHours: Math.round(neutral / 3600 * 10) / 10,
      unproductiveHours: Math.round(unproductive / 3600 * 10) / 10,
      productivityScore,
      activeDays,
      avgDailyHours: activeDays > 0 ? Math.round((totalDuration / 3600 / activeDays) * 10) / 10 : 0,
      totalActivities: empActs.length,
    },
    topApplications: topApps,
    categoryDistribution,
    truncated,
  };
}
