'use server';

import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { format, subDays } from 'date-fns';
import { authError, requireSessionOrg } from '@/lib/api';
import { NON_INTERNAL_AGENT_ACTIVITY_FILTER, excludeInternalAgentActivities } from '@/lib/agent-process';
import { safeTimezone, zonedDayStart, zonedDayEnd, localDayKey, hourInTimezone } from '@/lib/timezone';
import { log, requestContext } from '@/lib/logger';

/** Defensive normalization of a stored website value to a bare lowercase domain. */
function toDomain(raw: string): string {
  const cleaned = raw.replace(/^https?:\/\/(www\.)?/i, '').split(/[/?#]/)[0].toLowerCase();
  return cleaned.replace(/^www\./, '');
}

export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { searchParams } = new URL(request.url);
  const fromParam = searchParams.get('from');
  const toParam = searchParams.get('to');

  // ── Activity timeline pagination (strict, capped) ───────────────────────
  const rawActivityPage = searchParams.get('activityPage');
  const rawActivityPageSize = searchParams.get('activityPageSize');
  const activityPage = rawActivityPage === null ? 1 : Number(rawActivityPage);
  const activityPageSize = rawActivityPageSize === null ? 50 : Number(rawActivityPageSize);
  if (
    (rawActivityPage !== null && (!Number.isInteger(activityPage) || activityPage < 1)) ||
    (rawActivityPageSize !== null && (!Number.isInteger(activityPageSize) || activityPageSize < 1)) ||
    activityPageSize > 100
  ) {
    return NextResponse.json(
      { error: 'activityPage must be a positive integer and activityPageSize must be between 1 and 100' },
      { status: 422 }
    );
  }

  try {
    const scope = await requireSessionOrg(request, { allowGlobal: true });
    if (!scope.ok) return authError(scope);

    const employee = await db.employee.findFirst({
      where: { id, ...(scope.organizationId ? { organizationId: scope.organizationId } : {}) },
      include: {
        department: true,
        organization: { select: { id: true, name: true, timezone: true } },
        devices: {
          where: { status: { not: 'retired' } },
          orderBy: { registeredAt: 'desc' },
        },
      },
    });

    if (!employee) {
      return NextResponse.json({ error: 'Employee not found' }, { status: 404 });
    }

    // Organization-local day boundaries — "today" means today in the org's
    // timezone (same convention as /api/activities), never the server's UTC
    // midnight.
    const orgTz = safeTimezone(employee.organization?.timezone);

    // Determine date range
    const now = new Date();
    let startDate: Date;
    let endDate: Date;

    if (fromParam && toParam) {
      startDate = zonedDayStart(fromParam, orgTz);
      endDate = zonedDayEnd(toParam, orgTz);
    } else if (fromParam) {
      startDate = zonedDayStart(fromParam, orgTz);
      endDate = now;
    } else {
      startDate = zonedDayStart(localDayKey(subDays(now, 6), orgTz), orgTz);
      endDate = now;
    }

    // Count all-time stats. Internal agent processes are excluded via the
    // shared NOT filter (case-insensitive) so the monitoring agent never
    // contributes to usage duration/counts.
    const allTimeSummary = await db.activity.aggregate({
      where: { employeeId: id, ...NON_INTERNAL_AGENT_ACTIVITY_FILTER },
      _sum: { duration: true },
      _count: { id: true },
    });

    const allTimeProductive = await db.activity.aggregate({
      where: { employeeId: id, category: 'productive', ...NON_INTERNAL_AGENT_ACTIVITY_FILTER },
      _sum: { duration: true },
    });

    const allTimeNeutral = await db.activity.aggregate({
      where: { employeeId: id, category: 'neutral', ...NON_INTERNAL_AGENT_ACTIVITY_FILTER },
      _sum: { duration: true },
    });

    const allTimeUnproductive = await db.activity.aggregate({
      where: { employeeId: id, category: 'unproductive', ...NON_INTERNAL_AGENT_ACTIVITY_FILTER },
      _sum: { duration: true },
    });

    // Paginated activities in date range (internal agent processes excluded
    // with the NULL-safe predicate — website/idle/screenshot/work_session rows
    // are preserved). Timeline and summary stats now agree on the same set.
    const [activitiesPageRows, activitiesTotal] = await Promise.all([
      db.activity.findMany({
        where: {
          employeeId: id,
          timestamp: { gte: startDate, lte: endDate },
          ...NON_INTERNAL_AGENT_ACTIVITY_FILTER,
        },
        orderBy: { timestamp: 'desc' },
        skip: (activityPage - 1) * activityPageSize,
        take: activityPageSize,
        include: {
          device: { select: { id: true, name: true } },
        },
      }),
      db.activity.count({
        where: {
          employeeId: id,
          timestamp: { gte: startDate, lte: endDate },
          ...NON_INTERNAL_AGENT_ACTIVITY_FILTER,
        },
      }),
    ]);
    const activitiesInRange = excludeInternalAgentActivities(activitiesPageRows);

    // Ranged summary (internal agent processes excluded)
    const rangeSummary = await db.activity.aggregate({
      where: { employeeId: id, timestamp: { gte: startDate, lte: endDate }, ...NON_INTERNAL_AGENT_ACTIVITY_FILTER },
      _sum: { duration: true },
      _count: { id: true },
    });

    const rangeProductive = await db.activity.aggregate({
      where: { employeeId: id, category: 'productive', timestamp: { gte: startDate, lte: endDate }, ...NON_INTERNAL_AGENT_ACTIVITY_FILTER },
      _sum: { duration: true },
    });

    const rangeNeutral = await db.activity.aggregate({
      where: { employeeId: id, category: 'neutral', timestamp: { gte: startDate, lte: endDate }, ...NON_INTERNAL_AGENT_ACTIVITY_FILTER },
      _sum: { duration: true },
    });

    const rangeUnproductive = await db.activity.aggregate({
      where: { employeeId: id, category: 'unproductive', timestamp: { gte: startDate, lte: endDate }, ...NON_INTERNAL_AGENT_ACTIVITY_FILTER },
      _sum: { duration: true },
    });

    // Daily productivity for the date range — bucketed by the ORGANIZATION
    // timezone (P2-3): 23:30 UTC belongs to the NEXT local day in Asia/Dhaka.
    // The keys are org-local calendar days, never the server's local zone.
    const rangeSpanDays = Math.max(1, Math.ceil((endDate.getTime() - startDate.getTime()) / (1000 * 60 * 60 * 24)));
    const dailyMap: Record<string, { productive: number; neutral: number; unproductive: number; total: number }> = {};

    // Initialize all days in range (dedupe so a DST-skipped/repeated day can
    // never double-initialize or leave a gap).
    for (let i = rangeSpanDays; i >= 0; i--) {
      const day = localDayKey(subDays(endDate, i), orgTz);
      if (!dailyMap[day]) {
        dailyMap[day] = { productive: 0, neutral: 0, unproductive: 0, total: 0 };
      }
    }

    // Hourly distribution — org-local hours (never server-local getHours()).
    const hourlyMap: Record<number, { productive: number; neutral: number; unproductive: number }> = {};
    for (let h = 0; h < 24; h++) {
      hourlyMap[h] = { productive: 0, neutral: 0, unproductive: 0 };
    }

    for (const act of activitiesInRange) {
      const day = localDayKey(act.timestamp, orgTz);
      if (dailyMap[day]) {
        const cat = act.category || 'neutral';
        const minutes = act.duration / 60;
        dailyMap[day][cat as 'productive' | 'neutral' | 'unproductive'] += minutes;
        dailyMap[day].total += minutes;
      }

      // Hourly
      const hour = hourInTimezone(act.timestamp, orgTz);
      const cat = act.category || 'neutral';
      hourlyMap[hour][cat as 'productive' | 'neutral' | 'unproductive'] += act.duration;
    }

    // App and website usage — DB-side aggregation over the FULL filtered
    // range. Previously these were computed from the first activity page only
    // (50 rows), which undercounted and could omit entire domains from the
    // Top Applications / Website Usage surfaces; groupBy makes them exact and
    // bounded (server-side, never shipped to the browser).
    const [appUsage, websiteUsage] = await Promise.all([
      db.activity.groupBy({
        by: ['applicationName'],
        where: {
          employeeId: id,
          type: 'application',
          applicationName: { not: null },
          timestamp: { gte: startDate, lte: endDate },
          ...NON_INTERNAL_AGENT_ACTIVITY_FILTER,
        },
        _sum: { duration: true },
      }),
      db.activity.groupBy({
        by: ['url'],
        where: {
          employeeId: id,
          type: 'website',
          url: { not: null },
          timestamp: { gte: startDate, lte: endDate },
          ...NON_INTERNAL_AGENT_ACTIVITY_FILTER,
        },
        _sum: { duration: true },
      }),
    ]);

    const dailyProductivity = Object.entries(dailyMap)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([date, val]) => {
        // Label derived from the org-local day key (formatted via UTC so the
        // label never shifts across server timezones).
        const [y, m, d] = date.split('-').map(Number);
        const keyDate = new Date(Date.UTC(y, m - 1, d));
        return {
          date: format(keyDate, 'MMM dd'),
          ...val,
          score: val.total > 0 ? Math.round((val.productive / val.total) * 100) : 0,
        };
      });

    const hourlyDistribution = Object.entries(hourlyMap).map(([hour, val]) => ({
      hour: `${hour.toString().padStart(2, '0')}:00`,
      ...val,
      total: val.productive + val.neutral + val.unproductive,
    }));

    const totalAppDuration = appUsage.reduce((s, g) => s + (g._sum?.duration ?? 0), 0) || 1;
    const topApplications = appUsage
      .filter((g) => g.applicationName)
      .sort((a, b) => (b._sum?.duration ?? 0) - (a._sum?.duration ?? 0))
      .slice(0, 8)
      .map((g) => {
        const duration = g._sum?.duration ?? 0;
        return {
          name: g.applicationName!,
          duration: Math.round(duration / 60),
          percentage: Math.round((duration / totalAppDuration) * 100),
        };
      });

    const totalWebDuration = websiteUsage.reduce((s, g) => s + (g._sum?.duration ?? 0), 0) || 1;
    const topWebsites = websiteUsage
      .filter((g) => g.url)
      .sort((a, b) => (b._sum?.duration ?? 0) - (a._sum?.duration ?? 0))
      .slice(0, 8)
      .map((g) => {
        const duration = g._sum?.duration ?? 0;
        return {
          name: toDomain(g.url!),
          duration: Math.round(duration / 60),
          percentage: Math.round((duration / totalWebDuration) * 100),
        };
      });

    // Active days in range
    const activeDays = Object.values(dailyMap).filter(d => d.total > 0).length;

    // Alerts for this employee (N-9): structured employeeId linkage is the
    // primary filter; legacy rows (pre-linkage) fall back to metadata only.
    // Message/description text is NEVER used as an identity mechanism.
    const [empAlerts, empNotifications] = await Promise.all([
      db.alert.findMany({
        where: {
          organizationId: employee.organizationId,
          OR: [
            { employeeId: employee.id },
            { employeeId: null, metadata: { contains: employee.id } },
          ],
        },
        orderBy: { createdAt: 'desc' },
        take: 20,
      }),
      db.notification.findMany({
        where: {
          organizationId: employee.organizationId,
          OR: [
            { employeeId: employee.id },
            { employeeId: null, entityType: 'employee', entityId: employee.id },
          ],
        },
        orderBy: { createdAt: 'desc' },
        take: 20,
      }),
    ]);

    // Tenure calculation
    const tenureMonths = employee.joinDate
      ? Math.round((now.getTime() - new Date(employee.joinDate).getTime()) / (1000 * 60 * 60 * 24 * 30.44))
      : 0;

    // Active sessions count
    const activeSessionCount = await db.activity.count({
      where: {
        employeeId: id,
        type: 'work_session',
        timestamp: { gte: startDate, lte: endDate },
      },
    });

    return NextResponse.json({
      employee: {
        id: employee.id,
        employeeId: employee.employeeId,
        firstName: employee.firstName,
        lastName: employee.lastName,
        email: employee.email,
        phone: employee.phone,
        avatar: employee.avatar,
        designation: employee.designation,
        status: employee.status,
        joinDate: employee.joinDate,
        leaveDate: employee.leaveDate,
        createdAt: employee.createdAt,
        updatedAt: employee.updatedAt,
        organizationId: employee.organizationId,
        organization: employee.organization,
        departmentId: employee.departmentId,
        department: employee.department,
        devices: employee.devices,
        tenureMonths,
      },
      dateRange: {
        from: startDate.toISOString(),
        to: endDate.toISOString(),
      },
      allTime: {
        totalDuration: allTimeSummary._sum.duration || 0,
        productiveTime: allTimeProductive._sum.duration || 0,
        neutralTime: allTimeNeutral._sum.duration || 0,
        unproductiveTime: allTimeUnproductive._sum.duration || 0,
        totalActivities: allTimeSummary._count?.id || 0,
      },
      range: {
        totalDuration: rangeSummary._sum.duration || 0,
        productiveTime: rangeProductive._sum.duration || 0,
        neutralTime: rangeNeutral._sum.duration || 0,
        unproductiveTime: rangeUnproductive._sum.duration || 0,
        totalActivities: rangeSummary._count?.id || 0,
        activeDays,
        activeSessionCount,
        avgDailyHours: activeDays > 0
          ? Math.round(((rangeSummary._sum.duration || 0) / activeDays / 3600) * 10) / 10
          : 0,
        productivityScore: (rangeSummary._sum.duration || 0) > 0
          ? Math.round(((rangeProductive._sum.duration || 0) / (rangeSummary._sum.duration || 1)) * 100)
          : 0,
      },
      activities: activitiesInRange,
      activitiesTotal,
      activitiesPage: activityPage,
      activitiesPageSize: activityPageSize,
      activitiesTotalPages: Math.ceil(activitiesTotal / activityPageSize),
      dailyProductivity,
      hourlyDistribution,
      topApplications,
      topWebsites,
      alerts: empAlerts,
      notifications: empNotifications,
    });
  } catch (error) {
    log.error('api.employees.id.detail.', { error: String('Employee detail error:') }, requestContext(request));
    return NextResponse.json({ error: 'Failed to fetch employee details' }, { status: 500 });
  }
}
