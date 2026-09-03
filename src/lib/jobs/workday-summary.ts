/**
 * OmniSight — WorkDaySummary aggregation job (Phase 4).
 *
 * Computes one WorkDaySummary per (organization, employee, org-local day) for
 * a bounded trailing window and UPSERTS it on the unique key. Semantics:
 *
 *  - Deterministic whole-day recompute + upsert (never "existing +
 *    incremental"), so repeated runs, restarts and concurrent attempts all
 *    produce the SAME row content — idempotent by construction. The JobRun
 *    lease (`workday_summary`) makes concurrent runs impossible anyway.
 *  - Window: trailing local days from (today - windowDays + 1) .. today where
 *    windowDays = activity retention days clamped to [7, 90] (or the 90-day
 *    product window when retention is 0 = never purge). The job never scans
 *    the whole Activity table; every query is bounded to one org and one
 *    org-local day.
 *  - Org isolation: rows resolve org through the employee relation (Activity
 *    has no org column), and each org runs under its own try/catch — one
 *    failing org never blocks the others.
 *  - No fabrication: a summary row is only written for an (employee, day)
 *    that has at least one counted activity row or break overlap. A day with
 *    no telemetry (offline, weekend, not yet monitored) produces NO row —
 *    consumers treat missing as "no data", matching the dashboard today.
 *  - Timezone: day boundaries and the work window come from
 *    Organization.timezone (helpers in src/lib/timezone.ts +
 *    src/lib/anomalies/time.ts). One fixed `now` is pinned per run so a run
 *    is internally deterministic.
 *
 * `rebuildDaysForOrg` is the shared low-level seam used by the job AND by the
 * admin rebuild route (bounded org/employee/date-range rebuild, no raw data
 * deletion, no unbounded transaction).
 */

import { db } from '@/lib/db';
import { claimJob, finishJob } from './run';
import { getOrgSetting } from './settings';
import { safeTimezone, localDayKey, zonedDayStart, zonedDayEnd, addDaysToKey, dayKeysBetween } from '@/lib/timezone';
import { parseHHMM } from '@/lib/anomalies/time';
import { aggregateEmployeeDay, breakSessionOverlapSeconds, type WorkDayActivityRow } from '@/lib/workday/summary';

export interface WorkDaySummaryJobResult {
  orgsScanned: number;
  orgsSkipped: number;
  orgsFailed: number;
  summariesUpserted: number;
  employeesWithData: number;
  windowStartKey: string | null;
  windowEndKey: string | null;
  errors: string[];
}

export interface WorkDayJobOptions {
  /** Pinned clock for deterministic runs/tests. */
  now?: Date;
  /** Restrict to specific orgs (route-level single-org runs). */
  orgIds?: string[];
  /** Restrict to one employee (route-level rebuild runs). */
  employeeId?: string;
  /** Override the trailing window size (days). Tests use this. */
  windowDays?: number;
}

/** Product reporting window ceiling — the job never scans beyond it. */
export const MAX_AGGREGATION_WINDOW_DAYS = 90;
/** Never aggregate less than a week of trailing days. */
export const MIN_AGGREGATION_WINDOW_DAYS = 7;

export async function resolveAggregationWindowDays(orgId: string, fallback = 0): Promise<number> {
  let retention = fallback;
  if (retention <= 0) {
    const raw = await getOrgSetting(orgId, 'activity_retention_days', '90');
    const n = parseInt(raw, 10);
    retention = Number.isNaN(n) || n < 0 ? 90 : n;
  }
  if (retention === 0) return MAX_AGGREGATION_WINDOW_DAYS; // never purge → product window
  return Math.min(MAX_AGGREGATION_WINDOW_DAYS, Math.max(MIN_AGGREGATION_WINDOW_DAYS, retention));
}

export interface RebuildDayResult {
  upserted: number;
  employeesWithData: number;
  skippedNoEmployees: boolean;
  errors: string[];
}

/**
 * Recompute summaries for one org over the given org-local day keys
 * (YYYY-MM-DD, oldest first). Deterministic whole-day rebuild + upsert.
 */
