/**
 * Dashboard consumer wiring — WorkDaySummary read path (Phase 4 consumption).
 *
 * The /api/dashboard productivity metrics (dailyProductivity buckets, score,
 * avgProductivity, topEmployees) are served per org-local day from the
 * WorkDaySummary rollup when the aggregation job has covered that day, with an
 * EXACT raw-row fallback for the current org-local day (partial until it
 * completes) and for uncovered past days (pre-backfill installs). The raw
 * fallback runs the SAME aggregation engine over the SAME org-local window, so
 * a day served from the rollup and a day served from raw rows must produce
 * byte-identical values.
 *
 * Proves:
 *  - DC-1: all-raw org → dashboard equals an independent raw recomputation.
 *  - DC-2: identical org whose PAST days are materialized as summaries (today
 *    left raw) → dashboard output is byte-identical to the all-raw org, and
 *    readOrgDayTotals reports the expected summary/raw source mix.
 *  - DC-3: tenant isolation — an unrelated org's telemetry never appears, and
 *    an org with zero rows returns a zero dashboard.
 *
 * Runs against a THROWAWAY PostgreSQL database (workai_test_dashconsumer).
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';
import { NextRequest } from 'next/server';

const PG_TEST_BASE = process.env.PG_TEST_BASE_URL || 'postgresql://postgres:123456@localhost:5432';
const TEST_DB_NAME = 'workai_test_dashconsumer';
const TEST_DB_URL = `${PG_TEST_BASE}/${TEST_DB_NAME}?schema=public`;

process.env.DATABASE_URL = TEST_DB_URL;
process.env.DIRECT_URL = TEST_DB_URL;
process.env.JWT_SECRET = 'test-jwt-secret-dashconsumer-0123456789abcdef';
process.env.SUPER_ADMIN_EMAIL = 'root@dashconsumer.local';
process.env.SUPER_ADMIN_PASSWORD = 'S3cure!DashConsumer2026x';
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
let seq = 0;

before(async () => {
  const dbModule = await import('../src/lib/db');
  db = dbModule.db;
  signJWT = (await import('../src/lib/auth')).signJWT;
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

/** UTC timestamp at 00:30 on the given offset day (stable within a day). */
function dayOffsetUtc(daysAgo: number): Date {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - daysAgo, 0, 30, 0, 0));
}

/** Fresh UTC org + 1 employee + admin token. */
async function freshOrg(name: string) {
  seq += 1;
  const org = await db.organization.create({
    data: { name: `${name} ${seq}`, slug: `dashconsumer-${name.toLowerCase()}-${seq}-${Date.now()}`, timezone: 'UTC' },
  });
  const emp = await db.employee.create({
    data: {
      employeeId: `DC-EMP-${seq}`,
      firstName: 'Con',
      lastName: `Sumer${seq}`,
      email: `dc${seq}@dashconsumer.test`,
      organizationId: org.id,
      status: 'active',
    },
  });
  const token = await signJWT({ userId: `admin-dc-${seq}`, email: `admin-dc${seq}@dashconsumer.test`, role: 'admin', organizationId: org.id });
  return { orgId: org.id, empId: emp.id, token };
}

function req(token: string): NextRequest {
  return new NextRequest('http://localhost:3000/api/dashboard', { headers: { authorization: `Bearer ${token}` } });
}

async function dashboardData(token: string) {
  const api = await import('../src/app/api/dashboard/route');
  const res = await api.GET(req(token));
  assert.equal(res.status, 200);
  const body = await res.json();
  return body.data as {
    avgProductivity: number;
    productivityScore: number;
    topEmployees: Array<{ id: string; firstName: string; productiveTime: number }>;
    dailyProductivity: Array<{ date: string; productive: number; neutral: number; unproductive: number }>;
  };
}

