/**
 * Phase I — Multi-tenant isolation regression tests.
 *
 * Proves that every org-scoped admin surface (dashboard, employees, devices,
 * projects, departments, search, analytics) is isolated per organization and
 * that a client-supplied organizationId can never switch tenant context.
 *
 * Runs against a THROWAWAY PostgreSQL database (workai_test_multiorg).
 * Run: npx tsx --test tests/multi-org-isolation.test.ts
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { req } from './helpers/request';

// ─── Test DB isolation (set BEFORE any app module import) ──────────────────
const PG_TEST_BASE = process.env.PG_TEST_BASE_URL || 'postgresql://postgres:123456@localhost:5432';
const TEST_DB_NAME = 'workai_test_multiorg';
const TEST_DB_URL = `${PG_TEST_BASE}/${TEST_DB_NAME}?schema=public`;

process.env.DATABASE_URL = TEST_DB_URL;
process.env.DIRECT_URL = TEST_DB_URL;
process.env.JWT_SECRET = 'test-jwt-secret-multiorg-0123456789abcdef';
process.env.SUPER_ADMIN_EMAIL = 'root@multiorg.local';
process.env.SUPER_ADMIN_PASSWORD = 'S3cure!MultiOrg2026x';
(process.env as Record<string, string>).NODE_ENV = 'test';
// MO-14 seeds a physical screenshot file and serves it through the image
// route, which uses the storage driver — pin the local driver regardless of
// any developer's .env.
process.env.STORAGE_DRIVER = 'local';

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
let empA: { id: string };
let empB: { id: string };
let deviceA: { id: string };
let deviceB: { id: string };
let projectA: { id: string };
let projectB: { id: string };
let deptA: { id: string };
let deptB: { id: string };
let shotA: { id: string };
let shotB: { id: string };
let appEntryA: { id: string };
let appEntryB: { id: string };

let adminAToken: string;
let adminBToken: string;
let superGlobalToken: string;

before(async () => {
  const dbModule = await import('../src/lib/db');
  db = dbModule.db;
  signJWT = (await import('../src/lib/auth')).signJWT;

  orgA = await db.organization.create({ data: { name: 'Org A', slug: 'org-a' } });
  orgB = await db.organization.create({ data: { name: 'Org B', slug: 'org-b' } });

  deptA = await db.department.create({ data: { name: 'Dept A', organizationId: orgA.id } });
  deptB = await db.department.create({ data: { name: 'Dept B', organizationId: orgB.id } });

  empA = await db.employee.create({
    data: {
      employeeId: 'EMP-A-001', firstName: 'Alice', lastName: 'A', email: 'alice@a.test',
      organizationId: orgA.id, departmentId: deptA.id, status: 'active', agentApproved: true,
    },
  });
  empB = await db.employee.create({
    data: {
      employeeId: 'EMP-B-001', firstName: 'Bob', lastName: 'B', email: 'bob@b.test',
      organizationId: orgB.id, departmentId: deptB.id, status: 'active', agentApproved: true,
    },
  });

  // Devices are seeded with a FRESH lastHeartbeat: presence semantics treat a
  // heartbeat-less device as OFFLINE (isHeartbeatFresh → false), so without a
  // heartbeat MO-5's onlineDevices assertion would see 0 for org A's own
  // device. A fresh heartbeat makes the fixture match real enrolled agents.
  const freshBeat = new Date();
  deviceA = await db.device.create({
    data: { name: 'PC-A', hostname: 'PC-A', agentKey: 'key-org-a', organizationId: orgA.id, employeeId: empA.id, status: 'online', lastHeartbeat: freshBeat },
  });
  deviceB = await db.device.create({
    data: { name: 'PC-B', hostname: 'PC-B', agentKey: 'key-org-b', organizationId: orgB.id, employeeId: empB.id, status: 'online', lastHeartbeat: freshBeat },
  });

  projectA = await db.project.create({ data: { name: 'Project A', organizationId: orgA.id, status: 'active' } });
  projectB = await db.project.create({ data: { name: 'Project B', organizationId: orgB.id, status: 'active' } });

  await db.activity.createMany({
    data: [
      { employeeId: empA.id, type: 'application', applicationName: 'App-A', category: 'productive', duration: 120, timestamp: new Date() },
      { employeeId: empB.id, type: 'application', applicationName: 'App-B', category: 'productive', duration: 999, timestamp: new Date() },
    ],
  });

  shotA = await db.screenshot.create({
    data: { employeeId: empA.id, organizationId: orgA.id, filePath: '/uploads/screenshots/a.png', fileName: 'a.png', fileSize: 10, mimeType: 'image/png' },
  });
  shotB = await db.screenshot.create({
    data: { employeeId: empB.id, organizationId: orgB.id, filePath: '/uploads/screenshots/b.png', fileName: 'b.png', fileSize: 10, mimeType: 'image/png' },
  });

  // Create the physical image file the [id]/image route serves.
  const uploadDir = join(process.cwd(), 'uploads', 'screenshots');
  mkdirSync(uploadDir, { recursive: true });
  writeFileSync(join(uploadDir, 'a.png'), Buffer.from('iVBORw0KGgo=', 'base64'));

  await db.auditLog.createMany({
    data: [
      { action: 'create', resource: 'employee', description: 'org A event', organizationId: orgA.id },
      { action: 'create', resource: 'employee', description: 'org B event', organizationId: orgB.id },
    ],
  });

  const now = new Date();
  const periodStart = new Date(now.getTime() - 86400000);
  const periodEnd = now;
  await db.sentimentRecord.createMany({
    data: [
      { employeeId: empA.id, organizationId: orgA.id, periodStart, periodEnd, score: 7, mood: 'positive', signals: '{}', riskFactors: '[]' },
      { employeeId: empB.id, organizationId: orgB.id, periodStart, periodEnd, score: 2, mood: 'negative', signals: '{}', riskFactors: '[]' },
    ],
  });

  await db.notification.createMany({
    data: [
      { title: 'N-A', message: 'org A', type: 'system', organizationId: orgA.id },
      { title: 'N-B', message: 'org B', type: 'system', organizationId: orgB.id },
    ],
  });

  appEntryA = await db.appListEntry.create({
    data: { appName: 'App-Entry-A', listType: 'whitelist', organizationId: orgA.id },
  });
  appEntryB = await db.appListEntry.create({
    data: { appName: 'PROBE-B-APP', listType: 'blacklist', organizationId: orgB.id },
  });

  adminAToken = await signJWT({ userId: 'admin-a', email: 'admin@a.test', role: 'admin', organizationId: orgA.id });
  adminBToken = await signJWT({ userId: 'admin-b', email: 'admin@b.test', role: 'admin', organizationId: orgB.id });
  superGlobalToken = await signJWT({ userId: 'super-global', email: 'super@global.test', role: 'super_admin' });
});

after(async () => {
  await db.$disconnect();
  try {
    rmSync(join(process.cwd(), 'uploads', 'screenshots', 'a.png'), { force: true });
  } catch {
    /* best-effort cleanup */
  }
  try {
    execSync(`node scripts/pg-test-db.mjs drop ${TEST_DB_NAME}`, {
      env: { ...process.env, PG_TEST_BASE_URL: PG_TEST_BASE },
      stdio: 'pipe',
    });
  } catch {
    /* best-effort cleanup */
  }
});


