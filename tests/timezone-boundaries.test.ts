/**
 * P2-3 — org-timezone boundary tests.
 *
 * All business-day calculations (employee detail charts, self-portal
 * today/week, break grouping, analytics) must use the ORGANIZATION timezone,
 * never the server's local zone. These tests pin the helpers used by those
 * routes: localDayKey, zonedDayStart/End, orgDayWindow, hourInTimezone,
 * addDaysToKey, zonedDayOfWeek, safeTimezone — including DST-capable zones
 * and server-TZ independence. Pure unit tests: no database required.
 */
import { test, before } from 'node:test';
import assert from 'node:assert/strict';

type Tz = typeof import('../src/lib/timezone');
let tz: Tz;
before(async () => {
  tz = await import('../src/lib/timezone');
});
const localDayKey = (...a: Parameters<Tz['localDayKey']>) => tz.localDayKey(...a);
const zonedDayStart = (...a: Parameters<Tz['zonedDayStart']>) => tz.zonedDayStart(...a);
const zonedDayEnd = (...a: Parameters<Tz['zonedDayEnd']>) => tz.zonedDayEnd(...a);
const orgDayWindow = (...a: Parameters<Tz['orgDayWindow']>) => tz.orgDayWindow(...a);
const hourInTimezone = (...a: Parameters<Tz['hourInTimezone']>) => tz.hourInTimezone(...a);
const addDaysToKey = (...a: Parameters<Tz['addDaysToKey']>) => tz.addDaysToKey(...a);
const zonedDayOfWeek = (...a: Parameters<Tz['zonedDayOfWeek']>) => tz.zonedDayOfWeek(...a);
const safeTimezone = (...a: Parameters<Tz['safeTimezone']>) => tz.safeTimezone(...a);
const isValidTimezone = (...a: Parameters<Tz['isValidTimezone']>) => tz.isValidTimezone(...a);
const lastNDayKeys = (...a: Parameters<Tz['lastNDayKeys']>) => tz.lastNDayKeys(...a);

test('TZ-1: midnight / UTC-local day boundary (23:30 UTC crosses into next local day in Dhaka)', () => {
  const ts = new Date('2026-08-11T23:30:00Z');
  assert.equal(localDayKey(ts, 'UTC'), '2026-08-11');
  assert.equal(localDayKey(ts, 'Asia/Dhaka'), '2026-08-12'); // +06 → 05:30 next day
  assert.equal(localDayKey(ts, 'America/New_York'), '2026-08-11'); // -04 → 19:30 same day

  // Inverse: just after UTC midnight is the SAME local day everywhere,
  // but the previous local evening belongs to the previous day in + zones.
  const early = new Date('2026-08-12T00:30:00Z');
  assert.equal(localDayKey(early, 'Asia/Dhaka'), '2026-08-12');
  assert.equal(localDayKey(early, 'UTC'), '2026-08-12');
});

test('TZ-2: zonedDayStart/End map calendar keys to correct instants', () => {
  // Asia/Dhaka (+06, no DST): local midnight = 18:00 UTC previous day.
  const start = zonedDayStart('2026-08-12', 'Asia/Dhaka');
  assert.equal(start.toISOString(), '2026-08-11T18:00:00.000Z');
  const end = zonedDayEnd('2026-08-12', 'Asia/Dhaka');
  assert.equal(end.toISOString(), '2026-08-12T17:59:59.999Z');

  // Round trip: the instant at day start belongs to that local day.
  assert.equal(localDayKey(start, 'Asia/Dhaka'), '2026-08-12');
  assert.equal(localDayKey(end, 'Asia/Dhaka'), '2026-08-12');
});

test('TZ-3: orgDayWindow is self-consistent and DST-aware (spring forward, 23-hour day)', () => {
  // 2026-03-08 America/New_York: DST starts 2:00→3:00 AM. Day is 23h long.
  const fakeNow = new Date('2026-03-08T15:00:00Z');
  const w = orgDayWindow('America/New_York', fakeNow);
  assert.equal(w.dayKey, '2026-03-08');
  assert.equal(w.dayStart.toISOString(), '2026-03-08T05:00:00.000Z'); // midnight EST
  assert.equal(w.dayEnd.toISOString(), '2026-03-09T03:59:59.999Z'); // next midnight EDT - 1ms
  assert.equal(localDayKey(w.dayStart, 'America/New_York'), '2026-03-08');
  assert.equal(localDayKey(w.dayEnd, 'America/New_York'), '2026-03-08');
  assert.equal(
    (w.dayEnd.getTime() - w.dayStart.getTime() + 1) / 3_600_000,
    23,
    'spring-forward day is 23 hours long'
  );
});

test('TZ-4: DST fall-back day (2026-11-01, 25-hour day) is handled without losing/gaining buckets', () => {
  const fakeNow = new Date('2026-11-01T12:00:00Z');
  const w = orgDayWindow('America/New_York', fakeNow);
  assert.equal(w.dayKey, '2026-11-01');
  assert.equal(w.dayStart.toISOString(), '2026-11-01T04:00:00.000Z'); // midnight EDT
  assert.equal(w.dayEnd.toISOString(), '2026-11-02T04:59:59.999Z'); // next midnight EST - 1ms
  assert.equal(
    (w.dayEnd.getTime() - w.dayStart.getTime() + 1) / 3_600_000,
    25,
    'fall-back day is 25 hours long'
  );
  // lastNDayKeys across the fall-back transition still yields n distinct keys.
  const keys = lastNDayKeys('America/New_York', 3, new Date('2026-11-02T12:00:00Z'));
  assert.equal(keys.length, 3);
  assert.equal(new Set(keys).size, 3);
  assert.deepEqual(keys, ['2026-10-31', '2026-11-01', '2026-11-02']);
});

