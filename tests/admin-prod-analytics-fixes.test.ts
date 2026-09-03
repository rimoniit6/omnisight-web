/**
 * Analytics / Comparison Tool production fixes.
 *
 * Covers:
 *   A. compare-query.ts — pure query building: never dereferences undefined
 *      dates, stays disabled until complete, validates start<=end, and
 *      serializes LOCAL calendar days (never toISOString().split('T')[0]).
 *   B. timezone.ts zoned day boundaries — Asia/Dhaka (+06) local midnight is
 *      18:00 UTC the previous day; a 23:30 UTC activity belongs to the NEXT
 *      local day; America/New_York DST offset handled.
 *   C. GET /api/analytics — 400 for malformed/inverted ranges; org-local day
 *      bucketing (23:30 UTC lands on the next local day in Asia/Dhaka).
 *   D. GET /api/analytics/compare — 400 for inverted periods; periods use org
 *      timezone; departments mode accepts a bounded date range.
 *
 * Runs against a THROWAWAY PostgreSQL database (workai_test_analyticsfixes).
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';
import { req } from './helpers/request';

const PG_TEST_BASE = process.env.PG_TEST_BASE_URL || 'postgresql://postgres:123456@localhost:5432';
const TEST_DB_NAME = 'workai_test_analyticsfixes';
const TEST_DB_URL = `${PG_TEST_BASE}/${TEST_DB_NAME}?schema=public`;

process.env.DATABASE_URL = TEST_DB_URL;
process.env.DIRECT_URL = TEST_DB_URL;
process.env.JWT_SECRET = 'test-jwt-secret-analyticsfixes-0123456789abcdef';
process.env.SUPER_ADMIN_EMAIL = 'root@analyticsfixes.local';
process.env.SUPER_ADMIN_PASSWORD = 'S3cure!AnalyticsFixes2026x';
(process.env as Record<string, string>).NODE_ENV = 'test';

before(() => {
  execSync(`node scripts/pg-test-db.mjs ensure ${TEST_DB_NAME}`, {
    env: { ...process.env, PG_TEST_BASE_URL: PG_TEST_BASE },
    stdio: 'pipe',
  });
  execSync('npx prisma db push --force-reset --accept-data-loss --skip-generate', {
    env: { ...process.env, DATABASE_URL: TEST_DB_URL },
    stdio: 'pipe',
  });
});

type DbModule = typeof import('../src/lib/db');
let db: DbModule['db'];
let signJWT: (payload: { userId: string; email: string; role: string; organizationId?: string }) => Promise<string>;

let orgDhaka: { id: string };
let orgUtc: { id: string };
let empDhaka: { id: string };
let empUtc: { id: string };
let adminTokenDhaka: string;
let adminTokenUtc: string;

// ─── A. Pure compare-query tests (no DB) ────────────────────────────────────

test('AQ-1: buildPeriodCompareQuery stays disabled until ALL four dates exist', async () => {
  const { buildPeriodCompareQuery } = await import('../src/lib/compare-query');
  const d = new Date('2026-08-11T00:00:00');
  assert.deepEqual(buildPeriodCompareQuery({}), { ok: false, reason: 'incomplete' });
  assert.deepEqual(buildPeriodCompareQuery({ start1: d }), { ok: false, reason: 'incomplete' });
  assert.deepEqual(buildPeriodCompareQuery({ start1: d, end1: d }), { ok: false, reason: 'incomplete' });
  assert.deepEqual(buildPeriodCompareQuery({ start1: d, end1: d, start2: d }), { ok: false, reason: 'incomplete' });
});

test('AQ-2: start after end is flagged as invalid-range (never sent to the API)', async () => {
  const { buildPeriodCompareQuery } = await import('../src/lib/compare-query');
  const d = new Date('2026-08-11T00:00:00');
  const later = new Date('2026-08-20T00:00:00');
  const okDates = { start1: d, end1: later, start2: d, end2: later };
  assert.deepEqual(buildPeriodCompareQuery({ ...okDates, end1: d, start1: later }), { ok: false, reason: 'invalid-range' });
  assert.deepEqual(buildPeriodCompareQuery({ ...okDates, end2: d, start2: later }), { ok: false, reason: 'invalid-range' });
});

test('AQ-3: valid complete selection produces periods query params with LOCAL day keys', async () => {
  const { buildPeriodCompareQuery, toLocalDayKey } = await import('../src/lib/compare-query');
  const d1 = new Date('2026-08-11T00:00:00');
  const e1 = new Date('2026-08-14T00:00:00');
  const d2 = new Date('2026-07-27T00:00:00');
  const e2 = new Date('2026-07-31T00:00:00');
  const res = buildPeriodCompareQuery({ start1: d1, end1: e1, start2: d2, end2: e2 });
  assert.equal(res.ok, true);
  if (res.ok) {
    const p = new URLSearchParams(res.params);
    assert.equal(p.get('mode'), 'periods');
    assert.equal(p.get('startDate1'), '2026-08-11');
    assert.equal(p.get('endDate1'), '2026-08-14');
    assert.equal(p.get('startDate2'), '2026-07-27');
    assert.equal(p.get('endDate2'), '2026-07-31');
  }
  // Local day serialization must reflect the LOCAL calendar date (the browser
  // may be in a positive-offset zone where toISOString would shift a day back).
  assert.equal(toLocalDayKey(new Date(2026, 7, 11, 23, 30)), '2026-08-11');
});

test('AQ-4: buildDepartmentCompareQuery requires two different departments and carries the shared range', async () => {
  const { buildDepartmentCompareQuery } = await import('../src/lib/compare-query');
  assert.deepEqual(buildDepartmentCompareQuery('', 'b'), { ok: false, params: '' });
  assert.deepEqual(buildDepartmentCompareQuery('a', 'a'), { ok: false, params: '' });
  const res = buildDepartmentCompareQuery('deptA', 'deptB', { from: new Date('2026-08-04T00:00:00'), to: new Date('2026-08-11T00:00:00') });
  assert.equal(res.ok, true);
  if (res.ok) {
    const p = new URLSearchParams(res.params);
    assert.equal(p.get('mode'), 'departments');
    assert.equal(p.get('id1'), 'deptA');
    assert.equal(p.get('id2'), 'deptB');
    assert.equal(p.get('startDate'), '2026-08-04');
    assert.equal(p.get('endDate'), '2026-08-11');
  }
});

// ─── B. Timezone day-boundary tests ─────────────────────────────────────────

test('TZ-1: Asia/Dhaka local midnight is 18:00 UTC the previous day', async () => {
  const { zonedDayStart, zonedDayEnd } = await import('../src/lib/timezone');
  const start = zonedDayStart('2026-08-11', 'Asia/Dhaka');
  assert.equal(start.toISOString(), '2026-08-10T18:00:00.000Z');
  const end = zonedDayEnd('2026-08-11', 'Asia/Dhaka');
  assert.equal(end.toISOString(), '2026-08-11T17:59:59.999Z');
});

test('TZ-2: UTC boundaries stay at UTC midnight', async () => {
  const { zonedDayStart, zonedDayEnd } = await import('../src/lib/timezone');
  assert.equal(zonedDayStart('2026-08-11', 'UTC').toISOString(), '2026-08-11T00:00:00.000Z');
  assert.equal(zonedDayEnd('2026-08-11', 'UTC').toISOString(), '2026-08-11T23:59:59.999Z');
});

test('TZ-3: America/New_York DST offset (July = EDT -4) is honored', async () => {
  const { zonedDayStart, zonedDayEnd, localDayKey } = await import('../src/lib/timezone');
  const start = zonedDayStart('2026-08-11', 'America/New_York');
  assert.equal(start.toISOString(), '2026-08-11T04:00:00.000Z');
  assert.equal(localDayKey(start, 'America/New_York'), '2026-08-11');
  assert.equal(localDayKey(zonedDayEnd('2026-08-11', 'America/New_York'), 'America/New_York'), '2026-08-11');
});

test('TZ-4: a 23:30 UTC activity lands on the NEXT local day in Asia/Dhaka', async () => {
  const { localDayKey } = await import('../src/lib/timezone');
  const activity = new Date('2026-08-10T23:30:00.000Z');
  assert.equal(localDayKey(activity, 'Asia/Dhaka'), '2026-08-11');
  assert.equal(localDayKey(activity, 'UTC'), '2026-08-10');
});

// ─── C/D. Route tests (throwaway DB) ────────────────────────────────────────

before(async () => {
  const dbModule = await import('../src/lib/db');
  db = dbModule.db;
  signJWT = (await import('../src/lib/auth')).signJWT;

  orgDhaka = await db.organization.create({ data: { name: 'Dhaka Org', slug: 'dhaka-org', timezone: 'Asia/Dhaka' } });
  orgUtc = await db.organization.create({ data: { name: 'UTC Org', slug: 'utc-org', timezone: 'UTC' } });
  empDhaka = await db.employee.create({
    data: {
      employeeId: 'AN-EMP-1',
      firstName: 'Dhaka',
      lastName: 'Worker',
      email: 'dhaka@an.test',
      organizationId: orgDhaka.id,
      status: 'active',
    },
  });
  empUtc = await db.employee.create({
    data: {
      employeeId: 'AN-EMP-2',
      firstName: 'Utc',
      lastName: 'Worker',
      email: 'utc@an.test',
      organizationId: orgUtc.id,
      status: 'active',
    },
  });

  // 2026-08-10T23:30:00Z = 2026-08-11 05:30 local in Dhaka; 2026-08-10 in UTC.
  const mk = (employeeId: string, applicationName: string, duration: number, timestamp: Date, category = 'productive') =>
    db.activity.create({
      data: { type: 'application', title: null, applicationName, category, duration, employeeId, timestamp },
    });
  await mk(empDhaka.id, 'chrome.exe', 3600, new Date('2026-08-10T23:30:00.000Z'));
  await mk(empDhaka.id, 'Code.exe', 1800, new Date('2026-08-11T06:00:00.000Z'));
  await mk(empUtc.id, 'chrome.exe', 3600, new Date('2026-08-10T23:30:00.000Z'));

  adminTokenDhaka = await signJWT({ userId: 'admin-an1', email: 'admin1@an.test', role: 'admin', organizationId: orgDhaka.id });
  adminTokenUtc = await signJWT({ userId: 'admin-an2', email: 'admin2@an.test', role: 'admin', organizationId: orgUtc.id });
});

after(async () => {
  await db.$disconnect();
  try {
    execSync(`node scripts/pg-test-db.mjs drop ${TEST_DB_NAME}`, {
      env: { ...process.env, PG_TEST_BASE_URL: PG_TEST_BASE },
      stdio: 'pipe',
    });
  } catch {
    /* best-effort cleanup */
  }
});