// ─── 1–4: Admin A cannot see B's resources ─────────────────────────────────

test('MO-1: Admin A employee list contains only org A employees', async () => {
  const api = await import('../src/app/api/employees/route');
  const res = await api.GET(req(adminAToken, { url: `http://localhost:3000/api/employees?pageSize=100&status=active` }));
  const body = await res.json();
  assert.equal(res.status, 200);
  const ids = (body.data as Array<{ id: string }>).map((e) => e.id);
  assert.ok(ids.includes(empA.id), 'org A employee visible to admin A');
  assert.ok(!ids.includes(empB.id), 'org B employee must NOT leak to admin A');
});

test('MO-2: Admin A device list contains only org A devices', async () => {
  const api = await import('../src/app/api/devices/route');
  const res = await api.GET(req(adminAToken, { url: 'http://localhost:3000/api/devices?pageSize=100' }));
  const body = await res.json();
  const ids = (body.data as Array<{ id: string }>).map((d) => d.id);
  assert.ok(ids.includes(deviceA.id));
  assert.ok(!ids.includes(deviceB.id), 'org B device must NOT leak');
});

test('MO-3: Admin A project list contains only org A projects', async () => {
  const api = await import('../src/app/api/projects/route');
  const res = await api.GET(req(adminAToken, { url: 'http://localhost:3000/api/projects?pageSize=100' }));
  const body = await res.json();
  const ids = (body.data as Array<{ id: string }>).map((p) => p.id);
  assert.ok(ids.includes(projectA.id));
  assert.ok(!ids.includes(projectB.id), 'org B project must NOT leak');
});

test('MO-4: Admin A department list contains only org A departments', async () => {
  const api = await import('../src/app/api/departments/route');
  const res = await api.GET(req(adminAToken, { url: 'http://localhost:3000/api/departments' }));
  const body = await res.json();
  const ids = (body.data as Array<{ id: string }>).map((d) => d.id);
  assert.ok(ids.includes(deptA.id));
  assert.ok(!ids.includes(deptB.id), 'org B department must NOT leak');
});

// ─── 5–7: dashboard / analytics / search isolation ─────────────────────────

test('MO-5: Admin A dashboard contains NO org B data', async () => {
  const api = await import('../src/app/api/dashboard/route');
  const res = await api.GET(req(adminAToken, { url: 'http://localhost:3000/api/dashboard' }));
  const body = await res.json();
  assert.equal(res.status, 200);
  const data = body.data;
  // 1 active employee in org A (Alice), device online, activities only Alice's.
  assert.equal(data.totalEmployees, 1, 'dashboard employee count must be org-scoped');
  assert.equal(data.onlineDevices, 1, 'dashboard device count must be org-scoped');
  assert.equal(data.totalDevices, 1, 'dashboard total devices must be org-scoped');
  const recentNames = (data.recentActivities as Array<{ employee: { firstName: string } }>).map((a) => a.employee.firstName);
  assert.ok(recentNames.every((n) => n === 'Alice'), 'recent activity must not include Bob');
});

test('MO-6: Admin A analytics contains NO org B data', async () => {
  const api = await import('../src/app/api/analytics/route');
  const res = await api.GET(req(adminAToken, { url: 'http://localhost:3000/api/analytics?period=week' }));
  const body = await res.json();
  assert.equal(res.status, 200);
  const summary = body.data.summary;
  // Only Alice's single activity (120s) is in org A.
  assert.equal(summary.totalActivities, 1, 'analytics must only count org A activities');
  assert.equal(summary.activeEmployees, 1);
});

test('MO-7: Admin A search finds only org A resources', async () => {
  const api = await import('../src/app/api/search/route');
  const res = await api.GET(req(adminAToken, { url: 'http://localhost:3000/api/search?q=PC' }));
  const body = await res.json();
  assert.equal(res.status, 200);
  const deviceNames = (body.devices as Array<{ name: string }>).map((d) => d.name);
  assert.ok(deviceNames.includes('PC-A'));
  assert.ok(!deviceNames.includes('PC-B'), 'org B device must not appear in search');

  const res2 = await api.GET(req(adminAToken, { url: 'http://localhost:3000/api/search?q=Bob' }));
  const body2 = await res2.json();
  assert.equal((body2.employees as unknown[]).length, 0, 'org B employee must not appear in search');
});

// ─── 8–9: cross-org resource access + client org manipulation ──────────────

test('MO-8: cross-org resource IDs return 404 concealment', async () => {
  const empApi = await import('../src/app/api/employees/[id]/route');
  const res = await empApi.GET(req(adminAToken), { params: Promise.resolve({ id: empB.id }) });
  assert.equal(res.status, 404, 'org B employee detail must be concealed (404)');

  const projApi = await import('../src/app/api/projects/[id]/route');
  const projRes = await projApi.GET(req(adminAToken), { params: Promise.resolve({ id: projectB.id }) });
  assert.equal(projRes.status, 404, 'org B project must be concealed (404)');

  const devApi = await import('../src/app/api/devices/[id]/route');
  const devRes = await devApi.GET(req(adminAToken), { params: Promise.resolve({ id: deviceB.id }) });
  assert.equal(devRes.status, 404, 'org B device must be concealed (404)');
});

