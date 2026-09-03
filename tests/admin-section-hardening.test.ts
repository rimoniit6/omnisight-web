/**
 * WorkLensAI — Admin Section P1→P3 Hardening regression suite (MO-ADMIN-01..25).
 *
 * Proves the tenant-isolation, authorization, validation, audit and
 * truthfulness fixes for Organization / Reports / Daily Report / Settings:
 *
 *  MO-ADMIN-01/02  daily report excludes the other org (both directions)
 *  MO-ADMIN-03/04  team heatmap excludes the other org (both directions)
 *  MO-ADMIN-05/06  AI summary uses only caller-org data; client reportData ignored
 *  MO-ADMIN-07/08  cross-org employee/activity PDF → 404
 *  MO-ADMIN-09     audit PDF is organization-scoped
 *  MO-ADMIN-10     cross-org report generation → 404, zero report/audit rows
 *  MO-ADMIN-11/12  org admin cannot mutate global SystemSetting; super_admin can
 *  MO-ADMIN-13     dashboard PDF succeeds (no more 500)
 *  MO-ADMIN-14/15  invalid pagination/dates → 400/422, never 500
 *  MO-ADMIN-16     settings secrets never returned (REDACTED, no ciphertext)
 *  MO-ADMIN-17/18  daily + ai-summary rate-limit rules exist
 *  MO-ADMIN-19/21  no dead custom-PDF UI; no fabricated subscription data
 *  MO-ADMIN-20     reports list pagination + type filter
 *  MO-ADMIN-22     failed mutations create zero audit rows
 *  MO-ADMIN-23/24  successful mutations audited with session actor (no spoofing)
 *  MO-ADMIN-25     client organizationId can never override tenant scope
 *
 * Runs against a THROWAWAY PostgreSQL database (workai_test_adminhardening).
 * Run: npx tsx --test tests/admin-section-hardening.test.ts
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { req } from './helpers/request';
import { localDayKey } from '../src/lib/timezone';

const PG_TEST_BASE = process.env.PG_TEST_BASE_URL || 'postgresql://postgres:123456@localhost:5432';
const TEST_DB_NAME = 'workai_test_adminhardening';
const TEST_DB_URL = `${PG_TEST_BASE}/${TEST_DB_NAME}?schema=public`;

process.env.DATABASE_URL = TEST_DB_URL;
process.env.DIRECT_URL = TEST_DB_URL;
process.env.JWT_SECRET = 'test-jwt-secret-adminhardening-0123456789abc';
process.env.SUPER_ADMIN_EMAIL = 'root@adminhardening.local';
process.env.SUPER_ADMIN_PASSWORD = 'S3cure!AdminHardening2026x';
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
let deptA: { id: string };
let deptB: { id: string };
let empA: { id: string };
let empB: { id: string };
let adminAToken: string;
let adminBToken: string;
let managerAToken: string;
let managerBToken: string;
let viewerAToken: string;
let superAdminToken: string;


before(async () => {
  const dbModule = await import('../src/lib/db');
  db = dbModule.db;
  signJWT = (await import('../src/lib/auth')).signJWT;

  orgA = await db.organization.create({ data: { name: 'Hardening Org A', slug: 'hardening-org-a' } });
  orgB = await db.organization.create({ data: { name: 'Hardening Org B', slug: 'hardening-org-b' } });

  deptA = await db.department.create({ data: { name: 'PROBE-A-ENG', organizationId: orgA.id } });
  deptB = await db.department.create({ data: { name: 'PROBE-B-ENG', organizationId: orgB.id } });

  empA = await db.employee.create({
    data: {
      employeeId: 'PROBE-A-EMPLOYEE', firstName: 'PROBE-A', lastName: 'Employee',
      email: 'probe-a@a.test', organizationId: orgA.id, departmentId: deptA.id,
      status: 'active', agentApproved: true,
    },
  });
  empB = await db.employee.create({
    data: {
      employeeId: 'PROBE-B-EMPLOYEE', firstName: 'PROBE-B', lastName: 'Employee',
      email: 'probe-b@b.test', organizationId: orgB.id, departmentId: deptB.id,
      status: 'active', agentApproved: true,
    },
  });

  // Org A: ONE productive activity (3600s). Org B: an extreme 50,000s
  // unproductive block — any cross-org leak collapses Org A's score.
  await db.activity.createMany({
    data: [
      { employeeId: empA.id, type: 'application', applicationName: 'PROBE-A-APP', category: 'productive', duration: 3600, timestamp: new Date() },
      { employeeId: empB.id, type: 'application', applicationName: 'PROBE-B-APP', category: 'unproductive', duration: 50000, timestamp: new Date() },
    ],
  });

  await db.alert.createMany({
    data: [
      { title: 'PROBE-A-ALERT', description: 'org a alert', type: 'system', organizationId: orgA.id, createdAt: new Date() },
      { title: 'PROBE-B-ALERT', description: 'org b alert', type: 'system', organizationId: orgB.id, createdAt: new Date() },
    ],
  });

  await db.screenshot.createMany({
    data: [
      { employeeId: empA.id, organizationId: orgA.id, filePath: '/uploads/screenshots/a.png', fileName: 'a.png', fileSize: 10, mimeType: 'image/png', capturedAt: new Date() },
      { employeeId: empB.id, organizationId: orgB.id, filePath: '/uploads/screenshots/b.png', fileName: 'b.png', fileSize: 10, mimeType: 'image/png', capturedAt: new Date() },
    ],
  });

  await db.auditLog.createMany({
    data: [
      { action: 'login', resource: 'auth', description: 'PROBE-A-AUDIT', userId: 'user-a', organizationId: orgA.id, createdAt: new Date() },
      { action: 'login', resource: 'auth', description: 'PROBE-B-AUDIT', userId: 'user-b', organizationId: orgB.id, createdAt: new Date() },
    ],
  });

  adminAToken = await signJWT({ userId: 'admin-a', email: 'admin@a.test', role: 'admin', organizationId: orgA.id });
  adminBToken = await signJWT({ userId: 'admin-b', email: 'admin@b.test', role: 'admin', organizationId: orgB.id });
  managerAToken = await signJWT({ userId: 'mgr-a', email: 'mgr@a.test', role: 'manager', organizationId: orgA.id });
  managerBToken = await signJWT({ userId: 'mgr-b', email: 'mgr@b.test', role: 'manager', organizationId: orgB.id });
  viewerAToken = await signJWT({ userId: 'viewer-a', email: 'viewer@a.test', role: 'viewer', organizationId: orgA.id });
  superAdminToken = await signJWT({ userId: 'super-g', email: 'super@global.test', role: 'super_admin' });
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

// Org-local day key (orgs default to Asia/Dhaka). The daily-report routes
// bucket by the ORG-LOCAL calendar day — a UTC day key would shift after
// 18:00 UTC (Dhaka midnight) and make these assertions time-of-day dependent.
const today = () => localDayKey(new Date(), 'Asia/Dhaka');

// ==================== Daily report isolation ====================

test('MO-ADMIN-01: org A daily report excludes org B data', async () => {
  const api = await import('../src/app/api/reports/daily/route');
  const res = await api.POST(req(managerAToken, { method: 'POST', body: { date: today() } }));
  assert.equal(res.status, 200, `daily report must succeed, got ${res.status}`);
  const body = await res.json();

  assert.equal(body.summary.totalActivities, 1, 'only org A activity counted');
  assert.equal(body.summary.productivityScore, 100, 'org A score unaffected by org B 50,000s block');
  assert.equal(body.summary.alertsCount, 1, 'only org A alert counted');
  assert.equal(body.summary.screenshotsCount, 1, 'only org A screenshot counted');

  const serialized = JSON.stringify(body);
  assert.ok(!serialized.includes('PROBE-B'), 'no org B token anywhere in the report');
  assert.ok(serialized.includes('PROBE-A-APP'), 'org A app present');
});

test('MO-ADMIN-02: org B daily report excludes org A data', async () => {
  const api = await import('../src/app/api/reports/daily/route');
  const res = await api.POST(req(managerBToken, { method: 'POST', body: { date: today() } }));
  assert.equal(res.status, 200, `daily report must succeed, got ${res.status}`);
  const body = await res.json();

  assert.equal(body.summary.totalActivities, 1, 'only org B activity counted');
  assert.equal(body.summary.alertsCount, 1, 'only org B alert counted');
  assert.equal(body.summary.screenshotsCount, 1, 'only org B screenshot counted');
  const serialized = JSON.stringify(body);
  assert.ok(!serialized.includes('PROBE-A'), 'no org A token anywhere in the report');
  assert.ok(serialized.includes('PROBE-B-APP'), 'org B app present');
});

// ==================== Team heatmap isolation ====================

test('MO-ADMIN-03: org A team heatmap excludes org B departments', async () => {
  const api = await import('../src/app/api/organization/team-data/route');
  const res = await api.GET(req(adminAToken, { url: 'http://localhost:3000/api/organization/team-data' }));
  assert.equal(res.status, 200);
  const body = await res.json();

  const deptNames = body.departments.map((d: { name: string }) => d.name);
  assert.ok(deptNames.includes('PROBE-A-ENG'), 'org A department present');
  assert.ok(!deptNames.includes('PROBE-B-ENG'), 'org B department must not leak');
  const serialized = JSON.stringify(body);
  assert.ok(!serialized.includes('PROBE-B'), 'no org B token in heatmap payload');
});

test('MO-ADMIN-04: org B team heatmap excludes org A departments', async () => {
  const api = await import('../src/app/api/organization/team-data/route');
  const res = await api.GET(req(adminBToken, { url: 'http://localhost:3000/api/organization/team-data' }));
  assert.equal(res.status, 200);
  const body = await res.json();

  const deptNames = body.departments.map((d: { name: string }) => d.name);
  assert.ok(deptNames.includes('PROBE-B-ENG'), 'org B department present');
  assert.ok(!deptNames.includes('PROBE-A-ENG'), 'org A department must not leak');
});

// ==================== AI summary isolation ====================

test('MO-ADMIN-05: AI summary uses only the caller org data', async () => {
  const api = await import('../src/app/api/reports/daily/ai-summary/route');
  const res = await api.POST(req(managerAToken, { method: 'POST', body: { date: today() } }));
  assert.equal(res.status, 200, `ai-summary must succeed, got ${res.status}`);
  const body = await res.json();

  assert.equal(body.reportSnapshot.summary.totalActivities, 1, 'org B activities must not count');
  assert.equal(body.reportSnapshot.summary.productivityScore, 100, 'org B 50,000s block must not collapse org A score');
  const serialized = JSON.stringify(body);
  assert.ok(!serialized.includes('PROBE-B'), 'no org B token reaches the AI prompt data');
});

test('MO-ADMIN-06: client reportData cannot override authoritative metrics', async () => {
  const api = await import('../src/app/api/reports/daily/ai-summary/route');
  // Forged payload: an attacker tries to inject 999 activities, 50000 screenshots
  // and a 1% score. The server must ignore it and recompute from org A DB data.
  const forged = {
    date: today(),
    reportData: {
      summary: {
        totalEmployees: 999,
        totalActivities: 999,
        totalWorkingMinutes: 99999,
        productivityScore: 1,
        alertsCount: 999,
        screenshotsCount: 999,
        flaggedScreenshots: 999,
        onlineDevices: 999,
      },
    },
  };
  const res = await api.POST(req(managerAToken, { method: 'POST', body: forged }));
  assert.equal(res.status, 200);
  const body = await res.json();

  const s = body.reportSnapshot.summary;
  assert.equal(s.totalActivities, 1, 'forged activity count ignored');
  assert.equal(s.productivityScore, 100, 'forged score ignored');
  assert.equal(s.alertsCount, 1, 'forged alert count ignored');
  assert.equal(s.screenshotsCount, 1, 'forged screenshot count ignored');
});

// ==================== PDF exports ====================

test('MO-ADMIN-07: cross-org employee PDF returns 404', async () => {
  const api = await import('../src/app/api/reports/pdf/employee/route');
  const res = await api.POST(req(adminAToken, { method: 'POST', body: { employeeId: empB.id } }));
  assert.equal(res.status, 404, 'org A admin must not get org B employee PDF');
  // Same-org request still works.
  const own = await api.POST(req(adminAToken, { method: 'POST', body: { employeeId: empA.id } }));
  assert.equal(own.status, 200, 'own-org employee PDF must still work');
  assert.equal(own.headers.get('content-type'), 'application/pdf');
});

test('MO-ADMIN-08: cross-org activity PDF returns 404', async () => {
  const api = await import('../src/app/api/reports/pdf/activity/route');
  const cross = await api.POST(req(adminAToken, { method: 'POST', body: { employeeId: empB.id } }));
  assert.equal(cross.status, 404, 'foreign employeeId must be concealed with 404');
  // Foreign department names must not enumerate org B employees.
  const deptProbe = await api.POST(req(adminAToken, { method: 'POST', body: { department: 'PROBE-B-ENG' } }));
  assert.equal(deptProbe.status, 200, 'unknown-in-org department yields an empty PDF, not foreign data');
  const own = await api.POST(req(adminAToken, { method: 'POST', body: { employeeId: empA.id } }));
  assert.equal(own.status, 200, 'own-org activity PDF still works');
});

test('MO-ADMIN-09: audit PDF is organization-scoped', async () => {
  const api = await import('../src/app/api/reports/pdf/audit/route');
  // Org A admin filtering on org B's user → zero rows → minimal PDF.
  const foreignUser = await api.POST(req(adminAToken, { method: 'POST', body: { user: 'user-b' } }));
  assert.equal(foreignUser.status, 200);
  const foreignBytes = Buffer.from(await foreignUser.arrayBuffer());
  // Same filter for org B's own admin → one row → measurably larger PDF.
  const ownUser = await api.POST(req(adminBToken, { method: 'POST', body: { user: 'user-b' } }));
  const ownBytes = Buffer.from(await ownUser.arrayBuffer());
  assert.ok(foreignBytes.length < ownBytes.length, 'foreign-user audit PDF must contain fewer rows than own-org');
  // A full unfiltered org B export is larger still (proves the filter ran).
  const fullB = await api.POST(req(adminBToken, { method: 'POST', body: {} }));
  const fullBBytes = Buffer.from(await fullB.arrayBuffer());
  assert.ok(ownBytes.length < fullBBytes.length, 'filtered export smaller than unfiltered');
});

// ==================== Report generation ====================

test('MO-ADMIN-10: cross-org report generation returns 404 and creates nothing', async () => {
  const api = await import('../src/app/api/reports/generate/route');
  const reportBefore = await db.report.count({ where: { organizationId: orgA.id } });
  const auditBefore = await db.auditLog.count({ where: { organizationId: orgA.id } });

  const res = await api.POST(req(managerAToken, { method: 'POST', body: { type: 'employee', employeeId: empB.id } }));
  assert.equal(res.status, 404, 'foreign employee must be concealed with 404');

  assert.equal(await db.report.count({ where: { organizationId: orgA.id } }), reportBefore, 'no report created');
  assert.equal(await db.auditLog.count({ where: { organizationId: orgA.id } }), auditBefore, 'no audit row on failed generation');
});

test('MO-ADMIN-23: successful generation is audited with the session actor', async () => {
  const api = await import('../src/app/api/reports/generate/route');
  const res = await api.POST(req(managerAToken, { method: 'POST', body: { type: 'activity' } }));
  assert.equal(res.status, 201);
  const body = await res.json();
  const audit = await db.auditLog.findFirst({
    where: { resource: 'report', resourceId: body.data.id, organizationId: orgA.id },
  });
  assert.ok(audit, 'generation must be audited');
  assert.equal(audit!.userId, 'mgr-a', 'actor = verified session user');
  assert.equal(audit!.organizationId, orgA.id, 'organization = verified session org');
});

test('MO-ADMIN-24: client userId cannot spoof the audit actor', async () => {
  const api = await import('../src/app/api/reports/route');
  const res = await api.POST(req(managerAToken, {
    method: 'POST',
    body: { title: 'Spoof Attempt', type: 'activity', userId: 'attacker-spoofed-id', organizationId: orgB.id },
  }));
  assert.equal(res.status, 201);
  const body = await res.json();
  const audit = await db.auditLog.findFirst({ where: { resource: 'report', resourceId: body.data.id } });
  assert.ok(audit, 'audit row created');
  assert.equal(audit!.userId, 'mgr-a', 'actor always comes from the session, never the body');
  assert.equal(audit!.organizationId, orgA.id, 'org always comes from the session');
});

test('MO-ADMIN-25: client organizationId can never override tenant scope', async () => {
  const api = await import('../src/app/api/reports/route');
  const before = await db.report.count({ where: { organizationId: orgB.id } });
  const res = await api.POST(req(managerAToken, {
    method: 'POST',
    body: { title: 'Tenant Override Attempt', type: 'activity', organizationId: orgB.id },
  }));
  assert.equal(res.status, 201);
  const body = await res.json();
  assert.equal(body.data.organizationId, orgA.id, 'report persisted to the SESSION org, not the client-supplied org');
  assert.equal(await db.report.count({ where: { organizationId: orgB.id } }), before, 'org B untouched');
});

// ==================== Global settings ====================

test('MO-ADMIN-11: org admin cannot mutate instance-global SystemSetting (403)', async () => {
  const api = await import('../src/app/api/settings/route');
  const before = await db.systemSetting.count({ where: { key: '_probe_global' } });
  for (const token of [viewerAToken, managerAToken, adminAToken, adminBToken]) {
    const res = await api.PUT(req(token, { method: 'PUT', body: { key: '_probe_global', value: 'x' } }));
    assert.equal(res.status, 403, 'org-bound/non-super roles must be rejected');
  }
  assert.equal(await db.systemSetting.count({ where: { key: '_probe_global' } }), before, 'no global row written');
});

test('MO-ADMIN-12: super_admin can mutate global settings with audit attribution', async () => {
  const api = await import('../src/app/api/settings/route');
  const res = await api.PUT(req(superAdminToken, { method: 'PUT', body: { key: '_probe_global', value: 'ok' } }));
  assert.equal(res.status, 200, 'super_admin write allowed');
  const row = await db.systemSetting.findUnique({ where: { key: '_probe_global' } });
  assert.ok(row && row.value === 'ok', 'global row written');
  const audit = await db.auditLog.findFirst({
    where: { resource: 'settings', description: { contains: '_probe_global' } },
  });
  assert.ok(audit, 'global settings write is audited');
  assert.equal(audit!.userId, 'super-g', 'audit actor = verified super_admin');
  await db.systemSetting.delete({ where: { key: '_probe_global' } });
  await db.auditLog.deleteMany({ where: { id: audit!.id } });
});

// ==================== Dashboard PDF ====================

test('MO-ADMIN-13: dashboard PDF succeeds for org-bound admins (no more 500)', async () => {
  const api = await import('../src/app/api/reports/pdf/dashboard/route');
  const res = await api.POST(req(adminAToken, { method: 'POST', body: {} }));
  assert.equal(res.status, 200, `dashboard PDF must succeed, got ${res.status}`);
  assert.equal(res.headers.get('content-type'), 'application/pdf');

  const resB = await api.POST(req(adminBToken, { method: 'POST', body: {} }));
  assert.equal(resB.status, 200, 'org B dashboard PDF must succeed too');
});

// ==================== Input validation ====================

test('MO-ADMIN-14: invalid pagination returns 422, never 500', async () => {
  const reports = await import('../src/app/api/reports/route');
  for (const q of ['page=abc', 'page=0', 'page=-1', 'pageSize=abc', 'pageSize=0', 'pageSize=-1', 'pageSize=999999']) {
    const res = await reports.GET(req(managerAToken, { url: `http://localhost:3000/api/reports?${q}` }));
    assert.equal(res.status, 422, `?${q} must be 422`);
  }
  const ok = await reports.GET(req(managerAToken, { url: 'http://localhost:3000/api/reports?page=1&pageSize=10' }));
  assert.equal(ok.status, 200, 'valid pagination still works');

  const auditLogs = await import('../src/app/api/audit-logs/route');
  const bad = await auditLogs.GET(req(adminAToken, { url: 'http://localhost:3000/api/audit-logs?page=abc' }));
  assert.equal(bad.status, 422, 'audit-logs garbage page must be 422');
});

test('MO-ADMIN-15: invalid dates return 422, never 500', async () => {
  const daily = await import('../src/app/api/reports/daily/route');
  assert.equal((await daily.POST(req(managerAToken, { method: 'POST', body: { date: 'not-a-date' } }))).status, 422);
  assert.equal((await daily.POST(req(managerAToken, { method: 'POST' }))).status, 400, 'empty body is a client error');

  const generate = await import('../src/app/api/reports/generate/route');
  assert.equal(
    (await generate.POST(req(managerAToken, { method: 'POST', body: { type: 'activity', periodStart: 'garbage' } }))).status,
    422
  );

  const auditPdf = await import('../src/app/api/reports/pdf/audit/route');
  assert.equal((await auditPdf.POST(req(managerAToken, { method: 'POST', body: { dateFrom: 'garbage' } }))).status, 422);

  const reports = await import('../src/app/api/reports/route');
  assert.equal(
    (await reports.POST(req(managerAToken, { method: 'POST', body: { title: 'x', type: 'activity', startDate: 'garbage' } }))).status,
    422
  );

  const employeePdf = await import('../src/app/api/reports/pdf/employee/route');
  assert.equal(
    (await employeePdf.POST(req(managerAToken, { method: 'POST', body: { employeeId: empA.id, dateFrom: 'garbage' } }))).status,
    422
  );
});

test('MO-ADMIN-15b: reports POST rejects unknown type/format (allowlist)', async () => {
  const api = await import('../src/app/api/reports/route');
  const badType = await api.POST(req(managerAToken, { method: 'POST', body: { title: 'x', type: 'exec-sql' } }));
  assert.equal(badType.status, 422, 'free-form report type must be rejected');
  const badFormat = await api.POST(req(managerAToken, { method: 'POST', body: { title: 'x', type: 'activity', format: 'xml' } }));
  assert.equal(badFormat.status, 422, 'free-form format must be rejected');
});

// ==================== Secrets ====================

test('MO-ADMIN-16: settings secrets are never returned (REDACTED, no ciphertext)', async () => {
  const api = await import('../src/app/api/settings/route');
  const put = await api.PUT(req(superAdminToken, { method: 'PUT', body: { key: 'ai_api_key', value: 'sk-probe-1234567890abcdef' } }));
  assert.equal(put.status, 200);
  const putBody = await put.json();
  assert.equal(putBody.data.value, 'REDACTED', 'PUT response redacts the secret');

  const get = await api.GET(req(adminAToken));
  const getBody = await get.json();
  const row = (getBody.data as Array<{ key: string; value: string }>).find((s) => s.key === 'ai_api_key');
  assert.equal(row?.value, 'REDACTED', 'GET redacts the secret');
  const serialized = JSON.stringify(getBody);
  assert.ok(!serialized.includes('sk-probe-1234567890abcdef'), 'plaintext never leaves the server');

  await db.systemSetting.delete({ where: { key: 'ai_api_key' } });
});

// ==================== Rate limits ====================

test('MO-ADMIN-17/18: daily + ai-summary rate-limit rules exist', async () => {
  const proxy = await import('../src/proxy');
  const rules = proxy.__RATE_RULES_FOR_TESTS as Array<{ prefix: string; methods?: string[]; limit: number; keyBy: string }>;
  const daily = rules.find((r) => r.prefix === '/api/reports/daily');
  const ai = rules.find((r) => r.prefix === '/api/reports/daily/ai-summary');
  assert.ok(daily && daily.methods?.includes('POST') && daily.limit <= 10, 'daily report rate limited');
  assert.ok(ai && ai.methods?.includes('POST') && ai.limit <= 10, 'ai-summary rate limited');
});

// ==================== Reports pagination ====================

test('MO-ADMIN-20: reports list pagination + type filter + total', async () => {
  for (let i = 0; i < 3; i++) {
    await db.report.create({
      data: { title: `Pager ${i}`, type: 'device', format: 'csv', status: 'generated', organizationId: orgA.id },
    });
  }
  const api = await import('../src/app/api/reports/route');
  const res = await api.GET(req(managerAToken, { url: 'http://localhost:3000/api/reports?type=device&page=1&pageSize=2' }));
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.total, 3, 'total matches the FILTERED dataset');
  assert.equal(body.data.length, 2, 'pageSize respected');
  assert.equal(body.totalPages, 2, 'totalPages computed');
  assert.equal(body.page, 1);
  assert.equal(body.pageSize, 2);
});

// ==================== Truthful UI (source-level guards) ====================

test('MO-ADMIN-19: custom PDF UI no longer references a dead endpoint', () => {
  const source = readFileSync('src/components/reports/reports-page.tsx', 'utf8');
  assert.ok(!source.includes('/api/reports/pdf/custom'), 'dead custom-PDF endpoint reference removed');
});

test('MO-ADMIN-21: subscription UI does not fabricate business data', () => {
  const source = readFileSync('src/components/organization/organization-page.tsx', 'utf8');
  assert.ok(!source.includes('Enterprise Plan'), 'hardcoded plan removed');
  assert.ok(!source.includes('Renews Dec 31'), 'hardcoded renewal date removed');
  assert.ok(!source.includes('365 days'), 'hardcoded retention removed');
  assert.ok(!source.includes('Full Access'), 'hardcoded API access removed');
});

// ==================== Failed mutations ====================

test('MO-ADMIN-22: failed mutations create zero audit rows', async () => {
  const api = await import('../src/app/api/settings/route');
  const before = await db.auditLog.count({ where: { organizationId: orgA.id } });

  // Cross-org generate (already covered in MO-ADMIN-10) + org-admin settings
  // write — both must leave the audit log untouched.
  const put = await api.PUT(req(adminAToken, { method: 'PUT', body: { key: 'company_name', value: 'X' } }));
  assert.equal(put.status, 403);

  assert.equal(await db.auditLog.count({ where: { organizationId: orgA.id } }), before, 'no audit row for failed writes');
});
