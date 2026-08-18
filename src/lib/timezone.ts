/**
 * Timezone utilities (S-4 / S-6).
 *
 * `Organization.timezone` is the single source of truth for the
 * organization-local day/working-hours. These helpers are Intl-based — no
 * heavy dependency — and never throw on invalid input.
 */

/**
 * True when `tz` is a valid IANA timezone identifier (e.g. "Asia/Dhaka",
 * "UTC", "America/New_York"). `Intl.DateTimeFormat` throws RangeError for
 * unknown zones, which is the authoritative validation.
 */
export function isValidTimezone(tz: string): boolean {
  if (!tz || tz.length > 64) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/**
 * Normalize a possibly-missing/invalid timezone to a usable IANA zone.
 * Invalid or missing zones fall back to 'UTC' (never throw) — the same
 * convention every org-timezone consumer uses.
 */
export function safeTimezone(tz: string | null | undefined): string {
  return tz && isValidTimezone(tz) ? tz : 'UTC';
}

/**
 * Local calendar day (YYYY-MM-DD) of `date` in the given IANA timezone.
 *
 * Example: 2026-08-11T23:30:00Z in "Asia/Dhaka" (+06) is 05:30 on the 12th —
 * this returns "2026-08-12", while a UTC bucket would wrongly say "2026-08-11".
 * Invalid/missing timezones fall back to the UTC day (never throw).
 */
export function localDayKey(date: Date, timezone: string): string {
  try {
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: timezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).formatToParts(date);
    const y = parts.find((p) => p.type === 'year')?.value;
    const m = parts.find((p) => p.type === 'month')?.value;
    const d = parts.find((p) => p.type === 'day')?.value;
    if (!y || !m || !d) return date.toISOString().split('T')[0];
    return `${y}-${m}-${d}`;
  } catch {
    return date.toISOString().split('T')[0];
  }
}

/**
 * The last `n` distinct local calendar days (oldest first) ending today in the
 * given timezone. Walks back far enough to collect `n` distinct local keys
 * (DST boundaries can produce overlapping UTC offsets). Deterministic and
 * pure — testable without a database.
 */
export function lastNDayKeys(timezone: string, n: number, now = new Date()): string[] {
  const keys: string[] = [];
  const seen = new Set<string>();
  for (let i = 0; i < n + 3; i++) {
    const key = localDayKey(new Date(now.getTime() - i * 86_400_000), timezone);
    if (!seen.has(key)) {
      seen.add(key);
      keys.push(key);
      if (keys.length === n) break;
    }
  }
  return keys.reverse();
}

/**
 * Zone offset (ms) of `date` in the given IANA timezone: local = UTC + offset.
 * Never throws; invalid zones return 0 (UTC-like).
 */
function zoneOffsetMs(date: Date, timezone: string): number {
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false,
    }).formatToParts(date);
    const get = (type: string) => parts.find((p) => p.type === type)?.value;
    const y = Number(get('year'));
    const mo = Number(get('month'));
    const d = Number(get('day'));
    let h = Number(get('hour'));
    if (h === 24) h = 0; // en-US hour12:false can emit '24' at midnight
    const mi = Number(get('minute'));
    const s = Number(get('second'));
    const asUtc = Date.UTC(y, mo - 1, d, h, mi, s);
    return asUtc - date.getTime();
  } catch {
    return 0;
  }
}

/**
 * Milliseconds since local midnight of `date` in `timezone` (DST-aware).
 * Never throws; invalid zones return 0.
 */
function localWallClockMs(date: Date, timezone: string): number {
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone,
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false,
    }).formatToParts(date);
    let h = Number(parts.find((p) => p.type === 'hour')?.value ?? '0');
    if (h === 24) h = 0;
    const mi = Number(parts.find((p) => p.type === 'minute')?.value ?? '0');
    const s = Number(parts.find((p) => p.type === 'second')?.value ?? '0');
    return h * 3_600_000 + mi * 60_000 + s * 1000;
  } catch {
    return 0;
  }
}

/**
 * First instant of the calendar day `YYYY-MM-DD` in the given timezone
 * (the local midnight, DST-aware). Example: '2026-08-11' in 'Asia/Dhaka'
 * is 2026-08-10T18:00:00Z, NOT 2026-08-11T00:00:00Z. Invalid zones fall
 * back to UTC midnight of the day (never throw).
 */
export function zonedDayStart(day: string, timezone: string): Date {
  const [y, m, d] = day.split('-').map(Number);
  if (!y || !m || !d) return new Date(`${day}T00:00:00.000Z`);
  const utcMidnight = Date.UTC(y, m - 1, d, 0, 0, 0, 0);
  let t = utcMidnight - zoneOffsetMs(new Date(utcMidnight), timezone);
  // DST edges: the offset at UTC midnight may not be the offset at local
  // midnight. Walk TOWARD the requested local day (backward or forward) in
  // 30-minute steps until the instant falls on that day, then snap to the
  // day's local midnight. If convergence fails (pathological zone), fall back
  // to UTC midnight — never return the WRONG local day.
  for (let i = 0; i < 24; i++) {
    const key = localDayKey(new Date(t), timezone);
    if (key === day) break;
    t += (key < day ? 1 : -1) * 30 * 60 * 1000;
  }
  if (localDayKey(new Date(t), timezone) !== day) return new Date(utcMidnight);
  return new Date(t - localWallClockMs(new Date(t), timezone));
}

/**
 * Last instant of the calendar day `YYYY-MM-DD` in `timezone` (inclusive,
 * i.e. local midnight of the NEXT day minus 1 ms). Never throws.
 */
