/**
 * OmniSight — WorkDaySummary aggregation engine (Phase 4).
 *
 * PURE module (no DB, no IO): turns one employee's Activity rows for one
 * org-local calendar day into the daily totals persisted as WorkDaySummary.
 * Deterministic for a given input, so the aggregation job can recompute a
 * whole day and upsert on the unique (organizationId, employeeId, workDate)
 * key — idempotent by construction, never "existing + incremental".
 *
 * SEMANTICS (each one mirrors an existing consumer so the summary can never
 * disagree with the dashboard/reports over the same rows):
 *
 *  - Day bucket: a row is attributed to the org-local calendar day of its
 *    `timestamp` (`tzDayKey` in Organization.timezone — never server-local).
 *    A row is never split across days. Rows whose org-local day differs from
 *    the requested bucket are skipped defensively (a caller bug can never
 *    double-count a row into two days).
 *  - Category seconds: productive/neutral/unproductive/idle = SUM of
 *    `duration` grouped by the row's stored category — identical to the
 *    dashboard's per-day category sums. Rows with no p/n/u/idle category
 *    (screenshot/work_session events etc.) add no seconds but are counted.
 *  - Exclusions: internal-agent process rows (the monitoring agent must never
 *    count as the employee's work) and the zero-duration "Break Mode …"
 *    mirror rows. Website rows keep domain-only telemetry semantics.
 *  - activeSeconds = productive + neutral + unproductive (the dashboard's
 *    "total categorized duration").
 *  - workingSeconds / outsideHoursSeconds split ACTIVE seconds by the org
 *    work window (work_start_time..work_end_time in the org timezone) using
 *    the SAME per-row start-minute convention as the anomaly detector
 *    (`isWithinWorkWindow`, overnight windows supported). A short row that
 *    starts inside the window is counted in full — whole-row attribution,
 *    never sub-minute splitting.
 *  - breakSeconds is supplied by the caller from BreakSession overlap
 *    (break mode suppresses collection, so breaks never appear as Activity
 *    durations) — the engine never invents break time from rows.
 *  - Invalid rows (non-finite or non-positive duration) are skipped for time
 *    but still counted as activity — corrupt telemetry can never distort
 *    totals.
 *  - Offline gaps are never fabricated: totals cover only the rows that
 *    exist; unmonitored wall-clock time is simply absent.
 *
 * Note on parallel streams: application and website rows for the same minute
 * are separate telemetry streams and both contribute (this IS the existing
 * dashboard/report semantic — e.g. one minute on GitHub = one Chrome row +
 * one github.com row). WorkDaySummary must equal the dashboard/report totals
 * for the same window, so it deliberately does NOT interval-union streams.
 * "No double counting" is guaranteed by: deterministic whole-day rebuild,
 * single-day attribution, internal/break-mirror exclusions, and skipping
 * invalid durations.
 */

import {
  safeTimezone,
  tzDayKey,
  tzMinutesSinceMidnight,
  isWithinWorkWindow,
} from '@/lib/anomalies/time';
import { BREAK_TITLES } from '@/lib/breaks/service';
import { isInternalAgentProcess } from '@/lib/agent-process';

/** The Activity fields the engine may need (Prisma rows satisfy this). */
export interface WorkDayActivityRow {
  type: string;
  title: string | null;
  applicationName: string | null;
  category: string | null;
  duration: number;
  timestamp: Date;
}

export interface WorkDayTotals {
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
}

export interface AggregateEmployeeDayInput {
  /** Org-local day key (YYYY-MM-DD) this bucket aggregates. */
  dayKey: string;
  /** Organization IANA timezone (invalid → UTC via safeTimezone). */
  timezone: string;
  /** The employee's Activity rows (any timestamps — day filter applied here). */
  activities: WorkDayActivityRow[];
  /** Work window start, minutes since org-local midnight. */
  workStartMinutes: number;
  /** Work window end, minutes since org-local midnight (may be <= start). */
  workEndMinutes: number;
  /** Break seconds already computed from BreakSession overlap with the day. */
  breakSeconds: number;
  /**
   * Optional precomputed local-day window (fast path for bulk loaders that
   * already queried exactly one org-local day). When supplied AND the window
   * is a plain 24 h day, day membership + minutes-of-day are pure arithmetic
   * (no per-row Intl). DST-transition days (window != 24 h) automatically fall
   * back to the Intl clock so wall-clock minutes stay exact. When absent, the
   * engine derives everything from the timezone via Intl (pure default — used
   * by unit tests and ad-hoc callers).
   */
  localDayWindowMs?: { startMs: number; endExclusiveMs: number };
}

export function emptyTotals(): WorkDayTotals {
  return {
    productiveSeconds: 0,
    neutralSeconds: 0,
    unproductiveSeconds: 0,
    idleSeconds: 0,
    activeSeconds: 0,
    workingSeconds: 0,
    outsideHoursSeconds: 0,
    breakSeconds: 0,
    activityCount: 0,
    websiteActivityCount: 0,
    applicationActivityCount: 0,
  };
}

