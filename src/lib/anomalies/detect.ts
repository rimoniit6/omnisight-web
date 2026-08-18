/**
 * Rule-based anomaly detection engine (F-2, F-3, F-6, F-17, F-18).
 *
 * Pure and deterministic: given an employee's recent + baseline activities
 * and the org's detection configuration it returns the same anomalies every
 * run — no randomness, no fabricated values. Extracted from the former
 * `POST /api/anomalies/detect` handler so the on-demand route and the
 * scheduled job (F-1) share one engine instead of two.
 *
 * Timezone (F-6): ALL day boundaries, "today" windows, work-hour
 * classification and trend-chart keys use the org's IANA timezone via
 * src/lib/anomalies/time.ts. Nothing uses server-local or UTC day keys.
 *
 * Idle handling (F-3): `isIdleActivity` is the single canonical predicate
 * (category === 'idle' OR type === 'idle') and is used for the productive
 * ratio denominator, the excessive-idle check and history/totals. Idle time
 * never counts as productive or non-productive work time.
 *
 * Baseline sufficiency (F-17): the productivity rule requires the baseline
 * window to contain activity on at least MIN_BASELINE_DAYS distinct days,
 * otherwise it is skipped with a recorded reason — a new employee or an
 * organization with shallow history never gets a fabricated "drop".
 */
import type { AnomalySeverity, AnomalyType } from './constants';
import { tzDayKey, tzMinutesSinceMidnight, isWithinWorkWindow, safeTimezone } from './time';

// ─── Input shapes (decoupled from Prisma so the engine is unit-testable) ───
export interface ActivityLike {
  timestamp: Date;
  duration: number;
  category: string | null;
  type: string | null;
}

export interface EmployeeLike {
  id: string;
  firstName: string;
  lastName: string;
}

/** Organization-level detection configuration (resolved by the caller). */
export interface DetectConfig {
  /** IANA timezone; all day/hour semantics derive from it. */
  timezone: string;
  /** Work window start, minutes since midnight (org work_start_time). */
  workStartMinutes: number;
  /** Work window end, minutes since midnight (org work_end_time). */
  workEndMinutes: number;
  /** Reference "now" — injected for deterministic tests. */
  now: Date;
}

export interface EmployeeDetectInput {
  employee: EmployeeLike;
  /** Activities from the last 7 days (today included). */
  recent: ActivityLike[];
  /** Activities from the baseline window (~30d ago .. 7d ago). */
  baseline: ActivityLike[];
  deviceId?: string | null;
}

export interface DetectedAnomaly {
  type: AnomalyType;
  severity: AnomalySeverity;
  title: string;
  description: string;
  score: number;
  confidence: number;
  employeeId: string;
  deviceId?: string;
  metadata: Record<string, unknown>;
}

export interface EmployeeDetectResult {
  anomalies: DetectedAnomaly[];
  /** Rules skipped and why — observability for shallow-history orgs (F-17). */
  skippedReasons: string[];
}

// ─── Rule constants ────────────────────────────────────────────────────────
const PRODUCTIVITY_DROP_THRESHOLD_PCT = 30;
const MIN_BASELINE_DAYS = 5; // distinct baseline days with activity required
const EXCESSIVE_IDLE_THRESHOLD_MINUTES = 120;
const OFF_HOURS_MIN_COUNT = 5;
const OFF_HOURS_MIN_RATIO = 0.5;
const LOW_ACTIVITY_MIN_AVG = 20;
const LOW_ACTIVITY_RATIO = 0.3;
const LOW_ACTIVITY_MAX_TODAY = 10;

const clampScore = (v: number) => Math.max(0, Math.min(100, Math.round(v)));
const clampConfidence = (v: number) => Math.max(0, Math.min(0.95, v));

/** Canonical idle predicate (F-3) — covers both real representations. */
export function isIdleActivity(a: ActivityLike): boolean {
  return a.category === 'idle' || a.type === 'idle';
}

