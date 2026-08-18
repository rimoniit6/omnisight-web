/**
 * Presence-hardening regression tests (final audit pass).
 *
 * Proves the centralized live-status semantics end-to-end at the API layer:
 *   - Every read path that answers "is this device online right now?" uses
 *     heartbeat freshness (presence threshold), never the sticky Device.status.
 *   - Lifecycle statuses (maintenance/inactive/retired) stay pinned.
 *   - Org isolation is preserved on every touched surface (foreign 404s).
 *   - The employees list carries lastHeartbeat so the UI can derive live
 *     presence client-side.
 *
 * Runs against a THROWAWAY PostgreSQL database (workai_test_presence_hardening).
 * Run: npx tsx --test tests/presence-hardening.test.ts
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';
import { NextRequest } from 'next/server';
import { EMPLOYEE_ONLINE_THRESHOLD_MS } from '../src/lib/presence';

// ─── Test DB isolation (set BEFORE any app module import) ──────────────────
const PG_TEST_BASE = process.env.PG_TEST_BASE_URL || 'postgresql://postgres:123456@localhost:5432';
const TEST_DB_NAME = 'workai_test_presence_hardening';
const TEST_DB_URL = `${PG_TEST_BASE}/${TEST_DB_NAME}?schema=public`;

process.env.DATABASE_URL = TEST_DB_URL;
process.env.DIRECT_URL = TEST_DB_URL;
process.env.JWT_SECRET = 'test-jwt-secret-presence-hardening-0123456789';
process.env.SUPER_ADMIN_EMAIL = 'root@ph.local';
process.env.SUPER_ADMIN_PASSWORD = 'S3cure!PH2026x';
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

let orgA: { id: string };
let orgB: { id: string };

// A1: fresh device (online). A2: stale device (heartbeat far older than the
// threshold, stored status still 'online'). A3: maintenance-pinned device.
// A4: no device at all. B1: fresh device in another org.
let empA1: { id: string };
let empA2: { id: string };
let empA3: { id: string };
let empA4: { id: string };
let empB1: { id: string };

let adminAToken: string;
let adminBToken: string;

const FRESH = new Date(Date.now() - 10_000);
const STALE = new Date(Date.now() - EMPLOYEE_ONLINE_THRESHOLD_MS - 60_000);

before(async () => {
  const dbModule = await import('../src/lib/db');
  db = dbModule.db;
  signJWT = (await import('../src/lib/auth')).signJWT;

  orgA = await db.organization.create({ data: { name: 'PH Org A', slug: 'ph-org-a' } });
  orgB = await db.organization.create({ data: { name: 'PH Org B', slug: 'ph-org-b' } });

  empA1 = await db.employee.create({ data: { employeeId: 'PH-A1', firstName: 'Fresh', lastName: 'One', email: 'a1@ph.test', organizationId: orgA.id, status: 'active', agentApproved: true } });
  empA2 = await db.employee.create({ data: { employeeId: 'PH-A2', firstName: 'Stale', lastName: 'Two', email: 'a2@ph.test', organizationId: orgA.id, status: 'active', agentApproved: true } });
  empA3 = await db.employee.create({ data: { employeeId: 'PH-A3', firstName: 'Maint', lastName: 'Three', email: 'a3@ph.test', organizationId: orgA.id, status: 'active', agentApproved: true } });
  empA4 = await db.employee.create({ data: { employeeId: 'PH-A4', firstName: 'None', lastName: 'Four', email: 'a4@ph.test', organizationId: orgA.id, status: 'active', agentApproved: true } });
  empB1 = await db.employee.create({ data: { employeeId: 'PH-B1', firstName: 'Foreign', lastName: 'One', email: 'b1@ph.test', organizationId: orgB.id, status: 'active', agentApproved: true } });

  await db.device.create({ data: { name: 'PC-A1', hostname: 'pc-a1', agentKey: 'key-ph-a1', organizationId: orgA.id, employeeId: empA1.id, status: 'online', lastHeartbeat: FRESH } });
  // Sticky status 'online' but heartbeat long gone — the classic dead-agent row.
  await db.device.create({ data: { name: 'PC-A2', hostname: 'pc-a2', agentKey: 'key-ph-a2', organizationId: orgA.id, employeeId: empA2.id, status: 'online', lastHeartbeat: STALE } });
  await db.device.create({ data: { name: 'PC-A3', hostname: 'pc-a3', agentKey: 'key-ph-a3', organizationId: orgA.id, employeeId: empA3.id, status: 'maintenance', lastHeartbeat: STALE } });
  await db.device.create({ data: { name: 'PC-A1N', hostname: 'pc-a1n', agentKey: 'key-ph-a1n', organizationId: orgA.id, employeeId: empA1.id, status: 'online', lastHeartbeat: null } });
  await db.device.create({ data: { name: 'PC-B1', hostname: 'pc-b1', agentKey: 'key-ph-b1', organizationId: orgB.id, employeeId: empB1.id, status: 'online', lastHeartbeat: FRESH } });

  adminAToken = await signJWT({ userId: 'ph-admin-a', email: 'admin@ph-a.test', role: 'admin', organizationId: orgA.id });
  adminBToken = await signJWT({ userId: 'ph-admin-b', email: 'admin@ph-b.test', role: 'admin', organizationId: orgB.id });
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

function req(token: string | null, opts: { method?: string; body?: unknown; url?: string } = {}): NextRequest {
  const headers: Record<string, string> = {};
  if (token) headers['authorization'] = `Bearer ${token}`;
  if (opts.body !== undefined) headers['content-type'] = 'application/json';
  return new NextRequest(opts.url || 'http://localhost:3000/api/test', {
    method: opts.method || 'GET',
    headers,
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });
}

async function devicesAll(token: string): Promise<Array<{ id: string; name: string; status: string; lastHeartbeat: string | null }>> {
  const api = await import('../src/app/api/devices/route');
  const res = await api.GET(req(token, { url: `http://localhost:3000/api/devices?pageSize=50` }));
  assert.equal(res.status, 200);
  const body = await res.json();
  return body.data as Array<{ id: string; name: string; status: string; lastHeartbeat: string | null }>;
}

// ─── 1–3: devices list / detail / summary — effective live status ──────────

test('PH-01: devices list — fresh reads online, sticky-stale reads offline, maintenance pinned, null heartbeat offline', async () => {
  const devices = await devicesAll(adminAToken);
  const byName = new Map(devices.map((d) => [d.name, d]));
  assert.equal(byName.get('PC-A1')?.status, 'online');
  assert.equal(byName.get('PC-A2')?.status, 'offline');
  assert.equal(byName.get('PC-A3')?.status, 'maintenance');
  assert.equal(byName.get('PC-A1N')?.status, 'offline');
});

test('PH-02: devices list — foreign devices never leak into another org', async () => {
  const devicesA = await devicesAll(adminAToken);
  const devicesB = await devicesAll(adminBToken);
  assert.ok(!devicesA.some((d) => d.name === 'PC-B1'));
  assert.ok(devicesB.some((d) => d.name === 'PC-B1'));
});

test('PH-03: device summary counts by effective status (no sticky inflation)', async () => {
  const api = await import('../src/app/api/devices/summary/route');
  const res = await api.GET(req(adminAToken, { url: 'http://localhost:3000/api/devices/summary' }));
  const body = await res.json();
  assert.equal(body.total, 4); // org A devices only
  assert.equal(body.online, 1); // PC-A1 only — PC-A1N (null) and PC-A2 (stale) excluded
  assert.equal(body.offline, 2); // PC-A2 + PC-A1N
  assert.equal(body.maintenance, 1);
});

test('PH-04: device detail — stale device reads offline; cross-org id is 404', async () => {
  const api = await import('../src/app/api/devices/[id]/route');
  const staleDev = (await devicesAll(adminAToken)).find((d) => d.name === 'PC-A2')!;
  const res = await api.GET(req(adminAToken, { url: `http://localhost:3000/api/devices/${staleDev.id}` }), { params: Promise.resolve({ id: staleDev.id }) });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.data.status, 'offline');

  const foreignDev = (await devicesAll(adminBToken)).find((d) => d.name === 'PC-B1')!;
  const cross = await api.GET(req(adminAToken, { url: `http://localhost:3000/api/devices/${foreignDev.id}` }), { params: Promise.resolve({ id: foreignDev.id }) });
  assert.equal(cross.status, 404);
});

// ─── 4–7: employees list — live device filter + lastHeartbeat include ──────

async function employeesByDeviceFilter(token: string, deviceStatus: string): Promise<Array<{ id: string }>> {
  const api = await import('../src/app/api/employees/route');
  const res = await api.GET(req(token, { url: `http://localhost:3000/api/employees?status=active&deviceStatus=${deviceStatus}&pageSize=50` }));
  assert.equal(res.status, 200);
  const body = await res.json();
  return body.data as Array<{ id: string }>;
}

test('PH-05: employees online filter — only heartbeat-fresh devices count', async () => {
  const ids = await employeesByDeviceFilter(adminAToken, 'online');
  assert.ok(ids.some((e) => e.id === empA1.id));
  assert.ok(!ids.some((e) => e.id === empA2.id), 'stale-only employee must not match online');
  assert.ok(!ids.some((e) => e.id === empA3.id), 'maintenance-only employee must not match online');
  assert.ok(!ids.some((e) => e.id === empA4.id), 'no-device employee must not match online');
  assert.ok(!ids.some((e) => e.id === empB1.id), 'foreign employee must not match');
});

test('PH-06: employees offline filter — stale-only employees match, fresh do not', async () => {
  const ids = await employeesByDeviceFilter(adminAToken, 'offline');
  assert.ok(ids.some((e) => e.id === empA2.id), 'stale-only employee matches offline');
  assert.ok(!ids.some((e) => e.id === empA1.id), 'fresh employee must not match offline');
  assert.ok(!ids.some((e) => e.id === empA4.id), 'no-device employee is not offline (has no devices)');
});

test('PH-07: employees no_device filter still works', async () => {
  const ids = await employeesByDeviceFilter(adminAToken, 'no_device');
  assert.ok(ids.some((e) => e.id === empA4.id));
  assert.ok(!ids.some((e) => e.id === empA1.id));
});

test('PH-08: employees list include carries lastHeartbeat for client-side presence', async () => {
  const api = await import('../src/app/api/employees/route');
  const res = await api.GET(req(adminAToken, { url: `http://localhost:3000/api/employees?status=active&pageSize=50` }));
  assert.equal(res.status, 200);
  const body = await res.json();
  const emp = (body.data as Array<{ id: string; devices: Array<{ lastHeartbeat: string | null }> }>).find((e) => e.id === empA1.id);
  assert.ok(emp, 'employee present');
  assert.ok(emp.devices.some((d) => d.lastHeartbeat !== null), 'fresh device exposes its lastHeartbeat');
});

// ─── 8: webcam status — effective device status + cross-org 404 ────────────

test('PH-09: webcam status — fresh device online, sticky-stale device offline, foreign employee 404', async () => {
  const api = await import('../src/app/api/employees/[id]/webcam/route');
  const res = await api.GET(req(adminAToken, { url: `http://localhost:3000/api/employees/${empA1.id}/webcam` }), { params: Promise.resolve({ id: empA1.id }) });
  assert.equal(res.status, 200);
  let body = await res.json();
  const freshStatus = (body.devices as Array<{ name: string; status: string }>).find((d) => d.name === 'PC-A1')!.status;
  assert.equal(freshStatus, 'online');

  const res2 = await api.GET(req(adminAToken, { url: `http://localhost:3000/api/employees/${empA2.id}/webcam` }), { params: Promise.resolve({ id: empA2.id }) });
  assert.equal(res2.status, 200);
  body = await res2.json();
  const staleStatus = (body.devices as Array<{ name: string; status: string }>).find((d) => d.name === 'PC-A2')!.status;
  assert.equal(staleStatus, 'offline', 'a dead agent device must read offline for webcam gating');

  // Maintenance-pinned device stays maintenance (admin intent, not liveness).
  const res3 = await api.GET(req(adminAToken, { url: `http://localhost:3000/api/employees/${empA3.id}/webcam` }), { params: Promise.resolve({ id: empA3.id }) });
  body = await res3.json();
  const maintStatus = (body.devices as Array<{ name: string; status: string }>).find((d) => d.name === 'PC-A3')!.status;
  assert.equal(maintStatus, 'maintenance');

  // Cross-org employee id is concealed with 404.
  const cross = await api.GET(req(adminAToken, { url: `http://localhost:3000/api/employees/${empB1.id}/webcam` }), { params: Promise.resolve({ id: empB1.id }) });
  assert.equal(cross.status, 404);
});

// ─── 9: break-status device attribution ────────────────────────────────────

test('PH-10: break-status attributes only a LIVE (fresh-heartbeat) device', async () => {
  const api = await import('../src/app/api/break-status/route');
  const res = await api.GET(req(adminAToken, { url: 'http://localhost:3000/api/break-status?pageSize=50' }));
  assert.equal(res.status, 200);
  const body = await res.json();
  const rows = body.data as Array<{ id: string; device: { id: string } | null }>;
  const fresh = rows.find((r) => r.id === empA1.id);
  const stale = rows.find((r) => r.id === empA2.id);
  assert.ok(fresh?.device, 'fresh employee has an attributed device');
  assert.equal(stale?.device, null, 'dead-agent employee must not be attributed a device');
});

// ─── 11–16: reports / insights / charts — heartbeat freshness everywhere ────
// Regression coverage for the sticky-status sweep: every read-side "online"
// count on the reporting surface must derive from heartbeat freshness, never
// the sticky Device.status column (PC-A2 has stored status 'online' but its
// agent is dead; PC-A1N has stored 'online' but no heartbeat at all).

test('PH-11: daily report — onlineDevices counts heartbeat-fresh devices only', async () => {
  const api = await import('../src/app/api/reports/daily/route');
  const res = await api.POST(req(adminAToken, {
    method: 'POST',
    url: 'http://localhost:3000/api/reports/daily',
    body: { date: new Date().toISOString().slice(0, 10) },
  }));
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.summary.onlineDevices, 1, 'sticky-online rows must NOT inflate the count');
});

test('PH-12: report generate (device) — effective online/offline summary', async () => {
  const api = await import('../src/app/api/reports/generate/route');
  const res = await api.POST(req(adminAToken, {
    method: 'POST',
    url: 'http://localhost:3000/api/reports/generate',
    body: {
      type: 'device',
      periodStart: new Date(Date.now() - 7 * 24 * 3600_000).toISOString(),
      periodEnd: new Date().toISOString(),
    },
  }));
  assert.equal(res.status, 201);
  const body = await res.json();
  const reportData = JSON.parse(body.data.data) as {
    summary: { totalDevices: number; onlineCount: number; offlineCount: number; onlineRatio: number };
  };
  assert.equal(reportData.summary.totalDevices, 4);
  assert.equal(reportData.summary.onlineCount, 1, 'only PC-A1 is live');
  assert.equal(reportData.summary.offlineCount, 2, 'PC-A2 (stale) + PC-A1N (no heartbeat)');
  assert.equal(reportData.summary.onlineRatio, 25);
});

test('PH-13: report [id]/pdf (device) — summary stats from freshness', async () => {
  const created = await db.report.create({
    data: {
      title: 'PH Device Report',
      type: 'device',
      format: 'html',
      status: 'generated',
      organizationId: orgA.id,
      periodStart: new Date(Date.now() - 30 * 24 * 3600_000),
      periodEnd: new Date(),
      data: JSON.stringify({}),
      generatedBy: 'ph-admin-a',
    },
  });
  const api = await import('../src/app/api/reports/[id]/pdf/route');
  const res = await api.GET(
    req(adminAToken, { url: `http://localhost:3000/api/reports/${created.id}/pdf` }),
    { params: Promise.resolve({ id: created.id }) }
  );
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.data.summaryStats['Online Devices'], 1);
  assert.equal(body.data.summaryStats['Offline Devices'], 2);
  assert.equal(body.data.summaryStats['Online Rate'], '25%');
  assert.ok(body.data.htmlContent.includes('>offline<'), 'per-device row renders effective status');
});

test('PH-14: device chart-data — counts and reliability from freshness', async () => {
  const api = await import('../src/app/api/devices/chart-data/route');
  const res = await api.GET(req(adminAToken, { url: 'http://localhost:3000/api/devices/chart-data' }));
  assert.equal(res.status, 200);
  const body = await res.json();
  const byStatus = new Map((body.statusCounts as Array<{ status: string; count: number }>).map((s) => [s.status, s.count]));
  assert.equal(byStatus.get('Online'), 1);
  assert.equal(byStatus.get('Offline'), 2);
  assert.equal(byStatus.get('Maintenance'), 1);
  assert.equal(body.uptime.percentage, 25);
  assert.equal(body.uptime.mostReliableDevice, 'PC-A1');
  assert.equal(body.uptime.needsAttention, 3, 'offline + maintenance');
});

test('PH-15: AI insights — fleet health counts effective devices', async () => {
  const api = await import('../src/app/api/insights/ai-analysis/route');
  const res = await api.GET(req(adminAToken, { url: 'http://localhost:3000/api/insights/ai-analysis' }));
  assert.equal(res.status, 200);
  const body = await res.json();
  const fleet = (body.data as Array<{ title: string; content: string }>)
    .find((i) => i.title === 'Device Fleet Health Assessment');
  assert.ok(fleet, 'fleet insight present');
  assert.ok(fleet.content.includes('1/4 devices online'), 'fleet count derives from heartbeat freshness');
});

test('PH-16: daily report — org isolation (foreign devices never counted)', async () => {
  const api = await import('../src/app/api/reports/daily/route');
  const res = await api.POST(req(adminBToken, {
    method: 'POST',
    url: 'http://localhost:3000/api/reports/daily',
    body: { date: new Date().toISOString().slice(0, 10) },
  }));
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.summary.onlineDevices, 1, 'org B sees only PC-B1');
});