/**
 * Seeded scenario (UTC org, rows at 00:30 local of their day so day keys are
 * unambiguous at any call time):
 *  - 3 days ago  Code.exe  productive  3600s   (past → summary-eligible)
 *  - 2 days ago  Mail      neutral     1800s   (past → summary-eligible)
 *  - 1 day ago   game.exe  unproductive 900s   (past → summary-eligible)
 *  - 1 day ago   Code.exe  productive  5400s   (past → summary-eligible)
 *  - today       Code.exe  productive  1800s   (today → ALWAYS raw)
 *
 * Expected (UTC org, one employee):
 *  - productive = 3600 + 5400 + 1800 = 10800s
 *  - neutral = 1800s, unproductive = 900s → total categorized = 13500s
 *  - productivityScore = round(10800/13500×100) = 80
 *  - avgProductivity = 10800s / 1 emp / 3600 = 3
 *  - daily minutes: day-3 p60; day-2 n30; day-1 p90 u15; today p30
 */
async function seedOrgScenario() {
  const org = await freshOrg('Consume');
  await db.activity.createMany({
    data: [
      { employeeId: org.empId, type: 'application', title: 'Code', applicationName: 'Code.exe', category: 'productive', duration: 3600, timestamp: dayOffsetUtc(3), createdAt: dayOffsetUtc(3) },
      { employeeId: org.empId, type: 'application', title: 'Mail', applicationName: 'mail.exe', category: 'neutral', duration: 1800, timestamp: dayOffsetUtc(2), createdAt: dayOffsetUtc(2) },
      { employeeId: org.empId, type: 'application', title: 'Game', applicationName: 'game.exe', category: 'unproductive', duration: 900, timestamp: dayOffsetUtc(1), createdAt: dayOffsetUtc(1) },
      { employeeId: org.empId, type: 'application', title: 'Code', applicationName: 'Code.exe', category: 'productive', duration: 5400, timestamp: dayOffsetUtc(1), createdAt: dayOffsetUtc(1) },
      { employeeId: org.empId, type: 'application', title: 'Code', applicationName: 'Code.exe', category: 'productive', duration: 1800, timestamp: dayOffsetUtc(0), createdAt: dayOffsetUtc(0) },
    ],
  });
  return org;
}

/** Expected normalized dashboard view of the seeded scenario. */
const EXPECTED = {
  avgProductivity: 3,
  productivityScore: 80,
  dailyProductiveMinutes: [60, 0, 90, 30], // day-3, day-2, day-1, today
  dailyNeutralMinutes: [0, 30, 0, 0],
  dailyUnproductiveMinutes: [0, 0, 15, 0],
};

function assertScenarioDashboard(data: { avgProductivity: number; productivityScore: number; dailyProductivity: Array<{ productive: number; neutral: number; unproductive: number }> }) {
  assert.equal(data.avgProductivity, EXPECTED.avgProductivity, 'avgProductivity (productive h per active employee)');
  assert.equal(data.productivityScore, EXPECTED.productivityScore, 'productivityScore over the same 7-day org-local window');
  assert.equal(data.dailyProductivity.length, 7, 'exactly 7 buckets');
  const values = data.dailyProductivity.map((d) => [d.productive, d.neutral, d.unproductive]);
  // The LAST four buckets are day-3, day-2, day-1, today (older ones are 0).
  const tail = values.slice(3);
  for (let i = 0; i < 4; i += 1) {
    assert.deepEqual(tail[i], [EXPECTED.dailyProductiveMinutes[i], EXPECTED.dailyNeutralMinutes[i], EXPECTED.dailyUnproductiveMinutes[i]], `bucket ${i}`);
  }
  for (const b of values.slice(0, 3)) {
    assert.deepEqual(b, [0, 0, 0], 'older buckets are empty');
  }
}

test('DC-1: all-raw org → dashboard equals the raw recomputation', async () => {
  const org = await seedOrgScenario();
  const data = await dashboardData(org.token);
  assertScenarioDashboard(data);
  // topEmployees reflects exactly the productive seconds (10800s).
  assert.equal(data.topEmployees.length, 1);
  assert.equal(data.topEmployees[0].productiveTime, 10800, 'productiveTime is exact seconds');
});

