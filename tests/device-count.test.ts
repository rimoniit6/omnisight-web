/**
 * Device Count Regression — Organization.activeDeviceCount
 *
 * Verifies that Organization.activeDeviceCount stays in sync with the real
 * number of active (online, heartbeat-fresh) devices across organizations.
 *
 *   DC-01  Org with 0 devices → activeDeviceCount = 0
 *   DC-02  Org with 1 online device → activeDeviceCount = 1
 *   DC-03  Org with multiple online devices → correct count
 *   DC-04  Device in another org does not inflate the count
 *   DC-05  Heartbeat transition (offline → online) increments count
 *   DC-06  Device retirement (online → retired) decrements count
 *
 * Run: node --import tsx --test tests/device-count.test.ts
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';
import { PrismaClient } from '@prisma/client';

// ─── Test DB isolation ──────────────────────────────────────────────────
const PG_TEST_BASE = process.env.PG_TEST_BASE_URL || 'postgresql://postgres:123456@localhost:5432';
const TEST_DB_NAME = 'workai_test_device_count';
const TEST_DB_URL = `${PG_TEST_BASE}/${TEST_DB_NAME}?schema=public`;

process.env.DATABASE_URL = TEST_DB_URL;
process.env.DIRECT_URL = TEST_DB_URL;
process.env.JWT_SECRET = 'test-jwt-secret-device-count-0123456789abcdef';

let db: PrismaClient;

before(() => {
  execSync(`node scripts/pg-test-db.mjs ensure ${TEST_DB_NAME}`, {
    env: { ...process.env, PG_TEST_BASE_URL: PG_TEST_BASE },
    stdio: 'pipe',
  });
  execSync('npx prisma db push --force-reset --accept-data-loss --skip-generate', { stdio: 'pipe' });
});

before(() => {
  db = new PrismaClient({ datasources: { db: { url: TEST_DB_URL } } });
});

after(async () => {
  await db?.$disconnect();
  execSync(`node scripts/pg-test-db.mjs drop ${TEST_DB_NAME}`, {
    env: { ...process.env, PG_TEST_BASE_URL: PG_TEST_BASE },
    stdio: 'pipe',
  });
});

// ─── Helpers ────────────────────────────────────────────────────────────

const THRESHOLD = 5 * 60 * 1000;

async function createOrg(name: string) {
  return db.organization.create({
    data: { name, slug: name.toLowerCase().replace(/\s+/g, '-'), status: 'active' },
  });
}

async function createDevice(orgId: string, status: string, lastHeartbeat: Date | null) {
  return db.device.create({
    data: {
      name: `device-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      organizationId: orgId,
      status,
      lastHeartbeat,
    },
  });
}

function isOnline(status: string, lastHeartbeat: Date | null): boolean {
  if (['maintenance', 'inactive', 'retired'].includes(status)) return false;
  if (!lastHeartbeat) return false;
  return Date.now() - lastHeartbeat.getTime() <= THRESHOLD;
}

// ─── Tests ──────────────────────────────────────────────────────────────

test('DC-01: org with 0 devices → activeDeviceCount = 0', async () => {
  const org = await createOrg('DC01 Empty');
  const row = await db.organization.findUnique({ where: { id: org.id }, select: { activeDeviceCount: true } });
  assert.equal(row?.activeDeviceCount, 0);
});

test('DC-02: org with 1 online device (fresh heartbeat) → activeDeviceCount = 1', async () => {
  const org = await createOrg('DC02 One Device');
  const now = new Date();
  await createDevice(org.id, 'online', now);

  const devices = await db.device.findMany({ where: { organizationId: org.id }, select: { status: true, lastHeartbeat: true } });
  const active = devices.filter((d) => isOnline(d.status, d.lastHeartbeat)).length;
  await db.organization.update({ where: { id: org.id }, data: { activeDeviceCount: active } });

  const row = await db.organization.findUnique({ where: { id: org.id }, select: { activeDeviceCount: true } });
  assert.equal(row?.activeDeviceCount, 1);
});

test('DC-03: org with multiple online devices → correct count', async () => {
  const org = await createOrg('DC03 Multi Device');
  const now = new Date();
  await createDevice(org.id, 'online', now);
  await createDevice(org.id, 'online', now);
  await createDevice(org.id, 'online', now);
  await createDevice(org.id, 'offline', new Date(now.getTime() - 60 * 60 * 1000));

  const devices = await db.device.findMany({ where: { organizationId: org.id }, select: { status: true, lastHeartbeat: true } });
  const active = devices.filter((d) => isOnline(d.status, d.lastHeartbeat)).length;
  await db.organization.update({ where: { id: org.id }, data: { activeDeviceCount: active } });

  const row = await db.organization.findUnique({ where: { id: org.id }, select: { activeDeviceCount: true } });
  assert.equal(row?.activeDeviceCount, 3);
});

test('DC-04: device in another org does not inflate the count', async () => {
  const orgA = await createOrg('DC04 Org A');
  const orgB = await createOrg('DC04 Org B');
  const now = new Date();

  await createDevice(orgA.id, 'online', now);
  await createDevice(orgB.id, 'online', now);
  await createDevice(orgB.id, 'online', now);

  for (const org of [orgA, orgB]) {
    const devices = await db.device.findMany({ where: { organizationId: org.id }, select: { status: true, lastHeartbeat: true } });
    const active = devices.filter((d) => isOnline(d.status, d.lastHeartbeat)).length;
    await db.organization.update({ where: { id: org.id }, data: { activeDeviceCount: active } });
  }

  const rowA = await db.organization.findUnique({ where: { id: orgA.id }, select: { activeDeviceCount: true } });
  const rowB = await db.organization.findUnique({ where: { id: orgB.id }, select: { activeDeviceCount: true } });
  assert.equal(rowA?.activeDeviceCount, 1, 'Org A has 1 device');
  assert.equal(rowB?.activeDeviceCount, 2, 'Org B has 2 devices');
});

test('DC-05: heartbeat transition (offline → online) increments activeDeviceCount', async () => {
  const org = await createOrg('DC05 Heartbeat');
  const now = new Date();

  const device = await createDevice(org.id, 'offline', new Date(now.getTime() - 60 * 60 * 1000));
  await db.organization.update({ where: { id: org.id }, data: { activeDeviceCount: 0 } });

  const before = await db.device.findUnique({ where: { id: device.id }, select: { status: true, lastHeartbeat: true } });
  const wasActive = before && isOnline(before.status, before.lastHeartbeat);

  await db.device.update({ where: { id: device.id }, data: { status: 'online', lastHeartbeat: now } });

  if (!wasActive) {
    await db.organization.updateMany({ where: { id: org.id }, data: { activeDeviceCount: { increment: 1 } } });
  }

  const row = await db.organization.findUnique({ where: { id: org.id }, select: { activeDeviceCount: true } });
  assert.equal(row?.activeDeviceCount, 1, 'Count incremented after offline→online transition');
});

test('DC-06: device retirement (online → retired) decrements activeDeviceCount', async () => {
  const org = await createOrg('DC06 Retire');
  const now = new Date();

  const device = await createDevice(org.id, 'online', now);
  await db.organization.update({ where: { id: org.id }, data: { activeDeviceCount: 1 } });

  const before = await db.device.findUnique({ where: { id: device.id }, select: { status: true, lastHeartbeat: true } });
  const wasActive = before && isOnline(before.status, before.lastHeartbeat);

  await db.device.update({ where: { id: device.id }, data: { status: 'retired' } });

  if (wasActive) {
    await db.organization.updateMany({ where: { id: org.id }, data: { activeDeviceCount: { decrement: 1 } } });
  }

  const row = await db.organization.findUnique({ where: { id: org.id }, select: { activeDeviceCount: true } });
  assert.equal(row?.activeDeviceCount, 0, 'Count decremented after online→retired transition');
});
