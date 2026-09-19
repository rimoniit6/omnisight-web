// OmniSight — rolling anomaly-baseline refresh job (hardening area 4).
//
// Daily pass that persists each active employee's 30-day baseline snapshot
// (EmployeeBaseline) in the ORG data database and derives the anomaly grace
// period (Employee.anomalyGraceUntil):
//
//   - EMPLOYEE    is WITHIN grace until the persisted baseline is mature
//     (>= ANOMALY_MIN_BASELINE_DAYS active days) or the join-date + grace
//     window expires, whichever comes LAST — the detector never scores
//     history that does not exist.
//   - BASELINE    is refreshed in place (one row per employee, upsert by
//     employeeId) so dashboard tooling can show "baseline: N active days"
//     without recomputing a 30-day window per request.
//
// Runs on the same daily cadence as the integrity/schema jobs, under the
// same crash-safe JobRun lease (`refresh_baselines`). Per-org failures are
// isolated (continue-on-error) — one broken org DB never blocks the fleet.
// Respects activation state: orgs still on the platform DB get baselines
// written via getPrismaForOrg's resolved client exactly like every other
// org-owned table.
//
// Bounded: one employees query + one windowed activity query per org, then a
// single upsert per employee. No cross-org reads (tenant isolation).

import { db } from '@/lib/db';
import { getPrismaForOrg } from '@/lib/org-db';
import { getOrgSetting } from '@/lib/jobs/settings';
import { log } from '@/lib/logger';
import { computeBaseline, decideAnomalyGrace, type BaselineComputed } from '@/lib/anomalies/baseline';
import { safeTimezone, parseHHMM } from '@/lib/anomalies/time';
import {
  ANOMALY_RECENT_DAYS,
  ANOMALY_BASELINE_WINDOW_DAYS_PERSISTED,
} from '@/config/constants';

export interface RefreshBaselinesResult {
  orgsScanned: number;
  orgsSkipped: number;
  employeesRefreshed: number;
  inGrace: number;
  clearedGrace: number;
  errors: string[];
}

interface ActivityRow {
  employeeId: string;
  timestamp: Date;
  duration: number;
  category: string | null;
  type: string | null;
}

export async function runRefreshBaselinesJob(): Promise<RefreshBaselinesResult> {
  const result: RefreshBaselinesResult = {
    orgsScanned: 0,
    orgsSkipped: 0,
    employeesRefreshed: 0,
    inGrace: 0,
    clearedGrace: 0,
    errors: [],
  };

  const orgs = await db.organization.findMany({ where: { status: 'active' }, select: { id: true } });
  for (const org of orgs) {
    try {
      // Fail closed on the same control-plane gate the detector uses.
      if ((await getOrgSetting(org.id, 'ai_anomaly_detection', 'true')) !== 'true') {
        result.orgsSkipped += 1;
        continue;
      }
      const outcome = await refreshOrgBaselines(org.id);
      result.orgsScanned += 1;
      result.employeesRefreshed += outcome.employeesRefreshed;
      result.inGrace += outcome.inGrace;
      result.clearedGrace += outcome.clearedGrace;
    } catch (error) {
      result.orgsSkipped += 1;
      result.errors.push(`org ${org.id}: ${String(error)}`);
      log.error('jobs.refresh_baselines.org_failed', { orgId: org.id, error: String((error as Error)?.message ?? error) });
    }
  }

  return result;
}

async function refreshOrgBaselines(orgId: string): Promise<{
  employeesRefreshed: number;
  inGrace: number;
  clearedGrace: number;
}> {
  const orgData = (await getPrismaForOrg(orgId)).client;
  const now = new Date();
  // The persisted baseline must cover the SAME window the detection engine
  // compares against: [30d ago, 7d ago) — so maturity counts agree.
  const windowEnd = new Date(now.getTime() - ANOMALY_RECENT_DAYS * 24 * 60 * 60 * 1000);
  const windowStart = new Date(windowEnd.getTime() - ANOMALY_BASELINE_WINDOW_DAYS_PERSISTED * 24 * 60 * 60 * 1000);

  const timezone = safeTimezone((await db.organization.findUnique({ where: { id: orgId }, select: { timezone: true } }))?.timezone ?? 'UTC');
  const [rawStart, rawEnd] = [
    await getOrgSetting(orgId, 'work_start_time', '09:00'),
    await getOrgSetting(orgId, 'work_end_time', '18:00'),
  ];
  const workStartMinutes = parseHHMM(rawStart) ?? 9 * 60;
  const workEndMinutes = parseHHMM(rawEnd) ?? 18 * 60;

  const employees = await orgData.employee.findMany({
    where: { status: 'active', organizationId: orgId },
    select: { id: true, joinDate: true },
  });
  if (employees.length === 0) return { employeesRefreshed: 0, inGrace: 0, clearedGrace: 0 };

  const employeeIds = employees.map((e) => e.id);
  const activities = await orgData.activity.findMany({
    where: { employeeId: { in: employeeIds }, timestamp: { gte: windowStart, lt: windowEnd } },
    select: { employeeId: true, timestamp: true, duration: true, category: true, type: true },
  });
  const byEmployee = new Map<string, ActivityRow[]>();
  for (const a of activities) {
    const list = byEmployee.get(a.employeeId) ?? [];
    list.push(a);
    byEmployee.set(a.employeeId, list);
  }
  const joinByEmployee = new Map(employees.map((e) => [e.id, e.joinDate]));

  let employeesRefreshed = 0;
  let inGrace = 0;
  let clearedGrace = 0;

  for (const emp of employees) {
    const baseline: BaselineComputed = computeBaseline({
      activities: byEmployee.get(emp.id) ?? [],
      timezone,
      workStartMinutes,
      workEndMinutes,
      windowEnd,
    });

    await orgData.employeeBaseline.upsert({
      where: { employeeId: emp.id },
      update: {
        windowStart: baseline.windowStart,
        windowEnd: baseline.windowEnd,
        activityDays: baseline.activityDays,
        totalMinutes: baseline.totalMinutes,
        productiveMinutes: baseline.productiveMinutes,
        productiveRatio: baseline.productiveRatio,
        avgDailyMinutes: baseline.avgDailyMinutes,
        avgIdleMinutes: baseline.avgIdleMinutes,
        offHoursPerDay: baseline.offHoursPerDay,
        appsPerDay: baseline.appsPerDay,
        computedAt: now,
      },
      create: {
        employeeId: emp.id,
        organizationId: orgId,
        windowStart: baseline.windowStart,
        windowEnd: baseline.windowEnd,
        activityDays: baseline.activityDays,
        totalMinutes: baseline.totalMinutes,
        productiveMinutes: baseline.productiveMinutes,
        productiveRatio: baseline.productiveRatio,
        avgDailyMinutes: baseline.avgDailyMinutes,
        avgIdleMinutes: baseline.avgIdleMinutes,
        offHoursPerDay: baseline.offHoursPerDay,
        appsPerDay: baseline.appsPerDay,
      },
    });
    employeesRefreshed += 1;

    const grace = decideAnomalyGrace(baseline, joinByEmployee.get(emp.id) ?? null, now);
    await orgData.employee.update({
      where: { id: emp.id },
      data: { anomalyGraceUntil: grace.graceUntil },
    });
    if (grace.inGrace) inGrace += 1;
    else clearedGrace += 1;
  }

  return { employeesRefreshed, inGrace, clearedGrace };
}