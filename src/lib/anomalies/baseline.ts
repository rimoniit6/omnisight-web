// OmniSight — rolling anomaly baseline computation (hardening area 4).
//
// Pure and deterministic: given an employee's activities over a window and the
// org's timezone/work window, compute the SAME metrics the detection engine
// compares against — as a persistable snapshot (EmployeeBaseline) plus the
// maturity/grace decisions that gate detection:
//
//   - baselineMaturity: activityDays >= MIN_BASELINE_DAYS is what makes a
//     baseline trustworthy (the engine's F-17 floor). The persisted store
//     carries the same signal so the job, the detector and the dashboard
//     never disagree on "is this employee ready to be scored".
//   - grace decision: an employee is in the anomaly grace period until their
//     persisted baseline is mature. New hires (shallow history) are exempt —
//     no fabricated "productivity drop" verdicts.
//
// Idle/off-hours semantics match src/lib/anomalies/detect.ts exactly (F-3):
// idle never counts as productive/non-productive work time, and the offline
// predicates are the same helpers, so a baseline row and a detection run read
// the same world.

import type { ActivityLike } from './detect';
import { isIdleActivity } from './detect';
import { tzDayKey, tzMinutesSinceMidnight, isWithinWorkWindow } from './time';
import {
  ANOMALY_MIN_BASELINE_DAYS,
  ANOMALY_BASELINE_WINDOW_DAYS_PERSISTED,
  ANOMALY_GRACE_PERIOD_DAYS,
} from '@/config/constants';

export interface BaselineComputed {
  windowStart: Date;
  windowEnd: Date;
  activityDays: number;
  totalMinutes: number;
  productiveMinutes: number;
  productiveRatio: number;
  avgDailyMinutes: number;
  avgIdleMinutes: number;
  offHoursPerDay: number;
  appsPerDay: number;
}

export interface BaselineInput {
  /** Activities from the trailing 30-day baseline window ([30d ago, 7d ago)). */
  activities: ActivityLike[];
  /** IANA timezone — all day boundaries derive from it (F-6). */
  timezone: string;
  /** Work window, minutes since midnight (for off-hours counting). */
  workStartMinutes: number;
  workEndMinutes: number;
  /** Window edge for the row payload — injected for deterministic tests. */
  windowEnd: Date;
}

/**
 * Compute the persisted rolling-baseline snapshot from raw window activities.
 * Deterministic: same inputs → same numbers.
 */
export function computeBaseline(input: BaselineInput): BaselineComputed {
  const { activities, timezone, workStartMinutes, workEndMinutes, windowEnd } = input;
  const windowStart = new Date(windowEnd.getTime() - ANOMALY_BASELINE_WINDOW_DAYS_PERSISTED * 24 * 60 * 60 * 1000);

  const nonIdle = activities.filter((a) => !isIdleActivity(a));
  const totalMinutes = sumDuration(nonIdle);
  const productiveMinutes = sumDuration(nonIdle.filter((a) => a.category === 'productive'));
  const days = new Set(activities.map((a) => tzDayKey(a.timestamp, timezone))).size;
  const validDays = Math.max(days, 1);

  const idleMinutes = sumDuration(activities.filter((a) => isIdleActivity(a)));
  const offHours = activities.filter((a) => {
    const m = tzMinutesSinceMidnight(a.timestamp, timezone);
    return !isWithinWorkWindow(m, workStartMinutes, workEndMinutes);
  }).length;
  const apps = activities.filter((a) => a.type === 'application').length;

  return {
    windowStart,
    windowEnd,
    activityDays: days,
    totalMinutes,
    productiveMinutes,
    productiveRatio: totalMinutes > 0 ? productiveMinutes / totalMinutes : 0,
    avgDailyMinutes: totalMinutes / validDays,
    avgIdleMinutes: idleMinutes / validDays,
    offHoursPerDay: offHours / validDays,
    appsPerDay: apps / validDays,
  };
}

/** Baseline maturity floor — the engine's F-17 rule, exposed once. */
export function baselineMaturity(base: Pick<BaselineComputed, 'activityDays'>): {
  mature: boolean;
  activityDays: number;
  minDays: number;
} {
  const minDays = ANOMALY_MIN_BASELINE_DAYS;
  return { mature: base.activityDays >= minDays, activityDays: base.activityDays, minDays };
}

export interface GraceDecision {
  inGrace: boolean;
  /** null = no in-flight grace (baseline mature or employee never graced). */
  graceUntil: Date | null;
}

/**
 * Decide whether an employee is in the anomaly-detection grace period.
 *
 * A persisted baseline that is mature clears grace entirely. An immature
 * baseline keeps grace open at least until `joinDate + ANOMALY_GRACE_PERIOD_DAYS`
 * (and at least now + grace) so an employee who joined weeks ago but only has
 * a few active days still gets the full 14-day runway — the detector should
 * not score history that does not exist.
 */
export function decideAnomalyGrace(
  baseline: Pick<BaselineComputed, 'activityDays'> | null,
  joinDate: Date | null,
  now: Date
): GraceDecision {
  if (baseline && baselineMaturity(baseline).mature) {
    return { inGrace: false, graceUntil: null };
  }
  const latest = Math.max(
    (joinDate ? joinDate.getTime() + ANOMALY_GRACE_PERIOD_DAYS * 24 * 60 * 60 * 1000 : 0),
    now.getTime() + ANOMALY_GRACE_PERIOD_DAYS * 24 * 60 * 60 * 1000
  );
  const graceUntil = new Date(latest);
  return { inGrace: true, graceUntil };
}

/** Idleness/work-time semantics shared with detect.ts (F-3). */
export function isIdle(a: ActivityLike): boolean {
  return isIdleActivity(a);
}

function sumDuration(list: ActivityLike[]): number {
  return list.reduce((sum, a) => sum + (Number.isFinite(a.duration) && a.duration > 0 ? a.duration : 0), 0);
}