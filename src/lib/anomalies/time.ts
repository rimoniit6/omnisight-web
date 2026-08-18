/**
 * Canonical timezone strategy for anomaly detection (F-6).
 *
 * Every date boundary, day key, work-hour classification and trend-chart key
 * is derived from the ORGANIZATION's IANA timezone (`Organization.timezone`,
 * default "Asia/Dhaka"). Nothing uses server-local time and nothing mixes UTC
 * day keys with local day keys.
 *
 * `Intl.DateTimeFormat` is deterministic and DST-safe; an invalid stored
 * timezone falls back to 'UTC' rather than crashing the engine.
 */

/** IANA day key: YYYY-MM-DD in `timeZone` (en-CA formats dates as ISO). */
const dayFormatterCache = new Map<string, Intl.DateTimeFormat>();
function dayFormatter(timeZone: string): Intl.DateTimeFormat {
  let f = dayFormatterCache.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' });
    dayFormatterCache.set(timeZone, f);
  }
  return f;
}

/** Minutes-since-midnight formatter per timezone. */
const clockFormatterCache = new Map<string, Intl.DateTimeFormat>();
function clockFormatter(timeZone: string): Intl.DateTimeFormat {
  let f = clockFormatterCache.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    });
    clockFormatterCache.set(timeZone, f);
  }
  return f;
}

/** Validate an IANA timezone name; falls back to 'UTC' when invalid/absent. */
export function safeTimezone(timeZone: string | null | undefined): string {
  if (!timeZone) return 'UTC';
  try {
    // Throws RangeError for unknown timezones — the validation IS the check.
    new Intl.DateTimeFormat('en-US', { timeZone }).format();
    return timeZone;
  } catch {
    return 'UTC';
  }
}

/** Local (org-timezone) calendar date key: 'YYYY-MM-DD'. */
export function tzDayKey(ts: Date, timeZone: string): string {
  return dayFormatter(timeZone).format(ts);
}

/** Minutes since local midnight (org timezone), 0..1439. */
export function tzMinutesSinceMidnight(ts: Date, timeZone: string): number {
  const parts = clockFormatter(timeZone).formatToParts(ts);
  let hour = 0;
  let minute = 0;
  for (const p of parts) {
    if (p.type === 'hour') hour = parseInt(p.value, 10);
    else if (p.type === 'minute') minute = parseInt(p.value, 10);
  }
  // '24:xx' can be emitted by some engines at midnight with hour12:false.
  if (hour === 24) hour = 0;
  return hour * 60 + minute;
}

/**
 * True when `minutesSinceMidnight` falls inside the work window
 * [start, end). Supports overnight windows (end <= start, e.g. 22:00–06:00).
 */
export function isWithinWorkWindow(
  minutesSinceMidnight: number,
  startMinutes: number,
  endMinutes: number
): boolean {
  if (startMinutes === endMinutes) return true; // 24h window — degenerate config
  if (endMinutes > startMinutes) {
    return minutesSinceMidnight >= startMinutes && minutesSinceMidnight < endMinutes;
  }
  // Overnight window (e.g. 22:00–06:00): before midnight in [start, 1440) or
  // after midnight in [0, end).
  return minutesSinceMidnight >= startMinutes || minutesSinceMidnight < endMinutes;
}

/** Parse an HH:MM 24-hour string to minutes since midnight; null when invalid. */
export function parseHHMM(value: string | null | undefined): number | null {
  if (!value) return null;
  const m = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(value.trim());
  if (!m) return null;
  return parseInt(m[1], 10) * 60 + parseInt(m[2], 10);
}
