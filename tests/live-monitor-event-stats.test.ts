/**
 * Live Monitor — Event Stats (LM-P2-2) regression tests.
 *
 * GET /api/live-monitor/event-stats is the authoritative, DB-backed source
 * for the Event Stats card. These tests prove:
 *   - counts come from org-scoped DB aggregations (never the 80-event log)
 *   - tenant isolation (ORG A never sees ORG B counts)
 *   - time-window semantics (today / 24h / 7d)
 *   - >80 events are fully counted (no 80-cap)
 *   - reload persistence (same DB → same counts)
 *   - new events are reflected after refetch
 *   - invalid range -> 400, unauthenticated -> 401
 *   - org-less super_admin receives zeros, never global data
 *
 * Runs against a THROWAWAY PostgreSQL database (workai_test_eventstats).
 * Run: npx tsx --test tests/live-monitor-event-stats.test.ts
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';
import { NextRequest } from 'next/server';

// ─── Test DB isolation (must be set BEFORE any app module import) ──────────
const PG_TEST_BASE = process.env.PG_TEST_BASE_URL || 'postgresql://postgres:123456@localhost:5432';
const TEST_DB_NAME = 'workai_test_eventstats';
const TEST_DB_URL = `${PG_TEST_BASE}/${TEST_DB_NAME}?schema=public`;

process.env.DATABASE_URL = TEST_DB_URL;
process.env.DIRECT_URL = TEST_DB_URL;
process.env.JWT_SECRET = 'test-jwt-secret-eventstats-0123456789abcdef';
process.env.SUPER_ADMIN_EMAIL = 'admin@test.local';
process.env.SUPER_ADMIN_PASSWORD = 'test-password-123';

before(() => {
  if (process.env.EVENTSTATS_TEST_MIGRATED_DB !== '1') {
    execSync(`node scripts/pg-test-db.mjs ensure ${TEST_DB_NAME}`, {
      env: { ...process.env, PG_TEST_BASE_URL: PG_TEST_BASE },
      stdio: 'pipe',
    });
    execSync('npx prisma db push --force-reset --accept-data-loss --skip-generate', {
      env: { ...process.env, DATABASE_URL: TEST_DB_URL },
      stdio: 'pipe',
    });
  }
});

type DbModule = typeof import('../src/lib/db');
let db: DbModule['db'];
let signJWT: (payload: { userId: string; email: string; role: string; organizationId?: string }) => Promise<string>;
type EventStatsApi = typeof import('../src/app/api/live-monitor/event-stats/route');
let eventStatsApi: EventStatsApi;

const DAY_MS = 24 * 60 * 60 * 1000;

function req(token: string | null, url: string): NextRequest {
  const headers: Record<string, string> = {};
  if (token) headers['authorization'] = `Bearer ${token}`;
  return new NextRequest(new URL(url, 'http://localhost:3000'), { headers });
}

async function getStats(token: string, range = 'today') {
  const res = await eventStatsApi.GET(req(token, `/api/live-monitor/event-stats?range=${range}`));
  const json = await res.json();
  return { status: res.status, json };
}

before(async () => {
  const dbModule = await import('../src/lib/db');
  db = dbModule.db;
  signJWT = (await import('../src/lib/auth')).signJWT;
  eventStatsApi = await import('../src/app/api/live-monitor/event-stats/route');
});

after(async () => {
  await db.$disconnect();
  if (process.env.EVENTSTATS_TEST_MIGRATED_DB !== '1') {
    try {
      execSync(`node scripts/pg-test-db.mjs drop ${TEST_DB_NAME}`, {
        env: { ...process.env, PG_TEST_BASE_URL: PG_TEST_BASE },
        stdio: 'pipe',
      });
    } catch {
      /* best-effort cleanup */
    }
  }
});

let orgAId: string;
let orgBId: string;
let empAId: string;
let empBId: string;
let tokenA: string;
let tokenB: string;