test('TZ-5: week transition — Monday of the org-local week', () => {
  // Sunday 2026-08-16 → previous Monday is 2026-08-10 (daysSinceMonday = 6).
  const sunday = new Date('2026-08-16T12:00:00Z');
  assert.equal(zonedDayOfWeek(sunday, 'UTC'), 0);
  const sunKey = localDayKey(sunday, 'UTC');
  const sunDaysSinceMonday = zonedDayOfWeek(sunday, 'UTC') === 0 ? 6 : zonedDayOfWeek(sunday, 'UTC') - 1;
  assert.equal(addDaysToKey(sunKey, -sunDaysSinceMonday), '2026-08-10');

  // Monday 2026-08-17 → itself; Tuesday 2026-08-18 → Monday 2026-08-17.
  const mon = new Date('2026-08-17T12:00:00Z');
  const monDow = zonedDayOfWeek(mon, 'UTC');
  assert.equal(addDaysToKey(localDayKey(mon, 'UTC'), -(monDow === 0 ? 6 : monDow - 1)), '2026-08-17');
  const tue = new Date('2026-08-18T12:00:00Z');
  const tueDow = zonedDayOfWeek(tue, 'UTC');
  assert.equal(addDaysToKey(localDayKey(tue, 'UTC'), -(tueDow === 0 ? 6 : tueDow - 1)), '2026-08-17');
});

test('TZ-6: month transition — calendar-key arithmetic is month-aware', () => {
  assert.equal(addDaysToKey('2026-08-31', 1), '2026-09-01');
  assert.equal(addDaysToKey('2026-09-01', -1), '2026-08-31');
  assert.equal(addDaysToKey('2026-03-01', -1), '2026-02-28'); // non-leap year
  assert.equal(addDaysToKey('2028-03-01', -1), '2028-02-29'); // leap year
  assert.equal(addDaysToKey('2026-12-31', 1), '2027-01-01');

  // A 23:30 UTC instant on Aug 31 rolls to Sep 1 in Dhaka.
  assert.equal(localDayKey(new Date('2026-08-31T23:30:00Z'), 'Asia/Dhaka'), '2026-09-01');
});

test('TZ-7: hourInTimezone buckets by org zone, DST-aware', () => {
  assert.equal(hourInTimezone(new Date('2026-08-15T10:00:00Z'), 'UTC'), 10);
  assert.equal(hourInTimezone(new Date('2026-08-15T10:00:00Z'), 'Asia/Dhaka'), 16); // +06
  // 06:00 UTC on 2026-03-08 in NY = 01:00 EST (pre-spring-forward).
  assert.equal(hourInTimezone(new Date('2026-03-08T06:00:00Z'), 'America/New_York'), 1);
  // 07:00 UTC = 03:00 EDT — hour 2 was skipped by spring-forward.
  assert.equal(hourInTimezone(new Date('2026-03-08T07:00:00Z'), 'America/New_York'), 3);
});

test('TZ-8: server-local TZ never influences org-day results', () => {
  const saved = process.env.TZ;
  const ts = new Date('2026-08-11T23:30:00Z');
  try {
    for (const serverTz of ['UTC', 'Asia/Dhaka', 'Pacific/Honolulu', 'America/Los_Angeles']) {
      process.env.TZ = serverTz;
      assert.equal(localDayKey(ts, 'Asia/Dhaka'), '2026-08-12', `server TZ ${serverTz} must not shift Dhaka day`);
      assert.equal(localDayKey(ts, 'UTC'), '2026-08-11', `server TZ ${serverTz} must not shift UTC day`);
      assert.equal(
        zonedDayStart('2026-08-12', 'Asia/Dhaka').toISOString(),
        '2026-08-11T18:00:00.000Z',
        `server TZ ${serverTz} must not shift Dhaka midnight`
      );
    }
  } finally {
    if (saved === undefined) delete process.env.TZ;
    else process.env.TZ = saved;
  }
});

test('TZ-9: invalid/missing timezone falls back safely (never throws)', () => {
  assert.equal(isValidTimezone('Asia/Dhaka'), true);
  assert.equal(isValidTimezone('UTC'), true);
  assert.equal(isValidTimezone('Nope/Zzz'), false);
  assert.equal(isValidTimezone(''), false);
  assert.equal(safeTimezone('Nope/Zzz'), 'UTC');
  assert.equal(safeTimezone(null), 'UTC');
  assert.equal(safeTimezone(undefined), 'UTC');
  assert.equal(safeTimezone('America/New_York'), 'America/New_York');

  const ts = new Date('2026-08-11T23:30:00Z');
  assert.equal(localDayKey(ts, 'Nope/Zzz'), '2026-08-11'); // UTC fallback
  assert.equal(zonedDayStart('2026-08-12', 'Nope/Zzz').toISOString(), '2026-08-12T00:00:00.000Z');
  assert.equal(hourInTimezone(ts, 'Nope/Zzz'), 23);
  const w = orgDayWindow('Nope/Zzz', ts);
  assert.equal(w.dayKey, '2026-08-11');
  assert.equal(localDayKey(w.dayStart, 'UTC'), '2026-08-11');
});