test('MO-9: client-supplied organizationId cannot switch tenant context', async () => {
  // Org-bound Admin A tries to read org B by passing ?organizationId=orgB.
  // The server must reject this with 403 (cross-org access denied) or ignore
  // the param entirely — it must NEVER silently switch the tenant.
  const api = await import('../src/app/api/employees/route');
  const res = await api.GET(req(adminAToken, { url: `http://localhost:3000/api/employees?pageSize=100&organizationId=${orgB.id}` }));
  if (res.status === 403) {
    // Best case: server rejects cross-org param outright.
    const body = await res.json();
    assert.ok(body.error, '403 must include an error message');
  } else {
    // Acceptable fallback: server ignores the param and returns own-org data.
    assert.equal(res.status, 200, 'must be 200 or 403, nothing else');
    const body = await res.json();
    const ids = (body.data as Array<{ id: string }>).map((e) => e.id);
    assert.ok(ids.includes(empA.id), 'still scoped to own org');
    assert.ok(!ids.includes(empB.id), 'organizationId param must NEVER switch the tenant');
  }

  // Same for analytics and search.
  const anal = await import('../src/app/api/analytics/route');
  const analRes = await anal.GET(req(adminAToken, { url: `http://localhost:3000/api/analytics?period=week&organizationId=${orgB.id}` }));
  if (analRes.status === 403) {
    const analBody = await analRes.json();
    assert.ok(analBody.error, '403 must include an error message');
  } else {
    const analBody = await analRes.json();
    assert.equal(analBody.data.summary.totalActivities, 1, 'analytics must stay scoped to own org');
  }

  const search = await import('../src/app/api/search/route');
  const sRes = await search.GET(req(adminAToken, { url: `http://localhost:3000/api/search?q=PC&organizationId=${orgB.id}` }));
  if (sRes.status === 403) {
    const sBody = await sRes.json();
    assert.ok(sBody.error, '403 must include an error message');
  } else {
    const sBody = await sRes.json();
    assert.ok(!(sBody.devices as Array<{ name: string }>).some((d) => d.name === 'PC-B'), 'search must stay scoped');
  }
});

// ─── 10–11: Super Admin semantics ──────────────────────────────────────────

test('MO-10: org-less super admin dashboard is EMPTY (no global business data)', async () => {
  const api = await import('../src/app/api/dashboard/route');
  const res = await api.GET(req(superGlobalToken, { url: 'http://localhost:3000/api/dashboard' }));
  const body = await res.json();
  assert.equal(res.status, 200);
  const data = body.data;
  assert.equal(data.totalEmployees, 0, 'org-less super admin must NOT see global employee counts');
  assert.equal(data.totalDevices, 0, 'org-less super admin must NOT see global device counts');
  assert.equal((data.recentActivities as unknown[]).length, 0);
  assert.equal((data.departmentBreakdown as unknown[]).length, 0);
});

test('MO-10b: org-less super admin analytics/search are EMPTY', async () => {
  const anal = await import('../src/app/api/analytics/route');
  const aRes = await anal.GET(req(superGlobalToken, { url: 'http://localhost:3000/api/analytics?period=week' }));
  const aBody = await aRes.json();
  assert.equal(aBody.data.summary.totalActivities, 0);

  const search = await import('../src/app/api/search/route');
  const sRes = await search.GET(req(superGlobalToken, { url: 'http://localhost:3000/api/search?q=PC' }));
  const sBody = await sRes.json();
  assert.equal((sBody.employees as unknown[]).length, 0);
  assert.equal((sBody.devices as unknown[]).length, 0);
});

test('MO-11: super admin WITH active org sees ONLY that org on the dashboard', async () => {
  const bound = await signJWT({ userId: 'super-bound', email: 'super.bound@a.test', role: 'super_admin', organizationId: orgA.id });
  const api = await import('../src/app/api/dashboard/route');
  const res = await api.GET(req(bound, { url: 'http://localhost:3000/api/dashboard' }));
  const body = await res.json();
  assert.equal(res.status, 200);
  assert.equal(body.data.totalEmployees, 1, 'bound super admin dashboard is scoped to its org');
  assert.equal(body.data.totalDevices, 1);
});

// ─── 12: org creation remains Super Admin-only ─────────────────────────────

test('MO-12: org creation is Super Admin-only; regular admin gets 403', async () => {
  const api = await import('../src/app/api/organizations/route');
  const res = await api.POST(req(adminAToken, { method: 'POST', body: { name: 'Rogue Org' }, ip: '203.0.113.99' }));
  assert.equal(res.status, 403, 'org-bound admin cannot create an organization');
});

// ─── Seat-limit removal regression ─────────────────────────────────────────

test('MO-13: no seat-limit fields exist; employee creation is unlimited', async () => {
  const orgRow = await db.organization.findUnique({ where: { id: orgA.id } }) as Record<string, unknown> | null;
  assert.ok(orgRow, 'org exists');
  assert.equal('maxSeats' in (orgRow ?? {}), false, 'maxSeats column must be removed');
  assert.equal('currentSeats' in (orgRow ?? {}), false, 'currentSeats column must be removed');

  // Create employees past any hypothetical 50 limit to prove no cap.
  const api = await import('../src/app/api/employees/route');
  let created = 0;
  for (let i = 1; i <= 5; i++) {
    const res = await api.POST(
      req(adminAToken, {
        method: 'POST',
        body: { employeeId: `CAP-${i}`, firstName: `Cap${i}`, lastName: 'T', email: `cap${i}@a.test`, departmentId: deptA.id },
        ip: `203.0.113.2${i}`,
      })
    );
    assert.equal(res.status, 201, `employee CAP-${i} must create without any seat-limit error`);
    created++;
  }
  assert.equal(created, 5);
  assert.equal(await db.employee.count({ where: { organizationId: orgA.id } }), 6, '1 fixture + 5 new = 6 (no cap)');
});

// ─── 14+: newly-scoped surfaces (screenshots, compare, exports, sentiment, ─
// ───     break-status, notifications batch, AI usage) ───────────────────────

test('MO-14: screenshot list & image access are org-scoped', async () => {
  const listApi = await import('../src/app/api/screenshots/route');
  const listRes = await listApi.GET(req(adminAToken, { url: 'http://localhost:3000/api/screenshots?pageSize=100' }));
  const listBody = await listRes.json();
  const ids = (listBody.data as Array<{ id: string }>).map((s) => s.id);
  assert.ok(ids.includes(shotA.id), 'own-org screenshot visible');
  assert.ok(!ids.includes(shotB.id), 'org B screenshot must NOT leak');

  const imageApi = await import('../src/app/api/screenshots/[id]/image/route');
  const ownRes = await imageApi.GET(req(adminAToken, { url: `http://localhost:3000/api/screenshots/${shotA.id}/image` }), {
    params: Promise.resolve({ id: shotA.id }),
  });
  assert.equal(ownRes.status, 200, 'own-org screenshot image served');

  const crossRes = await imageApi.GET(req(adminAToken, { url: `http://localhost:3000/api/screenshots/${shotB.id}/image` }), {
    params: Promise.resolve({ id: shotB.id }),
  });
  assert.equal(crossRes.status, 404, 'cross-org screenshot image must be concealed (404)');
});