test('ES-00: seed ORG A + ORG B with known event counts', async () => {
  orgAId = (await db.organization.create({ data: { name: 'ES ORG A', slug: 'es-org-a', status: 'active' } })).id;
  orgBId = (await db.organization.create({ data: { name: 'ES ORG B', slug: 'es-org-b', status: 'active' } })).id;
  empAId = (await db.employee.create({ data: { employeeId: 'ES-EMP-A', firstName: 'A', lastName: 'One', email: 'es-a@example.com', organizationId: orgAId } })).id;
  empBId = (await db.employee.create({ data: { employeeId: 'ES-EMP-B', firstName: 'B', lastName: 'Two', email: 'es-b@example.com', organizationId: orgBId } })).id;

  tokenA = await signJWT({ userId: 'u-a', email: 'admin-a@example.com', role: 'admin', organizationId: orgAId });
  tokenB = await signJWT({ userId: 'u-b', email: 'admin-b@example.com', role: 'admin', organizationId: orgBId });

  // ORG A events (all within the last hour): 3 activities, 2 notifications,
  // 1 screenshot, 1 registration, 1 usb, 1 break activity, 1 device updated,
  // 1 guest enrollment.
  const now = new Date();
  for (let i = 0; i < 3; i++) {
    await db.activity.create({ data: { employeeId: empAId, type: 'application', title: `ES-act-${i}`, applicationName: `ES-app-${i}`, category: 'neutral', duration: 5, timestamp: now, createdAt: now } });
  }
  await db.activity.create({ data: { employeeId: empAId, type: 'application', title: 'Break Mode Started', applicationName: 'WorkLensAI Agent', category: 'neutral', duration: 1, timestamp: now, createdAt: now } });
  await db.notification.create({ data: { title: 'ES-notif-1', message: 'm', type: 'system', organizationId: orgAId, createdAt: now } });
  await db.notification.create({ data: { title: 'ES-notif-2', message: 'm', type: 'system', organizationId: orgAId, createdAt: now } });
  await db.screenshot.create({ data: { employeeId: empAId, filePath: 'es.png', fileName: 'es.png', fileSize: 1, organizationId: orgAId, capturedAt: now, createdAt: now } });
  await db.agentRegistration.create({ data: { employeeId: empAId, hostname: 'es-host', organizationId: orgAId, createdAt: now } });
  await db.usbEvent.create({ data: { eventType: 'usb_insert', organizationId: orgAId, employeeId: empAId, createdAt: now } });
  await db.device.create({ data: { name: 'ES-device-A', organizationId: orgAId, employeeId: empAId, status: 'online', updatedAt: now } });
  const guestDevice = await db.device.create({ data: { name: 'ES-guest-device', organizationId: orgAId, status: 'online', updatedAt: now } });
  await db.guest.create({ data: { organizationId: orgAId, deviceId: guestDevice.id, employeeId: empAId, status: 'PENDING', createdAt: now } });

  // ORG B events: 1 activity only.
  await db.activity.create({ data: { employeeId: empBId, type: 'application', title: 'ES-B-act', applicationName: 'B', category: 'neutral', duration: 5, timestamp: now, createdAt: now } });

  // ORG A old event (10 days ago — outside 7d window).
  const old = new Date(now.getTime() - 10 * DAY_MS);
  await db.activity.create({ data: { employeeId: empAId, type: 'application', title: 'ES-old', applicationName: 'old', category: 'neutral', duration: 5, timestamp: old, createdAt: old } });

  // ORG A device updated 10 days ago (excluded from all windows).
  await db.device.create({ data: { name: 'ES-device-old', organizationId: orgAId, employeeId: empAId, status: 'offline', updatedAt: old } });
});

test('ES-01: unauthenticated -> 401', async () => {
  const res = await eventStatsApi.GET(req(null, '/api/live-monitor/event-stats'));
  assert.equal(res.status, 401);
});

test('ES-02: invalid range -> 400', async () => {
  const { status } = await getStats(tokenA, 'decade');
  assert.equal(status, 400);
});

