/**
 * OmniSight — WorkDaySummary consumer reader (dashboard wiring).
 *
 * Reads per-employee daily totals for a range of ORG-LOCAL day keys from the
 * WorkDaySummary rollup table, with an EXACT raw-row fallback for any day the
 * rollup does not cover:
 *
 *  - the CURRENT org-local day (its summary is partial until the day ends —
 *    consumers that need live numbers always read raw for today);
 *  - any past day with NO WorkDaySummary rows for the org (pre-backfill
 *    installs, orgs whose hourly job has not run yet, tests).
 *
 * The fallback computes the SAME numbers the aggregation job would write —
 * same org-local window, same engine, same exclusions — so a consumer sees
 * byte-identical values regardless of whether a day is served from the rollup
 * or from raw rows. Deterministic rebuild semantics make this safe: covered
 * days are authoritative, uncovered days fall back, and mixing never
 * double-counts (each day is read from exactly one source).
 *
 * Consumers whose displayed metrics depend on data WorkDaySummary does not
 * store (per-ROW counts, per-ROW-rounded minutes, all-time history, or totals
 * including un-categorized durations) MUST keep their existing raw algorithms
 * — see docs/PHASE-4-REPORT.md "consumer fit" notes. This module only serves
 * the exact-fit surfaces (per-second p/n/u/idle/counts per org-local day).
 */

import { db } from '@/lib/db';
import { localDayKey, zonedDayStart, zonedDayEnd, safeTimezone } from '@/lib/timezone';
import { aggregateEmployeeDay, type WorkDayActivityRow } from './summary';

export interface EmployeeDayTotal {
  employeeId: string;
  workDate: string;
  productiveSeconds: number;
  neutralSeconds: number;
  unproductiveSeconds: number;
  idleSeconds: number;
  activeSeconds: number;
  activityCount: number;
}

export type DaySource = 'summary' | 'raw';

export interface ReadOrgDayTotalsResult {
  /** dayKey → employeeId → totals (only employees with data that day). */
  rows: Map<string, Map<string, EmployeeDayTotal>>;
  /** dayKey → source actually used (raw fallback for today/uncovered days). */
  source: Map<string, DaySource>;
  /** Requested keys that are in the future (never aggregated/read). */
  skippedFutureKeys: string[];
}

export interface ReadOrgDayTotalsOptions {
  organizationId: string;
  /** Organization IANA timezone — day boundaries are NEVER server-local. */
  timezone: string;
  /** Org-local day keys (YYYY-MM-DD), oldest first. */
  dayKeys: string[];
  /** Pinned clock for deterministic behavior/tests. */
  now?: Date;
}

/**
 * Read per-employee totals for the requested org-local days. Days with no
 * rollup coverage (and the current local day) are computed from raw rows via
 * the same engine — never fabricated, never mixed within a day.
 */
export async function readOrgDayTotals(options: ReadOrgDayTotalsOptions): Promise<ReadOrgDayTotalsResult> {
  const tz = safeTimezone(options.timezone);
  const now = options.now ?? new Date();
  const todayKey = localDayKey(now, tz);

  const rows = new Map<string, Map<string, EmployeeDayTotal>>();
  const source = new Map<string, DaySource>();
  const skippedFutureKeys: string[] = [];

  const validKeys = options.dayKeys.filter((key) => key <= todayKey);
  for (const key of options.dayKeys) {
    if (!validKeys.includes(key)) skippedFutureKeys.push(key);
  }
  if (validKeys.length === 0) return { rows, source, skippedFutureKeys };

  // Rollup rows for the covered keys (today is NEVER served from the rollup —
  // its summary is partial until the day completes).
  const coveredKeys = validKeys.filter((key) => key !== todayKey);
  const summaryRows = await db.workDaySummary.findMany({
    where: { organizationId: options.organizationId, workDate: { in: coveredKeys } },
    select: {
      employeeId: true,
      workDate: true,
      productiveSeconds: true,
      neutralSeconds: true,
      unproductiveSeconds: true,
      idleSeconds: true,
      activeSeconds: true,
      activityCount: true,
    },
  });

  // A day is "covered" only when the org has ≥ 1 rollup row for it (an org
  // whose job never ran has none and falls back wholesale).
  const coveredDaySet = new Set(summaryRows.map((r) => r.workDate));
  for (const row of summaryRows) {
    let byEmp = rows.get(row.workDate);
    if (!byEmp) {
      byEmp = new Map();
      rows.set(row.workDate, byEmp);
    }
    byEmp.set(row.employeeId, {
      employeeId: row.employeeId,
      workDate: row.workDate,
      productiveSeconds: row.productiveSeconds,
      neutralSeconds: row.neutralSeconds,
      unproductiveSeconds: row.unproductiveSeconds,
      idleSeconds: row.idleSeconds,
      activeSeconds: row.activeSeconds,
      activityCount: row.activityCount,
    });
  }
  for (const key of coveredDaySet) source.set(key, 'summary');

  // Raw fallback: today always, plus any requested past day with no rollup
  // coverage. One org-local-day query per uncovered day, aggregated through
  // the SAME engine (never persisted). Tenancy is enforced in SQL via the
  // employee→organization relation (never a client-supplied org/employee id).
  const rawKeys = validKeys.filter((key) => key === todayKey || !coveredDaySet.has(key));
  if (rawKeys.length > 0) {
    for (const key of rawKeys) {
      const dayStart = zonedDayStart(key, tz);
      const dayEndExclusive = new Date(zonedDayEnd(key, tz).getTime() + 1);
      const activityRows = await db.activity.findMany({
        where: {
          employee: { organizationId: options.organizationId },
          timestamp: { gte: dayStart, lt: dayEndExclusive },
        },
        select: { employeeId: true, type: true, title: true, applicationName: true, category: true, duration: true, timestamp: true },
      });
      if (activityRows.length === 0) continue;

      const byEmp = new Map<string, WorkDayActivityRow[]>();
      for (const r of activityRows) {
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

      const dayTotals = new Map<string, EmployeeDayTotal>();
      for (const [empId, empRows] of byEmp) {
        const totals = aggregateEmployeeDay({
          dayKey: key,
          timezone: tz,
          activities: empRows,
          workStartMinutes: 0,
          workEndMinutes: 1440,
          breakSeconds: 0,
          // Rows were loaded for exactly this org-local window.
          localDayWindowMs: { startMs: dayStart.getTime(), endExclusiveMs: dayEndExclusive.getTime() },
        });
        dayTotals.set(empId, {
          employeeId: empId,
          workDate: key,
          productiveSeconds: totals.productiveSeconds,
          neutralSeconds: totals.neutralSeconds,
          unproductiveSeconds: totals.unproductiveSeconds,
          idleSeconds: totals.idleSeconds,
          activeSeconds: totals.activeSeconds,
          activityCount: totals.activityCount,
        });
      }
      if (dayTotals.size > 0) {
        rows.set(key, dayTotals);
        source.set(key, 'raw');
      }
    }
  }

  return { rows, source, skippedFutureKeys };
}
