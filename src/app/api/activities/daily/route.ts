import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { authError, requireSessionOrg } from '@/lib/api';
import { excludeInternalAgentActivities } from '@/lib/agent-process';
import { isValidTimezone, localDayKey, lastNDayKeys } from '@/lib/timezone';

const MAX_DAYS = 365;

// GET /api/activities/daily
// Returns daily activity breakdown for timeline visualization
export async function GET(req: NextRequest) {
  try {
    // Tenant isolation: daily activities are organization-scoped from the
    // verified session — never from client input.
    const scope = await requireSessionOrg(req, { allowGlobal: true });
    if (!scope.ok) return authError(scope);
    if (!scope.organizationId) {
      return NextResponse.json({
        daily: [],
        summary: { totalProductive: 0, totalNeutral: 0, totalUnproductive: 0, totalIdle: 0, productivityScore: 0, avgDailyMinutes: 0 },
      });
    }
    const orgId = scope.organizationId;

    const { searchParams } = new URL(req.url);
    const employeeId = searchParams.get('employeeId');
    const rawDays = searchParams.get('days') || '7';
    const days = Number(rawDays);
    if (!Number.isInteger(days) || days < 1 || days > MAX_DAYS) {
      return NextResponse.json({ error: `Invalid days. Must be an integer between 1 and ${MAX_DAYS}.` }, { status: 422 });
    }

    // Organization-local day buckets (same convention as the dashboard):
    // 23:30 UTC in Asia/Dhaka (+06) is 05:30 the NEXT local day and must land
    // in that day's bucket. The trailing window includes slack so late-day
    // local events are never dropped.
    const org = await db.organization.findUnique({ where: { id: orgId }, select: { timezone: true } });
    const orgTz = org?.timezone && isValidTimezone(org.timezone) ? org.timezone : 'UTC';
    const dayKeys = lastNDayKeys(orgTz, days);
    const startDate = new Date(dayKeys[0] + 'T00:00:00.000Z');
    startDate.setUTCDate(startDate.getUTCDate() - 1); // slack for local-day offset

    // Activity has no direct organizationId — scope via the employee relation.
    const where: Record<string, unknown> = {
      timestamp: { gte: startDate },
      employee: { organizationId: orgId },
    };
    if (employeeId) where.employeeId = employeeId;

    // Get activities grouped by date and category. Internal agent processes are
    // excluded so the monitoring agent never skews daily summaries.
    const activities = excludeInternalAgentActivities(await db.activity.findMany({
      where,
      select: {
        timestamp: true,
        duration: true,
        category: true,
        type: true,
        applicationName: true,
      },
      orderBy: { timestamp: 'asc' },
    }));

    // Build daily breakdown
    const dailyMap: Record<string, {
      date: string;
      totalMinutes: number;
      productiveMinutes: number;
      neutralMinutes: number;
      unproductiveMinutes: number;
      idleMinutes: number;
      activityCount: number;
    }> = {};

    for (const act of activities) {
      const dateStr = localDayKey(act.timestamp, orgTz);
      if (!dailyMap[dateStr]) {
        dailyMap[dateStr] = {
          date: dateStr,
          totalMinutes: 0,
          productiveMinutes: 0,
          neutralMinutes: 0,
          unproductiveMinutes: 0,
          idleMinutes: 0,
          activityCount: 0,
        };
      }
      const day = dailyMap[dateStr];
      const mins = Math.round(act.duration / 60);
      day.totalMinutes += mins;
      day.activityCount += 1;

      if (act.type === 'idle') {
        day.idleMinutes += mins;
      } else if (act.category === 'productive') {
        day.productiveMinutes += mins;
      } else if (act.category === 'unproductive') {
        day.unproductiveMinutes += mins;
      } else {
        day.neutralMinutes += mins;
      }
    }

    // Fill in missing days using the org-local calendar keys (oldest first).
    const dailyData: Array<{
      date: string;
      totalMinutes: number;
      productiveMinutes: number;
      neutralMinutes: number;
      unproductiveMinutes: number;
      idleMinutes: number;
      activityCount: number;
    }> = [];
    for (const dateStr of dayKeys) {
      dailyData.push(dailyMap[dateStr] || {
        date: dateStr,
        totalMinutes: 0,
        productiveMinutes: 0,
        neutralMinutes: 0,
        unproductiveMinutes: 0,
        idleMinutes: 0,
        activityCount: 0,
      });
    }

    // Calculate summary
    const totalProductive = dailyData.reduce((s, d) => s + d.productiveMinutes, 0);
    const totalNeutral = dailyData.reduce((s, d) => s + d.neutralMinutes, 0);
    const totalUnproductive = dailyData.reduce((s, d) => s + d.unproductiveMinutes, 0);
    const totalIdle = dailyData.reduce((s, d) => s + d.idleMinutes, 0);
    const totalAll = totalProductive + totalNeutral + totalUnproductive + totalIdle;
    const productivityScore = totalAll > 0 ? Math.round((totalProductive / totalAll) * 100) : 0;

    return NextResponse.json({
      daily: dailyData,
      summary: {
        totalProductive,
        totalNeutral,
        totalUnproductive,
        totalIdle,
        productivityScore,
        avgDailyMinutes: totalAll > 0 ? Math.round(totalAll / days) : 0,
      },
    });
  } catch (error) {
    console.error('Daily activities error:', error);
    return NextResponse.json({ error: 'Failed to fetch daily activities' }, { status: 500 });
  }
}