test('AN-1: analytics rejects inverted custom ranges with 400 (never silent empty charts)', async () => {
  const api = await import('../src/app/api/analytics/route');
  const res = await api.GET(
    req(adminTokenDhaka, { url: 'http://localhost:3000/api/analytics?startDate=2026-08-20&endDate=2026-08-15' })
  );
  assert.equal(res.status, 400);
  const body = await res.json();
  assert.match(body.error, /must not be after/i);
});

test('AN-2: analytics rejects malformed date params with 400', async () => {
  const api = await import('../src/app/api/analytics/route');
  const res = await api.GET(
    req(adminTokenDhaka, { url: 'http://localhost:3000/api/analytics?startDate=08/11/2026&endDate=08/12/2026' })
  );
  assert.equal(res.status, 400);
});

test('AN-3: single-day analytics window in Asia/Dhaka captures the 23:30 UTC activity on the local day', async () => {
  const api = await import('../src/app/api/analytics/route');
  // 2026-08-11 local Dhaka window = 2026-08-10T18:00Z → 2026-08-11T17:59:59Z.
  const res = await api.GET(
    req(adminTokenDhaka, { url: 'http://localhost:3000/api/analytics?startDate=2026-08-11&endDate=2026-08-11' })
  );
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.data.summary.totalActivities, 2, 'both Dhaka activities fall inside the local day window');
  // The 23:30 UTC activity buckets to the LOCAL day 2026-08-11, not the UTC day.
  const day = body.data.productivityTrends.find((t: { dateISO: string }) => t.dateISO === '2026-08-11');
  assert.ok(day, 'trend must contain the 2026-08-11 local day bucket');
  assert.equal(day.totalMinutes, (3600 + 1800) / 60, 'both activities counted in the local day bucket');
});