test('MO-15: analytics compare is org-scoped (cross-org dept = 404)', async () => {
  const api = await import('../src/app/api/analytics/compare/route');
  const res = await api.GET(req(adminAToken, {
    url: `http://localhost:3000/api/analytics/compare?mode=departments&id1=${deptA.id}&id2=${deptB.id}`,
  }));
  assert.equal(res.status, 404, 'cross-org department in compare must be concealed (404)');

  const ownRes = await api.GET(req(adminAToken, {
    url: `http://localhost:3000/api/analytics/compare?mode=departments&id1=${deptA.id}&id2=${deptA.id}`,
  }));
  assert.equal(ownRes.status, 200, 'own-org compare works');
});

test('MO-16: audit-logs export is org-scoped', async () => {
  const api = await import('../src/app/api/audit-logs/export/route');
  const res = await api.GET(req(adminAToken, { url: 'http://localhost:3000/api/audit-logs/export' }));
  const body = await res.json();
  assert.equal(res.status, 200);
  const rows = body.data as Array<{ Description: string }>;
  assert.ok(rows.some((r) => r.Description === 'org A event'));
  assert.ok(!rows.some((r) => r.Description === 'org B event'), 'org B audit rows must NOT be exported');
});

test('MO-17: sentiment summary & detail are org-scoped', async () => {
  const sumApi = await import('../src/app/api/sentiment/summary/route');
  const sumRes = await sumApi.GET(req(adminAToken, { url: 'http://localhost:3000/api/sentiment/summary' }));
  const sumBody = await sumRes.json();
  assert.equal(sumBody.totalRecords, 1, 'summary must only count org A records');

  const detailApi = await import('../src/app/api/sentiment/[id]/route');
  // Fetch the actual B record id, then assert 404 concealment.
  const bRecord = await db.sentimentRecord.findFirst({ where: { employeeId: empB.id }, select: { id: true } });
  assert.ok(bRecord, 'fixture record exists');
  const cross = await detailApi.GET(req(adminAToken, { url: `http://localhost:3000/api/sentiment/${bRecord.id}` }), {
    params: Promise.resolve({ id: bRecord.id }),
  });
  assert.equal(cross.status, 404, 'cross-org sentiment detail must be concealed (404)');
});

test('MO-18: break-status summary is org-scoped', async () => {
  const api = await import('../src/app/api/break-status/summary/route');
  const res = await api.GET(req(adminAToken, { url: 'http://localhost:3000/api/break-status/summary' }));
  const body = await res.json();
  assert.equal(res.status, 200);
  const orgACount = await db.employee.count({ where: { organizationId: orgA.id, status: 'active' } });
  assert.equal(body.totalEmployees, orgACount, 'summary must only count org A employees (never org B)');
  assert.ok(!(body.breakByDepartment as Array<{ departmentName: string }>).some((d) => d.departmentName === 'Dept B'), 'org B department must not appear');
});

test('MO-19: notifications batch cannot touch cross-org notifications', async () => {
  const api = await import('../src/app/api/notifications/batch/route');
  const bNotif = await db.notification.findFirst({ where: { organizationId: orgB.id }, select: { id: true } });
  assert.ok(bNotif, 'org B notification exists');

  const res = await api.POST(req(adminAToken, {
    method: 'POST',
    body: { action: 'delete', ids: [bNotif.id] },
  }));
  const body = await res.json();
  assert.equal(res.status, 200);
  assert.equal(body.affected, 0, 'cross-org notification must NOT be affected');

  // The org B notification must still exist.
  assert.ok(await db.notification.findUnique({ where: { id: bNotif.id } }), 'org B notification untouched');
});

test('MO-20: AI provider usage is org-scoped', async () => {
  const api = await import('../src/app/api/ai-provider/usage/route');
  const res = await api.GET(req(adminAToken, { url: 'http://localhost:3000/api/ai-provider/usage' }));
  const body = await res.json();
  assert.equal(res.status, 200);
  // Org A: 1 screenshot with no aiAnalysis -> total 0. Only org A records count.
  assert.equal(typeof body.total, 'number', 'usage payload shape intact');
});

test('MO-21: org-less super admin gets EMPTY states for all new surfaces', async () => {
  const screens = await import('../src/app/api/screenshots/route');
  const sRes = await screens.GET(req(superGlobalToken, { url: 'http://localhost:3000/api/screenshots' }));
  const sBody = await sRes.json();
  assert.equal((sBody.data as unknown[]).length, 0, 'no global screenshot leak');

  const audit = await import('../src/app/api/audit-logs/export/route');
  const aRes = await audit.GET(req(superGlobalToken, { url: 'http://localhost:3000/api/audit-logs/export' }));
  const aBody = await aRes.json();
  assert.equal((aBody.data as unknown[]).length, 0, 'no global audit export');

  const usage = await import('../src/app/api/ai-provider/usage/route');
  const uRes = await usage.GET(req(superGlobalToken, { url: 'http://localhost:3000/api/ai-provider/usage' }));
  const uBody = await uRes.json();
  assert.equal(uBody.total, 0, 'no global AI usage aggregate');
});

// ─── 22–27: Break Monitor force-toggle auth + tenant isolation ──────────────
// POST /api/break-status/[id]/toggle must be admin-only and org-scoped:
// failed authorization / cross-org attempts must NEVER create Activity or
// AuditLog rows.

async function breakRowCounts(employeeId: string) {
  const [activities, auditLogs] = await Promise.all([
    db.activity.count({ where: { employeeId, title: { startsWith: 'Break Mode' } } }),
    db.auditLog.count({ where: { resourceId: employeeId, description: { contains: 'break mode' } } }),
  ]);
  return { activities, auditLogs };
}

test('MO-22: break-toggle unauthenticated -> 401 and no rows created', async () => {
  const before = await breakRowCounts(empA.id);
  const api = await import('../src/app/api/break-status/[id]/toggle/route');
  const res = await api.POST(req(null, {
    method: 'POST',
    body: {},
    url: `http://localhost:3000/api/break-status/${empA.id}/toggle`,
  }), { params: Promise.resolve({ id: empA.id }) });
  assert.equal(res.status, 401, 'unauthenticated must be rejected');
  const after = await breakRowCounts(empA.id);
  assert.deepEqual(after, before, 'no Activity/AuditLog created without auth');
});

test('MO-23: break-toggle viewer (same org) -> 403 and no rows created', async () => {
  const viewerAToken = await signJWT({ userId: 'viewer-a', email: 'viewer@a.test', role: 'viewer', organizationId: orgA.id });
  const before = await breakRowCounts(empA.id);
  const api = await import('../src/app/api/break-status/[id]/toggle/route');
  const res = await api.POST(req(viewerAToken, {
    method: 'POST',
    body: {},
    url: `http://localhost:3000/api/break-status/${empA.id}/toggle`,
  }), { params: Promise.resolve({ id: empA.id }) });
  assert.equal(res.status, 403, 'viewer must be rejected');
  const after = await breakRowCounts(empA.id);
  assert.deepEqual(after, before, 'no Activity/AuditLog created by viewer');
});

