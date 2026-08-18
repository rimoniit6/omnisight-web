'use server';
import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { authError, requireSessionOrg } from '@/lib/api';
import { effectiveDeviceStatus } from '@/lib/device-status';
import { localDayKey, lastNDayKeys } from '@/lib/timezone';
import { excludeInternalAgentActivities } from '@/lib/agent-process';

const DAY_MS = 24 * 60 * 60 * 1000;

function emptyDashboard() {
  return NextResponse.json({
    data: {
      totalEmployees: 0,
      totalDevices: 0,
      onlineDevices: 0,
      avgProductivity: 0,
      productivityScore: 0,
      activeAlerts: 0,
      recentActivities: [],
      topEmployees: [],
      departmentBreakdown: [],
      deviceStatusBreakdown: [],
      dailyProductivity: [],
    },
  });
}

export async function GET(req: NextRequest) {
  try {
    // Tenant isolation: the dashboard is organization-scoped. Organization
    // identity ALWAYS comes from the verified session JWT — never from a
    // client-supplied parameter. An org-less super_admin (bootstrap state)
    // receives a valid EMPTY dashboard — never global business data.
    const scope = await requireSessionOrg(req, { allowGlobal: true });
    if (!scope.ok) return authError(scope);
    if (!scope.organizationId) return emptyDashboard();

    const orgId = scope.organizationId;

    // Organization timezone — single source of truth for the local-day
    // productivity buckets (S-6). Defaults to UTC for a missing row.
    const org = await db.organization.findUnique({
      where: { id: orgId },
      select: { timezone: true },
    });
    const orgTz = org?.timezone || 'UTC';

    // ── 7-day trailing window (S-5) for productivity metrics ──────────────
    // avgProductivity and topEmployees are computed from the LAST 7 DAYS only
    // — never the unbounded historical total, which would dwarf recent
    // behavior and grow stale over time.
    const now = new Date();
    const sevenDaysAgo = new Date(now.getTime() - 7 * DAY_MS);

    // ── Effective online devices (S-5) ────────────────────────────────────
    // A stale device (no fresh heartbeat within the centralized presence
    // threshold) must NOT be counted as online. The stored `status` column is
    // never mutated — the dashboard computes the effective status read-side,
    // and it agrees with the presence API / realtime events.
    const devices = await db.device.findMany({
      where: { organizationId: orgId },
      select: { status: true, lastHeartbeat: true },
    });
    const onlineDevices = devices.filter(
      (d) => effectiveDeviceStatus(d.status, d.lastHeartbeat) === 'online'
    ).length;

    // ── Device status breakdown (P2-4) ────────────────────────────────────
    // Uses the SAME effective (heartbeat-derived) definition as onlineDevices
    // so the KPI and the pie chart can never contradict each other. A device
    // whose stored status is 'online' but whose heartbeat went stale reads as
    // offline here too. The stored status column is never mutated.
    const deviceStatusBreakdown = Array.from(
      devices.reduce((map, d) => {
        const eff = effectiveDeviceStatus(d.status, d.lastHeartbeat);
        map.set(eff, (map.get(eff) ?? 0) + 1);
        return map;
      }, new Map<string, number>()),
      ([status, count]) => ({ status, _count: count }),
    );

    const [totalEmployees, activeAlerts, activities, employees, totalDevices, departmentBreakdown] =
      await Promise.all([
        db.employee.count({ where: { organizationId: orgId, status: 'active' } }),
        db.alert.count({ where: { organizationId: orgId, status: { in: ['pending', 'acknowledged'] } } }),
        db.activity.findMany({
          // Activity has no direct organizationId — scope via the employee relation.
          // Internal agent processes are excluded at the data layer.
          where: { employee: { organizationId: orgId } },
          take: 10,
          orderBy: { timestamp: 'desc' },
          include: {
            employee: { select: { id: true, firstName: true, lastName: true, avatar: true } },
            device: { select: { id: true, name: true } },
          },
        }).then((rows) => excludeInternalAgentActivities(rows)),
        db.employee.findMany({
          where: { organizationId: orgId, status: 'active' },
          include: {
            // 7-day trailing window (S-5): unbounded historical productive
            // time must not skew the average or the top-employees list.
            activities: {
              where: { category: 'productive', timestamp: { gte: sevenDaysAgo } },
              select: { duration: true },
            },
            department: { select: { id: true, name: true } },
          },
          take: 50,
        }),
        db.device.count({ where: { organizationId: orgId } }),
        db.department.findMany({
          where: { organizationId: orgId },
          include: { _count: { select: { employees: true } } },
        }),
      ]);

    // avgProductivity — productive time per active employee over the trailing
    // 7-day window, in hours (never fabricated; zero when no data).
    const totalProductiveTime = employees.reduce(
      (sum, e) => sum + e.activities.reduce((s, a) => s + a.duration, 0),
      0
    );
    const avgProductivity =
      employees.length > 0 ? Math.round((totalProductiveTime / employees.length / 3600) * 100) / 100 : 0;

    // Top employees by productive time (same 7-day window).
    const topEmployees = employees
      .map((e) => ({
        id: e.id,
        firstName: e.firstName,
        lastName: e.lastName,
        department: e.department?.name || 'Unassigned',
        productiveTime: e.activities.reduce((s, a) => s + a.duration, 0),
      }))
      .sort((a, b) => b.productiveTime - a.productiveTime)
      .slice(0, 5);

    // ── Daily productivity in ORGANIZATION-local days (S-6) ───────────────
    // Buckets use the org timezone: 23:30 UTC in Asia/Dhaka (+06) is 05:30 the
    // NEXT local day and must land in that bucket. Fetch the trailing window
    // with slack, then group each activity by its org-local calendar day.
    const dailyKeys = lastNDayKeys(orgTz, 7, now);
    const windowStart = new Date(now.getTime() - 10 * DAY_MS);
    const recentActivities = excludeInternalAgentActivities(await db.activity.findMany({
      where: { employee: { organizationId: orgId }, timestamp: { gte: windowStart } },
      select: { timestamp: true, duration: true, category: true, applicationName: true },
    }));

    const byDay = new Map<string, { productive: number; neutral: number; unproductive: number }>();
    for (const a of recentActivities) {
      const key = localDayKey(a.timestamp, orgTz);
      const entry = byDay.get(key) ?? { productive: 0, neutral: 0, unproductive: 0 };
      if (a.category === 'productive') entry.productive += a.duration;
      else if (a.category === 'neutral') entry.neutral += a.duration;
      else if (a.category === 'unproductive') entry.unproductive += a.duration;
      byDay.set(key, entry);
    }

    const dailyProductivity = dailyKeys.map((key) => {
      const entry = byDay.get(key) ?? { productive: 0, neutral: 0, unproductive: 0 };
      // Label derived from the local date key (formatted via UTC so the label
      // never shifts across server timezones).
      const [y, m, d] = key.split('-').map(Number);
      const labelDate = new Date(Date.UTC(y, m - 1, d));
      return {
        date: labelDate.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'UTC' }),
        productive: Math.round(entry.productive / 60),
        neutral: Math.round(entry.neutral / 60),
        unproductive: Math.round(entry.unproductive / 60),
      };
    });

    // ── Productivity Score (P1-1) ─────────────────────────────────────────
    // CANONICAL formula — identical to analytics / activities-daily / reports
    // (productive duration ÷ total categorized duration × 100). Computed over
    // the SAME 7-day org-local window and buckets as the dailyProductivity
    // trend (never the unbounded historical total), so the KPI card and the
    // chart can never disagree. 0 when there is no activity in the window.
    const windowBuckets = dailyKeys
      .map((key) => byDay.get(key))
      .filter((b): b is { productive: number; neutral: number; unproductive: number } => b !== undefined);
    const totalInWindow = windowBuckets.reduce((s, b) => s + b.productive + b.neutral + b.unproductive, 0);
    const productiveInWindow = windowBuckets.reduce((s, b) => s + b.productive, 0);
    const productivityScore =
      totalInWindow > 0 ? Math.round((productiveInWindow / totalInWindow) * 100) : 0;

    return NextResponse.json({
      data: {
        totalEmployees,
        totalDevices,
        onlineDevices,
        avgProductivity,
        productivityScore,
        activeAlerts,
        recentActivities: activities,
        topEmployees,
        departmentBreakdown,
        deviceStatusBreakdown,
        dailyProductivity,
      },
    });
  } catch (error) {
    console.error('Dashboard GET error:', error);
    return NextResponse.json({ error: 'Failed to fetch dashboard data' }, { status: 500 });
  }
}