test('ES-03: org A sees exactly its own counts (today)', async () => {
  const { status, json } = await getStats(tokenA, 'today');
  assert.equal(status, 200);
  // activities = 3 app/website + 1 break = 4; break counted separately.
  assert.equal(json.data.counts.activity, 3, 'app/website activities');
  assert.equal(json.data.counts.break, 1, 'break activities');
  assert.equal(json.data.counts.notifications, 2);
  assert.equal(json.data.counts.screenshot, 1);
  assert.equal(json.data.counts.registration, 1);
  assert.equal(json.data.counts.usb, 1);
  assert.equal(json.data.counts.guest, 1, 'guest enrollments counted under their own stat (P3-2)');
  // Two devices were created at `now` (ES-device-A + the guest's device).
  assert.equal(json.data.counts.devices, 2, 'devices updated in window');
  assert.equal(json.data.counts.total, 3 + 1 + 2 + 1 + 1 + 1 + 2 + 1);
});

test('ES-04: tenant isolation — org B sees only its own counts', async () => {
  const { json } = await getStats(tokenB, 'today');
  assert.equal(json.data.counts.activity, 1, 'org B activity only');
  assert.equal(json.data.counts.notifications, 0);
  assert.equal(json.data.counts.screenshot, 0);
  assert.equal(json.data.counts.registration, 0);
  assert.equal(json.data.counts.usb, 0);
  assert.equal(json.data.counts.guest, 0, 'org B has no guests');
  assert.equal(json.data.counts.devices, 0);
  assert.equal(json.data.counts.total, 1);
});

test('ES-05: 7d window includes old in-window rows but not 10-day-old', async () => {
  const { json } = await getStats(tokenA, '7d');
  // today's 4 activities + the 10-day-old one is OUTSIDE 7d => still 4.
  assert.equal(json.data.counts.activity, 3, '7d app/website (10-day-old excluded)');
  assert.equal(json.data.counts.break, 1);
  // Three devices exist: two updated now, one 10 days ago => 7d sees the two.
  assert.equal(json.data.counts.devices, 2);
});

test('ES-06: 24h window equals today for freshly-created data', async () => {
  const { json } = await getStats(tokenA, '24h');
  assert.equal(json.data.counts.activity, 3);
  assert.equal(json.data.counts.total, 12);
});

test('ES-07: >80 events are fully counted (no 80-cap)', async () => {
  const now = new Date();
  const bulk: { employeeId: string; type: string; title: string; applicationName: string; category: string; duration: number; timestamp: Date; createdAt: Date }[] = [];
  for (let i = 0; i < 85; i++) {
    bulk.push({ employeeId: empBId, type: 'website', title: `ES-bulk-${i}`, applicationName: null as unknown as string, category: 'neutral', duration: 1, timestamp: now, createdAt: now });
  }
  await db.activity.createMany({ data: bulk as never });
  const { json } = await getStats(tokenB, 'today');
  assert.equal(json.data.counts.activity, 1 + 85, '85 new + 1 seeded = 86, NOT capped at 80');
});

test('ES-08: reload persistence — same DB yields the same counts', async () => {
  const a = await getStats(tokenA, 'today');
  const b = await getStats(tokenA, 'today');
  assert.deepEqual(a.json.data.counts, b.json.data.counts);
});

test('ES-09: new event after load is reflected on next fetch', async () => {
  const beforeStats = await getStats(tokenA, 'today');
  const beforeTotal = beforeStats.json.data.counts.total;
  await db.notification.create({ data: { title: 'ES-late', message: 'm', type: 'system', organizationId: orgAId, createdAt: new Date() } });
  const afterStats = await getStats(tokenA, 'today');
  assert.equal(afterStats.json.data.counts.total, beforeTotal + 1);
  assert.equal(afterStats.json.data.counts.notifications, 3);
});

test('ES-10: org-less super_admin gets zeros, never global data', async () => {
  const globalToken = await signJWT({ userId: 'u-g', email: 'global@test.local', role: 'super_admin' });
  const { status, json } = await getStats(globalToken, 'today');
  assert.equal(status, 200);
  assert.equal(json.data.counts.total, 0);
  assert.equal(json.data.counts.activity, 0);
});

test('ES-11: viewer role can read (page min role)', async () => {
  const viewerToken = await signJWT({ userId: 'u-v', email: 'viewer@example.com', role: 'viewer', organizationId: orgAId });
  const { status } = await getStats(viewerToken, 'today');
  assert.equal(status, 200);
});