export async function rebuildDaysForOrg(
  orgId: string,
  dayKeys: string[],
  options: { now?: Date; employeeId?: string } = {}
): Promise<RebuildDayResult> {
  const result: RebuildDayResult = { upserted: 0, employeesWithData: 0, skippedNoEmployees: false, errors: [] };
  if (dayKeys.length === 0) return result;

  const now = options.now ?? new Date();
  const org = await db.organization.findUnique({
    where: { id: orgId },
    select: { id: true, timezone: true },
  });
  if (!org) {
    result.errors.push(`org ${orgId}: not found`);
    return result;
  }
  const tz = safeTimezone(org.timezone);

  const [workStartRaw, workEndRaw] = await Promise.all([
    getOrgSetting(orgId, 'work_start_time', '09:00'),
    getOrgSetting(orgId, 'work_end_time', '18:00'),
  ]);
  const workStartMinutes = parseHHMM(workStartRaw) ?? 9 * 60;
  const workEndMinutes = parseHHMM(workEndRaw) ?? 18 * 60;

  const employeeWhere = options.employeeId ? { id: options.employeeId } : {};
  const employees = await db.employee.findMany({
    where: { organizationId: orgId, ...employeeWhere },
    select: { id: true },
  });
  if (employees.length === 0) {
    result.skippedNoEmployees = true;
    return result;
  }
  const employeeIds = employees.map((e) => e.id);

  // ── Break sessions that can touch the window (open sessions clipped to now) ──
  const windowStartKey = dayKeys[0];
  const windowEndKey = dayKeys[dayKeys.length - 1];
  const windowStart = zonedDayStart(windowStartKey, tz);
  const windowEndExclusive = new Date(zonedDayEnd(windowEndKey, tz).getTime() + 1);

  const breakSessions = await db.breakSession.findMany({
    where: {
      organizationId: orgId,
      ...(options.employeeId ? { employeeId: options.employeeId } : {}),
      startedAt: { lt: windowEndExclusive },
      OR: [{ endedAt: null }, { endedAt: { gte: windowStart } }],
    },
    select: { employeeId: true, startedAt: true, endedAt: true },
  });

  // emp → dayKey → breakSeconds (all sessions, overlap clipped to the day).
  const breakByDay = new Map<string, Map<string, number>>();
  for (const session of breakSessions) {
    let dayBreak = breakByDay.get(session.employeeId);
    if (!dayBreak) {
      dayBreak = new Map();
      breakByDay.set(session.employeeId, dayBreak);
    }
    for (const key of dayKeys) {
      const overlap = breakSessionOverlapSeconds(session, zonedDayStart(key, tz), zonedDayEnd(key, tz), now);
      if (overlap > 0) dayBreak.set(key, (dayBreak.get(key) ?? 0) + overlap);
    }
  }

  // ── Per-day activity load (bounded: one org × one org-local day per query) ──
  // Rows are queried per org-local day so every returned row belongs to that
  // exact day (zonedDayStart/zonedDayEnd are the true local midnights), which
  // keeps each query small and the in-memory partition trivial.
  const rowsByDayByEmp = new Map<string, Map<string, WorkDayActivityRow[]>>(); // day → emp → rows
  for (const key of dayKeys) {
    const dayStart = zonedDayStart(key, tz);
    const dayEndExclusive = new Date(zonedDayEnd(key, tz).getTime() + 1);
    const rows = await db.activity.findMany({
      where: {
        employeeId: { in: employeeIds },
        timestamp: { gte: dayStart, lt: dayEndExclusive },
      },
      select: { employeeId: true, type: true, title: true, applicationName: true, category: true, duration: true, timestamp: true },
    });
    if (rows.length === 0) continue;
    const byEmp = new Map<string, WorkDayActivityRow[]>();
    for (const r of rows) {
      const row: WorkDayActivityRow = {
        type: r.type,
        title: r.title,
        applicationName: r.applicationName,
        category: r.category,
        duration: r.duration,
        timestamp: r.timestamp,
      };
      const list = byEmp.get(r.employeeId);
      if (list) list.push(row);
      else byEmp.set(r.employeeId, [row]);
    }
    rowsByDayByEmp.set(key, byEmp);
  }
  if (rowsByDayByEmp.size === 0 && breakByDay.size === 0) return result;

  // ── Aggregate + upsert (whole-day deterministic content) ───────────────────
  const upserts: Array<{
    organizationId: string;
    employeeId: string;
    workDate: string;
    productiveSeconds: number;
    neutralSeconds: number;
    unproductiveSeconds: number;
    idleSeconds: number;
    activeSeconds: number;
    workingSeconds: number;
    outsideHoursSeconds: number;
    breakSeconds: number;
    activityCount: number;
    websiteActivityCount: number;
    applicationActivityCount: number;
  }> = [];

  for (const key of dayKeys) {
    const byEmp = rowsByDayByEmp.get(key);
    const empsWithRows = byEmp ? [...byEmp.keys()] : [];
    const empsWithBreaks = breakByDay.size > 0 ? [...breakByDay.keys()].filter((emp) => (breakByDay.get(emp)?.get(key) ?? 0) > 0) : [];
    // Fast path: rows were loaded for exactly this org-local window. The
    // window is the TRUE local-day span (zonedDayStart → zonedDayEnd+1), so
    // a DST-transition day is never mislabeled as a plain 24 h day.
    const dayStartMs = zonedDayStart(key, tz).getTime();
    const dayEndExclusiveMs = zonedDayEnd(key, tz).getTime() + 1;
    const seen = new Set<string>();
    for (const empId of [...empsWithRows, ...empsWithBreaks]) {
      if (seen.has(empId)) continue;
      seen.add(empId);
      const totals = aggregateEmployeeDay({
        dayKey: key,
        timezone: tz,
        activities: byEmp?.get(empId) ?? [],
        workStartMinutes,
        workEndMinutes,
        breakSeconds: breakByDay.get(empId)?.get(key) ?? 0,
        localDayWindowMs: { startMs: dayStartMs, endExclusiveMs: dayEndExclusiveMs },
      });
      upserts.push({
        organizationId: orgId,
        employeeId: empId,
        workDate: key,
        productiveSeconds: totals.productiveSeconds,
        neutralSeconds: totals.neutralSeconds,
        unproductiveSeconds: totals.unproductiveSeconds,
        idleSeconds: totals.idleSeconds,
        activeSeconds: totals.activeSeconds,
        workingSeconds: totals.workingSeconds,
        outsideHoursSeconds: totals.outsideHoursSeconds,
        breakSeconds: totals.breakSeconds,
        activityCount: totals.activityCount,
        websiteActivityCount: totals.websiteActivityCount,
        applicationActivityCount: totals.applicationActivityCount,
      });
    }
  }

  // Batch upserts in bounded transactions (50/commit — never one unbounded
  // transaction). The content is a full-day recompute, so an existing row is
  // REPLACED, never accumulated.
  for (let i = 0; i < upserts.length; i += 50) {
    const chunk = upserts.slice(i, i + 50);
    await db.$transaction(
      chunk.map((u) =>
        db.workDaySummary.upsert({
          where: {
            organizationId_employeeId_workDate: {
              organizationId: u.organizationId,
              employeeId: u.employeeId,
              workDate: u.workDate,
            },
          },
          create: u,
          update: u,
        })
      )
    );
    result.upserted += chunk.length;
  }
  result.employeesWithData = new Set(upserts.map((u) => u.employeeId)).size;
  return result;
}