function sumDuration(list: ActivityLike[]): number {
  return list.reduce((sum, a) => sum + (Number.isFinite(a.duration) && a.duration > 0 ? a.duration : 0), 0);
}

/**
 * 7-day per-day activity history in the org timezone (minutes per day),
 * oldest → newest. Computed ONCE per employee and reused by every rule that
 * needs it (F-18) and persisted into metadata for the trend chart.
 */
export function buildHistory(
  recent: ActivityLike[],
  timezone: string,
  now: Date
): { date: string; value: number }[] {
  const tz = safeTimezone(timezone);
  const perDay = new Map<string, number>();
  // 7 consecutive day labels in the ORG timezone (F-6) — the same key
  // function used to bucket activities, so a label can never disagree with
  // the bucket it is displayed for (the old UTC labels dropped activities
  // whose tz day differed from the UTC day).
  for (let i = 6; i >= 0; i--) {
    perDay.set(tzDayKey(new Date(now.getTime() - i * 24 * 60 * 60 * 1000), tz), 0);
  }
  for (const a of recent) {
    const key = tzDayKey(a.timestamp, tz);
    if (perDay.has(key)) perDay.set(key, (perDay.get(key) ?? 0) + (Number.isFinite(a.duration) && a.duration > 0 ? a.duration : 0));
  }
  return Array.from(perDay.entries()).map(([date, value]) => ({ date, value: Math.round(value / 60) }));
}

// ─── Rules ─────────────────────────────────────────────────────────────────

function checkProductivityDrop(
  emp: EmployeeLike,
  recent: ActivityLike[],
  baseline: ActivityLike[],
  timezone: string,
  deviceId: string | undefined,
  history: { date: string; value: number }[],
  skippedReasons: string[]
): DetectedAnomaly | null {
  if (recent.length === 0) {
    skippedReasons.push(`${emp.id}: productivity_drop skipped (no recent activity)`);
    return null;
  }
  if (baseline.length === 0) {
    skippedReasons.push(`${emp.id}: productivity_drop skipped (no baseline activity)`);
    return null;
  }

  // F-17: require a real baseline — activity on >= MIN_BASELINE_DAYS distinct
  // days (counted in the ORG timezone, matching every other day boundary —
  // F-6). A handful of rows (a new hire's first week) must not drive a "drop".
  const baselineDays = new Set(baseline.map((a) => tzDayKey(a.timestamp, timezone))).size;
  if (baselineDays < MIN_BASELINE_DAYS) {
    skippedReasons.push(`${emp.id}: productivity_drop skipped (baseline has ${baselineDays}/${MIN_BASELINE_DAYS} days)`);
    return null;
  }

  // F-3: idle never counts as work time in the ratio.
  const recentNonIdle = recent.filter((a) => !isIdleActivity(a));
  const baselineNonIdle = baseline.filter((a) => !isIdleActivity(a));
  const recentTotal = sumDuration(recentNonIdle);
  const baselineTotal = sumDuration(baselineNonIdle);
  if (recentTotal <= 0 || baselineTotal <= 0) {
    skippedReasons.push(`${emp.id}: productivity_drop skipped (zero non-idle duration)`);
    return null;
  }

  const recentProductive = sumDuration(recentNonIdle.filter((a) => a.category === 'productive'));
  const baselineProductive = sumDuration(baselineNonIdle.filter((a) => a.category === 'productive'));
  const recentRatio = recentProductive / recentTotal;
  const baselineRatio = baselineProductive / baselineTotal;

  if (baselineRatio <= 0) {
    skippedReasons.push(`${emp.id}: productivity_drop skipped (baseline productive ratio is zero)`);
    return null;
  }

  const dropPct = ((baselineRatio - recentRatio) / baselineRatio) * 100;
  if (!(dropPct > PRODUCTIVITY_DROP_THRESHOLD_PCT)) return null;

  return {
    type: 'productivity_drop',
    severity: dropPct > 50 ? 'critical' : dropPct > 40 ? 'high' : 'medium',
    title: `Productivity Drop Detected: ${emp.firstName} ${emp.lastName}`,
    description: `Productivity dropped ${Math.round(dropPct)}% compared to 30-day baseline. Current ratio: ${Math.round(recentRatio * 100)}%, baseline: ${Math.round(baselineRatio * 100)}%.`,
    score: clampScore(dropPct * 1.2),
    confidence: clampConfidence(0.5 + dropPct / 100),
    employeeId: emp.id,
    deviceId,
    metadata: {
      baseline: Math.round(baselineRatio * 100),
      current: Math.round(recentRatio * 100),
      threshold: PRODUCTIVITY_DROP_THRESHOLD_PCT,
      dropPct: Math.round(dropPct),
      history,
    },
  };
}