test('MO-24: break-toggle manager (same org) -> 403 and no rows created', async () => {
  const managerAToken = await signJWT({ userId: 'manager-a', email: 'manager@a.test', role: 'manager', organizationId: orgA.id });
  const before = await breakRowCounts(empA.id);
  const api = await import('../src/app/api/break-status/[id]/toggle/route');
  const res = await api.POST(req(managerAToken, {
    method: 'POST',
    body: {},
    url: `http://localhost:3000/api/break-status/${empA.id}/toggle`,
  }), { params: Promise.resolve({ id: empA.id }) });
  assert.equal(res.status, 403, 'manager must be rejected (admin-only route)');
  const after = await breakRowCounts(empA.id);
  assert.deepEqual(after, before, 'no Activity/AuditLog created by manager');
});

test('MO-25: admin toggles own-org employee -> 200 with Activity + AuditLog', async () => {
  const before = await breakRowCounts(empA.id);
  const api = await import('../src/app/api/break-status/[id]/toggle/route');
  const res = await api.POST(req(adminAToken, {
    method: 'POST',
    body: {},
    url: `http://localhost:3000/api/break-status/${empA.id}/toggle`,
  }), { params: Promise.resolve({ id: empA.id }) });
  const body = await res.json();
  assert.equal(res.status, 200, 'authorized admin toggles own-org employee');
  assert.equal(body.action, 'started', 'empA has no break activity yet -> starts a break');
  const after = await breakRowCounts(empA.id);
  assert.equal(after.activities, before.activities + 1, 'one Break Mode Activity created');
  assert.equal(after.auditLogs, before.auditLogs + 1, 'one AuditLog created');
});

test('MO-26: admin from org B toggling org A employee -> 404 and NO rows created', async () => {
  const before = await breakRowCounts(empA.id);
  const api = await import('../src/app/api/break-status/[id]/toggle/route');
  const res = await api.POST(req(adminBToken, {
    method: 'POST',
    body: {},
    url: `http://localhost:3000/api/break-status/${empA.id}/toggle`,
  }), { params: Promise.resolve({ id: empA.id }) });
  assert.equal(res.status, 404, 'cross-org employee must be concealed with 404');
  const after = await breakRowCounts(empA.id);
  assert.deepEqual(after, before, 'cross-org attempt must not create Activity/AuditLog');
  // empB (admin B's own org) must be untouched too.
  const bCounts = await breakRowCounts(empB.id);
  assert.deepEqual(bCounts, { activities: 0, auditLogs: 0 }, 'org B employee untouched');
});

test('MO-27: admin toggling nonexistent employee id -> 404 and no rows created', async () => {
  const before = await breakRowCounts(empA.id);
  const api = await import('../src/app/api/break-status/[id]/toggle/route');
  const res = await api.POST(req(adminAToken, {
    method: 'POST',
    body: {},
    url: 'http://localhost:3000/api/break-status/cms-nonexistent-id-0000/toggle',
  }), { params: Promise.resolve({ id: 'cms-nonexistent-id-0000' }) });
  assert.equal(res.status, 404, 'nonexistent employee id must 404');
  const after = await breakRowCounts(empA.id);
  assert.deepEqual(after, before, 'no Activity/AuditLog created for nonexistent id');
});

// ─── Intelligence section hardening (P1/P2/P3) ─────────────────────────────
// Proven live: the collection PUT /api/insights was dead-but-reachable and
// could mutate ANY org's insight with a viewer token. It is now removed;
// the org-scoped [id] route remains the canonical update path.

test('MO-28: collection PUT /api/insights is removed; [id] PUT stays org-scoped', async () => {
  const insightsApi = await import('../src/app/api/insights/route');
  assert.equal(typeof (insightsApi as unknown as { PUT?: unknown }).PUT, 'undefined', 'collection PUT handler must be deleted');

  // The dynamic [id] route remains the canonical, org-scoped update path.
  const insightA = await db.aiInsight.create({
    data: { title: 'I-A', content: 'insight A', type: 'productivity', organizationId: orgA.id },
  });
  const idApi = await import('../src/app/api/insights/[id]/route');
  const params = Promise.resolve({ id: insightA.id });
  const own = await idApi.PUT(req(adminAToken, { method: 'PUT', body: { status: 'acknowledged' }, url: `http://localhost:3000/api/insights/${insightA.id}` }), { params });
  assert.equal(own.status, 200, 'admin may acknowledge own org insight');
  const cross = await idApi.PUT(req(adminBToken, { method: 'PUT', body: { status: 'dismissed' }, url: `http://localhost:3000/api/insights/${insightA.id}` }), { params });
  assert.equal(cross.status, 404, 'cross-org insight id must be concealed with 404');
  await db.aiInsight.delete({ where: { id: insightA.id } });
});

test('MO-29: POST /api/insights (Generate Insight) requires manager+', async () => {
  const api = await import('../src/app/api/insights/route');
  const viewerAToken = await signJWT({ userId: 'v-a', email: 'v@a.test', role: 'viewer', organizationId: orgA.id });
  const managerAToken = await signJWT({ userId: 'm-a', email: 'm@a.test', role: 'manager', organizationId: orgA.id });

  const anon = await api.POST(req(null, { method: 'POST', body: {} }));
  assert.equal(anon.status, 401, 'unauthenticated must be rejected');
  const viewer = await api.POST(req(viewerAToken, { method: 'POST', body: {} }));
  assert.equal(viewer.status, 403, 'viewer must be rejected');

  // The AI-backed generate path is REACHED by manager+ (RBAC gate passes) and
  // answers truthfully. In this test env no AI provider is configured, so the
  // engine returns the honest not_configured state and MUST NOT fabricate or
  // persist an insight (the spec forbids any fallback labeled as AI).
  const before = await db.aiInsight.count({ where: { organizationId: orgA.id } });
  const manager = await api.POST(req(managerAToken, { method: 'POST', body: {} }));
  assert.equal(manager.status, 200, 'manager reaches the AI generate path');
  const managerBody = await manager.json();
  assert.equal(managerBody.data, null, 'no fabricated insight persisted without a provider');
  assert.ok(
    ['not_configured', 'error'].includes(managerBody.meta?.aiStatus ?? ''),
    `truthful aiStatus, got ${managerBody.meta?.aiStatus}`
  );
  assert.equal(await db.aiInsight.count({ where: { organizationId: orgA.id } }), before, 'nothing persisted');

  const admin = await api.POST(req(adminAToken, { method: 'POST', body: {} }));
  assert.equal(admin.status, 200, 'admin reaches the AI generate path');
  const adminBody = await admin.json();
  assert.equal(adminBody.data, null, 'no fabricated insight persisted without a provider');
  assert.equal(await db.aiInsight.count({ where: { organizationId: orgA.id } }), before, 'nothing persisted');
});

