'use server';
import { NextRequest, NextResponse } from 'next/server';
import { Prisma } from '@prisma/client';
import { db } from '@/lib/db';
import { authError, requireSessionOrg } from '@/lib/api';
import { NON_INTERNAL_AGENT_ACTIVITY_FILTER, INTERNAL_AGENT_PROCESS_NAMES } from '@/lib/agent-process';
import { zonedDayStart, zonedDayEnd } from '@/lib/timezone';
import { log, requestContext } from '@/lib/logger';

const DAY_KEY_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * P2-1 — comparison aggregation is now DATABASE-SIDE, mirroring
 * /api/analytics: summary via groupBy(category), active employees via
 * groupBy(employeeId), active days + top apps via raw SQL over the same
 * org-local window. No period row is ever materialized in the application
 * layer. Output semantics are preserved exactly (same category sums, same
 * org-local day counting, same first-row/productive-wins app category).
 */
const utcTs = (d: Date) => d.toISOString().slice(0, 19).replace('T', ' ');

// NULL-safe internal-agent-process exclusion (see lib/agent-process.ts).
// Written INLINE with Prisma.join in each raw query below — a plain-string
// template variable would be parameter-bound as TEXT, not spliced as SQL.

/**
 * A selected calendar day is interpreted as that day in the ORGANIZATION
 * timezone — never as a raw UTC day (Asia/Dhaka +06 would shift the window
 * and the active-day count back by a day).
 */
async function getAnalyticsForPeriod(startStr: string, endStr: string, orgId: string, orgTz: string) {
  const startDate = zonedDayStart(startStr, orgTz);
  const endDate = zonedDayEnd(endStr, orgTz);

  // Tenant isolation: activities are scoped through the employee relation to
  // the caller's organization — never queried globally. Internal agent
  // processes are excluded at the data layer.
  const where: Prisma.ActivityWhereInput = {
    timestamp: { gte: startDate, lte: endDate },
    employee: { organizationId: orgId },
    ...NON_INTERNAL_AGENT_ACTIVITY_FILTER,
  };

  const [byCategory, empGroups, dayRows, appRows] = await Promise.all([
    db.activity.groupBy({
      by: ['category'],
      where,
      _sum: { duration: true },
      _count: { _all: true },
    }),
    db.activity.groupBy({ by: ['employeeId'], where }),
    // Active days in the ORGANIZATION-local calendar (COUNT DISTINCT of the
    // org-local day) — identical to the old Set(localDayKey(...)).size.
    db.$queryRaw<Array<{ days: bigint }>>`
      SELECT COUNT(DISTINCT (a."timestamp" AT TIME ZONE 'UTC' AT TIME ZONE ${orgTz})::date)::bigint AS "days"
      FROM "Activity" a
      INNER JOIN "Employee" e ON e."id" = a."employeeId"
      WHERE a."timestamp" >= ${utcTs(startDate)}::timestamp
        AND a."timestamp" <= ${utcTs(endDate)}::timestamp
        AND e."organizationId" = ${orgId}
        AND (a."applicationName" IS NULL OR LOWER(a."applicationName") NOT IN (${Prisma.join(INTERNAL_AGENT_PROCESS_NAMES)}))
    `,
    // Top apps: per-key SUM(duration)/COUNT with the deterministic first-row
    // category (order = createdAt,id, the old insertion-order scan), except
    // 'productive' wins when ANY row is productive (the old JS overwrote the
    // category on sight of a productive row).
    db.$queryRaw<Array<{ key: string; category: string | null; duration: bigint }>>`
      SELECT
        COALESCE(a."applicationName", a."url", a."title", 'Unknown') AS "key",
        CASE
          WHEN bool_or(a."category" = 'productive') THEN 'productive'
          ELSE COALESCE((array_agg(a."category" ORDER BY a."createdAt", a."id"))[1], 'neutral')
        END AS "category",
        SUM(a."duration")::bigint AS "duration"
      FROM "Activity" a
      INNER JOIN "Employee" e ON e."id" = a."employeeId"
      WHERE a."timestamp" >= ${utcTs(startDate)}::timestamp
        AND a."timestamp" <= ${utcTs(endDate)}::timestamp
        AND e."organizationId" = ${orgId}
        AND (a."applicationName" IS NULL OR LOWER(a."applicationName") NOT IN (${Prisma.join(INTERNAL_AGENT_PROCESS_NAMES)}))
      GROUP BY 1
    `,
  ]);

  const sumOf = (cat: string | null) =>
    byCategory.filter((g) => g.category === cat).reduce((s, g) => s + (g._sum?.duration ?? 0), 0);
  const totalDuration = byCategory.reduce((s, g) => s + (g._sum?.duration ?? 0), 0);
  const productiveDuration = sumOf('productive');
  const neutralDuration = sumOf('neutral');
  const unproductiveDuration = sumOf('unproductive');
  const totalActivities = byCategory.reduce((s, g) => s + (g._count?._all ?? 0), 0);

  const topApps = appRows
    .sort((a, b) => Number(b.duration) - Number(a.duration))
    .slice(0, 5)
    .map((a) => ({
      name: a.key,
      duration: Number(a.duration),
      category: a.category,
      durationMinutes: Math.round(Number(a.duration) / 60),
    }));

  const totalActiveHours = Math.round(totalDuration / 3600 * 10) / 10;

  return {
    productivityScore: totalDuration > 0 ? Math.round((productiveDuration / totalDuration) * 100) : 0,
    activeHours: totalActiveHours,
    activeDays: Number(dayRows[0]?.days ?? 0),
    activeEmployees: empGroups.length,
    totalActivities,
    productiveHours: Math.round(productiveDuration / 3600 * 10) / 10,
    neutralHours: Math.round(neutralDuration / 3600 * 10) / 10,
    unproductiveHours: Math.round(unproductiveDuration / 3600 * 10) / 10,
    topApps,
    workload: {
      productive: totalDuration > 0 ? Math.round((productiveDuration / totalDuration) * 100) : 0,
      neutral: totalDuration > 0 ? Math.round((neutralDuration / totalDuration) * 100) : 0,
      unproductive: totalDuration > 0 ? Math.round((unproductiveDuration / totalDuration) * 100) : 0,
    },
  };
}

