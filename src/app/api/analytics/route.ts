'use server';
import { NextRequest, NextResponse } from 'next/server';
import { Prisma } from '@prisma/client';
import { db } from '@/lib/db';
import { authError, requireSessionOrg } from '@/lib/api';
import { NON_INTERNAL_AGENT_ACTIVITY_FILTER, INTERNAL_AGENT_PROCESS_NAMES } from '@/lib/agent-process';
import { zonedDayStart, zonedDayEnd, dayKeysBetween, lastNDayKeys } from '@/lib/timezone';
import { log, requestContext } from '@/lib/logger';

/**
 * P2-1 — analytics aggregation is now DATABASE-SIDE.
 *
 * OLD behavior: one `findMany` materialized every Activity row in the window
 * (90 days worst case, with the full employee object included) and computed
 * summaries, trends, department buckets and top apps in JS. Memory grew
 * linearly with activity volume (≈ rows × 1KB+).
 *
 * NEW behavior:
 *   - summary (workload distribution, totals) ........ Prisma groupBy(category)
 *   - activeEmployees ................................ Prisma groupBy(employeeId)
 *   - productivityTrends ............................ raw SQL: per (org-local
 *     day, category) aggregates via `(timestamp AT TIME ZONE <org>)::date`
 *   - departmentProductivity ........................ Prisma groupBy(employeeId,
 *     category) bucketed by the employee→department map
 *   - topApps ....................................... raw SQL: per app key with
 *     SUM(duration), COUNT, and first-row type/category (order = createdAt,id,
 *     the deterministic equivalent of the previous insertion-order scan)
 *
 * Memory is now O(window days + employees + departments + distinct app keys),
 * independent of activity row count. Output semantics are preserved exactly —
 * the same category sums, day buckets (org timezone), and largest-remainder
 * workload distribution.
 *
 * Remaining limitation: the raw-SQL day bucketing relies on Postgres
 * `AT TIME ZONE` (IANA tzdata) matching Node Intl `localDayKey` for
 * production timestamps (all modern dates — both use IANA data, so they
 * agree; verified by the reference-comparison test on this exact dataset).
 */
function emptyAnalytics() {
  return NextResponse.json({
    data: {
      productivityTrends: [],
      departmentProductivity: [],
      topApps: [],
      summary: {
        totalActivities: 0,
        avgProductivity: 0,
        totalProductiveHours: 0,
        activeEmployees: 0,
        workloadDistribution: { productive: 0, neutral: 0, unproductive: 0 },
      },
    },
  });
}