test('MO-30: ai-provider test-connection requires SUPER_ADMIN at handler level', async () => {
  const api = await import('../src/app/api/ai-provider/test-connection/route');
  const viewerAToken = await signJWT({ userId: 'v-a2', email: 'v2@a.test', role: 'viewer', organizationId: orgA.id });
  const managerAToken = await signJWT({ userId: 'm-a2', email: 'm2@a.test', role: 'manager', organizationId: orgA.id });
  const body = JSON.stringify({ provider: 'openai' });

  const anon = await api.POST(req(null, { method: 'POST', body }));
  assert.equal(anon.status, 401, 'unauthenticated must be rejected');
  const viewer = await api.POST(req(viewerAToken, { method: 'POST', body }));
  assert.equal(viewer.status, 403, 'viewer must be rejected');
  const manager = await api.POST(req(managerAToken, { method: 'POST', body }));
  assert.equal(manager.status, 403, 'manager must be rejected');
  // P1-7: this route PERSISTS instance-global AI config — an org-bound admin
  // must be rejected too (403), never allowed to reach validation.
  const admin = await api.POST(req(adminAToken, { method: 'POST', body }));
  assert.equal(admin.status, 403, 'org-bound admin must be rejected (global config write)');
  // Only the platform super_admin may test+persist. Without a stored key it
  // passes the auth gate and fails validation with a clear 400 (no network).
  const superAdmin = await api.POST(req(superGlobalToken, { method: 'POST', body }));
  assert.equal(superAdmin.status, 400, 'super_admin passes auth gate, fails validation with a clear 400');
});

test('MO-31: /api/settings GET admin+, PUT super_admin-only (P1-7)', async () => {
  const api = await import('../src/app/api/settings/route');
  const viewerAToken = await signJWT({ userId: 'v-a3', email: 'v3@a.test', role: 'viewer', organizationId: orgA.id });
  const managerAToken = await signJWT({ userId: 'm-a3', email: 'm3@a.test', role: 'manager', organizationId: orgA.id });

  const anonGet = await api.GET(req(null));
  assert.equal(anonGet.status, 401, 'unauthenticated GET must be rejected');
  const viewerGet = await api.GET(req(viewerAToken));
  assert.equal(viewerGet.status, 403, 'viewer GET must be rejected');
  const managerGet = await api.GET(req(managerAToken));
  assert.equal(managerGet.status, 403, 'manager GET must be rejected');
  const adminGet = await api.GET(req(adminAToken));
  assert.equal(adminGet.status, 200, 'admin GET allowed (global read is intentional)');

  const viewerPut = await api.PUT(req(viewerAToken, { method: 'PUT', body: { key: 'audit_probe', value: 'x' } }));
  assert.equal(viewerPut.status, 403, 'viewer PUT must be rejected');
  const adminPut = await api.PUT(req(adminAToken, { method: 'PUT', body: { key: 'audit_probe', value: 'x' } }));
  assert.equal(adminPut.status, 403, 'org-bound admin PUT must be rejected (instance-global write)');
  const managerPut = await api.PUT(req(managerAToken, { method: 'PUT', body: { key: 'audit_probe', value: 'x' } }));
  assert.equal(managerPut.status, 403, 'manager PUT must be rejected');

  const superPut = await api.PUT(req(superGlobalToken, { method: 'PUT', body: { key: 'audit_probe', value: 'x' } }));
  assert.equal(superPut.status, 200, 'super_admin PUT allowed');
  // The super_admin write is audited with the verified actor.
  const audit = await db.auditLog.findFirst({
    where: { resource: 'settings', resourceId: { not: null }, description: { contains: 'audit_probe' } },
  });
  assert.ok(audit, 'super_admin settings write must be audited');
  assert.equal(audit!.userId, 'super-global', 'audit actor = verified super_admin session');
  await db.systemSetting.deleteMany({ where: { key: 'audit_probe' } });
  await db.auditLog.deleteMany({ where: { id: audit!.id } });
});

test('MO-32: ai-analysis only sees the caller org\'s activities (org A)', async () => {
  const api = await import('../src/app/api/insights/ai-analysis/route');
  // Give org B a HUGE unproductive activity. If org B data leaked into org
  // A's analysis, the productive percentage would collapse below 100%.
  const leakProbe = await db.activity.create({
    data: { employeeId: empB.id, type: 'idle', category: 'unproductive', duration: 50000, timestamp: new Date() },
  });
  try {
    const res = await api.GET(req(adminAToken, { url: 'http://localhost:3000/api/insights/ai-analysis' }));
    assert.equal(res.status, 200);
    const body = await res.json();
    const pattern = (body.data as Array<{ title: string; content: string }>).find((i) => i.title === 'Activity Pattern Optimization');
    assert.ok(pattern, 'Activity Pattern Optimization insight present');
    assert.ok(
      /100% productive/.test(pattern.content),
      `org A analysis must include only org A activities (got: ${pattern.content})`
    );
  } finally {
    await db.activity.delete({ where: { id: leakProbe.id } });
  }
});

test('MO-33: ai-analysis ignores client-supplied orgId (no tenant switch)', async () => {
  const api = await import('../src/app/api/insights/ai-analysis/route');
  const leakProbe = await db.activity.create({
    data: { employeeId: empB.id, type: 'idle', category: 'unproductive', duration: 50000, timestamp: new Date() },
  });
  try {
    const res = await api.GET(req(adminAToken, { url: 'http://localhost:3000/api/insights/ai-analysis?orgId=org-b' }));
    assert.equal(res.status, 200);
    const body = await res.json();
    const pattern = (body.data as Array<{ title: string; content: string }>).find((i) => i.title === 'Activity Pattern Optimization');
    assert.ok(pattern);
    assert.ok(/100% productive/.test(pattern.content), 'client-supplied orgId must never change the tenant scope');
  } finally {
    await db.activity.delete({ where: { id: leakProbe.id } });
  }
});

// ─── Security section: app-list (Policies) P0/P1 hardening ──────────────────
// P0: DELETE /api/app-list/[id] was an ID-only mutation with no auth/org scope
//     (cross-org deactivation proven live: admin A deactivated org B's entry).
// P1: POST /api/app-list had no role gate (viewer received HTTP 201).
// P1: GET /api/app-list had no org scope (cross-org data exposure).
// Required: server-side authorization, org scope from verified session only,
// 404 concealment for cross-org/nonexistent targets, ZERO side effects on any
// failed request, audit entries bound to the authenticated actor + org.

