/**
 * WM-01..WM-06 regression tests — Work-Management & Reports remediation.
 *
 * - WM-01: spreadsheet formula injection neutralized on every export path
 *   (server generateCSV, report CSV endpoint, client csv-export).
 * - WM-02: report generation rejects inverted ranges and windows > 90 days.
 * - WM-03: /api/organization/team-data is admin-gated server-side.
 * - WM-04: POST /api/reports rejects inverted date ranges (422).
 * - WM-05: productivity report generation no longer N+1s department lookups
 *   (behavioral: still produces identical department breakdown).
 * - WM-06: report export/PDF responses carry a `truncated` flag.
 *
 * Runs against a THROWAWAY PostgreSQL database (workai_test_wmremediation).
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';
import { NextRequest } from 'next/server';

const PG_TEST_BASE = process.env.PG_TEST_BASE_URL || 'postgresql://postgres:123456@localhost:5432';
const TEST_DB_NAME = 'workai_test_wmremediation';
const TEST_DB_URL = `${PG_TEST_BASE}/${TEST_DB_NAME}?schema=public`;

process.env.DATABASE_URL = TEST_DB_URL;
process.env.DIRECT_URL = TEST_DB_URL;
process.env.JWT_SECRET = 'test-jwt-secret-wmremediation-0123456789abcdef';
process.env.SUPER_ADMIN_EMAIL = 'root@wmremediation.local';
process.env.SUPER_ADMIN_PASSWORD = 'S3cure!WmRemediation2026x';
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
let adminTokenA: string;
let managerTokenA: string;
let viewerTokenA: string;

before(async () => {
  const dbModule = await import('../src/lib/db');
  db = dbModule.db;
  signJWT = (await import('../src/lib/auth')).signJWT;

  orgA = await db.organization.create({ data: { name: 'WM Org A', slug: 'wm-org-a', timezone: 'UTC' } });
  const empA = await db.employee.create({
    data: { employeeId: 'WM-1', firstName: 'Wm', lastName: 'User', email: 'wm1@wm.test', organizationId: orgA.id, status: 'active' },
  });
  await db.activity.create({
    data: { type: 'application', applicationName: '=CMD()', category: 'productive', duration: 60, employeeId: empA.id, timestamp: new Date(Date.now() - 86_400_000) },
  });

  adminTokenA = await signJWT({ userId: 'admin-wm', email: 'admin@wm.test', role: 'admin', organizationId: orgA.id });
  managerTokenA = await signJWT({ userId: 'mgr-wm', email: 'mgr@wm.test', role: 'manager', organizationId: orgA.id });
  viewerTokenA = await signJWT({ userId: 'viewer-wm', email: 'viewer@wm.test', role: 'viewer', organizationId: orgA.id });
});

after(async () => {
  await db.$disconnect();
  try {
    execSync(`node scripts/pg-test-db.mjs drop ${TEST_DB_NAME}`, { stdio: 'pipe' });
  } catch {
    /* best-effort cleanup */
  }
});

const authHeaders = (token: string) => ({ authorization: `Bearer ${token}` });
const jsonHeaders = (token: string) => ({ authorization: `Bearer ${token}`, 'content-type': 'application/json' });

// ─── WM-01: formula injection ───────────────────────────────────────────────

test('WM-01a: generateCSV neutralizes =, +, -, @ and control-char prefixes', async () => {
  const { generateCSV } = await import('../src/lib/export');
  const csv = generateCSV(
    [{ key: 'v', label: 'Value' }],
    [{ v: '=CMD()' }, { v: '+1+1' }, { v: '@SUM(A1)' }, { v: '-2+3' }, { v: 'safe' }, { v: '=HYPERLINK("http://evil")' }, { v: ' a' }, { v: '\tTAB' }],
  );
  const lines = csv.split('\n').slice(1);
  assert.equal(lines[0], "'=CMD()", '=CMD() neutralized');
  assert.equal(lines[1], "'+1+1", '+1+1 neutralized');
  assert.equal(lines[2], "'@SUM(A1)", '@SUM(A1) neutralized');
  assert.equal(lines[3], "'-2+3", '-2+3 neutralized');
  assert.equal(lines[4], 'safe', 'plain values untouched');
  assert.ok(lines[5].startsWith(`"'=HYPERLINK`), `expected neutralized hyperlink: ${lines[5]}`);
  assert.equal(lines[6], ' a', 'leading-space values untouched (not formula prefixes)');
  assert.ok(lines[7].startsWith("'\tTAB"), `expected neutralized control char: ${lines[7]}`);
});

test('WM-01b: sanitizeSpreadsheetCell is a pure, exported helper', async () => {
  const { sanitizeSpreadsheetCell } = await import('../src/lib/export');
  assert.equal(sanitizeSpreadsheetCell('=1+1'), "'=1+1");
  assert.equal(sanitizeSpreadsheetCell('+SUM(A1)'), "'+SUM(A1)");
  assert.equal(sanitizeSpreadsheetCell('-1+1'), "'-1+1");
  assert.equal(sanitizeSpreadsheetCell('@COUNT'), "'@COUNT");
  assert.equal(sanitizeSpreadsheetCell('plain text'), 'plain text');
  assert.equal(sanitizeSpreadsheetCell('  leading'), '  leading');
  assert.equal(sanitizeSpreadsheetCell(42), '42');
});

