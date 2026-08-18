/**
 * Monitoring-agent exclusion from employee activity data.
 *
 * The WorkLensAI monitoring agent's own process (WorkLensAIAgent.exe) must
 * NEVER be counted as employee application activity — zero usage count, zero
 * duration — across Top Applications & Websites, activity summaries, reports,
 * analytics, exports, and team comparison. Exclusion is case-insensitive and
 * applied at the DATA layer (src/lib/agent-process.ts + every aggregation
 * route), never by hiding rows in the UI.
 *
 * Runs against a THROWAWAY PostgreSQL database (workai_test_agentproc).
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';
import { NextRequest } from 'next/server';

const PG_TEST_BASE = process.env.PG_TEST_BASE_URL || 'postgresql://postgres:123456@localhost:5432';
const TEST_DB_NAME = 'workai_test_agentproc';
const TEST_DB_URL = `${PG_TEST_BASE}/${TEST_DB_NAME}?schema=public`;

process.env.DATABASE_URL = TEST_DB_URL;
process.env.DIRECT_URL = TEST_DB_URL;
process.env.JWT_SECRET = 'test-jwt-secret-agentproc-0123456789abcdef';
process.env.SUPER_ADMIN_EMAIL = 'root@agentproc.local';
process.env.SUPER_ADMIN_PASSWORD = 'S3cure!AgentProc2026x';
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
let employee: { id: string };
let adminToken: string;
let managerToken: string;

before(async () => {
  const dbModule = await import('../src/lib/db');
  db = dbModule.db;
  signJWT = (await import('../src/lib/auth')).signJWT;

  org = await db.organization.create({ data: { name: 'Agent Proc Org', slug: 'agent-proc-org' } });
  employee = await db.employee.create({
    data: {
      employeeId: 'EMP-AGENTPROC-1',
      firstName: 'Ada',
      lastName: 'Lovelace',
      email: 'ada@agentproc.test',
      organizationId: org.id,
      status: 'active',
    },
  });

  // Historical activity records: the agent's own process (three casings) plus
  // legitimate applications. These simulate pre-fix rows already in the DB —
  // the aggregation layer must exclude them without touching the stored data.
  const now = new Date();
  const mk = (applicationName: string, duration: number, category = 'neutral') =>
    db.activity.create({
      data: {
        type: 'application',
        title: null,
        applicationName,
        category,
        duration,
        employeeId: employee.id,
        timestamp: now,
      },
    });
  await mk('WorkLensAIAgent.exe', 3600);
  await mk('worklensaiagent.exe', 1800);
  await mk('WORKLENSAIAGENT.EXE', 900);
  await mk('chrome.exe', 1200);
  await mk('Code.exe', 900, 'productive');
  await mk('Excel', 600);

  adminToken = await signJWT({ userId: 'admin-agentproc', email: 'admin@agentproc.test', role: 'admin', organizationId: org.id });
  managerToken = await signJWT({ userId: 'manager-agentproc', email: 'manager@agentproc.test', role: 'manager', organizationId: org.id });
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

function params(id: string): { params: Promise<{ id: string }> } {
  return { params: Promise.resolve({ id }) };
}

const AGENT_NAMES = ['worklensaiagent.exe', 'WorkLensAIAgent.exe', 'WORKLENSAIAGENT.EXE'];

function hasAgentName(value: unknown): boolean {
  return typeof value === 'string' && AGENT_NAMES.includes(value.toLowerCase());
}

test('AP-1: isInternalAgentProcess is case-insensitive and never matches legitimate apps', async () => {
  const { isInternalAgentProcess } = await import('../src/lib/agent-process');
  assert.equal(isInternalAgentProcess('WorkLensAIAgent.exe'), true);
  assert.equal(isInternalAgentProcess('worklensaiagent.exe'), true);
  assert.equal(isInternalAgentProcess('WORKLENSAIAGENT.EXE'), true);
  assert.equal(isInternalAgentProcess('chrome.exe'), false);
  assert.equal(isInternalAgentProcess('Code.exe'), false);
  assert.equal(isInternalAgentProcess('Excel'), false);
  assert.equal(isInternalAgentProcess(null), false);
  assert.equal(isInternalAgentProcess(undefined), false);
  assert.equal(isInternalAgentProcess(''), false);
});

test('AP-2: excludeInternalAgentActivities keeps legitimate apps only (zero agent count/duration)', async () => {
  const { excludeInternalAgentActivities } = await import('../src/lib/agent-process');
  const rows = [
    { applicationName: 'WorkLensAIAgent.exe', duration: 3600 },
    { applicationName: 'chrome.exe', duration: 1200 },
    { applicationName: 'WORKLENSAIAGENT.EXE', duration: 900 },
    { applicationName: null, duration: 300 },
    { applicationName: 'Code.exe', duration: 900 },
  ];
  const kept = excludeInternalAgentActivities(rows);
  assert.deepEqual(
    kept.map((r) => r.applicationName),
    ['chrome.exe', null, 'Code.exe']
  );
  assert.equal(
    kept.reduce((s, r) => s + r.duration, 0),
    1200 + 300 + 900,
    'excluded agent rows contribute zero duration'
  );
});

test('AP-3: Analytics Top Applications & Websites never contains the agent process', async () => {
  const api = await import('../src/app/api/analytics/route');
  const res = await api.GET(req(adminToken, { url: 'http://localhost:3000/api/analytics?period=week' }));
  assert.equal(res.status, 200);
  const body = await res.json();
  const topApps = body.data.topApps as Array<{ name: string; durationMinutes: number }>;

  for (const app of topApps) {
    assert.equal(hasAgentName(app.name), false, `agent process leaked into top apps: ${app.name}`);
  }
  const names = topApps.map((a) => a.name);
  assert.ok(names.includes('chrome.exe'), 'Chrome must still be counted');
  assert.ok(names.includes('Code.exe'), 'Code.exe must still be counted');
  assert.ok(names.includes('Excel'), 'Excel must still be counted');

  // Only the 3 legitimate application rows are counted — agent rows contribute 0.
  assert.equal(body.data.summary.totalActivities, 3, 'agent rows must not count toward activity totals');
});

test('AP-4: Employee detail Top Applications excludes the agent process', async () => {
  const api = await import('../src/app/api/employees/[id]/detail/route');
  const res = await api.GET(
    req(adminToken, { url: `http://localhost:3000/api/employees/${employee.id}/detail` }),
    params(employee.id)
  );
  assert.equal(res.status, 200);
  const body = await res.json();
  const topApps = body.topApplications as Array<{ name: string }>;
  assert.ok(topApps.length >= 3, 'legitimate apps must still be listed');
  for (const app of topApps) {
    assert.equal(hasAgentName(app.name), false, `agent process leaked into detail top apps: ${app.name}`);
  }
  assert.equal(body.range.totalActivities, 3, 'range totals exclude agent rows');
  assert.equal(body.allTime.totalActivities, 3, 'all-time totals exclude agent rows');
});

test('AP-5: Employee performance Top Applications excludes the agent process', async () => {
  const api = await import('../src/app/api/employees/[id]/performance/route');
  const res = await api.GET(
    req(adminToken, { url: `http://localhost:3000/api/employees/${employee.id}/performance` }),
    params(employee.id)
  );
  assert.equal(res.status, 200);
  const body = await res.json();
  const topApps = body.performance.topApplications as Array<{ name: string }>;
  for (const app of topApps) {
    assert.equal(hasAgentName(app.name), false, `agent process leaked into performance top apps: ${app.name}`);
  }
  assert.ok(topApps.some((a) => a.name === 'chrome.exe'), 'Chrome must remain a top application');
});

test('AP-6: Activities feed never returns agent rows and totals exclude them', async () => {
  const api = await import('../src/app/api/activities/route');
  const res = await api.GET(req(adminToken, { url: 'http://localhost:3000/api/activities?pageSize=50' }));
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.total, 3, 'feed total excludes the 3 agent rows');
  for (const row of body.data as Array<{ applicationName: string | null }>) {
    assert.equal(hasAgentName(row.applicationName), false, 'agent row must not appear in the activity feed');
  }
});

test('AP-7: generated activity report top applications exclude the agent process', async () => {
  const api = await import('../src/app/api/reports/generate/route');
  const res = await api.POST(req(managerToken, { method: 'POST', body: { type: 'activity' } }));
  assert.equal(res.status, 201);
  const body = await res.json();
  const reportData = JSON.parse(body.data.data as string) as {
    summary: { totalActivities: number; uniqueApps: number };
    topApplications: Array<{ name: string }>;
  };
  assert.ok(reportData.topApplications.length >= 3, 'legitimate apps must appear in the report');
  for (const app of reportData.topApplications) {
    assert.equal(hasAgentName(app.name), false, `agent process leaked into report: ${app.name}`);
  }
  assert.equal(reportData.summary.totalActivities, 3, 'report activity count excludes agent rows');
  assert.equal(reportData.summary.uniqueApps, 3, 'report unique-app count excludes agent rows');
});

test('AP-8: daily report per-employee top apps exclude the agent process', async () => {
  const api = await import('../src/app/api/reports/daily/route');
  const res = await api.POST(req(managerToken, { method: 'POST', body: {} }));
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.summary.totalActivities, 3, 'daily summary excludes agent rows');
  const stats = body.employeeStats as Array<{ topApps: Array<{ app: string }> }>;
  for (const emp of stats) {
    for (const t of emp.topApps) {
      assert.equal(hasAgentName(t.app), false, `agent process leaked into daily top apps: ${t.app}`);
    }
  }
});

test('AP-10: CSV from STORED report JSON excludes the agent process', async () => {
  // A report snapshot generated before the exclusion fix still contains the
  // agent name under topApplications[].name — the CSV path must filter it.
  const stored = await db.report.create({
    data: {
      title: 'Stored Agent Report',
      type: 'activity',
      format: 'csv',
      status: 'generated',
      organizationId: org.id,
      data: JSON.stringify({
        summary: { totalActivities: 4, totalHours: 3, uniqueApps: 4, uniqueWebsites: 0 },
        categoryDistribution: [],
        topApplications: [
          { name: 'WorkLensAIAgent.exe', hours: 1, percentage: 33 },
          { name: 'chrome.exe', hours: 2, percentage: 67 },
        ],
        topWebsites: [],
      }),
    },
  });
  const api = await import('../src/app/api/reports/[id]/csv/route');
  const res = await api.GET(
    req(managerToken, { url: `http://localhost:3000/api/reports/${stored.id}/csv` }),
    params(stored.id)
  );
  assert.equal(res.status, 200);
  const csv = await res.text();
  // The agent process must never appear in stored-report CSV, in any casing.
  assert.ok(!/worklensaiagent/i.test(csv), 'agent process must never appear in stored-report CSV');
  assert.ok(csv.trim().length > 0, 'CSV is still generated from the stored report data');
});

test('AP-9: activity export rows exclude the agent process', async () => {
  const report = await db.report.create({
    data: {
      title: 'Activity Export',
      type: 'activity',
      format: 'xlsx',
      status: 'generated',
      organizationId: org.id,
      periodStart: new Date(Date.now() - 24 * 3600 * 1000),
      periodEnd: new Date(),
    },
  });
  const api = await import('../src/app/api/reports/[id]/export/route');
  const res = await api.GET(
    req(managerToken, { url: `http://localhost:3000/api/reports/${report.id}/export` }),
    params(report.id)
  );
  assert.equal(res.status, 200);
  const body = await res.json();
  const rows = body.data as Array<{ Application: string }>;
  assert.ok(rows.length >= 3, 'legitimate rows must be exported');
  for (const row of rows) {
    assert.equal(hasAgentName(row.Application), false, `agent process leaked into export: ${row.Application}`);
  }
});