function checkExcessiveIdle(
  emp: EmployeeLike,
  recent: ActivityLike[],
  timezone: string,
  todayKey: string,
  deviceId: string | undefined,
  history: { date: string; value: number }[],
  skippedReasons: string[]
): DetectedAnomaly | null {
  const idleMinutes = recent
    .filter((a) => isIdleActivity(a) && tzDayKey(a.timestamp, timezone) === todayKey)
    .reduce((sum, a) => sum + (Number.isFinite(a.duration) && a.duration > 0 ? a.duration : 0), 0) / 60;

  if (!(idleMinutes > EXCESSIVE_IDLE_THRESHOLD_MINUTES)) {
    if (idleMinutes > 0) skippedReasons.push(`${emp.id}: excessive_idle not triggered (${Math.round(idleMinutes)} min <= ${EXCESSIVE_IDLE_THRESHOLD_MINUTES})`);
    return null;
  }

  return {
    type: 'excessive_idle',
    severity: idleMinutes > 240 ? 'high' : 'medium',
    title: `Excessive Idle Time: ${emp.firstName} ${emp.lastName}`,
    description: `${Math.round(idleMinutes)} minutes of idle time today (${Math.round((idleMinutes / 60) * 10) / 10} hours). Normal threshold is 2 hours.`,
    score: clampScore(idleMinutes / 3),
    confidence: clampConfidence(0.5 + idleMinutes / 480),
    employeeId: emp.id,
    deviceId,
    metadata: {
      totalIdleMinutes: Math.round(idleMinutes),
      threshold: EXCESSIVE_IDLE_THRESHOLD_MINUTES,
      day: todayKey,
      history,
    },
  };
}

function checkOffHoursActivity(
  emp: EmployeeLike,
  recent: ActivityLike[],
  timezone: string,
  todayKey: string,
  config: DetectConfig,
  deviceId: string | undefined
): DetectedAnomaly | null {
  const todayActivities = recent.filter(
    (a) => a.type === 'application' && tzDayKey(a.timestamp, timezone) === todayKey
  );
  const offHoursCount = todayActivities.filter((a) => {
    const minutes = tzMinutesSinceMidnight(a.timestamp, timezone);
    return !isWithinWorkWindow(minutes, config.workStartMinutes, config.workEndMinutes);
  }).length;
  const totalAppActivities = todayActivities.length;

  if (!(totalAppActivities > 0 && offHoursCount / totalAppActivities > OFF_HOURS_MIN_RATIO && offHoursCount > OFF_HOURS_MIN_COUNT)) {
    return null;
  }

  // Legacy persisted type key is `unusual_login` (kept for DB compatibility —
  // see constants.ts); the semantics are "off-hours activity".
  return {
    type: 'unusual_login',
    severity: 'medium',
    title: `Off-Hours Activity Pattern: ${emp.firstName} ${emp.lastName}`,
    description: `${offHoursCount} out of ${totalAppActivities} activities recorded outside working hours (${config.workStartMinutes / 60}-${config.workEndMinutes / 60}) today.`,
    score: clampScore(55 + Math.min(30, offHoursCount)),
    confidence: clampConfidence(0.5 + offHoursCount / (totalAppActivities * 2)),
    employeeId: emp.id,
    deviceId,
    metadata: {
      offHoursCount,
      totalActivities: totalAppActivities,
      workStart: config.workStartMinutes,
      workEnd: config.workEndMinutes,
    },
  };
}