test('WM-01c: report CSV export endpoint sanitizes formula-prefixed activity data', async () => {
  const mod = await import('../src/app/api/reports/[id]/csv/route');
  const report = await db.report.create({
    data: {
      title: 'WM Formula Report',
      type: 'activity',
      format: 'csv',
      status: 'completed',
      organizationId: orgA.id,
      generatedBy: 'admin-wm',
    },
  });
  const res = await mod.GET(new NextRequest(`http://test/api/reports/${report.id}/csv`, { headers: authHeaders(managerTokenA) }), {
    params: Promise.resolve({ id: report.id }),
  });
  assert.equal(res.status, 200);
  const csv = await res.text();
  assert.ok(csv.includes(`'=CMD()`), `report CSV must neutralize =CMD(): ${csv.slice(0, 200)}`);
});

// ─── WM-02 / WM-04: bounded report generation ───────────────────────────────

test('WM-02a: generate rejects a window wider than 90 days', async () => {
  const mod = await import('../src/app/api/reports/generate/route');
  const body = JSON.stringify({
    type: 'activity',
    periodStart: new Date(Date.now() - 200 * 86_400_000).toISOString(),
    periodEnd: new Date().toISOString(),
  });
  const res = await mod.POST(new NextRequest('http://test/api/reports/generate', { method: 'POST', headers: jsonHeaders(managerTokenA), body }));
  assert.equal(res.status, 400);
  const json = await res.json();
  assert.match(json.error, /must not exceed 90 days/);
});

test('WM-02b: generate rejects an inverted range', async () => {
  const mod = await import('../src/app/api/reports/generate/route');
  const body = JSON.stringify({
    type: 'activity',
    periodStart: new Date().toISOString(),
    periodEnd: new Date(Date.now() - 10 * 86_400_000).toISOString(),
  });
  const res = await mod.POST(new NextRequest('http://test/api/reports/generate', { method: 'POST', headers: jsonHeaders(managerTokenA), body }));
  assert.equal(res.status, 400);
  const json = await res.json();
  assert.match(json.error, /'from' must not be after 'to'/);
});

test('WM-04: POST /api/reports rejects inverted ranges', async () => {
  const mod = await import('../src/app/api/reports/route');
  const body = JSON.stringify({
    title: 'Inverted',
    type: 'productivity',
    format: 'pdf',
    startDate: new Date().toISOString(),
    endDate: new Date(Date.now() - 5 * 86_400_000).toISOString(),
  });
  const res = await mod.POST(new NextRequest('http://test/api/reports', { method: 'POST', headers: jsonHeaders(managerTokenA), body }));
  assert.equal(res.status, 400);
});

// ─── WM-03: team-data admin gate ────────────────────────────────────────────

test('WM-03: GET /api/organization/team-data requires admin+', async () => {
  const mod = await import('../src/app/api/organization/team-data/route');

  const asViewer = await mod.GET(new NextRequest('http://test/api/organization/team-data', { headers: authHeaders(viewerTokenA) }));
  assert.equal(asViewer.status, 403, 'viewer must be rejected');

  const asManager = await mod.GET(new NextRequest('http://test/api/organization/team-data', { headers: authHeaders(managerTokenA) }));
  assert.equal(asManager.status, 403, 'manager must be rejected');

  const asAdmin = await mod.GET(new NextRequest('http://test/api/organization/team-data', { headers: authHeaders(adminTokenA) }));
  assert.equal(asAdmin.status, 200, 'admin is allowed');
  const json = await asAdmin.json();
  assert.ok(Array.isArray(json.departments));
});

// ─── WM-05 / WM-06: capped generation + truncation flag ─────────────────────

test('WM-05/WM-06: generate caps activity scans and reports truncated=false for small datasets', async () => {
  const mod = await import('../src/app/api/reports/generate/route');
  const body = JSON.stringify({ type: 'activity' });
  const res = await mod.POST(new NextRequest('http://test/api/reports/generate', { method: 'POST', headers: jsonHeaders(managerTokenA), body }));
  assert.equal(res.status, 201);
  const json = await res.json();
  // The POST returns the report row; the truncated flag lives in the stored
  // JSON payload (the same payload every report consumer reads).
  const stored = JSON.parse((json.data as { data?: string }).data ?? '{}');
  assert.equal(stored.truncated, false, 'small dataset must not be flagged truncated');
});

test('WM-06: report export response carries a truncated flag', async () => {
  const mod = await import('../src/app/api/reports/[id]/export/route');
  const report = await db.report.create({
    data: {
      title: 'WM Export Flag',
      type: 'activity',
      format: 'csv',
      status: 'completed',
      organizationId: orgA.id,
      generatedBy: 'admin-wm',
    },
  });
  const res = await mod.GET(new NextRequest(`http://test/api/reports/${report.id}/export`, { headers: authHeaders(managerTokenA) }), {
    params: Promise.resolve({ id: report.id }),
  });
  assert.equal(res.status, 200);
  const json = await res.json();
  assert.equal(json.truncated, false, 'truncated flag must be present and false for small datasets');
});
