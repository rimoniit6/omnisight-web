'use server';

import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { format, subDays, startOfDay, getDay } from 'date-fns';
import { authError, requireSessionOrg } from '@/lib/api';
import { excludeInternalAgentActivities } from '@/lib/agent-process';

export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;

  try {
    const scope = await requireSessionOrg(request, { allowGlobal: true });
    if (!scope.ok) return authError(scope);

    const employee = await db.employee.findFirst({
      where: { id, ...(scope.organizationId ? { organizationId: scope.organizationId } : {}) },
      include: { department: true },
    });

    if (!employee) {
      return NextResponse.json({ error: 'Employee not found' }, { status: 404 });
    }

    const thirtyDaysAgo = startOfDay(subDays(new Date(), 29));

    // Get all activities for last 30 days. Internal agent processes are
    // excluded at the data layer — the monitoring agent's own process must
    // never count as employee application usage.
    const activities = excludeInternalAgentActivities(await db.activity.findMany({
      where: { employeeId: id, timestamp: { gte: thirtyDaysAgo } },
      orderBy: { timestamp: 'desc' },
    }));

    // Calculate time totals
    let totalSeconds = 0;
    let productiveSeconds = 0;
    let neutralSeconds = 0;
    let unproductiveSeconds = 0;

    const appMap: Record<string, number> = {};
    const websiteMap: Record<string, number> = {};
    const dailyMap: Record<string, { date: string; score: number }> = {};
    const dayOfWeekMap: Record<string, { hours: number; productive: number; total: number }> = {};
    const dayNames = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
    for (let i = 0; i < 7; i++) {
      dayOfWeekMap[dayNames[i]] = { hours: 0, productive: 0, total: 0 };
    }

    // Initialize daily map for all 30 days
    for (let i = 29; i >= 0; i--) {
      const day = format(subDays(new Date(), i), 'yyyy-MM-dd');
      dailyMap[day] = { date: day, score: 0 };
    }

    for (const act of activities) {
      const dur = act.duration;
      const cat = act.category || 'neutral';
      totalSeconds += dur;

      if (cat === 'productive') productiveSeconds += dur;
      else if (cat === 'unproductive') unproductiveSeconds += dur;
      else neutralSeconds += dur;

      // App aggregation
      if (act.type === 'application' && act.applicationName) {
        appMap[act.applicationName] = (appMap[act.applicationName] || 0) + dur;
      }

      // Website aggregation
      if (act.type === 'website' && act.url) {
        const hostname = act.url.replace(/^https?:\/\/(www\.)?/, '').split('/')[0];
        websiteMap[hostname] = (websiteMap[hostname] || 0) + dur;
      }

      // Daily productivity
      const dayStr = format(new Date(act.timestamp), 'yyyy-MM-dd');
      if (dailyMap[dayStr]) {
        if (cat === 'productive') dailyMap[dayStr].score += dur;
      }

      // Weekly pattern
      const dateObj = new Date(act.timestamp);
      const dayOfWeek = getDay(dateObj);
      const dayName = dayNames[dayOfWeek === 0 ? 6 : dayOfWeek - 1]; // Mon=0, Sun=6
      if (dayOfWeekMap[dayName]) {
        dayOfWeekMap[dayName].hours += dur / 3600;
        dayOfWeekMap[dayName].total += dur;
        if (cat === 'productive') dayOfWeekMap[dayName].productive += dur;
      }
    }

    // Calculate daily scores (percentage productive out of total)
    for (const day of Object.keys(dailyMap)) {
      const dayActivities = activities.filter(
        (a) => format(new Date(a.timestamp), 'yyyy-MM-dd') === day
      );
      const dayTotal = dayActivities.reduce((sum, a) => sum + a.duration, 0);
      const dayProductive = dayActivities.reduce(
        (sum, a) => sum + (a.category === 'productive' ? a.duration : 0),
        0
      );
      dailyMap[day].score = dayTotal > 0 ? Math.round((dayProductive / dayTotal) * 100) : 0;
    }

    // Productivity trend
    const productivityTrend = Object.values(dailyMap).map((d) => ({
      date: format(new Date(d.date), 'MMM dd'),
      score: d.score,
    }));

    // Overall score: weighted average of daily scores (days with activity)
    const daysWithData = productivityTrend.filter((d) => {
      const actCount = activities.filter(
        (a) => format(new Date(a.timestamp), 'MMM dd') === d.date
      ).length;
      return actCount > 0;
    });
    const overallScore =
      daysWithData.length > 0
        ? Math.round(daysWithData.reduce((sum, d) => sum + d.score, 0) / daysWithData.length)
        : 0;

    // Top applications (top 5)
    const totalDuration = totalSeconds || 1;
    const topApplications = Object.entries(appMap)
      .sort(([, a], [, b]) => b - a)
      .slice(0, 5)
      .map(([name, duration]) => ({
        name,
        duration: Math.round(duration / 60),
        percentage: Math.round((duration / totalDuration) * 100),
      }));

    // Top websites (top 5)
    const topWebsites = Object.entries(websiteMap)
      .sort(([, a], [, b]) => b - a)
      .slice(0, 5)
      .map(([name, duration]) => ({
        name,
        duration: Math.round(duration / 60),
        percentage: Math.round((duration / totalDuration) * 100),
      }));

    // Weekly pattern with scores
    const weeklyPattern = dayNames.map((day) => ({
      day,
      hours: Math.round(dayOfWeekMap[day].hours * 10) / 10,
      score:
        dayOfWeekMap[day].total > 0
          ? Math.round((dayOfWeekMap[day].productive / dayOfWeekMap[day].total) * 100)
          : 0,
    }));

    // Days tracked for average
    const activeDays = new Set(activities.map((a) => format(new Date(a.timestamp), 'yyyy-MM-dd'))).size || 1;

    // Devices
    const devices = await db.device.findMany({
      where: { employeeId: id, status: { not: 'retired' } },
      orderBy: { registeredAt: 'desc' },
    });

    // Recent activities (last 10)
    const recentActivities = activities.slice(0, 10).map((a) => ({
      id: a.id,
      type: a.type,
      title: a.title,
      category: a.category,
      duration: a.duration,
      timestamp: a.timestamp.toISOString(),
    }));

    // Risk indicators
    const riskIndicators: Array<{ type: string; severity: 'low' | 'medium' | 'high'; description: string }> = [];

    // Check high idle time
    const idleSeconds = activities
      .filter((a) => a.type === 'idle' || a.category === 'idle')
      .reduce((sum, a) => sum + a.duration, 0);
    const idlePct = totalSeconds > 0 ? (idleSeconds / totalSeconds) * 100 : 0;
    if (idlePct > 25) {
      riskIndicators.push({
        type: 'high_idle_time',
        severity: 'high',
        description: `High idle time detected at ${Math.round(idlePct)}% of tracked hours`,
      });
    } else if (idlePct > 15) {
      riskIndicators.push({
        type: 'high_idle_time',
        severity: 'medium',
        description: `Idle time is ${Math.round(idlePct)}% of tracked hours`,
      });
    } else if (idlePct > 8) {
      riskIndicators.push({
        type: 'high_idle_time',
        severity: 'low',
        description: `Idle time is ${Math.round(idlePct)}% of tracked hours`,
      });
    }

    // Check declining productivity
    const firstWeek = productivityTrend.slice(0, 7);
    const lastWeek = productivityTrend.slice(-7);
    const firstWeekAvg =
      firstWeek.length > 0
        ? firstWeek.reduce((sum, d) => sum + d.score, 0) / firstWeek.length
        : 0;
    const lastWeekAvg =
      lastWeek.length > 0
        ? lastWeek.reduce((sum, d) => sum + d.score, 0) / lastWeek.length
        : 0;
    const decline = firstWeekAvg - lastWeekAvg;
    if (decline > 20) {
      riskIndicators.push({
        type: 'declining_productivity',
        severity: 'high',
        description: `Productivity declined ${Math.round(decline)}% over the last 30 days`,
      });
    } else if (decline > 10) {
      riskIndicators.push({
        type: 'declining_productivity',
        severity: 'medium',
        description: `Productivity declined ${Math.round(decline)}% over the last 30 days`,
      });
    } else if (decline > 5) {
      riskIndicators.push({
        type: 'declining_productivity',
        severity: 'low',
        description: `Productivity declined ${Math.round(decline)}% over the last 30 days`,
      });
    }

    // Check unproductive app usage
    const unproductivePct = totalSeconds > 0 ? (unproductiveSeconds / totalSeconds) * 100 : 0;
    if (unproductivePct > 20) {
      riskIndicators.push({
        type: 'unproductive_app_usage',
        severity: 'high',
        description: `${Math.round(unproductivePct)}% of time spent on unproductive applications`,
      });
    } else if (unproductivePct > 10) {
      riskIndicators.push({
        type: 'unproductive_app_usage',
        severity: 'medium',
        description: `${Math.round(unproductivePct)}% of time spent on unproductive applications`,
      });
    } else if (unproductivePct > 5) {
      riskIndicators.push({
        type: 'unproductive_app_usage',
        severity: 'low',
        description: `${Math.round(unproductivePct)}% of time spent on unproductive applications`,
      });
    }

    // Check irregular hours
    const afterHoursActivities = activities.filter((a) => {
      const hour = new Date(a.timestamp).getHours();
      return hour < 8 || hour >= 20;
    });
    const afterHoursPct = activities.length > 0 ? (afterHoursActivities.length / activities.length) * 100 : 0;
    if (afterHoursPct > 20) {
      riskIndicators.push({
        type: 'irregular_hours',
        severity: 'high',
        description: `${Math.round(afterHoursPct)}% of activities outside working hours (8am-8pm)`,
      });
    } else if (afterHoursPct > 10) {
      riskIndicators.push({
        type: 'irregular_hours',
        severity: 'medium',
        description: `${Math.round(afterHoursPct)}% of activities outside working hours (8am-8pm)`,
      });
    } else if (afterHoursPct > 5) {
      riskIndicators.push({
        type: 'irregular_hours',
        severity: 'low',
        description: `${Math.round(afterHoursPct)}% of activities outside working hours (8am-8pm)`,
      });
    }

    // If no risk indicators, add a positive one
    if (riskIndicators.length === 0) {
      riskIndicators.push({
        type: 'no_risks',
        severity: 'low',
        description: 'No significant risk indicators detected. Performance is healthy.',
      });
    }

    return NextResponse.json({
      employee: {
        id: employee.id,
        firstName: employee.firstName,
        lastName: employee.lastName,
        email: employee.email,
        designation: employee.designation,
        department: employee.department,
        avatar: employee.avatar,
        status: employee.status,
        joinDate: employee.joinDate,
      },
      performance: {
        overallScore,
        productivityTrend,
        totalHoursTracked: Math.round(totalSeconds / 3600 * 10) / 10,
        productiveHours: Math.round(productiveSeconds / 3600 * 10) / 10,
        neutralHours: Math.round(neutralSeconds / 3600 * 10) / 10,
        unproductiveHours: Math.round(unproductiveSeconds / 3600 * 10) / 10,
        avgDailyHours: Math.round((totalSeconds / 3600) / activeDays * 10) / 10,
        topApplications,
        topWebsites,
        activityByCategory: {
          productive: totalSeconds > 0 ? Math.round((productiveSeconds / totalSeconds) * 100) : 0,
          neutral: totalSeconds > 0 ? Math.round((neutralSeconds / totalSeconds) * 100) : 0,
          unproductive: totalSeconds > 0 ? Math.round((unproductiveSeconds / totalSeconds) * 100) : 0,
        },
        weeklyPattern,
        recentActivities,
        devicesUsed: devices.map((d) => ({
          id: d.id,
          name: d.name,
          status: d.status,
          lastHeartbeat: d.lastHeartbeat?.toISOString() || null,
        })),
        riskIndicators,
      },
    });
  } catch (error) {
    console.error('Employee performance error:', error);
    return NextResponse.json({ error: 'Failed to fetch performance data' }, { status: 500 });
  }
}