async function getDepartmentAnalytics(deptId: string, orgId: string, startDate?: Date, endDate?: Date) {
  // Tenant isolation: the department and its employees must belong to the
  // caller's organization.
  const dept = await db.department.findFirst({
    where: { id: deptId, organizationId: orgId },
    select: { id: true },
  });
  if (!dept) {
    throw new OrgScopeError();
  }
  const employees = await db.employee.findMany({
    where: { departmentId: deptId, organizationId: orgId, status: 'active' },
    select: { id: true },
  });
  const empIds = employees.map((e) => e.id);

  // Date-bounded (never unbounded): the comparison tool always sends the
  // shared analytics range; a direct API call without dates falls back to a
  // trailing 90-day window so the query cannot scan all history.
  let boundStart: Date;
  let boundEnd: Date;
  if (startDate && endDate) {
    boundStart = startDate;
    boundEnd = endDate;
  } else {
    const now = new Date();
    boundStart = new Date(now.getTime() - 90 * 24 * 60 * 60 * 1000);
    boundEnd = now;
  }
  const where: Prisma.ActivityWhereInput = {
    employeeId: { in: empIds },
    timestamp: { gte: boundStart, lte: boundEnd },
    ...NON_INTERNAL_AGENT_ACTIVITY_FILTER,
  };

  const [byCategory, appRows] = await Promise.all([
    db.activity.groupBy({
      by: ['category'],
      where,
      _sum: { duration: true },
      _count: { _all: true },
    }),
    db.$queryRaw<Array<{ key: string; category: string | null; duration: bigint }>>`
      SELECT
        COALESCE(a."applicationName", a."url", a."title", 'Unknown') AS "key",
        CASE
          WHEN bool_or(a."category" = 'productive') THEN 'productive'
          ELSE COALESCE((array_agg(a."category" ORDER BY a."createdAt", a."id"))[1], 'neutral')
        END AS "category",
        SUM(a."duration")::bigint AS "duration"
      FROM "Activity" a
      WHERE a."employeeId" IN (${Prisma.join(empIds)})
        AND a."timestamp" >= ${utcTs(boundStart)}::timestamp
        AND a."timestamp" <= ${utcTs(boundEnd)}::timestamp
        AND (a."applicationName" IS NULL OR LOWER(a."applicationName") NOT IN (${Prisma.join(INTERNAL_AGENT_PROCESS_NAMES)}))
      GROUP BY 1
    `,
  ]);

  const sumOf = (cat: string | null) =>
    byCategory.filter((g) => g.category === cat).reduce((s, g) => s + (g._sum?.duration ?? 0), 0);
  const totalDuration = byCategory.reduce((s, g) => s + (g._sum?.duration ?? 0), 0);
  const productiveDuration = sumOf('productive');
  const neutralDuration = sumOf('neutral');
  const unproductiveDuration = sumOf('unproductive');
  const totalActivities = byCategory.reduce((s, g) => s + (g._count?._all ?? 0), 0);

  const topApps = appRows
    .sort((a, b) => Number(b.duration) - Number(a.duration))
    .slice(0, 5)
    .map((a) => ({
      name: a.key,
      duration: Number(a.duration),
      category: a.category,
      durationMinutes: Math.round(Number(a.duration) / 60),
    }));

  return {
    productivityScore: totalDuration > 0 ? Math.round((productiveDuration / totalDuration) * 100) : 0,
    activeHours: Math.round(totalDuration / 3600 * 10) / 10,
    activeEmployees: empIds.length,
    totalActivities,
    productiveHours: Math.round(productiveDuration / 3600 * 10) / 10,
    neutralHours: Math.round(neutralDuration / 3600 * 10) / 10,
    unproductiveHours: Math.round(unproductiveDuration / 3600 * 10) / 10,
    topApps,
    workload: {
      productive: totalDuration > 0 ? Math.round((productiveDuration / totalDuration) * 100) : 0,
      neutral: totalDuration > 0 ? Math.round((neutralDuration / totalDuration) * 100) : 0,
      unproductive: totalDuration > 0 ? Math.round((unproductiveDuration / totalDuration) * 100) : 0,
    },
  };
}

