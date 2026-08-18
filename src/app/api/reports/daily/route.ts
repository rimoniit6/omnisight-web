import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { authError, getSessionOrg, requireManagerOrg, parseJsonBody, BodyParseError, isValidDate } from '@/lib/api';
import { excludeInternalAgentActivities } from '@/lib/agent-process';
import { localDayKey, zonedDayStart, zonedDayEnd, safeTimezone } from '@/lib/timezone';
import { effectiveLiveStatus } from '@/lib/presence';
import { sessionDurationSeconds } from '@/lib/breaks/service';

// POST /api/reports/daily
// Generate a daily summary report for a given date
export async function POST(req: NextRequest) {
  try {
    // S-3: daily report generation requires manager-or-above.
    const scope = await requireManagerOrg(req);
    if (!scope.ok) return authError(scope);

    let body: Record<string, unknown>;
    try {
      body = await parseJsonBody(req);
    } catch (e) {
      if (e instanceof BodyParseError) {
        return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
      }
      throw e;
    }
    const { date } = body as { date?: string };

    // Tenant isolation: org identity comes from the authenticated session.
    const sessionOrg = await getSessionOrg(req);
    const org = sessionOrg
      ? await db.organization.findUnique({ where: { id: sessionOrg.id } })
      : null;
    if (!org) {
      return NextResponse.json({ error: 'No organization found' }, { status: 404 });
    }

    // Org-local calendar day (S-6 / F-06): the report's window uses the
    // ORGANIZATION timezone — never server-local midnight. A specified date
    // is interpreted as a YYYY-MM-DD local day key; absent → today (local).
    const timezone = safeTimezone(org.timezone);
    let dayKey: string;
    if (date) {
      const parsed = new Date(date);
      if (!isValidDate(parsed)) {
        return NextResponse.json({ error: 'Invalid date. Provide a valid ISO date (e.g. 2026-08-13).' }, { status: 422 });
      }
      dayKey = /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : localDayKey(parsed, timezone);
    } else {
      dayKey = localDayKey(new Date(), timezone);
    }
    const targetDate = zonedDayStart(dayKey, timezone);
    const nextDay = new Date(zonedDayEnd(dayKey, timezone).getTime() + 1);

    // Get active employee count
    const activeEmployees = await db.employee.count({
      where: { status: 'active', organizationId: org.id },
    });

    // Get all activities for the day — ALWAYS scoped to the caller's org via
    // the employee relation (Activity has no organizationId column).
    const activities = excludeInternalAgentActivities(await db.activity.findMany({
      where: {
        timestamp: { gte: targetDate, lt: nextDay },
        employee: { organizationId: org.id },
      },
      include: {
        employee: {
          select: { id: true, firstName: true, lastName: true, employeeId: true, department: { select: { name: true } } },
        },
        device: { select: { id: true, name: true } },
      },
      orderBy: { timestamp: 'asc' },
    }));

    // Calculate summary statistics
    const totalActivities = activities.length;
    let totalDurationSec = 0;
    let productiveSec = 0;
    let neutralSec = 0;
    let unproductiveSec = 0;
    let idleSec = 0;

    const employeeMap = new Map<string, {
      employeeId: string;
      name: string;
      department: string;
      activities: number;
      productiveMin: number;
      neutralMin: number;
      unproductiveMin: number;
      totalMin: number;
      topApps: Map<string, number>;
    }>();

    for (const act of activities) {
      const dur = act.duration || 0;
      totalDurationSec += dur;

      if (act.type === 'idle') {
        idleSec += dur;
      } else if (act.category === 'productive') {
        productiveSec += dur;
      } else if (act.category === 'unproductive') {
        unproductiveSec += dur;
      } else {
        neutralSec += dur;
      }

      // Per-employee stats
      const emp = employeeMap.get(act.employeeId) || {
        employeeId: act.employee.employeeId,
        name: `${act.employee.firstName} ${act.employee.lastName}`,
        department: act.employee.department?.name || 'Unassigned',
        activities: 0,
        productiveMin: 0,
        neutralMin: 0,
        unproductiveMin: 0,
        totalMin: 0,
        topApps: new Map(),
      };
      emp.activities += 1;
      emp.totalMin += Math.round(dur / 60);

      if (act.type === 'idle') {
        // skip app counting for idle
      } else if (act.category === 'productive') {
        emp.productiveMin += Math.round(dur / 60);
      } else if (act.category === 'unproductive') {
        emp.unproductiveMin += Math.round(dur / 60);
      } else {
        emp.neutralMin += Math.round(dur / 60);
      }

      if (act.applicationName) {
        emp.topApps.set(act.applicationName, (emp.topApps.get(act.applicationName) || 0) + dur);
      }

      employeeMap.set(act.employeeId, emp);
    }

    const totalMin = Math.round(totalDurationSec / 60);
    const productivePct = totalMin > 0 ? Math.round((productiveSec / totalDurationSec) * 100) : 0;
    const neutralPct = totalMin > 0 ? Math.round((neutralSec / totalDurationSec) * 100) : 0;
    const unproductivePct = totalMin > 0 ? Math.round((unproductiveSec / totalDurationSec) * 100) : 0;
    const idlePct = totalMin > 0 ? Math.round((idleSec / totalDurationSec) * 100) : 0;

    // Sort employees by total time (top performers)
    const employeeStats = Array.from(employeeMap.values())
      .sort((a, b) => b.totalMin - a.totalMin)
      .slice(0, 20) // Top 20
      .map((emp) => ({
        ...emp,
        topApps: Array.from(emp.topApps.entries())
          .sort((a, b) => b[1] - a[1])
          .slice(0, 5)
          .map(([name, sec]) => ({ app: name, minutes: Math.round(sec / 60) })),
      }));

    // Break statistics come from the CANONICAL BreakSession state (org-local
    // day window) — sessions overlapping the day contribute duration; the
    // count is sessions STARTED within the day. This is the same semantics
    // Break Monitor uses (previously the report only counted legacy activity
    // events and never reported break minutes).
    const breakSessions = await db.breakSession.findMany({
      where: {
        organizationId: org.id,
        startedAt: { gte: targetDate, lt: nextDay },
      },
      include: { employee: { select: { firstName: true, lastName: true } } },
      orderBy: { startedAt: 'asc' },
    });
    const breakCount = breakSessions.length;
    const breakMinutes = Math.round(
      breakSessions.reduce((sum, s) => sum + sessionDurationSeconds(s, targetDate, new Date(nextDay.getTime() - 1)), 0) / 60
    );
    const breakActivities = breakSessions.map((s) => ({
      type: 'break_start',
      employeeName: `${s.employee.firstName} ${s.employee.lastName}`.trim(),
      timestamp: s.startedAt,
      endedAt: s.endedAt,
      source: s.source,
    }));

    // Get alerts for the day (org-scoped)
    const alertsCount = await db.alert.count({
      where: {
        createdAt: { gte: targetDate, lt: nextDay },
        organizationId: org.id,
      },
    });

    // Get screenshots count for the day (org-scoped)
    const screenshotsCount = await db.screenshot.count({
      where: {
        capturedAt: { gte: targetDate, lt: nextDay },
        organizationId: org.id,
      },
    });

    // Get online devices — counted by heartbeat freshness, never the sticky
    // status column (an agent that stopped heartbeating is NOT online even if
    // Device.status still reads 'online').
    const orgDevices = await db.device.findMany({
      where: { organizationId: org.id },
      select: { status: true, lastHeartbeat: true },
    });
    const onlineDevices = orgDevices.filter(
      (d) => effectiveLiveStatus(d.status, d.lastHeartbeat) === 'online'
    ).length;

    // DS-P2-1: label the report with the ORG-LOCAL calendar day (previously
    // UTC toISOString shifted the label a day backward for UTC+ zones).
    const reportData = {
      date: dayKey,
      organization: { name: org.name, id: org.id },
      summary: {
        totalEmployees: activeEmployees,
        employeesActive: employeeMap.size,
        totalActivities,
        totalWorkingMinutes: totalMin,
        avgMinutesPerEmployee: employeeMap.size > 0 ? Math.round(totalMin / employeeMap.size) : 0,
        productivityScore: productivePct,
        breakdown: {
          productive: { minutes: Math.round(productiveSec / 60), percent: productivePct },
          neutral: { minutes: Math.round(neutralSec / 60), percent: neutralPct },
          unproductive: { minutes: Math.round(unproductiveSec / 60), percent: unproductivePct },
          idle: { minutes: Math.round(idleSec / 60), percent: idlePct },
        },
        breakCount,
        breakMinutes,
        alertsCount,
        screenshotsCount,
        onlineDevices,
      },
      employeeStats,
      breakActivities,
    };

    // Save as report + audit the generation (actor = verified session user;
    // organization = verified session org). Transactional so a failed audit
    // never leaves an orphan report and a failed save never audits success.
    const { report } = await db.$transaction(async (tx) => {
      const created = await tx.report.create({
        data: {
          title: `Daily Report — ${formatDate(targetDate)}`,
          type: 'productivity',
          format: 'json',
          status: 'generated',
          periodStart: targetDate,
          periodEnd: nextDay,
          data: JSON.stringify(reportData),
          organizationId: org.id,
          generatedBy: scope.userId,
        },
      });
      await tx.auditLog.create({
        data: {
          action: 'create',
          resource: 'report',
          resourceId: created.id,
          description: `Daily report generated for ${formatDate(targetDate)} by ${scope.email}`,
          userId: scope.userId,
          organizationId: org.id,
        },
      });
      return { report: created };
    });

    return NextResponse.json({ reportId: report.id, ...reportData });
  } catch (error) {
    console.error('Daily report generation error:', error);
    return NextResponse.json({ error: 'Failed to generate daily report' }, { status: 500 });
  }
}

function formatDate(d: Date): string {
  return d.toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
}