async function policyStats() {
  const [entries, audits] = await Promise.all([
    db.appListEntry.count(),
    db.auditLog.count({ where: { resource: 'policy' } }),
  ]);
  return { entries, audits };
}

// ─── GET /api/app-list ──────────────────────────────────────────────────────

test('MO-34: app-list GET is org-scoped (Org A sees only A; Org B sees only B)', async () => {
  const api = await import('../src/app/api/app-list/route');

  const resA = await api.GET(req(adminAToken, { url: 'http://localhost:3000/api/app-list?pageSize=100' }));
  assert.equal(resA.status, 200);
  const bodyA = await resA.json();
  const namesA = (bodyA.data as Array<{ appName: string }>).map((e) => e.appName);
  assert.ok(namesA.includes('App-Entry-A'), 'own-org entry visible to org A');
  assert.ok(!namesA.includes('PROBE-B-APP'), 'org B entry must NOT leak into org A list');

  const resB = await api.GET(req(adminBToken, { url: 'http://localhost:3000/api/app-list?pageSize=100' }));
  assert.equal(resB.status, 200);
  const bodyB = await resB.json();
  const namesB = (bodyB.data as Array<{ appName: string }>).map((e) => e.appName);
  assert.ok(namesB.includes('PROBE-B-APP'), 'own-org entry visible to org B');
  assert.ok(!namesB.includes('App-Entry-A'), 'org A entry must NOT leak into org B list');
});

test('MO-35: app-list GET ignores client-supplied organizationId (no tenant switch)', async () => {
  const api = await import('../src/app/api/app-list/route');
  const res = await api.GET(req(adminAToken, {
    url: `http://localhost:3000/api/app-list?pageSize=100&organizationId=${orgB.id}`,
  }));
  assert.equal(res.status, 200);
  const body = await res.json();
  const names = (body.data as Array<{ appName: string }>).map((e) => e.appName);
  assert.ok(names.includes('App-Entry-A'), 'still scoped to own org');
  assert.ok(!names.includes('PROBE-B-APP'), 'client organizationId must NEVER switch the tenant');
});

test('MO-36: app-list GET unauthenticated -> 401', async () => {
  const api = await import('../src/app/api/app-list/route');
  const res = await api.GET(req(null, { url: 'http://localhost:3000/api/app-list' }));
  assert.equal(res.status, 401, 'unauthenticated must be rejected');
});

// ─── POST /api/app-list ─────────────────────────────────────────────────────

test('MO-37: app-list POST unauthenticated -> 401 and zero rows created', async () => {
  const before = await policyStats();
  const api = await import('../src/app/api/app-list/route');
  const res = await api.POST(req(null, {
    method: 'POST',
    body: { appName: 'Rogue-App', listType: 'blacklist' },
  }));
  assert.equal(res.status, 401, 'unauthenticated must be rejected');
  const after = await policyStats();
  assert.equal(after.entries, before.entries, 'no AppListEntry created');
  assert.equal(after.audits, before.audits, 'no AuditLog created');
});

test('MO-38: app-list POST viewer -> 403 and zero rows created', async () => {
  const viewerAToken = await signJWT({ userId: 'viewer-applist', email: 'viewer.al@a.test', role: 'viewer', organizationId: orgA.id });
  const before = await policyStats();
  const api = await import('../src/app/api/app-list/route');
  const res = await api.POST(req(viewerAToken, {
    method: 'POST',
    body: { appName: 'Rogue-App', listType: 'blacklist' },
  }));
  assert.equal(res.status, 403, 'viewer must be rejected');
  const after = await policyStats();
  assert.equal(after.entries, before.entries, 'no AppListEntry created by viewer');
  assert.equal(after.audits, before.audits, 'no AuditLog created by viewer');
});

test('MO-39: app-list POST manager -> 201 in manager org', async () => {
  const managerAToken = await signJWT({ userId: 'manager-applist', email: 'manager.al@a.test', role: 'manager', organizationId: orgA.id });
  const before = await policyStats();
  const api = await import('../src/app/api/app-list/route');
  const res = await api.POST(req(managerAToken, {
    method: 'POST',
    body: { appName: 'Manager-App', listType: 'whitelist', reason: 'MO-39' },
  }));
  assert.equal(res.status, 201, 'manager may add an app policy entry');
  const body = await res.json();
  assert.equal(body.organizationId, orgA.id, 'entry must be created in the manager org');
  const after = await policyStats();
  assert.equal(after.entries, before.entries + 1, 'exactly one AppListEntry created');
  assert.equal(after.audits, before.audits + 1, 'exactly one AuditLog created');
  await db.appListEntry.delete({ where: { id: body.id } });
  await db.auditLog.deleteMany({ where: { resource: 'policy', description: { contains: 'Manager-App' } } });
});

test('MO-40: app-list POST admin allowed; client organizationId ignored', async () => {
  const before = await policyStats();
  const api = await import('../src/app/api/app-list/route');
  const res = await api.POST(req(adminAToken, {
    method: 'POST',
    body: { appName: 'Admin-App', listType: 'blacklist', organizationId: orgB.id },
  }));
  assert.equal(res.status, 201, 'admin may add an app policy entry');
  const body = await res.json();
  assert.equal(body.organizationId, orgA.id, 'client organizationId must NEVER move the entry into org B');
  const after = await policyStats();
  assert.equal(after.entries, before.entries + 1, 'exactly one AppListEntry created');
  await db.appListEntry.delete({ where: { id: body.id } });
  await db.auditLog.deleteMany({ where: { resource: 'policy', description: { contains: 'Admin-App' } } });
});

// ─── DELETE /api/app-list/[id] ──────────────────────────────────────────────

test('MO-41: app-list DELETE unauthenticated -> 401, target untouched', async () => {
  const before = await policyStats();
  const api = await import('../src/app/api/app-list/[id]/route');
  const res = await api.DELETE(req(null, { method: 'DELETE', url: `http://localhost:3000/api/app-list/${appEntryA.id}` }), {
    params: Promise.resolve({ id: appEntryA.id }),
  });
  assert.equal(res.status, 401, 'unauthenticated must be rejected');
  const row = await db.appListEntry.findUnique({ where: { id: appEntryA.id } });
  assert.equal(row?.isActive, true, 'entry must remain active');
  const after = await policyStats();
  assert.equal(after.entries, before.entries, 'no AppListEntry mutation');
  assert.equal(after.audits, before.audits, 'no AuditLog created');
});

