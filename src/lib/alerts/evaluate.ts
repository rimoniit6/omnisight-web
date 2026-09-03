/**
 * OmniSight — AlertRule condition evaluators (Phase 5). PURE module (no DB,
 * no IO): each condition decides whether a rule fires for one entity given
 * typed telemetry rows and resolved params. Deterministic for fixed input so
 * replayed job runs produce identical candidates; the caller (job) then
 * applies cooldown + persistence. Never throws on corrupt rows — degenerate
 * input yields "does not fire".
 *
 * Telemetry conventions match the rest of the product:
 *  - Org-local day boundaries come from the caller (zoned windows) — an
 *    evaluator never applies server-local day math.
 *  - Idle = the canonical predicate (category === 'idle' OR type === 'idle').
 *  - Categorized seconds use the stored server-authoritative category.
 *  - Internal-agent process rows and break-mirror rows are excluded (the same
 *    exclusions every aggregation consumer uses).
 */

import { resolveConditionParams, type AlertRuleConditionType } from './conditions';
import { isInternalAgentProcess } from '@/lib/agent-process';
import { BREAK_TITLES } from '@/lib/breaks/service';
import { isWithinWorkWindow } from '@/lib/anomalies/time';

// ─── Typed inputs (decoupled from Prisma so the engine is unit-testable) ────
export interface ActivityLike {
  timestamp: Date;
  duration: number;
  category: string | null;
  type: string | null;
  applicationName: string | null;
  title: string | null;
}

export interface DeviceLike {
  id: string;
  lastHeartbeat: Date | null;
}

export interface OrgWindowLike {
  /** Org-local day window start (inclusive) for "today". */
  dayStart: Date;
  /** Org-local day window end (EXCLUSIVE — caller passes end+1 ms). */
  dayEndExclusive: Date;
  /** Org work window, minutes since local midnight. */
  workStartMinutes: number;
  /** Org work window end, minutes since local midnight (may be <= start). */
  workEndMinutes: number;
}

export type EvaluateResult =
  | { fired: true; measured: number; threshold: number }
  | { fired: false; measured: number; threshold: number };

function isIdle(a: ActivityLike): boolean {
  return a.category === 'idle' || a.type === 'idle';
}

function isExcluded(a: ActivityLike): boolean {
  if (isInternalAgentProcess(a.applicationName)) return true;
  if (a.title != null && (BREAK_TITLES as readonly string[]).includes(a.title)) return true;
  return false;
}

function validDuration(a: ActivityLike): boolean {
  return Number.isFinite(a.duration) && a.duration > 0;
}

function inWindow(a: ActivityLike, w: OrgWindowLike): boolean {
  const ts = a.timestamp.getTime();
  return ts >= w.dayStart.getTime() && ts < w.dayEndExclusive.getTime();
}

/**
 * Minutes-of-day helper matching tzMinutesSinceMidnight semantics for the
 * work-window test. The caller guarantees rows are already org-local-day
 * windowed, so the wall-clock minute is derived from the day-window offset
 * (plain arithmetic; the caller's window is the exact zoned day span).
 */
function minutesSinceDayStart(a: ActivityLike, w: OrgWindowLike): number {
  return Math.max(0, Math.floor((a.timestamp.getTime() - w.dayStart.getTime()) / 60_000));
}

/** Condition: employee accumulated ≥ threshold minutes of idle TODAY. */
export function evaluateExcessiveIdle(
  activities: ActivityLike[],
  params: Record<string, number>,
  window: OrgWindowLike
): EvaluateResult {
  const threshold = params.thresholdMinutes ?? 120;
  let idleSec = 0;
  for (const a of activities) {
    if (!inWindow(a, window) || isExcluded(a) || !validDuration(a)) continue;
    if (isIdle(a)) idleSec += a.duration;
  }
  const measured = Math.floor(idleSec / 60);
  return measured >= threshold
    ? { fired: true, measured, threshold }
    : { fired: false, measured, threshold };
}

/** Condition: employee accumulated ≥ threshold minutes of unproductive TODAY. */
export function evaluateExcessiveUnproductive(
  activities: ActivityLike[],
  params: Record<string, number>,
  window: OrgWindowLike
): EvaluateResult {
  const threshold = params.thresholdMinutes ?? 120;
  let unproductiveSec = 0;
  for (const a of activities) {
    if (!inWindow(a, window) || isExcluded(a) || !validDuration(a)) continue;
    if (!isIdle(a) && a.category === 'unproductive') unproductiveSec += a.duration;
  }
  const measured = Math.floor(unproductiveSec / 60);
  return measured >= threshold
    ? { fired: true, measured, threshold }
    : { fired: false, measured, threshold };
}

/** Condition: ≥ threshold application activities TODAY outside work hours. */
export function evaluateOutsideHoursActivity(
  activities: ActivityLike[],
  params: Record<string, number>,
  window: OrgWindowLike
): EvaluateResult {
  const threshold = params.thresholdCount ?? 5;
  let count = 0;
  for (const a of activities) {
    if (!inWindow(a, window) || isExcluded(a)) continue;
    if (a.type !== 'application') continue; // app activity only (anomaly convention)
    const minutes = minutesSinceDayStart(a, window);
    if (!isWithinWorkWindow(minutes, window.workStartMinutes, window.workEndMinutes)) {
      count += 1;
    }
  }
  return count >= threshold
    ? { fired: true, measured: count, threshold }
    : { fired: false, measured: count, threshold };
}

/** Condition: device lastHeartbeat older than threshold minutes. */
export function evaluateDeviceOffline(
  device: DeviceLike,
  params: Record<string, number>,
  now: Date
): EvaluateResult {
  const threshold = params.thresholdMinutes ?? 15;
  if (!device.lastHeartbeat) {
    return { fired: false, measured: 0, threshold };
  }
  const staleMinutes = Math.floor((now.getTime() - device.lastHeartbeat.getTime()) / 60_000);
  const measured = Math.max(0, staleMinutes);
  return measured >= threshold
    ? { fired: true, measured, threshold }
    : { fired: false, measured, threshold };
}

/**
 * Dispatch a condition type over its input. `params` may be the stored JSON
 * string or an already-resolved record (the job resolves once per rule).
 */
export function evaluateCondition(
  conditionType: AlertRuleConditionType,
  input: { activities?: ActivityLike[]; device?: DeviceLike },
  paramsRaw: string | Record<string, number>,
  window: OrgWindowLike,
  now: Date
): EvaluateResult {
  const params =
    typeof paramsRaw === 'string' ? resolveConditionParams(conditionType, paramsRaw) : paramsRaw;
  switch (conditionType) {
    case 'excessive_idle':
      return evaluateExcessiveIdle(input.activities ?? [], params, window);
    case 'excessive_unproductive':
      return evaluateExcessiveUnproductive(input.activities ?? [], params, window);
    case 'outside_hours_activity':
      return evaluateOutsideHoursActivity(input.activities ?? [], params, window);
    case 'device_offline':
      return input.device
        ? evaluateDeviceOffline(input.device, params, now)
        : { fired: false, measured: 0, threshold: params.thresholdMinutes ?? 15 };
  }
}
