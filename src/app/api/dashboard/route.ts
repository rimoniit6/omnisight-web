'use server';
import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { authError, requireSessionOrg } from '@/lib/api';
import { effectiveDeviceStatus } from '@/lib/device-status';
import { lastNDayKeys } from '@/lib/timezone';
import {
  excludeInternalAgentActivities,
  NON_INTERNAL_AGENT_ACTIVITY_FILTER,
} from '@/lib/agent-process';
import { readOrgDayTotals } from '@/lib/workday/consume';
import { log } from '@/lib/logger';

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
    // avgProductivity and topEmployees are computed from the LAST 7 org-local
    // days only — never the unbounded historical total, which would dwarf
    // recent behavior and grow stale over time. One pinned clock per request
    // keeps the day keys, today's raw fallback and the rollup reads in sync.
    const now = new Date();

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

    // ── Daily productivity in ORGANIZATION-local days (S-6) ───────────────
    // Buckets use the org timezone: 23:30 UTC in Asia/Dhaka (+06) is 05:30 the
    // NEXT local day and must land in that bucket.
    //
    // Phase 4 wiring: per-day per-employee totals are read from the
    // WorkDaySummary rollup when the aggregation job has covered a day, with
    // an EXACT raw-row fallback for the current org-local day (its summary is
    // partial until the day completes) and for any uncovered past day (pre-
    // backfill installs). The fallback runs the SAME aggregation engine over
    // the SAME org-local window, so a day served from the rollup and a day
    // served from raw rows produce byte-identical values — and empty days are
    // never fabricated. The rolling 7×24 h productive-employee window of the
    // old implementation is superseded by the SAME 7 org-local day window the
    // trend/score use, so every productivity KPI on this page shares one
    // window and can never disagree (DP-7).
    log.info('dashboard.activities:start', { ...ctx });
    const activitiesStart = Date.now();
    const dailyKeys = lastNDayKeys(orgTz, 7, now);
    const dayTotals = await readOrgDayTotals({
      organizationId: orgId,
      timezone: orgTz,
      dayKeys: dailyKeys,
      now,
    });

    // Per-employee productive seconds over the SAME 7 org-local day window
    // (each day sourced from rollup or raw — never both).
    const employeeActivityMap = new Map<string, number>();
    for (const byEmp of dayTotals.rows.values()) {
      for (const totals of byEmp.values()) {
        employeeActivityMap.set(
          totals.employeeId,
          (employeeActivityMap.get(totals.employeeId) ?? 0) + totals.productiveSeconds
        );
      }
    }

    // avgProductivity — productive time per active employee over the trailing
    // 7-day window, in hours (never fabricated; zero when no data).
    let totalProductiveTime = 0;
    for (const secs of employeeActivityMap.values()) totalProductiveTime += secs;
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
            // Seconds on the wire (the UI divides by 3600 for hours) — the
            // rollup stores exact seconds, unchanged units from the raw path.
            productiveTime: employeeActivityMap.get(id) ?? 0,
          };
        })
        .filter((e) => e.firstName); // skip if employee was deleted concurrently
    }

    // Collapse per-employee rows into the org-day totals the trend renders
    // (rounding happens ONCE per day on the summed seconds — identical to the
    // pre-rollup behavior, so chart values never shift).
    const byDay = new Map<string, { productive: number; neutral: number; unproductive: number }>();
    for (const key of dailyKeys) {
      const byEmp = dayTotals.rows.get(key);
      if (!byEmp) continue;
      let productive = 0;
      let neutral = 0;
      let unproductive = 0;
      for (const totals of byEmp.values()) {
        productive += totals.productiveSeconds;
        neutral += totals.neutralSeconds;
        unproductive += totals.unproductiveSeconds;
      }
      byDay.set(key, { productive, neutral, unproductive });
    }
    log.info('dashboard.activities:success', {
      summaryDays: [...dayTotals.source.values()].filter((s) => s === 'summary').length,
      rawDays: [...dayTotals.source.values()].filter((s) => s === 'raw').length,
      durationMs: Date.now() - activitiesStart,
      ...ctx,
    });

    // ── Recent activities (last 10, for the feed) ──────────────────────────
    // The feed is deliberately NOT served from the rollup (WorkDaySummary
    // stores totals, not the individual rows a live feed needs) — a targeted
    // bounded query, internal-agent rows excluded at the DB layer.
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

    // ── Daily productivity buckets (minutes) ───────────────────────────────
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