test('AN-4: the same instant belongs to the PREVIOUS day for a UTC org (org timezone is authoritative)', async () => {
  const api = await import('../src/app/api/analytics/route');
  const res = await api.GET(
    req(adminTokenUtc, { url: 'http://localhost:3000/api/analytics?startDate=2026-08-11&endDate=2026-08-11' })
  );
  assert.equal(res.status, 200);
  const body = await res.json();
  // 23:30 UTC on the 10th is NOT inside the UTC 2026-08-11 window.
  assert.equal(body.data.summary.totalActivities, 0, 'UTC org must NOT count the 23:30Z activity on the 11th');
});

test('AN-5: compare periods rejects inverted ranges with 400', async () => {
  const api = await import('../src/app/api/analytics/compare/route');
  const res = await api.GET(
    req(adminTokenDhaka, {
      url: 'http://localhost:3000/api/analytics/compare?mode=periods&startDate1=2026-08-20&endDate1=2026-08-15&startDate2=2026-08-01&endDate2=2026-08-10',
    })
  );
  assert.equal(res.status, 400);
});

test('AN-6: compare periods counts active days in the org timezone', async () => {
  const api = await import('../src/app/api/analytics/compare/route');
  const res = await api.GET(
    req(adminTokenDhaka, {
      url: 'http://localhost:3000/api/analytics/compare?mode=periods&startDate1=2026-08-11&endDate1=2026-08-11&startDate2=2026-08-01&endDate2=2026-08-10',
    })
  );
  assert.equal(res.status, 200);
  const body = await res.json();
  // Both Dhaka activities are on local day 2026-08-11 → 1 active day (not 2).
  assert.equal(body.entityA.activeDays, 1);
  assert.equal(body.entityA.totalActivities, 2);
});

