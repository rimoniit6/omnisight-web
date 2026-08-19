'use server';
import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { authError, requireSessionOrg } from '@/lib/api';
import { effectiveDeviceStatus } from '@/lib/device-status';
import { localDayKey, lastNDayKeys } from '@/lib/timezone';
import {
  excludeInternalAgentActivities,
  NON_INTERNAL_AGENT_ACTIVITY_FILTER,
} from '@/lib/agent-process';
import { log } from '@/lib/logger';

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
  const startTime = Date.now();
  const requestId =
    req.headers.get('x-vercel-id') || req.headers.get('x-request-id') || undefined;
  const ctx = { requestId };

  try {
    log.info('dashboard.start', { ...ctx });

    // Tenant isolation: the dashboard is organization-scoped. Organization
    // identity ALWAYS comes from the verified session JWT — never from a
    // client-supplied parameter. An org-less super_admin (bootstrap state)
    // receives a valid EMPTY dashboard — never global business data.
    log.info('dashboard.auth:start', { ...ctx });
    const scope = await requireSessionOrg(req, { allowGlobal: true });
    if (!scope.ok) return authError(scope);
    if (!scope.organizationId) return emptyDashboard();
    log.info('dashboard.auth:success', { durationMs: Date.now() - startTime, ...ctx });

    const orgId = scope.organizationId;

    // Organization timezone — single source of truth for the local-day
    // productivity buckets (S-6). Defaults to UTC for a missing row.
    log.info('dashboard.organization:start', { ...ctx });
    const orgStart = Date.now();
    const org = await db.organization.findUnique({
      where: { id: orgId },
      select: { timezone: true },
    });
    const orgTz = org?.timezone || 'UTC';
    log.info('dashboard.organization:success', { durationMs: Date.now() - orgStart, ...ctx });

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
    log.info('dashboard.devices:start', { ...ctx });
    const devicesStart = Date.now();
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
    log.info('dashboard.devices:success', { durationMs: Date.now() - devicesStart, ...ctx });

    // ── Parallel lightweight queries ───────────────────────────────────────
    log.info('dashboard.queries:start', { ...ctx });
    const queriesStart = Date.now();
    const [totalEmployees, activeAlerts, totalDevices, departmentBreakdown] =
      await Promise.all([
        db.employee.count({ where: { organizationId: orgId, status: 'active' } }),
        db.alert.count({
          where: { organizationId: orgId, status: { in: ['pending', 'acknowledged'] } },
        }),
        db.device.count({ where: { organizationId: orgId } }),
        db.department.findMany({
          where: { organizationId: orgId },
          include: { _count: { select: { employees: true } } },
        }),
      ]);
    log.info('dashboard.queries:success', { durationMs: Date.now() - queriesStart, ...ctx });

    // ── Single consolidated activity query (10-day window) ─────────────────
    // REPLACES the previous two separate queries:
    //   1. Employee7-day activities (per-employee includes → N+1 overhead)
    //   2. Recent10-day activities (separate full scan)
    //
    // The10-day window is a superset of the7-day window. Both employee
    // summaries (top 5 employees by productive time) and daily productivity
    // buckets are derived from this single result set in JS, eliminating one
    // full table scan and the per-employee include overhead.
    //
    // Internal agent process exclusion is applied at the DB layer via
    // NON_INTERNAL_AGENT_ACTIVITY_FILTER (AND with the OR predicate) so the
    // rows never leave the database engine.
    log.info('dashboard.activities:start', { ...ctx });
    const activitiesStart = Date.now();
    const windowStart = new Date(now.getTime() - 10 * DAY_MS);
    const allActivities = excludeInternalAgentActivities(
      await db.activity.findMany({
        where: {
          employee: { organizationId: orgId },
          timestamp: { gte: windowStart },
          ...NON_INTERNAL_AGENT_ACTIVITY_FILTER,
        },
        select: {
          timestamp: true,
          duration: true,
          category: true,
          applicationName: true,
          employeeId: true,
        },
      })
    );
    log.info('dashboard.activities:success', {
      activityCount: allActivities.length,
      durationMs: Date.now() - activitiesStart,
      ...ctx,
    });

    // ── Recent activities (last 10, for the feed) ──────────────────────────
    // Sliced from the consolidated result — no separate DB query needed.
    // We need employee+device info for the feed, so do a targeted small query.
    log.info('dashboard.recent:start', { ...ctx });
    const recentStart = Date.now();
    const recentActivities = excludeInternalAgentActivities(
      await db.activity.findMany({
        where: {
          employee: { organizationId: orgId },
          ...NON_INTERNAL_AGENT_ACTIVITY_FILTER,
        },
        take: 10,
        orderBy: { timestamp: 'desc' },
        include: {
          employee: { select: { id: true, firstName: true, lastName: true, avatar: true } },
          device: { select: { id: true, name: true } },
        },
      })
    );
    log.info('dashboard.recent:success', { durationMs: Date.now() - recentStart, ...ctx });

    // ── Derive employee summaries from the consolidated result ─────────────
    // Group activities by employeeId, sum productive duration within the
    // 7-day window, then rank top 5. This replaces the per-employee include
    // query that caused N+1 overhead for50 employees.
    const employeeActivityMap = new Map<string, number>();
    for (const a of allActivities) {
      if (a.category === 'productive' && a.timestamp >= sevenDaysAgo) {
        employeeActivityMap.set(
          a.employeeId,
          (employeeActivityMap.get(a.employeeId) ?? 0) + a.duration
        );
      }
    }

    // avgProductivity — productive time per active employee over the trailing
    // 7-day window, in hours (never fabricated; zero when no data).
    let totalProductiveTime = 0;
    for (const dur of employeeActivityMap.values()) totalProductiveTime += dur;
    const avgProductivity =
      totalEmployees > 0
        ? Math.round((totalProductiveTime / totalEmployees / 3600) * 100) / 100
        : 0;

    // Top employees: need names/departments — fetch just the top5 employee
    // rows (cheap, indexed PK lookup after we know which IDs matter).
    const topEmployeeIds = [...employeeActivityMap.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([id]) => id);

    let topEmployees: Array<{
      id: string;
      firstName: string;
      lastName: string;
      department: string;
      productiveTime: number;
    }> = [];
    if (topEmployeeIds.length > 0) {
      const topRows = await db.employee.findMany({
        where: { id: { in: topEmployeeIds } },
        select: {
          id: true,
          firstName: true,
          lastName: true,
          department: { select: { name: true } },
        },
      });
      const topRowMap = new Map(topRows.map((r) => [r.id, r]));
      topEmployees = topEmployeeIds
        .map((id) => {
          const row = topRowMap.get(id);
          return {
            id,
            firstName: row?.firstName ?? '',
            lastName: row?.lastName ?? '',
            department: row?.department?.name || 'Unassigned',
            productiveTime: employeeActivityMap.get(id) ?? 0,
          };
        })
        .filter((e) => e.firstName); // skip if employee was deleted concurrently
    }

    // ── Daily productivity in ORGANIZATION-local days (S-6) ───────────────
    // Buckets use the org timezone: 23:30 UTC in Asia/Dhaka (+06) is 05:30 the
    // NEXT local day and must land in that bucket. Derive from the consolidated
    // activity result — no separate DB query needed.
    const dailyKeys = lastNDayKeys(orgTz, 7, now);
    const byDay = new Map<string, { productive: number; neutral: number; unproductive: number }>();
    for (const a of allActivities) {
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
        date: labelDate.toLocaleDateString('en-US', {
          weekday: 'short',
          month: 'short',
          day: 'numeric',
          timeZone: 'UTC',
        }),
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
      .filter(
        (b): b is { productive: number; neutral: number; unproductive: number } =>
          b !== undefined
      );
    const totalInWindow = windowBuckets.reduce(
      (s, b) => s + b.productive + b.neutral + b.unproductive,
      0
    );
    const productiveInWindow = windowBuckets.reduce((s, b) => s + b.productive, 0);
    const productivityScore =
      totalInWindow > 0 ? Math.round((productiveInWindow / totalInWindow) * 100) : 0;

    log.info('dashboard.complete', { durationMs: Date.now() - startTime, ...ctx });

    return NextResponse.json({
      data: {
        totalEmployees,
        totalDevices,
        onlineDevices,
        avgProductivity,
        productivityScore,
        activeAlerts,
        recentActivities,
        topEmployees,
        departmentBreakdown,
        deviceStatusBreakdown,
        dailyProductivity,
      },
    });
  } catch (error) {
    const durationMs = Date.now() - startTime;
    const prismaCode =
      error && typeof error === 'object' && 'code' in error
        ? (error as { code: string }).code
        : undefined;
    log.error('dashboard.error', {
      errorName: error instanceof Error ? error.name : 'Unknown',
      errorMessage: error instanceof Error ? error.message : String(error),
      prismaCode,
      durationMs,
      ...ctx,
    });
    return NextResponse.json({ error: 'Failed to fetch dashboard data' }, { status: 500 });
  }
}