export async function GET(req: NextRequest) {
  try {
    // Tenant isolation: analytics are organization-scoped from the verified
    // session — never from client input. Org-less super_admins (bootstrap)
    // get a valid EMPTY analytics response.
    const scope = await requireSessionOrg(req, { allowGlobal: true });
    if (!scope.ok) return authError(scope);
    if (!scope.organizationId) return emptyAnalytics();
    const orgId = scope.organizationId;

    const { searchParams } = new URL(req.url);
    const period = searchParams.get('period') || 'week';
    const startDateParam = searchParams.get('startDate');
    const endDateParam = searchParams.get('endDate');

    // Organization timezone is the single source of truth for local calendar
    // day boundaries — a selected date is interpreted as that calendar day in
    // the ORG timezone, never as a UTC timestamp (Asia/Dhaka +06 shifts the
    // UTC day back by 6h, which silently moved buckets to the previous day).
    const org = await db.organization.findUnique({
      where: { id: orgId },
      select: { timezone: true },
    });
    const orgTz = org?.timezone || 'UTC';

    let startKey: string;
    let endKey: string;

    if (startDateParam && endDateParam) {
      // Defensive validation: malformed or inverted ranges are rejected with
      // 400 — never silently turned into empty charts.
      const dayRe = /^\d{4}-\d{2}-\d{2}$/;
      if (!dayRe.test(startDateParam) || !dayRe.test(endDateParam)) {
        return NextResponse.json({ error: 'startDate and endDate must be YYYY-MM-DD' }, { status: 400 });
      }
      if (startDateParam > endDateParam) {
        return NextResponse.json({ error: 'startDate must not be after endDate' }, { status: 400 });
      }
      startKey = startDateParam;
      endKey = endDateParam;
    } else {
      const days = period === 'month' ? 30 : period === 'week' ? 7 : 1;
      const keys = lastNDayKeys(orgTz, days, new Date());
      startKey = keys[0];
      endKey = keys[keys.length - 1];
    }

    // Org-local day boundaries for the DB window (inclusive end).
    const startDate = zonedDayStart(startKey, orgTz);
    const endDate = zonedDayEnd(endKey, orgTz);
    const allDayKeys = dayKeysBetween(startKey, endKey);
    const cappedDayKeys = allDayKeys.slice(0, 90);

    // Shared scope predicate — org-scoped via the employee relation and
    // excluding the monitoring agent's own process (see lib/agent-process.ts)
    // at the DATA layer so it contributes zero count/duration anywhere.
    const where: Prisma.ActivityWhereInput = {
      timestamp: { gte: startDate, lte: endDate },
      employee: { organizationId: orgId },
      ...NON_INTERNAL_AGENT_ACTIVITY_FILTER,
    };

    // ── Summary: workload distribution + totals (zero rows materialized) ──
    const byCategory = await db.activity.groupBy({
      by: ['category'],
      where,
      _sum: { duration: true },
      _count: { _all: true },
    });
    const sumOf = (cat: string | null) =>
      byCategory.filter((g) => g.category === cat).reduce((s, g) => s + (g._sum?.duration ?? 0), 0);
    const totalDuration = byCategory.reduce((s, g) => s + (g._sum?.duration ?? 0), 0);
    const productiveDuration = sumOf('productive');
    const neutralDuration = sumOf('neutral');
    const unproductiveDuration = sumOf('unproductive');
    const totalActivities = byCategory.reduce((s, g) => s + (g._count?._all ?? 0), 0);

    // ── Active employees in period (distinct employeeIds, zero rows) ──
    const empGroups = await db.activity.groupBy({ by: ['employeeId'], where });
    const activeEmployees = empGroups.length;

    // ── Productivity trends: per (org-local day, category) from the DB. The
    // org-local calendar day is computed in PostgreSQL (`AT TIME ZONE`) so no
    // activity row is ever shipped to the application layer. ──
    // NOTE on raw-SQL date handling (two traps, both handled):
    //  1. Activity."timestamp" is TIMESTAMP(3) WITHOUT time zone storing UTC
    //     wall time (Prisma convention). `naive AT TIME ZONE zone` would
    //     interpret it AS local time in `zone` (wrong direction), so we first
    //     convert to timestamptz at UTC, then to the org zone's wall clock.
    //  2. Prisma binds Date params as ISO strings; Postgres then casts
    //     timestamptz→timestamp at the SESSION timezone (Asia/Dhaka here),
    //     silently shifting window bounds by the offset. Bounds are therefore
    //     sent as naive UTC wall-clock text and cast `::timestamp` explicitly
    //     so every comparison is session-TZ independent.
    const utcTs = (d: Date) => d.toISOString().slice(0, 19).replace('T', ' ');
    const trendRows = await db.$queryRaw<Array<{ day: string; category: string | null; duration: bigint }>>`
      SELECT
        (a."timestamp" AT TIME ZONE 'UTC' AT TIME ZONE ${orgTz})::date::text AS "day",
        a."category" AS "category",
        SUM(a."duration")::bigint AS "duration"
      FROM "Activity" a
      INNER JOIN "Employee" e ON e."id" = a."employeeId"
      WHERE a."timestamp" >= ${utcTs(startDate)}::timestamp
        AND a."timestamp" <= ${utcTs(endDate)}::timestamp
        AND e."organizationId" = ${orgId}
        AND (a."applicationName" IS NULL OR LOWER(a."applicationName") NOT IN (${Prisma.join(INTERNAL_AGENT_PROCESS_NAMES)}))
      GROUP BY 1, 2
    `;
    const dayMap = new Map<string, { total: number; productive: number; neutral: number; unproductive: number }>();
    for (const r of trendRows) {
      const entry = dayMap.get(r.day) ?? { total: 0, productive: 0, neutral: 0, unproductive: 0 };
      const dur = Number(r.duration);
      // `total` includes ALL durations (rows with a null/other category too) —
      // identical to the old `dayActs.reduce((s, a) => s + a.duration, 0)`.
      entry.total += dur;
      if (r.category === 'productive') entry.productive += dur;
      else if (r.category === 'neutral') entry.neutral += dur;
      else if (r.category === 'unproductive') entry.unproductive += dur;
      dayMap.set(r.day, entry);
    }

    // Productivity trends — same day buckets and math as the previous
    // in-memory computation, now backed by DB aggregates.
    const productivityTrends = cappedDayKeys.map((key) => {
      const v = dayMap.get(key) ?? { total: 0, productive: 0, neutral: 0, unproductive: 0 };
      const total = v.total;
      const score = total > 0 ? Math.round((v.productive / total) * 100) : 0;
      return {
        date: new Date(`${key}T00:00:00Z`).toLocaleDateString('en-US', {
          month: 'short',
          day: 'numeric',
          timeZone: 'UTC',
        }),
        dateISO: key,
        score,
        totalMinutes: Math.round(total / 60),
        productiveMinutes: Math.round(v.productive / 60),
        neutralMinutes: Math.round(v.neutral / 60),
        unproductiveMinutes: Math.round(v.unproductive / 60),
      };
    });

    // ── Department breakdown: employee→category sums, bucketed by the
    // employee→department map (same membership semantics as before). ──
    const departments = await db.department.findMany({
      where: { organizationId: orgId },
      include: { _count: { select: { employees: true } } },
    });

    const deptEmployees = await db.employee.findMany({
      where: { departmentId: { in: departments.map((d) => d.id) }, status: 'active', organizationId: orgId },
      select: { id: true, departmentId: true },
    });
    const employeesByDept = new Map<string, Set<string>>();
    for (const e of deptEmployees) {
      if (!e.departmentId) continue;
      const set = employeesByDept.get(e.departmentId) ?? new Set<string>();
      set.add(e.id);
      employeesByDept.set(e.departmentId, set);
    }

    const deptBuckets = await db.activity.groupBy({
      by: ['employeeId', 'category'],
      where,
      _sum: { duration: true },
    });
    const empBuckets = new Map<string, Map<string | null, number>>();
    for (const g of deptBuckets) {
      const m = empBuckets.get(g.employeeId) ?? new Map<string | null, number>();
      m.set(g.category, (m.get(g.category) ?? 0) + (g._sum?.duration ?? 0));
      empBuckets.set(g.employeeId, m);
    }

    const departmentProductivity = departments.map((dept) => {
        const empIds = employeesByDept.get(dept.id) ?? new Set<string>();
        let total = 0;
        let productive = 0;
        let neutral = 0;
        let unproductive = 0;
        for (const id of empIds) {
          const m = empBuckets.get(id);
          if (!m) continue;
          for (const [cat, dur] of m) {
            total += dur;
            if (cat === 'productive') productive += dur;
            else if (cat === 'neutral') neutral += dur;
            else if (cat === 'unproductive') unproductive += dur;
          }
        }

        return {
          department: dept.name,
          employees: dept._count.employees,
          score: total > 0 ? Math.round((productive / total) * 100) : 0,
          productive: Math.round(productive / 60),
          neutral: Math.round(neutral / 60),
          unproductive: Math.round(unproductive / 60),
        };
      });

    // ── Top apps/websites: per-key SUM(duration)/COUNT from the DB. Key is
    // the first non-null of applicationName/url/title (else 'Unknown') — the
    // COALESCE below is the exact SQL form of the old `a.applicationName ||
    // a.url || a.title || 'Unknown'`. Type/category fall back to the FIRST
    // row (deterministic: earliest createdAt, then id — the old scan was
    // insertion-ordered), except 'productive' wins when ANY row is
    // productive (the old JS overwrote the category with 'productive' on
    // sight of a productive row). ──
    const appRows = await db.$queryRaw<Array<{ key: string; type: string; category: string | null; duration: bigint; count: number }>>`
      SELECT
        COALESCE(a."applicationName", a."url", a."title", 'Unknown') AS "key",
        (array_agg(a."type" ORDER BY a."createdAt", a."id"))[1] AS "type",
        CASE
          WHEN bool_or(a."category" = 'productive') THEN 'productive'
          ELSE COALESCE((array_agg(a."category" ORDER BY a."createdAt", a."id"))[1], 'neutral')
        END AS "category",
        SUM(a."duration")::bigint AS "duration",
        COUNT(*)::int AS "count"
      FROM "Activity" a
      INNER JOIN "Employee" e ON e."id" = a."employeeId"
      WHERE a."timestamp" >= ${utcTs(startDate)}::timestamp
        AND a."timestamp" <= ${utcTs(endDate)}::timestamp
        AND e."organizationId" = ${orgId}
        AND (a."applicationName" IS NULL OR LOWER(a."applicationName") NOT IN (${Prisma.join(INTERNAL_AGENT_PROCESS_NAMES)}))
      GROUP BY 1
    `;
    const topApps = appRows
      .sort((x, y) => Number(y.duration) - Number(x.duration))
      .slice(0, 10)
      .map((a) => ({
        name: a.key,
        duration: Number(a.duration),
        count: a.count,
        type: a.type,
        category: a.category,
        durationMinutes: Math.round(Number(a.duration) / 60),
      }));

    return NextResponse.json({
      data: {
        productivityTrends,
        departmentProductivity,
        topApps,
        summary: {
          totalActivities,
          avgProductivity: productivityTrends.length > 0
            ? Math.round(productivityTrends.reduce((s, t) => s + t.score, 0) / productivityTrends.length)
            : 0,
          totalProductiveHours: Math.round(productiveDuration / 3600 * 10) / 10,
          activeEmployees,
          workloadDistribution: (() => {
            if (totalDuration === 0) return { productive: 0, neutral: 0, unproductive: 0 };
            const raw = {
              productive: (productiveDuration / totalDuration) * 100,
              neutral: (neutralDuration / totalDuration) * 100,
              unproductive: (unproductiveDuration / totalDuration) * 100,
            };
            // Largest-remainder method to ensure sum = 100
            const keys = ['productive', 'neutral', 'unproductive'] as const;
            const floored = Object.fromEntries(keys.map(k => [k, Math.floor(raw[k])]));
            const remainders = Object.fromEntries(keys.map(k => [k, raw[k] - floored[k]]));
            let sum = Object.values(floored).reduce((s, v) => s + v, 0);
            const sorted = [...keys].sort((a, b) => (remainders[b] ?? 0) - (remainders[a] ?? 0));
            for (const k of sorted) {
              if (sum >= 100) break;
              floored[k] = (floored[k] ?? 0) + 1;
              sum += 1;
            }
            return floored as Record<string, number>;
          })(),
        },
      },
    });
  } catch (error) {
    log.error('api.analytics.', { error: String('Analytics GET error:') }, requestContext(req));
    return NextResponse.json({ error: 'Failed to fetch analytics' }, { status: 500 });
  }
}