/** True when the row is the product's canonical idle representation. */
export function isIdleRow(row: WorkDayActivityRow): boolean {
  return row.category === 'idle' || row.type === 'idle';
}

/** True when the row is a zero-duration break-mode event mirror. */
export function isBreakMirrorRow(row: WorkDayActivityRow): boolean {
  return row.title != null && (BREAK_TITLES as readonly string[]).includes(row.title);
}

/** True when the row carries a categorized (productive/neutral/unproductive)
 *  verdict that counts toward active time. */
function categorizedSeconds(row: WorkDayActivityRow): { bucket: 'productive' | 'neutral' | 'unproductive' } | null {
  if (row.category === 'productive') return { bucket: 'productive' };
  if (row.category === 'neutral') return { bucket: 'neutral' };
  if (row.category === 'unproductive') return { bucket: 'unproductive' };
  return null;
}

/**
 * Aggregate ONE employee's rows into ONE org-local day bucket.
 * Deterministic and pure. `breakSeconds` is trusted (already clipped by the
 * caller); every other field is derived from the rows.
 */
export function aggregateEmployeeDay(input: AggregateEmployeeDayInput): WorkDayTotals {
  const tz = safeTimezone(input.timezone);
  const totals = emptyTotals();
  totals.breakSeconds = Number.isFinite(input.breakSeconds) && input.breakSeconds > 0
    ? Math.max(0, Math.round(input.breakSeconds))
    : 0;

  // Fast path: the caller already resolved the exact local-day window. Only a
  // plain 24 h window is eligible — a DST-transition day (≠24 h) falls back to
  // the Intl clock so wall-clock minutes stay exact.
  const w = input.localDayWindowMs;
  const fast = !!w && Math.abs(w.endExclusiveMs - w.startMs - 86_400_000) < 1000;

  for (const row of input.activities) {
    const ts = row.timestamp.getTime();
    // Defensive day attribution: a row belongs to exactly one org-local day.
    if (fast) {
      if (ts < w.startMs || ts >= w.endExclusiveMs) continue;
    } else if (tzDayKey(row.timestamp, tz) !== input.dayKey) {
      continue;
    }
    // The monitoring agent's own process is never the employee's work.
    if (isInternalAgentProcess(row.applicationName)) continue;
    // Zero-duration break event mirrors are telemetry markers, not work.
    if (isBreakMirrorRow(row)) continue;

    totals.activityCount += 1;
    if (row.type === 'website') totals.websiteActivityCount += 1;
    else if (row.type === 'application') totals.applicationActivityCount += 1;

    const validDuration = Number.isFinite(row.duration) && row.duration > 0;
    if (!validDuration) continue;

    if (isIdleRow(row)) {
      totals.idleSeconds += row.duration;
      continue;
    }

    const categorized = categorizedSeconds(row);
    if (!categorized) continue; // counted but never timed (no verdict)

    if (categorized.bucket === 'productive') totals.productiveSeconds += row.duration;
    else if (categorized.bucket === 'neutral') totals.neutralSeconds += row.duration;
    else totals.unproductiveSeconds += row.duration;

    // Working/outside-hours split on ACTIVE time, per-row start-minute
    // convention (matches the anomaly detector's off-hours rule).
    const minutes = fast
      ? Math.floor((ts - w.startMs) / 60_000)
      : tzMinutesSinceMidnight(row.timestamp, tz);
    if (isWithinWorkWindow(minutes, input.workStartMinutes, input.workEndMinutes)) {
      totals.workingSeconds += row.duration;
    } else {
      totals.outsideHoursSeconds += row.duration;
    }
  }

  // Invariant: active = categorized non-idle activity (dashboard total).
  totals.activeSeconds = totals.productiveSeconds + totals.neutralSeconds + totals.unproductiveSeconds;
  return totals;
}

/**
 * BreakSeconds contribution of ONE BreakSession to a local day window.
 * Clips to [dayStart, dayEndInclusive]; an open session (endedAt null) is
 * clipped to `now` so an in-progress day summary never counts future time.
 * Pure and deterministic for a fixed `now` (the job pins one `now` per run).
 */
export function breakSessionOverlapSeconds(
  session: { startedAt: Date; endedAt: Date | null },
  dayStart: Date,
  dayEndInclusive: Date,
  now: Date
): number {
  const startMs = session.startedAt.getTime();
  const endMs = (session.endedAt ?? now).getTime();
  const lo = Math.max(startMs, dayStart.getTime());
  const hi = Math.min(endMs, dayEndInclusive.getTime() + 1); // inclusive end → exclusive bound
  if (hi <= lo) return 0;
  return Math.round((hi - lo) / 1000);
}