/** Internal sentinel for a cross-org reference (mapped to 404/422 below). */
class OrgScopeError extends Error {}

export async function GET(req: NextRequest) {
  try {
    // Tenant isolation: comparisons are organization-scoped from the verified
    // session. Org-less super_admins get an empty state.
    const scope = await requireSessionOrg(req, { allowGlobal: true });
    if (!scope.ok) return authError(scope);
    if (!scope.organizationId) {
      return NextResponse.json({ error: 'No organization context' }, { status: 403 });
    }
    const orgId = scope.organizationId;

    // Organization timezone — authoritative for calendar-day interpretation.
    const org = await db.organization.findUnique({
      where: { id: orgId },
      select: { timezone: true },
    });
    const orgTz = org?.timezone || 'UTC';

    const { searchParams } = new URL(req.url);
    const mode = searchParams.get('mode');

    if (mode === 'departments') {
      const id1 = searchParams.get('id1');
      const id2 = searchParams.get('id2');
      if (!id1 || !id2) {
        return NextResponse.json({ error: 'id1 and id2 are required for departments mode' }, { status: 400 });
      }

      // Optional shared range — bounds the department queries. When absent,
      // getDepartmentAnalytics falls back to a trailing 90-day window.
      const startDateParam = searchParams.get('startDate');
      const endDateParam = searchParams.get('endDate');
      let deptStart: Date | undefined;
      let deptEnd: Date | undefined;
      if (startDateParam && endDateParam) {
        if (!DAY_KEY_RE.test(startDateParam) || !DAY_KEY_RE.test(endDateParam)) {
          return NextResponse.json({ error: 'startDate and endDate must be YYYY-MM-DD' }, { status: 400 });
        }
        if (startDateParam > endDateParam) {
          return NextResponse.json({ error: 'startDate must not be after endDate' }, { status: 400 });
        }
        deptStart = zonedDayStart(startDateParam, orgTz);
        deptEnd = zonedDayEnd(endDateParam, orgTz);
      }

      const [dept1, dept2] = await Promise.all([
        db.department.findFirst({ where: { id: id1, organizationId: orgId }, select: { id: true, name: true } }),
        db.department.findFirst({ where: { id: id2, organizationId: orgId }, select: { id: true, name: true } }),
      ]);

      if (!dept1 || !dept2) {
        // Conceal existence of cross-org resources.
        return NextResponse.json({ error: 'One or both departments not found' }, { status: 404 });
      }

      const [data1, data2] = await Promise.all([
        getDepartmentAnalytics(id1, orgId, deptStart, deptEnd),
        getDepartmentAnalytics(id2, orgId, deptStart, deptEnd),
      ]);

      return NextResponse.json({
        mode: 'departments',
        entityA: { id: dept1.id, name: dept1.name, ...data1 },
        entityB: { id: dept2.id, name: dept2.name, ...data2 },
      });
    }

    if (mode === 'periods') {
      const startDate1 = searchParams.get('startDate1');
      const endDate1 = searchParams.get('endDate1');
      const startDate2 = searchParams.get('startDate2');
      const endDate2 = searchParams.get('endDate2');

      if (!startDate1 || !endDate1 || !startDate2 || !endDate2) {
        return NextResponse.json({ error: 'All four date params are required for periods mode' }, { status: 400 });
      }
      if (
        !DAY_KEY_RE.test(startDate1) || !DAY_KEY_RE.test(endDate1) ||
        !DAY_KEY_RE.test(startDate2) || !DAY_KEY_RE.test(endDate2)
      ) {
        return NextResponse.json({ error: 'Period dates must be YYYY-MM-DD' }, { status: 400 });
      }
      if (startDate1 > endDate1 || startDate2 > endDate2) {
        return NextResponse.json({ error: 'Each period start date must not be after its end date' }, { status: 400 });
      }

      const [data1, data2] = await Promise.all([
        getAnalyticsForPeriod(startDate1, endDate1, orgId, orgTz),
        getAnalyticsForPeriod(startDate2, endDate2, orgId, orgTz),
      ]);

      // Format the label from the YYYY-MM-DD strings directly — never via
      // new Date(s).toLocaleDateString, which would interpret them as UTC
      // midnight and shift the label in the server's own timezone.
      const fmtPeriod = (s: string, e: string) => {
        const label = (key: string, withYear: boolean) => {
          const [y, m, d] = key.split('-').map(Number);
          const name = new Date(Date.UTC(y, m - 1, d)).toLocaleDateString('en-US', {
            month: 'short',
            day: 'numeric',
            ...(withYear ? { year: 'numeric' } : {}),
            timeZone: 'UTC',
          });
          return name;
        };
        return `${label(s, false)} - ${label(e, true)}`;
      };

      return NextResponse.json({
        mode: 'periods',
        entityA: { name: fmtPeriod(startDate1, endDate1), ...data1 },
        entityB: { name: fmtPeriod(startDate2, endDate2), ...data2 },
      });
    }

    return NextResponse.json({ error: 'mode parameter is required (departments or periods)' }, { status: 400 });
  } catch (error) {
    if (error instanceof OrgScopeError) {
      return NextResponse.json({ error: 'Department not found' }, { status: 404 });
    }
    log.error('api.analytics.compare.', { error: String('Analytics compare error:') }, requestContext(req));
    return NextResponse.json({ error: 'Failed to fetch comparison data' }, { status: 500 });
  }
}