export function zonedDayEnd(day: string, timezone: string): Date {
  const [y, m, d] = day.split('-').map(Number);
  const next = new Date(Date.UTC(y, m - 1, d + 1, 0, 0, 0, 0));
  const nextDay = next.toISOString().split('T')[0];
  return new Date(zonedDayStart(nextDay, timezone).getTime() - 1);
}

/**
 * All calendar-day keys (YYYY-MM-DD) from `startKey` to `endKey` inclusive,
 * oldest first. Day-string comparison is safe for zero-padded ISO dates.
 */
export function dayKeysBetween(startKey: string, endKey: string): string[] {
  const keys: string[] = [];
  let cur = startKey;
  let guard = 0;
  while (cur <= endKey && guard < 400) {
    keys.push(cur);
    const [y, m, d] = cur.split('-').map(Number);
    const next = new Date(Date.UTC(y, m - 1, d + 1, 0, 0, 0, 0));
    cur = next.toISOString().split('T')[0];
    guard += 1;
  }
  return keys;
}

/**
 * A single org-local calendar day window (S-4 / S-6).
 *
 * All "today" / day-boundary consumers (break stats, break history, daily
 * reports, dashboard) MUST use this helper instead of server-local
 * `setHours(0,0,0,0)` so the org's configured timezone is the day boundary.
 * Returns the local day key plus the inclusive [start, end] instants.
 */
export interface OrgDayWindow {
  dayKey: string;
  dayStart: Date;
  dayEnd: Date; // inclusive (last ms of the local day)
}

export function orgDayWindow(
  timezone: string,
  now: Date = new Date()
): OrgDayWindow {
  const tz = safeTimezone(timezone);
  const dayKey = localDayKey(now, tz);
  return {
    dayKey,
    dayStart: zonedDayStart(dayKey, tz),
    dayEnd: zonedDayEnd(dayKey, tz),
  };
}

/**
 * Hour of day (0-23) of `date` in the given IANA timezone (DST-aware).
 * Never throws; invalid zones fall back to the UTC hour (same convention as
 * the other org-day helpers). Used by the employee detail hourly chart so
 * the org timezone (never the server's local zone) decides the hour buckets.
 */
export function hourInTimezone(date: Date, timezone: string): number {
  if (!isValidTimezone(timezone)) return date.getUTCHours();
  return Math.floor(localWallClockMs(date, timezone) / 3_600_000);
}

/**
 * Add (or subtract) whole days to a YYYY-MM-DD key. Pure date arithmetic on
 * the calendar key — DST-proof and timezone-independent (a calendar day is
 * always 24 calendar hours of the key, not wall-clock hours).
 */
export function addDaysToKey(key: string, days: number): string {
  const [y, m, d] = key.split('-').map(Number);
  if (!y || !m || !d) return key;
  const t = Date.UTC(y, m - 1, d) + days * 86_400_000;
  return new Date(t).toISOString().slice(0, 10);
}

/**
 * Day of week (0=Sunday … 6=Saturday) of `date` in the given IANA timezone.
 * Never throws; invalid zones return 0.
 */
export function zonedDayOfWeek(date: Date, timezone: string): number {
  try {
    const parts = new Intl.DateTimeFormat('en-US', { timeZone: timezone, weekday: 'short' }).formatToParts(date);
    const label = parts.find((p) => p.type === 'weekday')?.value;
    const map: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
    return label ? (map[label] ?? 0) : 0;
  } catch {
    return 0;
  }
}

/**
 * Curated IANA timezone options for the Organization timezone selector.
 * Validation is still enforced server-side via isValidTimezone — this list is
 * a UX convenience, not the security boundary.
 */
export const TIMEZONE_OPTIONS: Array<{ value: string; label: string }> = [
  { value: 'UTC', label: 'UTC (Coordinated Universal Time)' },
  { value: 'Asia/Dhaka', label: 'Asia/Dhaka (GMT+6)' },
  { value: 'Asia/Kolkata', label: 'Asia/Kolkata (GMT+5:30)' },
  { value: 'Asia/Karachi', label: 'Asia/Karachi (GMT+5)' },
  { value: 'Asia/Dubai', label: 'Asia/Dubai (GMT+4)' },
  { value: 'Asia/Singapore', label: 'Asia/Singapore (GMT+8)' },
  { value: 'Asia/Tokyo', label: 'Asia/Tokyo (GMT+9)' },
  { value: 'Asia/Shanghai', label: 'Asia/Shanghai (GMT+8)' },
  { value: 'Europe/London', label: 'Europe/London (GMT+0/+1)' },
  { value: 'Europe/Paris', label: 'Europe/Paris (GMT+1/+2)' },
  { value: 'Europe/Berlin', label: 'Europe/Berlin (GMT+1/+2)' },
  { value: 'America/New_York', label: 'America/New_York (GMT-5/-4)' },
  { value: 'America/Chicago', label: 'America/Chicago (GMT-6/-5)' },
  { value: 'America/Denver', label: 'America/Denver (GMT-7/-6)' },
  { value: 'America/Los_Angeles', label: 'America/Los_Angeles (GMT-8/-7)' },
  { value: 'America/Toronto', label: 'America/Toronto (GMT-5/-4)' },
  { value: 'America/Sao_Paulo', label: 'America/Sao_Paulo (GMT-3)' },
  { value: 'Australia/Sydney', label: 'Australia/Sydney (GMT+10/+11)' },
  { value: 'Pacific/Auckland', label: 'Pacific/Auckland (GMT+12/+13)' },
];