test('MO-42: app-list DELETE viewer -> 403 and manager -> 403 (admin-only), target untouched', async () => {
  const viewerAToken = await signJWT({ userId: 'viewer-applist2', email: 'viewer.al2@a.test', role: 'viewer', organizationId: orgA.id });
  const managerAToken = await signJWT({ userId: 'manager-applist2', email: 'manager.al2@a.test', role: 'manager', organizationId: orgA.id });
  const before = await policyStats();

  const api = await import('../src/app/api/app-list/[id]/route');
  const params = Promise.resolve({ id: appEntryA.id });

  const viewerRes = await api.DELETE(req(viewerAToken, { method: 'DELETE', url: `http://localhost:3000/api/app-list/${appEntryA.id}` }), { params });
  assert.equal(viewerRes.status, 403, 'viewer must be rejected');

  const managerRes = await api.DELETE(req(managerAToken, { method: 'DELETE', url: `http://localhost:3000/api/app-list/${appEntryA.id}` }), { params });
  assert.equal(managerRes.status, 403, 'manager must be rejected (admin-only route)');

  const row = await db.appListEntry.findUnique({ where: { id: appEntryA.id } });
  assert.equal(row?.isActive, true, 'entry must remain active');
  const after = await policyStats();
  assert.equal(after.entries, before.entries, 'no AppListEntry mutation');
  assert.equal(after.audits, before.audits, 'no AuditLog created');
});

test('MO-43: admin deletes same-org app-list entry -> success, deactivated + audit', async () => {
  const entry = await db.appListEntry.create({
    data: { appName: 'MO-43-App', listType: 'whitelist', organizationId: orgA.id },
  });
  const before = await policyStats();
  const api = await import('../src/app/api/app-list/[id]/route');
  const res = await api.DELETE(req(adminAToken, { method: 'DELETE', url: `http://localhost:3000/api/app-list/${entry.id}` }), {
    params: Promise.resolve({ id: entry.id }),
  });
  assert.equal(res.status, 200, 'own-org admin delete succeeds');
  const body = await res.json();
  assert.equal(body.success, true);
  assert.equal(body.data?.isActive, false, 'soft-delete must deactivate the entry');

  const row = await db.appListEntry.findUnique({ where: { id: entry.id } });
  assert.equal(row?.isActive, false, 'entry persisted as inactive');
  const after = await policyStats();
  assert.equal(after.audits, before.audits + 1, 'exactly one AuditLog for the delete');
  const audit = await db.auditLog.findFirst({
    where: { resource: 'policy', action: 'delete', resourceId: entry.id, organizationId: orgA.id },
  });
  assert.ok(audit, 'audit entry bound to the resource and admin org');
  assert.equal(audit?.userId, 'admin-a', 'audit records the authenticated actor');
  await db.appListEntry.delete({ where: { id: entry.id } });
});

test('MO-44: admin A deleting org B entry -> 404, org B entry stays ACTIVE, zero side effects', async () => {
  const before = await policyStats();
  const api = await import('../src/app/api/app-list/[id]/route');
  const res = await api.DELETE(req(adminAToken, { method: 'DELETE', url: `http://localhost:3000/api/app-list/${appEntryB.id}` }), {
    params: Promise.resolve({ id: appEntryB.id }),
  });
  assert.equal(res.status, 404, 'cross-org entry must be concealed with 404');
  const row = await db.appListEntry.findUnique({ where: { id: appEntryB.id } });
  assert.equal(row?.isActive, true, 'cross-org DELETE must NOT deactivate the target');
  const after = await policyStats();
  assert.equal(after.entries, before.entries, 'no AppListEntry mutation');
  assert.equal(after.audits, before.audits, 'no AuditLog created');
});

test('MO-45: admin deleting nonexistent app-list entry -> 404 and no side effects', async () => {
  const before = await policyStats();
  const api = await import('../src/app/api/app-list/[id]/route');
  const res = await api.DELETE(req(adminAToken, { method: 'DELETE', url: 'http://localhost:3000/api/app-list/cms-nonexistent-entry-0000' }), {
    params: Promise.resolve({ id: 'cms-nonexistent-entry-0000' }),
  });
  assert.equal(res.status, 404, 'nonexistent id must 404');
  const after = await policyStats();
  assert.equal(after.entries, before.entries, 'no AppListEntry mutation');
  assert.equal(after.audits, before.audits, 'no AuditLog created');
});

// ─── P3: notifications mark-all-read must not be a GET side effect ──────────

test('MO-46: notifications GET is read-only (markAllRead param must not mutate)', async () => {
  const api = await import('../src/app/api/notifications/route');
  await db.notification.createMany({
    data: [
      { title: 'MO46-A', message: 'unread A', type: 'system', status: 'unread', organizationId: orgA.id },
      { title: 'MO46-B', message: 'unread B', type: 'system', status: 'unread', organizationId: orgB.id },
    ],
  });

  const res = await api.GET(req(adminAToken, { url: 'http://localhost:3000/api/notifications?markAllRead=true' }));
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.ok(Array.isArray(body.data), 'markAllRead=true must return the list payload, not mutate');

  const aRow = await db.notification.findFirst({ where: { title: 'MO46-A' } });
  assert.equal(aRow?.status, 'unread', 'GET must not mark org A notifications read');
  const bRow = await db.notification.findFirst({ where: { title: 'MO46-B' } });
  assert.equal(bRow?.status, 'unread', 'GET must not mark org B notifications read');

  const plain = await api.GET(req(adminAToken, { url: 'http://localhost:3000/api/notifications' }));
  assert.equal(plain.status, 200);
  const plainBody = await plain.json();
  assert.ok(Array.isArray(plainBody.data), 'plain GET stays read-only list');

  await db.notification.deleteMany({ where: { title: { in: ['MO46-A', 'MO46-B'] } } });
});

test('MO-47: notifications PUT markAllRead marks ONLY the caller org\'s notifications read', async () => {
  const api = await import('../src/app/api/notifications/route');
  await db.notification.createMany({
    data: [
      { title: 'MO47-A', message: 'unread A', type: 'system', status: 'unread', organizationId: orgA.id },
      { title: 'MO47-B', message: 'unread B', type: 'system', status: 'unread', organizationId: orgB.id },
    ],
  });

  const res = await api.PUT(req(adminBToken, {
    method: 'PUT',
    body: { markAllRead: true },
  }));
  assert.equal(res.status, 200, 'PUT markAllRead allowed');
  const aRow = await db.notification.findFirst({ where: { title: 'MO47-A' } });
  assert.equal(aRow?.status, 'unread', 'org A notification must NOT be marked by org B');
  const bRow = await db.notification.findFirst({ where: { title: 'MO47-B' } });
  assert.equal(bRow?.status, 'read', 'org B notification marked read by org B admin');

  await db.notification.deleteMany({ where: { title: { in: ['MO47-A', 'MO47-B'] } } });
});
