/**
 * S-5 / S-6 — dashboard correctness.
 *
 * - onlineDevices uses the EFFECTIVE device status (a stale device that has
 *   missed ≥3 heartbeats must NOT count as online; stored status untouched).
 * - avgProductivity is limited to a trailing 7-day window.
 * - dailyProductivity buckets use the ORGANIZATION timezone: an activity at
 *   23:30 UTC lands on the NEXT local day in Asia/Dhaka (+06).
 *
 * Runs against a THROWAWAY PostgreSQL database (workai_test_admindash).
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';
import { NextRequest } from 'next/server';

const PG_TEST_BASE = process.env.PG_TEST_BASE_URL || 'postgresql://postgres:123456@localhost:5432';
const TEST_DB_NAME = 'workai_test_admindash';
const TEST_DB_URL = `${PG_TEST_BASE}/${TEST_DB_NAME}?schema=public`;

process.env.DATABASE_URL = TEST_DB_URL;
process.env.DIRECT_URL = TEST_DB_URL;
process.env.JWT_SECRET = 'test-jwt-secret-admindash-0123456789abcdef';
process.env.SUPER_ADMIN_EMAIL = 'root@admindash.local';
process.env.SUPER_ADMIN_PASSWORD = 'S3cure!AdminDash2026x';
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

let org: { id: string };
let emp: { id: string };
let deviceFresh: { id: string };
let deviceStale: { id: string };
let adminToken: string;

before(async () => {
  const dbModule = await import('../src/lib/db');
  db = dbModule.db;
  signJWT = (await import('../src/lib/auth')).signJWT;

  org = await db.organization.create({ data: { name: 'Dash Org', slug: 'dash-org', timezone: 'Asia/Dhaka' } });
  emp = await db.employee.create({
    data: {
      employeeId: 'DASH-EMP-1',
      firstName: 'Dash',
      lastName: 'Worker',
      email: 'dash@dash.test',
      organizationId: org.id,
      status: 'active',
      agentApproved: true,
    },
  });

  const now = new Date();
  deviceFresh = await db.device.create({
    data: { name: 'Fresh PC', hostname: 'PC-FRESH', agentKey: 'key-fresh', organizationId: org.id, employeeId: emp.id, status: 'online', lastHeartbeat: new Date(now.getTime() - 30_000) },
  });
  deviceStale = await db.device.create({
    data: { name: 'Stale PC', hostname: 'PC-STALE', agentKey: 'key-stale', organizationId: org.id, employeeId: emp.id, status: 'online', lastHeartbeat: new Date(now.getTime() - 600_000) }, // 10 min old > 180s threshold
  });
  await db.device.create({
    data: { name: 'Null HB PC', hostname: 'PC-NULLHB', agentKey: 'key-nullhb', organizationId: org.id, employeeId: emp.id, status: 'online', lastHeartbeat: null },
  });
  await db.device.create({
    data: { name: 'Offline PC', hostname: 'PC-OFF', agentKey: 'key-off', organizationId: org.id, employeeId: emp.id, status: 'offline', lastHeartbeat: new Date(now.getTime() - 60_000) },
  });

  // Windowed productive activity: 2 days ago at 23:30 UTC (= 05:30 the NEXT
  // local day in Asia/Dhaka). 1800s → 30 min.
  const lateUtc = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - 2, 23, 30, 0, 0));
  await db.activity.create({
    data: { employeeId: emp.id, type: 'application', applicationName: 'Code', category: 'productive', duration: 1800, timestamp: lateUtc, createdAt: lateUtc },
  });

  // Out-of-window activity (10 days ago) must be excluded from avgProductivity.
  const oldUtc = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - 10, 12, 0, 0, 0));
  await db.activity.create({
    data: { employeeId: emp.id, type: 'application', applicationName: 'Legacy', category: 'productive', duration: 3600, timestamp: oldUtc, createdAt: oldUtc },
  });

  adminToken = await signJWT({ userId: 'admin', email: 'admin@dash.test', role: 'admin', organizationId: org.id });
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

function req(token: string, url = 'http://localhost:3000/api/dashboard'): NextRequest {
  return new NextRequest(url, { headers: { authorization: `Bearer ${token}` } });
}

async function dashboard() {
  const api = await import('../src/app/api/dashboard/route');
  const res = await api.GET(req(adminToken));
  assert.equal(res.status, 200);
  const body = await res.json();
  return body.data as {
    totalEmployees: number;
    totalDevices: number;
    onlineDevices: number;
    avgProductivity: number;
    dailyProductivity: Array<{ date: string; productive: number; neutral: number; unproductive: number }>;
  };
}

test('DASH-1: stale device is NOT counted online; fresh + null-heartbeat devices ARE', async () => {
  const data = await dashboard();
  assert.equal(data.totalDevices, 4);
  // fresh (online) + null-heartbeat (keeps stored online) = 2; stale → offline; offline stays offline.
  assert.equal(data.onlineDevices, 2, 'stale device must not be counted online');
});

test('DASH-2: stored device status is never mutated for the calculation', async () => {
  await dashboard();
  const stored = await db.device.findUnique({ where: { id: deviceStale.id }, select: { status: true } });
  assert.equal(stored?.status, 'online', 'stored status column must stay untouched');
  const fresh = await db.device.findUnique({ where: { id: deviceFresh.id }, select: { status: true } });
  assert.equal(fresh?.status, 'online');
});

test('DASH-3: avgProductivity is limited to the trailing 7-day window', async () => {
  const data = await dashboard();
  // Only the 1800s activity (2 days ago) counts — the 3600s activity from 10
  // days ago must be excluded: 1800s / 1 employee / 3600 = 0.5 hours.
  assert.equal(data.avgProductivity, 0.5);
});

test('DASH-4: Asia/Dhaka local-day bucketing (23:30 UTC → next local day)', async () => {
  const { localDayKey } = await import('../src/lib/timezone');
  const now = new Date();
  const lateUtc = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - 2, 23, 30, 0, 0));

  const dhakaKey = localDayKey(lateUtc, 'Asia/Dhaka');
  const utcKey = localDayKey(lateUtc, 'UTC');
  assert.notEqual(dhakaKey, utcKey, '23:30 UTC is 05:30 the NEXT local day in Dhaka');

  const labelFor = (key: string): string => {
    const [y, m, d] = key.split('-').map(Number);
    return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'UTC' });
  };
  const dhakaLabel = labelFor(dhakaKey);
  const utcLabel = labelFor(utcKey);

  const data = await dashboard();
  const dhakaEntry = data.dailyProductivity.find((e) => e.date === dhakaLabel);
  const utcEntry = data.dailyProductivity.find((e) => e.date === utcLabel);

  assert.ok(dhakaEntry, `Dhaka-day bucket ${dhakaLabel} must exist`);
  assert.equal(dhakaEntry.productive, 30, '1800s activity must land in the Dhaka local-day bucket');
  assert.ok(utcEntry, `UTC-day bucket ${utcLabel} must exist`);
  assert.equal(utcEntry.productive, 0, 'activity at 23:30 UTC must NOT land in the UTC-day bucket');
  assert.equal(data.dailyProductivity.length, 7, 'exactly 7 daily buckets');
});

test('DASH-6: deviceStatusBreakdown uses the SAME effective status as onlineDevices (P2-4)', async () => {
  const api = await import('../src/app/api/dashboard/route');
  const res = await api.GET(req(adminToken));
  assert.equal(res.status, 200);
  const body = await res.json();
  const data = body.data as {
    totalDevices: number;
    onlineDevices: number;
    deviceStatusBreakdown: Array<{ status: string; _count: number }>;
  };

  // Breakdown must sum to totalDevices and agree with the KPI count.
  const breakdownTotal = data.deviceStatusBreakdown.reduce((s, d) => s + d._count, 0);
  assert.equal(breakdownTotal, data.totalDevices, 'breakdown sums to total devices');

  const onlineInBreakdown = data.deviceStatusBreakdown.find((d) => d.status === 'online')?._count ?? 0;
  assert.equal(onlineInBreakdown, data.onlineDevices, 'breakdown online count == onlineDevices KPI');

  // Fixture: fresh(online) + offline-with-fresh-hb(online) = 2 online;
  // stale + null-heartbeat = 2 offline. Stored column is 3×online/1×offline.
  const offlineInBreakdown = data.deviceStatusBreakdown.find((d) => d.status === 'offline')?._count ?? 0;
  assert.equal(onlineInBreakdown, 2);
  assert.equal(offlineInBreakdown, 2);
  assert.equal(data.deviceStatusBreakdown.find((d) => d.status === 'online')?._count, 2);
  // The stored-status groupBy (the pre-fix behavior) would have said online=3.
  assert.notEqual(onlineInBreakdown, 3, 'stale stored-online device must not appear as online');
});

test('DASH-5: pure timezone helpers (UTC/local-day boundary + validation)', async () => {
  const { localDayKey, lastNDayKeys, isValidTimezone } = await import('../src/lib/timezone');

  // Boundary: 2026-08-11T23:30:00Z → UTC day 11, Dhaka day 12.
  const ts = new Date('2026-08-11T23:30:00Z');
  assert.equal(localDayKey(ts, 'UTC'), '2026-08-11');
  assert.equal(localDayKey(ts, 'Asia/Dhaka'), '2026-08-12');

  // lastNDayKeys: exactly n distinct, ascending, ending today.
  const keys = lastNDayKeys('Asia/Dhaka', 7);
  assert.equal(keys.length, 7);
  assert.equal(new Set(keys).size, 7);
  assert.equal(keys[6], localDayKey(new Date(), 'Asia/Dhaka'), 'newest bucket is today');

  // Validation.
  assert.equal(isValidTimezone('Asia/Dhaka'), true);
  assert.equal(isValidTimezone('UTC'), true);
  assert.equal(isValidTimezone('America/New_York'), true);
  assert.equal(isValidTimezone('Nope/Zzz'), false);
  assert.equal(isValidTimezone(''), false);
});