export async function runWorkDaySummaryJob(options: WorkDayJobOptions = {}): Promise<WorkDaySummaryJobResult> {
  const result: WorkDaySummaryJobResult = {
    orgsScanned: 0,
    orgsSkipped: 0,
    orgsFailed: 0,
    summariesUpserted: 0,
    employeesWithData: 0,
    windowStartKey: null,
    windowEndKey: null,
    errors: [],
  };

  if (!(await claimJob('workday_summary'))) {
    return result; // lease held elsewhere — no-op this round
  }

  try {
    const now = options.now ?? new Date();
    const orgs = options.orgIds && options.orgIds.length > 0
      ? await db.organization.findMany({ where: { id: { in: options.orgIds } }, select: { id: true, timezone: true } })
      : await db.organization.findMany({ where: { status: 'active' }, select: { id: true, timezone: true } });

    for (const org of orgs) {
      try {
        const tz = safeTimezone(org.timezone);
        const windowDays = options.windowDays ?? (await resolveAggregationWindowDays(org.id));
        const todayKey = localDayKey(now, tz);
        const startKey = addDaysToKey(todayKey, -(windowDays - 1));
        const dayKeys = dayKeysBetween(startKey, todayKey);
        result.windowStartKey = result.windowStartKey ?? startKey;
        result.windowEndKey = todayKey;

        const rebuild = await rebuildDaysForOrg(org.id, dayKeys, { now, employeeId: options.employeeId });
        result.orgsScanned += 1;
        if (rebuild.skippedNoEmployees) result.orgsSkipped += 1;
        result.summariesUpserted += rebuild.upserted;
        result.employeesWithData += rebuild.employeesWithData;
        if (rebuild.errors.length > 0) {
          result.errors.push(...rebuild.errors);
          result.orgsFailed += 1;
        }
      } catch (error) {
        result.orgsFailed += 1;
        result.errors.push(`org ${org.id}: ${String(error)}`);
        console.error(`[jobs] workday summary failed for org ${org.id}, continuing:`, error);
      }
    }

    if (result.errors.length > 0) {
      await finishJob('workday_summary', result.errors.join('; '), { ...result });
    } else {
      await finishJob('workday_summary', undefined, { ...result });
    }
    return result;
  } catch (error) {
    await finishJob('workday_summary', String(error));
    throw error;
  }
}