test('AN-7: departments mode is date-bounded and cross-org departments stay concealed', async () => {
  const api = await import('../src/app/api/analytics/compare/route');
  const dept = await db.department.create({
    data: { name: 'Eng', organizationId: orgDhaka.id },
  });
  await db.employee.update({ where: { id: empDhaka.id }, data: { departmentId: dept.id } });

  // Cross-org department must be concealed (404).
  const cross = await api.GET(
    req(adminTokenDhaka, {
      url: `http://localhost:3000/api/analytics/compare?mode=departments&id1=${dept.id}&id2=00000000-0000-0000-0000-000000000000`,
    })
  );
  assert.equal(cross.status, 404);
});

test('AN-8: departments mode honors the shared date range (bounded, never all-history)', async () => {
  const api = await import('../src/app/api/analytics/compare/route');
  const dept = await db.department.create({
    data: { name: 'Bounded Eng', organizationId: orgDhaka.id },
  });
  const emp = await db.employee.create({
    data: {
      employeeId: 'AN-EMP-B',
      firstName: 'Bound',
      lastName: 'Worker',
      email: 'bound@an.test',
      organizationId: orgDhaka.id,
      status: 'active',
      departmentId: dept.id,
    },
  });
  // Recent activity inside the window + an OLD activity (6 months back) that
  // must NOT be counted when the shared range is applied.
  await db.activity.create({
    data: { type: 'application', title: null, applicationName: 'chrome.exe', category: 'productive', duration: 1200, employeeId: emp.id, timestamp: new Date('2026-08-09T12:00:00.000Z') },
  });
  await db.activity.create({
    data: { type: 'application', title: null, applicationName: 'old.exe', category: 'neutral', duration: 9999, employeeId: emp.id, timestamp: new Date('2026-02-09T12:00:00.000Z') },
  });

  const res = await api.GET(
    req(adminTokenDhaka, {
      url: `http://localhost:3000/api/analytics/compare?mode=departments&id1=${dept.id}&id2=${dept.id}&startDate=2026-08-04&endDate=2026-08-11`,
    })
  );
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.entityA.totalActivities, 1, 'only the in-window activity is counted');
  assert.equal(body.entityA.activeHours, Math.round(1200 / 3600 * 10) / 10, 'duration comes only from in-window activities');
  const apps = body.entityA.topApps as Array<{ name: string }>;
  assert.equal(apps.map((a) => a.name).includes('old.exe'), false, 'out-of-window app must not appear');
  assert.equal(apps.map((a) => a.name).includes('chrome.exe'), true, 'in-window app still appears');
});

test('AN-9: departments mode without a range falls back to a bounded 90-day window', async () => {
  const api = await import('../src/app/api/analytics/compare/route');
  const dept = await db.department.create({
    data: { name: 'Fallback Eng', organizationId: orgDhaka.id },
  });
  const emp = await db.employee.create({
    data: {
      employeeId: 'AN-EMP-C',
      firstName: 'Fallback',
      lastName: 'Worker',
      email: 'fallback@an.test',
      organizationId: orgDhaka.id,
      status: 'active',
      departmentId: dept.id,
    },
  });
  // An activity 200 days in the past must be outside the 90-day fallback.
  await db.activity.create({
    data: { type: 'application', title: null, applicationName: 'ancient.exe', category: 'neutral', duration: 9999, employeeId: emp.id, timestamp: new Date(Date.now() - 200 * 24 * 3600 * 1000) },
  });

  const res = await api.GET(
    req(adminTokenDhaka, {
      url: `http://localhost:3000/api/analytics/compare?mode=departments&id1=${dept.id}&id2=${dept.id}`,
    })
  );
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.entityA.totalActivities, 0, 'ancient activity excluded by the 90-day fallback bound');
  const apps = body.entityA.topApps as Array<{ name: string }>;
  assert.equal(apps.map((a) => a.name).includes('ancient.exe'), false);
});