function checkLowActivitySpike(
  emp: EmployeeLike,
  recent: ActivityLike[],
  timezone: string,
  todayKey: string,
  deviceId: string | undefined,
  history: { date: string; value: number }[],
  skippedReasons: string[]
): DetectedAnomaly | null {
  const activitiesByDay = new Map<string, number>();
  for (const a of recent) {
    const key = tzDayKey(a.timestamp, timezone);
    activitiesByDay.set(key, (activitiesByDay.get(key) ?? 0) + 1);
  }
  const dayValues = Array.from(activitiesByDay.values());
  if (dayValues.length === 0) {
    skippedReasons.push(`${emp.id}: low_activity_spike skipped (no activity)`);
    return null;
  }
  const avgPerDay = dayValues.reduce((a, b) => a + b, 0) / dayValues.length;
  const todayCount = activitiesByDay.get(todayKey) ?? 0;

  if (!(avgPerDay > LOW_ACTIVITY_MIN_AVG && todayCount < avgPerDay * LOW_ACTIVITY_RATIO && todayCount < LOW_ACTIVITY_MAX_TODAY)) {
    return null;
  }

  return {
    type: 'low_activity_spike',
    severity: 'high',
    title: `Unusually Low Activity: ${emp.firstName} ${emp.lastName}`,
    description: `Only ${todayCount} activities today vs daily average of ${Math.round(avgPerDay)}. This is ${Math.round((1 - todayCount / avgPerDay) * 100)}% below normal.`,
    score: clampScore((1 - todayCount / avgPerDay) * 80),
    confidence: clampConfidence(0.5 + (1 - todayCount / avgPerDay) / 2),
    employeeId: emp.id,
    deviceId,
    metadata: {
      todayCount,
      avgPerDay: Math.round(avgPerDay),
      threshold: LOW_ACTIVITY_RATIO,
      history,
    },
  };
}

// ─── Entry point ───────────────────────────────────────────────────────────

/**
 * Run every rule against one employee's windows. Deterministic; returns the
 * detected anomalies plus skip reasons for observability. Never throws for
 * bad data — degenerate inputs yield no anomaly and a reason.
 */
export function detectAnomaliesForEmployee(
  input: EmployeeDetectInput,
  config: DetectConfig
): EmployeeDetectResult {
  const timezone = safeTimezone(config.timezone);
  const todayKey = tzDayKey(config.now, timezone);
  const deviceId = input.deviceId ?? undefined;
  const skippedReasons: string[] = [];

  // F-18: one history computation per employee, reused by all rules.
  const history = buildHistory(input.recent, timezone, config.now);

  const anomalies: DetectedAnomaly[] = [];

  const prod = checkProductivityDrop(input.employee, input.recent, input.baseline, timezone, deviceId, history, skippedReasons);
  if (prod) anomalies.push(prod);

  const idle = checkExcessiveIdle(input.employee, input.recent, timezone, todayKey, deviceId, history, skippedReasons);
  if (idle) anomalies.push(idle);

  const offHours = checkOffHoursActivity(input.employee, input.recent, timezone, todayKey, config, deviceId);
  if (offHours) anomalies.push(offHours);

  const low = checkLowActivitySpike(input.employee, input.recent, timezone, todayKey, deviceId, history, skippedReasons);
  if (low) anomalies.push(low);

  return { anomalies, skippedReasons };
}

/** Run the engine for many employees, aggregating results. */
export function detectAnomaliesForEmployees(
  inputs: EmployeeDetectInput[],
  config: DetectConfig
): EmployeeDetectResult {
  const anomalies: DetectedAnomaly[] = [];
  const skippedReasons: string[] = [];
  for (const input of inputs) {
    const result = detectAnomaliesForEmployee(input, config);
    anomalies.push(...result.anomalies);
    skippedReasons.push(...result.skippedReasons);
  }
  return { anomalies, skippedReasons };
}