test('DC-2: summary-covered past days + raw today → byte-identical dashboard', async () => {
  const { rebuildDaysForOrg } = await import('../src/lib/jobs/workday-summary');
  const { lastNDayKeys, localDayKey } = await import('../src/lib/timezone');

  const org = await seedOrgScenario();
  const now = new Date();
  const allKeys = lastNDayKeys('UTC', 7, now);
  const todayKey = localDayKey(now, 'UTC');
  const pastKeys = allKeys.filter((k) => k !== todayKey);

  // Materialize rollups for ALL PAST days (as the hourly job would); today is
  // deliberately left raw (partial until it completes).
  const res = await rebuildDaysForOrg(org.orgId, pastKeys, { now });
  assert.equal(res.errors.length, 0);
  assert.ok(res.upserted >= 3, 'past days (day-3, day-2, day-1) materialized into summaries');

  // The reader must report: data-bearing past days from the rollup, today
  // from raw rows. Empty past days have no rows and therefore no source entry.
  const { readOrgDayTotals } = await import('../src/lib/workday/consume');
  const read = await readOrgDayTotals({ organizationId: org.orgId, timezone: 'UTC', dayKeys: allKeys, now });
  const dataKeys = [localDayKey(dayOffsetUtc(3), 'UTC'), localDayKey(dayOffsetUtc(2), 'UTC'), localDayKey(dayOffsetUtc(1), 'UTC')];
  for (const key of dataKeys) assert.equal(read.source.get(key), 'summary', `data past day ${key} served from rollup`);
  assert.equal(read.source.get(todayKey), 'raw', 'today always raw (partial day)');

  // Dashboard values must be identical to the all-raw org (DC-1 scenario).
  const data = await dashboardData(org.token);
  assertScenarioDashboard(data);
  assert.equal(data.topEmployees[0].productiveTime, 10800);
});

test('DC-3: tenant isolation + zero-data org', async () => {
  // Org A: summary-covered data. Org B: its OWN identical raw rows must never
  // appear in A, and an empty org C returns a zero dashboard.
  const { rebuildDaysForOrg } = await import('../src/lib/jobs/workday-summary');
  const { lastNDayKeys, localDayKey } = await import('../src/lib/timezone');
  const now = new Date();
  const allKeys = lastNDayKeys('UTC', 7, now);
  const pastKeys = allKeys.filter((k) => k !== localDayKey(now, 'UTC'));

  const a = await seedOrgScenario();
  await rebuildDaysForOrg(a.orgId, pastKeys, { now });

  const b = await seedOrgScenario(); // identical data, DIFFERENT org
  await rebuildDaysForOrg(b.orgId, pastKeys, { now });
  // Add an extra unproductive block to B today so A and B genuinely differ.
  await db.activity.create({
    data: { employeeId: b.empId, type: 'application', title: 'Game', applicationName: 'game.exe', category: 'unproductive', duration: 999999, timestamp: dayOffsetUtc(0), createdAt: dayOffsetUtc(0) },
  });

  const c = await freshOrg('Empty');

  const dataA = await dashboardData(a.token);
  const dataB = await dashboardData(b.token);
  const dataC = await dashboardData(c.token);

  assertScenarioDashboard(dataA);
  assert.notEqual(dataB.productivityScore, dataA.productivityScore, 'org B differs from org A');
  assert.equal(dataC.avgProductivity, 0, 'empty org has no fabricated productivity');
  assert.equal(dataC.productivityScore, 0);
  assert.equal(dataC.topEmployees.length, 0);
  assert.equal(dataC.dailyProductivity.length, 7);
  for (const bucket of dataC.dailyProductivity) {
    assert.deepEqual([bucket.productive, bucket.neutral, bucket.unproductive], [0, 0, 0]);
  }
});
